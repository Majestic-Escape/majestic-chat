import { CHAT_CONFIG } from '../constants/config';
import type { Message, ReplyRef } from '../types/chat.types';

/**
 * Snippet stored on a reply (and shown in the quote block / preview bar).
 *
 * - whitespace (newlines, tabs, NBSP, runs of spaces) collapsed to one space,
 *   trimmed — the preview bar is a single line;
 * - `[Attachment]` when the original has no text but carries attachments,
 *   `''` when it has neither;
 * - hard-truncated to REPLY_SNIPPET_MAX UTF-16 code units **without splitting
 *   a surrogate pair** (a trailing lone high surrogate is dropped), so
 *   `snippet.length <= REPLY_SNIPPET_MAX` always holds — the same contract the
 *   Zod `.max()` and Mongoose `maxlength` enforce. No ellipsis: the UI clamps
 *   visually, and tests can assert exact lengths.
 */
export function buildReplySnippet(text: string | undefined, hasAttachments: boolean): string {
  const collapsed = (text ?? '').replace(/\s+/g, ' ').trim();
  if (!collapsed) return hasAttachments ? '[Attachment]' : '';
  const max = CHAT_CONFIG.REPLY_SNIPPET_MAX;
  if (collapsed.length <= max) return collapsed;
  let cut = collapsed.slice(0, max);
  const last = cut.charCodeAt(cut.length - 1);
  if (last >= 0xd800 && last <= 0xdbff) cut = cut.slice(0, -1);
  return cut;
}

/**
 * The snapshot a reply carries about the message it quotes. Copies only the
 * original's own fields — never `original.replyTo` — so chains stay O(1).
 */
export function buildReplyRef(original: Pick<Message, 'id' | 'senderId' | 'type' | 'content'>): ReplyRef {
  return {
    messageId: original.id,
    senderId: original.senderId,
    text: buildReplySnippet(original.content?.text, (original.content?.attachments?.length ?? 0) > 0),
    type: original.type,
  };
}
