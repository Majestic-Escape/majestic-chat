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
