import mongoose from 'mongoose';
import { Conversation, Participant, OBJECT_ID_RE, isAcceptableName } from '@majestic/chat-shared';
import { logger } from './logger';

/**
 * Live participant first names.
 *
 * `Conversation.participants[].firstName` is a snapshot taken when the thread
 * was created; a rename in server.me (`users.firstName` in the main DB, same
 * Atlas cluster, different database) never reached it. The REST read paths
 * that carry names — the conversation lists (cache-miss branch only, so the
 * cached list carries the live name for its TTL), the detail route and
 * `POST /conversations` — resolve them here with ONE `users` find over the
 * distinct participant ids, through the default connection's pool
 * (`useDb(..., { useCache: true })` opens no sockets).
 *
 * The permission check (`findById` / `ChatService.getConversation`, used by
 * send, history and socket join) never calls this: it must not cost a query.
 *
 * Name policy is the one applied at creation (`isAcceptableName`): a live name
 * that fails it falls back to the stored snapshot, a snapshot that fails it is
 * omitted (clients show "Guest"/"Host"). Only `{ userId, role, joinedAt,
 * firstName }` is ever emitted. Any error (unreachable, timeout, a DB user
 * that may not read the main DB) degrades to the snapshots, warned at most
 * once per WARN_INTERVAL_MS with the error name/code only.
 */

const DEFAULT_MAIN_DB = 'master-db';
const NAME_CAP = 60;
const QUERY_MAX_TIME_MS = 2000;
/** Upper bound on the whole lookup (buffering included) — a response is never held longer. */
const LOOKUP_DEADLINE_MS = 2500;
const WARN_INTERVAL_MS = 5 * 60 * 1000;

let lastWarnAt = 0;

/** The creation-time rule: a trimmed first name, or nothing. */
export function acceptableFirstName(name: unknown): string | undefined {
  return isAcceptableName(name) ? (name as string).trim() : undefined;
}

/** Trim, collapse whitespace, strip control/format characters, cap — then the same rule. */
export function cleanLiveFirstName(raw: unknown): string | undefined {
  if (typeof raw !== 'string') return undefined;
  const cleaned = raw
    .replace(/\s+/gu, ' ')
    .replace(/[\p{Cc}\p{Cf}]/gu, '')
    .replace(/ {2,}/g, ' ')
    .trim()
    .slice(0, NAME_CAP)
    .trim();
  return acceptableFirstName(cleaned);
}

function publicParticipant(p: Participant, firstName: string | undefined): Participant {
  const out: Participant = { userId: p.userId, role: p.role, joinedAt: p.joinedAt };
  if (firstName) out.firstName = firstName;
  return out;
}

/** New objects (cached ones are never mutated); live name first, then an acceptable snapshot, else none. */
function withNames<T extends Conversation>(conversations: T[], live: Map<string, string>): T[] {
  return conversations.map((conv) => ({
    ...conv,
    participants: (conv.participants || []).map((p) => {
      const liveName = typeof p.userId === 'string' ? live.get(p.userId.toLowerCase()) : undefined;
      return publicParticipant(p, liveName ?? acceptableFirstName(p.firstName));
    }),
  }));
}

function warnDegraded(error: unknown): void {
  const now = Date.now();
  if (now - lastWarnAt < WARN_INTERVAL_MS) return;
  lastWarnAt = now;
  const e = error as { name?: unknown; code?: unknown; codeName?: unknown } | null;
  logger.warn(
    {
      errName: typeof e?.name === 'string' ? e.name : 'Error',
      ...(e?.code !== undefined ? { errCode: e.code } : {}),
      ...(typeof e?.codeName === 'string' ? { codeName: e.codeName } : {}),
    },
    'Live participant names unavailable - serving stored snapshots'
  );
}

/** Test hook: forget when the degraded-mode warning was last logged. */
export function resetLiveNamesWarning(): void {
  lastWarnAt = 0;
}

export async function withLiveFirstNames<T extends Conversation>(conversations: T[]): Promise<T[]> {
  const ids = new Set<string>();
  for (const conv of conversations) {
    for (const p of conv.participants || []) {
      if (typeof p.userId === 'string' && OBJECT_ID_RE.test(p.userId)) ids.add(p.userId.toLowerCase());
    }
  }
  if (ids.size === 0) return withNames(conversations, new Map());

  let timer: NodeJS.Timeout | undefined;
  try {
    const db = mongoose.connection.useDb(process.env.MAIN_DB_NAME || DEFAULT_MAIN_DB, { useCache: true });
    const lookup = (async () => {
      // `find` may hand back a promise while the connection is buffering; awaiting a cursor is a no-op
      const cursor = await db
        .collection('users')
        .find(
          { _id: { $in: [...ids].map((id) => new mongoose.Types.ObjectId(id)) } },
          { projection: { firstName: 1 }, maxTimeMS: QUERY_MAX_TIME_MS }
        );
      return (await cursor.toArray()) as Array<{ _id: unknown; firstName?: unknown }>;
    })();
    const deadline = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        const err = new Error('live name lookup timed out');
        err.name = 'LiveNamesTimeout';
        reject(err);
      }, LOOKUP_DEADLINE_MS);
    });
    lookup.catch(() => undefined); // a late rejection after the deadline must not go unhandled
    const users = await Promise.race([lookup, deadline]);

    const live = new Map<string, string>();
    for (const u of users) {
      const name = cleanLiveFirstName(u.firstName);
      if (name) live.set(String(u._id).toLowerCase(), name);
    }
    return withNames(conversations, live);
  } catch (error) {
    warnDegraded(error);
    return withNames(conversations, new Map());
  } finally {
    if (timer) clearTimeout(timer);
  }
}
