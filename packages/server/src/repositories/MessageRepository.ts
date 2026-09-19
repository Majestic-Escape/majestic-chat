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
  MODERATION_VERSION,
  maskContactInfo,
  maskContactInfoParts,
} from '@majestic/chat-shared';
import { logger } from '../lib/logger';

/** Rows accepted before the contact lock-down carry no detector version and are masked on read. */
export function isLegacyModeration(doc: { moderation?: { version?: number } | null }): boolean {
  return !doc.moderation || !doc.moderation.version || doc.moderation.version < MODERATION_VERSION;
}

// Adjacent rows loaded around a history page that contains legacy rows, so a
// fragment split across a page boundary is masked in either direction.
const LEGACY_CONTEXT_ROWS = 40;

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
      return message ? this.transformDocument(this.maskIfLegacy(message)) : null;
    } catch (error) {
      this.logger.error({ error, conversationId, messageId }, 'Error finding reply target');
      throw ChatError.database('Failed to find message');
    }
  }

  async findById(id: string): Promise<Message | null> {
    try {
      const message = await this.model.findById(id).lean();
      return message ? this.transformDocument(this.maskIfLegacy(message)) : null;
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
      const page = messages.slice(0, limit);
      await this.maskLegacyHistory(conversationId, page);
      const data = page.map((msg) => this.transformDocument(msg));

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
      return message ? this.transformDocument(this.maskIfLegacy(message)) : null;
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

  /**
   * Moderation context: the sender's persisted messages in the conversation
   * since `since`, newest first (the caller trims to its character budget).
   */
  async recentTextsBySender(conversationId: string, senderId: string, since: Date, limit: number): Promise<string[]> {
    try {
      const rows = await this.model
        .find({ conversationId, senderId, createdAt: { $gte: since }, deletedAt: null }, { 'content.text': 1, createdAt: 1 })
        .sort({ createdAt: -1, _id: -1 })
        .limit(limit)
        .lean();
      return rows.map((r: any) => (r.content && r.content.text) || '');
    } catch (error) {
      this.logger.error({ error, conversationId, senderId }, 'Error loading moderation context');
      throw ChatError.database('Failed to load moderation context');
    }
  }

  /**
   * Legacy history (rows without MODERATION_VERSION) may still contain contact
   * data, including identifiers split across messages and across page
   * boundaries. When a page holds legacy rows, the adjacent rows on BOTH sides
   * are loaded as context, each sender's chronological sequence is masked as
   * one resource (separated and glued), and only the requested page is
   * returned — count, order and cursors unchanged. Pages of post-lock-down
   * rows cost nothing here.
   */
  private async maskLegacyHistory(conversationId: string, page: any[]): Promise<void> {
    if (!page.some((m) => isLegacyModeration(m))) return;
    const sortKey = (m: any) => `${new Date(m.createdAt).getTime().toString().padStart(15, '0')}:${String(m._id)}`;
    const ordered = [...page].sort((a, b) => (sortKey(a) < sortKey(b) ? -1 : 1));
    const oldest = ordered[0];
    const newest = ordered[ordered.length - 1];
    const [older, newer] = await Promise.all([
      this.model
        .find({ conversationId, $or: [{ createdAt: { $lt: oldest.createdAt } }, { createdAt: oldest.createdAt, _id: { $lt: oldest._id } }] }, { senderId: 1, 'content.text': 1, createdAt: 1 })
        .sort({ createdAt: -1, _id: -1 })
        .limit(LEGACY_CONTEXT_ROWS)
        .lean(),
      this.model
        .find({ conversationId, $or: [{ createdAt: { $gt: newest.createdAt } }, { createdAt: newest.createdAt, _id: { $gt: newest._id } }] }, { senderId: 1, 'content.text': 1, createdAt: 1 })
        .sort({ createdAt: 1, _id: 1 })
        .limit(LEGACY_CONTEXT_ROWS)
        .lean(),
    ]);
    const sequence = [...(older as any[]).reverse(), ...ordered, ...(newer as any[])];
    const bySender = new Map<string, any[]>();
    for (const row of sequence) {
      const list = bySender.get(row.senderId) || [];
      list.push(row);
      bySender.set(row.senderId, list);
    }
    const inPage = new Set(page.map((m) => String(m._id)));
    for (const rows of bySender.values()) {
      if (!rows.some((r) => inPage.has(String(r._id)) && isLegacyModeration(r))) continue;
      const texts = rows.map((r) => (r.content && r.content.text) || '');
      const masked = maskContactInfoParts(texts);
      rows.forEach((r, i) => {
        if (masked[i] !== texts[i] && inPage.has(String(r._id))) {
          const target = page.find((m) => String(m._id) === String(r._id));
          if (target) target.content = { ...target.content, text: masked[i] };
        }
      });
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
      // A quote snapshot may carry legacy text: masked on read (bounded, ≤ REPLY_SNIPPET_MAX chars).
      replyTo: doc.replyTo?.messageId
        ? {
            messageId: doc.replyTo.messageId,
            senderId: doc.replyTo.senderId,
            text: maskContactInfo(doc.replyTo.text ?? ''),
            type: doc.replyTo.type,
          }
        : undefined,
    };
  }

  /** A legacy row served on its own (findById, reply target, idempotent replay) is masked individually. */
  private maskIfLegacy(doc: any): any {
    if (!doc || !isLegacyModeration(doc) || !doc.content?.text) return doc;
    return { ...doc, content: { ...doc.content, text: maskContactInfo(doc.content.text) } };
  }
}
