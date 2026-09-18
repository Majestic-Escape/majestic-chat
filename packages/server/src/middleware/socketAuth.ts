import jwt from 'jsonwebtoken';
import { TypedSocket } from '../socket/server';
import { verifyWithMainApi } from '../lib/session';
import { logger } from '../lib/logger';

export type AuthenticatedSocket = TypedSocket & {
  data: {
    user: {
      id: string;
      firstName: string;
      role?: string;
    };
    joinedRooms: Set<string>;
  };
};

export interface JWTPayload {
  userId: string;
  firstName: string;
  tokenVersion?: number;
  admin?: number;
}

// Validate JWT_SECRET exists at module load time - fail fast if not configured
function getJwtSecret(): string {
  const secret = process.env.JWT_SECRET;
  if (!secret) {
    logger.error('FATAL: JWT_SECRET environment variable is not configured');
    throw new Error('JWT_SECRET must be configured before starting the server');
  }
  return secret;
}

// Get the secret once at module load - server will fail to start if missing
const JWT_SECRET: string = getJwtSecret();

/** Local signature/expiry check; throws jwt errors. */
export function decodeToken(token: string): JWTPayload {
  const decoded = jwt.verify(token, JWT_SECRET) as JWTPayload;
  if (!decoded || typeof decoded.userId !== 'string' || !/^[a-f0-9]{24}$/i.test(decoded.userId)) {
    throw new jwt.JsonWebTokenError('Invalid token payload');
  }
  return decoded;
}

export async function socketAuthMiddleware(socket: TypedSocket, next: (err?: Error) => void): Promise<void> {
  try {
    // Extract token from handshake
    const token = socket.handshake.auth.token;

    if (!token || typeof token !== 'string') {
      logger.warn({ socketId: socket.id }, 'Socket connection attempt without token');
      return next(new Error('Authentication required'));
    }

    // Verify JWT (JWT_SECRET is guaranteed to be a string due to getJwtSecret check)
    const decoded = decodeToken(token);

    // The signature says who; server.me says whether the session still stands
    // (logout-all, ban, deleted account). Cached, fail-open — see lib/session.
    if ((await verifyWithMainApi(token)) === 'rejected') {
      logger.warn({ socketId: socket.id, userId: decoded.userId }, 'Session invalidated by main API');
      return next(new Error('Token invalidated'));
    }

    // Set user data on socket (map userId to id for consistency)
    socket.data.user = {
      id: decoded.userId,
      firstName: decoded.firstName,
      role: decoded.admin === 1 ? 'admin' : 'user',
    };
    socket.data.joinedRooms = new Set();

    logger.info({ socketId: socket.id, userId: decoded.userId }, 'Socket authenticated');
    next();
  } catch (error) {
    if (error instanceof jwt.TokenExpiredError) {
      logger.warn({ socketId: socket.id }, 'Expired token');
      return next(new Error('Token expired'));
    }

    if (error instanceof jwt.JsonWebTokenError) {
      logger.warn({ socketId: socket.id, error: error.message }, 'Invalid token');
      return next(new Error('Invalid token'));
    }

    logger.error({ socketId: socket.id, error }, 'Authentication error');
    next(new Error('Authentication failed'));
  }
}

export function getUserFromSocket(
  socket: TypedSocket
): { id: string; firstName: string; role?: string } | null {
  return socket.data.user || null;
}

export function isAuthenticated(socket: TypedSocket): socket is AuthenticatedSocket {
  return !!socket.data.user;
}
