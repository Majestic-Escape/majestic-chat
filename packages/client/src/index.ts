// Socket client
export { ChatClient, ChatSocket, ConnectionState, ChatClientOptions } from './socket/client';

// Context
export { ChatProvider, useChatContext, useChatClient, ChatContextValue, ChatProviderProps } from './context/ChatContext';

// Hooks
export { useChat, UseChatOptions, UseChatReturn } from './hooks/useChat';
export { useConversations, UseConversationsReturn } from './hooks/useConversations';
export { usePageVisibility } from './hooks/usePageVisibility';

// Components
export { ChatWindow, ChatWindowProps } from './components/ChatWindow';
export { MessageList, MessageListProps } from './components/MessageList';
export { MessageBubble, MessageBubbleProps } from './components/MessageBubble';
export { MessageInput, MessageInputProps } from './components/MessageInput';
export { TypingIndicator, TypingIndicatorProps } from './components/TypingIndicator';

// Re-export shared types for convenience
export type {
  Message,
  Conversation,
  MessageContent,
  MessageType,
  MessageStatus,
  Participant,
  ParticipantRole,
  ConversationStatus,
  Attachment,
  ReadReceipt,
  LastMessage,
  PaginationOptions,
  PaginatedResult,
} from '@majestic/chat-shared';

