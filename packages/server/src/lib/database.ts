import mongoose from 'mongoose';
import { ChatError } from '@majestic/chat-shared';
import { logger } from './logger';

type MongooseCache = {
  conn: typeof mongoose | null;
  promise: Promise<typeof mongoose> | null;
};

declare global {
  // eslint-disable-next-line no-var
  var mongooseCache: MongooseCache | undefined;
}

let cached: MongooseCache = global.mongooseCache || { conn: null, promise: null };

if (!global.mongooseCache) {
  global.mongooseCache = cached;
}

export async function connectDatabase(): Promise<typeof mongoose> {
  const MONGODB_URI = process.env.MONGODB_URI;

  if (!MONGODB_URI) {
    throw ChatError.internal('MONGODB_URI environment variable is not defined');
  }

  // Return cached connection if available
  if (cached.conn) {
    logger.debug('Using cached MongoDB connection');
    return cached.conn;
  }

  // Return pending connection promise if exists
  if (cached.promise) {
    cached.conn = await cached.promise;
    return cached.conn;
  }

  // Create new connection
  const opts = {
    maxPoolSize: 10,
    minPoolSize: 5,
    maxIdleTimeMS: 30000,
    serverSelectionTimeoutMS: 5000,
  };

  cached.promise = mongoose.connect(MONGODB_URI, opts).then((mongooseInstance) => {
    logger.info('MongoDB connected successfully');
    return mongooseInstance;
  });

  try {
    cached.conn = await cached.promise;
  } catch (error) {
    cached.promise = null;
    logger.error({ error }, 'Failed to connect to MongoDB');
    throw ChatError.database(
      `Failed to connect to MongoDB: ${error instanceof Error ? error.message : 'Unknown error'}`
    );
  }

  return cached.conn;
}

export async function disconnectDatabase(): Promise<void> {
  if (cached.conn) {
    await cached.conn.disconnect();
    cached.conn = null;
    cached.promise = null;
    logger.info('MongoDB disconnected');
  }
}
