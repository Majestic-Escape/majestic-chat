import { useState, useEffect, useCallback, useRef } from 'react';
import {
  Message,
  SOCKET_EVENTS,
  MessageType,
  SendMessageInput,
} from '@majestic/chat-shared';
import { useChatClient, useChatContext } from '../context/ChatContext';

export interface UseChatOptions {
  conversationId: string;
  apiUrl?: string;
  onNewMessage?: (message: Message) => void;
  onMessageRead?: (data: { messageIds: string[]; userId: string }) => void;
}

export interface UseChatReturn {
  messages: Message[];
  isLoading: boolean;
  error: string | null;
  hasMore: boolean;
  sendMessage: (text: string, clientMessageId?: string) => Promise<void>;
  loadMore: () => Promise<void>;
  markAsRead: (messageIds: string[]) => void;
  typingUsers: Set<string>;
  startTyping: () => void;
  stopTyping: () => void;
}

export function useChat({ conversationId, apiUrl, onNewMessage, onMessageRead }: UseChatOptions): UseChatReturn {
  const client = useChatClient();
  const [messages, setMessages] = useState<Message[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [hasMore, setHasMore] = useState(true);
  const [typingUsers, setTypingUsers] = useState<Set<string>>(new Set());
  const typingTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const cursorRef = useRef<string | undefined>(undefined);

  // Join conversation on mount
  useEffect(() => {
    client.joinConversation(conversationId);

    return () => {
      client.leaveConversation(conversationId);
    };
  }, [client, conversationId]);

  // Load initial messages
  useEffect(() => {
    async function loadInitialMessages() {
      setIsLoading(true);
      setError(null);
      
      try {
        // Get token from localStorage (same as user.website)
        const token = typeof window !== 'undefined' ? localStorage.getItem('token') : null;
        if (!token) {
          setError('Not authenticated');
          setIsLoading(false);
          return;
        }

        const baseUrl = apiUrl || (typeof window !== 'undefined' ? window.location.origin : '');
        const chatUrl = baseUrl.includes('localhost:3000') 
          ? 'http://localhost:3001' 
          : baseUrl;
        
        const response = await fetch(
          `${chatUrl}/api/chat/conversations/${conversationId}/messages?limit=50`,
          {
            headers: {
              Authorization: `Bearer ${token}`,
            },
          }
        );

        if (!response.ok) {
          throw new Error('Failed to load messages');
        }

        const data = await response.json();
        if (data.success && data.data) {
          // Handle paginated response: { data: messages[], hasMore, nextCursor }
          const loadedMessages = data.data.data || data.data;
          setMessages(Array.isArray(loadedMessages) ? loadedMessages : []);
          setHasMore(data.data.hasMore || false);
          cursorRef.current = data.data.nextCursor;
        }
      } catch (err) {
        console.error('Failed to load messages:', err);
        setError(err instanceof Error ? err.message : 'Failed to load messages');
      } finally {
        setIsLoading(false);
      }
    }

    loadInitialMessages();
  }, [conversationId, apiUrl]);

  // Listen for new messages
  useEffect(() => {
    const handleNewMessage = (data: { message: Message; conversationId: string }) => {
      if (data.conversationId === conversationId) {
        setMessages((prev) => {
          // Avoid duplicates
          if (prev.some((m) => m.id === data.message.id)) {
            return prev;
          }
          const updated = [...prev, data.message];
          onNewMessage?.(data.message);
          return updated;
        });
      }
    };

    const handleMessageRead = (data: {
      conversationId: string;
      messageIds: string[];
      userId: string;
      timestamp: Date;
    }) => {
      if (data.conversationId === conversationId) {
        setMessages((prev) =>
          prev.map((msg) => {
            if (!data.messageIds.includes(msg.id)) {
              return msg;
            }
            // Only add read receipt if user hasn't already read this message
            const alreadyRead = msg.readBy.some((r) => r.userId === data.userId);
            if (alreadyRead) {
              return msg;
            }
            return {
              ...msg,
              readBy: [...msg.readBy, { userId: data.userId, readAt: data.timestamp }],
            };
          })
        );
        onMessageRead?.(data);
      }
    };

    const handleTypingUpdate = (data: { conversationId: string; userId: string; isTyping: boolean }) => {
      if (data.conversationId === conversationId) {
        setTypingUsers((prev) => {
          const updated = new Set(prev);
          if (data.isTyping) {
            updated.add(data.userId);
          } else {
            updated.delete(data.userId);
          }
          return updated;
        });
      }
    };

    client.on(SOCKET_EVENTS.MESSAGE_NEW, handleNewMessage);
    client.on(SOCKET_EVENTS.MESSAGE_READ_ACK, handleMessageRead);
    client.on(SOCKET_EVENTS.TYPING_UPDATE, handleTypingUpdate);

    return () => {
      client.off(SOCKET_EVENTS.MESSAGE_NEW, handleNewMessage);
      client.off(SOCKET_EVENTS.MESSAGE_READ_ACK, handleMessageRead);
      client.off(SOCKET_EVENTS.TYPING_UPDATE, handleTypingUpdate);
    };
  }, [client, conversationId, onNewMessage, onMessageRead]);

  const sendMessage = useCallback(
    async (text: string, clientMessageId?: string) => {
      try {
        setError(null);
        const messageData: SendMessageInput = {
          conversationId,
          content: { text },
          type: MessageType.TEXT,
          clientMessageId: clientMessageId || `${Date.now()}-${Math.random()}`,
        };

        await client.sendMessage(messageData);
      } catch (err) {
        const errorMessage = err instanceof Error ? err.message : 'Failed to send message';
        setError(errorMessage);
        throw err;
      }
    },
    [client, conversationId]
  );

  const loadMore = useCallback(async () => {
    if (isLoading || !hasMore) {
      return;
    }

    setIsLoading(true);
    setError(null);

    try {
      const token = typeof window !== 'undefined' ? localStorage.getItem('token') : null;
      if (!token) {
        setError('Not authenticated');
        return;
      }

      const baseUrl = apiUrl || (typeof window !== 'undefined' ? window.location.origin : '');
      const chatUrl = baseUrl.includes('localhost:3000') 
        ? 'http://localhost:3001' 
        : baseUrl;
      
      const url = new URL(`${chatUrl}/api/chat/conversations/${conversationId}/messages`);
      url.searchParams.set('limit', '50');
      if (cursorRef.current) {
        url.searchParams.set('cursor', cursorRef.current);
      }

      const response = await fetch(url.toString(), {
        headers: {
          Authorization: `Bearer ${token}`,
        },
      });

      if (!response.ok) {
        throw new Error('Failed to load more messages');
      }

      const data = await response.json();
      if (data.success && data.data) {
        // Handle paginated response: { data: messages[], hasMore, nextCursor }
        const loadedMessages = data.data.data || data.data;
        if (Array.isArray(loadedMessages)) {
          setMessages((prev) => [...loadedMessages, ...prev]);
        }
        setHasMore(data.data.hasMore || false);
        cursorRef.current = data.data.nextCursor;
      }
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : 'Failed to load messages';
      setError(errorMessage);
    } finally {
      setIsLoading(false);
    }
  }, [isLoading, hasMore, conversationId, apiUrl]);

  const markAsRead = useCallback(
    (messageIds: string[]) => {
      client.markAsRead(conversationId, messageIds);
    },
    [client, conversationId]
  );

  const startTyping = useCallback(() => {
    client.startTyping(conversationId);

    // Auto-stop typing after 3 seconds
    if (typingTimeoutRef.current) {
      clearTimeout(typingTimeoutRef.current);
    }
    typingTimeoutRef.current = setTimeout(() => {
      client.stopTyping(conversationId);
    }, 3000);
  }, [client, conversationId]);

  const stopTyping = useCallback(() => {
    if (typingTimeoutRef.current) {
      clearTimeout(typingTimeoutRef.current);
      typingTimeoutRef.current = null;
    }
    client.stopTyping(conversationId);
  }, [client, conversationId]);

  return {
    messages,
    isLoading,
    error,
    hasMore,
    sendMessage,
    loadMore,
    markAsRead,
    typingUsers,
    startTyping,
    stopTyping,
  };
}
