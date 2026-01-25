import React from 'react';
import { Message } from '@majestic/chat-shared';

export interface MessageBubbleProps {
  message: Message;
  currentUserId: string;
  showSender?: boolean;
  className?: string;
}

export function MessageBubble({
  message,
  currentUserId,
  showSender = true,
  className = '',
}: MessageBubbleProps) {
  const isOwnMessage = message.senderId === currentUserId;
  const isRead = message.readBy.length > 1; // More than just sender

  return (
    <div
      className={`message-bubble ${isOwnMessage ? 'message-bubble--own' : 'message-bubble--other'} ${className}`}
      data-message-id={message.id}
    >
      {showSender && !isOwnMessage && (
        <div className="message-bubble__sender">{message.senderId}</div>
      )}
      
      <div className="message-bubble__content">
        {message.content.text && (
          <div className="message-bubble__text">{message.content.text}</div>
        )}
        
        {message.content.attachments && message.content.attachments.length > 0 && (
          <div className="message-bubble__attachments">
            {message.content.attachments.map((attachment) => (
              <div key={attachment.id} className="message-bubble__attachment">
                {attachment.type === 'image' ? (
                  <img
                    src={attachment.url}
                    alt={attachment.filename}
                    className="message-bubble__image"
                  />
                ) : (
                  <a
                    href={attachment.url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="message-bubble__file"
                  >
                    {attachment.filename}
                  </a>
                )}
              </div>
            ))}
          </div>
        )}
      </div>

      <div className="message-bubble__meta">
        <span className="message-bubble__time">
          {new Date(message.createdAt).toLocaleTimeString([], {
            hour: '2-digit',
            minute: '2-digit',
          })}
        </span>
        {isOwnMessage && (
          <span
            className={`message-bubble__status message-bubble__status--${message.status}`}
            aria-label={`Message ${message.status}`}
          >
            {isRead ? '✓✓' : '✓'}
          </span>
        )}
      </div>

      {message.moderation.status !== 'clean' && (
        <div className="message-bubble__warning" role="alert">
          ⚠️ This message was flagged by our moderation system
        </div>
      )}
    </div>
  );
}
