import { EventEmitter } from 'events';
import {
  Message,
  Conversation,
  SendMessageParams,
  SendMessageParamsSchema,
  PaginationOptions,
  PaginatedResult,
  ChatError,
  MessageStatus,
  ModerationStatus,
  ParticipantRole,
  ConversationStatus,
} from '@majestic/chat-shared';
import { MessageRepository } from '../repositories/MessageRepository';
import { ConversationRepository } from '../repositories/ConversationRepository';
import { ModerationService } from './ModerationService';
import { UnreadCountService } from './UnreadCountService';
import { logger } from '../lib/logger';

export class ChatService {
  private messageRepo: MessageRepository;
  private conversationRepo: ConversationRepository;
  private moderationService: ModerationService;
  private unreadCountService: UnreadCountService;
  private eventEmitter: EventEmitter;
  private logger = logger.child({ service: 'ChatService' });

  constructor() {
    this.messageRepo = new MessageRepository();
    this.conversationRepo = new ConversationRepository();
    this.moderationService = new ModerationService();
    this.unreadCountService = UnreadCountService.getInstance();
    this.eventEmitter = new EventEmitter();
  }

  getEventEmitter(): EventEmitter {
    return this.eventEmitter;
  }

  async sendMessage(params: SendMessageParams): Promise<{ message: Message; recipientInfo: Array<{ userId: string; role: string }> }> {
    try {
      // Validate params
      const validated = SendMessageParamsSchema.parse(params);
      this.logger.debug({ conversationId: validated.conversationId }, 'Sending message');

      // Verify conversation exists
      const conversation = await this.conversationRepo.findById(validated.conversationId);
      if (!conversation) {
        throw ChatError.notFound('conversation');
      }

      // Verify sender is participant (using already-fetched conversation — no extra DB query)
      const isParticipant = conversation.participants.some(p => p.userId === validated.senderId);
      if (!isParticipant) {
        throw ChatError.userNotParticipant();
      }

      // Check for duplicate (idempotency)
      const existing = await this.messageRepo.findByClientMessageId(
        validated.conversationId,
        validated.clientMessageId
      );
      if (existing) {
        this.logger.debug({ messageId: existing.id }, 'Returning existing message (idempotent)');
        return { message: existing, recipientInfo: [] };
      }

      // Run moderation check
      const moderationResult = await this.moderationService.checkMessage(validated.content);

      // Block if moderation failed
      if (moderationResult.status === ModerationStatus.BLOCKED) {
        this.logger.warn(
          { conversationId: validated.conversationId, flags: moderationResult.flags },
          'Message blocked by moderation'
        );
        throw ChatError.moderationBlocked(moderationResult.flags);
      }

      // Create message
      const message = await this.messageRepo.create({
        conversationId: validated.conversationId,
        senderId: validated.senderId,
        clientMessageId: validated.clientMessageId,
        type: validated.type,
        content: validated.content,
        moderation: moderationResult,
        readBy: [{ userId: validated.senderId, readAt: new Date() }],
        status: MessageStatus.SENT,
      });

      // Update conversation lastMessage (pass participant IDs to avoid extra DB query)
      const participantUserIds = conversation.participants.map(p => p.userId);
      await this.conversationRepo.updateLastMessage(validated.conversationId, {
        content: validated.content.text || '[Attachment]',
        senderId: validated.senderId,
        sentAt: message.createdAt,
      }, participantUserIds);

      // Increment unread count for other participants (MongoDB + Redis)
      const recipientInfo: Array<{ userId: string; role: string }> = [];
      for (const participant of conversation.participants) {
        if (participant.userId !== validated.senderId) {
          await this.conversationRepo.incrementUnreadCount(
            validated.conversationId,
            participant.userId
          );
          // Directly recalculate and cache — avoids invalidate+get round-trip
          await this.unreadCountService.recalculateUnread(
            participant.userId,
            participant.role as 'host' | 'guest'
          );
          recipientInfo.push({ userId: participant.userId, role: participant.role as string });
        }
      }

      // Emit event
      this.eventEmitter.emit('message:created', { message, conversation });

      this.logger.info({ messageId: message.id }, 'Message sent successfully');
      return { message, recipientInfo };
    } catch (error) {
      this.logger.error({ error }, 'Error sending message');
      throw error;
    }
  }

  async getMessages(
    conversationId: string,
    userId: string,
    options: PaginationOptions
  ): Promise<PaginatedResult<Message>> {
    try {
      // Verify user is participant using cached findById (no separate query)
      const conversation = await this.conversationRepo.findById(conversationId);
      if (!conversation || !conversation.participants.some(p => p.userId === userId)) {
        throw ChatError.userNotParticipant();
      }

      // Fetch messages
      const result = await this.messageRepo.findByConversation(conversationId, options);

      this.logger.debug(
        { conversationId, count: result.data.length, hasMore: result.hasMore },
        'Messages fetched'
      );

      return result;
    } catch (error) {
      this.logger.error({ error, conversationId }, 'Error fetching messages');
      throw error;
    }
  }

  async markAsRead(conversationId: string, userId: string, messageIds: string[]): Promise<{ newTotal: number; role: string }> {
    try {
      // Verify user is participant AND get their role in one query
      const userRole = await this.unreadCountService.getUserRoleInConversation(userId, conversationId);
      if (!userRole) {
        throw ChatError.userNotParticipant();
      }

      // Update readBy on messages (only for messages in this conversation)
      await this.messageRepo.updateReadBy(conversationId, messageIds, userId, new Date());

      // Reset unread count in MongoDB
      await this.conversationRepo.resetUnreadCount(conversationId, userId);

      // Recalculate total unread in Redis and return new total + role
      const newTotal = await this.unreadCountService.recalculateUnread(userId, userRole);

      // Emit event
      this.eventEmitter.emit('messages:read', { conversationId, userId, messageIds });

      this.logger.debug({ conversationId, userId, role: userRole, count: messageIds.length, newTotal }, 'Messages marked as read');
      return { newTotal, role: userRole };
    } catch (error) {
      this.logger.error({ error, conversationId, userId }, 'Error marking messages as read');
      throw error;
    }
  }

  async getConversations(userId: string): Promise<Conversation[]> {
    try {
      const conversations = await this.conversationRepo.findByUserId(userId);

      this.logger.debug({ userId, count: conversations.length }, 'Conversations fetched');

      return conversations;
    } catch (error) {
      this.logger.error({ error, userId }, 'Error fetching conversations');
      throw error;
    }
  }

  async getConversationsByRole(userId: string, role: 'host' | 'guest'): Promise<Conversation[]> {
    try {
      const conversations = await this.conversationRepo.findByUserIdAndRole(userId, role);

      this.logger.debug({ userId, role, count: conversations.length }, 'Conversations fetched by role');

      return conversations;
    } catch (error) {
      this.logger.error({ error, userId, role }, 'Error fetching conversations by role');
      throw error;
    }
  }

  async getOrCreateConversation(
    propertyId: string,
    hostId: string,
    guestId: string,
    bookingId?: string,
    participantNames?: { hostFirstName?: string; hostLastName?: string; guestFirstName?: string; guestLastName?: string }
  ): Promise<Conversation> {
    try {
      // Try to find existing conversation for this specific property and participants
      const existing = await this.conversationRepo.findByParticipantsAndProperty([hostId, guestId], propertyId);

      if (existing) {
        this.logger.debug({ conversationId: existing.id, propertyId }, 'Found existing conversation for property');
        return existing;
      }

      // Create new conversation (different property or first conversation)
      const conversation = await this.conversationRepo.create({
        propertyId,
        bookingId,
        participants: [
          { 
            userId: hostId, 
            role: ParticipantRole.HOST, 
            firstName: participantNames?.hostFirstName,
            lastName: participantNames?.hostLastName,
            joinedAt: new Date() 
          },
          { 
            userId: guestId, 
            role: ParticipantRole.GUEST, 
            firstName: participantNames?.guestFirstName,
            lastName: participantNames?.guestLastName,
            joinedAt: new Date() 
          },
        ],
        unreadCount: { [hostId]: 0, [guestId]: 0 },
        status: ConversationStatus.ACTIVE,
      });

      this.logger.info({ conversationId: conversation.id, propertyId }, 'New conversation created');

      return conversation;
    } catch (error) {
      this.logger.error({ error, propertyId, hostId, guestId }, 'Error getting/creating conversation');
      throw error;
    }
  }

  async getConversation(conversationId: string, userId: string): Promise<Conversation> {
    try {
      // Single cached findById — no separate isUserParticipant query needed
      const conversation = await this.conversationRepo.findById(conversationId);

      if (!conversation) {
        throw ChatError.notFound('conversation');
      }

      // Check participant from already-fetched doc (in-memory, no DB query)
      const isParticipant = conversation.participants.some(p => p.userId === userId);
      if (!isParticipant) {
        throw ChatError.userNotParticipant();
      }

      return conversation;
    } catch (error) {
      this.logger.error({ error, conversationId, userId }, 'Error fetching conversation');
      throw error;
    }
  }

  async checkConversationExists(
    propertyId: string,
    hostId: string,
    guestId: string
  ): Promise<Conversation | null> {
    try {
      const existing = await this.conversationRepo.findByParticipantsAndProperty([hostId, guestId], propertyId);
      
      if (existing) {
        this.logger.debug({ conversationId: existing.id, propertyId }, 'Found existing conversation');
      }
      
      return existing;
    } catch (error) {
      this.logger.error({ error, propertyId, hostId, guestId }, 'Error checking conversation exists');
      throw error;
    }
  }
}
