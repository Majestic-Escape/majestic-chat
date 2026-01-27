import {
  Message,
  SendMessageParams,
  PaginationOptions,
  PaginatedResult,
  MessageModel,
  IMessageDocument,
  ChatError,
} from '@majestic/chat-shared';
import { logger } from '../lib/logger';

export class MessageRepository {
  private model = MessageModel;
  private logger = logger.child({ repository: 'MessageRepository' });

  async create(data: Omit<Message, 'id' | 'createdAt' | 'updatedAt'>): Promise<Message> {
    try {
      this.logger.debug({ conversationId: data.conversationId }, 'Creating message');

      // Use findOneAndUpdate with upsert to handle duplicate clientMessageId
      const message = await this.model.findOneAndUpdate(
        {
          conversationId: data.conversationId,
          clientMessageId: data.clientMessageId,
        },
        { $setOnInsert: data },
        {
          upsert: true,
          new: true,
          lean: true,
        }
      );

      if (!message) {
        throw ChatError.database('Failed to create message');
      }

      this.logger.info({ messageId: message._id }, 'Message created');
      return this.transformDocument(message);
    } catch (error) {
      this.logger.error({ error }, 'Error creating message');
      throw error;
    }
  }

  async findById(id: string): Promise<Message | null> {
    try {
      const message = await this.model.findById(id).lean();
      return message ? this.transformDocument(message) : null;
    } catch (error) {
      this.logger.error({ error, id }, 'Error finding message by ID');
      throw ChatError.database('Failed to find message');
    }
  }

  async findByConversation(
    conversationId: string,
    options: PaginationOptions
  ): Promise<PaginatedResult<Message>> {
    try {
      const { limit, cursor, direction } = options;

      const query: any = { conversationId };

      // Apply cursor-based pagination
      if (cursor) {
        const cursorMessage = await this.model.findById(cursor).lean();
        if (cursorMessage) {
          query.createdAt =
            direction === 'before'
              ? { $lt: cursorMessage.createdAt }
              : { $gt: cursorMessage.createdAt };
        }
      }

      // Fetch one extra to determine if there are more results
      const messages = await this.model
        .find(query)
        .sort({ createdAt: direction === 'before' ? -1 : 1 })
        .limit(limit + 1)
        .lean();

      const hasMore = messages.length > limit;
      const data = messages.slice(0, limit).map((msg) => this.transformDocument(msg));

      const nextCursor = hasMore && data.length > 0 ? data[data.length - 1].id : undefined;

      return {
        data,
        nextCursor,
        hasMore,
      };
    } catch (error) {
      this.logger.error({ error, conversationId }, 'Error finding messages by conversation');
      throw ChatError.database('Failed to find messages');
    }
  }

  async findByClientMessageId(
    conversationId: string,
    clientMessageId: string
  ): Promise<Message | null> {
    try {
      const message = await this.model.findOne({ conversationId, clientMessageId }).lean();
      return message ? this.transformDocument(message) : null;
    } catch (error) {
      this.logger.error({ error, conversationId, clientMessageId }, 'Error finding message');
      throw ChatError.database('Failed to find message');
    }
  }

  async updateReadBy(conversationId: string, messageIds: string[], userId: string, readAt: Date): Promise<void> {
    try {
      // Only update messages that belong to the specified conversation
      // and where the user hasn't already read the message
      const result = await this.model.updateMany(
        { 
          _id: { $in: messageIds },
          conversationId: conversationId,
          'readBy.userId': { $ne: userId }  // Only update if user hasn't already read
        },
        {
          $push: {
            readBy: { userId, readAt },
          },
        }
      );

      this.logger.debug({ messageIds, userId, conversationId, matchedCount: result.matchedCount }, 'Messages marked as read');
    } catch (error) {
      this.logger.error({ error, messageIds, userId, conversationId }, 'Error updating read receipts');
      throw ChatError.database('Failed to update read receipts');
    }
  }

  async updateStatus(messageId: string, status: Message['status']): Promise<void> {
    try {
      await this.model.findByIdAndUpdate(messageId, { status });
      this.logger.debug({ messageId, status }, 'Message status updated');
    } catch (error) {
      this.logger.error({ error, messageId, status }, 'Error updating message status');
      throw ChatError.database('Failed to update message status');
    }
  }

  private transformDocument(doc: any): Message {
    return {
      id: doc._id.toString(),
      conversationId: doc.conversationId,
      senderId: doc.senderId,
      clientMessageId: doc.clientMessageId,
      type: doc.type,
      content: doc.content,
      moderation: doc.moderation,
      readBy: doc.readBy || [],
      status: doc.status,
      createdAt: doc.createdAt,
      updatedAt: doc.updatedAt,
      deletedAt: doc.deletedAt,
    };
  }
}
