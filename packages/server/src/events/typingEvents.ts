import { SOCKET_EVENTS, getRoomName } from '@majestic/chat-shared';
import { TypedServer, TypedSocket } from '../socket/server';
import { logger as baseLogger } from '../lib/logger';

/**
 * Emits typing update to all sockets in a room EXCEPT sockets belonging to the typing user.
 * This handles the multi-device scenario where the same user is logged in on multiple devices.
 * Without this, if Host A types on Device 1, Device 2 (also logged in as Host A) would
 * incorrectly show "Typing..." as if the other person is typing.
 */
 */
async function emitTypingToOtherUsers(
  io: TypedServer,
  roomName: string,
  typingUserId: string,
  conversationId: string,
  isTyping: boolean
): Promise<void> {
  // Get all sockets in the room
  const socketsInRoom = await io.in(roomName).fetchSockets();

  // Emit only to sockets that belong to OTHER users (not the typing user)
  for (const s of socketsInRoom) {
    if (s.data.user?.id !== typingUserId) {
      s.emit(SOCKET_EVENTS.TYPING_UPDATE, {
        conversationId,
        userId: typingUserId,
        isTyping,
      });
    }
  }
}

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

        // Emit to other users in the room (excludes ALL sockets of the typing user)
        await emitTypingToOtherUsers(io, roomName, user.id, conversationId, true);

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

        // Emit to other users in the room (excludes ALL sockets of the typing user)
        await emitTypingToOtherUsers(io, roomName, user.id, conversationId, false);

        logger.debug({ userId: user.id, conversationId }, 'User stopped typing');
      } catch (error) {
        logger.error({ error, userId: user.id }, 'Error handling typing stop');
      }
    });
  });
}
