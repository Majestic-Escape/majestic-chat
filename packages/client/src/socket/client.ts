import { io, Socket } from 'socket.io-client';
import {
  ClientToServerEvents,
  ServerToClientEvents,
  SOCKET_EVENTS,
  SendMessageInput,
  MessageResponse,
} from '@majestic/chat-shared';

export type ChatSocket = Socket<ServerToClientEvents, ClientToServerEvents>;

export type ConnectionState = 'connecting' | 'connected' | 'disconnected' | 'error';

export interface ChatClientOptions {
  url: string;
  token: string;
  onConnectionChange?: (state: ConnectionState) => void;
  onError?: (error: { code: string; message: string }) => void;
}

export class ChatClient {
  private socket: ChatSocket | null = null;
  private options: ChatClientOptions;
  public connectionState: ConnectionState = 'disconnected';

  constructor(options: ChatClientOptions) {
    this.options = options;
  }

  connect(): void {
    if (this.socket?.connected) {
      return;
    }

    this.updateConnectionState('connecting');

    this.socket = io(this.options.url, {
      auth: {
        token: this.options.token,
      },
      reconnection: true,
      reconnectionDelay: 1000,
      reconnectionDelayMax: 5000,
      reconnectionAttempts: 5,
    }) as ChatSocket;

    // Connection event handlers
    this.socket.on('connect', () => {
      this.updateConnectionState('connected');
    });

    this.socket.on('disconnect', (reason) => {
      console.log('Socket disconnected:', reason);
      this.updateConnectionState('disconnected');
    });

    this.socket.on('connect_error', (error) => {
      console.error('Socket connection error:', error);
      this.updateConnectionState('error');
    });

    // Error event handler
    this.socket.on(SOCKET_EVENTS.ERROR, (error) => {
      console.error('Chat error:', error);
      this.options.onError?.(error);
    });
  }

  disconnect(): void {
    if (this.socket) {
      this.socket.disconnect();
      this.socket = null;
      this.updateConnectionState('disconnected');
    }
  }

  joinConversation(conversationId: string): void {
    if (!this.socket) {
      throw new Error('Socket not connected');
    }
    this.socket.emit(SOCKET_EVENTS.CONVERSATION_JOIN, { conversationId });
  }

  leaveConversation(conversationId: string): void {
    if (!this.socket) {
      throw new Error('Socket not connected');
    }
    this.socket.emit(SOCKET_EVENTS.CONVERSATION_LEAVE, { conversationId });
  }

  sendMessage(data: SendMessageInput): Promise<MessageResponse> {
    return new Promise((resolve, reject) => {
      if (!this.socket) {
        reject(new Error('Socket not connected'));
        return;
      }

      this.socket.emit(SOCKET_EVENTS.MESSAGE_SEND, data, (response: MessageResponse) => {
        if (response.success) {
          resolve(response);
        } else {
          reject(new Error(response.error || 'Failed to send message'));
        }
      });
    });
  }

  markAsRead(conversationId: string, messageIds: string[]): void {
    if (!this.socket) {
      throw new Error('Socket not connected');
    }
    this.socket.emit(SOCKET_EVENTS.MESSAGE_READ, { conversationId, messageIds });
  }

  startTyping(conversationId: string): void {
    if (!this.socket) {
      return;
    }
    this.socket.emit(SOCKET_EVENTS.TYPING_START, { conversationId });
  }

  stopTyping(conversationId: string): void {
    if (!this.socket) {
      return;
    }
    this.socket.emit(SOCKET_EVENTS.TYPING_STOP, { conversationId });
  }

  on<E extends keyof ServerToClientEvents>(event: E, handler: ServerToClientEvents[E]): void {
    if (!this.socket) {
      throw new Error('Socket not connected');
    }
    this.socket.on(event, handler as any);
  }

  off<E extends keyof ServerToClientEvents>(event: E, handler: ServerToClientEvents[E]): void {
    if (!this.socket) {
      return;
    }
    this.socket.off(event, handler as any);
  }

  getSocket(): ChatSocket | null {
    return this.socket;
  }

  private updateConnectionState(state: ConnectionState): void {
    this.connectionState = state;
    this.options.onConnectionChange?.(state);
  }
}
