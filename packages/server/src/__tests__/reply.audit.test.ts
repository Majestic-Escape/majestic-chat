// Batch Q audit: adversarial input, auth edges, DB-failure boundary at the socket
// layer, existence-oracle parity, cross-conversation clientMessageId reuse, and
// resource hygiene (sessions / connections do not grow with sends).
import { createServer, Server as HttpServer } from 'http';
import { AddressInfo } from 'net';
import jwt from 'jsonwebtoken';
import mongoose from 'mongoose';
import { io as ioc, Socket as ClientSocket } from 'socket.io-client';
import { ErrorCode, SOCKET_EVENTS, CHAT_CONFIG, MessageModel, ConversationModel } from '@majestic/chat-shared';
import { createSocketServer, TypedServer } from '../socket/server';
import { socketAuthMiddleware } from '../middleware/socketAuth';
import { registerMessageEvents } from '../events/messageEvents';
import { ChatService } from '../services/ChatService';
import { MessageRepository } from '../repositories/MessageRepository';
import { startDb, stopDb, clearDb, makeConversation, rawMessage, rawConversation, countMessages, cid, HOST_ID, GUEST_ID, STRANGER_ID } from './helpers/db';

type Ack = { success: boolean; messageId?: string; error?: string; code?: string };
type NewMsg = { message: { id: string; clientMessageId: string; content: { text?: string }; replyTo?: Record<string, unknown> }; conversationId: string };

let httpServer: HttpServer;
let io: TypedServer;
let chatService: ChatService;
let url: string;
const clients: ClientSocket[] = [];
const token = (userId: string, opts: jwt.SignOptions = {}) => jwt.sign({ userId, firstName: 'U' }, 'test-jwt-secret', opts);

function connectRaw(auth: Record<string, unknown>): Promise<{ ok: boolean; error?: string; socket?: ClientSocket }> {
  return new Promise((resolve) => {
    const s = ioc(url, { auth, transports: ['websocket'], reconnection: false, forceNew: true });
    clients.push(s);
    s.once('connect', () => resolve({ ok: true, socket: s }));
    s.once('connect_error', (e: Error) => resolve({ ok: false, error: e.message }));
  });
}
async function connect(userId: string): Promise<ClientSocket> {
  const r = await connectRaw({ token: token(userId) });
  if (!r.ok || !r.socket) throw new Error('connect failed: ' + r.error);
  return r.socket;
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function waitUntil(fn: () => boolean, ms = 3000): Promise<void> {
  const t0 = Date.now();
  while (!fn()) {
    if (Date.now() - t0 > ms) throw new Error('waitUntil timed out');
    await sleep(20);
  }
}
async function join(s: ClientSocket, conversationId: string): Promise<void> {
  s.emit(SOCKET_EVENTS.CONVERSATION_JOIN, { conversationId });
  const room = `${CHAT_CONFIG.ROOM_PREFIX}${conversationId}`;
  await waitUntil(() => io.sockets.adapter.rooms.get(room)?.has(s.id as string) === true);
}
function send(s: ClientSocket, payload: unknown, timeoutMs = 4000): Promise<Ack | { timedOut: true }> {
  return new Promise((resolve) => {
    s.timeout(timeoutMs).emit(SOCKET_EVENTS.MESSAGE_SEND, payload as never, (err: Error | null, res: Ack) => resolve(err ? { timedOut: true } : res));
  });
}
function collect(s: ClientSocket): NewMsg[] {
  const arr: NewMsg[] = [];
  s.on(SOCKET_EVENTS.MESSAGE_NEW, (m: NewMsg) => arr.push(m));
  return arr;
}
const plain = (conversationId: string, text: string, extra: Record<string, unknown> = {}) => ({ conversationId, content: { text }, type: 'text', clientMessageId: cid(), ...extra });

beforeAll(async () => {
  await startDb();
  httpServer = createServer();
  io = createSocketServer(httpServer);
  io.use(socketAuthMiddleware);
  chatService = new ChatService();
  registerMessageEvents(io, chatService);
  await new Promise<void>((r) => httpServer.listen(0, r));
  url = `http://127.0.0.1:${(httpServer.address() as AddressInfo).port}`;
});
afterAll(async () => {
  for (const c of clients) c.disconnect();
  io.close();
  await new Promise<void>((r) => httpServer.close(() => r()));
  await stopDb();
});
beforeEach(async () => {
  await clearDb();
});
afterEach(() => {
  for (const c of clients.splice(0)) c.disconnect();
  jest.restoreAllMocks();
});

describe('authentication edges', () => {
  it('rejects sockets without a token, with an invalid token, and with an expired token', async () => {
    expect((await connectRaw({})).ok).toBe(false);
    expect((await connectRaw({ token: 'garbage' })).ok).toBe(false);
    const expired = await connectRaw({ token: token(GUEST_ID, { expiresIn: -10 }) });
    expect(expired.ok).toBe(false);
    expect(expired.error).toMatch(/expired/i);
    const wrongSecret = jwt.sign({ userId: GUEST_ID, firstName: 'U' }, 'other-secret');
    expect((await connectRaw({ token: wrongSecret })).ok).toBe(false);
  });

  it('a retry after the sender lost participant status is rejected, but the first message stays stored exactly once', async () => {
    const conv = await makeConversation();
    const guest = await connect(GUEST_ID);
    const id = cid();
    const first = (await send(guest, { ...plain(conv, 'before removal'), clientMessageId: id })) as Ack;
    expect(first.success).toBe(true);
    await ConversationModel.updateOne({ _id: conv }, { $pull: { participants: { userId: GUEST_ID } } });
    const retry = (await send(guest, { ...plain(conv, 'before removal'), clientMessageId: id })) as Ack;
    // conversation cache is optional/absent in tests → the removal is visible immediately
    expect(retry.success).toBe(false);
    expect(retry.code).toBe(ErrorCode.USER_NOT_PARTICIPANT);
    expect(await countMessages({ conversationId: conv, clientMessageId: id })).toBe(1);
  });
});

describe('hostile payloads', () => {
  it('strips unknown properties and forged reply fields; the stored document has only schema fields', async () => {
    const conv = await makeConversation();
    const host = await connect(HOST_ID);
    const guest = await connect(GUEST_ID);
    await join(host, conv);
    const orig = (await send(host, plain(conv, 'orig'))) as Ack;
    const res = (await send(guest, {
      ...plain(conv, 'evil'),
      senderId: HOST_ID, // spoof attempt
      readBy: [{ userId: HOST_ID, readAt: new Date() }],
      moderation: { status: 'clean', flags: [], confidence: 0 },
      status: 'read',
      deletedAt: new Date(),
      replyTo: { messageId: orig.messageId, text: 'FORGED', senderId: 'x', type: 'system', nested: { replyTo: {} } },
      __proto__: { polluted: true },
      constructor: { prototype: { polluted: true } },
    })) as Ack;
    expect(res.success).toBe(true);
    const raw = await rawMessage(res.messageId as string);
    expect(raw!.senderId).toBe(GUEST_ID); // actor from the JWT, never the body
    expect(raw!.status).toBe('sent');
    expect(raw!.deletedAt).toBeUndefined();
    expect((raw!.readBy as unknown[]).length).toBe(1);
    expect(raw!.replyTo).toEqual({ messageId: orig.messageId, senderId: HOST_ID, text: 'orig', type: 'text' });
    expect(Object.keys(raw!).sort()).toEqual(['__v', '_id', 'clientMessageId', 'content', 'conversationId', 'createdAt', 'moderation', 'readBy', 'replyTo', 'senderId', 'status', 'type', 'updatedAt']);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  it('rejects structurally bad payloads with VALIDATION_ERROR and never stores them', async () => {
    const conv = await makeConversation();
    const guest = await connect(GUEST_ID);
    for (const bad of [
      null,
      'string',
      { conversationId: conv },
      { conversationId: conv, content: 'not an object', type: 'text', clientMessageId: cid() },
      { conversationId: conv, content: { text: 'x' }, type: 'video', clientMessageId: cid() },
      { conversationId: conv, content: { text: 'x' }, type: 'text' },
      { conversationId: conv, content: { text: 'x' }, type: 'text', clientMessageId: cid(), replyTo: 'abc' },
      { conversationId: conv, content: { text: 'x' }, type: 'text', clientMessageId: cid(), replyTo: { messageId: '<script>' } },
      { conversationId: conv, content: { text: 'x'.repeat(100_000) }, type: 'text', clientMessageId: cid() },
    ]) {
      const res = (await send(guest, bad)) as Ack;
      expect(res.success).toBe(false);
      expect(res.code).toBe(ErrorCode.VALIDATION_ERROR);
    }
    expect(await countMessages({ conversationId: conv })).toBe(0);
  });

  it('stores and echoes hostile text verbatim (rendering is the client\'s job) incl. lone surrogates and bidi', async () => {
    const conv = await makeConversation();
    const host = await connect(HOST_ID);
    const guest = await connect(GUEST_ID);
    await join(host, conv);
    const got = collect(host);
    const evil = '<img src=x onerror=alert(1)>‮\ud800 lone   nul 日本語 😀 ' + 'https://x.test/' + 'a'.repeat(300);
    const res = (await send(guest, plain(conv, evil))) as Ack;
    expect(res.success).toBe(true);
    await waitUntil(() => got.length === 1);
    // a lone surrogate cannot survive JSON/BSON round-trips intact; everything else must
    const expected = evil.replace('\ud800', '�');
    expect(got[0].message.content.text === evil || got[0].message.content.text === expected).toBe(true);
    const reply = (await send(host, plain(conv, 'r', { replyTo: { messageId: res.messageId } }))) as Ack;
    expect(reply.success).toBe(true);
    const raw = await rawMessage(reply.messageId as string);
    expect((raw!.replyTo as { text: string }).text.length).toBeLessThanOrEqual(CHAT_CONFIG.REPLY_SNIPPET_MAX);
    expect((raw!.replyTo as { text: string }).text.startsWith('<img src=x onerror=alert(1)>')).toBe(true);
  });

  it('unknown and foreign-conversation targets are indistinguishable (no existence oracle)', async () => {
    const conv = await makeConversation();
    const other = await makeConversation({ hostId: STRANGER_ID, guestId: 'ddddddddddddddddddddddd4' });
    const stranger = await connect(STRANGER_ID);
    const foreign = (await send(stranger, plain(other, 'private'))) as Ack;
    const guest = await connect(GUEST_ID);
    const a = (await send(guest, plain(conv, 'x', { replyTo: { messageId: foreign.messageId } }))) as Ack;
    const b = (await send(guest, plain(conv, 'x', { replyTo: { messageId: new mongoose.Types.ObjectId().toString() } }))) as Ack;
    expect(a).toEqual(b);
    expect(a.code).toBe(ErrorCode.MESSAGE_NOT_FOUND);
    expect(await countMessages({ conversationId: conv })).toBe(0);
  });

  it('the same clientMessageId in two conversations is two independent messages (index is per conversation)', async () => {
    const convA = await makeConversation();
    const convB = await makeConversation({ hostId: STRANGER_ID, guestId: GUEST_ID, propertyId: 'prop-2' });
    const guest = await connect(GUEST_ID);
    const id = cid();
    const a = (await send(guest, { ...plain(convA, 'in A'), clientMessageId: id })) as Ack;
    const b = (await send(guest, { ...plain(convB, 'in B'), clientMessageId: id })) as Ack;
    expect(a.success && b.success).toBe(true);
    expect(a.messageId).not.toBe(b.messageId);
    expect((await rawMessage(b.messageId as string))!.content).toMatchObject({ text: 'in B' }); // Mongoose adds attachments: [] (schema default, unchanged)
    expect((await rawConversation(convA))!.unreadCount[HOST_ID]).toBe(1);
    expect((await rawConversation(convB))!.unreadCount[STRANGER_ID]).toBe(1);
  });
});

describe('database failure boundary at the socket layer (T)', () => {
  it('a DB error mid-transaction acks INTERNAL_ERROR (ambiguous) and the same-id retry completes once', async () => {
    const conv = await makeConversation();
    const host = await connect(HOST_ID);
    const guest = await connect(GUEST_ID);
    await join(host, conv);
    const hostGot = collect(host);
    const spy = jest.spyOn(MessageRepository.prototype, 'createWithConversationUpdate').mockImplementationOnce(() => {
      const e = new Error('connection <monitor> to 127.0.0.1:27117 closed') as Error & { name: string };
      e.name = 'MongoNetworkError';
      throw e;
    });
    const id = cid();
    const first = (await send(guest, { ...plain(conv, 'db down'), clientMessageId: id })) as Ack;
    expect(first).toEqual({ success: false, code: ErrorCode.INTERNAL_ERROR, error: 'Failed to send message' });
    expect(spy).toHaveBeenCalledTimes(1);
    expect(await countMessages({ conversationId: conv })).toBe(0);
    expect((await rawConversation(conv))!.lastMessage).toBeUndefined();
    const retry = (await send(guest, { ...plain(conv, 'db down'), clientMessageId: id })) as Ack;
    expect(retry.success).toBe(true);
    await waitUntil(() => hostGot.length === 1);
    expect(await countMessages({ conversationId: conv })).toBe(1);
    expect((await rawConversation(conv))!.unreadCount[HOST_ID]).toBe(1);
  });
});

describe('resource hygiene', () => {
  it('60 sends do not grow Mongo connections or leave sessions open', async () => {
    const conv = await makeConversation();
    const guest = await connect(GUEST_ID);
    const host = await connect(HOST_ID);
    const admin = mongoose.connection.db!.admin();
    const before = await admin.serverStatus();
    for (let i = 0; i < 30; i++) {
      expect(((await send(guest, plain(conv, `g${i}`))) as Ack).success).toBe(true);
      expect(((await send(host, plain(conv, `h${i}`))) as Ack).success).toBe(true);
    }
    const after = await admin.serverStatus();
    expect(after.connections.current - before.connections.current).toBeLessThanOrEqual(2);
    // every ChatService transaction ended its session: the driver's pool holds no
    // orphaned "in use" sessions (activeSessionsCount counts server-side records
    // refreshed by the cache; a leak would grow it with every send)
    const cacheAfter = after.logicalSessionRecordCache?.activeSessionsCount ?? 0;
    const cacheBefore = before.logicalSessionRecordCache?.activeSessionsCount ?? 0;
    expect(cacheAfter - cacheBefore).toBeLessThanOrEqual(5);
    expect(await MessageModel.countDocuments({ conversationId: conv })).toBe(60);
    // socket listener counts on the server side stay flat (no per-send handlers)
    const serverSockets = [...io.sockets.sockets.values()];
    for (const s of serverSockets) expect(s.listenerCount(SOCKET_EVENTS.MESSAGE_SEND)).toBe(1);
  });
});
