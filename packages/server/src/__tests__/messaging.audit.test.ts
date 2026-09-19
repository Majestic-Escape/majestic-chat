// Messaging-system audit: the hardened server contract. Every socket event and
// REST route, adversarial payloads, typing gate, read bounds, oracle parity,
// pagination, join/leave ordering, session freshness against a stub main API,
// the Redis breaker, and the moderation regex budget. Real socket.io-client
// and a real Express app on a MongoMemoryReplSet; no Redis (cache off).
import { createServer, Server as HttpServer } from 'http';
import { AddressInfo } from 'net';
import express from 'express';
import jwt from 'jsonwebtoken';
import { io as ioc, Socket as ClientSocket } from 'socket.io-client';
import { ErrorCode, SOCKET_EVENTS, CHAT_CONFIG, MessageModel, ConversationModel, checkText } from '@majestic/chat-shared';
import { createSocketServer, TypedServer } from '../socket/server';
import { socketAuthMiddleware } from '../middleware/socketAuth';
import { registerMessageEvents } from '../events/messageEvents';
import { registerTypingEvents } from '../events/typingEvents';
import { ChatService } from '../services/ChatService';
import { UnreadCountService } from '../services/UnreadCountService';
import { conversationRoutes } from '../routes/conversationRoutes';
import { resetSessionCache } from '../lib/session';
import { createShutdown } from '../lib/shutdown';
import { startDb, stopDb, clearDb, makeConversation, rawMessage, rawConversation, countMessages, cid, HOST_ID, GUEST_ID, STRANGER_ID } from './helpers/db';

type Ack = { success: boolean; messageId?: string; error?: string; code?: string };
type NewMsg = { message: { id: string; clientMessageId: string; content: { text?: string } }; conversationId: string };
type ErrEvt = { code: string; message: string };
type ReadBy = { userId: string }[];
type Page = { data: { data: { id: string }[]; hasMore: boolean; nextCursor?: string } };
const readBy = async (id: string): Promise<ReadBy> => ((await rawMessage(id)) as { readBy: ReadBy }).readBy;

let httpServer: HttpServer;
let io: TypedServer;
let url: string;
let mainApi: HttpServer;
let mainApiUrl: string;
let mainApiMode: 'ok' | 'reject' | 'down' | 'slow' = 'ok';
const mainApiCalls: string[] = [];
const clients: ClientSocket[] = [];
const token = (userId: string, opts: jwt.SignOptions = {}, extra: Record<string, unknown> = {}) =>
  jwt.sign({ userId, firstName: 'U', ...extra }, 'test-jwt-secret', opts);

function connectRaw(auth: Record<string, unknown>): Promise<{ ok: boolean; error?: string; socket?: ClientSocket }> {
  return new Promise((resolve) => {
    const s = ioc(url, { auth, transports: ['websocket'], reconnection: false, forceNew: true });
    clients.push(s);
    s.once('connect', () => resolve({ ok: true, socket: s }));
    s.once('connect_error', (e: Error) => resolve({ ok: false, error: e.message, socket: s }));
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
function collect<T>(s: ClientSocket, event: string): T[] {
  const arr: T[] = [];
  s.on(event, (m: T) => arr.push(m));
  return arr;
}
const plain = (conversationId: string, text: string, extra: Record<string, unknown> = {}) => ({ conversationId, content: { text }, type: 'text', clientMessageId: cid(), ...extra });
const rest = (path: string, tok: string | null, init: RequestInit = {}) =>
  fetch(`${url}/api/chat${path}`, { ...init, headers: { ...(init.headers || {}), ...(tok ? { Authorization: `Bearer ${tok}` } : {}), 'content-type': 'application/json' } });

beforeAll(async () => {
  await startDb();
  // stub server.me: /auth/check-token answers per mainApiMode
  mainApi = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      mainApiCalls.push(req.url || '');
      if (mainApiMode === 'down') {
        req.socket.destroy();
        return;
      }
      if (mainApiMode === 'slow') {
        setTimeout(() => {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end('{"success":true}');
        }, 5000).unref();
        return;
      }
      if (mainApiMode === 'reject') {
        res.writeHead(401, { 'content-type': 'application/json' });
        res.end('{"success":false,"code":"TOKEN_INVALIDATED"}');
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{"success":true}');
    });
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
  const chatService = new ChatService();
  registerMessageEvents(io, chatService);
  registerTypingEvents(io);
  await new Promise<void>((r) => httpServer.listen(0, r));
  url = `http://127.0.0.1:${(httpServer.address() as AddressInfo).port}`;
});
afterAll(async () => {
  for (const c of clients) c.disconnect();
  io.close();
  await new Promise<void>((r) => httpServer.close(() => r()));
  await new Promise<void>((r) => mainApi.close(() => r()));
  delete process.env.MAIN_API_URL;
  await stopDb();
});
beforeEach(async () => {
  await clearDb();
  mainApiMode = 'ok';
  mainApiCalls.length = 0;
  resetSessionCache();
});
afterEach(() => {
  for (const c of clients.splice(0)) c.disconnect();
});

describe('payload validation on every event (a malformed payload never crashes the process)', () => {
  const junk = [null, undefined, 42, 'str', [], {}, { conversationId: null }, { conversationId: 5 }, { conversationId: 'not-hex' }, { conversationId: 'x'.repeat(50000) }, { conversationId: { $ne: null } }];

  it('join / leave / typing / read survive every junk shape and answer VALIDATION_ERROR where the protocol has an error channel', async () => {
    const g = await connect(GUEST_ID);
    const errors = collect<ErrEvt>(g, SOCKET_EVENTS.ERROR);
    for (const j of junk) {
      g.emit(SOCKET_EVENTS.CONVERSATION_JOIN, j as never);
      g.emit(SOCKET_EVENTS.CONVERSATION_LEAVE, j as never);
      g.emit(SOCKET_EVENTS.TYPING_START, j as never);
      g.emit(SOCKET_EVENTS.TYPING_STOP, j as never);
      g.emit(SOCKET_EVENTS.MESSAGE_READ, j as never);
    }
    await sleep(300);
    expect(g.connected).toBe(true);
    expect(errors.length).toBeGreaterThan(0);
    expect(errors.every((e) => e.code === ErrorCode.VALIDATION_ERROR)).toBe(true);
    // still functional afterwards
    const conv = await makeConversation();
    expect(((await send(g, plain(conv, 'ok'))) as Ack).success).toBe(true);
  });

  it('message:send rejects junk with a definitive VALIDATION_ERROR ack (never INTERNAL/DATABASE, never a timeout)', async () => {
    const g = await connect(GUEST_ID);
    const conv = await makeConversation();
    const cases: unknown[] = [...junk,
      { conversationId: conv, content: { text: 'x' }, type: 'text', clientMessageId: 'x'.repeat(CHAT_CONFIG.MAX_CLIENT_MESSAGE_ID_LENGTH + 1) },
      { conversationId: conv, content: { text: 'x' }, type: 'text', clientMessageId: '' },
      { conversationId: conv, content: { text: 'x', attachments: [{ id: '1', url: 'https://evil.example/p.png', type: 'image', filename: 'a', size: 1, mimeType: 'image/png' }] }, type: 'image', clientMessageId: cid() },
      { conversationId: 'not-an-id', content: { text: 'x' }, type: 'text', clientMessageId: cid() },
    ];
    for (const c of cases) {
      const ack = (await send(g, c)) as Ack;
      expect(ack).toMatchObject({ success: false, code: ErrorCode.VALIDATION_ERROR });
    }
    expect(await countMessages({ conversationId: conv })).toBe(0);
    expect(g.connected).toBe(true);
  });

  it('a 4000-character adversarial message is moderated in milliseconds (ReDoS budget)', () => {
    const inputs = ['a'.repeat(2000) + ' '.repeat(2000), 'x'.repeat(1000) + ' '.repeat(1000) + '(' + ' '.repeat(1000) + 'at' + ' '.repeat(990), 'a.'.repeat(2000), '9'.repeat(4000), ('a' + ' '.repeat(30)).repeat(129), 'a@'.repeat(2000)];
    for (const input of inputs) {
      const t0 = process.hrtime.bigint();
      checkText(input);
      const ms = Number(process.hrtime.bigint() - t0) / 1e6;
      expect(ms).toBeLessThan(50);
    }
    // and real contact info is still caught
    expect(checkText('user (at) example (dot) com').flaggedPatterns).toContain('OBFUSCATED_EMAIL');
    expect(checkText('call me on 9876543210').flaggedPatterns).toEqual(expect.arrayContaining(['INDIAN_PHONE', 'CONTACT_INTENT']));
    expect(checkText('mail me at first.last+tag@sub.example.co.in').flaggedPatterns).toContain('EMAIL');
  });
});

describe('rooms, typing and read', () => {
  it('typing is gated by room membership: a participant who has not joined, and a stranger, cannot inject "typing"', async () => {
    const conv = await makeConversation();
    const host = await connect(HOST_ID);
    const guest = await connect(GUEST_ID);
    const stranger = await connect(STRANGER_ID);
    const seen = collect<{ userId: string; isTyping: boolean }>(guest, SOCKET_EVENTS.TYPING_UPDATE);
    await join(guest, conv);
    host.emit(SOCKET_EVENTS.TYPING_START, { conversationId: conv }); // host not joined yet
    stranger.emit(SOCKET_EVENTS.TYPING_START, { conversationId: conv });
    await sleep(200);
    expect(seen).toEqual([]);
    await join(host, conv);
    host.emit(SOCKET_EVENTS.TYPING_START, { conversationId: conv });
    await waitUntil(() => seen.length === 1);
    expect(seen[0]).toMatchObject({ userId: HOST_ID, isTyping: true });
  });

  it("typing never echoes to the typist's other devices", async () => {
    const conv = await makeConversation();
    const d1 = await connect(HOST_ID);
    const d2 = await connect(HOST_ID);
    const guest = await connect(GUEST_ID);
    await join(d1, conv); await join(d2, conv); await join(guest, conv);
    const onD2 = collect(d2, SOCKET_EVENTS.TYPING_UPDATE), onGuest = collect(guest, SOCKET_EVENTS.TYPING_UPDATE);
    d1.emit(SOCKET_EVENTS.TYPING_START, { conversationId: conv });
    await waitUntil(() => onGuest.length === 1);
    await sleep(100);
    expect(onD2).toEqual([]);
  });

  it('read receipts are bounded and conversation-scoped, the ack carries the reader userId; re-reading is idempotent', async () => {
    const conv = await makeConversation();
    const other = await makeConversation({ guestId: STRANGER_ID });
    const host = await connect(HOST_ID);
    const guest = await connect(GUEST_ID);
    await join(host, conv); await join(guest, conv);
    const m1 = (await send(host, plain(conv, 'one'))) as Ack;
    const foreign = (await send(host, plain(other, 'other'))) as Ack;
    const errors = collect<ErrEvt>(guest, SOCKET_EVENTS.ERROR);
    const acks = collect<{ messageIds: string[] }>(host, SOCKET_EVENTS.MESSAGE_READ_ACK);
    guest.emit(SOCKET_EVENTS.MESSAGE_READ, { conversationId: conv, messageIds: Array.from({ length: CHAT_CONFIG.MAX_READ_BATCH + 1 }, () => m1.messageId) });
    await waitUntil(() => errors.length === 1);
    expect(errors[0].code).toBe(ErrorCode.VALIDATION_ERROR);
    expect(acks).toEqual([]);
    guest.emit(SOCKET_EVENTS.MESSAGE_READ, { conversationId: conv, messageIds: [m1.messageId as string, foreign.messageId as string] });
    await waitUntil(() => acks.length === 1);
    // the read ack carries the reader under `userId` (the field both pages key on)
    expect(acks[0]).toMatchObject({ conversationId: conv, userId: GUEST_ID, messageIds: [m1.messageId, foreign.messageId] });
    expect((await readBy(foreign.messageId as string)).some((r) => r.userId === GUEST_ID)).toBe(false);
    expect((await readBy(m1.messageId as string)).filter((r) => r.userId === GUEST_ID)).toHaveLength(1);
    expect((await rawConversation(conv))!.unreadCount[GUEST_ID]).toBe(0);
    guest.emit(SOCKET_EVENTS.MESSAGE_READ, { conversationId: conv, messageIds: [m1.messageId as string] });
    await waitUntil(() => acks.length === 2);
    expect((await readBy(m1.messageId as string)).filter((r) => r.userId === GUEST_ID)).toHaveLength(1);
  });

  it('a message that lands while a read receipt is in flight stays counted; the counter follows readBy truth and heals old drift', async () => {
    const conv = await makeConversation();
    const host = await connect(HOST_ID);
    const guest = await connect(GUEST_ID);
    await join(host, conv); await join(guest, conv);
    const unreadPushes = collect<{ totalUnread: number; role: string }>(guest, SOCKET_EVENTS.UNREAD_COUNT_UPDATE);
    const first = (await send(host, plain(conv, 'first'))) as Ack;
    await waitUntil(() => unreadPushes.length === 1);
    expect((await rawConversation(conv))!.unreadCount[GUEST_ID]).toBe(1);
    // the receipt for "first" and a second message race each other
    const second = send(host, plain(conv, 'second, racing the receipt'));
    guest.emit(SOCKET_EVENTS.MESSAGE_READ, { conversationId: conv, messageIds: [first.messageId as string] });
    const secondAck = (await second) as Ack;
    await waitUntil(() => unreadPushes.length >= 3);
    await sleep(150);
    expect((await rawConversation(conv))!.unreadCount[GUEST_ID]).toBe(1);
    expect((await readBy(secondAck.messageId as string)).some((r) => r.userId === GUEST_ID)).toBe(false);
    expect(unreadPushes[unreadPushes.length - 1].totalUnread).toBe(1);
    // a receipt is not a conversation update: lists sort by updatedAt, so the
    // thread being read must not jump to the top of either participant's list
    const updatedAtBefore = (await rawConversation(conv))!.updatedAt;
    // legacy drift (a counter zeroed by the old unconditional reset while a message was unread) heals on the next receipt
    await ConversationModel.updateOne({ _id: conv }, { $set: { [`unreadCount.${GUEST_ID}`]: 0 } }, { timestamps: false });
    guest.emit(SOCKET_EVENTS.MESSAGE_READ, { conversationId: conv, messageIds: [first.messageId as string] }); // already read: nothing new to mark
    await waitUntil(() => unreadPushes.length >= 4);
    expect((await rawConversation(conv))!.unreadCount[GUEST_ID]).toBe(1);
    expect(unreadPushes[unreadPushes.length - 1].totalUnread).toBe(1);
    expect((await rawConversation(conv))!.updatedAt).toEqual(updatedAtBefore);
    // an already-applied receipt changes nothing: the counter stays, updatedAt stays, and the
    // role total is served from the cache instead of being invalidated and recounted
    const recounts = jest.spyOn(UnreadCountService.prototype, 'recalculateUnread');
    guest.emit(SOCKET_EVENTS.MESSAGE_READ, { conversationId: conv, messageIds: [first.messageId as string] });
    await waitUntil(() => unreadPushes.length >= 5);
    expect((await rawConversation(conv))!.unreadCount[GUEST_ID]).toBe(1);
    expect((await rawConversation(conv))!.updatedAt).toEqual(updatedAtBefore);
    expect(recounts).not.toHaveBeenCalled();
    recounts.mockRestore();
    // reading the second one brings it to 0 (still without touching updatedAt)
    guest.emit(SOCKET_EVENTS.MESSAGE_READ, { conversationId: conv, messageIds: [secondAck.messageId as string] });
    await waitUntil(() => unreadPushes.length >= 6);
    expect((await rawConversation(conv))!.unreadCount[GUEST_ID]).toBe(0);
    expect(unreadPushes[unreadPushes.length - 1].totalUnread).toBe(0);
    expect((await rawConversation(conv))!.updatedAt).toEqual(updatedAtBefore);
    // drift ABOVE the truth (a decrement that failed half-way) comes down on the next receipt,
    // even one that marks nothing new — the badge must not show phantom unread for good
    await ConversationModel.updateOne({ _id: conv }, { $set: { [`unreadCount.${GUEST_ID}`]: 5 } }, { timestamps: false });
    guest.emit(SOCKET_EVENTS.MESSAGE_READ, { conversationId: conv, messageIds: [secondAck.messageId as string] });
    await waitUntil(() => unreadPushes.length >= 7);
    expect((await rawConversation(conv))!.unreadCount[GUEST_ID]).toBe(0);
    expect(unreadPushes[unreadPushes.length - 1].totalUnread).toBe(0);
    expect((await rawConversation(conv))!.updatedAt).toEqual(updatedAtBefore);
    // ...and a message that lands while such a receipt is in flight is still not lost
    await ConversationModel.updateOne({ _id: conv }, { $set: { [`unreadCount.${GUEST_ID}`]: 5 } }, { timestamps: false });
    const third = send(host, plain(conv, 'third, racing a converging receipt'));
    guest.emit(SOCKET_EVENTS.MESSAGE_READ, { conversationId: conv, messageIds: [secondAck.messageId as string] });
    const thirdAck = (await third) as Ack;
    await waitUntil(() => unreadPushes.length >= 9);
    await sleep(150);
    // the racing message is never lost: either the receipt converged (1) or the send moved the
    // counter under it and the receipt fell back to the relative update (6, drift kept)…
    expect([1, 6]).toContain((await rawConversation(conv))!.unreadCount[GUEST_ID]);
    expect((await readBy(thirdAck.messageId as string)).some((r) => r.userId === GUEST_ID)).toBe(false);
    // …and the next quiet receipt converges for good
    guest.emit(SOCKET_EVENTS.MESSAGE_READ, { conversationId: conv, messageIds: [secondAck.messageId as string] });
    await waitUntil(() => unreadPushes.length >= 10);
    expect((await rawConversation(conv))!.unreadCount[GUEST_ID]).toBe(1);
    expect(unreadPushes[unreadPushes.length - 1].totalUnread).toBe(1);
  });

  it("a conversation whose unread map has no entry for a user counts 0 for them — never the other participant's counter (legacy documents)", async () => {
    // legacy shape: only the guest's counter exists (created by a host send before both keys were initialised at creation)
    const legacy = await ConversationModel.create({ propertyId: 'legacy-p', participants: [{ userId: HOST_ID, role: 'host', firstName: 'Hosty', joinedAt: new Date() }, { userId: GUEST_ID, role: 'guest', firstName: 'Test', joinedAt: new Date() }], unreadCount: { [GUEST_ID]: 3 }, status: 'active' });
    const one = await rest('/unread-count?role=host', token(HOST_ID));
    expect(((await one.json()) as { data: { totalUnread: number } }).data.totalUnread).toBe(0);
    const both = await rest('/unread-count?role=all', token(HOST_ID));
    expect(((await both.json()) as { data: { host: number } }).data).toMatchObject({ host: 0 });
    const guestSide = await rest('/unread-count?role=guest', token(GUEST_ID));
    expect(((await guestSide.json()) as { data: { totalUnread: number } }).data.totalUnread).toBe(3);
    await ConversationModel.deleteOne({ _id: legacy._id });
  });

  it('join then immediately leave ends not joined (membership follows emission order)', async () => {
    const conv = await makeConversation();
    const host = await connect(HOST_ID);
    const guest = await connect(GUEST_ID);
    await join(host, conv);
    const seen = collect<NewMsg>(guest, SOCKET_EVENTS.MESSAGE_NEW);
    guest.emit(SOCKET_EVENTS.CONVERSATION_JOIN, { conversationId: conv });
    guest.emit(SOCKET_EVENTS.CONVERSATION_LEAVE, { conversationId: conv });
    await sleep(300);
    const room = `${CHAT_CONFIG.ROOM_PREFIX}${conv}`;
    expect(io.sockets.adapter.rooms.get(room)?.has(guest.id as string) ?? false).toBe(false);
    await send(host, plain(conv, 'x'));
    await sleep(200);
    expect(seen).toEqual([]);
  });

  it('unknown and foreign conversations are indistinguishable on join, send and REST', async () => {
    const conv = await makeConversation();
    const stranger = await connect(STRANGER_ID);
    const errors = collect<ErrEvt>(stranger, SOCKET_EVENTS.ERROR);
    const unknown = 'f'.repeat(24);
    const a = (await send(stranger, plain(conv, 'a'))) as Ack;
    const b = (await send(stranger, plain(unknown, 'b'))) as Ack;
    expect(a.code).toBe(b.code);
    expect(a.code).toBe(ErrorCode.USER_NOT_PARTICIPANT);
    // (the two rejected sends above also emitted error events — count only the join errors)
    const beforeJoin = errors.length;
    stranger.emit(SOCKET_EVENTS.CONVERSATION_JOIN, { conversationId: conv });
    stranger.emit(SOCKET_EVENTS.CONVERSATION_JOIN, { conversationId: unknown });
    await waitUntil(() => errors.length === beforeJoin + 2);
    const joinErrors = errors.slice(beforeJoin);
    expect(joinErrors.map((e) => e.code)).toEqual([ErrorCode.USER_NOT_PARTICIPANT, ErrorCode.USER_NOT_PARTICIPANT]);
    const room = `${CHAT_CONFIG.ROOM_PREFIX}${conv}`;
    expect(io.sockets.adapter.rooms.get(room)?.has(stranger.id as string) ?? false).toBe(false);
    const r1 = await rest(`/conversations/${conv}`, token(STRANGER_ID));
    const r2 = await rest(`/conversations/${unknown}`, token(STRANGER_ID));
    expect(r1.status).toBe(r2.status);
    const h1 = await rest(`/conversations/${conv}/messages`, token(STRANGER_ID));
    const h2 = await rest(`/conversations/${unknown}/messages`, token(STRANGER_ID));
    expect(h1.status).toBe(h2.status);
  });

  it('light-event flood is capped per user (join spam does not become a lookup storm)', async () => {
    const g = await connect(GUEST_ID);
    const conv = await makeConversation();
    const findById = jest.spyOn(ChatService.prototype, 'getConversation');
    for (let i = 0; i < CHAT_CONFIG.LIGHT_EVENTS_PER_MINUTE + 100; i++) g.emit(SOCKET_EVENTS.CONVERSATION_JOIN, { conversationId: i === 0 ? conv : 'a'.repeat(23) + (i % 10) });
    await sleep(500);
    expect(findById.mock.calls.length).toBeLessThanOrEqual(CHAT_CONFIG.LIGHT_EVENTS_PER_MINUTE);
    findById.mockRestore();
    expect(g.connected).toBe(true);
  });
});

describe('REST', () => {
  it('history pagination is bounded, validated and tie-safe', async () => {
    const conv = await makeConversation();
    const host = await connect(HOST_ID);
    // 12 messages, several with identical createdAt
    const now = new Date();
    for (let i = 0; i < 12; i++) {
      await MessageModel.create({ conversationId: conv, senderId: HOST_ID, clientMessageId: cid(), type: 'text', content: { text: `m${i}` }, moderation: { status: 'clean', flags: [], confidence: 0 }, readBy: [], status: 'sent', createdAt: new Date(now.getTime() + Math.floor(i / 3) * 1000) });
    }
    const big = await rest(`/conversations/${conv}/messages?limit=100000`, token(HOST_ID));
    expect(big.status).toBe(200);
    expect(((await big.json()) as Page).data.data.length).toBe(12);
    expect((await rest(`/conversations/${conv}/messages?limit=abc`, token(HOST_ID))).status).toBe(400);
    expect((await rest(`/conversations/${conv}/messages?limit=0`, token(HOST_ID))).status).toBe(400);
    expect((await rest(`/conversations/${conv}/messages?cursor=zzz`, token(HOST_ID))).status).toBe(400);
    expect((await rest(`/conversations/not-an-id/messages`, token(HOST_ID))).status).toBe(400);
    let cursor: string | undefined;
    const seen: string[] = [];
    for (let page = 0; page < 10; page++) {
      const r = (await (await rest(`/conversations/${conv}/messages?limit=5${cursor ? '&cursor=' + cursor : ''}`, token(HOST_ID))).json()) as Page;
      seen.push(...r.data.data.map((m) => m.id));
      if (!r.data.hasMore) break;
      cursor = r.data.nextCursor;
    }
    expect(seen).toHaveLength(12);
    expect(new Set(seen).size).toBe(12);
    void host;
  });

  it('conversation creation validates ids and is rate limited per user', async () => {
    const body = (o: Record<string, unknown>) => JSON.stringify({ propertyId: 'b'.repeat(24), hostId: HOST_ID, guestId: GUEST_ID, ...o });
    // main API stub answers 200 without a host field → validation allows (documented fail-open)
    expect((await rest('/conversations', token(GUEST_ID), { method: 'POST', body: body({ guestId: 'nope' }) })).status).toBe(400);
    expect((await rest('/conversations', token(GUEST_ID), { method: 'POST', body: body({ hostId: GUEST_ID }) })).status).toBe(400);
    expect((await rest('/conversations', token(GUEST_ID), { method: 'POST', body: body({ guestFirstName: 'x'.repeat(101) }) })).status).toBe(400);
    expect((await rest('/conversations', token(STRANGER_ID), { method: 'POST', body: body({}) })).status).toBe(403);
    let limited = 0;
    for (let i = 0; i < CHAT_CONFIG.CONVERSATIONS_PER_MINUTE + 5; i++) {
      const r = await rest('/conversations', token(HOST_ID), { method: 'POST', body: body({ guestId: ('c'.repeat(23) + (i % 10)), propertyId: ('d'.repeat(22) + String(i).padStart(2, '0')) }) });
      if (r.status === 429) limited++;
    }
    expect(limited).toBe(5);
  });
});

describe('session freshness (server.me check-token)', () => {
  it('a token the main API rejects cannot connect or call REST; the verdict is cached', async () => {
    mainApiMode = 'reject';
    const t = token(GUEST_ID, {}, { tokenVersion: 99 });
    const r = await connectRaw({ token: t });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/invalidated/i);
    expect((await rest('/conversations?role=guest', t)).status).toBe(401);
    expect(mainApiCalls.length).toBe(1); // second check served from cache
  });

  it('an accepted session is checked once per token, then cached', async () => {
    const t = token(GUEST_ID);
    for (let i = 0; i < 3; i++) expect((await rest('/conversations?role=guest', t)).status).toBe(200);
    expect((await connectRaw({ token: t })).ok).toBe(true);
    expect(mainApiCalls.length).toBe(1);
  });

  it('main API down or slow → fail-open (chat keeps working on the signature)', async () => {
    mainApiMode = 'down';
    expect((await connectRaw({ token: token(GUEST_ID) })).ok).toBe(true);
    resetSessionCache();
    mainApiMode = 'slow';
    const t0 = Date.now();
    expect((await rest('/conversations?role=guest', token(HOST_ID))).status).toBe(200);
    expect(Date.now() - t0).toBeLessThan(4500); // 3 s request timeout, not the stub's 5 s
  }, 15000);

  it('a token with a malformed userId claim is rejected even with a valid signature', async () => {
    const r = await connectRaw({ token: jwt.sign({ userId: 'admin', firstName: 'x' }, 'test-jwt-secret') });
    expect(r.ok).toBe(false);
    expect((await rest('/conversations?role=guest', jwt.sign({ userId: { $ne: null }, firstName: 'x' }, 'test-jwt-secret'))).status).toBe(401);
  });
});

describe('graceful shutdown (SIGTERM on a deploy)', () => {
  it('closes every socket first so clients reconnect immediately, then exits 0; a second signal is ignored', async () => {
    // own server so the suite's io survives
    const srv = createServer();
    const io2 = createSocketServer(srv);
    io2.use(socketAuthMiddleware);
    await new Promise<void>((r) => srv.listen(0, r));
    const url2 = `http://127.0.0.1:${(srv.address() as AddressInfo).port}`;
    const s = ioc(url2, { auth: { token: token(GUEST_ID) }, transports: ['websocket'], reconnection: false, forceNew: true });
    clients.push(s);
    await new Promise<void>((r) => s.once('connect', () => r()));
    const exits: number[] = [];
    const reasons: string[] = [];
    s.on('disconnect', (reason) => reasons.push(reason));
    const shutdown = createShutdown(io2, (code) => exits.push(code), 5000);
    const t0 = Date.now();
    shutdown('SIGTERM');
    shutdown('SIGTERM');
    await waitUntil(() => exits.length > 0, 5000);
    expect(exits).toEqual([0]);
    expect(reasons).toEqual(['transport close']);
    expect(Date.now() - t0).toBeLessThan(3000);
    expect(srv.listening).toBe(false);
    // (the helper connected mongoose directly, so disconnectDatabase() had no cached connection to close — the suite keeps its DB)
  }, 15000);
});

describe('Redis breaker (cache helpers never stall a request)', () => {
  it('with REDIS_URL pointing at a closed port every helper returns a miss within milliseconds', async () => {
    process.env.REDIS_URL = 'redis://127.0.0.1:1';
    jest.resetModules();
    const cache = await import('../lib/cache');
    const t0 = Date.now();
    expect(await cache.cacheGet('k')).toBeNull();
    await cache.cacheSetEx('k', 10, 'v');
    await cache.cacheDel('k');
    expect(await cache.cacheMget(['a', 'b'])).toEqual([null, null]);
    expect(Date.now() - t0).toBeLessThan(2500);
    expect(cache.cacheSuspended()).toBe(true);
    (await import('../lib/redis')).closeRedisClients();
    delete process.env.REDIS_URL;
    jest.resetModules();
  }, 10000);
});
