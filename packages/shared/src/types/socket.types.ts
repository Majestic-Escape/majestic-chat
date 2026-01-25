import { z } from "zod";
import { Message, MessageContentSchema, MessageTypeSchema } from "./chat.types";

// Input types
export const SendMessageInputSchema = z.object({
  conversationId: z.string(),
  content: MessageContentSchema,
  type: MessageTypeSchema,
  clientMessageId: z.string(),
});

export type SendMessageInput = z.infer<typeof SendMessageInputSchema>;

export const ReadMessagesInputSchema = z.object({
  conversationId: z.string(),
  messageIds: z.array(z.string()),
});

export type ReadMessagesInput = z.infer<typeof ReadMessagesInputSchema>;

export const MessageResponseSchema = z.object({
  success: z.boolean(),
  messageId: z.string().optional(),
  error: z.string().optional(),
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
  error: (data: { code: string; message: string }) => void;
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
