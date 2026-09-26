// Opening the inbox fast without giving anything away: gzip on the REST
// routes, a cacheable CORS preflight, one main-API session check per token at
// a time, and no raw (pre-masking) text in the moderation block of history.
import { createServer, Server as HttpServer } from 'http';
import { AddressInfo } from 'net';
import { gunzipSync } from 'zlib';
import express from 'express';
import cors from 'cors';
import jwt from 'jsonwebtoken';
import { MessageModel } from '@majestic/chat-shared';
import { conversationRoutes } from '../routes/conversationRoutes';
import { resetSessionCache, verifyWithMainApi } from '../lib/session';
import { buildCorsOptions, PREFLIGHT_MAX_AGE_S } from '../lib/corsOptions';
import { publicModeration } from '../repositories/MessageRepository';
import { startDb, stopDb, clearDb, makeConversation, cid, HOST_ID, GUEST_ID } from './helpers/db';

let httpServer: HttpServer;
let url: string;
let mainApi: HttpServer;
let mainApiCalls = 0;
let mainApiDelayMs = 0;
const token = (userId: string) => jwt.sign({ userId, firstName: 'U' }, 'test-jwt-secret');

/** Raw HTTP GET (fetch would transparently decode gzip and hide the header). */
function rawGet(path: string, headers: Record<string, string>): Promise<{ status: number; headers: Record<string, string | string[] | undefined>; body: Buffer }> {
  return new Promise((resolve, reject) => {
    const req = require('http').request(`${url}${path}`, { method: 'GET', headers }, (res: any) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
    });
    req.on('error', reject);
    req.end();
  });
}

beforeAll(async () => {
  await startDb();
  mainApi = createServer((req, res) => {
    mainApiCalls++;
    setTimeout(() => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{"success":true}');
    }, mainApiDelayMs);
  });
  await new Promise<void>((r) => mainApi.listen(0, r));
  process.env.MAIN_API_URL = `http://127.0.0.1:${(mainApi.address() as AddressInfo).port}/api/v1`;

  const app = express();
  app.use(cors(buildCorsOptions(['https://majesticescape.in'])));
  app.use(express.json());
  app.use('/api/chat', conversationRoutes);
  httpServer = createServer(app);
  await new Promise<void>((r) => httpServer.listen(0, r));
  url = `http://127.0.0.1:${(httpServer.address() as AddressInfo).port}`;
});
afterAll(async () => {
  await new Promise<void>((r) => httpServer.close(() => r()));
  await new Promise<void>((r) => mainApi.close(() => r()));
  delete process.env.MAIN_API_URL;
  await stopDb();
});
beforeEach(async () => {
  await clearDb();
  resetSessionCache();
  mainApiCalls = 0;
  mainApiDelayMs = 0;
});

async function seedThread(n: number, text: (i: number) => string, extra: Record<string, unknown> = {}) {
  const conv = await makeConversation();
  for (let i = 0; i < n; i++) {
    await MessageModel.create({
      conversationId: conv,
      senderId: i % 2 ? HOST_ID : GUEST_ID,
      clientMessageId: cid(),
      type: 'text',
      content: { text: text(i) },
      moderation: { status: 'clean', flags: [], confidence: 0, version: 2 },
      readBy: [],
      status: 'sent',
      createdAt: new Date(Date.now() - (n - i) * 1000),
      ...extra,
    });
  }
  return conv;
}

describe('gzip on the chat REST routes', () => {
  it('compresses a large JSON page for a client that accepts gzip, and it decodes to the same JSON', async () => {
    const conv = await seedThread(30, (i) => `message number ${i} about the villa and the check-in time, see you soon`);
    const path = `/api/chat/conversations/${conv}/messages?limit=30`;
    const zipped = await rawGet(path, { Authorization: `Bearer ${token(GUEST_ID)}`, 'Accept-Encoding': 'gzip, deflate, br' });
    expect(zipped.status).toBe(200);
    expect(zipped.headers['content-encoding']).toBe('gzip');
    expect(String(zipped.headers.vary)).toMatch(/Accept-Encoding/i);
    const decoded = JSON.parse(gunzipSync(zipped.body).toString('utf8'));
    const plain = await rawGet(path, { Authorization: `Bearer ${token(GUEST_ID)}` });
    expect(plain.headers['content-encoding']).toBeUndefined();
    expect(decoded).toEqual(JSON.parse(plain.body.toString('utf8')));
    expect(decoded.data.data).toHaveLength(30);
    expect(zipped.body.length).toBeLessThan(plain.body.length / 2);
  });

  it('leaves small bodies and errors uncompressed', async () => {
    const res = await rawGet('/api/chat/conversations?role=guest', { Authorization: `Bearer ${token(GUEST_ID)}`, 'Accept-Encoding': 'gzip' });
    expect(res.status).toBe(200);
    expect(res.headers['content-encoding']).toBeUndefined();
    const denied = await rawGet('/api/chat/conversations?role=guest', { 'Accept-Encoding': 'gzip' });
    expect(denied.status).toBe(401);
    expect(denied.headers['content-encoding']).toBeUndefined();
  });
});

describe('CORS preflight', () => {
  it('is cacheable by the browser for the allowed origin', async () => {
    const res = await fetch(`${url}/api/chat/conversations?role=guest`, {
      method: 'OPTIONS',
      headers: { Origin: 'https://majesticescape.in', 'Access-Control-Request-Method': 'GET', 'Access-Control-Request-Headers': 'authorization' },
    });
    expect(res.status).toBe(204);
    expect(res.headers.get('access-control-allow-origin')).toBe('https://majesticescape.in');
    expect(res.headers.get('access-control-max-age')).toBe(String(PREFLIGHT_MAX_AGE_S));
  });

  it('still refuses another origin', async () => {
    const res = await fetch(`${url}/api/chat/conversations?role=guest`, {
      method: 'OPTIONS',
      headers: { Origin: 'https://evil.example', 'Access-Control-Request-Method': 'GET', 'Access-Control-Request-Headers': 'authorization' },
    });
    expect(res.headers.get('access-control-allow-origin')).toBeNull();
  });
});

describe('session check single-flight', () => {
  it('concurrent requests with one token make one main-API call, and the verdict is shared', async () => {
    mainApiDelayMs = 150;
    const t = token(GUEST_ID);
    const verdicts = await Promise.all([verifyWithMainApi(t), verifyWithMainApi(t), verifyWithMainApi(t), verifyWithMainApi(t)]);
    expect(verdicts).toEqual(['ok', 'ok', 'ok', 'ok']);
    expect(mainApiCalls).toBe(1);
    // cached afterwards
    expect(await verifyWithMainApi(t)).toBe('ok');
    expect(mainApiCalls).toBe(1);
  });

  it('different tokens are checked separately', async () => {
    mainApiDelayMs = 50;
    await Promise.all([verifyWithMainApi(token(GUEST_ID)), verifyWithMainApi(token(HOST_ID))]);
    expect(mainApiCalls).toBe(2);
  });

  it('opening the inbox (list + unread in parallel) costs one check', async () => {
    mainApiDelayMs = 100;
    const auth = { Authorization: `Bearer ${token(HOST_ID)}` };
    const [a, b] = await Promise.all([
      fetch(`${url}/api/chat/conversations?role=host`, { headers: auth }),
      fetch(`${url}/api/chat/unread-count?role=all`, { headers: auth }),
    ]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(mainApiCalls).toBe(1);
  });
});

describe('moderation block on the wire', () => {
  it('history never carries originalContent (the pre-masking text)', async () => {
    const conv = await seedThread(1, () => 'call me on •••', {
      moderation: { status: 'flagged', flags: ['PHONE'], confidence: 0.6, originalContent: 'call me on 9876543210' },
    });
    const res = await fetch(`${url}/api/chat/conversations/${conv}/messages?limit=10`, { headers: { Authorization: `Bearer ${token(GUEST_ID)}` } });
    const body = (await res.json()) as { data: { data: { moderation: { status: string } }[] } };
    const text = JSON.stringify(body);
    expect(text).not.toContain('9876543210');
    expect(text).not.toContain('originalContent');
    expect(body.data.data[0].moderation.status).toBe('flagged');
  });

  it('publicModeration keeps everything but the raw text', () => {
    expect(publicModeration({ status: 'flagged', flags: ['PHONE'], confidence: 0.6, version: 2, originalContent: 'x' })).toEqual({ status: 'flagged', flags: ['PHONE'], confidence: 0.6, version: 2 });
    expect(publicModeration(undefined)).toBeUndefined();
    expect(publicModeration(null)).toBeNull();
  });
});
