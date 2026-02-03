export const CHAT_CONFIG = {
  // Pagination
  DEFAULT_PAGE_SIZE: 50,
  MAX_PAGE_SIZE: 100,

  // Timeouts (ms)
  TYPING_TIMEOUT: 3000,
  // Increased ping timeout to prevent "transport close" disconnects
  // Server waits 60s for pong before considering connection dead
  SOCKET_PING_TIMEOUT: 60000,
  // Ping interval - server sends ping every 25s
  SOCKET_PING_INTERVAL: 25000,
  // Connection recovery - allow 2 minutes for reconnection
  CONNECTION_RECOVERY_DURATION: 120000,

  // Rate limits
  MESSAGES_PER_MINUTE: 60,
  UPLOADS_PER_HOUR: 30,

  // File limits
  MAX_FILE_SIZE: 25 * 1024 * 1024, // 25MB
  ALLOWED_IMAGE_TYPES: ['image/jpeg', 'image/png', 'image/webp', 'image/gif'],
  ALLOWED_DOC_TYPES: [
    'application/pdf',
    'application/msword',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  ],

  // Room naming
  ROOM_PREFIX: 'conversation:',
} as const;

export const getRoomName = (conversationId: string): string =>
  `${CHAT_CONFIG.ROOM_PREFIX}${conversationId}`;
