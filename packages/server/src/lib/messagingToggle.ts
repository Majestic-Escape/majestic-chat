import mongoose from 'mongoose';
import { logger } from './logger';

/**
 * Ops switch for guest↔host messaging (admin.site → Settings → "Messaging").
 *
 * The flag lives in the SHARED app database, not in this service's own one:
 * `settings` collection, document `_id: "messaging"`, field `enabled: boolean`
 * — the same place (and the same `MAIN_DB_NAME`, default `master-db`, same
 * cluster) the admin API in majestic-escape-rag-ai-chat-widget writes it
 * (`src/lib/featureToggles.ts`). Keep id and field in lockstep with that file.
 * It has to live outside this service so it can still be read — and flipped —
 * while this service is the thing that is down or being worked on.
 *
 * FAIL-OPEN: a document that is absent, malformed, or a read that fails never
 * switches messaging off; a failed read keeps the last value seen (so an admin's
 * OFF survives a database blip) and otherwise leaves messaging ON, which is how
 * it behaved before this switch existed. Only an admin's explicit `false`
 * turns it off, and nothing a caller sends can influence the read.
 *
 * Cost: one `findOne` by `_id` per TTL window per instance (single-flight), and
 * only while someone is calling — an idle instance reads nothing.
 */

const DEFAULT_MAIN_DB = 'master-db';
const SETTINGS_COLLECTION = 'settings';
const DOC_ID = 'messaging';
/** Short: an admin flip should reach every instance within seconds. */
const CACHE_TTL_MS = 10_000;
const FAILURE_CACHE_TTL_MS = 5_000;
/** While OFF, look again sooner so switching it back ON reaches callers within seconds (one findOne per 3 s per instance at most). */
const OFF_CACHE_TTL_MS = 3_000;
const QUERY_MAX_TIME_MS = 2000;
const LOOKUP_DEADLINE_MS = 2500;
const WARN_INTERVAL_MS = 5 * 60 * 1000;

/** `true`/`false` → stored; `null` → document absent; throws → read failure. */
export type MessagingReader = () => Promise<boolean | null>;

let cache: { enabled: boolean; expires: number } | null = null;
let inflight: Promise<boolean> | null = null;
let lastWarnAt = 0;
let loggedFirstRead = false;

async function readFromDb(): Promise<boolean | null> {
  const db = mongoose.connection.useDb(process.env.MAIN_DB_NAME || DEFAULT_MAIN_DB, { useCache: true });
  let timer: NodeJS.Timeout | undefined;
  try {
    const lookup = (async () =>
      (await db
        .collection(SETTINGS_COLLECTION)
        .findOne({ _id: DOC_ID } as never, { projection: { enabled: 1 }, maxTimeMS: QUERY_MAX_TIME_MS })) as {
        enabled?: unknown;
      } | null)();
    lookup.catch(() => undefined); // a late rejection after the deadline must not go unhandled
    const deadline = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error('messaging setting lookup timed out')), LOOKUP_DEADLINE_MS);
    });
    const doc = await Promise.race([lookup, deadline]);
    if (!loggedFirstRead) {
      // One line per process: which database this instance reads the switch from and what it
      // found. If an admin's flips ever seem ignored, compare `db` with the widget service's
      // MONGODB_URI database (a mismatch reads "absent" forever and leaves messaging ON).
      loggedFirstRead = true;
      logger.info({ db: process.env.MAIN_DB_NAME || DEFAULT_MAIN_DB, document: doc ? doc.enabled : 'absent' }, 'Messaging switch read');
    }
    if (!doc) return null;
    if (typeof doc.enabled !== 'boolean') throw new Error(`settings/${DOC_ID}.enabled is ${typeof doc.enabled}, expected boolean`);
    return doc.enabled;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** Is guest↔host messaging currently offered? Never rejects. */
export function isMessagingEnabled(reader: MessagingReader = readFromDb): Promise<boolean> {
  const now = Date.now();
  if (cache && cache.expires > now) return Promise.resolve(cache.enabled);
  if (inflight) return inflight;

  const previous = cache?.enabled;
  inflight = (async () => {
    try {
      const stored = await reader();
      const enabled = stored === null ? true : stored;
      cache = { enabled, expires: Date.now() + (enabled ? CACHE_TTL_MS : OFF_CACHE_TTL_MS) };
      return enabled;
    } catch (error) {
      const enabled = previous ?? true;
      cache = { enabled, expires: Date.now() + FAILURE_CACHE_TTL_MS };
      if (Date.now() - lastWarnAt > WARN_INTERVAL_MS) {
        lastWarnAt = Date.now();
        logger.warn(
          { error: error instanceof Error ? error.message : String(error), keeping: enabled ? 'enabled' : 'disabled' },
          'Messaging switch unreadable - keeping the last known state'
        );
      }
      return enabled;
    } finally {
      inflight = null;
    }
  })();
  return inflight;
}

/**
 * Last value seen, synchronously and regardless of age (`undefined` before the
 * first read). For per-packet checks on live sockets, where awaiting would
 * reorder packets; the sweep in `socket/server.ts` keeps it fresh.
 */
export function peekMessagingEnabled(): boolean | undefined {
  return cache?.enabled;
}

/** Test hooks. */
export function resetMessagingToggle(): void {
  cache = null;
  inflight = null;
  lastWarnAt = 0;
  loggedFirstRead = false;
}
export function expireMessagingToggle(): void {
  if (cache) cache.expires = 0;
}
