import { getRedisClient } from './redis';
import { logger } from './logger';

/**
 * Redis as an optional read-through cache. Every helper swallows Redis
 * errors (no REDIS_URL, connection down, command failure, timeout) and behaves
 * like a cache miss / no-op, so Mongo remains the source of truth and a Redis
 * outage degrades to "uncached" instead of failing (or slowing) every send.
 *
 * A failure also opens a short circuit breaker: for SUSPECT_MS the helpers do
 * not touch Redis at all, so a black-holed connection costs one command
 * timeout per window instead of one per call.
 */
const SUSPECT_MS = 10_000;
let suspectUntil = 0;
let warned = false;

function unavailable(op: string, error: unknown): void {
  suspectUntil = Date.now() + SUSPECT_MS;
  if (!warned) {
    warned = true;
    logger.warn({ error, op }, 'Redis unavailable — running without cache');
  } else {
    logger.debug({ error, op }, 'Redis operation failed (ignored)');
  }
}

const suspect = (): boolean => Date.now() < suspectUntil;

// Keys whose write or invalidation was skipped while the breaker was open.
// They may now hold values from before the outage; they are dropped with one
// DEL the first time Redis answers again, so an outage never leaves a stale
// conversation / unread entry behind for the rest of its TTL.
const DIRTY_MAX = 2000;
const dirty = new Set<string>();
let dirtyOverflow = false;
function markDirty(keys: string[]): void {
  for (const key of keys) {
    if (dirty.size >= DIRTY_MAX) {
      dirtyOverflow = true;
      return;
    }
    dirty.add(key);
  }
}
async function flushDirty(): Promise<void> {
  if (dirty.size === 0 && !dirtyOverflow) return;
  const keys = [...dirty];
  const overflow = dirtyOverflow;
  dirty.clear();
  dirtyOverflow = false;
  try {
    if (keys.length) await getRedisClient().del(...keys);
    if (overflow) logger.warn({ dropped: keys.length }, 'Redis outage touched more keys than tracked; the rest expire by TTL');
    logger.info({ dropped: keys.length }, 'Redis back — dropped cache entries changed during the outage');
  } catch (error) {
    keys.forEach((k) => dirty.add(k));
    throw error;
  }
}

/** Exposed for tests / diagnostics: is the breaker currently open? */
export function cacheSuspended(): boolean {
  return suspect();
}

export async function cacheGet(key: string): Promise<string | null> {
  if (suspect()) return null;
  try {
    await flushDirty();
    return await getRedisClient().get(key);
  } catch (error) {
    unavailable('get', error);
    return null;
  }
}

export async function cacheMget(keys: string[]): Promise<(string | null)[]> {
  if (suspect() || keys.length === 0) return keys.map(() => null);
  try {
    await flushDirty();
    return await getRedisClient().mget(...keys);
  } catch (error) {
    unavailable('mget', error);
    return keys.map(() => null);
  }
}

export async function cacheSetEx(key: string, ttlSeconds: number, value: string): Promise<void> {
  if (suspect()) {
    markDirty([key]);
    return;
  }
  try {
    await flushDirty();
    await getRedisClient().setex(key, ttlSeconds, value);
  } catch (error) {
    markDirty([key]);
    unavailable('setex', error);
  }
}

export async function cacheDel(...keys: string[]): Promise<void> {
  if (keys.length === 0) return;
  if (suspect()) {
    markDirty(keys);
    return;
  }
  try {
    await flushDirty();
    await getRedisClient().del(...keys);
  } catch (error) {
    markDirty(keys);
    unavailable('del', error);
  }
}
