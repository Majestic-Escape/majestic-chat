import React from 'react';
import { useChat } from '../hooks/useChat';
import { MessageList } from './MessageList';
import { MessageInput } from './MessageInput';
import { TypingIndicator } from './TypingIndicator';

export interface ChatWindowProps {
  conversationId: string;
  currentUserId: string;
  className?: string;
  onBack?: () => void;
  header?: React.ReactNode;
}

export function ChatWindow({
  conversationId,
  currentUserId,
  className = '',
  onBack,
  header,
}: ChatWindowProps) {
  const {
    messages,
    isLoading,
    error,
    hasMore,
    sendMessage,
    loadMore,
    typingUsers,
    startTyping,
    stopTyping,
  } = useChat({ conversationId });

  const handleSendMessage = async (text: string) => {
    try {
      await sendMessage(text);
    } catch (err) {
      console.error('Failed to send message:', err);
    }
  };

  return (
    <div className={`chat-window ${className}`}>
      {/* Header */}
      <div className="chat-window__header">
        {onBack && (
          <button
            onClick={onBack}
            className="chat-window__back-button"
            aria-label="Go back"
          >
            ← Back
          </button>
        )}
        {header || <div className="chat-window__title">Chat</div>}
      </div>

      {/* Error message */}
      {error && (
        <div className="chat-window__error" role="alert">
          {error}
        </div>
      )}

      {/* Messages */}
      <div className="chat-window__messages">
        <MessageList
          messages={messages}
          currentUserId={currentUserId}
          isLoading={isLoading}
          hasMore={hasMore}
          onLoadMore={loadMore}
        />
      </div>

      {/* Typing indicator */}
      {typingUsers.size > 0 && (
        <div className="chat-window__typing">
          <TypingIndicator userIds={Array.from(typingUsers)} />
        </div>
      )}

      {/* Input */}
      <div className="chat-window__input">
        <MessageInput
          onSend={handleSendMessage}
          onTypingStart={startTyping}
          onTypingStop={stopTyping}
          disabled={isLoading}
        />
      </div>
    </div>
  );
}
