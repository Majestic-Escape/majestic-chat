import { SOCKET_EVENTS, ConversationRefInputSchema, getRoomName } from '@majestic/chat-shared';
import { TypedServer, TypedSocket } from '../socket/server';
import { logger as baseLogger } from '../lib/logger';
import { lightLimit } from './messageEvents';

/**
 * Typing indicators are best-effort and carry no data, so they are gated by
 * room membership instead of a lookup: a socket may only signal typing in a
 * conversation it has joined, and a join is only granted to a participant
 * (messageEvents). Anything else is dropped — a stranger cannot make "typing…"
 * appear in a thread they are not part of.
 *
 * The update goes to every socket in the room except the typing user's own
 * sockets (`user:<id>` holds all of a user's connections on every instance),
 * so a host typing on one device never sees "Typing…" on another. This is a
 * plain adapter broadcast — no cluster-wide fetchSockets() round trip per
 * keystroke.
 */
function emitTyping(io: TypedServer, socket: TypedSocket, conversationId: string, isTyping: boolean): boolean {
  const roomName = getRoomName(conversationId);
  if (!socket.data.joinedRooms?.has(roomName)) return false;
  io.to(roomName)
    .except(`user:${socket.data.user.id}`)
    .emit(SOCKET_EVENTS.TYPING_UPDATE, {
      conversationId,
      userId: socket.data.user.id,
      isTyping,
    });
  return true;
}

export function registerTypingEvents(io: TypedServer): void {
  const logger = baseLogger.child({ module: 'typingEvents' });

  io.on('connection', (socket: TypedSocket) => {
    const handle = (isTyping: boolean) => (data: unknown) => {
      const user = socket.data.user;
      if (!user) {
        return;
      }
      if (!lightLimit(user.id).allowed) {
        return;
      }
      const parsed = ConversationRefInputSchema.safeParse(data);
      if (!parsed.success) {
        return;
      }
      try {
        const sent = emitTyping(io, socket, parsed.data.conversationId, isTyping);
        if (!sent) {
          logger.debug({ userId: user.id, conversationId: parsed.data.conversationId }, 'Typing ignored: not in room');
        }
      } catch (error) {
        logger.error({ error, userId: user.id }, 'Error handling typing event');
      }
    };

    // TYPING:START - User started typing
    socket.on(SOCKET_EVENTS.TYPING_START, handle(true));

    // TYPING:STOP - User stopped typing
    socket.on(SOCKET_EVENTS.TYPING_STOP, handle(false));
  });
}
