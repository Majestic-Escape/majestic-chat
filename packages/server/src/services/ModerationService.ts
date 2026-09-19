import {
  checkCandidate,
  detectContact,
  MessageContent,
  ModerationResult,
  ModerationStatus,
  MODERATION_VERSION,
  MODERATION_BLOCKED_MESSAGE,
  normalizeForModeration,
} from '@majestic/chat-shared';
import { logger } from '../lib/logger';

/**
 * Message moderation (contact lock-down, 2026-09-20).
 *
 * A candidate is judged against the sender's recently ACCEPTED messages in
 * the same conversation — the context that the recipient has already seen —
 * so a phone number, email, domain or handle split across messages is caught
 * on the completing fragment. The context is read from Mongo (the authoritative
 * history: only persisted messages count, exactly once, a rejected candidate
 * never enters it) and bounded by CONTEXT_MESSAGES / CONTEXT_CHARS /
 * CONTEXT_DAYS. The caller holds the per-(conversation, sender) lock across
 * read → judge → persist, so concurrent sends cannot slip past each other.
 */
export const CONTEXT_MESSAGES = 30;
export const CONTEXT_CHARS = 1500;
export const CONTEXT_DAYS = 7;

export interface ModerationContextSource {
  recentTextsBySender(conversationId: string, senderId: string, since: Date, limit: number): Promise<string[]>;
}

export interface ModerationContext {
  conversationId: string;
  senderId: string;
  source: ModerationContextSource;
}

export class ModerationService {
  private logger = logger.child({ service: 'ModerationService' });

  /** Judge a candidate message; with a context the sender's accepted history is included. */
  async checkMessage(content: MessageContent, context?: ModerationContext): Promise<ModerationResult> {
    const text = content.text || '';
    if (text.trim().length === 0) {
      return { status: ModerationStatus.CLEAN, flags: [], confidence: 0, version: MODERATION_VERSION };
    }

    const previous = context ? await this.loadContext(context) : [];
    const result = previous.length ? checkCandidate(previous, text) : detectContact(text);
    const status = result.status;
    const flags = result.kinds;

    if (status !== ModerationStatus.CLEAN) {
      this.logger.warn(
        { status, flags, conversationId: context?.conversationId, contextMessages: previous.length },
        status === ModerationStatus.BLOCKED ? 'Message blocked by moderation' : 'Message flagged by moderation'
      );
    }

    return {
      status,
      flags,
      confidence: status === ModerationStatus.BLOCKED ? 1 : status === ModerationStatus.FLAGGED ? 0.6 : 0,
      originalContent: status !== ModerationStatus.CLEAN ? text : undefined,
      version: MODERATION_VERSION,
    };
  }

  /**
   * The sender's accepted messages, oldest first, trimmed to the character
   * budget from the newest end (newest CONTEXT_MESSAGES within CONTEXT_DAYS).
   */
  private async loadContext(context: ModerationContext): Promise<string[]> {
    const since = new Date(Date.now() - CONTEXT_DAYS * 24 * 60 * 60 * 1000);
    const newestFirst = await context.source.recentTextsBySender(context.conversationId, context.senderId, since, CONTEXT_MESSAGES);
    const kept: string[] = [];
    let budget = CONTEXT_CHARS;
    for (const t of newestFirst) {
      if (!t) continue;
      const len = normalizeForModeration(t).text.length;
      if (len > budget) break;
      budget -= len;
      kept.push(t);
    }
    return kept.reverse();
  }

  formatWarningMessage(result: ModerationResult): string | null {
    if (result.status === ModerationStatus.BLOCKED) return MODERATION_BLOCKED_MESSAGE;
    if (result.status === ModerationStatus.FLAGGED) {
      return 'Please keep all communication and payments on Majestic Escape.';
    }
    return null;
  }
}
