import {
  SOCKET_EVENTS,
  SendMessageInputSchema,
  ReadMessagesInputSchema,
  ChatError,
  getRoomName,
  MessageType,
  CHAT_CONFIG,
} from '@majestic/chat-shared';
import { TypedServer, TypedSocket } from '../socket/server';
import { ChatService } from '../services/ChatService';
import { UnreadCountService } from '../services/UnreadCountService';
import { logger as baseLogger } from '../lib/logger';

// Rate limiting state - tracks message counts per user
const rateLimitMap = new Map<string, { count: number; windowStart: number }>();

// Clean up old rate limit entries every 5 minutes
setInterval(() => {
  const now = Date.now();
  for (const [userId, data] of rateLimitMap.entries()) {
    if (now - data.windowStart > 60000) {
      rateLimitMap.delete(userId);
    }
  }
}, 5 * 60 * 1000);

function checkRateLimit(userId: string): { allowed: boolean; retryAfter?: number } {
  const now = Date.now();
  const windowMs = 60000; // 1 minute window
  const maxMessages = CHAT_CONFIG.MESSAGES_PER_MINUTE;

  const userLimit = rateLimitMap.get(userId);

  if (!userLimit || now - userLimit.windowStart > windowMs) {
    // New window
    rateLimitMap.set(userId, { count: 1, windowStart: now });
    return { allowed: true };
  }

  if (userLimit.count >= maxMessages) {
    const retryAfter = Math.ceil((userLimit.windowStart + windowMs - now) / 1000);
    return { allowed: false, retryAfter };
  }

  userLimit.count++;
  return { allowed: true };
}

export function registerMessageEvents(io: TypedServer, chatService: ChatService): void {
  const logger = baseLogger.child({ module: 'messageEvents' });
  const unreadCountService = UnreadCountService.getInstance();

  io.on('connection', (socket: TypedSocket) => {
    // MESSAGE:SEND - Send a new message
    socket.on(SOCKET_EVENTS.MESSAGE_SEND, async (data, callback) => {
      const user = socket.data.user;
      if (!user) {
        callback?.({ success: false, error: 'Not authenticated' });
        return;
      }

      // Check rate limit
      const rateCheck = checkRateLimit(user.id);
      if (!rateCheck.allowed) {
        logger.warn({ userId: user.id, retryAfter: rateCheck.retryAfter }, 'Rate limit exceeded');
        const error = ChatError.rateLimited(rateCheck.retryAfter);
        socket.emit(SOCKET_EVENTS.ERROR, {
          code: error.code,
          message: error.message,
        });
        callback?.({ success: false, error: `Rate limit exceeded. Try again in ${rateCheck.retryAfter} seconds.` });
        return;
      }

      try {
        logger.debug({ userId: user.id, conversationId: data.conversationId }, 'Sending message');

        // Validate input
        const validated = SendMessageInputSchema.parse(data);

        // Send message via service
        const { message, recipientInfo } = await chatService.sendMessage({
          conversationId: validated.conversationId,
          senderId: user.id,
          content: validated.content,
          type: validated.type || MessageType.TEXT,
          clientMessageId: validated.clientMessageId,
        });

        // Emit to conversation room
        const roomName = getRoomName(validated.conversationId);
        io.to(roomName).emit(SOCKET_EVENTS.MESSAGE_NEW, {
          message,
          conversationId: validated.conversationId,
        });

        // Emit role-scoped unread count update to each recipient's personal room
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
            });
          } catch (err) {
            logger.error({ err, recipientId: recipient.userId }, 'Error emitting unread count update');
          }
        }

        // Send acknowledgment
        callback?.({ success: true, messageId: message.id });

        logger.info({ messageId: message.id, userId: user.id }, 'Message sent');
      } catch (error) {
        logger.error({ error, userId: user.id }, 'Error sending message');

        if (error instanceof ChatError) {
          socket.emit(SOCKET_EVENTS.ERROR, {
            code: error.code,
            message: error.message,
          });
          callback?.({ success: false, error: error.message });
        } else {
          callback?.({ success: false, error: 'Failed to send message' });
        }
      }
    });

    // MESSAGE:READ - Mark messages as read
    socket.on(SOCKET_EVENTS.MESSAGE_READ, async (data) => {
      const user = socket.data.user;
      if (!user) {
        return;
      }

      try {
        logger.debug({ userId: user.id, conversationId: data.conversationId }, 'Marking messages as read');

        // Validate input
        const validated = ReadMessagesInputSchema.parse(data);

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
        });

        logger.info(
          { userId: user.id, conversationId: validated.conversationId, role, count: validated.messageIds.length, newTotal },
          'Messages marked as read'
        );
      } catch (error) {
        logger.error({ error, userId: user.id }, 'Error marking messages as read');

        if (error instanceof ChatError) {
          socket.emit(SOCKET_EVENTS.ERROR, {
            code: error.code,
            message: error.message,
          });
        }
      }
    });

    // CONVERSATION:JOIN - Join a conversation room
    socket.on(SOCKET_EVENTS.CONVERSATION_JOIN, async (data) => {
      const user = socket.data.user;
      if (!user) {
        return;
      }

      try {
        const { conversationId } = data;
        const roomName = getRoomName(conversationId);

        // Skip if already in this room (deduplication)
        if (socket.data.joinedRooms.has(roomName)) {
          logger.debug({ userId: user.id, conversationId }, 'Already in conversation room, skipping');
          return;
        }

        logger.debug({ userId: user.id, conversationId }, 'Joining conversation');

        // Verify user is participant
        const conversation = await chatService.getConversation(conversationId, user.id);

        // Join room
        await socket.join(roomName);
        socket.data.joinedRooms.add(roomName);

        logger.info({ userId: user.id, conversationId, roomName }, 'Joined conversation room');
      } catch (error) {
        logger.error({ error, userId: user.id, conversationId: data.conversationId }, 'Error joining conversation');

        if (error instanceof ChatError) {
          socket.emit(SOCKET_EVENTS.ERROR, {
            code: error.code,
            message: error.message,
          });
        }
      }
    });

    // CONVERSATION:LEAVE - Leave a conversation room
    socket.on(SOCKET_EVENTS.CONVERSATION_LEAVE, async (data) => {
      const user = socket.data.user;
      if (!user) {
        return;
      }

      try {
        const { conversationId } = data;
        logger.debug({ userId: user.id, conversationId }, 'Leaving conversation');

        // Leave room
        const roomName = getRoomName(conversationId);
        await socket.leave(roomName);
        socket.data.joinedRooms.delete(roomName);

        logger.info({ userId: user.id, conversationId, roomName }, 'Left conversation room');
      } catch (error) {
        logger.error({ error, userId: user.id, conversationId: data.conversationId }, 'Error leaving conversation');
      }
    });
  });
}
