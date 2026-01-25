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
        const message = await chatService.sendMessage({
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

        // Mark as read via service
        await chatService.markAsRead(validated.conversationId, user.id, validated.messageIds);

        // Emit to conversation room
        const roomName = getRoomName(validated.conversationId);
        io.to(roomName).emit(SOCKET_EVENTS.MESSAGE_READ_ACK, {
          conversationId: validated.conversationId,
          messageIds: validated.messageIds,
          userId: user.id,
          timestamp: new Date(),
        });

        logger.info(
          { userId: user.id, conversationId: validated.conversationId, count: validated.messageIds.length },
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
        logger.debug({ userId: user.id, conversationId }, 'Joining conversation');

        // Verify user is participant
        const conversation = await chatService.getConversation(conversationId, user.id);

        // Join room
        const roomName = getRoomName(conversationId);
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
