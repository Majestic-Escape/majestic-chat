import mongoose, { Schema, Document } from 'mongoose';
import {
  Message,
  MessageType,
  MessageStatus,
  ModerationStatus,
} from '../types/chat.types';
import { CHAT_CONFIG } from '../constants/config';

export interface IMessageDocument extends Omit<Message, 'id'>, Document {
  _id: mongoose.Types.ObjectId;
}

const MessageSchema = new Schema<IMessageDocument>(
  {
    conversationId: {
      type: String,
      required: true,
      index: true,
    },
    senderId: {
      type: String,
      required: true,
      index: true,
    },
    clientMessageId: {
      type: String,
      required: true,
    },
    type: {
      type: String,
      enum: Object.values(MessageType),
      required: true,
      default: MessageType.TEXT,
    },
    content: {
      text: {
        type: String,
      },
      attachments: [
        {
          id: { type: String, required: true },
          url: { type: String, required: true },
          type: { type: String, enum: ['image', 'document'], required: true },
          filename: { type: String, required: true },
          size: { type: Number, required: true },
          mimeType: { type: String, required: true },
          thumbnailUrl: { type: String },
        },
      ],
    },
    moderation: {
      status: {
        type: String,
        enum: Object.values(ModerationStatus),
        required: true,
        default: ModerationStatus.CLEAN,
      },
      flags: {
        type: [String],
        default: [],
      },
      confidence: {
        type: Number,
        required: true,
        default: 0,
        min: 0,
        max: 1,
      },
      version: { type: Number },
      fragment: { type: Boolean },
      originalContent: {
        type: String,
      },
    },
    readBy: [
      {
        userId: { type: String, required: true },
        readAt: { type: Date, required: true },
      },
    ],
    status: {
      type: String,
      enum: Object.values(MessageStatus),
      required: true,
      default: MessageStatus.SENT,
    },
    deletedAt: {
      type: Date,
    },
    // Server-derived snapshot of the quoted message (see ReplyRefSchema).
    // Nested path, not a sub-schema: no _id, absent on plain messages.
    replyTo: {
      messageId: { type: String },
      senderId: { type: String },
      text: { type: String, maxlength: CHAT_CONFIG.REPLY_SNIPPET_MAX },
      type: { type: String, enum: Object.values(MessageType) },
    },
  },
  {
    timestamps: true,
    collection: 'messages',
    toJSON: {
      virtuals: true,
      transform: (_doc, ret: any) => {
        ret.id = ret._id.toString();
        delete ret._id;
        delete ret.__v;
        return ret;
      },
    },
    toObject: {
      virtuals: true,
      transform: (_doc, ret: any) => {
        ret.id = ret._id.toString();
        delete ret._id;
        delete ret.__v;
        return ret;
      },
    },
  }
);

// Indexes
// Message loading + cursor pagination: sorted by (createdAt, _id) so ties in
// createdAt have a deterministic order the index can serve without a blocking
// sort. (The older { conversationId, createdAt } index remains on existing
// deployments until dropped by hand; it is a strict prefix of this one.)
MessageSchema.index({ conversationId: 1, createdAt: -1, _id: -1 }); // Message loading
MessageSchema.index({ conversationId: 1, clientMessageId: 1 }, { unique: true }); // Idempotency
MessageSchema.index({ senderId: 1, createdAt: -1 }); // User history
// Moderation context (contact lock-down): the sender's rows of one conversation, newest first —
// exact index bounds, no in-memory sort, for the two queries every send issues
MessageSchema.index({ conversationId: 1, senderId: 1, createdAt: -1, _id: -1 });
MessageSchema.index({ 'moderation.status': 1, createdAt: -1 }); // Moderation queue

// Export model (handle serverless environments)
export const MessageModel =
  (mongoose.models.Message as mongoose.Model<IMessageDocument>) ||
  mongoose.model<IMessageDocument>('Message', MessageSchema);

export { MessageSchema };
