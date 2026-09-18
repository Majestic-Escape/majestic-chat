import {
  Conversation,
  ConversationModel,
  IConversationDocument,
  ChatError,
  Participant,
  LastMessage,
} from '@majestic/chat-shared';
import { getRedisClient } from '../lib/redis';
import { cacheGet, cacheSetEx } from '../lib/cache';
import { logger } from '../lib/logger';

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
    try {
      const redis = getRedisClient();
      await redis.del(this.convKey(id));
    } catch (e) {
      this.logger.warn({ e, id }, 'Redis invalidation failed (conv)');
    }
  }

  /**
   * Invalidate conversation list cache for specific user(s).
   */
  private async invalidateConvList(...userIds: string[]): Promise<void> {
    try {
      const redis = getRedisClient();
      const keys: string[] = [];
      for (const userId of userIds) {
        keys.push(this.convListKey(userId));
        keys.push(this.convListRoleKey(userId, 'host'));
        keys.push(this.convListRoleKey(userId, 'guest'));
      }
      if (keys.length > 0) {
        await redis.del(...keys);
      }
    } catch (e) {
      this.logger.warn({ e }, 'Redis invalidation failed (convlist)');
    }
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
        return JSON.parse(cached);
      }

      // 2. Fallback to MongoDB
      const conversation = await this.model.findById(id).lean();
      if (!conversation) return null;

      const result = this.transformDocument(conversation);

      // 3. Cache for next time
      await cacheSetEx(this.convKey(id), CONV_TTL, JSON.stringify(result));

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
        return JSON.parse(cached);
      }

      // 2. Fallback to MongoDB
      const conversations = await this.model
        .find({ 'participants.userId': userId })
        .sort({ updatedAt: -1 })
        .limit(limit)
        .lean();

      const result = conversations.map((conv) => this.transformDocument(conv));

      // 3. Cache for next time
      await cacheSetEx(cacheKey, CONVLIST_TTL, JSON.stringify(result));

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
        return JSON.parse(cached);
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

      // 3. Cache for next time
      await cacheSetEx(cacheKey, CONVLIST_TTL, JSON.stringify(result));

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

  async resetUnreadCount(conversationId: string, userId: string): Promise<void> {
    try {
      await this.model.findByIdAndUpdate(conversationId, {
        $set: { [`unreadCount.${userId}`]: 0 },
      });

      this.logger.debug({ conversationId, userId }, 'Unread count reset');

      // Invalidate conversation cache (unreadCount changed)
      await this.invalidateConv(conversationId);
    } catch (error) {
      this.logger.error({ error, conversationId, userId }, 'Error resetting unread count');
      throw ChatError.database('Failed to reset unread count');
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
    
    return {
      id,
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
