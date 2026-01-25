import Redis from 'ioredis';
import { ChatError } from '@majestic/chat-shared';
import { logger } from './logger';

export function createRedisClient(name: string): Redis {
  const REDIS_URL = process.env.REDIS_URL;

  if (!REDIS_URL) {
    throw ChatError.internal('REDIS_URL environment variable is not defined');
  }

  const client = new Redis(REDIS_URL, {
    maxRetriesPerRequest: 3,
    retryStrategy(times: number) {
      const delay = Math.min(times * 50, 2000);
      logger.warn({ times, delay, name }, 'Redis retrying connection');
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
    logger.error({ err, name }, 'Redis client error');
  });

  client.on('close', () => {
    logger.warn({ name }, 'Redis client connection closed');
  });

  client.on('reconnecting', () => {
    logger.info({ name }, 'Redis client reconnecting');
  });

  return client;
}

export function createPubSubClients(): { pubClient: Redis; subClient: Redis } {
  const pubClient = createRedisClient('pub');
  const subClient = createRedisClient('sub');

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
