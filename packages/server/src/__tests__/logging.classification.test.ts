// Log classification: a rejection the server produced on purpose (bad input,
// a stranger's join, an expected 403/429) must not reach error-level alerting
// — it logs at warn with its code and enough context to investigate a probe —
// while a real fault (Mongo, a bug) is an error carrying the Error itself.
// Real socket.io clients + Express against a MongoMemoryReplSet, no Redis.
import { createServer, Server as HttpServer } from 'http';
import { AddressInfo } from 'net';
import express from 'express';
import jwt from 'jsonwebtoken';
import { io as ioc, Socket as ClientSocket } from 'socket.io-client';
import { ChatError, ErrorCode, SOCKET_EVENTS } from '@majestic/chat-shared';
import { logger, logFailure } from '../lib/logger';
import { createSocketServer, TypedServer } from '../socket/server';
import { socketAuthMiddleware } from '../middleware/socketAuth';
import { registerMessageEvents } from '../events/messageEvents';
import { registerTypingEvents } from '../events/typingEvents';
import { ChatService } from '../services/ChatService';
import { conversationRoutes } from '../routes/conversationRoutes';
import { startDb, stopDb, clearDb, makeConversation, cid, GUEST_ID, STRANGER_ID } from './helpers/db';

type Ack = { success: boolean; code?: string; error?: string };
type LogCall = [Record<string, unknown>, string];

let httpServer: HttpServer;
let io: TypedServer;
let url: string;
let chatService: ChatService;
const clients: ClientSocket[] = [];
const token = (userId: string) => jwt.sign({ userId, firstName: 'U' }, 'test-jwt-secret');
const warns: LogCall[] = [];
const errors: LogCall[] = [];
const debugs: LogCall[] = [];

function connect(userId: string): Promise<ClientSocket> {
  return new Promise((resolve, reject) => {
    const s = ioc(url, { auth: { token: token(userId) }, transports: ['websocket'], reconnection: false, forceNew: true });
    clients.push(s);
    s.once('connect', () => resolve(s));
    s.once('connect_error', (e: Error) => reject(e));
  });
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
function send(s: ClientSocket, payload: unknown): Promise<Ack> {
  return new Promise((resolve) => s.timeout(4000).emit(SOCKET_EVENTS.MESSAGE_SEND, payload as never, (err: Error | null, res: Ack) => resolve(err ? { success: false, code: 'TIMEOUT' } : res)));
}
const rest = (path: string, tok: string) => fetch(`${url}/api/chat${path}`, { headers: { Authorization: `Bearer ${tok}` } });
const reset = () => { warns.length = 0; errors.length = 0; debugs.length = 0; };
const codes = (calls: LogCall[]) => calls.map(([ctx]) => ctx.code);

beforeAll(async () => {
  await startDb();
  // Every module logs through a child of the base logger; route the children
  // to the base so the spies below see the handlers' and the service's calls.
  jest.spyOn(logger, 'child').mockImplementation((() => logger) as never);
  jest.spyOn(logger, 'warn').mockImplementation(((ctx: Record<string, unknown>, msg: string) => { warns.push([ctx, msg]); }) as never);
  jest.spyOn(logger, 'error').mockImplementation(((ctx: Record<string, unknown>, msg: string) => { errors.push([ctx, msg]); }) as never);
  jest.spyOn(logger, 'debug').mockImplementation(((ctx: Record<string, unknown>, msg: string) => { debugs.push([ctx, msg]); }) as never);

  const app = express();
  app.use(express.json());
  app.use('/api/chat', conversationRoutes);
  httpServer = createServer(app);
  io = createSocketServer(httpServer);
  io.use(socketAuthMiddleware);
  chatService = new ChatService();
  registerMessageEvents(io, chatService);
  registerTypingEvents(io);
  await new Promise<void>((r) => httpServer.listen(0, r));
  url = `http://127.0.0.1:${(httpServer.address() as AddressInfo).port}`;
});
afterAll(async () => {
  for (const c of clients) c.disconnect();
  io.close();
  await new Promise<void>((r) => httpServer.close(() => r()));
  await stopDb();
  jest.restoreAllMocks();
});
beforeEach(async () => {
  await clearDb();
  reset();
});
afterEach(() => {
  for (const c of clients.splice(0)) c.disconnect();
});

describe('logFailure', () => {
  const fake = () => {
    const calls: Record<string, LogCall[]> = { warn: [], error: [], info: [], debug: [] };
    const log = { warn: (c: never, m: string) => calls.warn.push([c, m]), error: (c: never, m: string) => calls.error.push([c, m]), info: (c: never, m: string) => calls.info.push([c, m]), debug: (c: never, m: string) => calls.debug.push([c, m]) };
    return { log: log as never, calls };
  };
  it('a 4xx ChatError is an expected rejection → warn with code, status and reason, never error', () => {
    for (const e of [ChatError.userNotParticipant(), new ChatError(ErrorCode.VALIDATION_ERROR, 'bad'), new ChatError(ErrorCode.RATE_LIMITED, 'slow down'), new ChatError(ErrorCode.MESSAGE_NOT_FOUND, 'gone'), new ChatError(ErrorCode.MODERATION_BLOCKED, 'no')]) {
      const { log, calls } = fake();
      logFailure(log, e, { userId: 'u1' }, 'x');
      expect(calls.error).toHaveLength(0);
      expect(calls.warn).toHaveLength(1);
      expect(calls.warn[0][0]).toMatchObject({ userId: 'u1', code: e.code, statusCode: e.statusCode, reason: e.message });
    }
  });
  it('the expected level is configurable (the service layer uses debug; the caller logs the rejection with request context)', () => {
    const { log, calls } = fake();
    logFailure(log, ChatError.userNotParticipant(), {}, 'x', 'debug');
    expect(calls.debug).toHaveLength(1);
    expect(calls.warn).toHaveLength(0);
    expect(calls.error).toHaveLength(0);
  });
  it('a 5xx ChatError, a plain Error and a non-Error are faults → error with the Error under err', () => {
    for (const e of [new ChatError(ErrorCode.DATABASE_ERROR, 'db'), new Error('mongo down'), 'string failure']) {
      const { log, calls } = fake();
      logFailure(log, e, { conversationId: 'c1' }, 'x', 'debug');
      expect(calls.warn).toHaveLength(0);
      expect(calls.debug).toHaveLength(0);
      expect(calls.error).toHaveLength(1);
      expect(calls.error[0][0]).toMatchObject({ conversationId: 'c1' });
      expect((calls.error[0][0] as { err: unknown }).err).toBe(e);
    }
  });
});

describe('socket handlers', () => {
  it("a stranger's join is refused, logged at warn with USER_NOT_PARTICIPANT and the ids, and never at error", async () => {
    const convId = await makeConversation();
    const stranger = await connect(STRANGER_ID);
    const errs: { code: string }[] = [];
    stranger.on('error', (e: { code: string }) => errs.push(e));
    stranger.emit(SOCKET_EVENTS.CONVERSATION_JOIN, { conversationId: convId });
    await sleep(400);
    expect(errs.map((e) => e.code)).toEqual([ErrorCode.USER_NOT_PARTICIPANT]);
    expect(errors).toHaveLength(0);
    const rejection = warns.find(([, m]) => /join rejected/i.test(m));
    expect(rejection).toBeDefined();
    expect(rejection![0]).toMatchObject({ userId: STRANGER_ID, conversationId: convId, code: ErrorCode.USER_NOT_PARTICIPANT, statusCode: 403 });
  });

  it('a malformed join / read / send payload logs at warn (VALIDATION), never at error', async () => {
    const guest = await connect(GUEST_ID);
    guest.emit(SOCKET_EVENTS.CONVERSATION_JOIN, { conversationId: 'not-an-id' });
    guest.emit(SOCKET_EVENTS.MESSAGE_READ, { nope: true });
    const ack = await send(guest, { junk: 1 });
    await sleep(300);
    expect(ack.success).toBe(false);
    expect(ack.code).toBe(ErrorCode.VALIDATION_ERROR);
    expect(errors).toHaveLength(0);
    expect(warns.filter(([, m]) => /Rejected (join|read) payload/.test(m))).toHaveLength(2);
  });

  it("a stranger's send is refused (403) and logged at warn; the service layer logs it at debug, not error", async () => {
    const convId = await makeConversation();
    const stranger = await connect(STRANGER_ID);
    const ack = await send(stranger, { conversationId: convId, content: { text: 'hi' }, type: 'text', clientMessageId: cid() });
    expect(ack.success).toBe(false);
    expect(ack.code).toBe(ErrorCode.USER_NOT_PARTICIPANT);
    expect(errors).toHaveLength(0);
    expect(codes(warns)).toContain(ErrorCode.USER_NOT_PARTICIPANT);
    expect(codes(debugs)).toContain(ErrorCode.USER_NOT_PARTICIPANT);
  });

  it('a real fault behind a send (the database throws) is an error with the Error object, and the ack is the ambiguous INTERNAL_ERROR', async () => {
    const convId = await makeConversation();
    const guest = await connect(GUEST_ID);
    const boom = new Error('mongo down');
    const spy = jest.spyOn(chatService, 'sendMessage').mockRejectedValueOnce(boom);
    const ack = await send(guest, { conversationId: convId, content: { text: 'hi' }, type: 'text', clientMessageId: cid() });
    spy.mockRestore();
    expect(ack.success).toBe(false);
    expect(ack.code).toBe(ErrorCode.INTERNAL_ERROR);
    expect(errors).toHaveLength(1);
    expect(errors[0][0]).toMatchObject({ userId: GUEST_ID });
    expect((errors[0][0] as { err: unknown }).err).toBe(boom);
    expect(codes(warns)).not.toContain(ErrorCode.INTERNAL_ERROR);
  });
});

describe('REST routes', () => {
  it("a stranger's history request answers 403 and logs at warn, not error", async () => {
    const convId = await makeConversation();
    const res = await rest(`/conversations/${convId}/messages?limit=5`, token(STRANGER_ID));
    expect(res.status).toBe(403);
    expect(errors).toHaveLength(0);
    const w = warns.find(([ctx]) => ctx.code === ErrorCode.USER_NOT_PARTICIPANT);
    expect(w).toBeDefined();
    expect(w![0]).toMatchObject({ userId: STRANGER_ID, conversationId: convId, statusCode: 403 });
  });

  it('an unexpected exception in a route answers 500 and logs at error with the Error', async () => {
    const boom = new Error('unexpected');
    // the routes module owns its own ChatService instance → spy on the prototype
    const spy = jest.spyOn(ChatService.prototype, 'getConversationsByRole').mockRejectedValueOnce(boom);
    const res = await rest('/conversations?role=guest', token(GUEST_ID));
    spy.mockRestore();
    expect(res.status).toBe(500);
    expect(warns.filter(([, m]) => /Error fetching conversations/.test(m))).toHaveLength(0);
    expect(errors.some(([ctx]) => (ctx as { err: unknown }).err === boom)).toBe(true);
  });
});
