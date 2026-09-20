import pino from 'pino';

const isDevelopment = process.env.NODE_ENV !== 'production';
// pino-pretty runs in a worker thread; under Jest that thread would keep the
// process alive, so tests log plain JSON (and are silent by LOG_LEVEL anyway).
const prettyPrint = isDevelopment && process.env.NODE_ENV !== 'test';

export const logger = pino({
  name: 'majestic-chat',
  level: process.env.LOG_LEVEL || (isDevelopment ? 'debug' : 'info'),
  transport: prettyPrint
    ? {
        target: 'pino-pretty',
        options: {
          colorize: true,
          translateTime: 'HH:MM:ss Z',
          ignore: 'pid,hostname',
        },
      }
    : undefined,
});

/** A failure that a caller is about to answer with an error code. */
type Classifiable = { code?: string; statusCode?: number; message?: string };

/**
 * Log a caught failure at the level it deserves.
 *
 * A `ChatError` with a 4xx status is a rejection the server produced on
 * purpose — bad input, not a participant of that conversation, rate-limited,
 * moderation, not found. It is expected, client-caused behaviour (or an
 * attacker probing), so it logs at `warn` (`expected`) with its code and
 * message: visible and countable for alerting on bursts, but not an error
 * that pages anyone. Everything else — Mongo, Redis, a bug — is a real fault
 * and logs at `error` with the Error itself under `err` (pino's serializer
 * keeps message and stack; a plain Error under another key serialises to {}).
 */
export function logFailure(
  log: pino.Logger,
  error: unknown,
  context: Record<string, unknown>,
  msg: string,
  expected: 'warn' | 'info' | 'debug' = 'warn'
): void {
  const e = error as Classifiable | null;
  const status = typeof e?.statusCode === 'number' ? e.statusCode : undefined;
  if (e && typeof e.code === 'string' && status !== undefined && status < 500) {
    log[expected]({ ...context, code: e.code, statusCode: status, reason: e.message }, msg);
    return;
  }
  log.error({ ...context, err: error }, msg);
}
