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
import { logger } from '../lib/logger';

export class ChatService {
  private messageRepo: MessageRepository;
  private conversationRepo: ConversationRepository;
  private moderationService: ModerationService;
  private eventEmitter: EventEmitter;
  private logger = logger.child({ service: 'ChatService' });

  constructor() {
    this.messageRepo = new MessageRepository();
    this.conversationRepo = new ConversationRepository();
    this.moderationService = new ModerationService();
    this.eventEmitter = new EventEmitter();
  }

  getEventEmitter(): EventEmitter {
    return this.eventEmitter;
  }

  async sendMessage(params: SendMessageParams): Promise<Message> {
    try {
      // Validate params
      const validated = SendMessageParamsSchema.parse(params);
      this.logger.debug({ conversationId: validated.conversationId }, 'Sending message');

      // Verify conversation exists
      const conversation = await this.conversationRepo.findById(validated.conversationId);
      if (!conversation) {
        throw ChatError.notFound('conversation');
      }

      // Verify sender is participant
      const isParticipant = await this.conversationRepo.isUserParticipant(
        validated.conversationId,
        validated.senderId
      );
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
        return existing;
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

      // Update conversation lastMessage
      await this.conversationRepo.updateLastMessage(validated.conversationId, {
        content: validated.content.text || '[Attachment]',
        senderId: validated.senderId,
        sentAt: message.createdAt,
      });

      // Increment unread count for other participants
      for (const participant of conversation.participants) {
        if (participant.userId !== validated.senderId) {
          await this.conversationRepo.incrementUnreadCount(
            validated.conversationId,
            participant.userId
          );
        }
      }

      // Emit event
      this.eventEmitter.emit('message:created', { message, conversation });

      this.logger.info({ messageId: message.id }, 'Message sent successfully');
      return message;
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
      // Verify user is participant
      const isParticipant = await this.conversationRepo.isUserParticipant(conversationId, userId);
      if (!isParticipant) {
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

  async markAsRead(conversationId: string, userId: string, messageIds: string[]): Promise<void> {
    try {
      // Verify user is participant
      const isParticipant = await this.conversationRepo.isUserParticipant(conversationId, userId);
      if (!isParticipant) {
        throw ChatError.userNotParticipant();
      }

      // Update readBy on messages
      await this.messageRepo.updateReadBy(messageIds, userId, new Date());

      // Reset unread count
      await this.conversationRepo.resetUnreadCount(conversationId, userId);

      // Emit event
      this.eventEmitter.emit('messages:read', { conversationId, userId, messageIds });

      this.logger.debug({ conversationId, userId, count: messageIds.length }, 'Messages marked as read');
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
      const conversation = await this.conversationRepo.findById(conversationId);

      if (!conversation) {
        throw ChatError.notFound('conversation');
      }

      // Verify user is participant
      const isParticipant = await this.conversationRepo.isUserParticipant(conversationId, userId);
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
