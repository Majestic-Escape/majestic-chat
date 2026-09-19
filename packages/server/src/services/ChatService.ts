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
  ReplyRef,
  buildReplyRef,
} from '@majestic/chat-shared';
import { MessageRepository } from '../repositories/MessageRepository';
import { ConversationRepository } from '../repositories/ConversationRepository';
import { ModerationService } from './ModerationService';
import { UnreadCountService } from './UnreadCountService';
import { logger, logFailure } from '../lib/logger';

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

  /**
   * The message a reply quotes: must exist in THIS conversation and not be
   * deleted. One generic MESSAGE_NOT_FOUND for unknown / foreign / deleted ids
   * (no existence oracle across conversations). The stored snapshot is built
   * here from the persisted original — never from anything a client sent.
   */
  private async resolveReplyTo(conversationId: string, messageId: string): Promise<ReplyRef> {
    const original = await this.messageRepo.findReplyTarget(conversationId, messageId);
    if (!original) {
      throw ChatError.notFound('message');
    }
    return buildReplyRef(original);
  }

  /**
   * Send a message. Idempotent on (conversationId, clientMessageId):
   *  - `created: true`  → inserted now, conversation lastMessage/unread applied
   *    atomically with it (one transaction), Redis recomputed;
   *  - `created: false` → the same logical send was already stored (retry after
   *    a lost ack, concurrent duplicate, buffered re-emit); nothing in the DB is
   *    touched. `recipientInfo` is still filled so the caller re-broadcasts —
   *    delivery to the other party is at-least-once and clients de-duplicate.
   */
  async sendMessage(params: SendMessageParams): Promise<{ message: Message; recipientInfo: Array<{ userId: string; role: string }>; created: boolean }> {
    try {
      // Validate params
      const validated = SendMessageParamsSchema.parse(params);
      this.logger.debug({ conversationId: validated.conversationId }, 'Sending message');

      // Verify the conversation exists AND the sender is a participant. One
      // answer for both failures: a caller must not be able to tell a foreign
      // conversation from a non-existent one (no existence oracle on ids).
      const conversation = await this.conversationRepo.findById(validated.conversationId);
      const isParticipant = !!conversation && conversation.participants.some(p => p.userId === validated.senderId);
      if (!conversation || !isParticipant) {
        throw ChatError.userNotParticipant();
      }

      const recipients = conversation.participants
        .filter(p => p.userId !== validated.senderId)
        .map(p => ({ userId: p.userId, role: p.role as string }));

      // Check for duplicate (idempotency) — cheap fast path; the unique index
      // inside createWithConversationUpdate is the real guarantee.
      const existing = await this.messageRepo.findByClientMessageId(
        validated.conversationId,
        validated.clientMessageId
      );
      if (existing) {
        this.logger.debug({ messageId: existing.id }, 'Returning existing message (idempotent)');
        return { message: existing, recipientInfo: recipients, created: false };
      }

      // Resolve the quoted message before any write (structural check, 404)
      const replyTo = validated.replyTo
        ? await this.resolveReplyTo(validated.conversationId, validated.replyTo.messageId)
        : undefined;

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

      // Insert the message and update the conversation (lastMessage + unread)
      // in one transaction — both or neither, whatever crashes afterwards.
      // A plain message carries no replyTo key at all.
      const { message, created } = await this.messageRepo.createWithConversationUpdate(
        {
          conversationId: validated.conversationId,
          senderId: validated.senderId,
          clientMessageId: validated.clientMessageId,
          type: validated.type,
          content: validated.content,
          moderation: moderationResult,
          readBy: [{ userId: validated.senderId, readAt: new Date() }],
          status: MessageStatus.SENT,
          ...(replyTo ? { replyTo } : {}),
        },
        {
          lastMessage: {
            content: validated.content.text || '[Attachment]',
            senderId: validated.senderId,
          },
          recipientIds: recipients.map(r => r.userId),
        }
      );

      if (!created) {
        // Lost the race to a concurrent identical send: same outcome as the
        // fast path above — nothing else to apply.
        this.logger.debug({ messageId: message.id }, 'Returning existing message (idempotent, raced)');
        return { message, recipientInfo: recipients, created: false };
      }

      // Redis: drop the cached conversation/lists and recompute unread totals
      // (idempotent recomputes from Mongo, outside the transaction)
      const participantUserIds = conversation.participants.map(p => p.userId);
      await this.conversationRepo.invalidateAfterMessage(validated.conversationId, participantUserIds);
      for (const recipient of recipients) {
        await this.unreadCountService.recalculateUnread(
          recipient.userId,
          recipient.role as 'host' | 'guest'
        );
      }

      // Emit event
      this.eventEmitter.emit('message:created', { message, conversation });

      this.logger.info({ messageId: message.id }, 'Message sent successfully');
      return { message, recipientInfo: recipients, created: true };
    } catch (error) {
      logFailure(this.logger, error, {}, 'Error sending message', 'debug');
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
      logFailure(this.logger, error, { conversationId }, 'Error fetching messages', 'debug');
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
      const newlyRead = messageIds.length > 0
        ? await this.messageRepo.updateReadBy(conversationId, messageIds, userId, new Date())
        : 0;

      // The counter moves by what this receipt marked read and is raised to
      // the readBy truth — a message that arrived while the receipt was in
      // flight stays counted (an unconditional reset to 0 used to lose it).
      // Only a change invalidates the cached conversation + the reader's
      // lists (the list carries per-conversation unread badges) and forces a
      // recount; re-reading an already-read thread changes nothing.
      const truth = await this.messageRepo.countUnreadFor(conversationId, userId);
      const changed = await this.conversationRepo.applyReadToUnreadCount(conversationId, userId, newlyRead, truth);
      const newTotal = changed
        ? await this.unreadCountService.recalculateUnread(userId, userRole)
        : await this.unreadCountService.getTotalUnread(userId, userRole);

      // Emit event
      this.eventEmitter.emit('messages:read', { conversationId, userId, messageIds });

      this.logger.debug({ conversationId, userId, role: userRole, count: messageIds.length, newTotal }, 'Messages marked as read');
      return { newTotal, role: userRole };
    } catch (error) {
      logFailure(this.logger, error, { conversationId, userId }, 'Error marking messages as read', 'debug');
      throw error;
    }
  }

  async getConversations(userId: string): Promise<Conversation[]> {
    try {
      const conversations = await this.conversationRepo.findByUserId(userId);

      this.logger.debug({ userId, count: conversations.length }, 'Conversations fetched');

      return conversations;
    } catch (error) {
      logFailure(this.logger, error, { userId }, 'Error fetching conversations', 'debug');
      throw error;
    }
  }

  async getConversationsByRole(userId: string, role: 'host' | 'guest'): Promise<Conversation[]> {
    try {
      const conversations = await this.conversationRepo.findByUserIdAndRole(userId, role);

      this.logger.debug({ userId, role, count: conversations.length }, 'Conversations fetched by role');

      return conversations;
    } catch (error) {
      logFailure(this.logger, error, { userId, role }, 'Error fetching conversations by role', 'debug');
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
      logFailure(this.logger, error, { propertyId, hostId, guestId }, 'Error getting/creating conversation', 'debug');
      throw error;
    }
  }

  async getConversation(conversationId: string, userId: string): Promise<Conversation> {
    try {
      // Single cached findById — no separate isUserParticipant query needed.
      // Unknown and foreign conversations get the same answer (no oracle).
      const conversation = await this.conversationRepo.findById(conversationId);
      const isParticipant = !!conversation && conversation.participants.some(p => p.userId === userId);
      if (!conversation || !isParticipant) {
        throw ChatError.userNotParticipant();
      }

      return conversation;
    } catch (error) {
      logFailure(this.logger, error, { conversationId, userId }, 'Error fetching conversation', 'debug');
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
      logFailure(this.logger, error, { propertyId, hostId, guestId }, 'Error checking conversation exists', 'debug');
      throw error;
    }
  }
}
