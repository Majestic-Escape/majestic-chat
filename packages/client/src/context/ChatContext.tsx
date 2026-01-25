import React, { createContext, useContext, useEffect, useState, useMemo } from 'react';
import { ChatClient, ConnectionState } from '../socket/client';

export interface ChatContextValue {
  client: ChatClient | null;
  connectionState: ConnectionState;
  isConnected: boolean;
  error: string | null;
}

const ChatContext = createContext<ChatContextValue | null>(null);

export interface ChatProviderProps {
  children: React.ReactNode;
  socketUrl: string;
  token: string;
  onError?: (error: { code: string; message: string }) => void;
}

export function ChatProvider({ children, socketUrl, token, onError }: ChatProviderProps) {
  const [client, setClient] = useState<ChatClient | null>(null);
  const [connectionState, setConnectionState] = useState<ConnectionState>('disconnected');
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    // Create client instance
    const chatClient = new ChatClient({
      url: socketUrl,
      token,
      onConnectionChange: (state) => {
        setConnectionState(state);
        if (state === 'error') {
          setError('Connection error');
        } else {
          setError(null);
        }
      },
      onError: (err) => {
        setError(err.message);
        onError?.(err);
      },
    });

    setClient(chatClient);

    // Connect
    chatClient.connect();

    // Cleanup on unmount
    return () => {
      chatClient.disconnect();
    };
  }, [socketUrl, token, onError]);

  const value = useMemo<ChatContextValue>(
    () => ({
      client,
      connectionState,
      isConnected: connectionState === 'connected',
      error,
    }),
    [client, connectionState, error]
  );

  return <ChatContext.Provider value={value}>{children}</ChatContext.Provider>;
}

export function useChatContext(): ChatContextValue {
  const context = useContext(ChatContext);
  if (!context) {
    throw new Error('useChatContext must be used within ChatProvider');
  }
  return context;
}

export function useChatClient(): ChatClient {
  const { client } = useChatContext();
  if (!client) {
    throw new Error('Chat client not initialized');
  }
  return client;
}
