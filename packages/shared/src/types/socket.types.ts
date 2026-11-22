import { z } from "zod";
import { Message, MessageContentSchema, MessageTypeSchema, ReplyToInputSchema, OBJECT_ID_RE } from "./chat.types";
import { CHAT_CONFIG } from "../constants/config";

// Every client→server payload is validated against one of these before any
// field is read (a malformed payload must never reach a handler, let alone a
// catch block). Ids are Mongo ObjectIds; arrays and free strings are bounded
// so no event can carry an unbounded amount of work into the server.
const ObjectIdSchema = z.string().regex(OBJECT_ID_RE, { message: "Invalid id" });

// Input types
export const SendMessageInputSchema = z.object({
  conversationId: ObjectIdSchema,
  content: MessageContentSchema,
  type: MessageTypeSchema,
  clientMessageId: z.string().min(1).max(CHAT_CONFIG.MAX_CLIENT_MESSAGE_ID_LENGTH),
  // Only the id: the quoted text/author are resolved server-side (see ReplyRef)
  replyTo: ReplyToInputSchema.optional(),
});

export type SendMessageInput = z.infer<typeof SendMessageInputSchema>;

export const ReadMessagesInputSchema = z.object({
  conversationId: ObjectIdSchema,
  messageIds: z.array(ObjectIdSchema).max(CHAT_CONFIG.MAX_READ_BATCH),
});

export type ReadMessagesInput = z.infer<typeof ReadMessagesInputSchema>;

// conversation:join / conversation:leave / typing:start / typing:stop
export const ConversationRefInputSchema = z.object({
  conversationId: ObjectIdSchema,
});

export type ConversationRefInput = z.infer<typeof ConversationRefInputSchema>;

export const MessageResponseSchema = z.object({
  success: z.boolean(),
  messageId: z.string().optional(),
  error: z.string().optional(),
  // ChatError code on failure (VALIDATION_ERROR, MESSAGE_NOT_FOUND, RATE_LIMITED,
  // INTERNAL_ERROR, ...). Lets a client tell a definitive rejection ("nothing
  // was stored") from an ambiguous failure it must retry with the same
  // clientMessageId.
  code: z.string().optional(),
});

export type MessageResponse = z.infer<typeof MessageResponseSchema>;

// Socket.io Event Interfaces
export interface ClientToServerEvents {
  "message:send": (
    data: SendMessageInput,
    callback: (response: MessageResponse) => void,
  ) => void;
  "message:read": (data: ReadMessagesInput) => void;
  "conversation:join": (data: { conversationId: string }) => void;
  "conversation:leave": (data: { conversationId: string }) => void;
  "typing:start": (data: { conversationId: string }) => void;
  "typing:stop": (data: { conversationId: string }) => void;
}

export interface ServerToClientEvents {
  "message:new": (data: { message: Message; conversationId: string }) => void;
  "message:sent": (data: {
    messageId: string;
    clientMessageId: string;
  }) => void;
  "message:delivered": (data: {
    messageId: string;
    userId: string;
    timestamp: Date;
  }) => void;
  "message:read": (data: {
    conversationId: string;
    messageIds: string[];
    userId: string;
    timestamp: Date;
  }) => void;
  "typing:update": (data: {
    conversationId: string;
    userId: string;
    isTyping: boolean;
  }) => void;
  "user:online": (data: { userId: string }) => void;
  "user:offline": (data: { userId: string }) => void;
  // conversationId (additive): the conversation whose change produced this
  // total, so a client can refresh/join a conversation it has not seen yet.
  "unread:update": (data: { userId: string; totalUnread: number; role: string; conversationId?: string }) => void;
  error: (data: { code: string; message: string }) => void;
  // Sent just before the server drops a socket because an admin switched
  // messaging off; clients must hide messaging and not reconnect.
  "messaging:disabled": () => void;
}

export interface InterServerEvents {
  ping: () => void;
}

export interface SocketData {
  user: {
    id: string;
    firstName: string;
    role?: string;
  };
  joinedRooms: Set<string>;
}
