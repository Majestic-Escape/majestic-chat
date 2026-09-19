import crypto from 'crypto';
import mongoose from 'mongoose';
import { ChatError } from '@majestic/chat-shared';
import { getRedisClient } from './redis';
import { logger } from './logger';

/**
 * Per (conversation, sender) critical section for message sends: the
 * cross-message contact detector reads the sender's persisted messages,
 * judges the candidate and persists it while the lock is held, so a
 * concurrent send from another socket / instance always sees the previous
 * message. A rejected candidate is never persisted, so it never becomes
 * moderation context (Mongo is the authoritative history — nothing to heal).
 *
 * Providers:
 *  - Redis (primary, cluster-wide): `SET key token NX PX ttl`; release and
 *    renewal are compare-token Lua scripts, so an expired owner can never
 *    delete or extend a newer owner's lock. A watchdog renews the TTL while
 *    the section runs; a process crash lets the TTL expire.
 *  - Mongo (fallback while Redis is unreachable, still cluster-wide): one
 *    document per key, `insertOne` is the atomic acquire, compare-token
 *    `deleteOne` the release, a TTL index the crash safety net.
 *  - In-process mutex only when no REDIS_URL is configured (single-server
 *    mode: there is no second instance to protect against).
 *
 * Every process queues its own sends per key in FIFO order first (a client
 * flushing buffered sends after a reconnect is one burst), so at most one
 * request per process polls the shared lock; that polling is a bounded
 * backoff (25 → 250 ms, ≤ MAX_WAIT_MS, ≤ 14 acquire commands). When neither
 * succeeds in time the send answers MODERATION_BUSY, a definitive, retryable
 * rejection — no accepted message ever bypasses the section.
 */
const LOCK_TTL_MS = 15_000;
const RENEW_EVERY_MS = 5_000;
// Cross-instance contention: bounded polling of the shared lock.
const MAX_WAIT_MS = 3_000;
const BACKOFF_MS = [25, 50, 100, 150, 250, 250, 250, 250, 250, 250, 250, 250, 250, 250];
// In-process queue: sends from this process for one key wait here in FIFO
// order (a reconnecting client flushes its buffered sends as one burst), so
// only one request per process polls the shared lock at a time.
const LOCAL_QUEUE_MAX_WAIT_MS = 10_000;

const RELEASE_SCRIPT = `if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end`;
const RENEW_SCRIPT = `if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('pexpire', KEYS[1], ARGV[2]) else return 0 end`;

export type LockProvider = 'redis' | 'mongo' | 'memory';

export interface ModerationLock {
  key: string;
  token: string;
  provider: LockProvider;
  /** True while the lock is still ours (fencing check after persistence). */
  isOwner(): Promise<boolean>;
  release(): Promise<void>;
}

// --- Mongo fallback model -------------------------------------------------

interface LockDoc {
  _id: string;
  token: string;
  expiresAt: Date;
}
const lockSchema = new mongoose.Schema<LockDoc>(
  {
    _id: { type: String, required: true },
    token: { type: String, required: true },
    expiresAt: { type: Date, required: true },
  },
  { collection: 'moderationlocks', versionKey: false }
);
lockSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });
export const ModerationLockModel = mongoose.models.ModerationLock || mongoose.model<LockDoc>('ModerationLock', lockSchema);

// --- In-process FIFO queue (also the whole lock in single-server mode) ------

const localQueues = new Map<string, Promise<void>>();

async function enterLocalQueue(key: string): Promise<() => void> {
  const previous = localQueues.get(key) || Promise.resolve();
  let release!: () => void;
  const mine = new Promise<void>((resolve) => {
    release = resolve;
  });
  const tail = previous.then(() => mine);
  localQueues.set(key, tail);
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(ChatError.moderationBusy()), LOCAL_QUEUE_MAX_WAIT_MS);
    timer.unref();
  });
  try {
    await Promise.race([previous, timeout]);
  } catch (error) {
    release(); // keep the chain moving for those behind us
    throw error;
  } finally {
    if (timer) clearTimeout(timer);
  }
  return () => {
    release();
    if (localQueues.get(key) === tail) localQueues.delete(key);
  };
}

// --- Helpers ----------------------------------------------------------------

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

let redisWarnedAt = 0;
function noteRedisFailure(op: string, error: unknown): void {
  const now = Date.now();
  if (now - redisWarnedAt > 60_000) {
    redisWarnedAt = now;
    logger.warn({ err: error instanceof Error ? error.message : String(error), op }, 'Moderation lock: Redis unavailable — using the Mongo lock');
  }
}

function isDuplicateKey(err: unknown): boolean {
  return !!err && typeof err === 'object' && (err as { code?: number }).code === 11000;
}

export function lockKey(conversationId: string, senderId: string): string {
  return `modlock:${conversationId}:${senderId}`;
}

async function tryRedis(key: string, token: string): Promise<boolean | null> {
  try {
    const res = await getRedisClient().set(key, token, 'PX', LOCK_TTL_MS, 'NX');
    return res === 'OK';
  } catch (error) {
    noteRedisFailure('acquire', error);
    return null; // provider unavailable
  }
}

async function tryMongo(key: string, token: string): Promise<boolean> {
  const now = new Date();
  try {
    await ModerationLockModel.create({ _id: key, token, expiresAt: new Date(now.getTime() + LOCK_TTL_MS) });
    return true;
  } catch (error) {
    if (!isDuplicateKey(error)) throw error;
    // The TTL monitor runs once a minute: an expired holder is reaped here.
    const reaped = await ModerationLockModel.deleteOne({ _id: key, expiresAt: { $lt: now } });
    if (reaped.deletedCount) {
      try {
        await ModerationLockModel.create({ _id: key, token, expiresAt: new Date(Date.now() + LOCK_TTL_MS) });
        return true;
      } catch (again) {
        if (!isDuplicateKey(again)) throw again;
      }
    }
    return false;
  }
}

function makeLock(key: string, token: string, provider: LockProvider, leaveQueue: () => void): ModerationLock {
  let released = false;
  let watchdog: NodeJS.Timeout | undefined;
  if (provider !== 'memory') {
    watchdog = setInterval(async () => {
      try {
        if (provider === 'redis') {
          const ok = await getRedisClient().eval(RENEW_SCRIPT, 1, key, token, String(LOCK_TTL_MS));
          if (ok === 0) logger.warn({ key }, 'modlock_lost_before_renewal');
        } else {
          await ModerationLockModel.updateOne({ _id: key, token }, { $set: { expiresAt: new Date(Date.now() + LOCK_TTL_MS) } });
        }
      } catch (error) {
        logger.warn({ key, err: error instanceof Error ? error.message : String(error) }, 'modlock_renew_failed');
      }
    }, RENEW_EVERY_MS);
    watchdog.unref();
  }
  return {
    key,
    token,
    provider,
    async isOwner() {
      try {
        if (provider === 'redis') return (await getRedisClient().get(key)) === token;
        if (provider === 'mongo') return !!(await ModerationLockModel.exists({ _id: key, token }));
        return true;
      } catch {
        return false;
      }
    },
    async release() {
      if (released) return;
      released = true;
      if (watchdog) clearInterval(watchdog);
      try {
        if (provider === 'redis') await getRedisClient().eval(RELEASE_SCRIPT, 1, key, token);
        else if (provider === 'mongo') await ModerationLockModel.deleteOne({ _id: key, token });
      } catch (error) {
        // The TTL is the safety net; log and move on.
        logger.warn({ key, provider, err: error instanceof Error ? error.message : String(error) }, 'modlock_release_failed');
      } finally {
        leaveQueue();
      }
    },
  };
}

/**
 * Acquire the moderation lock for a sender in a conversation: the in-process
 * FIFO queue first, then (when REDIS_URL is configured) the shared lock.
 * Throws ChatError.moderationBusy() when it cannot be acquired in time.
 */
export async function acquireModerationLock(conversationId: string, senderId: string): Promise<ModerationLock> {
  const key = lockKey(conversationId, senderId);
  const token = crypto.randomBytes(16).toString('hex');
  const leaveQueue = await enterLocalQueue(key);
  if (!process.env.REDIS_URL) return makeLock(key, token, 'memory', leaveQueue);
  const started = Date.now();
  try {
    for (let attempt = 0; ; attempt++) {
      let acquired: boolean;
      let provider: LockProvider;
      const viaRedis = await tryRedis(key, token);
      if (viaRedis === null) {
        provider = 'mongo';
        acquired = await tryMongo(key, token);
      } else {
        provider = 'redis';
        acquired = viaRedis;
      }
      if (acquired) return makeLock(key, token, provider, leaveQueue);
      const waited = Date.now() - started;
      const delay = BACKOFF_MS[Math.min(attempt, BACKOFF_MS.length - 1)];
      if (attempt + 1 >= BACKOFF_MS.length || waited + delay > MAX_WAIT_MS) {
        logger.warn({ key, attempts: attempt + 1, waited }, 'modlock_busy');
        throw ChatError.moderationBusy();
      }
      await sleep(delay);
    }
  } catch (error) {
    leaveQueue();
    throw error;
  }
}

/** Test hook: which provider a fresh acquire would use right now. */
export async function probeLockProvider(): Promise<LockProvider> {
  if (!process.env.REDIS_URL) return 'memory';
  try {
    await getRedisClient().ping();
    return 'redis';
  } catch {
    return 'mongo';
  }
}
