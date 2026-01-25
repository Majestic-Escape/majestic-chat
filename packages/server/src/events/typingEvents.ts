import { SOCKET_EVENTS, getRoomName } from '@majestic/chat-shared';
import { TypedServer, TypedSocket } from '../socket/server';
import { logger as baseLogger } from '../lib/logger';

export function registerTypingEvents(io: TypedServer): void {
  const logger = baseLogger.child({ module: 'typingEvents' });

  io.on('connection', (socket: TypedSocket) => {
    // TYPING:START - User started typing
    socket.on(SOCKET_EVENTS.TYPING_START, async (data) => {
      const user = socket.data.user;
      if (!user) {
        return;
      }

      try {
        const { conversationId } = data;
        const roomName = getRoomName(conversationId);

        // Emit to others in the room (not to sender)
        socket.to(roomName).emit(SOCKET_EVENTS.TYPING_UPDATE, {
          conversationId,
          userId: user.id,
          isTyping: true,
        });

        logger.debug({ userId: user.id, conversationId }, 'User started typing');
      } catch (error) {
        logger.error({ error, userId: user.id }, 'Error handling typing start');
      }
    });

    // TYPING:STOP - User stopped typing
    socket.on(SOCKET_EVENTS.TYPING_STOP, async (data) => {
      const user = socket.data.user;
      if (!user) {
        return;
      }

      try {
        const { conversationId } = data;
        const roomName = getRoomName(conversationId);

        // Emit to others in the room (not to sender)
        socket.to(roomName).emit(SOCKET_EVENTS.TYPING_UPDATE, {
          conversationId,
          userId: user.id,
          isTyping: false,
        });

        logger.debug({ userId: user.id, conversationId }, 'User stopped typing');
      } catch (error) {
        logger.error({ error, userId: user.id }, 'Error handling typing stop');
      }
    });
  });
}
