// Live participant first names: a rename in server.me (`users.firstName` in
// the main DB) reaches the conversation lists, the detail route and POST
// /conversations; the stored snapshot is the fallback; the permission-check
// paths (send, history, socket join, read) never query the main DB.
import { createServer, Server as HttpServer } from 'http';
import { AddressInfo } from 'net';
import express from 'express';
import jwt from 'jsonwebtoken';
import mongoose from 'mongoose';
import { io as ioc, Socket as ClientSocket } from 'socket.io-client';
import { CHAT_CONFIG, ConversationModel, ParticipantRole, SOCKET_EVENTS } from '@majestic/chat-shared';
import { createSocketServer, TypedServer } from '../socket/server';
import { socketAuthMiddleware } from '../middleware/socketAuth';
import { registerMessageEvents } from '../events/messageEvents';
import { ChatService } from '../services/ChatService';
import { conversationRoutes } from '../routes/conversationRoutes';
import { resetSessionCache } from '../lib/session';
import { logger } from '../lib/logger';
import { resetLiveNamesWarning, withLiveFirstNames } from '../lib/liveNames';
import { startDb, stopDb, clearDb, makeConversation, cid, HOST_ID, GUEST_ID } from './helpers/db';

// An in-memory stand-in for Redis so the list cache hit / miss split is real
// (the suite otherwise runs without Redis, where every read is a miss).
jest.mock('../lib/cache', () => {
  const store = new Map<string, string>();
  return {
    __store: store,
    cacheSuspended: () => false,
    cacheGet: async (key: string) => store.get(key) ?? null,
    cacheMget: async (keys: string[]) => keys.map((k) => store.get(k) ?? null),
    cacheSetEx: async (key: string, _ttl: number, value: string) => {
      store.set(key, value);
    },
    cacheDel: async (...keys: string[]) => {
      for (const k of keys) store.delete(k);
    },
  };
});
const cacheStore: Map<string, string> = jest.requireMock('../lib/cache').__store;

const MAIN_DB = 'main-test';
process.env.MAIN_DB_NAME = MAIN_DB;

const ALLOWED_PARTICIPANT_KEYS = ['firstName', 'joinedAt', 'role', 'userId'];
const DEGRADED_MSG = 'Live participant names unavailable - serving stored snapshots';

let httpServer: HttpServer;
let mainApi: HttpServer;
let io: TypedServer;
let url: string;
const clients: ClientSocket[] = [];
let mainApiGuestName = 'Priya';
let mainApiHostName = 'Rahul';

/** Every command the driver sends to the main DB, recorded via command monitoring. */
const mainDbCommands: Array<{ name: string; collection: unknown }> = [];
const usersFinds = () => mainDbCommands.filter((c) => c.name === 'find' && c.collection === 'users').length;

const token = (userId: string) => jwt.sign({ userId, firstName: 'U' }, 'test-jwt-secret');
const users = () => mongoose.connection.useDb(MAIN_DB, { useCache: true }).collection('users');

async function seedUser(id: string, firstName: unknown): Promise<void> {
  await users().insertOne({
    _id: new mongoose.Types.ObjectId(id),
    firstName,
    lastName: 'Secretlast',
    email: 'secret@example.com',
    phone: '9876543210',
  } as any);
}

async function rest(path: string, userId: string, init: RequestInit = {}): Promise<{ status: number; body: any }> {
  const res = await fetch(`${url}/api/chat${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${token(userId)}`, 'content-type': 'application/json', ...(init.headers || {}) },
  });
  return { status: res.status, body: await res.json() };
}

/** MC-PRIV-01: a participant carries exactly the public fields, nothing from the users doc. */
function expectPublic(conv: any): void {
  for (const p of conv.participants) {
    for (const key of Object.keys(p)) expect(ALLOWED_PARTICIPANT_KEYS).toContain(key);
  }
  expect(JSON.stringify(conv)).not.toMatch(/Secretlast|secret@example\.com|9876543210|lastName|"_id"/);
}

const nameOf = (conv: any, role: string) => conv.participants.find((p: any) => p.role === role)?.firstName;

function connect(userId: string): Promise<ClientSocket> {
  return new Promise((resolve, reject) => {
    const s = ioc(url, { auth: { token: token(userId) }, transports: ['websocket'], reconnection: false, forceNew: true });
    clients.push(s);
    s.once('connect', () => resolve(s));
    s.once('connect_error', reject);
  });
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function waitUntil(fn: () => boolean, ms = 3000): Promise<void> {
  const t0 = Date.now();
  while (!fn()) {
    if (Date.now() - t0 > ms) throw new Error('waitUntil timed out');
    await sleep(20);
  }
}

beforeAll(async () => {
  await startDb({ monitorCommands: true });
  mongoose.connection.getClient().on('commandStarted', (e) => {
    if (e.databaseName === MAIN_DB) mainDbCommands.push({ name: e.commandName, collection: e.command[e.commandName] });
  });

  mainApi = createServer((req, res) => {
    const u = req.url || '';
    res.setHeader('content-type', 'application/json');
    if (u.startsWith('/api/v1/auth/check-token')) {
      res.end('{"success":true}');
    } else if (/^\/api\/v1\/guests\/info\/[a-f0-9]{24}/.test(u)) {
      res.end(JSON.stringify({ user: { firstName: mainApiGuestName } }));
    } else if (u.startsWith('/api/v1/properties/')) {
      res.end(JSON.stringify({ success: true, data: { host: { _id: HOST_ID, firstName: mainApiHostName } } }));
    } else {
      res.statusCode = 404;
      res.end('{}');
    }
  });
  await new Promise<void>((r) => mainApi.listen(0, r));
  process.env.MAIN_API_URL = `http://127.0.0.1:${(mainApi.address() as AddressInfo).port}/api/v1`;

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
  delete process.env.MAIN_DB_NAME;
  await stopDb();
});

beforeEach(async () => {
  await clearDb(); // default (chat) DB only
  await users().deleteMany({});
  cacheStore.clear();
  resetSessionCache();
  resetLiveNamesWarning();
  mainApiGuestName = 'Priya';
  mainApiHostName = 'Rahul';
  mainDbCommands.length = 0;
});

afterEach(() => {
  jest.restoreAllMocks();
});

describe('MC-NAME-01 live first names on every name-carrying REST path', () => {
  it('lists (?role=host, ?role=guest, no role) show the renamed name; one users find per cache miss, none on a hit', async () => {
    const conv = await makeConversation(); // snapshots: host "Hosty", guest "Test"
    await seedUser(HOST_ID, 'Arjun');
    await seedUser(GUEST_ID, 'Meera');
    mainDbCommands.length = 0;

    const hostList = await rest('/conversations?role=host', HOST_ID);
    expect(hostList.status).toBe(200);
    expect(hostList.body.data).toHaveLength(1);
    expect(hostList.body.data[0].id).toBe(conv);
    expect(nameOf(hostList.body.data[0], 'guest')).toBe('Meera');
    expect(nameOf(hostList.body.data[0], 'host')).toBe('Arjun');
    expectPublic(hostList.body.data[0]);
    expect(usersFinds()).toBe(1);

    const guestList = await rest('/conversations?role=guest', GUEST_ID);
    expect(nameOf(guestList.body.data[0], 'host')).toBe('Arjun');
    expectPublic(guestList.body.data[0]);
    expect(usersFinds()).toBe(2);

    const all = await rest('/conversations', GUEST_ID);
    expect(nameOf(all.body.data[0], 'host')).toBe('Arjun');
    expect(nameOf(all.body.data[0], 'guest')).toBe('Meera');
    expectPublic(all.body.data[0]);
    expect(usersFinds()).toBe(3);

    // the cached list carries the live name: a hit costs no main-DB query
    expect(cacheStore.get(`convlist:host:${HOST_ID}`)).toContain('Meera');
    const hit = await rest('/conversations?role=host', HOST_ID);
    expect(nameOf(hit.body.data[0], 'guest')).toBe('Meera');
    expect(usersFinds()).toBe(3);

    // a rename shows up once the list entry expires (TTL simulated by eviction)
    await users().updateOne({ _id: new mongoose.Types.ObjectId(GUEST_ID) }, { $set: { firstName: 'Kavya' } });
    cacheStore.delete(`convlist:host:${HOST_ID}`);
    mainDbCommands.length = 0;
    const renamed = await rest('/conversations?role=host', HOST_ID);
    expect(nameOf(renamed.body.data[0], 'guest')).toBe('Kavya');
    expect(usersFinds()).toBe(1);
  });

  it('the detail route shows the live name (one users find per call, conv: cache or not)', async () => {
    const conv = await makeConversation();
    await seedUser(GUEST_ID, 'Meera');
    mainDbCommands.length = 0;

    const first = await rest(`/conversations/${conv}`, HOST_ID);
    expect(first.status).toBe(200);
    expect(nameOf(first.body.data, 'guest')).toBe('Meera');
    expect(nameOf(first.body.data, 'host')).toBe('Hosty'); // no users doc → snapshot
    expectPublic(first.body.data);
    expect(usersFinds()).toBe(1);

    // the conv: cache entry itself keeps the snapshot (it is the permission cache)
    expect(cacheStore.get(`conv:${conv}`)).toContain('"Test"');
    const second = await rest(`/conversations/${conv}`, HOST_ID);
    expect(nameOf(second.body.data, 'guest')).toBe('Meera');
    expect(usersFinds()).toBe(2);
  });

  it('POST on an existing thread returns the live names', async () => {
    const propertyId = new mongoose.Types.ObjectId().toString();
    const conv = await makeConversation({ propertyId });
    await seedUser(HOST_ID, 'Arjun');
    await seedUser(GUEST_ID, 'Meera');
    mainDbCommands.length = 0;

    const res = await rest('/conversations', GUEST_ID, { method: 'POST', body: JSON.stringify({ propertyId, hostId: HOST_ID, guestId: GUEST_ID }) });
    expect(res.status).toBe(200);
    expect(res.body.data.id).toBe(conv);
    expect(nameOf(res.body.data, 'host')).toBe('Arjun');
    expect(nameOf(res.body.data, 'guest')).toBe('Meera');
    expectPublic(res.body.data);
    expect(usersFinds()).toBe(1);
  });

  it('POST create returns only { userId, role, joinedAt, firstName } per participant, with live names', async () => {
    const propertyId = new mongoose.Types.ObjectId().toString();
    await seedUser(HOST_ID, 'Arjun');
    await seedUser(GUEST_ID, 'Meera');
    mainDbCommands.length = 0;

    const res = await rest('/conversations', GUEST_ID, { method: 'POST', body: JSON.stringify({ propertyId, hostId: HOST_ID, guestId: GUEST_ID }) });
    expect(res.status).toBe(200);
    for (const p of res.body.data.participants) {
      expect(Object.keys(p).sort()).toEqual(ALLOWED_PARTICIPANT_KEYS);
    }
    expect(nameOf(res.body.data, 'host')).toBe('Arjun');
    expect(nameOf(res.body.data, 'guest')).toBe('Meera');
    expectPublic(res.body.data);
    expect(usersFinds()).toBe(1);

    // the stored snapshot is still the creation-time name from server.me's API
    const raw = await ConversationModel.findById(res.body.data.id).lean();
    expect(raw!.participants.map((p: any) => p.firstName).sort()).toEqual(['Priya', 'Rahul']);
  });

  it('POST create without users docs returns the snapshot names, still in the public shape', async () => {
    const propertyId = new mongoose.Types.ObjectId().toString();
    const res = await rest('/conversations', HOST_ID, { method: 'POST', body: JSON.stringify({ propertyId, hostId: HOST_ID, guestId: GUEST_ID }) });
    expect(res.status).toBe(200);
    expect(nameOf(res.body.data, 'host')).toBe('Rahul');
    expect(nameOf(res.body.data, 'guest')).toBe('Priya');
    for (const p of res.body.data.participants) expect(Object.keys(p).sort()).toEqual(ALLOWED_PARTICIPANT_KEYS);
  });
});

describe('MC-NAME-02 the name policy applies to live names too', () => {
  it('an unacceptable live name falls back to an acceptable snapshot', async () => {
    const conv = await makeConversation();
    await seedUser(GUEST_ID, 'WhatsApp Rahul');
    await seedUser(HOST_ID, 'Arjun 9876543210');
    const res = await rest(`/conversations/${conv}`, HOST_ID);
    expect(nameOf(res.body.data, 'guest')).toBe('Test');
    expect(nameOf(res.body.data, 'host')).toBe('Hosty');
    expectPublic(res.body.data);
  });

  it('both unacceptable → no firstName at all (clients show "Guest"/"Host")', async () => {
    const doc = await ConversationModel.create({
      propertyId: 'prop-1',
      participants: [
        { userId: HOST_ID, role: ParticipantRole.HOST, firstName: 'rahul@villa.in', joinedAt: new Date() },
        { userId: GUEST_ID, role: ParticipantRole.GUEST, firstName: 'Priya 9876543210', joinedAt: new Date() },
      ],
      unreadCount: {},
    });
    await seedUser(GUEST_ID, 'WhatsApp Rahul');
    await seedUser(HOST_ID, 42);
    const list = await rest('/conversations?role=host', HOST_ID);
    const detail = await rest(`/conversations/${doc._id}`, HOST_ID);
    for (const conv of [list.body.data[0], detail.body.data]) {
      for (const p of conv.participants) expect(p).not.toHaveProperty('firstName');
      expectPublic(conv);
    }
  });

  it('a live name is cleaned (whitespace, control/format characters) before the rule', async () => {
    const conv = await makeConversation();
    await seedUser(GUEST_ID, '  Meera​ \t\n Devi\u0007 ');
    const res = await rest(`/conversations/${conv}`, HOST_ID);
    expect(nameOf(res.body.data, 'guest')).toBe('Meera Devi');
  });
});

describe('MC-NAME-03 missing users doc', () => {
  it('falls back to the stored snapshot', async () => {
    const conv = await makeConversation();
    await seedUser(HOST_ID, 'Arjun'); // only the host exists in the main DB
    const res = await rest(`/conversations/${conv}`, GUEST_ID);
    expect(nameOf(res.body.data, 'host')).toBe('Arjun');
    expect(nameOf(res.body.data, 'guest')).toBe('Test');
  });

  it('participants without an ObjectId user id cost no query and keep their snapshots', async () => {
    const [out] = await withLiveFirstNames([
      {
        id: 'x',
        propertyId: 'p',
        participants: [
          { userId: 'legacy-host', role: ParticipantRole.HOST, firstName: 'Hosty', joinedAt: new Date(), lastName: 'Secretlast' } as any,
          { userId: 'legacy-guest', role: ParticipantRole.GUEST, firstName: 'Priya 9876543210', joinedAt: new Date() },
        ],
        unreadCount: {},
        status: 'active',
        createdAt: new Date(),
        updatedAt: new Date(),
      } as any,
    ]);
    expect(mainDbCommands).toHaveLength(0);
    expect(out.participants[0]).toEqual({ userId: 'legacy-host', role: 'host', firstName: 'Hosty', joinedAt: expect.any(Date) });
    expect(out.participants[1]).not.toHaveProperty('firstName');
  });

  it('never mutates the objects it was given', async () => {
    await seedUser(GUEST_ID, 'Meera');
    const input = {
      id: 'x',
      participants: [{ userId: GUEST_ID, role: ParticipantRole.GUEST, firstName: 'Test', joinedAt: new Date() }],
    } as any;
    const [out] = await withLiveFirstNames([input]);
    expect(out.participants[0].firstName).toBe('Meera');
    expect(input.participants[0].firstName).toBe('Test');
    expect(out).not.toBe(input);
  });
});

describe('MC-NAME-04 main-DB read failure degrades to snapshots', () => {
  function failUsersReads(make: () => { toArray: () => Promise<unknown> }) {
    const Collection = mongoose.mongo.Collection.prototype as any;
    const original = Collection.find;
    return jest.spyOn(Collection, 'find').mockImplementation(function (this: any, ...args: unknown[]) {
      if (this.collectionName === 'users' && this.dbName === MAIN_DB) return make();
      return original.apply(this, args);
    });
  }

  it('"not authorized" → HTTP 200 with snapshots and ONE code-only warning across requests', async () => {
    const conv = await makeConversation();
    await seedUser(GUEST_ID, 'Meera');
    const unauthorized = Object.assign(new Error('not authorized on master-db to execute command { find: "users" }'), {
      name: 'MongoServerError',
      code: 13,
      codeName: 'Unauthorized',
    });
    failUsersReads(() => ({ toArray: () => Promise.reject(unauthorized) }));
    const warn = jest.spyOn(logger, 'warn');

    const detail = await rest(`/conversations/${conv}`, HOST_ID);
    const list = await rest('/conversations?role=host', HOST_ID);
    expect(detail.status).toBe(200);
    expect(list.status).toBe(200);
    expect(nameOf(detail.body.data, 'guest')).toBe('Test');
    expect(nameOf(list.body.data[0], 'guest')).toBe('Test');
    expectPublic(detail.body.data);

    const degraded = warn.mock.calls.filter((c) => c[1] === DEGRADED_MSG);
    expect(degraded).toHaveLength(1);
    expect(degraded[0][0]).toEqual({ errName: 'MongoServerError', errCode: 13, codeName: 'Unauthorized' });
    expect(JSON.stringify(degraded[0])).not.toMatch(/Meera|Test|Hosty|master-db|users/);
  });

  it('a synchronous throw from the driver on POST → 200 with snapshots', async () => {
    const propertyId = new mongoose.Types.ObjectId().toString();
    await makeConversation({ propertyId });
    failUsersReads(() => {
      throw Object.assign(new Error('boom'), { name: 'MongoNetworkError' });
    });
    const res = await rest('/conversations', GUEST_ID, { method: 'POST', body: JSON.stringify({ propertyId, hostId: HOST_ID, guestId: GUEST_ID }) });
    expect(res.status).toBe(200);
    expect(nameOf(res.body.data, 'host')).toBe('Hosty');
    expect(nameOf(res.body.data, 'guest')).toBe('Test');
    expectPublic(res.body.data);
  });

  it('a lookup that never answers is abandoned at the deadline (response not held)', async () => {
    const conv = await makeConversation();
    failUsersReads(() => ({ toArray: () => new Promise(() => undefined) }));
    const t0 = Date.now();
    const res = await rest(`/conversations/${conv}`, HOST_ID);
    expect(res.status).toBe(200);
    expect(nameOf(res.body.data, 'guest')).toBe('Test');
    expect(Date.now() - t0).toBeLessThan(4000);
  });
});

describe('MC-PRIV-01 nothing beyond the public participant fields', () => {
  it('a legacy lastName document plus a rich users doc: no lastName / email / extra field on list, detail or POST', async () => {
    const propertyId = new mongoose.Types.ObjectId().toString();
    const legacy = await ConversationModel.create({
      propertyId,
      participants: [
        { userId: HOST_ID, role: ParticipantRole.HOST, firstName: 'Rahul', lastName: 'Secretlast', joinedAt: new Date() },
        { userId: GUEST_ID, role: ParticipantRole.GUEST, firstName: 'Priya', lastName: 'Secretlast', joinedAt: new Date() },
      ],
      unreadCount: {},
    } as any);
    await seedUser(HOST_ID, 'Arjun');
    await seedUser(GUEST_ID, 'Meera');
    const responses = [
      (await rest('/conversations', HOST_ID)).body.data[0],
      (await rest('/conversations?role=guest', GUEST_ID)).body.data[0],
      (await rest(`/conversations/${legacy._id}`, GUEST_ID)).body.data,
      (await rest('/conversations', GUEST_ID, { method: 'POST', body: JSON.stringify({ propertyId, hostId: HOST_ID, guestId: GUEST_ID }) })).body.data,
    ];
    for (const conv of responses) {
      expectPublic(conv);
      expect(nameOf(conv, 'host')).toBe('Arjun');
      expect(nameOf(conv, 'guest')).toBe('Meera');
    }
  });
});

describe('cost: the permission-check paths never touch the main DB', () => {
  it('socket join, send, read and REST history perform no users query', async () => {
    const conv = await makeConversation();
    await seedUser(GUEST_ID, 'Meera');
    mainDbCommands.length = 0;

    const guest = await connect(GUEST_ID);
    const host = await connect(HOST_ID);
    for (const s of [guest, host]) {
      s.emit(SOCKET_EVENTS.CONVERSATION_JOIN, { conversationId: conv });
      const room = `${CHAT_CONFIG.ROOM_PREFIX}${conv}`;
      await waitUntil(() => io.sockets.adapter.rooms.get(room)?.has(s.id as string) === true);
    }
    const ack: any = await new Promise((resolve) => {
      guest.timeout(4000).emit(SOCKET_EVENTS.MESSAGE_SEND, { conversationId: conv, content: { text: 'hello' }, type: 'text', clientMessageId: cid() }, (err: Error | null, r: any) =>
        resolve(err ? { timedOut: true } : r)
      );
    });
    expect(ack.success).toBe(true);
    host.emit(SOCKET_EVENTS.MESSAGE_READ, { conversationId: conv, messageIds: [ack.messageId] });
    await sleep(200);
    const history = await rest(`/conversations/${conv}/messages?limit=10`, HOST_ID);
    expect(history.status).toBe(200);
    expect(history.body.data.data).toHaveLength(1);

    expect(usersFinds()).toBe(0);
    expect(mainDbCommands).toHaveLength(0);
  });

  it('the main-DB handle shares the default connection pool (no new client)', () => {
    expect(mongoose.connection.useDb(MAIN_DB, { useCache: true }).getClient()).toBe(mongoose.connection.getClient());
  });
});
