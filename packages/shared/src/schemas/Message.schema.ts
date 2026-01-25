import mongoose, { Schema, Document } from 'mongoose';
import {
  Message,
  MessageType,
  MessageStatus,
  ModerationStatus,
} from '../types/chat.types';

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
MessageSchema.index({ conversationId: 1, createdAt: -1 }); // Message loading
MessageSchema.index({ conversationId: 1, clientMessageId: 1 }, { unique: true }); // Idempotency
MessageSchema.index({ senderId: 1, createdAt: -1 }); // User history
MessageSchema.index({ 'moderation.status': 1, createdAt: -1 }); // Moderation queue

// Export model (handle serverless environments)
export const MessageModel =
  (mongoose.models.Message as mongoose.Model<IMessageDocument>) ||
  mongoose.model<IMessageDocument>('Message', MessageSchema);

export { MessageSchema };
