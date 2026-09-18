import { createServer, Server as HttpServer } from 'http';
import { AddressInfo } from 'net';
import jwt from 'jsonwebtoken';
import { io as ioc, Socket as ClientSocket } from 'socket.io-client';
import { ErrorCode, MessageModel, SOCKET_EVENTS, CHAT_CONFIG } from '@majestic/chat-shared';
import { createSocketServer, TypedServer } from '../socket/server';
import { socketAuthMiddleware } from '../middleware/socketAuth';
import { registerMessageEvents } from '../events/messageEvents';
import { ChatService } from '../services/ChatService';
import { MessageRepository } from '../repositories/MessageRepository';
import {
  startDb,
  stopDb,
  clearDb,
  makeConversation,
  rawConversation,
  countMessages,
  cid,
  HOST_ID,
  GUEST_ID,
  STRANGER_ID,
} from './helpers/db';

type Ack = { success: boolean; messageId?: string; error?: string; code?: string };
type NewMsg = { message: { id: string; clientMessageId: string; content: { text?: string }; replyTo?: Record<string, unknown> }; conversationId: string };

let httpServer: HttpServer;
let io: TypedServer;
let chatService: ChatService;
let url: string;
const clients: ClientSocket[] = [];

const token = (userId: string, firstName = 'U') => jwt.sign({ userId, firstName }, 'test-jwt-secret');

function connect(userId: string): Promise<ClientSocket> {
  return new Promise((resolve, reject) => {
    const s = ioc(url, { auth: { token: token(userId) }, transports: ['websocket'], reconnection: false, forceNew: true });
    clients.push(s);
    s.once('connect', () => resolve(s));
    s.once('connect_error', reject);
  });
}

async function join(s: ClientSocket, conversationId: string): Promise<void> {
  s.emit(SOCKET_EVENTS.CONVERSATION_JOIN, { conversationId });
  // join is fire-and-forget on the wire: wait until the server put this socket in the room
  const room = `${CHAT_CONFIG.ROOM_PREFIX}${conversationId}`;
  await waitUntil(() => io.sockets.adapter.rooms.get(room)?.has(s.id as string) === true);
}

function send(s: ClientSocket, payload: Record<string, unknown>, timeoutMs = 4000): Promise<Ack | { timedOut: true }> {
  return new Promise((resolve) => {
    s.timeout(timeoutMs).emit(SOCKET_EVENTS.MESSAGE_SEND, payload, (err: Error | null, res: Ack) => {
      resolve(err ? { timedOut: true } : res);
    });
  });
}

function collect(s: ClientSocket): NewMsg[] {
  const arr: NewMsg[] = [];
  s.on(SOCKET_EVENTS.MESSAGE_NEW, (m: NewMsg) => arr.push(m));
  return arr;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function waitUntil(fn: () => boolean, ms = 3000): Promise<void> {
  const t0 = Date.now();
  while (!fn()) {
    if (Date.now() - t0 > ms) throw new Error('waitUntil timed out');
    await sleep(20);
  }
}

const plain = (conversationId: string, text: string, extra: Record<string, unknown> = {}) => ({
  conversationId, content: { text }, type: 'text', clientMessageId: cid(), ...extra,
});

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

describe('reply over the socket', () => {
  it('stores the server snapshot, ignores forged fields, and both parties receive it', async () => {
    const conv = await makeConversation();
    const host = await connect(HOST_ID);
    const guest = await connect(GUEST_ID);
    await join(host, conv);
    await join(guest, conv);
    const hostGot = collect(host);
    const guestGot = collect(guest);

    const a1 = (await send(host, plain(conv, 'Original text'))) as Ack;
    expect(a1.success).toBe(true);
    await waitUntil(() => guestGot.length === 1);

    const a2 = (await send(guest, plain(conv, 'reply', { replyTo: { messageId: a1.messageId, text: 'FORGED', senderId: 'x' } }))) as Ack;
    expect(a2).toEqual({ success: true, messageId: expect.any(String) });
    await waitUntil(() => hostGot.length === 2 && guestGot.length === 2);
    for (const got of [hostGot[1], guestGot[1]]) {
      expect(got.message.replyTo).toEqual({ messageId: a1.messageId, senderId: HOST_ID, text: 'Original text', type: 'text' });
    }
    expect(await countMessages({ conversationId: conv })).toBe(2);
  });

  it('rejects a bogus target with MESSAGE_NOT_FOUND and no broadcast; old-shape payloads still work', async () => {
    const conv = await makeConversation();
    const host = await connect(HOST_ID);
    const guest = await connect(GUEST_ID);
    await join(host, conv);
    await join(guest, conv);
    const hostGot = collect(host);
    const errors: Array<{ code: string }> = [];
    guest.on(SOCKET_EVENTS.ERROR, (e: { code: string }) => errors.push(e));

    const bad = (await send(guest, plain(conv, 'x', { replyTo: { messageId: 'ffffffffffffffffffffffff' } }))) as Ack;
    expect(bad.success).toBe(false);
    expect(bad.code).toBe(ErrorCode.MESSAGE_NOT_FOUND);
    await sleep(200);
    expect(hostGot).toHaveLength(0);
    expect(errors.map((e) => e.code)).toEqual([ErrorCode.MESSAGE_NOT_FOUND]);
    expect(await countMessages({ conversationId: conv })).toBe(0);

    const old = (await send(guest, { conversationId: conv, content: { text: 'old client' }, type: 'text', clientMessageId: cid() })) as Ack;
    expect(old.success).toBe(true);
    await waitUntil(() => hostGot.length === 1);
    expect(hostGot[0].message).not.toHaveProperty('replyTo');
  });

  it('acks human validation errors with VALIDATION_ERROR and stores nothing', async () => {
    const conv = await makeConversation();
    const guest = await connect(GUEST_ID);
    await join(guest, conv);
    const long = (await send(guest, plain(conv, 'a'.repeat(4001)))) as Ack;
    expect(long).toEqual({ success: false, code: ErrorCode.VALIDATION_ERROR, error: 'Message is too long (max 4000 characters)' });
    const malformed = (await send(guest, plain(conv, 'x', { replyTo: { messageId: 'nope' } }))) as Ack;
    expect(malformed).toEqual({ success: false, code: ErrorCode.VALIDATION_ERROR, error: 'Invalid reply target' });
    const garbage = (await send(guest, { conversationId: conv })) as Ack;
    expect(garbage.code).toBe(ErrorCode.VALIDATION_ERROR);
    const ok = (await send(guest, plain(conv, 'a'.repeat(4000)))) as Ack;
    expect(ok.success).toBe(true);
    expect(await countMessages({ conversationId: conv })).toBe(1);
  });

  it('non-participants get USER_NOT_PARTICIPANT (code in the ack)', async () => {
    const conv = await makeConversation();
    const stranger = await connect(STRANGER_ID);
    const res = (await send(stranger, plain(conv, 'hi'))) as Ack;
    expect(res.success).toBe(false);
    expect(res.code).toBe(ErrorCode.USER_NOT_PARTICIPANT);
  });

  it('rate limit is applied before any reply lookup', async () => {
    const userId = 'eeeeeeeeeeeeeeeeeeeeeee5';
    const conv = await makeConversation({ guestId: userId });
    const s = await connect(userId);
    await join(s, conv);
    const first = (await send(s, plain(conv, 'seed'))) as Ack;
    for (let i = 1; i < CHAT_CONFIG.MESSAGES_PER_MINUTE; i++) {
      expect(((await send(s, plain(conv, `m${i}`))) as Ack).success).toBe(true);
    }
    const spy = jest.spyOn(MessageRepository.prototype, 'findReplyTarget');
    const limited = (await send(s, plain(conv, 'over', { replyTo: { messageId: first.messageId } }))) as Ack;
    expect(limited.success).toBe(false);
    expect(limited.code).toBe(ErrorCode.RATE_LIMITED);
    expect(spy).not.toHaveBeenCalled();
    expect(await countMessages({ conversationId: conv })).toBe(CHAT_CONFIG.MESSAGES_PER_MINUTE);
  });
});

describe('delivery boundaries — same clientMessageId retry', () => {
  it('C: persisted, ack + echo lost → retry returns the same id, one row, receiver sees one message', async () => {
    const conv = await makeConversation();
    const host = await connect(HOST_ID);
    await join(host, conv);
    const hostGot = collect(host);

    let guest = await connect(GUEST_ID);
    await join(guest, conv);
    const id = cid();
    // Drop the sender the instant the transaction committed: neither the ack
    // nor the echo can reach it.
    chatService.getEventEmitter().once('message:created', () => guest.disconnect());
    const lost = await send(guest, { ...plain(conv, 'hello?'), clientMessageId: id }, 1500);
    expect(lost).toEqual({ timedOut: true });
    await waitUntil(() => hostGot.length === 1);
    expect(await countMessages({ conversationId: conv, clientMessageId: id })).toBe(1);
    const before = await rawConversation(conv);
    expect(before!.unreadCount[HOST_ID]).toBe(1);

    guest = await connect(GUEST_ID);
    await join(guest, conv);
    const guestGot = collect(guest);
    const retry = (await send(guest, { ...plain(conv, 'hello?'), clientMessageId: id })) as Ack;
    expect(retry.success).toBe(true);
    expect(retry.messageId).toBe(hostGot[0].message.id);
    await waitUntil(() => guestGot.length === 1);
    // at-least-once: the host may now hold a second raw event — same id
    expect(new Set(hostGot.map((m) => m.message.id)).size).toBe(1);
    expect(await countMessages({ conversationId: conv, clientMessageId: id })).toBe(1);
    const after = await rawConversation(conv);
    expect(after!.unreadCount[HOST_ID]).toBe(1);
    expect(after!.lastMessage).toEqual(before!.lastMessage);
  });

  it('F: crash after commit, before broadcast → ambiguous ack; retry delivers without touching the DB', async () => {
    const conv = await makeConversation();
    const host = await connect(HOST_ID);
    const guest = await connect(GUEST_ID);
    await join(host, conv);
    await join(guest, conv);
    const hostGot = collect(host);
    const id = cid();
    const realTo = io.to.bind(io);
    jest.spyOn(io, 'to').mockImplementationOnce(() => {
      throw new Error('simulated crash before broadcast');
    });
    const first = (await send(guest, { ...plain(conv, 'quiet'), clientMessageId: id })) as Ack;
    expect(first).toEqual({ success: false, code: ErrorCode.INTERNAL_ERROR, error: 'Failed to send message' });
    await sleep(150);
    expect(hostGot).toHaveLength(0);
    expect(await countMessages({ conversationId: conv, clientMessageId: id })).toBe(1);
    const before = await rawConversation(conv);
    expect(before!.unreadCount[HOST_ID]).toBe(1);

    (io.to as unknown as jest.Mock).mockImplementation(realTo);
    const retry = (await send(guest, { ...plain(conv, 'quiet'), clientMessageId: id })) as Ack;
    expect(retry.success).toBe(true);
    await waitUntil(() => hostGot.length === 1);
    expect(hostGot[0].message.id).toBe(retry.messageId);
    const after = await rawConversation(conv);
    expect(after!.unreadCount[HOST_ID]).toBe(1);
    expect(after!.lastMessage).toEqual(before!.lastMessage);
    expect(await countMessages({ conversationId: conv, clientMessageId: id })).toBe(1);
  });

  it('G: crash after broadcast, before ack → retry re-broadcasts the same id; receiver dedupes, DB untouched', async () => {
    const conv = await makeConversation();
    const host = await connect(HOST_ID);
    const guest = await connect(GUEST_ID);
    await join(host, conv);
    await join(guest, conv);
    const hostGot = collect(host);
    const id = cid();
    const realTo = io.to.bind(io);
    jest.spyOn(io, 'to').mockImplementationOnce((room: string | string[]) => {
      const b = realTo(room);
      return { emit: (...args: unknown[]) => { (b.emit as (...a: unknown[]) => boolean)(...args); throw new Error('crash after broadcast'); } } as unknown as ReturnType<typeof realTo>;
    });
    const first = (await send(guest, { ...plain(conv, 'twice?'), clientMessageId: id })) as Ack;
    expect(first.code).toBe(ErrorCode.INTERNAL_ERROR);
    await waitUntil(() => hostGot.length === 1);

    (io.to as unknown as jest.Mock).mockImplementation(realTo);
    const retry = (await send(guest, { ...plain(conv, 'twice?'), clientMessageId: id })) as Ack;
    expect(retry.success).toBe(true);
    await waitUntil(() => hostGot.length === 2);
    const ids = new Set(hostGot.map((m) => m.message.id));
    expect(ids.size).toBe(1); // two raw events, one logical message → client dedupe
    expect(await countMessages({ conversationId: conv })).toBe(1);
    expect((await rawConversation(conv))!.unreadCount[HOST_ID]).toBe(1);
  });

  it('D: ack received, echo lost (sender not in the room) → history holds it once', async () => {
    const conv = await makeConversation();
    const guest = await connect(GUEST_ID);
    const guestGot = collect(guest);
    const ack = (await send(guest, plain(conv, 'no room'))) as Ack;
    expect(ack.success).toBe(true);
    await sleep(150);
    expect(guestGot).toHaveLength(0);
    const history = await chatService.getMessages(conv, GUEST_ID, { limit: 50, direction: 'before' });
    expect(history.data.map((m) => m.id)).toEqual([ack.messageId]);
  });

  it('E: two sockets of one user racing the same id → one row, identical acks', async () => {
    const conv = await makeConversation();
    const a = await connect(GUEST_ID);
    const b = await connect(GUEST_ID);
    const id = cid();
    const [ra, rb] = (await Promise.all([
      send(a, { ...plain(conv, 'race'), clientMessageId: id }),
      send(b, { ...plain(conv, 'race'), clientMessageId: id }),
    ])) as Ack[];
    expect(ra.success && rb.success).toBe(true);
    expect(ra.messageId).toBe(rb.messageId);
    expect(await countMessages({ conversationId: conv })).toBe(1);
    expect((await rawConversation(conv))!.unreadCount[HOST_ID]).toBe(1);
  });

  it('G4: a rate-limited retry of an unconfirmed send carries the code and resolves later with the same id', async () => {
    const userId = 'fffffffffffffffffffffff6';
    const conv = await makeConversation({ guestId: userId });
    const host = await connect(HOST_ID);
    await join(host, conv);
    const hostGot = collect(host);
    let s = await connect(userId);
    await join(s, conv);
    const id = cid();
    chatService.getEventEmitter().once('message:created', () => s.disconnect());
    expect(await send(s, { ...plain(conv, 'unconfirmed'), clientMessageId: id }, 1500)).toEqual({ timedOut: true });
    await waitUntil(() => hostGot.length === 1);

    s = await connect(userId);
    await join(s, conv);
    for (let i = 1; i < CHAT_CONFIG.MESSAGES_PER_MINUTE; i++) {
      expect(((await send(s, plain(conv, `fill ${i}`))) as Ack).success).toBe(true);
    }
    const limited = (await send(s, { ...plain(conv, 'unconfirmed'), clientMessageId: id })) as Ack;
    expect(limited).toMatchObject({ success: false, code: ErrorCode.RATE_LIMITED });
    // the client keeps the pending send; the window passes…
    const realNow = Date.now;
    jest.spyOn(Date, 'now').mockImplementation(() => realNow() + 61_000);
    const resolved = (await send(s, { ...plain(conv, 'unconfirmed'), clientMessageId: id })) as Ack;
    expect(resolved).toEqual({ success: true, messageId: hostGot[0].message.id });
    expect(await countMessages({ conversationId: conv, clientMessageId: id })).toBe(1);
  });

  it('a retry of any age never inflates unread or moves lastMessage', async () => {
    const conv = await makeConversation();
    const host = await connect(HOST_ID);
    await join(host, conv);
    const guest = await connect(GUEST_ID);
    await join(guest, conv);
    const id = cid();
    const first = (await send(guest, { ...plain(conv, 'first'), clientMessageId: id })) as Ack;
    for (let i = 0; i < 5; i++) expect(((await send(guest, plain(conv, `later ${i}`))) as Ack).success).toBe(true);
    const before = await rawConversation(conv);
    const replay = (await send(guest, { ...plain(conv, 'first'), clientMessageId: id })) as Ack;
    expect(replay.messageId).toBe(first.messageId);
    const after = await rawConversation(conv);
    expect(after!.unreadCount[HOST_ID]).toBe(6);
    expect(after!.lastMessage).toEqual(before!.lastMessage);
    expect(await MessageModel.countDocuments({ conversationId: conv })).toBe(6);
  });
});
