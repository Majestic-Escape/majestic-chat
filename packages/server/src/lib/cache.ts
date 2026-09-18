import { getRedisClient } from './redis';
import { logger } from './logger';

/**
 * Redis as an optional read-through cache. Every helper swallows Redis
 * errors (no REDIS_URL, connection down, command failure) and behaves like a
 * cache miss / no-op, so Mongo remains the source of truth and a Redis outage
 * degrades to "uncached" instead of failing every send with DATABASE_ERROR.
 */
let warned = false;
function unavailable(op: string, error: unknown): void {
  if (!warned) {
    warned = true;
    logger.warn({ error, op }, 'Redis unavailable — running without cache');
  } else {
    logger.debug({ error, op }, 'Redis operation failed (ignored)');
  }
}

export async function cacheGet(key: string): Promise<string | null> {
  try {
    return await getRedisClient().get(key);
  } catch (error) {
    unavailable('get', error);
    return null;
  }
}

export async function cacheSetEx(key: string, ttlSeconds: number, value: string): Promise<void> {
  try {
    await getRedisClient().setex(key, ttlSeconds, value);
  } catch (error) {
    unavailable('setex', error);
  }
}
