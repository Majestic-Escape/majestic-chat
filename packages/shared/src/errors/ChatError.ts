// User-facing reasons (the site toasts the ack `error` verbatim and keeps the text in the composer).
export const MODERATION_BLOCKED_MESSAGE =
  "Contact details aren't allowed here. For your safety, keep communication and payments on Majestic Escape. Remove phone numbers, email addresses, social handles, links or direct-payment details and try again.";
export const MODERATION_BUSY_MESSAGE = 'Please try again in a moment.';
export const MODERATION_UNAVAILABLE_MESSAGE = "Messages with numbers or links can't be sent right now — please try again in a minute.";

export enum ErrorCode {
  VALIDATION_ERROR = 'VALIDATION_ERROR',
  UNAUTHORIZED = 'UNAUTHORIZED',
  FORBIDDEN = 'FORBIDDEN',
  CONVERSATION_NOT_FOUND = 'CONVERSATION_NOT_FOUND',
  MESSAGE_NOT_FOUND = 'MESSAGE_NOT_FOUND',
  USER_NOT_PARTICIPANT = 'USER_NOT_PARTICIPANT',
  MODERATION_BLOCKED = 'MODERATION_BLOCKED',
  MODERATION_BUSY = 'MODERATION_BUSY',
  MODERATION_UNAVAILABLE = 'MODERATION_UNAVAILABLE',
  RATE_LIMITED = 'RATE_LIMITED',
  DATABASE_ERROR = 'DATABASE_ERROR',
  SOCKET_ERROR = 'SOCKET_ERROR',
  FILE_TOO_LARGE = 'FILE_TOO_LARGE',
  INVALID_FILE_TYPE = 'INVALID_FILE_TYPE',
  INTERNAL_ERROR = 'INTERNAL_ERROR',
}

export const HTTP_STATUS_MAP: Record<ErrorCode, number> = {
  [ErrorCode.VALIDATION_ERROR]: 400,
  [ErrorCode.UNAUTHORIZED]: 401,
  [ErrorCode.FORBIDDEN]: 403,
  [ErrorCode.CONVERSATION_NOT_FOUND]: 404,
  [ErrorCode.MESSAGE_NOT_FOUND]: 404,
  [ErrorCode.USER_NOT_PARTICIPANT]: 403,
  [ErrorCode.MODERATION_BLOCKED]: 403,
  [ErrorCode.MODERATION_BUSY]: 429,
  [ErrorCode.MODERATION_UNAVAILABLE]: 503,
  [ErrorCode.RATE_LIMITED]: 429,
  [ErrorCode.DATABASE_ERROR]: 500,
  [ErrorCode.SOCKET_ERROR]: 500,
  [ErrorCode.FILE_TOO_LARGE]: 413,
  [ErrorCode.INVALID_FILE_TYPE]: 415,
  [ErrorCode.INTERNAL_ERROR]: 500,
};

export class ChatError extends Error {
  public readonly code: ErrorCode;
  public readonly statusCode: number;
  public readonly details?: Record<string, unknown>;
  public readonly timestamp: Date;

  constructor(code: ErrorCode, message: string, details?: Record<string, unknown>) {
    super(message);
    this.name = 'ChatError';
    this.code = code;
    this.statusCode = HTTP_STATUS_MAP[code];
    this.details = details;
    this.timestamp = new Date();

    // Maintains proper stack trace for where error was thrown
    Error.captureStackTrace(this, this.constructor);
  }

  toJSON(): {
    code: ErrorCode;
    message: string;
    statusCode: number;
    details?: Record<string, unknown>;
    timestamp: Date;
  } {
    return {
      code: this.code,
      message: this.message,
      statusCode: this.statusCode,
      details: this.details,
      timestamp: this.timestamp,
    };
  }

  static fromCode(code: ErrorCode, details?: Record<string, unknown>): ChatError {
    const defaultMessages: Record<ErrorCode, string> = {
      [ErrorCode.VALIDATION_ERROR]: 'Validation failed',
      [ErrorCode.UNAUTHORIZED]: 'Authentication required',
      [ErrorCode.FORBIDDEN]: 'Access forbidden',
      [ErrorCode.CONVERSATION_NOT_FOUND]: 'Conversation not found',
      [ErrorCode.MESSAGE_NOT_FOUND]: 'Message not found',
      [ErrorCode.USER_NOT_PARTICIPANT]: 'User is not a participant in this conversation',
      [ErrorCode.MODERATION_BLOCKED]: MODERATION_BLOCKED_MESSAGE,
      [ErrorCode.MODERATION_BUSY]: MODERATION_BUSY_MESSAGE,
      [ErrorCode.MODERATION_UNAVAILABLE]: MODERATION_UNAVAILABLE_MESSAGE,
      [ErrorCode.RATE_LIMITED]: 'Rate limit exceeded',
      [ErrorCode.DATABASE_ERROR]: 'Database operation failed',
      [ErrorCode.SOCKET_ERROR]: 'Socket connection error',
      [ErrorCode.FILE_TOO_LARGE]: 'File size exceeds limit',
      [ErrorCode.INVALID_FILE_TYPE]: 'Invalid file type',
      [ErrorCode.INTERNAL_ERROR]: 'Internal server error',
    };

    return new ChatError(code, defaultMessages[code], details);
  }

  // Static factory methods
  static validation(message: string, details?: Record<string, unknown>): ChatError {
    return new ChatError(ErrorCode.VALIDATION_ERROR, message, details);
  }

  static unauthorized(message: string = 'Authentication required'): ChatError {
    return new ChatError(ErrorCode.UNAUTHORIZED, message);
  }

  static forbidden(message: string = 'Access forbidden'): ChatError {
    return new ChatError(ErrorCode.FORBIDDEN, message);
  }

  static notFound(resource: string): ChatError {
    return new ChatError(
      resource === 'conversation' ? ErrorCode.CONVERSATION_NOT_FOUND : ErrorCode.MESSAGE_NOT_FOUND,
      `${resource.charAt(0).toUpperCase() + resource.slice(1)} not found`
    );
  }

  static userNotParticipant(): ChatError {
    return new ChatError(
      ErrorCode.USER_NOT_PARTICIPANT,
      'User is not a participant in this conversation'
    );
  }

  static moderationBlocked(flags: string[], message: string = MODERATION_BLOCKED_MESSAGE): ChatError {
    return new ChatError(ErrorCode.MODERATION_BLOCKED, message, { flags });
  }

  /** The sender's moderation critical section is held by a concurrent send; retry with the same clientMessageId. */
  static moderationBusy(): ChatError {
    return new ChatError(ErrorCode.MODERATION_BUSY, MODERATION_BUSY_MESSAGE, { retryAfter: 2 });
  }

  /** Shared moderation state is unreachable: a message that could be a contact fragment is refused until it is back. */
  static moderationUnavailable(): ChatError {
    return new ChatError(ErrorCode.MODERATION_UNAVAILABLE, MODERATION_UNAVAILABLE_MESSAGE, { retryAfter: 60 });
  }

  static rateLimited(retryAfter?: number): ChatError {
    return new ChatError(ErrorCode.RATE_LIMITED, 'Rate limit exceeded', {
      retryAfter: retryAfter || 60,
    });
  }

  static database(message: string): ChatError {
    return new ChatError(ErrorCode.DATABASE_ERROR, message);
  }

  static internal(message: string = 'Internal server error'): ChatError {
    return new ChatError(ErrorCode.INTERNAL_ERROR, message);
  }
}

// Type guard
export function isChatError(error: unknown): error is ChatError {
  return error instanceof ChatError;
}
