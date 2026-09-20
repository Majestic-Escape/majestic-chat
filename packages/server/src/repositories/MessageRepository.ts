import mongoose from 'mongoose';
import {
  Message,
  LastMessage,
  SendMessageParams,
  PaginationOptions,
  PaginatedResult,
  MessageModel,
  ConversationModel,
  IMessageDocument,
  ChatError,
} from '@majestic/chat-shared';
import { logger } from '../lib/logger';

export type NewMessageData = Omit<Message, 'id' | 'createdAt' | 'updatedAt'>;

/** Result of an idempotent create: `created` is false when the
 * (conversationId, clientMessageId) document already existed — including when
 * a concurrent insert won the race (E11000). Callers branch on it explicitly;
 * nothing is inferred from the document. */
export interface CreateResult {
  message: Message;
  created: boolean;
}

function isDuplicateKey(error: unknown): boolean {
  const e = error as { code?: number; cause?: { code?: number } };
  return e?.code === 11000 || e?.cause?.code === 11000;
}

export class MessageRepository {
  private model = MessageModel;
  private conversationModel = ConversationModel;
  private logger = logger.child({ repository: 'MessageRepository' });

  /**
   * Insert a message AND apply its conversation side effects (lastMessage,
   * per-recipient unread increments) in ONE multi-document transaction, so a
   * crash at any point leaves either both or neither. Idempotent on
   * (conversationId, clientMessageId): a duplicate aborts the transaction and
   * the existing document is returned with `created: false` — no side effect
   * is ever applied twice, whatever the age of the retry.
   *
   * Requires a replica set (all Atlas tiers; tests use MongoMemoryReplSet).
   * Redis cache invalidation is the caller's job, after commit.
   */
  async createWithConversationUpdate(
    data: NewMessageData,
    sideEffects: { lastMessage: Omit<LastMessage, 'sentAt'>; recipientIds: string[] }
  ): Promise<CreateResult> {
    const session = await mongoose.startSession();
    try {
      let inserted: Message | null = null;
      await session.withTransaction(async () => {
        inserted = null;
        const [doc] = await this.model.create([data], { session });
        const created = this.transformDocument(doc.toObject({ transform: false, virtuals: false }));
        const inc: Record<string, number> = {};
        for (const userId of sideEffects.recipientIds) inc[`unreadCount.${userId}`] = 1;
        await this.conversationModel.updateOne(
          { _id: data.conversationId },
          {
            $set: {
              lastMessage: { ...sideEffects.lastMessage, sentAt: created.createdAt },
              updatedAt: new Date(),
            },
            ...(sideEffects.recipientIds.length ? { $inc: inc } : {}),
          },
          { session }
        );
        inserted = created;
      });
      if (inserted) {
        this.logger.info({ messageId: (inserted as Message).id }, 'Message created');
        return { message: inserted, created: true };
      }
      throw ChatError.database('Transaction ended without a result');
    } catch (error) {
      if (isDuplicateKey(error)) {
        const existing = await this.model
          .findOne({ conversationId: data.conversationId, clientMessageId: data.clientMessageId })
          .lean();
        if (existing) {
          this.logger.debug({ messageId: existing._id }, 'Duplicate clientMessageId — returning existing message');
          return { message: this.transformDocument(existing), created: false };
        }
      }
      this.logger.error({ error }, 'Error creating message');
      throw error;
    } finally {
      await session.endSession();
    }
  }

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

  /**
   * The message a reply may quote: must live in the SAME conversation and not
   * be deleted. One query, scoped by conversation, so a message from another
   * thread is never materialised — unknown, foreign and deleted ids are
   * indistinguishable to the caller (no existence oracle).
   */
  async findReplyTarget(conversationId: string, messageId: string): Promise<Message | null> {
    try {
      const message = await this.model
        .findOne({ _id: messageId, conversationId, deletedAt: null })
        .lean();
      return message ? this.transformDocument(message) : null;
    } catch (error) {
      this.logger.error({ error, conversationId, messageId }, 'Error finding reply target');
      throw ChatError.database('Failed to find message');
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
      const desc = direction === 'before';

      // Cursor-based pagination on (createdAt, _id): two messages committed in
      // the same millisecond are ordered by _id, so pages never skip or repeat
      // a message with a tied timestamp. The cursor must belong to this
      // conversation (a foreign id is simply ignored).
      if (cursor) {
        const cursorMessage = await this.model.findOne({ _id: cursor, conversationId }).lean();
        if (cursorMessage) {
          const op = desc ? '$lt' : '$gt';
          query.$or = [
            { createdAt: { [op]: cursorMessage.createdAt } },
            { createdAt: cursorMessage.createdAt, _id: { [op]: cursorMessage._id } },
          ];
        }
      }

      // Fetch one extra to determine if there are more results
      const messages = await this.model
        .find(query)
        .sort(desc ? { createdAt: -1, _id: -1 } : { createdAt: 1, _id: 1 })
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

  /**
   * The truth behind a participant's unread counter: messages in the
   * conversation from other senders that carry no readBy entry for them.
   * One indexed count on the conversation (threads are small).
   */
  async countUnreadFor(conversationId: string, userId: string): Promise<number> {
    try {
      return await this.model.countDocuments({
        conversationId,
        senderId: { $ne: userId },
        'readBy.userId': { $ne: userId },
        deletedAt: null,
      });
    } catch (error) {
      this.logger.error({ error, conversationId, userId }, 'Error counting unread messages');
      throw ChatError.database('Failed to count unread messages');
    }
  }

  /** Returns how many messages were newly marked read (already-read ones do not count). */
  async updateReadBy(conversationId: string, messageIds: string[], userId: string, readAt: Date): Promise<number> {
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
      return result.modifiedCount;
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
      // Explicit pick: old documents (no key) serialise exactly as before —
      // JSON drops undefined — and nothing but the four snapshot fields leaks.
      replyTo: doc.replyTo?.messageId
        ? {
            messageId: doc.replyTo.messageId,
            senderId: doc.replyTo.senderId,
            text: doc.replyTo.text ?? '',
            type: doc.replyTo.type,
          }
        : undefined,
    };
  }
}
