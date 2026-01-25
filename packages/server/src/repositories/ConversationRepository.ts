import {
  Conversation,
  ConversationModel,
  IConversationDocument,
  ChatError,
  Participant,
  LastMessage,
} from '@majestic/chat-shared';
import { logger } from '../lib/logger';

export class ConversationRepository {
  private model = ConversationModel;
  private logger = logger.child({ repository: 'ConversationRepository' });

  async create(data: Omit<Conversation, 'id' | 'createdAt' | 'updatedAt'>): Promise<Conversation> {
    try {
      this.logger.debug({ propertyId: data.propertyId }, 'Creating conversation');

      const conversation = await this.model.create(data);
      this.logger.info({ conversationId: conversation._id }, 'Conversation created');

      return this.transformDocument(conversation.toObject());
    } catch (error) {
      this.logger.error({ error }, 'Error creating conversation');
      throw ChatError.database('Failed to create conversation');
    }
  }

  async findById(id: string): Promise<Conversation | null> {
    try {
      const conversation = await this.model.findById(id).lean();
      return conversation ? this.transformDocument(conversation) : null;
    } catch (error) {
      this.logger.error({ error, id }, 'Error finding conversation by ID');
      throw ChatError.database('Failed to find conversation');
    }
  }

  async findByParticipants(userIds: string[]): Promise<Conversation | null> {
    try {
      const conversation = await this.model
        .findOne({
          'participants.userId': { $all: userIds },
          'participants.0': { $exists: true },
          $expr: { $eq: [{ $size: '$participants' }, userIds.length] },
        })
        .lean();

      return conversation ? this.transformDocument(conversation) : null;
    } catch (error) {
      this.logger.error({ error, userIds }, 'Error finding conversation by participants');
      throw ChatError.database('Failed to find conversation');
    }
  }

  async findByParticipantsAndProperty(userIds: string[], propertyId: string): Promise<Conversation | null> {
    try {
      const conversation = await this.model
        .findOne({
          propertyId,
          'participants.userId': { $all: userIds },
          'participants.0': { $exists: true },
          $expr: { $eq: [{ $size: '$participants' }, userIds.length] },
        })
        .lean();

      return conversation ? this.transformDocument(conversation) : null;
    } catch (error) {
      this.logger.error({ error, userIds, propertyId }, 'Error finding conversation by participants and property');
      throw ChatError.database('Failed to find conversation');
    }
  }

  async findByUserId(userId: string, limit: number = 50): Promise<Conversation[]> {
    try {
      const conversations = await this.model
        .find({ 'participants.userId': userId })
        .sort({ updatedAt: -1 })
        .limit(limit)
        .lean();

      return conversations.map((conv) => this.transformDocument(conv));
    } catch (error) {
      this.logger.error({ error, userId }, 'Error finding conversations by user ID');
      throw ChatError.database('Failed to find conversations');
    }
  }

  async findByPropertyId(propertyId: string): Promise<Conversation[]> {
    try {
      const conversations = await this.model.find({ propertyId }).sort({ updatedAt: -1 }).lean();

      return conversations.map((conv) => this.transformDocument(conv));
    } catch (error) {
      this.logger.error({ error, propertyId }, 'Error finding conversations by property ID');
      throw ChatError.database('Failed to find conversations');
    }
  }

  async updateLastMessage(conversationId: string, lastMessage: LastMessage): Promise<void> {
    try {
      await this.model.findByIdAndUpdate(conversationId, {
        lastMessage,
        updatedAt: new Date(),
      });

      this.logger.debug({ conversationId }, 'Last message updated');
    } catch (error) {
      this.logger.error({ error, conversationId }, 'Error updating last message');
      throw ChatError.database('Failed to update last message');
    }
  }

  async incrementUnreadCount(conversationId: string, userId: string): Promise<void> {
    try {
      await this.model.findByIdAndUpdate(conversationId, {
        $inc: { [`unreadCount.${userId}`]: 1 },
      });

      this.logger.debug({ conversationId, userId }, 'Unread count incremented');
    } catch (error) {
      this.logger.error({ error, conversationId, userId }, 'Error incrementing unread count');
      throw ChatError.database('Failed to increment unread count');
    }
  }

  async resetUnreadCount(conversationId: string, userId: string): Promise<void> {
    try {
      await this.model.findByIdAndUpdate(conversationId, {
        $set: { [`unreadCount.${userId}`]: 0 },
      });

      this.logger.debug({ conversationId, userId }, 'Unread count reset');
    } catch (error) {
      this.logger.error({ error, conversationId, userId }, 'Error resetting unread count');
      throw ChatError.database('Failed to reset unread count');
    }
  }

  async isUserParticipant(conversationId: string, userId: string): Promise<boolean> {
    try {
      const conversation = await this.model
        .findOne({
          _id: conversationId,
          'participants.userId': userId,
        })
        .lean();

      return !!conversation;
    } catch (error) {
      this.logger.error({ error, conversationId, userId }, 'Error checking participant');
      throw ChatError.database('Failed to check participant');
    }
  }

  async addParticipant(conversationId: string, participant: Participant): Promise<void> {
    try {
      await this.model.findByIdAndUpdate(conversationId, {
        $addToSet: { participants: participant },
      });

      this.logger.info({ conversationId, userId: participant.userId }, 'Participant added');
    } catch (error) {
      this.logger.error({ error, conversationId }, 'Error adding participant');
      throw ChatError.database('Failed to add participant');
    }
  }

  private transformDocument(doc: any): Conversation {
    return {
      id: doc._id.toString(),
      propertyId: doc.propertyId,
      bookingId: doc.bookingId,
      participants: doc.participants,
      lastMessage: doc.lastMessage,
      unreadCount: doc.unreadCount instanceof Map ? Object.fromEntries(doc.unreadCount) : doc.unreadCount || {},
      status: doc.status,
      createdAt: doc.createdAt,
      updatedAt: doc.updatedAt,
    };
  }
}
