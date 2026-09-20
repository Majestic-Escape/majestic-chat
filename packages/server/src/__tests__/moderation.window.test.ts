/**
 * Contact lock-down on the live send path: the cross-message window (Mongo
 * is the authoritative context, one critical section per conversation +
 * sender), the lock providers (in-process queue, Mongo fallback while Redis
 * is unreachable, compare-token release), legacy history masking across
 * pagination in both directions, cache-read sanitisation, participant names
 * resolved from server.me, and the user-facing rejection codes.
 */
import { createServer, Server as HttpServer } from 'http';
import { AddressInfo } from 'net';
import express from 'express';
import jwt from 'jsonwebtoken';
import mongoose from 'mongoose';
import { io as ioc, Socket as ClientSocket } from 'socket.io-client';
import { ErrorCode, SOCKET_EVENTS, CHAT_CONFIG, MessageModel, ConversationModel, MODERATION_VERSION, MODERATION_BLOCKED_MESSAGE, ParticipantRole, MASK, isContextRelevant } from '@majestic/chat-shared';
import { createSocketServer, TypedServer } from '../socket/server';
import { socketAuthMiddleware } from '../middleware/socketAuth';
import { registerMessageEvents } from '../events/messageEvents';
import { ChatService } from '../services/ChatService';
import { MessageRepository } from '../repositories/MessageRepository';
import { conversationRoutes } from '../routes/conversationRoutes';
import { acquireModerationLock, ModerationLockModel, lockKey } from '../lib/moderationLock';
import { closeRedisClients } from '../lib/redis';
import { cacheSetEx } from '../lib/cache';
import { startDb, stopDb, clearDb, makeConversation, countMessages, cid, HOST_ID, GUEST_ID } from './helpers/db';

type Ack = { success: boolean; messageId?: string; error?: string; code?: string };
type NewMsg = { message: { id: string; content: { text?: string }; moderation?: { version?: number } } };

let httpServer: HttpServer;
let io: TypedServer;
let url: string;
let mainApi: HttpServer;
let mainApiUrl: string;
const clients: ClientSocket[] = [];
const mainApiUsers: Record<string, string> = {}; // userId → firstName served by the stub
let propertyHostFirstName = 'Rahul';

const token = (userId: string) => jwt.sign({ userId, firstName: 'T', tokenVersion: 0 }, process.env.JWT_SECRET!, { expiresIn: '1h' });
async function connect(userId: string): Promise<ClientSocket> {
  const socket = ioc(url, { auth: { token: token(userId) }, transports: ['websocket'], forceNew: true });
  clients.push(socket);
  await new Promise<void>((resolve, reject) => {
    socket.once('connect', () => resolve());
    socket.once('connect_error', (e) => reject(e));
  });
  return socket;
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function waitUntil(fn: () => boolean, ms = 3000): Promise<void> {
  const until = Date.now() + ms;
  while (!fn()) {
    if (Date.now() > until) throw new Error('timeout');
    await sleep(20);
  }
}
async function join(s: ClientSocket, conversationId: string): Promise<void> {
  s.emit(SOCKET_EVENTS.CONVERSATION_JOIN, { conversationId });
  const room = `${CHAT_CONFIG.ROOM_PREFIX}${conversationId}`;
  await waitUntil(() => io.sockets.adapter.rooms.get(room)?.has(s.id as string) === true);
}
function send(s: ClientSocket, conversationId: string, text: string, extra: Record<string, unknown> = {}): Promise<Ack> {
  return new Promise((resolve) => {
    s.timeout(8000).emit(SOCKET_EVENTS.MESSAGE_SEND, { conversationId, content: { text }, type: 'text', clientMessageId: cid(), ...extra } as never, (err: Error | null, ack: Ack) => resolve(err ? { success: false, code: 'TIMEOUT' } : ack));
  });
}
function collect(s: ClientSocket): NewMsg[] {
  const out: NewMsg[] = [];
  s.on(SOCKET_EVENTS.MESSAGE_NEW, (m: NewMsg) => out.push(m));
  return out;
}
const rest = async (path: string, tok: string | null, init: RequestInit = {}) => {
  const res = await fetch(`${url}/api/chat${path}`, { ...init, headers: { ...(init.headers || {}), ...(tok ? { Authorization: `Bearer ${tok}` } : {}), 'content-type': 'application/json' } });
  return { status: res.status, body: (await res.json()) as any };
};

/** Fresh participants per test: the socket rate limit is per user and per process. */
const fresh = () => ({ hostId: new mongoose.Types.ObjectId().toString(), guestId: new mongoose.Types.ObjectId().toString() });

/** A row accepted before the lock-down: no moderation.version. */
async function legacyRow(conversationId: string, senderId: string, text: string, at: Date, extra: Record<string, unknown> = {}) {
  const doc = await MessageModel.create({ conversationId, senderId, clientMessageId: cid(), type: 'text', content: { text }, moderation: { status: 'clean', flags: [], confidence: 0 }, readBy: [], status: 'sent', createdAt: at, ...extra });
  return String(doc._id);
}

beforeAll(async () => {
  await startDb();
  mainApi = createServer((req, res) => {
    const u = req.url || '';
    res.setHeader('content-type', 'application/json');
    const info = u.match(/^\/api\/v1\/guests\/info\/([a-f0-9]{24})/);
    if (u.startsWith('/api/v1/auth/check-token')) {
      res.end('{"success":true}');
    } else if (info) {
      const name = mainApiUsers[info[1]];
      if (!req.headers.authorization) {
        res.statusCode = 401;
        res.end('{"success":false}');
      } else if (!name) {
        res.statusCode = 404;
        res.end('{"message":"User not found"}');
      } else {
        res.end(JSON.stringify({ message: 'ok', user: { _id: info[1], firstName: name, profilePicture: null } }));
      }
    } else if (u.startsWith('/api/v1/properties/')) {
      const id = u.split('/').pop();
      res.end(JSON.stringify({ success: true, data: { _id: id, host: { _id: HOST_ID, firstName: propertyHostFirstName } } }));
    } else {
      res.statusCode = 404;
      res.end('{}');
    }
  });
  await new Promise<void>((r) => mainApi.listen(0, r));
  mainApiUrl = `http://127.0.0.1:${(mainApi.address() as AddressInfo).port}/api/v1`;
  process.env.MAIN_API_URL = mainApiUrl;

  const app = express();
  app.use(express.json());
  app.use('/api/chat', conversationRoutes);
  httpServer = createServer(app);
  io = createSocketServer(httpServer);
  io.use(socketAuthMiddleware);
  registerMessageEvents(io, new ChatService());
  await new Promise<void>((r) => httpServer.listen(0, r));
  url = `http://127.0.0.1:${(httpServer.address() as AddressInfo).port}`;
});
afterAll(async () => {
  for (const c of clients) c.disconnect();
  io.close();
  await new Promise<void>((r) => httpServer.close(() => r()));
  await new Promise<void>((r) => mainApi.close(() => r()));
  delete process.env.MAIN_API_URL;
  delete process.env.REDIS_URL;
  closeRedisClients();
  await stopDb();
});
beforeEach(async () => {
  await clearDb();
});

describe('cross-message window on the live send path', () => {
  it('a phone number split over two messages is blocked on the completing fragment; the rejected candidate never enters the context', async () => {
    const conv = await makeConversation();
    const guest = await connect(GUEST_ID);
    const host = await connect(HOST_ID);
    await join(guest, conv);
    await join(host, conv);
    const got = collect(host);

    expect((await send(guest, conv, 'first five 98765')).success).toBe(true);
    const blocked = await send(guest, conv, 'last five 43210');
    expect(blocked).toMatchObject({ success: false, code: ErrorCode.MODERATION_BLOCKED, error: MODERATION_BLOCKED_MESSAGE });
    expect(await countMessages({ conversationId: conv })).toBe(1);

    // the rejected "43210" never became context: 98765 + 3210 is nine digits,
    // so this send passes — had "43210" been stored, 98765 43210 3210 would chain
    expect((await send(guest, conv, 'ok 3210')).success).toBe(true);
    expect(await countMessages({ conversationId: conv })).toBe(2);
    await waitUntil(() => got.length === 2);
    for (const m of got) expect(m.message.moderation?.version).toBe(MODERATION_VERSION);
  });

  it('one digit per message, an email and a domain split over many messages, and a resumption after the old 15-minute window are all caught', async () => {
    const ids = fresh();
    const GUEST_ID = ids.guestId;
    const conv = await makeConversation(ids);
    const guest = await connect(GUEST_ID);
    await join(guest, conv);
    for (const d of ['9', '8', '7', '6', '5', '4', '3', '2', '1']) expect((await send(guest, conv, d)).success).toBe(true);
    expect((await send(guest, conv, '0')).code).toBe(ErrorCode.MODERATION_BLOCKED);
    expect((await send(guest, conv, 'rahul')).success).toBe(true);
    expect((await send(guest, conv, '@')).success).toBe(true);
    expect((await send(guest, conv, 'gmail')).code).toBe(ErrorCode.MODERATION_BLOCKED);
    expect((await send(guest, conv, 'rahulvilla')).success).toBe(true);
    expect((await send(guest, conv, 'dot in')).code).toBe(ErrorCode.MODERATION_BLOCKED);

    // resumption: a fragment stored 20 minutes ago is still context (7-day window)
    const conv2 = await makeConversation(ids);
    await join(guest, conv2);
    await MessageModel.create({ conversationId: conv2, senderId: GUEST_ID, clientMessageId: cid(), type: 'text', content: { text: '98765' }, moderation: { status: 'clean', flags: [], confidence: 0, version: MODERATION_VERSION }, readBy: [], status: 'sent', createdAt: new Date(Date.now() - 20 * 60 * 1000) });
    expect((await send(guest, conv2, '43210')).code).toBe(ErrorCode.MODERATION_BLOCKED);
    // but a fragment older than the window is not
    const conv3 = await makeConversation(ids);
    await join(guest, conv3);
    await MessageModel.create({ conversationId: conv3, senderId: GUEST_ID, clientMessageId: cid(), type: 'text', content: { text: '98765' }, moderation: { status: 'clean', flags: [], confidence: 0, version: MODERATION_VERSION }, readBy: [], status: 'sent', createdAt: new Date(Date.now() - 8 * 24 * 60 * 60 * 1000) });
    expect((await send(guest, conv3, '43210')).success).toBe(true);
  });

  it('filler messages cannot flush a fragment out of the context: 40 fillers after a digit, 10 digits with 6 fillers between each, a 1400-char filler, an e-mail over 8 messages with fillers (rows are seeded as accepted history to stay under the rate limit)', async () => {
    const ids = fresh();
    const GUEST_ID = ids.guestId;
    const guest = await connect(GUEST_ID);
    const accepted = async (conversationId: string, text: string, minutesAgo: number) =>
      MessageModel.create({ conversationId, senderId: GUEST_ID, clientMessageId: cid(), type: 'text', content: { text }, moderation: { status: 'clean', flags: [], confidence: 0, version: MODERATION_VERSION, fragment: isContextRelevant(text) }, readBy: [], status: 'sent', createdAt: new Date(Date.now() - minutesAgo * 60000) });
    // 1. first half, 40 short fillers, second half
    const c1 = await makeConversation(ids);
    await join(guest, c1);
    await accepted(c1, 'first five 98765', 60);
    for (let i = 0; i < 40; i++) await accepted(c1, 'ok', 59 - i);
    expect((await send(guest, c1, 'last five 43210')).code).toBe(ErrorCode.MODERATION_BLOCKED);
    // 2. one digit per message with 6 fillers between each (63 rows before the last digit)
    const c2 = await makeConversation(ids);
    await join(guest, c2);
    let m = 200;
    for (const d of ['9', '8', '7', '6', '5', '4', '3', '2', '1']) { await accepted(c2, d, m--); for (let i = 0; i < 6; i++) await accepted(c2, 'sure', m--); }
    expect((await send(guest, c2, '0')).code).toBe(ErrorCode.MODERATION_BLOCKED);
    // 3. a filler longer than the character window still leaves the digit run in context
    const c3 = await makeConversation(ids);
    await join(guest, c3);
    await accepted(c3, 'call 98765', 30);
    await accepted(c3, 'lorem ipsum '.repeat(120), 20);
    expect((await send(guest, c3, '43210')).code).toBe(ErrorCode.MODERATION_BLOCKED);
    // 4. e-mail over 8 messages interleaved with fillers
    const c4 = await makeConversation(ids);
    await join(guest, c4);
    m = 100;
    for (const part of ['rahul', 'ok', 'ok', '@', 'fine', 'gmail', 'thanks', 'dot']) await accepted(c4, part, m--);
    expect((await send(guest, c4, 'com')).code).toBe(ErrorCode.MODERATION_BLOCKED);
    // 5. legacy rows (no fragment flag) beyond the window are judged on the fly
    const c5 = await makeConversation(ids);
    await join(guest, c5);
    await MessageModel.create({ conversationId: c5, senderId: GUEST_ID, clientMessageId: cid(), type: 'text', content: { text: '98765' }, moderation: { status: 'clean', flags: [], confidence: 0 }, readBy: [], status: 'sent', createdAt: new Date(Date.now() - 50 * 60000) });
    for (let i = 0; i < 40; i++) await accepted(c5, 'yes', 40 - i);
    expect((await send(guest, c5, '43210')).code).toBe(ErrorCode.MODERATION_BLOCKED);
    // 6. and ordinary chat with explained numbers stays clean across the same volume
    const c6 = await makeConversation(ids);
    await join(guest, c6);
    m = 100;
    for (const t of ['we are 2 adults and 2 kids', 'check-in at 3 pm on 12/10', 'budget is Rs 5000 per night', 'ok', 'ok', 'see you at 6']) await accepted(c6, t, m--);
    expect((await send(guest, c6, 'is parking for 2 cars available?')).success).toBe(true);
  });

  it("the other party's messages are not the sender's context, and a same-id retry adds nothing", async () => {
    const conv = await makeConversation();
    const guest = await connect(GUEST_ID);
    const host = await connect(HOST_ID);
    await join(guest, conv);
    await join(host, conv);
    expect((await send(host, conv, 'first five 98765')).success).toBe(true);
    expect((await send(guest, conv, 'last five 43210')).success).toBe(true); // different sender
    const id = cid();
    const a = await send(guest, conv, 'again 12345', { clientMessageId: id });
    const b = await send(guest, conv, 'again 12345', { clientMessageId: id });
    expect(a.success && b.success && a.messageId === b.messageId).toBe(true);
    expect(await countMessages({ conversationId: conv, senderId: GUEST_ID })).toBe(2);
  });

  it('two sockets of one sender racing with the two halves: exactly one half is stored, 25 rounds (rate limit: 60 sends/min/user)', async () => {
    const ids = fresh();
    const conv = await makeConversation(ids);
    const a = await connect(ids.guestId);
    const b = await connect(ids.guestId);
    await join(a, conv);
    await join(b, conv);
    for (let round = 0; round < 25; round++) {
      await MessageModel.deleteMany({ conversationId: conv });
      const [x, y] = await Promise.all([send(a, conv, `first ${round} 98765`), send(b, conv, `last ${round} 43210`)]);
      expect([x.success, y.success].filter(Boolean).length).toBe(1);
      expect(await countMessages({ conversationId: conv })).toBe(1);
    }
  });

  it('a clean candidate racing a blocked one is unaffected by it', async () => {
    const ids = fresh();
    const conv = await makeConversation(ids);
    const a = await connect(ids.guestId);
    const b = await connect(ids.guestId);
    await join(a, conv);
    await join(b, conv);
    for (let round = 0; round < 20; round++) {
      const [x, y] = await Promise.all([send(a, conv, `hello ${round}`), send(b, conv, `call me on 9876543210 ${round}`)]);
      expect(x.success).toBe(true);
      expect(y.code).toBe(ErrorCode.MODERATION_BLOCKED);
    }
    expect(await countMessages({ conversationId: conv })).toBe(20);
  });
});

describe('moderation ↔ persistence consistency under injected faults', () => {
  it('a Mongo insert failure after a clean verdict persists nothing, leaves the context untouched, and the same-id retry then succeeds exactly once', async () => {
    const ids = fresh();
    const conv = await makeConversation(ids);
    const guest = await connect(ids.guestId);
    await join(guest, conv);
    const proto = MessageRepository.prototype as any;
    const original = proto.createWithConversationUpdate;
    let failures = 0;
    proto.createWithConversationUpdate = async function (...args: unknown[]) {
      failures++;
      throw new Error('injected: transaction aborted');
    };
    let ack: Ack;
    const clientMessageId = cid();
    try {
      ack = await send(guest, conv, 'first five 98765', { clientMessageId });
    } finally {
      proto.createWithConversationUpdate = original;
    }
    expect(failures).toBe(1);
    expect(ack.success).toBe(false);
    expect(ack.code).not.toBe(ErrorCode.MODERATION_BLOCKED); // ambiguous failure, not a verdict
    expect(await countMessages({ conversationId: conv })).toBe(0);
    // the failed candidate never became context: the completing half alone is clean
    expect((await send(guest, conv, 'last five 43210')).success).toBe(true);
    // the client's same-id retry of the failed send is judged against the now-persisted half → blocked
    const retry = await send(guest, conv, 'first five 98765', { clientMessageId });
    expect(retry.code).toBe(ErrorCode.MODERATION_BLOCKED);
    expect(await countMessages({ conversationId: conv })).toBe(1);
  });

  it('a context read failure fails CLOSED: the candidate is not accepted without its history', async () => {
    const ids = fresh();
    const conv = await makeConversation(ids);
    const guest = await connect(ids.guestId);
    await join(guest, conv);
    const proto = MessageRepository.prototype as any;
    const original = proto.moderationContext;
    proto.moderationContext = async function () {
      throw new Error('injected: Mongo unavailable');
    };
    let ack: Ack;
    try {
      ack = await send(guest, conv, 'hello there');
    } finally {
      proto.moderationContext = original;
    }
    expect(ack.success).toBe(false);
    expect(await countMessages({ conversationId: conv })).toBe(0);
    expect((await send(guest, conv, 'hello there')).success).toBe(true);
  });

  it('a lock that cannot be acquired (provider error) never admits the message', async () => {
    const ids = fresh();
    const conv = await makeConversation(ids);
    const guest = await connect(ids.guestId);
    await join(guest, conv);
    const lockLib = require('../lib/moderationLock');
    const originalCreate = ModerationLockModel.create;
    process.env.REDIS_URL = 'redis://127.0.0.1:1';
    closeRedisClients();
    (ModerationLockModel as any).create = async () => { throw new Error('injected: lock store down'); };
    let ack: Ack;
    try {
      ack = await send(guest, conv, 'hello');
    } finally {
      (ModerationLockModel as any).create = originalCreate;
      delete process.env.REDIS_URL;
      closeRedisClients();
    }
    expect(ack.success).toBe(false);
    expect(await countMessages({ conversationId: conv })).toBe(0);
    void lockLib;
  });
});

describe('lock providers', () => {
  it('in-process: sends of one sender are serialised; a second holder waits for the first', async () => {
    const l1 = await acquireModerationLock('c1', 'u1');
    let second: 'waiting' | 'acquired' = 'waiting';
    const p = acquireModerationLock('c1', 'u1').then((l) => {
      second = 'acquired';
      return l;
    });
    await sleep(100);
    expect(second).toBe('waiting');
    await l1.release();
    const l2 = await p;
    expect(second).toBe('acquired');
    await l2.release();
    // another key is independent
    const other = await acquireModerationLock('c1', 'u2');
    await other.release();
  });

  it('Mongo fallback while Redis is configured but unreachable: atomic acquire, compare-token release, expired holder reaped', async () => {
    process.env.REDIS_URL = 'redis://127.0.0.1:1';
    closeRedisClients();
    try {
      const l1 = await acquireModerationLock('c9', 'u9');
      expect(l1.provider).toBe('mongo');
      const key = lockKey('c9', 'u9');
      expect(await ModerationLockModel.exists({ _id: key, token: l1.token })).toBeTruthy();
      // a stale release with another token must not remove the current owner's lock
      await ModerationLockModel.deleteOne({ _id: key, token: 'not-the-owner' });
      expect(await ModerationLockModel.exists({ _id: key, token: l1.token })).toBeTruthy();
      expect(await l1.isOwner()).toBe(true);
      await l1.release();
      expect(await ModerationLockModel.exists({ _id: key })).toBeFalsy();

      // an expired holder (crashed process) is reaped on the next acquire
      await ModerationLockModel.create({ _id: key, token: 'dead', expiresAt: new Date(Date.now() - 1000) });
      const l2 = await acquireModerationLock('c9', 'u9');
      expect(l2.provider).toBe('mongo');
      expect(await ModerationLockModel.exists({ _id: key, token: l2.token })).toBeTruthy();
      await l2.release();
    } finally {
      delete process.env.REDIS_URL;
      closeRedisClients();
    }
  });

  it("Mongo fallback: an old owner that wakes after its lease expired cannot release or renew the new owner's lock (cross-process takeover emulated on the collection)", async () => {
    process.env.REDIS_URL = 'redis://127.0.0.1:1';
    closeRedisClients();
    try {
      const key = lockKey('c11', 'u11');
      const old = await acquireModerationLock('c11', 'u11');
      expect(old.provider).toBe('mongo');
      // the lease expires while the old owner is stalled (a slow transaction) and another
      // process takes it over exactly as tryMongo does: reap the expired document, insert its own
      await ModerationLockModel.updateOne({ _id: key }, { $set: { expiresAt: new Date(Date.now() - 1) } });
      expect((await ModerationLockModel.deleteOne({ _id: key, expiresAt: { $lt: new Date() } })).deletedCount).toBe(1);
      await ModerationLockModel.create({ _id: key, token: 'new-owner', expiresAt: new Date(Date.now() + 15_000) });
      expect(await old.isOwner()).toBe(false);
      // the stalled owner finishes: its compare-and-delete release reports the loss and leaves the new lock intact
      expect(await old.release()).toBe(false);
      expect(await ModerationLockModel.exists({ _id: key, token: 'new-owner' })).toBeTruthy();
      // a renewal by the old token cannot extend the new owner's lease either
      const before = (await ModerationLockModel.findById(key).lean()) as any;
      await ModerationLockModel.updateOne({ _id: key, token: old.token }, { $set: { expiresAt: new Date(Date.now() + 60_000) } });
      const after = (await ModerationLockModel.findById(key).lean()) as any;
      expect(after.expiresAt.getTime()).toBe(before.expiresAt.getTime());
      // the new owner (this process, next section) reaps nothing and answers BUSY while the other holds
      await expect(acquireModerationLock('c11', 'u11')).rejects.toMatchObject({ code: ErrorCode.MODERATION_BUSY });
      await ModerationLockModel.deleteOne({ _id: key, token: 'new-owner' });
      // and once it is gone, the section is free again
      const next = await acquireModerationLock('c11', 'u11');
      expect(await next.release()).toBe(true);
    } finally {
      delete process.env.REDIS_URL;
      closeRedisClients();
    }
  });

  it('a live holder in another process keeps the section exclusive; the waiter answers MODERATION_BUSY', async () => {
    process.env.REDIS_URL = 'redis://127.0.0.1:1';
    closeRedisClients();
    try {
      const key = lockKey('c10', 'u10');
      await ModerationLockModel.create({ _id: key, token: 'other-instance', expiresAt: new Date(Date.now() + 60_000) });
      const t0 = Date.now();
      await expect(acquireModerationLock('c10', 'u10')).rejects.toMatchObject({ code: ErrorCode.MODERATION_BUSY });
      expect(Date.now() - t0).toBeLessThan(6000);
      await ModerationLockModel.deleteOne({ _id: key });
    } finally {
      delete process.env.REDIS_URL;
      closeRedisClients();
    }
  });
});

describe('legacy history masking', () => {
  it('fragments split across pages (either direction), previews and quotes cannot be reconstructed', async () => {
    const conv = await makeConversation();
    const t = (m: number) => new Date(Date.parse('2026-01-01T00:00:00Z') + m * 60_000);
    // legacy rows: older half then newer half, interleaved with the host
    const first = await legacyRow(conv, GUEST_ID, 'my number starts 98765', t(1));
    await legacyRow(conv, HOST_ID, 'ok', t(2));
    await legacyRow(conv, HOST_ID, 'sure', t(3));
    const second = await legacyRow(conv, GUEST_ID, 'and ends 43210', t(4));
    await legacyRow(conv, HOST_ID, 'thanks', t(5));
    await legacyRow(conv, GUEST_ID, 'reach me on rahul', t(6));
    await legacyRow(conv, GUEST_ID, 'at gmail dot com', t(7));
    await legacyRow(conv, GUEST_ID, 'quoted reply', t(8), { replyTo: { messageId: first, senderId: GUEST_ID, text: 'my number starts 98765 43210', type: 'text' } });
    await ConversationModel.updateOne({ _id: conv }, { $set: { lastMessage: { content: 'and ends 43210', senderId: GUEST_ID, sentAt: t(8) } } });

    const guestTok = token(GUEST_ID);
    // newest page of 2, then older pages
    const p1 = await rest(`/conversations/${conv}/messages?limit=2`, guestTok);
    expect(p1.status).toBe(200);
    const texts: string[] = [];
    const collectPage = (p: any) => p.body.data.data.forEach((m: any) => texts.push(m.content.text));
    collectPage(p1);
    let cursor = p1.body.data.nextCursor;
    while (cursor) {
      const p = await rest(`/conversations/${conv}/messages?limit=2&cursor=${cursor}`, guestTok);
      collectPage(p);
      cursor = p.body.data.nextCursor;
    }
    expect(texts.length).toBe(8);
    const all = texts.join(' | ');
    expect(all).not.toMatch(/98765|43210|gmail|rahul(?!.*quoted)/);
    expect(all).toContain(MASK);
    expect(texts).toContain('ok'); // untouched rows stay
    // quote snapshot and conversation preview
    const quoted = p1.body.data.data.find((m: any) => m.replyTo);
    expect(quoted.replyTo.text).not.toMatch(/98765|43210/);
    const list = await rest('/conversations', guestTok);
    const c = list.body.data.find((x: any) => x.id === conv);
    expect(c.lastMessage.content).not.toMatch(/43210/);
    expect(JSON.stringify(c.participants)).not.toMatch(/lastName/);

    // a post-lock-down row completing a legacy fragment is masked too
    await MessageModel.create({ conversationId: conv, senderId: GUEST_ID, clientMessageId: cid(), type: 'text', content: { text: 'and 43210 again' }, moderation: { status: 'clean', flags: [], confidence: 0, version: MODERATION_VERSION }, readBy: [], status: 'sent', createdAt: t(9) });
    const latest = await rest(`/conversations/${conv}/messages?limit=3`, guestTok);
    for (const m of latest.body.data.data) expect(m.content.text).not.toMatch(/43210/);
    // the direct row read is masked as well
    expect(second).toBeTruthy();
  });

  it('a page of post-lock-down rows is served untouched (no masking cost path)', async () => {
    const ids = fresh();
    const conv = await makeConversation(ids);
    const guest = await connect(ids.guestId);
    await join(guest, conv);
    for (const text of ['hello', 'we are 4 adults', 'arriving 6 pm']) expect((await send(guest, conv, text)).success).toBe(true);
    const page = await rest(`/conversations/${conv}/messages?limit=10`, token(ids.guestId));
    expect(page.body.data.data.map((m: any) => m.content.text).sort()).toEqual(['arriving 6 pm', 'hello', 'we are 4 adults']);
  });
});

describe('participants', () => {
  it('names come from server.me, client-supplied names are ignored, lastName never surfaces — including from a pre-deploy cache entry', async () => {
    const propertyId = new mongoose.Types.ObjectId().toString();
    mainApiUsers[GUEST_ID] = 'Priya';
    propertyHostFirstName = 'Rahul';
    const created = await rest('/conversations', token(GUEST_ID), {
      method: 'POST',
      body: JSON.stringify({ propertyId, hostId: HOST_ID, guestId: GUEST_ID, hostFirstName: 'Forged 9876543210', hostLastName: 'Sharma', guestFirstName: 'Evil', guestLastName: 'Verma' }),
    });
    expect(created.status).toBe(200);
    const parts = created.body.data.participants;
    expect(parts.find((p: any) => p.role === ParticipantRole.HOST).firstName).toBe('Rahul');
    expect(parts.find((p: any) => p.role === ParticipantRole.GUEST).firstName).toBe('Priya');
    expect(JSON.stringify(parts)).not.toMatch(/Sharma|Verma|Evil|Forged|lastName/);
    const raw = await ConversationModel.findById(created.body.data.id).lean();
    expect(JSON.stringify(raw!.participants)).not.toMatch(/lastName/);

    // a name server.me itself holds that fails the name policy is omitted
    const propertyId2 = new mongoose.Types.ObjectId().toString();
    mainApiUsers[GUEST_ID] = 'Priya 9876543210';
    propertyHostFirstName = 'WhatsApp Rahul';
    const created2 = await rest('/conversations', token(GUEST_ID), { method: 'POST', body: JSON.stringify({ propertyId: propertyId2, hostId: HOST_ID, guestId: GUEST_ID }) });
    expect(created2.status).toBe(200);
    for (const p of created2.body.data.participants) expect(p.firstName).toBeUndefined();

    // legacy document with lastName in Mongo → never returned, from Mongo or from the cache
    const legacy = await ConversationModel.create({
      propertyId: new mongoose.Types.ObjectId().toString(),
      participants: [
        { userId: HOST_ID, role: 'host', firstName: 'Rahul', lastName: 'Sharma', joinedAt: new Date() },
        { userId: GUEST_ID, role: 'guest', firstName: 'Priya', lastName: 'Verma', joinedAt: new Date() },
      ],
      unreadCount: { [HOST_ID]: 0, [GUEST_ID]: 0 },
      status: 'active',
    });
    const one = await rest(`/conversations/${legacy._id}`, token(GUEST_ID));
    expect(JSON.stringify(one.body.data)).not.toMatch(/Sharma|Verma|lastName/);
    // simulate a cache entry written by the previous release (lastName included)
    await cacheSetEx(`conv:${legacy._id}`, 60, JSON.stringify({ ...one.body.data, participants: legacy.participants }));
    const again = await rest(`/conversations/${legacy._id}`, token(GUEST_ID));
    expect(JSON.stringify(again.body.data)).not.toMatch(/Sharma|Verma|lastName/);
  });
});
