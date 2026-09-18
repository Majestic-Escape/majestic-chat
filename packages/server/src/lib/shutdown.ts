import type { Server } from 'socket.io';
import { closeRedisClients } from './redis';
import { disconnectDatabase } from './database';
import { logger } from './logger';

export const SHUTDOWN_DEADLINE_MS = 8000;

/**
 * Graceful shutdown for SIGTERM/SIGINT (a Railway deploy or restart). Open
 * WebSockets keep an HTTP server from ever finishing close(), so the sockets
 * are closed first: every client gets a "transport close" and reconnects (to
 * the replacement instance on a deploy) instead of waiting for the platform's
 * SIGKILL. Then Redis and Mongo are released. A hard deadline guarantees the
 * exit even if a handle refuses to close (e.g. the adapter waiting on a Redis
 * that is down). Idempotent: a second signal is ignored.
 */
export function createShutdown(io: Server, exit: (code: number) => void = (code) => process.exit(code), deadlineMs = SHUTDOWN_DEADLINE_MS): (signal: string) => void {
  let started = false;
  return (signal: string): void => {
    if (started) return;
    started = true;
    logger.info({ signal }, 'Shutting down gracefully');
    setTimeout(() => {
      logger.warn('Shutdown deadline reached, exiting');
      exit(1);
    }, deadlineMs).unref();
    io.close(() => {
      void (async () => {
        try {
          closeRedisClients();
          await disconnectDatabase();
        } catch (error) {
          logger.warn({ error }, 'Error while closing connections');
        }
        logger.info('Server closed');
        exit(0);
      })();
    });
  };
}
