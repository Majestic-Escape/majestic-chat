import { Server as HttpServer } from 'http';
import { Server, Socket } from 'socket.io';
import { createAdapter } from '@socket.io/redis-adapter';
import {
  ClientToServerEvents,
  ServerToClientEvents,
  InterServerEvents,
  SocketData,
  CHAT_CONFIG,
} from '@majestic/chat-shared';
import { getPubSubClients } from '../lib/redis';
import { logger } from '../lib/logger';

export type TypedServer = Server<
  ClientToServerEvents,
  ServerToClientEvents,
  InterServerEvents,
  SocketData
>;

export type TypedSocket = Socket<
  ClientToServerEvents,
  ServerToClientEvents,
  InterServerEvents,
  SocketData
>;

// Get allowed CORS origins (same logic as main server)
function getCorsOrigins(): string | string[] {
  if (process.env.CORS_ORIGIN) {
    return process.env.CORS_ORIGIN.split(',').map(o => o.trim());
  }
  return ['http://localhost:3000', 'http://localhost:3001', 'http://localhost:3002'];
}

export function createSocketServer(httpServer: HttpServer): TypedServer {
  const corsOrigins = getCorsOrigins();
  const io: TypedServer = new Server(httpServer, {
    cors: {
      origin: corsOrigins,
      credentials: true,
    },
    pingTimeout: CHAT_CONFIG.SOCKET_PING_TIMEOUT,
    pingInterval: CHAT_CONFIG.SOCKET_PING_INTERVAL,
    connectionStateRecovery: {
      maxDisconnectionDuration: CHAT_CONFIG.CONNECTION_RECOVERY_DURATION,
    },
  });

  // Setup Redis adapter for horizontal scaling
  try {
    const { pubClient, subClient } = getPubSubClients();
    io.adapter(createAdapter(pubClient, subClient));
    logger.info('Socket.io Redis adapter configured');
  } catch (error) {
    logger.error({ error }, 'Failed to setup Redis adapter, running in single-server mode');
  }

  // Connection logging
  io.on('connection', (socket: TypedSocket) => {
    logger.info({ socketId: socket.id }, 'Client connected');

    socket.on('disconnect', (reason) => {
      logger.info({ socketId: socket.id, reason }, 'Client disconnected');
    });

    socket.on('error', (error) => {
      logger.error({ socketId: socket.id, error }, 'Socket error');
    });
  });

  return io;
}
