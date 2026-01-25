import React, { useEffect, useRef } from 'react';
import { Message } from '@majestic/chat-shared';
import { MessageBubble } from './MessageBubble';

export interface MessageListProps {
  messages: Message[];
  currentUserId: string;
  isLoading?: boolean;
  hasMore?: boolean;
  onLoadMore?: () => void;
  className?: string;
}

export function MessageList({
  messages,
  currentUserId,
  isLoading = false,
  hasMore = false,
  onLoadMore,
  className = '',
}: MessageListProps) {
  const listRef = useRef<HTMLDivElement>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  const prevMessagesLengthRef = useRef(messages.length);

  // Auto-scroll to bottom on new messages
  useEffect(() => {
    if (messages.length > prevMessagesLengthRef.current) {
      bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
    }
    prevMessagesLengthRef.current = messages.length;
  }, [messages.length]);

  // Handle scroll for loading more
  const handleScroll = () => {
    if (!listRef.current || !hasMore || isLoading) {
      return;
    }

    const { scrollTop } = listRef.current;
    if (scrollTop < 100) {
      onLoadMore?.();
    }
  };

  if (messages.length === 0 && !isLoading) {
    return (
      <div className={`message-list message-list--empty ${className}`}>
        <div className="message-list__empty-state">No messages yet. Start the conversation!</div>
      </div>
    );
  }

  return (
    <div
      ref={listRef}
      onScroll={handleScroll}
      className={`message-list ${className}`}
      role="log"
      aria-label="Message list"
    >
      {isLoading && hasMore && (
        <div className="message-list__loader" role="status" aria-live="polite">
          Loading more messages...
        </div>
      )}

      {messages.map((message, index) => {
        const prevMessage = index > 0 ? messages[index - 1] : null;
        const showSender = !prevMessage || prevMessage.senderId !== message.senderId;

        return (
          <MessageBubble
            key={message.id}
            message={message}
            currentUserId={currentUserId}
            showSender={showSender}
          />
        );
      })}

      <div ref={bottomRef} />
    </div>
  );
}
