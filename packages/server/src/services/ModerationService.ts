import {
  checkCandidate,
  detectContact,
  isContextRelevant,
  MessageContent,
  ModerationResult,
  ModerationStatus,
  MODERATION_VERSION,
  MODERATION_BLOCKED_MESSAGE,
  normalizeForModeration,
} from '@majestic/chat-shared';
import { logger } from '../lib/logger';
import type { ModerationContextRow } from '../repositories/MessageRepository';

/**
 * Message moderation (contact lock-down, 2026-09-20).
 *
 * A candidate is judged against the sender's recently ACCEPTED messages in
 * the same conversation — the context that the recipient has already seen —
 * so a phone number, email, domain or handle split across messages is caught
 * on the completing fragment. The context is read from Mongo (the authoritative
 * history: only persisted messages count, exactly once, a rejected candidate
 * never enters it) and bounded as follows:
 *  - the newest messages up to CONTEXT_CHARS normalised characters (walked
 *    newest → older, at most CONTEXT_ROWS_CAP rows, within CONTEXT_DAYS);
 *  - plus every older message that can be a piece of an identifier
 *    (moderation.fragment, see isContextRelevant) — up to
 *    CONTEXT_FRAGMENT_ROWS rows / CONTEXT_FRAGMENT_CHARS characters — so a
 *    digit sent an hour and forty filler messages ago is still in the picture.
 * The caller holds the per-(conversation, sender) lock across read → judge →
 * persist, so concurrent sends cannot slip past each other.
 */
export const CONTEXT_CHARS = 1500;
export const CONTEXT_ROWS_CAP = 400;
export const CONTEXT_FRAGMENT_ROWS = 200;
export const CONTEXT_FRAGMENT_CHARS = 3000;
export const CONTEXT_DAYS = 7;

export interface ModerationContextSource {
  moderationContext(conversationId: string, senderId: string, since: Date, caps: { rows: number; fragmentRows: number; chars: number; fragmentChars: number }): Promise<ModerationContextRow[]>;
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
      fragment: isContextRelevant(text),
    };
  }

  /**
   * The sender's accepted messages, oldest first: the newest ones up to the
   * character budget, plus older identifier-bearing ones (bounded), see above.
   */
  private async loadContext(context: ModerationContext): Promise<string[]> {
    const since = new Date(Date.now() - CONTEXT_DAYS * 24 * 60 * 60 * 1000);
    const newestFirst = await context.source.moderationContext(context.conversationId, context.senderId, since, { rows: CONTEXT_ROWS_CAP, fragmentRows: CONTEXT_FRAGMENT_ROWS, chars: CONTEXT_CHARS, fragmentChars: CONTEXT_FRAGMENT_CHARS });
    const kept: ModerationContextRow[] = [];
    let budget = CONTEXT_CHARS;
    let fragmentBudget = CONTEXT_FRAGMENT_CHARS;
    let fragmentRows = 0;
    let windowOpen = true;
    for (const row of newestFirst) {
      if (!row.text) continue;
      const len = normalizeForModeration(row.text).text.length;
      if (windowOpen && len <= budget) {
        budget -= len;
        kept.push(row);
        continue;
      }
      windowOpen = false; // the character window ends at the first row that does not fit
      // older rows survive only when they can be a piece of an identifier
      const relevant = row.fragment === undefined ? isContextRelevant(row.text) : row.fragment;
      if (!relevant || fragmentRows >= CONTEXT_FRAGMENT_ROWS || len > fragmentBudget) continue;
      fragmentBudget -= len;
      fragmentRows++;
      kept.push(row);
    }
    return kept.reverse().map((r) => r.text);
  }

  formatWarningMessage(result: ModerationResult): string | null {
    if (result.status === ModerationStatus.BLOCKED) return MODERATION_BLOCKED_MESSAGE;
    if (result.status === ModerationStatus.FLAGGED) {
      return 'Please keep all communication and payments on Majestic Escape.';
    }
    return null;
  }
}
