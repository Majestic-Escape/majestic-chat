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
import { verifyWithMainApi } from '../lib/session';
import { expireMessagingToggle, isMessagingEnabled } from '../lib/messagingToggle';
import { messagingPacketGate } from '../middleware/messagingGate';
import { logger } from '../lib/logger';
import jwt from 'jsonwebtoken';

// A socket can outlive its token by days. Re-check the signature/expiry and
// the main-API verdict now and then and drop sockets whose session is gone.
const SESSION_RECHECK_MS = 15 * 60 * 1000;

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
  
  logger.info({
    pingTimeout: CHAT_CONFIG.SOCKET_PING_TIMEOUT,
    pingInterval: CHAT_CONFIG.SOCKET_PING_INTERVAL,
    recoveryDuration: CHAT_CONFIG.CONNECTION_RECOVERY_DURATION,
    corsOrigins,
  }, 'Creating Socket.IO server with config');

  const io: TypedServer = new Server(httpServer, {
    cors: {
      origin: corsOrigins,
      credentials: true,
    },
    // Ping/pong settings to prevent "transport close" disconnects
    // Server sends ping every 25s, waits 60s for pong
    pingTimeout: CHAT_CONFIG.SOCKET_PING_TIMEOUT,
    pingInterval: CHAT_CONFIG.SOCKET_PING_INTERVAL,
    // Connection state recovery - allows reconnection within 2 minutes
    connectionStateRecovery: {
      maxDisconnectionDuration: CHAT_CONFIG.CONNECTION_RECOVERY_DURATION,
      // Skip middlewares on recovery (faster reconnection)
      skipMiddlewares: false,
    },
    // Allow WebSocket transport only (prevents polling issues)
    // If you need polling fallback, use: ['polling', 'websocket']
    transports: ['websocket', 'polling'],
    // Allow transport upgrade from polling to websocket
    allowUpgrades: true,
    // Per-message deflate compression (reduces bandwidth)
    perMessageDeflate: {
      threshold: 1024, // Only compress messages > 1KB
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

  // Drop every socket once an admin switches messaging off. While anyone is
  // connected this re-reads the flag every 5 s (the read also refreshes the cache
  // REST and handshakes use, so a flip lands within ~5 s); an idle instance reads
  // nothing and keeps the 10 s cache. `local`: each instance sweeps its own sockets.
  setInterval(() => {
    if (io.engine.clientsCount === 0) return;
    expireMessagingToggle();
    void isMessagingEnabled().then((enabled) => {
      if (enabled) return;
      io.local.emit('messaging:disabled');
      io.local.disconnectSockets(true);
    });
  }, 5_000).unref();

  // Track connection metrics
  let connectionCount = 0;

  // Connection logging
  io.on('connection', (socket: TypedSocket) => {
    connectionCount++;
    const clientInfo = {
      socketId: socket.id,
      transport: socket.conn.transport.name,
      remoteAddress: socket.handshake.address,
      userAgent: socket.handshake.headers['user-agent']?.substring(0, 50),
      recovered: socket.recovered,
      totalConnections: connectionCount,
    };
    
    logger.info(clientInfo, 'Client connected');

    // Every packet from this socket is checked against the messaging switch
    // (synchronously; see messagingPacketGate).
    socket.use((packet, next) => messagingPacketGate(socket, packet, next));

    // Auto-join user to personal room for global notifications (e.g., unread count updates)
    if (socket.data.user?.id) {
      const userRoom = `user:${socket.data.user.id}`;
      socket.join(userRoom);
      logger.info({ socketId: socket.id, userRoom }, 'Auto-joined user personal room');
    }

    // Log transport upgrades
    socket.conn.on('upgrade', (transport) => {
      logger.info({ socketId: socket.id, transport: transport.name }, 'Transport upgraded');
    });

    // Periodic session re-check (expired token, logout-all, ban, deleted user)
    const recheck = setInterval(async () => {
      const token = socket.handshake.auth?.token;
      let alive = typeof token === 'string';
      if (alive) {
        try {
          jwt.verify(token, process.env.JWT_SECRET as string);
        } catch {
          alive = false;
        }
      }
      if (alive && (await verifyWithMainApi(token)) === 'rejected') alive = false;
      if (!alive) {
        logger.warn({ socketId: socket.id, userId: socket.data.user?.id }, 'Session no longer valid — disconnecting socket');
        socket.disconnect(true);
      }
    }, SESSION_RECHECK_MS);
    recheck.unref();

    socket.on('disconnect', (reason) => {
      clearInterval(recheck);
      connectionCount--;
      logger.info({ 
        socketId: socket.id, 
        reason,
        totalConnections: connectionCount,
      }, 'Client disconnected');
    });

    socket.on('error', (error) => {
      logger.error({ socketId: socket.id, error }, 'Socket error');
    });
  });

  return io;
}
