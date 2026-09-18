// Runs before every test file. JWT_SECRET is read at import time by
// socketAuth.ts / index.ts; REDIS_URL must be absent so getRedisClient() throws
// synchronously and every caller falls back to single-server mode.
process.env.JWT_SECRET = 'test-jwt-secret';
process.env.LOG_LEVEL = 'silent';
process.env.NODE_ENV = 'test';
delete process.env.REDIS_URL;
