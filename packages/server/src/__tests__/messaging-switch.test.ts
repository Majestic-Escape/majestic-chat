// Admin "Messaging" switch (settings/messaging in the shared app database):
// when it is off, NOTHING in this service answers — REST, a socket handshake,
// or a packet on a socket that was already open — whatever the caller sends,
// with or without a token. Fail-open on read problems, single-flight reads.
// Real Express + socket.io + MongoMemoryReplSet; the flag is written where the
// widget service's admin API writes it.
import { createServer, Server as HttpServer } from 'http';
import { AddressInfo } from 'net';
import { readFileSync } from 'fs';
import { join } from 'path';
import express from 'express';
import jwt from 'jsonwebtoken';
import mongoose from 'mongoose';
import { io as ioc, Socket as ClientSocket } from 'socket.io-client';
import { ErrorCode, SOCKET_EVENTS } from '@majestic/chat-shared';
import { createSocketServer, TypedServer } from '../socket/server';
import { socketAuthMiddleware } from '../middleware/socketAuth';
import { messagingSocketGate } from '../middleware/messagingGate';
import { registerMessageEvents } from '../events/messageEvents';
import { registerTypingEvents } from '../events/typingEvents';
import { ChatService } from '../services/ChatService';
import { conversationRoutes } from '../routes/conversationRoutes';
import { expireMessagingToggle, isMessagingEnabled, peekMessagingEnabled, resetMessagingToggle } from '../lib/messagingToggle';
import { startDb, stopDb, clearDb, makeConversation, countMessages, cid, GUEST_ID, HOST_ID } from './helpers/db';

const MAIN_DB = 'main-switch-test';
type Ack = { success: boolean; error?: string; code?: string };

const findLog: string[] = [];
let settingsFinds = 0;
    findLog.length = 0; // `find` commands against the shared app database (the flag read)
let httpServer: HttpServer;
let io: TypedServer;
let url: string;
const clients: ClientSocket[] = [];
const token = (userId: string) => jwt.sign({ userId, firstName: 'U' }, 'test-jwt-secret');
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Write (or remove) the flag exactly where the admin API stores it, and drop the local cache. */
async function setFlag(value: boolean | 'malformed' | null): Promise<void> {
  const col = mongoose.connection.useDb(MAIN_DB, { useCache: true }).collection('settings');
  if (value === null) await col.deleteOne({ _id: 'messaging' } as never);
  else await col.updateOne({ _id: 'messaging' } as never, { $set: { enabled: value === 'malformed' ? 'no' : value } }, { upsert: true });
  resetMessagingToggle();
}

function connectRaw(auth: Record<string, unknown>): Promise<{ ok: boolean; error?: Error & { data?: { code?: string } }; socket: ClientSocket }> {
  return new Promise((resolve) => {
    const s = ioc(url, { auth, transports: ['websocket'], reconnection: false, forceNew: true });
    clients.push(s);
    s.once('connect', () => resolve({ ok: true, socket: s }));
    s.once('connect_error', (e) => resolve({ ok: false, error: e as never, socket: s }));
  });
}
const rest = (path: string, tok: string | null, init: RequestInit = {}) =>
  fetch(`${url}/api/chat${path}`, { ...init, headers: { ...(init.headers || {}), ...(tok ? { Authorization: `Bearer ${tok}` } : {}), 'content-type': 'application/json' } });
const send = (s: ClientSocket, conversationId: string): Promise<Ack | { timedOut: true }> =>
  new Promise((resolve) => {
    s.timeout(4000).emit(
      SOCKET_EVENTS.MESSAGE_SEND,
      { conversationId, content: { text: 'hello' }, type: 'text', clientMessageId: cid() } as never,
      (err: Error | null, res: Ack) => resolve(err ? { timedOut: true } : res)
    );
  });

beforeAll(async () => {
  process.env.MAIN_DB_NAME = MAIN_DB;
  await startDb({ monitorCommands: true });
  mongoose.connection.getClient().on('commandStarted', (e) => {
    if (e.databaseName === MAIN_DB && e.commandName === 'find') {
      settingsFinds++;
      findLog.push(String((e.command as Record<string, unknown>).find) + ' ' + JSON.stringify((e.command as Record<string, unknown>).filter));
    }
  });
  const app = express();
  app.use(express.json());
  app.use('/api/chat', conversationRoutes);
  httpServer = createServer(app);
  io = createSocketServer(httpServer);
  // same order as index.ts (asserted against the source below)
  io.use(messagingSocketGate);
  io.use(socketAuthMiddleware);
  registerMessageEvents(io, new ChatService());
  registerTypingEvents(io);
  await new Promise<void>((r) => httpServer.listen(0, r));
  url = `http://127.0.0.1:${(httpServer.address() as AddressInfo).port}`;
});
afterAll(async () => {
  for (const c of clients) c.disconnect();
  io.close();
  await new Promise<void>((r) => httpServer.close(() => r()));
  delete process.env.MAIN_DB_NAME;
  await mongoose.connection.useDb(MAIN_DB).dropDatabase();
  await stopDb();
});
beforeEach(async () => {
  await clearDb();
  await setFlag(null);
});
afterEach(() => {
  for (const c of clients.splice(0)) c.disconnect();
});

describe('switch ON (or never set): behaviour is exactly what it was before the switch existed', () => {
  it('no document → REST answers, a socket connects and sends', async () => {
    const conv = await makeConversation();
    expect((await rest('/conversations', token(GUEST_ID))).status).toBe(200);
    const { ok, socket } = await connectRaw({ token: token(GUEST_ID) });
    expect(ok).toBe(true);
    expect(((await send(socket, conv)) as Ack).success).toBe(true);
  });

  it('enabled:true → same', async () => {
    await setFlag(true);
    expect((await rest('/conversations', token(GUEST_ID))).status).toBe(200);
  });
});

describe('switch OFF: REST refuses everything, before authentication', () => {
  const calls: Array<[string, string]> = [
    ['GET', '/conversations'],
    ['GET', '/conversations/check?propertyId=p&hostId=h&guestId=g'],
    ['POST', '/conversations'],
    ['GET', '/conversations/aaaaaaaaaaaaaaaaaaaaaaa1'],
    ['GET', '/conversations/aaaaaaaaaaaaaaaaaaaaaaa1/messages'],
    ['GET', '/unread-count?role=all'],
    ['GET', '/anything-else-a-prober-invents'],
  ];

  it.each(calls)('%s %s → 503 MESSAGING_DISABLED for a valid token, a garbage token and no token', async (method, path) => {
    await setFlag(false);
    for (const tok of [token(GUEST_ID), 'not-a-jwt', null]) {
      const res = await rest(path, tok, { method, body: method === 'POST' ? '{}' : undefined });
      expect(res.status).toBe(503);
      expect(res.headers.get('cache-control')).toBe('no-store');
      const body = await res.json();
      expect(body).toMatchObject({ success: false, code: ErrorCode.MESSAGING_DISABLED });
      // reveals nothing about conversations, tokens or users
      expect(JSON.stringify(body)).not.toMatch(/token|conversation not found|participant/i);
    }
  });

  it('turning it back on restores service immediately for new calls', async () => {
    await setFlag(false);
    expect((await rest('/conversations', token(GUEST_ID))).status).toBe(503);
    await setFlag(true);
    expect((await rest('/conversations', token(GUEST_ID))).status).toBe(200);
  });
});

describe('switch OFF: sockets', () => {
  it('the handshake is refused — with a valid token, a bad one and none — and carries the code', async () => {
    await setFlag(false);
    for (const auth of [{ token: token(GUEST_ID) }, { token: 'garbage' }, {}]) {
      const r = await connectRaw(auth);
      expect(r.ok).toBe(false);
      expect(r.error?.data?.code).toBe(ErrorCode.MESSAGING_DISABLED);
      expect(r.socket.active).toBe(false); // a middleware refusal is final: the client does not retry
    }
  });

  it('a socket that is ALREADY connected is cut off: the next packet is refused (ack + nothing stored), then the socket is dropped', async () => {
    const conv = await makeConversation();
    const { socket } = await connectRaw({ token: token(GUEST_ID) });
    expect(((await send(socket, conv)) as Ack).success).toBe(true);
    const before = await countMessages({ conversationId: conv });

    const events: string[] = [];
    socket.on('messaging:disabled' as never, (() => { events.push('messaging:disabled'); }) as never);
    const dropped = new Promise<string>((r) => socket.once('disconnect', (reason) => r(reason)));

    // an admin flips it; this instance learns of it (the sweep / next read)
    await setFlag(false);
    await isMessagingEnabled();
    expect(peekMessagingEnabled()).toBe(false);

    const ack = (await send(socket, conv)) as Ack;
    expect(ack.success).toBe(false);
    expect(ack.code).toBe(ErrorCode.MESSAGING_DISABLED);
    expect(await countMessages({ conversationId: conv })).toBe(before); // never reached the service layer
    expect(await dropped).toBe('io server disconnect');
    expect(events).toEqual(['messaging:disabled']);
  });

  it('with no traffic at all, the periodic sweep disconnects idle sockets within its interval', async () => {
    const { socket } = await connectRaw({ token: token(HOST_ID) });
    await isMessagingEnabled(); // warm the cache as a real request would have
    const told = new Promise<boolean>((r) => socket.once('messaging:disabled' as never, () => r(true)));
    const dropped = new Promise<string>((r) => socket.once('disconnect', (reason) => r(reason)));
    await setFlag(false);
    expect(await Promise.race([told, sleep(9000).then(() => false)])).toBe(true);
    expect(await dropped).toBe('io server disconnect');
  }, 20000);
});

describe('fail-open and cost', () => {
  it('a malformed document is treated as ON (never as OFF, never a crash)', async () => {
    await setFlag('malformed');
    expect((await rest('/conversations', token(GUEST_ID))).status).toBe(200);
  });

  it('an admin OFF survives a database blip; a first-ever failed read leaves messaging ON', async () => {
    const boom = async (): Promise<boolean | null> => {
      throw new Error('simulated outage');
    };
    resetMessagingToggle();
    expect(await isMessagingEnabled(boom)).toBe(true);

    resetMessagingToggle();
    expect(await isMessagingEnabled(async () => false)).toBe(false);
    expireMessagingToggle();
    expect(await isMessagingEnabled(boom)).toBe(false);
  });

  it('is single-flight and cached: 200 concurrent callers cost one read, and the next window none', async () => {
    resetMessagingToggle();
    let reads = 0;
    const counting = async () => {
      reads++;
      await sleep(20);
      return true as boolean | null;
    };
    await Promise.all(Array.from({ length: 200 }, () => isMessagingEnabled(counting)));
    expect(reads).toBe(1);
    await Promise.all(Array.from({ length: 200 }, () => isMessagingEnabled(counting)));
    expect(reads).toBe(1);
  });
});

/** `n` requests in batches of 50 (500 at once exceeds the local connection backlog; a batch is still well inside one cache window). */
async function burst(n: number, make: () => Promise<Response>): Promise<number[]> {
  const statuses: number[] = [];
  for (let i = 0; i < n; i += 50) statuses.push(...(await Promise.all(Array.from({ length: Math.min(50, n - i) }, make))).map((r) => r.status));
  return statuses;
}

describe('database cost of the switch (command-monitored)', () => {
  it('500 REST requests in a burst cost ONE read of the flag; the rest are served from memory', async () => {
    resetMessagingToggle();
    settingsFinds = 0;
    findLog.length = 0;
    const calls = await burst(500, () => rest('/unread-count', null));
    expect(calls.every((c) => c === 401)).toBe(true); // ON: reaches auth, as before
    expect({ n: settingsFinds, findLog }).toEqual({ n: 1, findLog: expect.any(Array) });
  });

  it('while OFF, 500 refused requests also cost ONE read (then at most one per 3 s)', async () => {
    await setFlag(false);
    settingsFinds = 0;
    findLog.length = 0;
    const calls = await burst(500, () => rest('/conversations', token(GUEST_ID)));
    expect(calls.every((c) => c === 503)).toBe(true);
    expect({ n: settingsFinds, findLog }).toEqual({ n: 1, findLog: expect.any(Array) });
  });

  it('an idle server (no socket, no request) reads nothing — the sweep skips an empty instance', async () => {
    resetMessagingToggle();
    settingsFinds = 0;
    findLog.length = 0;
    for (let i = 0; i < 40 && io.engine.clientsCount > 0; i++) await sleep(100); // let earlier tests' sockets finish closing
    resetMessagingToggle();
    settingsFinds = 0;
    findLog.length = 0;
    const clients = io.engine.clientsCount;
    await sleep(6500); // longer than one sweep interval (5 s)
    expect({ clients, n: settingsFinds, findLog }).toEqual({ clients: 0, n: 0, findLog: [] });
  }, 15000);

  it('with a socket connected the sweep reads at most once per interval (not per packet)', async () => {
    resetMessagingToggle();
    const conv = await makeConversation();
    const { socket } = await connectRaw({ token: token(GUEST_ID) });
    settingsFinds = 0;
    findLog.length = 0;
    for (let i = 0; i < 30; i++) await send(socket, conv); // 30 sends: packets never re-read the flag
    const afterBurst = settingsFinds;
    expect(afterBurst).toBeLessThanOrEqual(1);
    // Over a 12 s window (two to three 5 s sweep ticks) the reads are the sweep's alone: ~one per tick, never one per packet.
    settingsFinds = 0;
    findLog.length = 0;
    await sleep(12000);
    expect(settingsFinds).toBeGreaterThanOrEqual(1);
    expect(settingsFinds).toBeLessThanOrEqual(3);
  }, 40000);
});

describe('wiring (the gates cannot be dropped from the real server unnoticed)', () => {
  const src = (p: string) => readFileSync(join(__dirname, '..', p), 'utf8').replace(/\r\n/g, '\n');
  it('index.ts: the messaging gate runs before authentication on every socket', () => {
    const s = src('index.ts');
    expect(s.indexOf('io.use(messagingSocketGate)')).toBeGreaterThan(-1);
    expect(s.indexOf('io.use(messagingSocketGate)')).toBeLessThan(s.indexOf('io.use(socketAuthMiddleware)'));
  });
  it('conversationRoutes.ts: the REST gate is registered before any route', () => {
    const s = src('routes/conversationRoutes.ts');
    expect(s.indexOf('router.use(messagingGate)')).toBeGreaterThan(-1);
    expect(s.indexOf('router.use(messagingGate)')).toBeLessThan(s.search(/router\.(get|post|put|patch|delete)\(/));
  });
  it('socket/server.ts: every packet of every socket passes the packet gate', () => {
    expect(src('socket/server.ts')).toContain('socket.use((packet, next) => messagingPacketGate(socket, packet, next))');
  });
});
