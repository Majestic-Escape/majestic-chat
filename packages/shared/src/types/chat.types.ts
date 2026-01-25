import { z } from 'zod';

// Enums
export enum MessageType {
  TEXT = 'text',
  IMAGE = 'image',
  FILE = 'file',
  SYSTEM = 'system',
}

export enum MessageStatus {
  SENDING = 'sending',
  SENT = 'sent',
  DELIVERED = 'delivered',
  READ = 'read',
  FAILED = 'failed',
}

export enum ModerationStatus {
  CLEAN = 'clean',
  FLAGGED = 'flagged',
  BLOCKED = 'blocked',
}

export enum ParticipantRole {
  HOST = 'host',
  GUEST = 'guest',
}

export enum ConversationStatus {
  ACTIVE = 'active',
  ARCHIVED = 'archived',
  BLOCKED = 'blocked',
}

// Zod Schemas
export const MessageTypeSchema = z.enum(['text', 'image', 'file', 'system']);
export const MessageStatusSchema = z.enum(['sending', 'sent', 'delivered', 'read', 'failed']);
export const ModerationStatusSchema = z.enum(['clean', 'flagged', 'blocked']);
export const ParticipantRoleSchema = z.enum(['host', 'guest']);
export const ConversationStatusSchema = z.enum(['active', 'archived', 'blocked']);

// Attachment
export const AttachmentSchema = z.object({
  id: z.string(),
  url: z.string().url(),
  type: z.enum(['image', 'document']),
  filename: z.string(),
  size: z.number().positive(),
  mimeType: z.string(),
  thumbnailUrl: z.string().url().optional(),
});

export type Attachment = z.infer<typeof AttachmentSchema>;

// MessageContent
export const MessageContentSchema = z.object({
  text: z.string().optional(),
  attachments: z.array(AttachmentSchema).optional(),
});

export type MessageContent = z.infer<typeof MessageContentSchema>;

// ModerationResult
export const ModerationResultSchema = z.object({
  status: ModerationStatusSchema,
  flags: z.array(z.string()),
  confidence: z.number().min(0).max(1),
  originalContent: z.string().optional(),
});

export type ModerationResult = z.infer<typeof ModerationResultSchema>;

// ReadReceipt
export const ReadReceiptSchema = z.object({
  userId: z.string(),
  readAt: z.coerce.date(),
});

export type ReadReceipt = z.infer<typeof ReadReceiptSchema>;

// Participant
export const ParticipantSchema = z.object({
  userId: z.string(),
  role: ParticipantRoleSchema,
  firstName: z.string().optional(),
  lastName: z.string().optional(),
  joinedAt: z.coerce.date(),
});

export type Participant = z.infer<typeof ParticipantSchema>;

// LastMessage
export const LastMessageSchema = z.object({
  content: z.string(),
  senderId: z.string(),
  sentAt: z.coerce.date(),
});

export type LastMessage = z.infer<typeof LastMessageSchema>;

// Message
export const MessageSchema = z.object({
  id: z.string(),
  conversationId: z.string(),
  senderId: z.string(),
  clientMessageId: z.string(),
  type: MessageTypeSchema,
  content: MessageContentSchema,
  moderation: ModerationResultSchema,
  readBy: z.array(ReadReceiptSchema),
  status: MessageStatusSchema,
  createdAt: z.coerce.date(),
  updatedAt: z.coerce.date(),
  deletedAt: z.coerce.date().optional(),
});

export type Message = z.infer<typeof MessageSchema>;

// Conversation
export const ConversationSchema = z.object({
  id: z.string(),
  propertyId: z.string(),
  bookingId: z.string().optional(),
  participants: z.array(ParticipantSchema),
  lastMessage: LastMessageSchema.optional(),
  unreadCount: z.record(z.string(), z.number()),
  status: ConversationStatusSchema,
  createdAt: z.coerce.date(),
  updatedAt: z.coerce.date(),
});

export type Conversation = z.infer<typeof ConversationSchema>;

// SendMessageParams
export const SendMessageParamsSchema = z.object({
  conversationId: z.string(),
  senderId: z.string(),
  content: MessageContentSchema,
  type: MessageTypeSchema,
  clientMessageId: z.string(),
});

export type SendMessageParams = z.infer<typeof SendMessageParamsSchema>;

// PaginationOptions
export const PaginationOptionsSchema = z.object({
  limit: z.number().min(1).max(100).default(50),
  cursor: z.string().optional(),
  direction: z.enum(['before', 'after']),
});

export type PaginationOptions = z.infer<typeof PaginationOptionsSchema>;

// PaginatedResult
export const PaginatedResultSchema = <T extends z.ZodTypeAny>(dataSchema: T) =>
  z.object({
    data: z.array(dataSchema),
    nextCursor: z.string().optional(),
    hasMore: z.boolean(),
  });

export type PaginatedResult<T> = {
  data: T[];
  nextCursor?: string;
  hasMore: boolean;
};
