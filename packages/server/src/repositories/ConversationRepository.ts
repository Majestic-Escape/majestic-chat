import {
  Conversation,
  ConversationModel,
  IConversationDocument,
  ChatError,
  Participant,
  LastMessage,
  MODERATION_VERSION,
  MASK,
  maskContactInfo,
  isFragmentBearing,
} from '@majestic/chat-shared';
import { cacheGet, cacheSetEx, cacheDel } from '../lib/cache';
import { logger } from '../lib/logger';

/**
 * What the other party may see of a participant: id, role, first name,
 * joinedAt. `lastName` (still present on legacy documents) is never returned.
 * Applied on every read path — Mongo and the Redis cache alike — so entries
 * cached before the contact lock-down cannot surface it either.
 */
export function toPublicParticipant(p: any): Participant {
  const out: Participant = { userId: p.userId, role: p.role, joinedAt: p.joinedAt };
  if (typeof p.firstName === 'string' && p.firstName) out.firstName = p.firstName;
  return out;
}

/** A legacy lastMessage preview (no MODERATION_VERSION) is masked conservatively. */
function toPublicLastMessage(lm: any): Conversation['lastMessage'] {
  if (!lm) return lm;
  if (lm.version && lm.version >= MODERATION_VERSION) return lm;
  const content = typeof lm.content === 'string' ? maskContactInfo(lm.content) : lm.content;
  return { ...lm, content: isFragmentBearing(content || '') ? MASK : content };
}

export function toPublicConversation(conv: Conversation): Conversation {
  return {
    ...conv,
    participants: (conv.participants || []).map(toPublicParticipant),
    lastMessage: toPublicLastMessage(conv.lastMessage),
  };
}

// Redis TTLs
const CONV_TTL = 600;     // 10 min — individual conversation cache
const CONVLIST_TTL = 120;  // 2 min — conversation list cache (changes on every message)

export class ConversationRepository {
  private model = ConversationModel;
  private logger = logger.child({ repository: 'ConversationRepository' });

  // ─── Redis Cache Helpers ───────────────────────────────────────

  private convKey(id: string): string {
    return `conv:${id}`;
  }

  private convListKey(userId: string): string {
    return `convlist:${userId}`;
  }

  private convListRoleKey(userId: string, role: string): string {
    return `convlist:${role}:${userId}`;
  }

  /**
   * Invalidate a single conversation cache.
   */
  private async invalidateConv(id: string): Promise<void> {
    await cacheDel(this.convKey(id));
  }

  /**
   * Invalidate conversation list cache for specific user(s).
   */
  private async invalidateConvList(...userIds: string[]): Promise<void> {
    const keys: string[] = [];
    for (const userId of userIds) {
      keys.push(this.convListKey(userId));
      keys.push(this.convListRoleKey(userId, 'host'));
      keys.push(this.convListRoleKey(userId, 'guest'));
    }
    await cacheDel(...keys);
  }

  // ─── CRUD Operations ──────────────────────────────────────────

  async create(data: Omit<Conversation, 'id' | 'createdAt' | 'updatedAt'>): Promise<Conversation> {
    try {
      this.logger.debug({ propertyId: data.propertyId }, 'Creating conversation');

      const conversation = await this.model.create(data);
      this.logger.info({ conversationId: conversation._id }, 'Conversation created');

      const result = conversation.toJSON() as unknown as Conversation;
      this.logger.debug({ resultId: result.id }, 'Document transformed');

      // Invalidate conversation lists for all participants
      const participantIds = data.participants.map(p => p.userId);
      await this.invalidateConvList(...participantIds);
      
      return result;
    } catch (error: any) {
      this.logger.error({ 
        error: error?.message || error, 
        stack: error?.stack,
        name: error?.name 
      }, 'Error creating conversation');
      throw ChatError.database('Failed to create conversation');
    }
  }

  /**
   * Find conversation by ID — Redis-cached.
   * Cache key: conv:{id}, TTL: 10 minutes.
   */
  async findById(id: string): Promise<Conversation | null> {
    try {
      // 1. Check Redis cache (optional — a miss when Redis is unavailable)
      const cached = await cacheGet(this.convKey(id));
      if (cached) {
        return toPublicConversation(JSON.parse(cached));
      }

      // 2. Fallback to MongoDB
      const conversation = await this.model.findById(id).lean();
      if (!conversation) return null;

      const result = this.transformDocument(conversation);

      // 3. Cache for next time — off the response's critical path (the helper
      // swallows failures and heals skipped writes itself)
      void cacheSetEx(this.convKey(id), CONV_TTL, JSON.stringify(result));

      return result;
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

  /**
   * Find all conversations for a user — Redis-cached.
   * Cache key: convlist:{userId}, TTL: 2 minutes.
   */
  async findByUserId(userId: string, limit: number = 50): Promise<Conversation[]> {
    try {
      // 1. Check Redis cache (optional)
      const cacheKey = this.convListKey(userId);
      const cached = await cacheGet(cacheKey);
      if (cached) {
        return (JSON.parse(cached) as Conversation[]).map(toPublicConversation);
      }

      // 2. Fallback to MongoDB
      const conversations = await this.model
        .find({ 'participants.userId': userId })
        .sort({ updatedAt: -1 })
        .limit(limit)
        .lean();

      const result = conversations.map((conv) => this.transformDocument(conv));

      // 3. Cache for next time — off the response's critical path
      void cacheSetEx(cacheKey, CONVLIST_TTL, JSON.stringify(result));

      return result;
    } catch (error) {
      this.logger.error({ error, userId }, 'Error finding conversations by user ID');
      throw ChatError.database('Failed to find conversations');
    }
  }

  /**
   * Find conversations for a user filtered by their role — Redis-cached.
   * Cache key: convlist:{role}:{userId}, TTL: 2 minutes.
   * 
   * This avoids fetching ALL conversations then filtering in JS on the frontend.
   */
  async findByUserIdAndRole(userId: string, role: 'host' | 'guest', limit: number = 50): Promise<Conversation[]> {
    try {
      // 1. Check Redis cache (optional)
      const cacheKey = this.convListRoleKey(userId, role);
      const cached = await cacheGet(cacheKey);
      if (cached) {
        return (JSON.parse(cached) as Conversation[]).map(toPublicConversation);
      }

      // 2. MongoDB query with role filter
      const conversations = await this.model
        .find({
          participants: { $elemMatch: { userId, role } }
        })
        .sort({ updatedAt: -1 })
        .limit(limit)
        .lean();

      const result = conversations.map((conv) => this.transformDocument(conv));

      // 3. Cache for next time — off the response's critical path
      void cacheSetEx(cacheKey, CONVLIST_TTL, JSON.stringify(result));

      return result;
    } catch (error) {
      this.logger.error({ error, userId, role }, 'Error finding conversations by user ID and role');
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

  // ─── Write Operations (with cache invalidation) ──────────────

  /**
   * Drop the Redis copies of a conversation and its participants' lists after
   * the document changed elsewhere (e.g. inside a message transaction).
   */
  async invalidateAfterMessage(conversationId: string, participantUserIds: string[]): Promise<void> {
    await this.invalidateConv(conversationId);
    if (participantUserIds.length > 0) await this.invalidateConvList(...participantUserIds);
  }

  async updateLastMessage(conversationId: string, lastMessage: LastMessage, participantUserIds?: string[]): Promise<void> {
    try {
      await this.model.findByIdAndUpdate(conversationId, {
        lastMessage,
        updatedAt: new Date(),
      });

      this.logger.debug({ conversationId }, 'Last message updated');

      // Invalidate conversation cache (lastMessage changed)
      await this.invalidateConv(conversationId);

      // Also invalidate conversation lists for all participants
      // (sort order changes when updatedAt changes)
      if (participantUserIds && participantUserIds.length > 0) {
        // Use caller-provided participant IDs — avoids extra DB query
        await this.invalidateConvList(...participantUserIds);
      } else {
        // Fallback: fetch from DB (used by other callers that don't have participant data)
        const conv = await this.model.findById(conversationId).select('participants').lean();
        if (conv?.participants) {
          const ids = conv.participants.map((p: any) => p.userId);
          await this.invalidateConvList(...ids);
        }
      }
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

      // Invalidate conversation cache (unreadCount changed)
      await this.invalidateConv(conversationId);
    } catch (error) {
      this.logger.error({ error, conversationId, userId }, 'Error incrementing unread count');
      throw ChatError.database('Failed to increment unread count');
    }
  }

  /**
   * Zero the reader's unread counter. Returns whether anything changed; only
   * then are the cached conversation AND the reader's conversation lists
   * dropped (the lists carry the per-conversation badge — leaving them cached
   * showed a stale unread badge for up to CONVLIST_TTL after reading).
   */
  /**
   * Apply a read receipt to a participant's unread counter.
   *
   * Resetting the counter to 0 on every read zeroed a message that had
   * landed between the client deciding to send its receipt and the server
   * applying it (the badge said 0 while the message was still unread), and a
   * plain `$set` of a recomputed value has the same hole: it waits for the
   * send transaction that is incrementing the same document and then
   * overwrites the increment. So the counter moves by what this receipt
   * actually marked read — a relative update composes with the send's
   * `$inc` in either order — floored at 0, and raised to the readBy truth
   * (`MessageRepository.countUnreadFor`, computed after the receipt) so a
   * counter that older code had zeroed too early heals on the next receipt.
   * Returns true when the stored value changed (only then are the caches
   * invalidated and the role total recounted).
   *
   * A counter that sits ABOVE the truth (a decrement that failed half-way, a
   * counted message that no longer counts) would never come down through a
   * relative update, so when `seen` — the raw counter read just before the
   * truth was counted — shows such drift, the counter is compared-and-set to
   * the truth: the filter matches only if nothing moved the counter since
   * `seen` was read, which is exactly when the truth is exact. If a
   * concurrent send did move it, the CAS matches nothing and the relative
   * update below runs instead, so a message that landed in the window is
   * never lost; the drift heals on the next quiet receipt.
   *
   * `timestamps: false`: a read is not a conversation update. Conversation
   * lists sort by `updatedAt`, so the automatic timestamp would move the
   * thread being read to the top of both participants' lists, and it made
   * every receipt count as modified (caches dropped and the total recounted
   * for a receipt that changed nothing).
   */
  async applyReadToUnreadCount(conversationId: string, userId: string, newlyRead: number, truth: number, seen?: number): Promise<boolean> {
    try {
      const field = `unreadCount.${userId}`;
      if (seen !== undefined && seen - newlyRead > truth) {
        const cas = await this.model.updateOne(
          { _id: conversationId, [field]: seen },
          { $set: { [field]: truth } },
          { timestamps: false }
        );
        if (cas.matchedCount > 0) {
          const converged = cas.modifiedCount > 0;
          this.logger.debug({ conversationId, userId, seen, newlyRead, truth, converged }, 'Unread count converged to the readBy truth');
          if (converged) {
            await this.invalidateConv(conversationId);
            await this.invalidateConvList(userId);
          }
          return converged;
        }
        // the counter moved while the truth was being counted: fall through to the relative update
      }
      const result = await this.model.updateOne(
        { _id: conversationId },
        [
          {
            $set: {
              [field]: {
                $max: [{ $subtract: [{ $ifNull: [`$${field}`, 0] }, newlyRead] }, truth, 0],
              },
            },
          },
        ],
        { timestamps: false }
      );
      const changed = result.modifiedCount > 0;

      this.logger.debug({ conversationId, userId, newlyRead, truth, changed }, 'Unread count updated by read receipt');

      if (changed) {
        await this.invalidateConv(conversationId);
        await this.invalidateConvList(userId);
      }
      return changed;
    } catch (error) {
      this.logger.error({ error, conversationId, userId }, 'Error resetting unread count');
      throw ChatError.database('Failed to reset unread count');
    }
  }

  /** The stored unread counter for a participant, read from MongoDB (never the cache). */
  async readUnreadCounter(conversationId: string, userId: string): Promise<number> {
    try {
      const field = `unreadCount.${userId}`;
      const doc = await this.model.findOne({ _id: conversationId }, { [field]: 1 }).lean<{ unreadCount?: Record<string, number> }>();
      const value = doc?.unreadCount?.[userId];
      return typeof value === 'number' ? value : 0;
    } catch (error) {
      this.logger.error({ error, conversationId, userId }, 'Error reading unread counter');
      throw ChatError.database('Failed to read unread counter');
    }
  }

  async isUserParticipant(conversationId: string, userId: string): Promise<boolean> {
    try {
      // Try cached findById first — avoids a separate DB query
      const cached = await this.findById(conversationId);
      if (cached) {
        return cached.participants.some(p => p.userId === userId);
      }

      // Fallback to direct DB query
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

      // Invalidate caches
      await this.invalidateConv(conversationId);
      await this.invalidateConvList(participant.userId);
    } catch (error) {
      this.logger.error({ error, conversationId }, 'Error adding participant');
      throw ChatError.database('Failed to add participant');
    }
  }

  private transformDocument(doc: any): Conversation {
    // Handle both transformed (id) and raw (_id) documents
    const id = doc.id || (doc._id ? doc._id.toString() : undefined);
    
    if (!id) {
      this.logger.error({ doc }, 'Document has no id or _id');
      throw new Error('Document has no id');
    }
    
    return toPublicConversation({
      id,
      propertyId: doc.propertyId,
      bookingId: doc.bookingId,
      participants: doc.participants,
      lastMessage: doc.lastMessage,
      unreadCount: doc.unreadCount instanceof Map ? Object.fromEntries(doc.unreadCount) : doc.unreadCount || {},
      status: doc.status,
      createdAt: doc.createdAt,
      updatedAt: doc.updatedAt,
    });
  }
}
