import {
  SOCKET_EVENTS,
  SendMessageInputSchema,
  ReadMessagesInputSchema,
  ConversationRefInputSchema,
  ChatError,
  ErrorCode,
  getRoomName,
  MessageType,
  CHAT_CONFIG,
} from '@majestic/chat-shared';
import { TypedServer, TypedSocket } from '../socket/server';
import { ChatService } from '../services/ChatService';
import { UnreadCountService } from '../services/UnreadCountService';
import { logger as baseLogger } from '../lib/logger';

// Rate limiting state, per user and per process. Two budgets: message sends
// (the expensive path) and the light events (join / leave / read / typing),
// which still cost a lookup or a room fan-out each and must not be floodable.
const rateLimitMap = new Map<string, { count: number; windowStart: number }>();

// Clean up old rate limit entries every 5 minutes. unref(): the timer must not
// keep a process (or a Jest worker) alive on its own.
setInterval(() => {
  const now = Date.now();
  for (const [key, data] of rateLimitMap.entries()) {
    if (now - data.windowStart > 60000) {
      rateLimitMap.delete(key);
    }
  }
}, 5 * 60 * 1000).unref();

function checkRateLimit(key: string, maxPerMinute: number): { allowed: boolean; retryAfter?: number } {
  const now = Date.now();
  const windowMs = 60000; // 1 minute window

  const userLimit = rateLimitMap.get(key);

  if (!userLimit || now - userLimit.windowStart > windowMs) {
    // New window
    rateLimitMap.set(key, { count: 1, windowStart: now });
    return { allowed: true };
  }

  if (userLimit.count >= maxPerMinute) {
    const retryAfter = Math.ceil((userLimit.windowStart + windowMs - now) / 1000);
    return { allowed: false, retryAfter };
  }

  userLimit.count++;
  return { allowed: true };
}

const messageLimit = (userId: string) => checkRateLimit(userId, CHAT_CONFIG.MESSAGES_PER_MINUTE);
/** Shared budget for join / leave / read / typing (typingEvents imports it). */
export const lightLimit = (userId: string) => checkRateLimit(`light:${userId}`, CHAT_CONFIG.LIGHT_EVENTS_PER_MINUTE);

/** Exported for tests: the light-event budget is what a join/read/typing flood hits. */
export const __rateLimitMap = rateLimitMap;

export function registerMessageEvents(io: TypedServer, chatService: ChatService): void {
  const logger = baseLogger.child({ module: 'messageEvents' });
  const unreadCountService = UnreadCountService.getInstance();

  const emitError = (socket: TypedSocket, code: ErrorCode, message: string) => {
    socket.emit(SOCKET_EVENTS.ERROR, { code, message });
  };

  io.on('connection', (socket: TypedSocket) => {
    // Room membership changes are applied strictly in the order the client
    // emitted them: a join awaits a participant lookup while a leave is
    // immediate, so without this chain "join A, leave A" could end joined.
    let roomOps: Promise<void> = Promise.resolve();
    const serial = (op: () => Promise<void>) => {
      roomOps = roomOps.then(op, op);
      return roomOps;
    };

    // MESSAGE:SEND - Send a new message
    socket.on(SOCKET_EVENTS.MESSAGE_SEND, async (data, callback) => {
      const user = socket.data.user;
      if (!user) {
        callback?.({ success: false, error: 'Not authenticated' });
        return;
      }
      const ack = typeof callback === 'function' ? callback : undefined;

      // Check rate limit
      const rateCheck = messageLimit(user.id);
      if (!rateCheck.allowed) {
        logger.warn({ userId: user.id, retryAfter: rateCheck.retryAfter }, 'Rate limit exceeded');
        const error = ChatError.rateLimited(rateCheck.retryAfter);
        emitError(socket, error.code, error.message);
        ack?.({
          success: false,
          code: error.code,
          error: `Rate limit exceeded. Try again in ${rateCheck.retryAfter} seconds.`,
        });
        return;
      }

      try {
        // Validate input. A malformed payload is a definitive rejection
        // (nothing stored): ack a human reason + VALIDATION_ERROR, no broadcast.
        const parsed = SendMessageInputSchema.safeParse(data);
        if (!parsed.success) {
          const issue = parsed.error.issues[0];
          const reason =
            issue?.path[0] === 'content' && issue.path[1] === 'text' && issue.code === 'too_big'
              ? `Message is too long (max ${CHAT_CONFIG.MAX_MESSAGE_LENGTH} characters)`
              : issue?.path[0] === 'content' && issue.path[1] === 'attachments'
                ? 'Attachments are not supported yet'
                : issue?.path[0] === 'replyTo'
                  ? 'Invalid reply target'
                  : 'Invalid message';
          logger.warn({ userId: user.id, issue }, 'Rejected message payload');
          ack?.({ success: false, code: ErrorCode.VALIDATION_ERROR, error: reason });
          return;
        }
        const validated = parsed.data;
        logger.debug({ userId: user.id, conversationId: validated.conversationId }, 'Sending message');

        // Send message via service. `created: false` means this
        // clientMessageId was already stored (retry after a lost ack, buffered
        // re-emit, concurrent duplicate): nothing changed in the DB, but we
        // still broadcast — delivery is at-least-once and clients de-duplicate
        // by message id / clientMessageId, so a crash between commit and
        // broadcast is healed by the sender's retry.
        const { message, recipientInfo, created } = await chatService.sendMessage({
          conversationId: validated.conversationId,
          senderId: user.id,
          content: validated.content,
          type: validated.type || MessageType.TEXT,
          clientMessageId: validated.clientMessageId,
          replyTo: validated.replyTo,
        });

        // Emit to conversation room
        const roomName = getRoomName(validated.conversationId);
        io.to(roomName).emit(SOCKET_EVENTS.MESSAGE_NEW, {
          message,
          conversationId: validated.conversationId,
        });

        // Emit role-scoped unread count update to each recipient's personal
        // room. `conversationId` (additive) lets a client that does not know
        // this conversation yet — a brand-new inquiry — refresh its list and
        // join the room instead of waiting for a reload.
        for (const recipient of recipientInfo) {
          try {
            const totalUnread = await unreadCountService.getTotalUnread(
              recipient.userId,
              recipient.role as 'host' | 'guest'
            );
            io.to(`user:${recipient.userId}`).emit(SOCKET_EVENTS.UNREAD_COUNT_UPDATE, {
              userId: recipient.userId,
              totalUnread,
              role: recipient.role,
              conversationId: validated.conversationId,
            });
          } catch (err) {
            logger.error({ err, recipientId: recipient.userId }, 'Error emitting unread count update');
          }
        }

        // Send acknowledgment
        ack?.({ success: true, messageId: message.id });

        logger.info({ messageId: message.id, userId: user.id, created }, created ? 'Message sent' : 'Message re-acknowledged (idempotent)');
      } catch (error) {
        logger.error({ error, userId: user.id }, 'Error sending message');

        if (error instanceof ChatError) {
          emitError(socket, error.code, error.message);
          ack?.({ success: false, code: error.code, error: error.message });
        } else {
          // Unknown failure: the client must treat this as ambiguous (the
          // message may or may not have been stored) and retry the same id.
          ack?.({ success: false, code: ErrorCode.INTERNAL_ERROR, error: 'Failed to send message' });
        }
      }
    });

    // MESSAGE:READ - Mark messages as read
    socket.on(SOCKET_EVENTS.MESSAGE_READ, async (data) => {
      const user = socket.data.user;
      if (!user) {
        return;
      }
      if (!lightLimit(user.id).allowed) {
        logger.warn({ userId: user.id }, 'Light-event rate limit exceeded (read)');
        return;
      }

      // Validate before anything reads the payload (an unbounded id list would
      // become an unbounded $in and an unbounded room broadcast)
      const parsed = ReadMessagesInputSchema.safeParse(data);
      if (!parsed.success) {
        logger.warn({ userId: user.id, issue: parsed.error.issues[0] }, 'Rejected read payload');
        emitError(socket, ErrorCode.VALIDATION_ERROR, 'Invalid read receipt');
        return;
      }
      const validated = parsed.data;

      try {
        logger.debug({ userId: user.id, conversationId: validated.conversationId }, 'Marking messages as read');

        // Mark as read via service (returns new total unread count + role)
        const { newTotal, role } = await chatService.markAsRead(validated.conversationId, user.id, validated.messageIds);

        // Emit to conversation room
        const roomName = getRoomName(validated.conversationId);
        io.to(roomName).emit(SOCKET_EVENTS.MESSAGE_READ_ACK, {
          conversationId: validated.conversationId,
          messageIds: validated.messageIds,
          userId: user.id,
          timestamp: new Date(),
        });

        // Emit role-scoped updated unread count to the reader's personal room
        io.to(`user:${user.id}`).emit(SOCKET_EVENTS.UNREAD_COUNT_UPDATE, {
          userId: user.id,
          totalUnread: newTotal,
          role,
          conversationId: validated.conversationId,
        });

        logger.info(
          { userId: user.id, conversationId: validated.conversationId, role, count: validated.messageIds.length, newTotal },
          'Messages marked as read'
        );
      } catch (error) {
        logger.error({ error, userId: user.id, conversationId: validated.conversationId }, 'Error marking messages as read');

        if (error instanceof ChatError) {
          emitError(socket, error.code, error.message);
        }
      }
    });

    // CONVERSATION:JOIN - Join a conversation room
    socket.on(SOCKET_EVENTS.CONVERSATION_JOIN, async (data) => {
      const user = socket.data.user;
      if (!user) {
        return;
      }
      if (!lightLimit(user.id).allowed) {
        logger.warn({ userId: user.id }, 'Light-event rate limit exceeded (join)');
        return;
      }

      const parsed = ConversationRefInputSchema.safeParse(data);
      if (!parsed.success) {
        logger.warn({ userId: user.id, issue: parsed.error.issues[0] }, 'Rejected join payload');
        emitError(socket, ErrorCode.VALIDATION_ERROR, 'Invalid conversation');
        return;
      }
      const { conversationId } = parsed.data;
      const roomName = getRoomName(conversationId);

      await serial(async () => {
      try {
        // Skip if already in this room (deduplication)
        if (socket.data.joinedRooms.has(roomName)) {
          logger.debug({ userId: user.id, conversationId }, 'Already in conversation room, skipping');
          return;
        }

        logger.debug({ userId: user.id, conversationId }, 'Joining conversation');

        // Verify user is participant (one USER_NOT_PARTICIPANT for unknown and
        // foreign conversations alike — no existence oracle)
        await chatService.getConversation(conversationId, user.id);

        // Join room
        await socket.join(roomName);
        socket.data.joinedRooms.add(roomName);

        logger.info({ userId: user.id, conversationId, roomName }, 'Joined conversation room');
      } catch (error) {
        logger.error({ error, userId: user.id, conversationId }, 'Error joining conversation');

        if (error instanceof ChatError) {
          emitError(socket, error.code, error.message);
        }
      }
      });
    });

    // CONVERSATION:LEAVE - Leave a conversation room
    socket.on(SOCKET_EVENTS.CONVERSATION_LEAVE, async (data) => {
      const user = socket.data.user;
      if (!user) {
        return;
      }
      if (!lightLimit(user.id).allowed) {
        return;
      }

      const parsed = ConversationRefInputSchema.safeParse(data);
      if (!parsed.success) {
        emitError(socket, ErrorCode.VALIDATION_ERROR, 'Invalid conversation');
        return;
      }
      const { conversationId } = parsed.data;
      const roomName = getRoomName(conversationId);

      await serial(async () => {
      try {
        logger.debug({ userId: user.id, conversationId }, 'Leaving conversation');

        // Leave room
        await socket.leave(roomName);
        socket.data.joinedRooms.delete(roomName);

        logger.info({ userId: user.id, conversationId, roomName }, 'Left conversation room');
      } catch (error) {
        logger.error({ error, userId: user.id, conversationId }, 'Error leaving conversation');
      }
      });
    });
  });
}
