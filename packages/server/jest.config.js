/** Server test suite: ts-jest against src/, real Mongo via mongodb-memory-server
 * (replica set — the message transaction needs one), real socket.io clients.
 * Env is set in setupEnv.ts; no Redis (single-server mode). */
module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  roots: ['<rootDir>/src'],
  testMatch: ['**/__tests__/**/*.test.ts'],
  setupFiles: ['<rootDir>/src/__tests__/setupEnv.ts'],
  testTimeout: 60000,
  // ts-jest resolves @majestic/chat-shared through the workspace symlink → dist
  moduleFileExtensions: ['ts', 'js', 'json'],
};
