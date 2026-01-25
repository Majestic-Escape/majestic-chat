import mongoose, { Schema, Document } from 'mongoose';
import { Conversation, ConversationStatus, ParticipantRole } from '../types/chat.types';

export interface IConversationDocument extends Omit<Conversation, 'id'>, Document {
  _id: mongoose.Types.ObjectId;
}

const ConversationSchema = new Schema<IConversationDocument>(
  {
    propertyId: {
      type: String,
      required: true,
      index: true,
    },
    bookingId: {
      type: String,
      sparse: true,
    },
    participants: [
      {
        userId: { type: String, required: true },
        role: {
          type: String,
          enum: Object.values(ParticipantRole),
          required: true,
        },
        firstName: { type: String },
        lastName: { type: String },
        joinedAt: { type: Date, required: true, default: Date.now },
      },
    ],
    lastMessage: {
      content: { type: String },
      senderId: { type: String },
      sentAt: { type: Date },
    },
    unreadCount: {
      type: Map,
      of: Number,
      default: {},
    },
    status: {
      type: String,
      enum: Object.values(ConversationStatus),
      required: true,
      default: ConversationStatus.ACTIVE,
    },
  },
  {
    timestamps: true,
    collection: 'conversations',
    toJSON: {
      virtuals: true,
      transform: (_doc, ret: any) => {
        ret.id = ret._id.toString();
        delete ret._id;
        delete ret.__v;
        // Convert Map to plain object
        if (ret.unreadCount instanceof Map) {
          ret.unreadCount = Object.fromEntries(ret.unreadCount);
        }
        return ret;
      },
    },
    toObject: {
      virtuals: true,
      transform: (_doc, ret: any) => {
        ret.id = ret._id.toString();
        delete ret._id;
        delete ret.__v;
        // Convert Map to plain object
        if (ret.unreadCount instanceof Map) {
          ret.unreadCount = Object.fromEntries(ret.unreadCount);
        }
        return ret;
      },
    },
  }
);

// Indexes
ConversationSchema.index({ 'participants.userId': 1, updatedAt: -1 }); // User's conversations
ConversationSchema.index({ propertyId: 1, status: 1 }); // Property conversations
ConversationSchema.index({ bookingId: 1 }, { sparse: true }); // Booking lookup

// Export model (handle serverless environments)
export const ConversationModel =
  (mongoose.models.Conversation as mongoose.Model<IConversationDocument>) ||
  mongoose.model<IConversationDocument>('Conversation', ConversationSchema);

export { ConversationSchema };
