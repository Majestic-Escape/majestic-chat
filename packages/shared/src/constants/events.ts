export const SOCKET_EVENTS = {
  // Client to Server
  MESSAGE_SEND: 'message:send',
  MESSAGE_READ: 'message:read',
  CONVERSATION_JOIN: 'conversation:join',
  CONVERSATION_LEAVE: 'conversation:leave',
  TYPING_START: 'typing:start',
  TYPING_STOP: 'typing:stop',

  // Server to Client
  MESSAGE_NEW: 'message:new',
  MESSAGE_SENT: 'message:sent',
  MESSAGE_DELIVERED: 'message:delivered',
  MESSAGE_READ_ACK: 'message:read',
  TYPING_UPDATE: 'typing:update',
  USER_ONLINE: 'user:online',
  USER_OFFLINE: 'user:offline',
  ERROR: 'error',
} as const;

export type SocketEvent = typeof SOCKET_EVENTS[keyof typeof SOCKET_EVENTS];
