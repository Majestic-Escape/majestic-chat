import React from 'react';

export interface TypingIndicatorProps {
  userIds: string[];
  className?: string;
}

export function TypingIndicator({ userIds, className = '' }: TypingIndicatorProps) {
  if (userIds.length === 0) {
    return null;
  }

  const getText = () => {
    if (userIds.length === 1) {
      return 'Someone is typing...';
    }
    if (userIds.length === 2) {
      return '2 people are typing...';
    }
    return `${userIds.length} people are typing...`;
  };

  return (
    <div className={`typing-indicator ${className}`} role="status" aria-live="polite">
      <span className="typing-indicator__text">{getText()}</span>
      <span className="typing-indicator__dots">
        <span className="typing-indicator__dot">.</span>
        <span className="typing-indicator__dot">.</span>
        <span className="typing-indicator__dot">.</span>
      </span>
    </div>
  );
}
