import Redis from 'ioredis';
import { ChatError } from '@majestic/chat-shared';
import { logger } from './logger';

/**
 * ioredis clients tuned for "Redis is optional": a command issued while the
 * connection is down fails at once (no offline queue) instead of waiting
 * through reconnection attempts, and a command that gets no answer fails
 * after COMMAND_TIMEOUT_MS. The callers (lib/cache.ts, UnreadCountService,
 * the Socket.IO adapter wrapper below) treat every failure as a cache miss /
 * dropped cross-instance packet, so an outage never stalls or kills the
 * process. Reconnection itself keeps retrying forever (capped 2 s backoff) and
 * ioredis re-subscribes the adapter's channels on its own.
 */
const COMMAND_TIMEOUT_MS = 2000;
const CONNECT_TIMEOUT_MS = 5000;

export function createRedisClient(name: string, mode: 'command' | 'subscriber' = 'command'): Redis {
  const REDIS_URL = process.env.REDIS_URL;

  if (!REDIS_URL) {
    throw ChatError.internal('REDIS_URL environment variable is not defined');
  }

  // The subscriber only ever issues (p)subscribe, which must simply wait for
  // the connection (at boot and after every drop) — never be flushed with an
  // error the adapter does not catch. Command clients fail fast instead.
  const subscriber = mode === 'subscriber';
  const client = new Redis(REDIS_URL, {
    maxRetriesPerRequest: subscriber ? null : 1,
    enableOfflineQueue: subscriber,
    commandTimeout: subscriber ? undefined : COMMAND_TIMEOUT_MS,
    connectTimeout: CONNECT_TIMEOUT_MS,
    retryStrategy(times: number) {
      const delay = Math.min(times * 50, 2000);
      if (times <= 3 || times % 20 === 0) logger.warn({ times, delay, name }, 'Redis retrying connection');
      return delay;
    },
    reconnectOnError(err: Error) {
      logger.error({ err, name }, 'Redis connection error');
      return true;
    },
  });

  client.on('connect', () => {
    logger.info({ name }, 'Redis client connected');
  });

  client.on('ready', () => {
    logger.info({ name }, 'Redis client ready');
  });

  client.on('error', (err: Error) => {
    logger.error({ err: err.message, name }, 'Redis client error');
  });

  client.on('close', () => {
    logger.warn({ name }, 'Redis client connection closed');
  });

  client.on('reconnecting', () => {
    logger.debug({ name }, 'Redis client reconnecting');
  });

  return client;
}

/**
 * The Socket.IO Redis adapter calls `pubClient.publish(...)` without awaiting
 * or catching the returned promise. With Redis down that promise rejects, and
 * an unhandled rejection terminates the process (Node ≥ 15) — one dropped
 * broadcast would take the whole chat server with it. Wrap `publish` so a
 * failed cross-instance publish is logged and dropped; local delivery to
 * sockets on this instance is unaffected (the adapter broadcasts locally
 * regardless).
 */
let publishWarnedAt = 0;
function guardPublish(client: Redis): Redis {
  const original = client.publish.bind(client) as (...args: unknown[]) => Promise<number>;
  (client as unknown as { publish: (...args: unknown[]) => Promise<number> }).publish = (...args: unknown[]) =>
    original(...args).catch((err: Error) => {
      const now = Date.now();
      if (now - publishWarnedAt > 10_000) {
        publishWarnedAt = now;
        logger.warn({ err: err.message }, 'Redis publish failed — cross-instance broadcast dropped (local delivery unaffected)');
      }
      return 0;
    });
  return client;
}

export function createPubSubClients(): { pubClient: Redis; subClient: Redis } {
  const pubClient = guardPublish(createRedisClient('pub'));
  const subClient = createRedisClient('sub', 'subscriber');

  return { pubClient, subClient };
}

// Singleton instances
let redisClientInstance: Redis | null = null;
let pubClientInstance: Redis | null = null;
let subClientInstance: Redis | null = null;

export function getRedisClient(): Redis {
  if (!redisClientInstance) {
    redisClientInstance = createRedisClient('main');
  }
  return redisClientInstance;
}

export function getPubSubClients(): { pubClient: Redis; subClient: Redis } {
  if (!pubClientInstance || !subClientInstance) {
    const clients = createPubSubClients();
    pubClientInstance = clients.pubClient;
    subClientInstance = clients.subClient;
  }
  return { pubClient: pubClientInstance, subClient: subClientInstance };
}

/**
 * Drop every client (graceful shutdown, tests). A client that never managed
 * to connect would otherwise keep retrying forever and hold the process open.
 */
export function closeRedisClients(): void {
  for (const client of [redisClientInstance, pubClientInstance, subClientInstance]) {
    if (client) client.disconnect(false);
  }
  redisClientInstance = null;
  pubClientInstance = null;
  subClientInstance = null;
}
