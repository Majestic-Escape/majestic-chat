import { ModerationStatus } from '../types/chat.types';

export enum PatternType {
  INDIAN_PHONE = 'INDIAN_PHONE',
  SPACED_PHONE = 'SPACED_PHONE',
  EMAIL = 'EMAIL',
  OBFUSCATED_EMAIL = 'OBFUSCATED_EMAIL',
  WHATSAPP = 'WHATSAPP',
  TELEGRAM = 'TELEGRAM',
  SIGNAL = 'SIGNAL',
  CONTACT_INTENT = 'CONTACT_INTENT',
}

// Regex patterns for contact detection.
//
// These run synchronously on the chat server's event loop for every message
// (up to MAX_MESSAGE_LENGTH characters), so each one must be linear in the
// input: bounded runs instead of unbounded `+`/`*`, and whitespace between
// tokens consumed atomically with the `(?=(\s*))\N` idiom so two adjacent
// optional/whitespace groups can never share (and re-split) the same run. The
// previous unbounded forms took seconds on a crafted 4000-character message
// ("aaa… " + 2000 spaces → 5.7 s), enough to stall every user; the worst case
// now is a few milliseconds.
export const MODERATION_PATTERNS: Record<PatternType, RegExp> = {
  // Matches: "+91 98765 43210", "9876543210", "+91-98765-43210"
  [PatternType.INDIAN_PHONE]: /(?:\+91[\s.-]?)?[6-9]\d{4}[\s.-]?\d{5}/gi,

  // Matches: "9 8 7 6 5 4 3 2 1 0", "9.8.7.6.5.4.3.2.1.0"
  [PatternType.SPACED_PHONE]: /[6-9](?:\s{0,3}\d){9}/gi,

  // Standard email format (RFC-ish bounds: 64-char local part, 63-char labels)
  [PatternType.EMAIL]: /[a-zA-Z0-9._%+-]{1,64}@[a-zA-Z0-9-]{1,63}(?:\.[a-zA-Z0-9-]{1,63}){0,4}\.[a-zA-Z]{2,24}/gi,

  // Email with (at) and (dot): "user (at) example (dot) com"
  [PatternType.OBFUSCATED_EMAIL]:
    /[a-zA-Z0-9._%+-]{1,64}(?=(\s*))\1[\(\[]?(?=(\s*))\2at(?=(\s*))\3[\)\]]?(?=(\s*))\4[a-zA-Z0-9-]{1,63}(?=(\s*))\5[\(\[]?(?=(\s*))\6dot(?=(\s*))\7[\)\]]?(?=(\s*))\8[a-zA-Z]{2,24}/gi,

  // WhatsApp mentions: "whatsapp", "whats app", "wa.me/", "watsap"
  [PatternType.WHATSAPP]: /whats?\s{0,3}app|wa\.me\/|watsap/gi,

  // Telegram handles and links: "telegram", "t.me/", "@username"
  [PatternType.TELEGRAM]: /telegram|t\.me\/|@[a-zA-Z][a-zA-Z0-9_]{4,}/gi,

  // Signal app mentions
  [PatternType.SIGNAL]: /\bsignal\s{0,3}(?:app|number|me)\b/gi,

  // Contact sharing intent phrases
  [PatternType.CONTACT_INTENT]: /(?:call|text|reach|contact|message|ping|dm)\s{0,3}(?:me|us)\s{0,3}(?:on|at|via|@)?/gi,
};

export interface ViolationMatch {
  pattern: PatternType;
  match: string;
  index: number;
  length: number;
}

export interface ViolationResult {
  hasViolations: boolean;
  violations: ViolationMatch[];
  confidence: number;
  flaggedPatterns: PatternType[];
}

/**
 * Check text for contact information violations
 */
export function checkText(text: string): ViolationResult {
  const violations: ViolationMatch[] = [];
  const flaggedPatterns: Set<PatternType> = new Set();

  // Run all patterns against the text
  for (const [patternType, regex] of Object.entries(MODERATION_PATTERNS)) {
    const pattern = patternType as PatternType;
    const matches = text.matchAll(regex);

    for (const match of matches) {
      if (match.index !== undefined) {
        violations.push({
          pattern,
          match: match[0],
          index: match.index,
          length: match[0].length,
        });
        flaggedPatterns.add(pattern);
      }
    }
  }

  const confidence = calculateConfidence(violations);
  const status = getModerationStatus(confidence);

  return {
    hasViolations: violations.length > 0,
    violations,
    confidence,
    flaggedPatterns: Array.from(flaggedPatterns),
  };
}

/**
 * Calculate confidence score based on violation types
 */
export function calculateConfidence(violations: ViolationMatch[]): number {
  if (violations.length === 0) {
    return 0;
  }

  const patternWeights: Record<PatternType, number> = {
    [PatternType.INDIAN_PHONE]: 0.9,
    [PatternType.SPACED_PHONE]: 0.85,
    [PatternType.EMAIL]: 0.9,
    [PatternType.OBFUSCATED_EMAIL]: 0.85,
    [PatternType.WHATSAPP]: 0.7,
    [PatternType.TELEGRAM]: 0.7,
    [PatternType.SIGNAL]: 0.7,
    [PatternType.CONTACT_INTENT]: 0.4,
  };

  // Get unique pattern types
  const uniquePatterns = new Set(violations.map((v) => v.pattern));

  // Calculate weighted confidence
  let totalWeight = 0;
  for (const pattern of uniquePatterns) {
    totalWeight += patternWeights[pattern];
  }

  // Multiple violations increase confidence
  const multiplier = Math.min(1.2, 1 + uniquePatterns.size * 0.1);
  const confidence = Math.min(1.0, totalWeight * multiplier);

  return confidence;
}

/**
 * Determine moderation status based on confidence
 */
export function getModerationStatus(confidence: number): ModerationStatus {
  if (confidence >= 0.9) {
    return ModerationStatus.BLOCKED;
  }
  if (confidence >= 0.6) {
    return ModerationStatus.FLAGGED;
  }
  return ModerationStatus.CLEAN;
}
