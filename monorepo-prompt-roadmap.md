# 🚀 MajesticEscape Chat System - Monorepo Edition

## Complete Prompt Execution Roadmap for GitHub Copilot Agent Mode

> **Architecture:** Separate repo with 3 packages (server, shared, client)
> **Integration:** Plugs into existing user.website and server.me repos
> **Deployment:** Socket.io on Railway, Client SDK as npm package

---

# 📋 TABLE OF CONTENTS

1. [Architecture Overview](#architecture-overview)
2. [Week 1: Foundation](#week-1-foundation)
3. [Week 2: Services & Real-time](#week-2-services--real-time)
4. [Week 3: Client SDK & Integration](#week-3-client-sdk--integration)
5. [Deployment Guide](#deployment-guide)
6. [Integration Guide for Developer](#integration-guide-for-developer)

---

# 🏗️ ARCHITECTURE OVERVIEW

## Repository Structure

```
Majestic-Escape/majestic-chat/          # NEW REPO
│
├── .github/
│   └── copilot-instructions.md         # AI coding rules
│
├── packages/
│   │
│   ├── shared/                         # @majestic/chat-shared
│   │   ├── src/
│   │   │   ├── types/                  # TypeScript types + Zod schemas
│   │   │   ├── schemas/                # MongoDB schemas
│   │   │   ├── errors/                 # ChatError class
│   │   │   ├── moderation/             # Contact detection patterns
│   │   │   ├── constants/              # Event names, config
│   │   │   └── index.ts                # Public exports
│   │   ├── package.json
│   │   └── tsconfig.json
│   │
│   ├── server/                         # @majestic/chat-server
│   │   ├── src/
│   │   │   ├── services/               # ChatService, ModerationService
│   │   │   ├── repositories/           # MessageRepo, ConversationRepo
│   │   │   ├── events/                 # Socket event handlers
│   │   │   ├── middleware/             # Auth, rate limiting
│   │   │   ├── lib/                    # DB connection, Redis
│   │   │   └── index.ts                # Server entry point
│   │   ├── package.json
│   │   ├── tsconfig.json
│   │   └── Dockerfile
│   │
│   └── client/                         # @majestic/chat-client
│       ├── src/
│       │   ├── hooks/                  # useChat, useConversations
│       │   ├── components/             # ChatWindow, MessageList, etc.
│       │   ├── context/                # ChatProvider
│       │   ├── socket/                 # Socket.io client wrapper
│       │   └── index.ts                # Public exports
│       ├── package.json
│       └── tsconfig.json
│
├── package.json                        # Workspace root
├── tsconfig.base.json                  # Shared TS config
├── .env.example                        # Environment template
└── README.md
```

## How It Connects to Existing Repos

```
┌─────────────────────────────────────────────────────────────────────┐
│                        EXISTING SYSTEM                               │
├─────────────────────────────────────────────────────────────────────┤
│                                                                      │
│   user.website                         server.me                     │
│   ┌────────────────────┐              ┌────────────────────┐        │
│   │ Next.js Frontend   │              │ Express Backend    │        │
│   │                    │   REST API   │                    │        │
│   │ • Property pages   │◄────────────►│ • User auth        │        │
│   │ • Booking flow     │              │ • Properties API   │        │
│   │ • User dashboard   │              │ • Bookings API     │        │
│   │                    │              │                    │        │
│   │ ┌────────────────┐ │              │ ┌────────────────┐ │        │
│   │ │ CHAT COMPONENT │ │              │ │ JWT Verify     │ │        │
│   │ │ (from client   │ │              │ │ Endpoint       │ │        │
│   │ │  package)      │ │              │ └───────┬────────┘ │        │
│   │ └───────┬────────┘ │              └─────────┼──────────┘        │
│   └─────────┼──────────┘                        │                    │
│             │                                   │                    │
└─────────────┼───────────────────────────────────┼────────────────────┘
              │ WebSocket                         │ Verify Token
              │ Connection                        │
              ▼                                   ▼
┌─────────────────────────────────────────────────────────────────────┐
│                     NEW: majestic-chat REPO                          │
├─────────────────────────────────────────────────────────────────────┤
│                                                                      │
│   ┌─────────────┐    ┌─────────────┐    ┌─────────────────────┐     │
│   │   shared    │    │   server    │    │       client        │     │
│   │             │    │             │    │                     │     │
│   │ • Types     │◄───┤ • Socket.io │    │ • React hooks       │     │
│   │ • Schemas   │    │ • Services  │    │ • UI components     │     │
│   │ • Patterns  │◄───┤ • Events    │    │ • Socket wrapper    │     │
│   │             │    │             │    │                     │     │
│   └─────────────┘    └──────┬──────┘    └─────────────────────┘     │
│         ▲                   │                     ▲                  │
│         │                   │                     │                  │
│         └───────────────────┴─────────────────────┘                  │
│                    Internal dependencies                             │
│                                                                      │
│   Deployment:                                                        │
│   • server → Railway (chat.majesticescape.in)                       │
│   • client → npm package installed in user.website                  │
│   • shared → internal dependency (not published)                    │
│                                                                      │
└─────────────────────────────────────────────────────────────────────┘
```

---

# 📅 WEEK 1: FOUNDATION

## Day 1: Project Setup

### Step 0.1: Create GitHub Repository (Manual)

1. Go to GitHub → Majestic-Escape organization
2. Click "New Repository"
3. Name: `majestic-chat`
4. Private repository
5. Initialize with README

### Step 0.2: Clone and Setup (Manual)

```bash
git clone https://github.com/Majestic-Escape/majestic-chat.git
cd majestic-chat
```

---

### 🎯 PROMPT 0.1: Initialize Monorepo Structure

**This is your FIRST prompt to Copilot:**

```
## CONTEXT
Creating a new monorepo called "majestic-chat" for MajesticEscape.in property rental platform.
This will contain a Socket.io chat server, shared utilities, and a React client SDK.
Must integrate with existing Express backend (server.me) and Next.js frontend (user.website).

## TASK
Initialize the complete monorepo structure with npm workspaces.

## SPECIFICATIONS

Create this exact structure:

majestic-chat/
├── .github/
│   └── copilot-instructions.md
├── packages/
│   ├── shared/
│   │   ├── src/
│   │   │   ├── types/
│   │   │   │   └── .gitkeep
│   │   │   ├── schemas/
│   │   │   │   └── .gitkeep
│   │   │   ├── errors/
│   │   │   │   └── .gitkeep
│   │   │   ├── moderation/
│   │   │   │   └── .gitkeep
│   │   │   ├── constants/
│   │   │   │   └── .gitkeep
│   │   │   └── index.ts
│   │   ├── package.json
│   │   └── tsconfig.json
│   ├── server/
│   │   ├── src/
│   │   │   ├── services/
│   │   │   │   └── .gitkeep
│   │   │   ├── repositories/
│   │   │   │   └── .gitkeep
│   │   │   ├── events/
│   │   │   │   └── .gitkeep
│   │   │   ├── middleware/
│   │   │   │   └── .gitkeep
│   │   │   ├── lib/
│   │   │   │   └── .gitkeep
│   │   │   └── index.ts
│   │   ├── package.json
│   │   ├── tsconfig.json
│   │   └── Dockerfile
│   └── client/
│       ├── src/
│       │   ├── hooks/
│       │   │   └── .gitkeep
│       │   ├── components/
│       │   │   └── .gitkeep
│       │   ├── context/
│       │   │   └── .gitkeep
│       │   ├── socket/
│       │   │   └── .gitkeep
│       │   └── index.ts
│       ├── package.json
│       └── tsconfig.json
├── package.json
├── tsconfig.base.json
├── .env.example
├── .gitignore
└── README.md

Root package.json:
{
  "name": "majestic-chat",
  "version": "1.0.0",
  "private": true,
  "workspaces": [
    "packages/*"
  ],
  "scripts": {
    "build": "npm run build --workspaces",
    "build:shared": "npm run build -w @majestic/chat-shared",
    "build:server": "npm run build -w @majestic/chat-server",
    "build:client": "npm run build -w @majestic/chat-client",
    "dev:server": "npm run dev -w @majestic/chat-server",
    "lint": "npm run lint --workspaces",
    "test": "npm run test --workspaces",
    "clean": "rm -rf packages/*/dist"
  }
}

packages/shared/package.json:
{
  "name": "@majestic/chat-shared",
  "version": "1.0.0",
  "main": "dist/index.js",
  "types": "dist/index.d.ts",
  "scripts": {
    "build": "tsc",
    "lint": "eslint src/",
    "test": "jest"
  },
  "dependencies": {
    "zod": "^3.22.0",
    "mongoose": "^8.0.0"
  },
  "devDependencies": {
    "typescript": "^5.3.0",
    "@types/node": "^20.0.0"
  }
}

packages/server/package.json:
{
  "name": "@majestic/chat-server",
  "version": "1.0.0",
  "main": "dist/index.js",
  "scripts": {
    "build": "tsc",
    "dev": "ts-node-dev --respawn src/index.ts",
    "start": "node dist/index.js",
    "lint": "eslint src/",
    "test": "jest"
  },
  "dependencies": {
    "@majestic/chat-shared": "*",
    "socket.io": "^4.7.0",
    "@socket.io/redis-adapter": "^8.2.0",
    "ioredis": "^5.3.0",
    "mongoose": "^8.0.0",
    "pino": "^8.16.0",
    "jsonwebtoken": "^9.0.0",
    "cors": "^2.8.5"
  },
  "devDependencies": {
    "typescript": "^5.3.0",
    "@types/node": "^20.0.0",
    "ts-node-dev": "^2.0.0"
  }
}

packages/client/package.json:
{
  "name": "@majestic/chat-client",
  "version": "1.0.0",
  "main": "dist/index.js",
  "types": "dist/index.d.ts",
  "scripts": {
    "build": "tsc",
    "lint": "eslint src/",
    "test": "jest"
  },
  "dependencies": {
    "@majestic/chat-shared": "*",
    "socket.io-client": "^4.7.0"
  },
  "peerDependencies": {
    "react": "^18.0.0",
    "react-dom": "^18.0.0"
  },
  "devDependencies": {
    "typescript": "^5.3.0",
    "@types/react": "^18.0.0",
    "@types/node": "^20.0.0"
  }
}

tsconfig.base.json:
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "commonjs",
    "lib": ["ES2022"],
    "declaration": true,
    "strict": true,
    "noImplicitAny": true,
    "strictNullChecks": true,
    "noImplicitThis": true,
    "alwaysStrict": true,
    "noUnusedLocals": false,
    "noUnusedParameters": false,
    "noImplicitReturns": true,
    "noFallthroughCasesInSwitch": false,
    "inlineSourceMap": true,
    "inlineSources": true,
    "experimentalDecorators": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true,
    "resolveJsonModule": true
  }
}

Each package tsconfig.json should extend the base and set:
- outDir: "./dist"
- rootDir: "./src"

.env.example:
# MongoDB
MONGODB_URI=mongodb+srv://user:pass@cluster.mongodb.net/majestic-chat

# Redis (for Socket.io scaling)
REDIS_URL=redis://localhost:6379

# JWT (same secret as server.me for token verification)
JWT_SECRET=your-jwt-secret

# Server
PORT=3001
CORS_ORIGIN=https://www.majesticescape.in

# Optional: External auth verification
AUTH_SERVICE_URL=https://api.majesticescape.in/auth/verify

.gitignore should include:
node_modules/
dist/
.env
*.log

## CONSTRAINTS
- Use npm workspaces (not yarn or pnpm)
- TypeScript 5.3+ strict mode
- All packages must build independently
- Shared package has NO React dependencies

## VERIFICATION
After creating all files, run:
npm install
npm run build:shared

Both commands should succeed with no errors.
```

**✅ VERIFY BEFORE CONTINUING:**

```bash
npm install
npm run build:shared
# Should complete without errors
```

---

### 🎯 PROMPT 0.2: Create Copilot Instructions

```
## TASK
Create the .github/copilot-instructions.md file with project rules.

## SPECIFICATIONS
File: .github/copilot-instructions.md

Content:

# Copilot Instructions for MajesticEscape Chat

## Project Overview
Real-time chat system for property rentals. Monorepo with 3 packages:
- @majestic/chat-shared: Types, schemas, utilities (NO React)
- @majestic/chat-server: Socket.io server (Node.js)
- @majestic/chat-client: React hooks & components

## Tech Stack (EXACT VERSIONS)
- Runtime: Node.js 20.x
- TypeScript: 5.3+
- Socket.io: 4.7.x (server and client)
- Redis Adapter: @socket.io/redis-adapter 8.x
- Database: MongoDB 7.x via Mongoose 8.x
- Validation: Zod 3.x
- React: 18.x (client package only)

## Code Style Rules
- Use async/await, NEVER callbacks
- All functions must have TypeScript types
- Use Zod for runtime validation
- Use pino logger in server, NEVER console.log
- Named exports only, NO default exports
- Errors must be ChatError instances

## File Locations
- Types go in: packages/shared/src/types/
- MongoDB schemas go in: packages/shared/src/schemas/
- Services go in: packages/server/src/services/
- React hooks go in: packages/client/src/hooks/
- React components go in: packages/client/src/components/

## Import Rules
- Server imports from shared: import { Message } from '@majestic/chat-shared'
- Client imports from shared: import { Message } from '@majestic/chat-shared'
- NEVER import server code from client or vice versa

## Socket.io Rules
- Use ONLY v4 APIs
- Room broadcasts: io.to(room).emit() NOT io.sockets.emit()
- Room naming: conversation:{conversationId}
- Event naming: domain:action (message:send, typing:start)

## DO NOT
- Use deprecated Socket.io v2/v3 APIs
- Put React code in shared package
- Use default exports
- Skip error handling
- Create files outside defined structure
- Add features not explicitly requested

## VERIFICATION
After every change, run from repo root:
npm run build:shared && npm run build:server && npm run build:client

## VERIFICATION
File created at .github/copilot-instructions.md
```

---

## Day 1-2: Shared Package - Types

### 🎯 PROMPT 1.1: Chat Types

```
## CONTEXT
Monorepo initialized. Creating shared types that server and client will use.
This is the foundation - everything else depends on these types.

## TASK
Create comprehensive chat type definitions with Zod schemas.

## SPECIFICATIONS
File: packages/shared/src/types/chat.types.ts

Create TypeScript types AND Zod schemas for:

1. MessageType enum: 'text' | 'image' | 'file' | 'system'

2. MessageStatus enum: 'sending' | 'sent' | 'delivered' | 'read' | 'failed'

3. ModerationStatus enum: 'clean' | 'flagged' | 'blocked'

4. ParticipantRole enum: 'host' | 'guest'

5. ConversationStatus enum: 'active' | 'archived' | 'blocked'

6. Attachment type:
   - id: string
   - url: string
   - type: 'image' | 'document'
   - filename: string
   - size: number (bytes)
   - mimeType: string
   - thumbnailUrl?: string

7. MessageContent type:
   - text?: string
   - attachments?: Attachment[]

8. ModerationResult type:
   - status: ModerationStatus
   - flags: string[]
   - confidence: number
   - originalContent?: string

9. ReadReceipt type:
   - userId: string
   - readAt: Date

10. Participant type:
    - userId: string
    - role: ParticipantRole
    - joinedAt: Date

11. LastMessage type:
    - content: string
    - senderId: string
    - sentAt: Date

12. Message type:
    - id: string
    - conversationId: string
    - senderId: string
    - clientMessageId: string
    - type: MessageType
    - content: MessageContent
    - moderation: ModerationResult
    - readBy: ReadReceipt[]
    - status: MessageStatus
    - createdAt: Date
    - updatedAt: Date
    - deletedAt?: Date

13. Conversation type:
    - id: string
    - propertyId: string
    - bookingId?: string
    - participants: Participant[]
    - lastMessage?: LastMessage
    - unreadCount: Record<string, number>
    - status: ConversationStatus
    - createdAt: Date
    - updatedAt: Date

14. SendMessageParams type:
    - conversationId: string
    - senderId: string
    - content: MessageContent
    - type: MessageType
    - clientMessageId: string

15. PaginationOptions type:
    - limit: number (default 50, max 100)
    - cursor?: string
    - direction: 'before' | 'after'

16. PaginatedResult<T> type:
    - data: T[]
    - nextCursor?: string
    - hasMore: boolean

For each type, create a corresponding Zod schema with same name + "Schema" suffix.
Use z.infer<typeof Schema> to derive types from schemas.

Export everything from the file.

## CONSTRAINTS
- NO database-specific fields (_id, __v)
- NO methods on types
- All Date fields use z.coerce.date() in Zod
- Use strict Zod schemas
- This file must work in both Node.js AND browser

## VERIFICATION
cd packages/shared && npx tsc --noEmit src/types/chat.types.ts
```

**✅ VERIFY:**

```bash
cd packages/shared && npx tsc --noEmit
```

---

### 🎯 PROMPT 1.2: Socket Event Types

```
## CONTEXT
Chat types created. Need type definitions for Socket.io events.

## TASK
Create Socket.io event type definitions for type-safe events.

## SPECIFICATIONS
File: packages/shared/src/types/socket.types.ts

Create:

1. ClientToServerEvents interface:
   - 'message:send': (data: SendMessageInput, callback: (response: MessageResponse) => void) => void
   - 'message:read': (data: ReadMessagesInput) => void
   - 'conversation:join': (data: { conversationId: string }) => void
   - 'conversation:leave': (data: { conversationId: string }) => void
   - 'typing:start': (data: { conversationId: string }) => void
   - 'typing:stop': (data: { conversationId: string }) => void

2. ServerToClientEvents interface:
   - 'message:new': (data: { message: Message; conversationId: string }) => void
   - 'message:sent': (data: { messageId: string; clientMessageId: string }) => void
   - 'message:delivered': (data: { messageId: string; userId: string; timestamp: Date }) => void
   - 'message:read': (data: { conversationId: string; messageIds: string[]; userId: string; timestamp: Date }) => void
   - 'typing:update': (data: { conversationId: string; userId: string; isTyping: boolean }) => void
   - 'user:online': (data: { userId: string }) => void
   - 'user:offline': (data: { userId: string }) => void
   - 'error': (data: { code: string; message: string }) => void

3. InterServerEvents interface:
   - 'ping': () => void

4. SocketData interface:
   - user: { id: string; email: string; role?: string }
   - joinedRooms: Set<string>

5. Input types:
   - SendMessageInput: { conversationId, content, type, clientMessageId }
   - ReadMessagesInput: { conversationId, messageIds }
   - MessageResponse: { success: boolean; messageId?: string; error?: string }

Import Message and other types from ./chat.types

## CONSTRAINTS
- Use proper function signatures for Socket.io events
- All inputs should have Zod schemas for validation

## REFERENCES
@workspace packages/shared/src/types/chat.types.ts

## VERIFICATION
cd packages/shared && npx tsc --noEmit src/types/socket.types.ts
```

---

### 🎯 PROMPT 1.3: Error Types

```
## CONTEXT
Types created. Need typed error handling.

## TASK
Create ChatError class and error codes.

## SPECIFICATIONS
File: packages/shared/src/errors/ChatError.ts

Create:

1. ErrorCode enum:
   - VALIDATION_ERROR = 'VALIDATION_ERROR'
   - UNAUTHORIZED = 'UNAUTHORIZED'
   - FORBIDDEN = 'FORBIDDEN'
   - CONVERSATION_NOT_FOUND = 'CONVERSATION_NOT_FOUND'
   - MESSAGE_NOT_FOUND = 'MESSAGE_NOT_FOUND'
   - USER_NOT_PARTICIPANT = 'USER_NOT_PARTICIPANT'
   - MODERATION_BLOCKED = 'MODERATION_BLOCKED'
   - RATE_LIMITED = 'RATE_LIMITED'
   - DATABASE_ERROR = 'DATABASE_ERROR'
   - SOCKET_ERROR = 'SOCKET_ERROR'
   - FILE_TOO_LARGE = 'FILE_TOO_LARGE'
   - INVALID_FILE_TYPE = 'INVALID_FILE_TYPE'
   - INTERNAL_ERROR = 'INTERNAL_ERROR'

2. HTTP_STATUS_MAP: Record<ErrorCode, number>
   - Map each code to appropriate HTTP status

3. ChatError class extends Error:
   Properties:
   - code: ErrorCode
   - statusCode: number
   - details?: Record<string, unknown>
   - timestamp: Date

   Constructor:
   - (code: ErrorCode, message: string, details?: Record<string, unknown>)
   - Auto-set statusCode from HTTP_STATUS_MAP
   - Auto-set timestamp to new Date()

   Methods:
   - toJSON(): { code, message, statusCode, details, timestamp }
   - static fromCode(code: ErrorCode, details?: Record<string, unknown>): ChatError

   Static factory methods:
   - static validation(message: string, details?: object): ChatError
   - static unauthorized(message?: string): ChatError
   - static forbidden(message?: string): ChatError
   - static notFound(resource: string): ChatError
   - static userNotParticipant(): ChatError
   - static moderationBlocked(flags: string[]): ChatError
   - static rateLimited(retryAfter?: number): ChatError
   - static database(message: string): ChatError
   - static internal(message?: string): ChatError

4. Type guard:
   - isChatError(error: unknown): error is ChatError

## CONSTRAINTS
- All factory methods return properly typed ChatError
- Default messages for each error type
- Works in both Node.js and browser

## VERIFICATION
cd packages/shared && npx tsc --noEmit src/errors/ChatError.ts
```

---

### 🎯 PROMPT 1.4: Constants

```
## CONTEXT
Types and errors created. Need shared constants.

## TASK
Create shared constants for events and configuration.

## SPECIFICATIONS
File: packages/shared/src/constants/events.ts

Create:

export const SOCKET_EVENTS = {
  // Client to Server
  MESSAGE_SEND: 'message:send',
  MESSAGE_READ: 'message:read',
  CONVERSATION_JOIN: 'conversation:join',
  CONVERSATION_LEAVE: 'conversation:leave',
  TYPING_START: 'typing:start',
  TYPING_STOP: 'typing:stop',

  // Server to Client
  MESSAGE_NEW: 'message:new',
  MESSAGE_SENT: 'message:sent',
  MESSAGE_DELIVERED: 'message:delivered',
  MESSAGE_READ_ACK: 'message:read',
  TYPING_UPDATE: 'typing:update',
  USER_ONLINE: 'user:online',
  USER_OFFLINE: 'user:offline',
  ERROR: 'error',
} as const;

export type SocketEvent = typeof SOCKET_EVENTS[keyof typeof SOCKET_EVENTS];

---

File: packages/shared/src/constants/config.ts

Create:

export const CHAT_CONFIG = {
  // Pagination
  DEFAULT_PAGE_SIZE: 50,
  MAX_PAGE_SIZE: 100,

  // Timeouts (ms)
  TYPING_TIMEOUT: 3000,
  SOCKET_PING_TIMEOUT: 20000,
  SOCKET_PING_INTERVAL: 25000,
  CONNECTION_RECOVERY_DURATION: 120000,

  // Rate limits
  MESSAGES_PER_MINUTE: 60,
  UPLOADS_PER_HOUR: 30,

  // File limits
  MAX_FILE_SIZE: 25 * 1024 * 1024, // 25MB
  ALLOWED_IMAGE_TYPES: ['image/jpeg', 'image/png', 'image/webp', 'image/gif'],
  ALLOWED_DOC_TYPES: ['application/pdf', 'application/msword', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'],

  // Room naming
  ROOM_PREFIX: 'conversation:',
} as const;

export const getRoomName = (conversationId: string): string =>
  `${CHAT_CONFIG.ROOM_PREFIX}${conversationId}`;

## VERIFICATION
cd packages/shared && npx tsc --noEmit src/constants/events.ts src/constants/config.ts
```

---

### 🎯 PROMPT 1.5: Update Shared Index

```
## CONTEXT
All shared types, errors, and constants created. Need to export them.

## TASK
Update the shared package index to export everything.

## SPECIFICATIONS
File: packages/shared/src/index.ts

Content:

// Types
export * from './types/chat.types';
export * from './types/socket.types';

// Errors
export * from './errors/ChatError';

// Constants
export * from './constants/events';
export * from './constants/config';

// Moderation (will be added later)
// export * from './moderation/patterns';

// Schemas (will be added later)
// export * from './schemas/Message.schema';
// export * from './schemas/Conversation.schema';

## VERIFICATION
cd packages/shared && npm run build
```

**✅ CHECKPOINT 1: Verify Shared Foundation**

```bash
cd packages/shared && npm run build
# Should output to packages/shared/dist/ with no errors
```

---

## Day 2-3: Shared Package - Database

### 🎯 PROMPT 2.1: MongoDB Schemas

```
## CONTEXT
Types defined. Need MongoDB schemas in shared package so server can use them.

## TASK
Create Message MongoDB schema.

## SPECIFICATIONS
File: packages/shared/src/schemas/Message.schema.ts

Import types from '../types/chat.types'

Create MessageSchema matching the Message type:
- All fields from Message type
- Use mongoose.Schema.Types.ObjectId for ID references
- Store as strings in schema, transform on output

Indexes:
1. { conversationId: 1, createdAt: -1 } - message loading
2. { conversationId: 1, clientMessageId: 1 }, { unique: true } - idempotency
3. { senderId: 1, createdAt: -1 } - user history
4. { 'moderation.status': 1, createdAt: -1 } - moderation queue

Schema options:
- timestamps: true
- collection: 'messages'
- toJSON: { virtuals: true, transform to convert _id to id }
- toObject: { virtuals: true, transform to convert _id to id }

Export:
- MessageSchema
- IMessageDocument (mongoose.Document & Message)
- MessageModel (only if mongoose.models.Message doesn't exist - for serverless)

## CONSTRAINTS
- Transform _id to id in all outputs
- Remove __v from outputs
- NO instance methods
- NO static methods (keep in repository)

## REFERENCES
@workspace packages/shared/src/types/chat.types.ts

## VERIFICATION
cd packages/shared && npx tsc --noEmit src/schemas/Message.schema.ts
```

---

### 🎯 PROMPT 2.2: Conversation Schema

```
## CONTEXT
Message schema created. Need Conversation schema.

## TASK
Create Conversation MongoDB schema.

## SPECIFICATIONS
File: packages/shared/src/schemas/Conversation.schema.ts

Create ConversationSchema matching Conversation type.

Indexes:
1. { 'participants.userId': 1, updatedAt: -1 } - user's conversations
2. { propertyId: 1, status: 1 } - property conversations
3. { bookingId: 1 }, { sparse: true } - booking lookup

Schema options:
- Same as Message schema
- collection: 'conversations'

Export:
- ConversationSchema
- IConversationDocument
- ConversationModel

## REFERENCES
@workspace packages/shared/src/schemas/Message.schema.ts

## VERIFICATION
cd packages/shared && npx tsc --noEmit src/schemas/Conversation.schema.ts
```

---

### 🎯 PROMPT 2.3: Moderation Patterns

```
## CONTEXT
Schemas created. Need moderation patterns for contact detection.

## TASK
Create regex patterns for Indian market contact detection.

## SPECIFICATIONS
File: packages/shared/src/moderation/patterns.ts

Create:

1. PatternType enum:
   - INDIAN_PHONE
   - SPACED_PHONE
   - EMAIL
   - OBFUSCATED_EMAIL
   - WHATSAPP
   - TELEGRAM
   - SIGNAL
   - CONTACT_INTENT

2. MODERATION_PATTERNS: Record<PatternType, RegExp>

   INDIAN_PHONE: Matches +91 followed by 10 digits, or 10 digits starting with 6-9
   Pattern: /(?:\+91[\s.-]?)?[6-9]\d{4}[\s.-]?\d{5}/gi
   Examples: "+91 98765 43210", "9876543210", "+91-98765-43210"

   SPACED_PHONE: Digits with spaces/dots between them
   Pattern: /[6-9](?:\s*\d){9}/gi
   Examples: "9 8 7 6 5 4 3 2 1 0", "9.8.7.6.5.4.3.2.1.0"

   EMAIL: Standard email format
   Pattern: /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/gi

   OBFUSCATED_EMAIL: Email with (at) and (dot)
   Pattern: /[a-zA-Z0-9._%+-]+\s*[\(\[]?\s*at\s*[\)\]]?\s*[a-zA-Z0-9.-]+\s*[\(\[]?\s*dot\s*[\)\]]?\s*[a-zA-Z]{2,}/gi

   WHATSAPP: WhatsApp mentions
   Pattern: /whats?\s*app|wa\.me\/|watsap/gi

   TELEGRAM: Telegram handles and links
   Pattern: /telegram|t\.me\/|@[a-zA-Z][a-zA-Z0-9_]{4,}/gi

   SIGNAL: Signal app mentions
   Pattern: /\bsignal\s*(?:app|number|me)\b/gi

   CONTACT_INTENT: Phrases indicating contact sharing intent
   Pattern: /(?:call|text|reach|contact|message|ping|dm)\s*(?:me|us)\s*(?:on|at|via|@)?/gi

3. ViolationMatch type:
   - pattern: PatternType
   - match: string
   - index: number
   - length: number

4. ViolationResult type:
   - hasViolations: boolean
   - violations: ViolationMatch[]
   - confidence: number (0-1)
   - flaggedPatterns: PatternType[]

5. Functions:

   checkText(text: string): ViolationResult
   - Run all patterns against text
   - Calculate confidence based on number and type of matches
   - Phone/email = high confidence (0.9)
   - Platform mentions = medium confidence (0.7)
   - Intent phrases alone = low confidence (0.4)
   - Multiple matches increase confidence

   calculateConfidence(violations: ViolationMatch[]): number
   - No violations: 0
   - Intent only: 0.4
   - Platform only: 0.6
   - Phone or email: 0.9
   - Multiple types: min(1.0, sum of individual confidences)

   getModerationStatus(confidence: number): ModerationStatus
   - >= 0.9: 'blocked'
   - >= 0.6: 'flagged'
   - < 0.6: 'clean'

## CONSTRAINTS
- Patterns must be case-insensitive (use /gi flags)
- Must handle Unicode spaces
- Test examples in comments for each pattern
- Export everything

## VERIFICATION
cd packages/shared && npx tsc --noEmit src/moderation/patterns.ts
```

---

### 🎯 PROMPT 2.4: Update Shared Index (Final)

```
## TASK
Update shared package index to export all modules.

## SPECIFICATIONS
File: packages/shared/src/index.ts

// Types
export * from './types/chat.types';
export * from './types/socket.types';

// Errors
export * from './errors/ChatError';

// Constants
export * from './constants/events';
export * from './constants/config';

// Moderation
export * from './moderation/patterns';

// Schemas
export * from './schemas/Message.schema';
export * from './schemas/Conversation.schema';

## VERIFICATION
cd packages/shared && npm run build
ls packages/shared/dist/
```

**✅ CHECKPOINT 2: Shared Package Complete**

```bash
npm run build:shared
# Verify dist/ folder has all compiled files
```

---

# 📅 WEEK 2: SERVICES & REAL-TIME

## Day 4: Server Package - Infrastructure

### 🎯 PROMPT 3.1: Database Connection

```
## CONTEXT
Shared package complete. Building server package.
Server will run on Railway, needs serverless-friendly DB connection.

## TASK
Create MongoDB connection utility.

## SPECIFICATIONS
File: packages/server/src/lib/database.ts

Create:

1. Type: MongooseCache = { conn: typeof mongoose | null; promise: Promise<typeof mongoose> | null }

2. Global cache: declare global { var mongooseCache: MongooseCache }

3. Function: connectDatabase(): Promise<typeof mongoose>
   - Check for MONGODB_URI env var
   - Use cached connection if available
   - Create new connection with options:
     - maxPoolSize: 10
     - minPoolSize: 5
     - maxIdleTimeMS: 30000
     - serverSelectionTimeoutMS: 5000
   - Cache the connection promise
   - Log connection status with pino

4. Function: disconnectDatabase(): Promise<void>

5. Export logger instance for server use:
   - Create pino logger with pretty print in development
   - Name: 'majestic-chat'

## CONSTRAINTS
- Works in serverless AND long-running server
- Mongoose 8.x APIs only
- No callbacks

## VERIFICATION
cd packages/server && npx tsc --noEmit src/lib/database.ts
```

---

### 🎯 PROMPT 3.2: Redis Connection

```
## CONTEXT
Database connection ready. Need Redis for Socket.io adapter.

## TASK
Create Redis connection utilities.

## SPECIFICATIONS
File: packages/server/src/lib/redis.ts

Create:

1. Function: createRedisClient(name: string): Redis
   - Use REDIS_URL from env
   - Configure with:
     - maxRetriesPerRequest: 3
     - retryStrategy: exponential backoff
   - Log connection events

2. Function: createPubSubClients(): { pubClient: Redis; subClient: Redis }
   - Create two Redis clients for Socket.io adapter
   - Name them 'pub' and 'sub'

3. Export singleton instances:
   - redisClient: main Redis client
   - pubClient: for publishing
   - subClient: for subscribing

## CONSTRAINTS
- Handle connection errors gracefully
- Log all connection events
- Auto-reconnect on failure

## VERIFICATION
cd packages/server && npx tsc --noEmit src/lib/redis.ts
```

---

### 🎯 PROMPT 3.3: Repositories

```
## CONTEXT
Database ready. Need repository layer for data access.

## TASK
Create MessageRepository class.

## SPECIFICATIONS
File: packages/server/src/repositories/MessageRepository.ts

Import from @majestic/chat-shared:
- Message, SendMessageParams, PaginationOptions, PaginatedResult
- MessageModel, IMessageDocument

Class: MessageRepository

Constructor:
- private model = MessageModel
- private logger: pino.Logger

Methods:

1. async create(data: Omit<Message, 'id' | 'createdAt' | 'updatedAt'>): Promise<Message>
   - Handle duplicate clientMessageId (return existing via upsert pattern)

2. async findById(id: string): Promise<Message | null>
   - Use lean() for performance

3. async findByConversation(conversationId: string, options: PaginationOptions): Promise<PaginatedResult<Message>>
   - Implement cursor-based pagination
   - Sort by createdAt descending
   - Return { data, nextCursor, hasMore }

4. async findByClientMessageId(conversationId: string, clientMessageId: string): Promise<Message | null>

5. async updateReadBy(messageIds: string[], userId: string, readAt: Date): Promise<void>
   - Batch update using $addToSet

6. async updateStatus(messageId: string, status: MessageStatus): Promise<void>

7. async softDelete(messageId: string): Promise<void>
   - Set deletedAt = new Date()

Private helper:
- toMessage(doc: IMessageDocument): Message
  - Transform _id to id
  - Remove __v

## CONSTRAINTS
- Return plain objects, not Mongoose documents
- All methods async/await
- Log all operations
- Handle errors with ChatError

## REFERENCES
@workspace packages/shared/src/schemas/Message.schema.ts
@workspace packages/shared/src/types/chat.types.ts

## VERIFICATION
cd packages/server && npx tsc --noEmit src/repositories/MessageRepository.ts
```

---

### 🎯 PROMPT 3.4: Conversation Repository

```
## CONTEXT
Message repository created. Need Conversation repository.

## TASK
Create ConversationRepository class.

## SPECIFICATIONS
File: packages/server/src/repositories/ConversationRepository.ts

Methods:

1. async create(data: Omit<Conversation, 'id' | 'createdAt' | 'updatedAt'>): Promise<Conversation>

2. async findById(id: string): Promise<Conversation | null>

3. async findByUserId(userId: string, status?: ConversationStatus): Promise<Conversation[]>
   - Filter by participant userId
   - Sort by updatedAt descending

4. async findByPropertyAndParticipants(propertyId: string, participantIds: string[]): Promise<Conversation | null>
   - Find existing conversation between these users for this property

5. async updateLastMessage(conversationId: string, lastMessage: LastMessage): Promise<void>
   - Also update updatedAt

6. async incrementUnreadCount(conversationId: string, exceptUserId: string): Promise<void>
   - Increment unreadCount for all participants except sender

7. async resetUnreadCount(conversationId: string, userId: string): Promise<void>
   - Set unreadCount[userId] = 0

8. async updateStatus(conversationId: string, status: ConversationStatus): Promise<void>

9. async isUserParticipant(conversationId: string, userId: string): Promise<boolean>

## CONSTRAINTS
- Same patterns as MessageRepository

## REFERENCES
@workspace packages/server/src/repositories/MessageRepository.ts

## VERIFICATION
cd packages/server && npx tsc --noEmit src/repositories/ConversationRepository.ts
```

---

## Day 5: Server Package - Services

### 🎯 PROMPT 4.1: Moderation Service

```
## CONTEXT
Repositories ready. Need services layer.

## TASK
Create ModerationService for content checking.

## SPECIFICATIONS
File: packages/server/src/services/ModerationService.ts

Import from @majestic/chat-shared:
- checkText, getModerationStatus, ViolationResult, ModerationResult
- MessageContent, ModerationStatus

Class: ModerationService

Constructor:
- private logger: pino.Logger

Methods:

1. async checkMessage(content: MessageContent): Promise<ModerationResult>
   - If no text content, return clean result
   - Run checkText() on content.text
   - Log moderation results
   - Return ModerationResult with status, flags, confidence

2. async checkBatch(contents: MessageContent[]): Promise<ModerationResult[]>
   - Check multiple messages efficiently

3. formatWarningMessage(result: ModerationResult): string | null
   - If flagged: return user-friendly warning about platform policy
   - If blocked: return message about content being blocked
   - If clean: return null

## CONSTRAINTS
- Must be fast (< 50ms per message)
- Never throw, always return result
- Log all moderation decisions

## REFERENCES
@workspace packages/shared/src/moderation/patterns.ts

## VERIFICATION
cd packages/server && npx tsc --noEmit src/services/ModerationService.ts
```

---

### 🎯 PROMPT 4.2: Chat Service

```
## CONTEXT
Moderation service ready. Need main chat service.

## TASK
Create ChatService class with all business logic.

## SPECIFICATIONS
File: packages/server/src/services/ChatService.ts

Import from @majestic/chat-shared:
- All types, ChatError, ErrorCode

Class: ChatService

Constructor:
- private messageRepo: MessageRepository
- private conversationRepo: ConversationRepository
- private moderationService: ModerationService
- private eventEmitter: EventEmitter
- private logger: pino.Logger

Methods:

1. async sendMessage(params: SendMessageParams): Promise<Message>
   Flow:
   a. Validate params with Zod schema
   b. Verify conversation exists
   c. Verify sender is participant
   d. Check for duplicate (clientMessageId) - return existing if found
   e. Run moderation check
   f. Create message with moderation result
   g. Update conversation lastMessage
   h. Increment unread count for other participants
   i. Emit 'message:created' event
   j. Return message

   Error handling:
   - Validation fail → ChatError.validation()
   - Conversation not found → ChatError.notFound('conversation')
   - Not participant → ChatError.userNotParticipant()

2. async getMessages(conversationId: string, userId: string, options: PaginationOptions): Promise<PaginatedResult<Message>>
   Flow:
   a. Validate inputs
   b. Verify user is participant
   c. Fetch messages from repository
   d. Return paginated result

3. async markAsRead(conversationId: string, userId: string, messageIds: string[]): Promise<void>
   Flow:
   a. Verify user is participant
   b. Update readBy on messages
   c. Reset unread count
   d. Emit 'messages:read' event

4. async getConversations(userId: string): Promise<Conversation[]>
   - Fetch all conversations for user
   - Sort by updatedAt desc

5. async getOrCreateConversation(propertyId: string, hostId: string, guestId: string): Promise<Conversation>
   Flow:
   a. Try to find existing conversation
   b. If found, return it
   c. If not, create new with both participants
   d. Return new conversation

6. async getConversation(conversationId: string, userId: string): Promise<Conversation>
   - Verify user is participant
   - Return conversation

## CONSTRAINTS
- All methods validate inputs first
- All methods check authorization
- Use ChatError for all errors
- Log entry and exit of each method
- Emit events for real-time updates

## REFERENCES
@workspace packages/server/src/repositories/MessageRepository.ts
@workspace packages/server/src/services/ModerationService.ts
@workspace packages/shared/src/errors/ChatError.ts

## VERIFICATION
cd packages/server && npx tsc --noEmit src/services/ChatService.ts
```

---

## Day 6: Server Package - Socket.io

### 🎯 PROMPT 5.1: Socket Server Setup

```
## CONTEXT
Services ready. Need Socket.io server.

## TASK
Create Socket.io server with Redis adapter.

## SPECIFICATIONS
File: packages/server/src/socket/server.ts

Import from @majestic/chat-shared:
- ClientToServerEvents, ServerToClientEvents, InterServerEvents, SocketData
- CHAT_CONFIG

Import Socket.io and Redis adapter.

Create:

1. Type: TypedServer = Server<ClientToServerEvents, ServerToClientEvents, InterServerEvents, SocketData>
2. Type: TypedSocket = Socket<ClientToServerEvents, ServerToClientEvents, InterServerEvents, SocketData>

3. Function: createSocketServer(httpServer: HttpServer): TypedServer
   Configuration:
   - cors: { origin: process.env.CORS_ORIGIN, credentials: true }
   - pingTimeout: CHAT_CONFIG.SOCKET_PING_TIMEOUT
   - pingInterval: CHAT_CONFIG.SOCKET_PING_INTERVAL
   - connectionStateRecovery: { maxDisconnectionDuration: CHAT_CONFIG.CONNECTION_RECOVERY_DURATION }

   Setup:
   - Attach Redis adapter using pubClient and subClient
   - Return configured server

4. Export types: TypedServer, TypedSocket

## CONSTRAINTS
- Use Socket.io v4 APIs only
- Type-safe events using shared types

## REFERENCES
@workspace packages/shared/src/types/socket.types.ts
@workspace packages/server/src/lib/redis.ts

## VERIFICATION
cd packages/server && npx tsc --noEmit src/socket/server.ts
```

---

### 🎯 PROMPT 5.2: Socket Authentication

```
## CONTEXT
Socket server created. Need authentication middleware.

## TASK
Create JWT authentication middleware for Socket.io.

## SPECIFICATIONS
File: packages/server/src/middleware/socketAuth.ts

Import: TypedSocket from socket/server
Import: jsonwebtoken

Create:

1. Type: AuthenticatedSocket = TypedSocket with guaranteed user data

2. Type: JWTPayload = { id: string; email: string; role?: string }

3. Function: socketAuthMiddleware(socket: TypedSocket, next: (err?: Error) => void): void
   Flow:
   a. Extract token from socket.handshake.auth.token
   b. If no token, call next(new Error('Authentication required'))
   c. Verify JWT using JWT_SECRET env var
   d. On success:
      - Set socket.data.user = { id, email, role }
      - Set socket.data.joinedRooms = new Set()
      - Call next()
   e. On failure: next(new Error('Invalid token'))

4. Function: getUserFromSocket(socket: TypedSocket): { id: string; email: string } | null
   - Return socket.data.user if exists

5. Function: isAuthenticated(socket: TypedSocket): socket is AuthenticatedSocket
   - Type guard

## CONSTRAINTS
- Log authentication attempts
- Handle expired tokens
- Don't expose sensitive error details to client

## VERIFICATION
cd packages/server && npx tsc --noEmit src/middleware/socketAuth.ts
```

---

### 🎯 PROMPT 5.3: Socket Event Handlers

````
## CONTEXT
Auth middleware ready. Need event handlers.

## TASK
Create message event handlers.

## SPECIFICATIONS
File: packages/server/src/events/messageEvents.ts

Import types from socket/server and services

Create:

Function: registerMessageEvents(io: TypedServer, chatService: ChatService, logger: Logger): void

Inside, register handlers for socket events:

1. socket.on(SOCKET_EVENTS.MESSAGE_SEND, async (data, callback) => { ... })
   - Get user from socket.data.user
   - Validate data with Zod
   - Call chatService.sendMessage()
   - Emit MESSAGE_NEW to conversation room
   - Call callback with success/messageId
   - On error: emit ERROR event, call callback with error

2. socket.on(SOCKET_EVENTS.MESSAGE_READ, async (data) => { ... })
   - Call chatService.markAsRead()
   - Emit MESSAGE_READ_ACK to room

3. socket.on(SOCKET_EVENTS.CONVERSATION_JOIN, async (data) => { ... })
   - Verify user is participant via chatService
   - socket.join(getRoomName(conversationId))
   - Add to socket.data.joinedRooms

4. socket.on(SOCKET_EVENTS.CONVERSATION_LEAVE, async (data) => { ... })
   - socket.leave(getRoomName(conversationId))
   - Remove from socket.data.joinedRooms

Handler pattern:
```typescript
socket.on('event', async (data, callback) => {
  const user = socket.data.user;
  if (!user) {
    callback?.({ success: false, error: 'Not authenticated' });
    return;
  }

  try {
    // Validate with Zod
    // Call service
    // Emit events
    callback?.({ success: true, ... });
  } catch (error) {
    logger.error({ error, event: 'name' }, 'Event handler error');
    if (error instanceof ChatError) {
      socket.emit(SOCKET_EVENTS.ERROR, { code: error.code, message: error.message });
    }
    callback?.({ success: false, error: error.message });
  }
});
````

## CONSTRAINTS

- Every handler wrapped in try/catch
- Log all events
- Validate all inputs
- Use callback for acknowledgments

## REFERENCES

@workspace packages/server/src/socket/server.ts
@workspace packages/server/src/services/ChatService.ts
@workspace packages/shared/src/constants/events.ts

## VERIFICATION

cd packages/server && npx tsc --noEmit src/events/messageEvents.ts

```

---

### 🎯 PROMPT 5.4: Typing Event Handlers

```

## CONTEXT

Message events ready. Need typing indicators.

## TASK

Create typing event handlers.

## SPECIFICATIONS

File: packages/server/src/events/typingEvents.ts

Create:

Function: registerTypingEvents(io: TypedServer, logger: Logger): void

Track typing state: Map<string, NodeJS.Timeout> for auto-timeout

1. socket.on(SOCKET_EVENTS.TYPING_START, (data) => { ... })
   - Emit TYPING_UPDATE with { isTyping: true } to room (except sender)
   - Set timeout to auto-stop after CHAT_CONFIG.TYPING_TIMEOUT
   - Clear previous timeout if exists

2. socket.on(SOCKET_EVENTS.TYPING_STOP, (data) => { ... })
   - Emit TYPING_UPDATE with { isTyping: false } to room
   - Clear timeout

3. On socket disconnect:
   - Clear all typing timeouts for this socket
   - Emit typing:stop for all rooms user was typing in

## CONSTRAINTS

- Always clean up timeouts
- Don't emit to sender (use socket.to(room) not io.to(room))

## VERIFICATION

cd packages/server && npx tsc --noEmit src/events/typingEvents.ts

```

---

### 🎯 PROMPT 5.5: Server Entry Point

```

## CONTEXT

All socket components ready. Need main server entry.

## TASK

Create server entry point that ties everything together.

## SPECIFICATIONS

File: packages/server/src/index.ts

Create:

1. Import all components

2. Main async function: startServer()
   Flow:
   a. Load environment variables (dotenv)
   b. Connect to MongoDB
   c. Create HTTP server
   d. Create Socket.io server
   e. Apply auth middleware
   f. Instantiate services:
   - MessageRepository
   - ConversationRepository
   - ModerationService
   - ChatService
     g. Register event handlers:
   - registerMessageEvents
   - registerTypingEvents
     h. Add connection/disconnect logging
     i. Start HTTP server on PORT
     j. Log startup complete

3. Handle graceful shutdown:
   - SIGTERM/SIGINT handlers
   - Close Socket.io
   - Disconnect MongoDB
   - Exit process

4. Call startServer() and handle errors

## CONSTRAINTS

- Graceful shutdown required
- All errors logged
- Health check endpoint at GET /health

## VERIFICATION

cd packages/server && npm run build
cd packages/server && npm run start

# Should start server on configured port

````

**✅ CHECKPOINT 3: Server Package Complete**
```bash
npm run build:server
# Test: npm run dev:server (should start without errors)
````

---

# 📅 WEEK 3: CLIENT SDK & INTEGRATION

## Day 7-8: Client Package

### 🎯 PROMPT 6.1: Socket Client Wrapper

```
## CONTEXT
Server complete. Building React client SDK.
Client package will be installed in user.website.

## TASK
Create type-safe Socket.io client wrapper.

## SPECIFICATIONS
File: packages/client/src/socket/client.ts

Import from @majestic/chat-shared:
- ClientToServerEvents, ServerToClientEvents
- SOCKET_EVENTS

Import: io, Socket from 'socket.io-client'

Create:

1. Type: ChatSocket = Socket<ServerToClientEvents, ClientToServerEvents>

2. Type: ConnectionState = 'connecting' | 'connected' | 'disconnected' | 'error'

3. Type: ChatClientOptions = {
     url: string;
     token: string;
     onConnectionChange?: (state: ConnectionState) => void;
     onError?: (error: { code: string; message: string }) => void;
   }

4. Class: ChatClient
   Properties:
   - private socket: ChatSocket | null
   - private options: ChatClientOptions
   - connectionState: ConnectionState

   Constructor(options: ChatClientOptions)

   Methods:
   - connect(): void
     - Create socket with auth token
     - Setup connection event handlers
     - Handle reconnection

   - disconnect(): void
     - Clean disconnect

   - joinConversation(conversationId: string): void
     - Emit CONVERSATION_JOIN

   - leaveConversation(conversationId: string): void
     - Emit CONVERSATION_LEAVE

   - sendMessage(data: SendMessageInput): Promise<MessageResponse>
     - Emit MESSAGE_SEND with callback
     - Return promise that resolves with callback result

   - markAsRead(conversationId: string, messageIds: string[]): void
     - Emit MESSAGE_READ

   - startTyping(conversationId: string): void
   - stopTyping(conversationId: string): void

   - on<E extends keyof ServerToClientEvents>(event: E, handler: ServerToClientEvents[E]): void
   - off<E extends keyof ServerToClientEvents>(event: E, handler: ServerToClientEvents[E]): void

   - getSocket(): ChatSocket | null

5. Export: ChatClient, ChatSocket, ConnectionState, ChatClientOptions

## CONSTRAINTS
- Type-safe event handlers
- Handle reconnection gracefully
- Clean up listeners on disconnect
- Works in browser only (check for window)

## VERIFICATION
cd packages/client && npx tsc --noEmit src/socket/client.ts
```

---

### 🎯 PROMPT 6.2: Chat Context Provider

```
## CONTEXT
Socket client ready. Need React context for state management.

## TASK
Create ChatProvider context for React apps.

## SPECIFICATIONS
File: packages/client/src/context/ChatContext.tsx

Import React, ChatClient, types from shared

Create:

1. Type: ChatContextValue = {
     client: ChatClient | null;
     connectionState: ConnectionState;
     isConnected: boolean;
     error: string | null;
   }

2. ChatContext = createContext<ChatContextValue | null>(null)

3. Type: ChatProviderProps = {
     children: React.ReactNode;
     socketUrl: string;
     token: string;
     onError?: (error: { code: string; message: string }) => void;
   }

4. Component: ChatProvider({ children, socketUrl, token, onError }: ChatProviderProps)
   - Create ChatClient instance on mount
   - Connect with token
   - Track connection state
   - Disconnect on unmount
   - Reconnect when token changes
   - Provide context value

5. Hook: useChatContext(): ChatContextValue
   - Get context
   - Throw if used outside provider

6. Hook: useChatClient(): ChatClient
   - Get client from context
   - Throw if not connected

## CONSTRAINTS
- Clean up on unmount
- Handle token refresh
- Memoize context value

## VERIFICATION
cd packages/client && npx tsc --noEmit src/context/ChatContext.tsx
```

---

### 🎯 PROMPT 6.3: useChat Hook

```
## CONTEXT
Context ready. Need main chat hook.

## TASK
Create useChat hook for conversation functionality.

## SPECIFICATIONS
File: packages/client/src/hooks/useChat.ts

Import types, context, React hooks

Create:

Hook: useChat(conversationId: string)

Parameters:
- conversationId: string

Returns:
{
  messages: Message[];
  isLoading: boolean;
  error: string | null;
  hasMore: boolean;
  sendMessage: (content: MessageContent, type?: MessageType) => Promise<void>;
  loadMore: () => Promise<void>;
  markAsRead: (messageIds: string[]) => void;
  typingUsers: string[];
  startTyping: () => void;
  stopTyping: () => void;
}

Implementation:

1. State:
   - messages: Message[]
   - isLoading: boolean
   - error: string | null
   - cursor: string | null
   - hasMore: boolean
   - typingUsers: string[]

2. On mount:
   - Join conversation room
   - Load initial messages (via REST API or socket)
   - Subscribe to events:
     - MESSAGE_NEW → add to messages
     - MESSAGE_READ_ACK → update read status
     - TYPING_UPDATE → update typingUsers

3. On unmount:
   - Leave conversation room
   - Unsubscribe from events

4. sendMessage function:
   - Generate clientMessageId (uuid)
   - Optimistically add message with 'sending' status
   - Call client.sendMessage()
   - Update status to 'sent' on success
   - Update status to 'failed' on error

5. loadMore function:
   - Fetch older messages using cursor
   - Prepend to messages array

6. markAsRead function:
   - Call client.markAsRead()

7. Typing functions:
   - Debounce startTyping
   - Auto-stop after 3 seconds of inactivity

## CONSTRAINTS
- Optimistic updates for sending
- Deduplicate messages by id
- Sort messages by createdAt
- Clean up all subscriptions

## VERIFICATION
cd packages/client && npx tsc --noEmit src/hooks/useChat.ts
```

---

### 🎯 PROMPT 6.4: useConversations Hook

```
## CONTEXT
useChat ready. Need conversations list hook.

## TASK
Create useConversations hook.

## SPECIFICATIONS
File: packages/client/src/hooks/useConversations.ts

Hook: useConversations()

Returns:
{
  conversations: Conversation[];
  isLoading: boolean;
  error: string | null;
  refresh: () => Promise<void>;
  unreadTotal: number;
}

Implementation:
- Fetch conversations on mount
- Subscribe to updates (new messages update lastMessage)
- Calculate total unread count
- Provide refresh function

## VERIFICATION
cd packages/client && npx tsc --noEmit src/hooks/useConversations.ts
```

---

### 🎯 PROMPT 6.5: Chat Components

```
## CONTEXT
Hooks ready. Need React components.

## TASK
Create ChatWindow component.

## SPECIFICATIONS
File: packages/client/src/components/ChatWindow.tsx

Component: ChatWindow

Props:
{
  conversationId: string;
  currentUserId: string;
  className?: string;
  onBack?: () => void;
}

Structure:
- Header (optional back button, conversation info)
- Message list (scrollable, newest at bottom)
- Typing indicator
- Message input

Use useChat hook internally.

Styling:
- Use CSS classes (consumer provides styles)
- Export component without styles
- Provide default class names for each element

Sub-components to create:
- MessageList: Renders list of messages
- MessageBubble: Single message with sender info, time, read status
- MessageInput: Text input + send button
- TypingIndicator: Shows who is typing

File: packages/client/src/components/MessageList.tsx
File: packages/client/src/components/MessageBubble.tsx
File: packages/client/src/components/MessageInput.tsx
File: packages/client/src/components/TypingIndicator.tsx

## CONSTRAINTS
- No built-in styles (consumer provides CSS)
- Accessible (ARIA labels)
- Mobile-friendly
- Export all components individually

## VERIFICATION
cd packages/client && npx tsc --noEmit src/components/ChatWindow.tsx
```

---

### 🎯 PROMPT 6.6: Client Package Index

```
## TASK
Create client package public exports.

## SPECIFICATIONS
File: packages/client/src/index.ts

// Context
export { ChatProvider, useChatContext, useChatClient } from './context/ChatContext';
export type { ChatProviderProps, ChatContextValue } from './context/ChatContext';

// Hooks
export { useChat } from './hooks/useChat';
export { useConversations } from './hooks/useConversations';

// Components
export { ChatWindow } from './components/ChatWindow';
export { MessageList } from './components/MessageList';
export { MessageBubble } from './components/MessageBubble';
export { MessageInput } from './components/MessageInput';
export { TypingIndicator } from './components/TypingIndicator';

// Socket client (for advanced usage)
export { ChatClient } from './socket/client';
export type { ChatClientOptions, ConnectionState, ChatSocket } from './socket/client';

// Re-export types from shared that consumers need
export type {
  Message,
  Conversation,
  MessageContent,
  MessageType,
  MessageStatus,
  Participant,
} from '@majestic/chat-shared';

## VERIFICATION
cd packages/client && npm run build
```

**✅ CHECKPOINT 4: Client Package Complete**

```bash
npm run build:client
# Verify all files compile
```

---

## Day 9: Integration Testing

### 🎯 PROMPT 7.1: Integration Test Setup

```
## TASK
Create integration test for full chat flow.

## SPECIFICATIONS
File: packages/server/src/__tests__/integration/chat.test.ts

Test: "Full chat flow"

Setup:
- Connect to test MongoDB
- Start Socket.io server
- Create two test users (host and guest)

Test cases:

1. "Should create conversation between host and guest"
   - Call getOrCreateConversation
   - Verify conversation created with both participants

2. "Should send and receive messages"
   - Connect both users via Socket.io
   - User 1 joins conversation
   - User 2 joins conversation
   - User 1 sends message
   - Verify User 2 receives message:new event

3. "Should handle typing indicators"
   - User 1 starts typing
   - Verify User 2 receives typing:update

4. "Should mark messages as read"
   - User 2 marks message as read
   - Verify User 1 receives read receipt

5. "Should flag contact information"
   - Send message with phone number
   - Verify message has moderation.status = 'flagged' or 'blocked'

Teardown:
- Disconnect sockets
- Clean up test data
- Close connections

## VERIFICATION
cd packages/server && npm test
```

---

## Day 10: Documentation

### 🎯 PROMPT 8.1: README Documentation

```
## TASK
Create comprehensive README.

## SPECIFICATIONS
File: README.md

Sections:

1. # MajesticEscape Chat System
   - Brief description
   - Architecture diagram (ASCII)

2. ## Quick Start
   - Prerequisites
   - Installation
   - Environment setup
   - Running locally

3. ## Packages
   - @majestic/chat-shared
   - @majestic/chat-server
   - @majestic/chat-client

4. ## Deployment
   - Server deployment to Railway
   - Environment variables reference

5. ## Integration Guide
   - Installing in user.website
   - Basic usage example
   - Styling guide

6. ## API Reference
   - Socket events
   - React hooks
   - Components

7. ## Development
   - Running tests
   - Contributing

## VERIFICATION
Review README.md for completeness
```

---

# 🚀 DEPLOYMENT GUIDE

## Server Deployment to Railway

### Step 1: Create Railway Project

1. Go to railway.app
2. New Project → Deploy from GitHub repo
3. Select majestic-chat repo
4. Set root directory: `packages/server`

### Step 2: Configure Environment Variables

```
MONGODB_URI=mongodb+srv://...
REDIS_URL=redis://...
JWT_SECRET=same-as-server-me
PORT=3001
CORS_ORIGIN=https://www.majesticescape.in
NODE_ENV=production
```

### Step 3: Configure Domain

1. Settings → Domains
2. Add custom domain: `chat.majesticescape.in`
3. Configure DNS CNAME

### Step 4: Deploy

- Railway auto-deploys on git push
- Check logs for startup confirmation

---

# 🔌 INTEGRATION GUIDE FOR DEVELOPER

## Step 1: Install Client Package

In the `user.website` repo:

```bash
# Option A: Install from npm (if published)
npm install @majestic/chat-client

# Option B: Install from GitHub
npm install github:Majestic-Escape/majestic-chat#packages/client

# Option C: Link locally during development
cd ../majestic-chat && npm link packages/client
cd ../user.website && npm link @majestic/chat-client
```

## Step 2: Add Environment Variable

```env
# .env.local
NEXT_PUBLIC_CHAT_URL=wss://chat.majesticescape.in
```

## Step 3: Add ChatProvider to App

```tsx
// app/providers.tsx
"use client";

import { ChatProvider } from "@majestic/chat-client";
import { useAuth } from "@/hooks/useAuth"; // Your existing auth

export function Providers({ children }) {
  const { user, token } = useAuth();

  return (
    <>
      {token ? (
        <ChatProvider
          socketUrl={process.env.NEXT_PUBLIC_CHAT_URL!}
          token={token}
        >
          {children}
        </ChatProvider>
      ) : (
        children
      )}
    </>
  );
}
```

## Step 4: Create Inbox Page

```tsx
// app/inbox/page.tsx
"use client";

import { useConversations } from "@majestic/chat-client";
import Link from "next/link";

export default function InboxPage() {
  const { conversations, isLoading, unreadTotal } = useConversations();

  if (isLoading) return <div>Loading...</div>;

  return (
    <div>
      <h1>Messages {unreadTotal > 0 && `(${unreadTotal})`}</h1>
      <ul>
        {conversations.map((conv) => (
          <li key={conv.id}>
            <Link href={`/inbox/${conv.id}`}>
              {conv.lastMessage?.content || "No messages yet"}
            </Link>
          </li>
        ))}
      </ul>
    </div>
  );
}
```

## Step 5: Create Chat Page

```tsx
// app/inbox/[conversationId]/page.tsx
"use client";

import { ChatWindow } from "@majestic/chat-client";
import { useAuth } from "@/hooks/useAuth";

export default function ChatPage({ params }) {
  const { user } = useAuth();

  return (
    <ChatWindow
      conversationId={params.conversationId}
      currentUserId={user.id}
      className='h-screen'
      onBack={() => router.back()}
    />
  );
}
```

## Step 6: Add Styles

```css
/* styles/chat.css */
.chat-window {
  /* your styles */
}
.message-list {
  /* your styles */
}
.message-bubble {
  /* your styles */
}
.message-bubble--sent {
  /* your styles */
}
.message-bubble--received {
  /* your styles */
}
.message-input {
  /* your styles */
}
.typing-indicator {
  /* your styles */
}
```

---

# ✅ FINAL CHECKLIST

## Before Handoff:

- [ ] All packages build without errors
- [ ] Server runs locally and connects to MongoDB
- [ ] Socket.io connects and authenticates
- [ ] Messages send and receive in real-time
- [ ] Typing indicators work
- [ ] Read receipts work
- [ ] Moderation flags phone numbers/emails
- [ ] README is complete
- [ ] Environment variables documented
- [ ] Integration guide tested

## Developer Needs:

1. **Access to:**
   - GitHub repo (majestic-chat)
   - MongoDB Atlas cluster
   - Redis instance (Upstash recommended)
   - Railway account

2. **Configuration:**
   - JWT_SECRET must match server.me
   - CORS_ORIGIN set correctly
   - DNS configured for chat subdomain

3. **Integration:**
   - Install @majestic/chat-client
   - Add ChatProvider
   - Create inbox pages
   - Style components

---

**Total Prompts: 25**
**Estimated Time: 10 days**
**Result: Production-ready chat system**
