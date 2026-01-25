import {
  checkText,
  getModerationStatus,
  ViolationResult,
  ModerationResult,
  MessageContent,
  ModerationStatus,
} from '@majestic/chat-shared';
import { logger } from '../lib/logger';

export class ModerationService {
  private logger = logger.child({ service: 'ModerationService' });

  async checkMessage(content: MessageContent): Promise<ModerationResult> {
    // If no text content, return clean result
    if (!content.text || content.text.trim().length === 0) {
      return {
        status: ModerationStatus.CLEAN,
        flags: [],
        confidence: 0,
      };
    }

    try {
      const result: ViolationResult = checkText(content.text);
      const status = getModerationStatus(result.confidence);

      const moderationResult: ModerationResult = {
        status,
        flags: result.flaggedPatterns,
        confidence: result.confidence,
        originalContent: result.hasViolations ? content.text : undefined,
      };

      // Log moderation decisions
      if (status !== ModerationStatus.CLEAN) {
        this.logger.warn(
          {
            status,
            confidence: result.confidence,
            flags: result.flaggedPatterns,
            violationCount: result.violations.length,
          },
          'Content moderation triggered'
        );
      }

      return moderationResult;
    } catch (error) {
      this.logger.error({ error }, 'Error during moderation check');
      // On error, return clean to avoid blocking legitimate messages
      return {
        status: ModerationStatus.CLEAN,
        flags: [],
        confidence: 0,
      };
    }
  }

  async checkBatch(contents: MessageContent[]): Promise<ModerationResult[]> {
    const results = await Promise.all(contents.map((content) => this.checkMessage(content)));

    this.logger.debug({ count: contents.length }, 'Batch moderation check completed');

    return results;
  }

  formatWarningMessage(result: ModerationResult): string | null {
    if (result.status === ModerationStatus.BLOCKED) {
      return 'Your message was blocked because it appears to contain contact information. Please use the platform for all communications to ensure safety and security for both parties.';
    }

    if (result.status === ModerationStatus.FLAGGED) {
      return 'Your message has been flagged for review. Please avoid sharing personal contact information. Use the platform messaging system for all communications.';
    }

    return null;
  }
}
