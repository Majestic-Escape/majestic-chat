import { createServer } from 'http';
import express from 'express';
import cors from 'cors';
import { connectDatabase } from './lib/database';
import { createSocketServer } from './socket/server';
import { socketAuthMiddleware } from './middleware/socketAuth';
import { registerMessageEvents } from './events/messageEvents';
import { registerTypingEvents } from './events/typingEvents';
import { ChatService } from './services/ChatService';
import { conversationRoutes } from './routes/conversationRoutes';
import { getRedisClient } from './lib/redis';
import { createShutdown } from './lib/shutdown';
import { logger } from './lib/logger';
import { buildCorsOptions } from './lib/corsOptions';

const PORT = process.env.PORT || 3001;

// A rejected promise nobody awaited (a dropped Redis publish, a late cache
// write) must never take the process down with every socket on it. Log and
// carry on; the failing operation has already degraded on its own.
process.on('unhandledRejection', (reason) => {
  logger.error({ reason: reason instanceof Error ? reason.message : String(reason) }, 'Unhandled promise rejection (ignored)');
});
process.on('uncaughtException', (error) => {
  logger.fatal({ error }, 'Uncaught exception');
  process.exit(1);
});

// Validate required environment variables at startup
function validateEnvironment(): void {
  const required = ['JWT_SECRET'];
  const missing = required.filter(key => !process.env[key]);
  
  if (missing.length > 0) {
    logger.error({ missing }, 'Missing required environment variables');
    throw new Error(`Missing required environment variables: ${missing.join(', ')}`);
  }

  // Warn about insecure CORS configuration
  if (!process.env.CORS_ORIGIN) {
    logger.warn('CORS_ORIGIN not set - defaulting to restrictive localhost origins. Set CORS_ORIGIN in production!');
  }
}

// Get allowed CORS origins
function getCorsOrigins(): string | string[] {
  if (process.env.CORS_ORIGIN) {
    // Support comma-separated origins
    return process.env.CORS_ORIGIN.split(',').map(o => o.trim());
  }
  // Default to localhost origins for development
  return ['http://localhost:3000', 'http://localhost:3001', 'http://localhost:3002'];
}

async function startServer() {
  try {
    // Validate environment before starting
    validateEnvironment();

    // Connect to MongoDB
    await connectDatabase();
    logger.info('Database connected');

    // Open the cache client now so the first request does not pay (or skip)
    // the connection; without REDIS_URL the cache simply stays off.
    if (process.env.REDIS_URL) {
      try {
        getRedisClient();
      } catch (error) {
        logger.warn({ error }, 'Redis cache client not started');
      }
    } else {
      logger.warn('REDIS_URL not set — running without cache and single-instance broadcast');
    }

    // Create Express app
    const app = express();
    
    // Middleware - secure CORS configuration
    const corsOrigins = getCorsOrigins();
    app.use(cors(buildCorsOptions(corsOrigins)));
    logger.info({ origins: corsOrigins }, 'CORS configured');
    app.use(express.json());

    // Health check endpoint
    app.get('/health', (req, res) => {
      res.json({ status: 'ok', timestamp: new Date().toISOString() });
    });

    // API routes
    app.use('/api/chat', conversationRoutes);

    // Create HTTP server from Express app
    const httpServer = createServer(app);

    // Create Socket.io server
    const io = createSocketServer(httpServer);

    // Apply authentication middleware
    io.use(socketAuthMiddleware);

    // Initialize services
    const chatService = new ChatService();

    // Register event handlers
    registerMessageEvents(io, chatService);
    registerTypingEvents(io);

    // Start server
    httpServer.listen(PORT, () => {
      logger.info({ port: PORT }, 'MajesticEscape Chat Server started');
      logger.info(`REST API: http://localhost:${PORT}/api/chat`);
      logger.info(`WebSocket: ws://localhost:${PORT}`);
    });

    // Graceful shutdown (sockets first, then Redis and Mongo; see lib/shutdown)
    const shutdown = createShutdown(io);
    process.on('SIGTERM', () => shutdown('SIGTERM'));
    process.on('SIGINT', () => shutdown('SIGINT'));
  } catch (error) {
    logger.error({ error }, 'Failed to start server');
    process.exit(1);
  }
}

startServer();
