import { createHash } from 'crypto';
import { cacheGet, cacheSetEx } from './cache';
import { logger } from './logger';

/**
 * Session freshness. Tokens are HS256 JWTs minted by server.me with a 7-day
 * life; this server verifies the signature locally, but only server.me knows
 * whether the session is still alive: a user who logged out everywhere
 * (tokenVersion bumped), was banned, or was deleted must lose chat too, not
 * keep it for up to a week.
 *
 * `verifyWithMainApi` asks server.me's /auth/check-token and caches the
 * verdict for VERDICT_TTL_S per token (in memory and, when available, in
 * Redis so every instance shares it). One call per token per 5 minutes, so a
 * reconnect storm never amplifies into a call storm.
 *
 * Fail-open by design: if server.me is unreachable, slow or broken the token
 * is accepted on the strength of its signature (logged) — chat must not go
 * down with the main API. Only an explicit 401/403/404 rejects.
 *
 * Without MAIN_API_URL (local dev, unit tests) the check is skipped.
 */
export type SessionVerdict = 'ok' | 'rejected' | 'unknown';

const VERDICT_TTL_S = 300;
const UNREACHABLE_TTL_S = 30; // do not hammer a main API that is down
const REQUEST_TIMEOUT_MS = 3000;
const MAX_LOCAL = 5000;

const local = new Map<string, { verdict: SessionVerdict; expiresAt: number }>();

function keyFor(token: string): string {
  return 'session:' + createHash('sha256').update(token).digest('hex');
}

function remember(key: string, verdict: SessionVerdict, ttlS: number): void {
  if (local.size >= MAX_LOCAL) local.delete(local.keys().next().value as string);
  local.set(key, { verdict, expiresAt: Date.now() + ttlS * 1000 });
  if (verdict !== 'unknown') void cacheSetEx(key, ttlS, verdict);
}

export async function verifyWithMainApi(token: string): Promise<SessionVerdict> {
  const apiBaseUrl = process.env.MAIN_API_URL;
  if (!apiBaseUrl) return 'unknown';

  const key = keyFor(token);
  const cached = local.get(key);
  if (cached && cached.expiresAt > Date.now()) return cached.verdict;
  if (cached) local.delete(key);

  const shared = await cacheGet(key);
  if (shared === 'ok' || shared === 'rejected') {
    local.set(key, { verdict: shared, expiresAt: Date.now() + VERDICT_TTL_S * 1000 });
    return shared;
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const res = await fetch(`${apiBaseUrl}/auth/check-token`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token }),
      signal: controller.signal,
    });
    if (res.status === 200) {
      remember(key, 'ok', VERDICT_TTL_S);
      return 'ok';
    }
    if (res.status === 401 || res.status === 403 || res.status === 404) {
      logger.warn({ status: res.status }, 'Session rejected by main API');
      remember(key, 'rejected', VERDICT_TTL_S);
      return 'rejected';
    }
    logger.warn({ status: res.status }, 'Main API could not verify the session — allowing (fail-open)');
    remember(key, 'unknown', UNREACHABLE_TTL_S);
    return 'unknown';
  } catch (error) {
    logger.warn({ error: error instanceof Error ? error.message : String(error) }, 'Main API unreachable for session check — allowing (fail-open)');
    remember(key, 'unknown', UNREACHABLE_TTL_S);
    return 'unknown';
  } finally {
    clearTimeout(timer);
  }
}

/** Test hook: forget every cached verdict. */
export function resetSessionCache(): void {
  local.clear();
}
