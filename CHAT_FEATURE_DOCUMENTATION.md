# MajesticEscape Chat Feature Documentation

Complete developer documentation for the real-time chat feature across all repositories.

---

## Table of Contents

1. [Feature Overview](#section-1-feature-overview)
2. [Architecture Diagram](#section-2-architecture-diagram)
3. [Complete File Map](#section-3-complete-file-map)
4. [Local Development Setup](#section-4-local-development-setup)
5. [Environment Variables Reference](#section-5-environment-variables-reference)
6. [Development Deployment](#section-6-development-deployment)
7. [Production Deployment](#section-7-production-deployment)
8. [Pull Request Guidelines](#section-8-pull-request-guidelines)
9. [Troubleshooting](#section-9-troubleshooting)
10. [Quick Reference Commands](#section-10-quick-reference-commands)

---

## Section 1: Feature Overview

### What the Chat Feature Does

The chat feature enables real-time messaging between guests and property hosts on MajesticEscape.in.

**Guest Side:**

- View "Message Host" button on property listing pages
- Start new conversations with hosts about specific properties
- Send and receive real-time messages via `/contact_host/[propertyId]` page
- Access all conversations via `/messages` page
- See typing indicators when host is typing
- View read receipts (single check = sent, double check = read)

**Host Side:**

- Receive messages from potential guests via `/host/inbox` page
- Reply to inquiries about their properties
- See which property each conversation relates to
- Filter conversations (All / Unread)
- View typing indicators and read receipts

### User Flow Diagrams

**Guest Initiating Chat:**

```
┌─────────────────┐     ┌──────────────────┐     ┌─────────────────┐
│  Property Page  │────▶│ "Message Host"   │────▶│  Check if Conv  │
│  (stay/[id])    │     │  Button Click    │     │  Exists (API)   │
└─────────────────┘     └──────────────────┘     └────────┬────────┘
                                                          │
                    ┌─────────────────────────────────────┼─────────────────────────────────┐
                    │                                     │                                 │
                    ▼                                     ▼                                 │
          ┌─────────────────┐                   ┌─────────────────┐                        │
          │  Conversation   │                   │  No Existing    │                        │
          │  Exists         │                   │  Conversation   │                        │
          └────────┬────────┘                   └────────┬────────┘                        │
                   │                                     │                                 │
                   ▼                                     ▼                                 │
          ┌─────────────────┐                   ┌─────────────────┐                        │
          │  Go to Messages │                   │  Go to Contact  │                        │
          │  /messages      │                   │  Host Page      │                        │
          └─────────────────┘                   └─────────────────┘                        │
```

**Message Flow:**

```
┌──────────────┐    WebSocket     ┌──────────────┐    MongoDB     ┌──────────────┐
│   Guest      │◀───────────────▶│  Chat Server │◀─────────────▶│   Database   │
│   Browser    │                  │  (Socket.io) │                │              │
└──────────────┘                  └──────────────┘                └──────────────┘
                                         │
                                         │ WebSocket
                                         ▼
                                  ┌──────────────┐
                                  │    Host      │
                                  │   Browser    │
                                  └──────────────┘
```

### Key Features

| Feature             | Description                                            |
| ------------------- | ------------------------------------------------------ |
| Real-time Messaging | Messages delivered instantly via WebSocket (Socket.io) |
| Typing Indicators   | Shows when the other party is typing                   |
| Read Receipts       | Single check (sent), double check (read by recipient)  |
| Content Moderation  | Blocks phone numbers, emails, and contact info sharing |
| Message Persistence | All messages stored in MongoDB                         |
| Horizontal Scaling  | Redis adapter enables multiple server instances        |
| Rate Limiting       | 60 messages per minute per user                        |
| Reconnection        | Auto-reconnects with message recovery                  |

### Content Moderation

⚠️ **How It Works:**

The content moderation is implemented in `majestic-chat/packages/shared/src/moderation/patterns.ts` and executed by `ModerationService.ts` on the server.

**Detection Flow:**

1. User sends a message via Socket.io
2. Server receives message in `messageEvents.ts`
3. `ChatService.sendMessage()` calls `ModerationService.checkMessage()`
4. `checkText()` runs regex patterns against message content
5. If confidence ≥ 0.9 → Message BLOCKED (throws error, not saved)
6. If confidence ≥ 0.6 → Message FLAGGED (saved with flag)
7. If confidence < 0.6 → Message CLEAN (saved normally)

**Patterns Detected:**

| Pattern Type     | Examples                         | Weight |
| ---------------- | -------------------------------- | ------ |
| INDIAN_PHONE     | `+91 98765 43210`, `9876543210`  | 0.9    |
| SPACED_PHONE     | `9 8 7 6 5 4 3 2 1 0`            | 0.85   |
| EMAIL            | `user@example.com`               | 0.9    |
| OBFUSCATED_EMAIL | `user (at) example (dot) com`    | 0.85   |
| WHATSAPP         | `whatsapp`, `wa.me/`             | 0.7    |
| TELEGRAM         | `telegram`, `t.me/`, `@username` | 0.7    |
| SIGNAL           | `signal app`, `signal me`        | 0.7    |
| CONTACT_INTENT   | `call me on`, `text me at`       | 0.4    |

**Testing Content Moderation:**

```javascript
// In browser console or test
// These should be BLOCKED:
"My number is 9876543210"; // Indian phone
"Email me at test@gmail.com"; // Email
"Contact me on whatsapp"; // WhatsApp mention

// These should be ALLOWED:
"I'll arrive at 10am"; // Time, not phone
"The property looks great!"; // Normal message
```

---

## Section 2: Architecture Diagram

### System Architecture

```
┌─────────────────────────────────────────────────────────────────────────────────┐
│                              USER BROWSER                                        │
│  ┌─────────────────────────────────────────────────────────────────────────┐    │
│  │                        user.website (Next.js)                            │    │
│  │  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐     │    │
│  │  │ Property    │  │ Contact     │  │ Messages    │  │ Host Inbox  │     │    │
│  │  │ Page        │  │ Host Page   │  │ Page        │  │ Page        │     │    │
│  │  │ /stay/[id]  │  │ /contact_   │  │ /messages   │  │ /host/inbox │     │    │
│  │  │             │  │ host/[id]   │  │             │  │             │     │    │
│  │  └──────┬──────┘  └──────┬──────┘  └──────┬──────┘  └──────┬──────┘     │    │
│  │         │                │                │                │            │    │
│  │         └────────────────┴────────────────┴────────────────┘            │    │
│  │                                   │                                      │    │
│  │                          Socket.io Client                                │    │
│  └───────────────────────────────────┼──────────────────────────────────────┘    │
└──────────────────────────────────────┼──────────────────────────────────────────┘
                                       │
                                       │ WebSocket (wss://)
                                       │ REST API (https://)
                                       ▼
┌─────────────────────────────────────────────────────────────────────────────────┐
│                         majestic-chat (Socket.io Server)                         │
│  ┌─────────────────────────────────────────────────────────────────────────┐    │
│  │                        @majestic/chat-server                             │    │
│  │  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐     │    │
│  │  │ Socket      │  │ REST API    │  │ Chat        │  │ Moderation  │     │    │
│  │  │ Events      │  │ Routes      │  │ Service     │  │ Service     │     │    │
│  │  └──────┬──────┘  └──────┬──────┘  └──────┬──────┘  └──────┬──────┘     │    │
│  │         │                │                │                │            │    │
│  │         └────────────────┴────────────────┴────────────────┘            │    │
│  │                                   │                                      │    │
│  │                    ┌──────────────┴──────────────┐                       │    │
│  │                    ▼                             ▼                       │    │
│  │           ┌─────────────┐               ┌─────────────┐                  │    │
│  │           │  MongoDB    │               │   Redis     │                  │    │
│  │           │  (Messages) │               │  (Scaling)  │                  │    │
│  │           └─────────────┘               └─────────────┘                  │    │
│  └──────────────────────────────────────────────────────────────────────────┘    │
└─────────────────────────────────────────────────────────────────────────────────┘
                                       │
                                       │ REST API (property validation)
                                       ▼
┌─────────────────────────────────────────────────────────────────────────────────┐
│                           server.me (Express Backend)                            │
│  ┌─────────────────────────────────────────────────────────────────────────┐    │
│  │  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐                      │    │
│  │  │ Property    │  │ Auth        │  │ Guest       │                      │    │
│  │  │ Routes      │  │ Middleware  │  │ Routes      │                      │    │
│  │  └─────────────┘  └─────────────┘  └─────────────┘                      │    │
│  └──────────────────────────────────────────────────────────────────────────┘    │
└─────────────────────────────────────────────────────────────────────────────────┘
```

### Data Flow

1. **Authentication**: User logs in via server.me, receives JWT token
2. **Token Sharing**: Same JWT token used for both server.me and chat server (same JWT_SECRET)
3. **Conversation Creation**: Chat server validates hostId against property via server.me API
4. **Real-time Messages**: Sent via WebSocket, stored in MongoDB, broadcast to room participants
5. **Message History**: Loaded via REST API with pagination

### Repository Connections

| From          | To            | Protocol  | Purpose                       |
| ------------- | ------------- | --------- | ----------------------------- |
| user.website  | majestic-chat | WebSocket | Real-time messaging           |
| user.website  | majestic-chat | REST      | Conversation/message APIs     |
| user.website  | server.me     | REST      | Property data, authentication |
| majestic-chat | server.me     | REST      | Property host validation      |
| majestic-chat | MongoDB       | TCP       | Message/conversation storage  |
| majestic-chat | Redis         | TCP       | Socket.io scaling adapter     |

---

## Section 3: Complete File Map

### majestic-chat Repository (NEW)

**Root Files:**

| File Path              | Status | Purpose                                        |
| ---------------------- | ------ | ---------------------------------------------- |
| `package.json`         | NEW    | Monorepo root with workspace configuration     |
| `.env`                 | NEW    | Environment variables (copy from .env.example) |
| `.env.example`         | NEW    | Environment variable template                  |
| `README.md`            | NEW    | Project overview and quick start               |
| `INTEGRATION_GUIDE.md` | NEW    | Frontend integration instructions              |
| `DEPLOYMENT.md`        | NEW    | Deployment guide for all platforms             |
| `tsconfig.base.json`   | NEW    | Shared TypeScript configuration                |
| `test-chat.html`       | NEW    | Standalone HTML test page                      |

**packages/shared/ (Shared Types & Utilities):**

| File Path                            | Status | Purpose                                                   |
| ------------------------------------ | ------ | --------------------------------------------------------- |
| `package.json`                       | NEW    | Shared package configuration                              |
| `tsconfig.json`                      | NEW    | TypeScript config for shared                              |
| `src/index.ts`                       | NEW    | Main exports for shared package                           |
| `src/server.ts`                      | NEW    | Server-only exports                                       |
| `src/types.ts`                       | NEW    | Type re-exports                                           |
| `src/types/chat.types.ts`            | NEW    | Message, Conversation, Participant types with Zod schemas |
| `src/types/socket.types.ts`          | NEW    | Socket.io event type definitions                          |
| `src/schemas/Message.schema.ts`      | NEW    | MongoDB Message model with indexes                        |
| `src/schemas/Conversation.schema.ts` | NEW    | MongoDB Conversation model with indexes                   |
| `src/constants/events.ts`            | NEW    | Socket event name constants                               |
| `src/constants/config.ts`            | NEW    | Chat configuration (rate limits, timeouts)                |
| `src/errors/ChatError.ts`            | NEW    | Custom error class with error codes                       |
| `src/moderation/patterns.ts`         | NEW    | Contact info detection regex patterns                     |

**packages/server/ (Socket.io Server):**

| File Path                                    | Status | Purpose                                       |
| -------------------------------------------- | ------ | --------------------------------------------- |
| `package.json`                               | NEW    | Server package dependencies                   |
| `tsconfig.json`                              | NEW    | TypeScript config for server                  |
| `Dockerfile`                                 | NEW    | Docker build configuration                    |
| `src/index.ts`                               | NEW    | Server entry point, Express + Socket.io setup |
| `src/socket/server.ts`                       | NEW    | Socket.io server creation with Redis adapter  |
| `src/middleware/socketAuth.ts`               | NEW    | JWT authentication for WebSocket connections  |
| `src/events/messageEvents.ts`                | NEW    | Message send/read/join/leave handlers         |
| `src/events/typingEvents.ts`                 | NEW    | Typing indicator handlers                     |
| `src/routes/conversationRoutes.ts`           | NEW    | REST API for conversations and messages       |
| `src/services/ChatService.ts`                | NEW    | Business logic for chat operations            |
| `src/services/ModerationService.ts`          | NEW    | Content moderation checks                     |
| `src/repositories/MessageRepository.ts`      | NEW    | MongoDB message data access                   |
| `src/repositories/ConversationRepository.ts` | NEW    | MongoDB conversation data access              |
| `src/lib/database.ts`                        | NEW    | MongoDB connection with pooling               |
| `src/lib/redis.ts`                           | NEW    | Redis client for Socket.io adapter            |
| `src/lib/logger.ts`                          | NEW    | Pino logger configuration                     |

**packages/client/ (React SDK):**

| File Path                            | Status | Purpose                                   |
| ------------------------------------ | ------ | ----------------------------------------- |
| `package.json`                       | NEW    | Client SDK package configuration          |
| `tsconfig.json`                      | NEW    | TypeScript config for client              |
| `example.css`                        | NEW    | Example styles for chat components        |
| `src/index.ts`                       | NEW    | Main exports for client SDK               |
| `src/socket/client.ts`               | NEW    | ChatClient class for Socket.io connection |
| `src/context/ChatContext.tsx`        | NEW    | React context provider for chat           |
| `src/hooks/useChat.ts`               | NEW    | Hook for message operations               |
| `src/hooks/useConversations.ts`      | NEW    | Hook for conversation list                |
| `src/components/ChatWindow.tsx`      | NEW    | Full chat window component                |
| `src/components/MessageList.tsx`     | NEW    | Scrollable message list                   |
| `src/components/MessageBubble.tsx`   | NEW    | Individual message display                |
| `src/components/MessageInput.tsx`    | NEW    | Message input with send button            |
| `src/components/TypingIndicator.tsx` | NEW    | Typing dots animation                     |

### user.website Repository

**Chat Pages:**

| File Path                                              | Status | Purpose                                          |
| ------------------------------------------------------ | ------ | ------------------------------------------------ |
| `src/app/(landing)/contact_host/[propertyId]/page.jsx` | NEW    | Contact host page - guest initiates conversation |
| `src/app/chat/[propertyId]/page.jsx`                   | NEW    | Direct chat page with Socket.io integration      |
| `src/app/host/inbox/page.jsx`                          | NEW    | Host inbox - view and reply to guest inquiries   |
| `src/app/host/inbox/layout.jsx`                        | NEW    | Layout wrapper for host inbox                    |

**Modified Components:**

| File Path                                                 | Status   | Purpose                                                |
| --------------------------------------------------------- | -------- | ------------------------------------------------------ |
| `src/app/(landing)/stay/[id]/components/host-profile.jsx` | MODIFIED | Added "Message Host" button with chat navigation logic |
| `src/components/bottom-navigation.tsx`                    | MODIFIED | Added "Messages" link for logged-in users              |
| `src/components/user-dropdown-menu.jsx`                   | MODIFIED | Added "Messages" link in dropdown                      |
| `src/components/protected-route.tsx`                      | NEW      | Auth wrapper for protected chat pages                  |

**Configuration:**

| File Path    | Status   | Purpose                               |
| ------------ | -------- | ------------------------------------- |
| `.env.local` | MODIFIED | Added `NEXT_PUBLIC_CHAT_URL` variable |

### server.me Repository

| File Path        | Status   | Purpose                                           |
| ---------------- | -------- | ------------------------------------------------- |
| `.env`           | MODIFIED | Added `CHAT_SERVER_URL` variable (reference only) |
| `models/Chat.js` | EXISTING | Legacy chat model (NOT used by new system)        |
| `index.js`       | EXISTING | Main server entry (no chat-specific changes)      |

⚠️ **Note**: The new chat system uses its own MongoDB collections (`messages`, `conversations`) in the majestic-chat server. The existing `Chat.js` model in server.me is for legacy purposes and is NOT used by the new real-time chat feature.

### admin.site Repository

| File Path              | Status | Purpose                                           |
| ---------------------- | ------ | ------------------------------------------------- |
| No chat-specific files | N/A    | Admin panel does not currently have chat features |

---

## Section 4: Local Development Setup

### Prerequisites

| Requirement | Version                  | Check Command     |
| ----------- | ------------------------ | ----------------- |
| Node.js     | 20.x or higher           | `node --version`  |
| npm         | 9.x or higher            | `npm --version`   |
| MongoDB     | Atlas or local           | Connection string |
| Redis       | 7.x (optional for local) | `redis-cli ping`  |
| Git         | Any recent version       | `git --version`   |

### Step 1: Clone All Repositories

```bash
# Create workspace directory
mkdir majestic-escape
cd majestic-escape

# Clone all repos (adjust URLs to your actual repos)
git clone <user.website-repo-url> user.website
git clone <server.me-repo-url> server.me
git clone <admin.site-repo-url> admin.site
git clone <majestic-chat-repo-url> majestic-chat
```

### Step 2: Install Dependencies

```bash
# Install majestic-chat dependencies (monorepo)
cd majestic-chat
npm install

# Install user.website dependencies
cd ../user.website
npm install

# Install server.me dependencies
cd ../server.me
npm install

# Install admin.site dependencies (if needed)
cd ../admin.site
npm install
```

### Step 3: Configure Environment Files

**majestic-chat/.env**

```env
# MongoDB - Use your MongoDB Atlas connection string
MONGODB_URI=mongodb+srv://<username>:<password>@<cluster>.mongodb.net/<database>?retryWrites=true&w=majority

# Redis - Optional for local development (comment out to skip)
# REDIS_URL=redis://localhost:6379

# JWT Secret - MUST match server.me JWT_SECRET exactly
JWT_SECRET=<your-jwt-secret-from-server-me>

# Server port
PORT=3001

# CORS - Allow local development origins
CORS_ORIGIN=http://localhost:3000,http://localhost:3001,http://localhost:3002

# Main API URL for property validation
MAIN_API_URL=http://localhost:5005/api/v1
```

**user.website/.env.local** (add/update these lines)

```env
# Existing variables...

# Chat Server URL
NEXT_PUBLIC_CHAT_URL=http://localhost:3001
```

**server.me/.env** (add this line)

```env
# Existing variables...

# Chat Server URL (for reference)
CHAT_SERVER_URL=http://localhost:3001
```

⚠️ **CRITICAL**: The `JWT_SECRET` in majestic-chat MUST exactly match the `JWT_SECRET` in server.me. If they don't match, authentication will fail.

### Step 4: Build majestic-chat Packages

```bash
cd majestic-chat

# Build shared package first (required by server and client)
npm run build:shared

# Build server package
npm run build:server

# Build client package (if using SDK components)
npm run build:client

# Or build all at once
npm run build
```

### Step 5: Start Services (In Order)

⚠️ **Start services in this exact order:**

**Terminal 1 - MongoDB** (if running locally)

```bash
# Skip if using MongoDB Atlas
mongod
```

**Terminal 2 - Redis** (optional for local)

```bash
# Skip if not using Redis locally
redis-server
```

**Terminal 3 - server.me (Express Backend)**

```bash
cd server.me
npm run dev
# Should start on http://localhost:5005
```

**Terminal 4 - majestic-chat (Chat Server)**

```bash
cd majestic-chat
npm run dev:server
# Should start on http://localhost:3001
```

**Terminal 5 - user.website (Next.js Frontend)**

```bash
cd user.website
npm run dev
# Should start on http://localhost:3000
```

### Step 6: Verify Setup

✅ **Checklist:**

- [ ] server.me running: Visit http://localhost:5005 - should show "Majestic Escape backend is live"
- [ ] Chat server running: Visit http://localhost:3001/health - should return `{"status":"ok"}`
- [ ] user.website running: Visit http://localhost:3000
- [ ] MongoDB connected: Check chat server logs for "MongoDB connected successfully"
- [ ] Test chat: Log in, go to a property page, click "Message Host"

### Test URLs

| Service            | URL                                                             | Expected Response                              |
| ------------------ | --------------------------------------------------------------- | ---------------------------------------------- |
| server.me          | http://localhost:5005                                           | `{"status":"Majestic Escape backend is live"}` |
| Chat Server Health | http://localhost:3001/health                                    | `{"status":"ok","timestamp":"..."}`            |
| user.website       | http://localhost:3000                                           | Homepage loads                                 |
| Contact Host       | http://localhost:3000/contact_host/[propertyId]?hostId=[hostId] | Contact form                                   |
| Host Inbox         | http://localhost:3000/host/inbox                                | Host message inbox                             |

---

## Section 5: Environment Variables Reference

### majestic-chat

| Variable       | Required      | Description                       | Local Example                                        | Dev Example                             | Prod Example                                              |
| -------------- | ------------- | --------------------------------- | ---------------------------------------------------- | --------------------------------------- | --------------------------------------------------------- |
| `MONGODB_URI`  | ✅ Yes        | MongoDB connection string         | `mongodb+srv://user:pass@cluster.mongodb.net/dbname` | Same                                    | Same                                                      |
| `JWT_SECRET`   | ✅ Yes        | JWT secret (MUST match server.me) | `<your-secret>`                                      | `<your-secret>`                         | `<your-secret>`                                           |
| `PORT`         | No            | Server port                       | `3001`                                               | `3001`                                  | `3001`                                                    |
| `CORS_ORIGIN`  | ✅ Yes (prod) | Allowed origins (comma-separated) | `http://localhost:3000,http://localhost:3001`        | `https://user.me.coderelix.in`          | `https://www.majesticescape.in,https://majesticescape.in` |
| `REDIS_URL`    | No            | Redis connection for scaling      | `redis://localhost:6379`                             | `redis://...railway.internal:6379`      | `redis://...railway.internal:6379`                        |
| `MAIN_API_URL` | No            | server.me API URL for validation  | `http://localhost:5005/api/v1`                       | `https://server.me.coderelix.in/api/v1` | `https://api.majesticescape.in/api/v1`                    |
| `NODE_ENV`     | No            | Environment mode                  | `development`                                        | `development`                           | `production`                                              |
| `LOG_LEVEL`    | No            | Logging verbosity                 | `debug`                                              | `info`                                  | `info`                                                    |

### user.website

| Variable                   | Required | Description             | Local Example                  | Dev Example                             | Prod Example                           |
| -------------------------- | -------- | ----------------------- | ------------------------------ | --------------------------------------- | -------------------------------------- |
| `NEXT_PUBLIC_CHAT_URL`     | ✅ Yes   | Chat server URL         | `http://localhost:3001`        | `https://chat.coderelix.in`             | `https://chat.majesticescape.in`       |
| `NEXT_PUBLIC_API_BASE_URL` | ✅ Yes   | server.me API URL       | `http://localhost:5005/api/v1` | `https://server.me.coderelix.in/api/v1` | `https://api.majesticescape.in/api/v1` |
| `JWT_SECRET`               | ✅ Yes   | JWT secret for NextAuth | `<nextauth-secret>`            | `<nextauth-secret>`                     | `<nextauth-secret>`                    |

⚠️ **Note**: user.website has its own `JWT_SECRET` for NextAuth, but the chat server uses server.me's `JWT_SECRET` for token verification. These are different secrets.

### server.me

| Variable          | Required | Description           | Local Example                                        | Dev Example                 | Prod Example                     |
| ----------------- | -------- | --------------------- | ---------------------------------------------------- | --------------------------- | -------------------------------- |
| `JWT_SECRET`      | ✅ Yes   | JWT secret for auth   | `<your-secret>`                                      | `<your-secret>`             | `<your-secret>`                  |
| `DB_URI`          | ✅ Yes   | MongoDB connection    | `mongodb+srv://user:pass@cluster.mongodb.net/dbname` | Same                        | Same                             |
| `PORT`            | No       | Server port           | `5005`                                               | `5005`                      | `5005`                           |
| `CHAT_SERVER_URL` | No       | Chat server reference | `http://localhost:3001`                              | `https://chat.coderelix.in` | `https://chat.majesticescape.in` |

### admin.site

| Variable                   | Required | Description |
| -------------------------- | -------- | ----------- |
| No chat-specific variables | -        | -           |

---

## Section 6: Development Deployment (user.me.coderelix.in)

### Step 1: Deploy majestic-chat Server

**Option A: Railway (Recommended)**

1. Push majestic-chat to GitHub
2. Go to [railway.app](https://railway.app) and create new project
3. Select "Deploy from GitHub repo"
4. Choose the majestic-chat repository
5. Set root directory to `packages/server`
6. Add environment variables:

```env
MONGODB_URI=<your-mongodb-connection-string>
JWT_SECRET=<your-jwt-secret-matching-server-me>
CORS_ORIGIN=https://user.me.coderelix.in
MAIN_API_URL=https://server.me.coderelix.in/api/v1
NODE_ENV=production
PORT=3001
```

7. Add Redis service in Railway (click "New" → "Database" → "Redis")
8. Copy Redis URL to `REDIS_URL` environment variable
9. Deploy and note the generated URL (e.g., `majestic-chat-dev.up.railway.app`)

### Step 2: Configure DNS for Chat Subdomain

Add DNS record for `chat.coderelix.in`:

| Type  | Name | Value                              |
| ----- | ---- | ---------------------------------- |
| CNAME | chat | `majestic-chat-dev.up.railway.app` |

### Step 3: Set Environment Variables for Dev

**user.website (Vercel/hosting platform):**

```env
NEXT_PUBLIC_CHAT_URL=https://chat.coderelix.in
```

**majestic-chat (Railway):**

```env
CORS_ORIGIN=https://user.me.coderelix.in,https://admin.me.coderelix.in
```

### Step 4: Deploy user.website Changes

```bash
cd user.website
git add .
git commit -m "feat: add chat feature integration"
git push origin main
# Vercel will auto-deploy
```

### Step 5: Deploy server.me Changes

```bash
cd server.me
git add .
git commit -m "feat: add chat server URL config"
git push origin main
# Deploy to your hosting platform
```

### Step 6: Verification Checklist

✅ **Dev Deployment Checklist:**

- [ ] Chat server health check: `curl https://chat.coderelix.in/health`
- [ ] WebSocket connection: Open browser console on user.me.coderelix.in, check for "Socket connected"
- [ ] Create conversation: Click "Message Host" on a property
- [ ] Send message: Type and send a test message
- [ ] Receive message: Open in another browser/incognito, verify message appears
- [ ] Read receipts: Verify double-check appears when message is read
- [ ] Content moderation: Try sending a phone number, should be blocked
- [ ] Host inbox: Log in as host, check /host/inbox shows guest messages

---

## Section 7: Production Deployment (majesticescape.in)

### Pre-Deployment Checklist

⚠️ **Before deploying to production:**

- [ ] All features tested on development environment
- [ ] No console errors in browser
- [ ] WebSocket connections stable
- [ ] Content moderation working
- [ ] Rate limiting tested
- [ ] Mobile responsiveness verified
- [ ] Host inbox working correctly
- [ ] Error tracking configured (Sentry recommended)

### Step 1: Backup Procedures

```bash
# Export MongoDB collections (if needed)
mongodump --uri="<your-mongodb-uri>" --collection=conversations --out=backup/
mongodump --uri="<your-mongodb-uri>" --collection=messages --out=backup/
```

### Step 2: Deploy Chat Server to Production

**Railway Production Setup:**

1. Create new Railway project for production (separate from dev)
2. Deploy from same GitHub repo
3. Set production environment variables:

```env
MONGODB_URI=<your-production-mongodb-uri>
JWT_SECRET=<your-jwt-secret-matching-server-me>
CORS_ORIGIN=https://www.majesticescape.in,https://majesticescape.in,https://admin.majesticescape.in
MAIN_API_URL=https://api.majesticescape.in/api/v1
NODE_ENV=production
PORT=3001
LOG_LEVEL=info
```

4. Add Redis service for production
5. Note the production URL

### Step 3: Configure Production DNS

Add DNS record for `chat.majesticescape.in`:

| Type  | Name | Value                           |
| ----- | ---- | ------------------------------- |
| CNAME | chat | `<your-railway-production-url>` |

⚠️ **Wait for DNS propagation (up to 24 hours)**

### Step 4: Set Production Environment Variables

**user.website (Production):**

```env
NEXT_PUBLIC_CHAT_URL=https://chat.majesticescape.in
```

**majestic-chat (Production):**

```env
CORS_ORIGIN=https://www.majesticescape.in,https://majesticescape.in
```

### Step 5: Deploy Frontend Changes

```bash
cd user.website
git checkout main
git pull origin main
# Ensure NEXT_PUBLIC_CHAT_URL is set in production env
git push origin main
# Production deployment triggers
```

### Step 6: Deploy Backend Changes

```bash
cd server.me
git checkout main
git pull origin main
git push origin main
# Production deployment triggers
```

### Step 7: Post-Deployment Verification

✅ **Production Verification Checklist:**

- [ ] Health check: `curl https://chat.majesticescape.in/health`
- [ ] SSL certificate valid (check browser padlock)
- [ ] WebSocket connects over WSS (not WS)
- [ ] Login and navigate to property page
- [ ] Click "Message Host" - contact page loads
- [ ] Send test message - delivered
- [ ] Check from host account at /host/inbox - message received
- [ ] Reply from host - guest receives
- [ ] Typing indicator works
- [ ] Read receipts work
- [ ] Try sending phone number - blocked
- [ ] Test on mobile device
- [ ] Check error tracking dashboard

### Step 8: Rollback Procedure

⚠️ **If something fails:**

**Rollback Chat Server:**

```bash
# Railway: Use the "Rollback" button in deployment history
# Or redeploy previous commit
```

**Rollback user.website:**

```bash
cd user.website
git revert HEAD
git push origin main
```

**Disable Chat Feature (Emergency):**

1. In user.website `host-profile.jsx`, hide the "Message Host" button:

```jsx
// Add condition to hide button:
{
  false && !isOwnListing && <Button>Message host</Button>;
}
```

2. Deploy the change
3. Investigate and fix the issue
4. Re-enable when ready

### Monitoring Setup

**Recommended monitoring:**

1. **Uptime monitoring**: UptimeRobot or similar for `https://chat.majesticescape.in/health`
2. **Error tracking**: Sentry for both chat server and frontend
3. **Logs**: Railway provides built-in logging
4. **Alerts**: Set up alerts for:
   - Server downtime
   - High error rates
   - Memory/CPU spikes
   - Database connection failures

---

## Section 8: Pull Request Guidelines

### Files to Review Together

When reviewing chat-related PRs, these files should be reviewed as a group:

**majestic-chat changes:**

- `packages/shared/src/types/*.ts` - Type changes affect all packages
- `packages/shared/src/schemas/*.ts` - Schema changes affect database
- `packages/server/src/services/*.ts` - Business logic changes
- `packages/server/src/events/*.ts` - Socket event changes

**user.website changes:**

- `src/app/(landing)/contact_host/[propertyId]/page.jsx` - Guest contact form
- `src/app/host/inbox/page.jsx` - Host inbox
- `src/app/chat/[propertyId]/page.jsx` - Direct chat page
- `src/app/(landing)/stay/[id]/components/host-profile.jsx` - Entry point button
- `src/components/bottom-navigation.tsx` - Mobile nav
- `src/components/user-dropdown-menu.jsx` - Desktop nav
- `.env.local` - Environment configuration

### Potential Merge Conflict Files

⚠️ **High conflict risk:**

| File                                                                   | Reason                                |
| ---------------------------------------------------------------------- | ------------------------------------- |
| `user.website/.env.local`                                              | Multiple developers may add variables |
| `user.website/src/app/(landing)/stay/[id]/components/host-profile.jsx` | Frequently modified component         |
| `user.website/src/components/bottom-navigation.tsx`                    | Navigation changes                    |
| `user.website/src/components/user-dropdown-menu.jsx`                   | Menu changes                          |
| `majestic-chat/packages/shared/src/types/chat.types.ts`                | Type definitions may conflict         |
| `server.me/.env`                                                       | Environment variable additions        |

### Recommended PR Review Order

1. **First**: Review `majestic-chat/packages/shared` changes
   - Types and schemas are foundational
   - Breaking changes here affect everything

2. **Second**: Review `majestic-chat/packages/server` changes
   - API and socket event changes
   - Database operations

3. **Third**: Review `majestic-chat/packages/client` changes
   - SDK components and hooks
   - Only if using the SDK

4. **Fourth**: Review `user.website` changes
   - Frontend integration
   - UI/UX changes

5. **Last**: Review `server.me` changes
   - Usually minimal for chat feature
   - Environment variable additions

### Testing Requirements Before Merge

**Required tests:**

- [ ] Local development works with all services running
- [ ] Can create new conversation via contact_host page
- [ ] Can send and receive messages
- [ ] Host inbox shows guest messages correctly
- [ ] Typing indicators work
- [ ] Read receipts work
- [ ] Content moderation blocks phone numbers
- [ ] Error handling works (disconnect/reconnect)
- [ ] Mobile responsive (bottom nav shows Messages)

**For schema changes:**

- [ ] Existing conversations still load
- [ ] Existing messages still display
- [ ] No data migration required (or migration script provided)

**For API changes:**

- [ ] Backward compatible or version bumped
- [ ] Error responses documented
- [ ] Rate limiting still works

---

## Section 9: Troubleshooting

### Common Issues and Solutions

| Issue                           | Cause                        | Solution                                                  |
| ------------------------------- | ---------------------------- | --------------------------------------------------------- |
| Chat not connecting             | Wrong `NEXT_PUBLIC_CHAT_URL` | Verify URL in `.env.local` matches chat server            |
| Chat not connecting             | CORS error                   | Add frontend origin to `CORS_ORIGIN` in chat server       |
| Chat not connecting             | JWT_SECRET mismatch          | Ensure chat server `JWT_SECRET` matches server.me exactly |
| "Authentication required" error | Token not in localStorage    | User needs to log in first                                |
| "Authentication required" error | Token expired                | User needs to re-login                                    |
| Messages not sending            | Socket not connected         | Check connection status, verify WebSocket URL             |
| Messages not sending            | Rate limited                 | Wait 60 seconds, reduce message frequency                 |
| Messages blocked                | Content moderation           | Remove phone numbers/emails from message                  |
| "Conversation not found"        | Invalid conversationId       | Verify conversation was created successfully              |
| "User not participant"          | Wrong userId                 | Check token contains correct userId                       |
| Property validation fails       | server.me API down           | Check server.me is running and accessible                 |
| Property validation fails       | Wrong `MAIN_API_URL`         | Verify URL points to correct server.me instance           |
| Redis connection failed         | Redis not running            | Start Redis or remove `REDIS_URL` for single-server mode  |
| MongoDB connection failed       | Wrong connection string      | Verify `MONGODB_URI` is correct                           |
| WebSocket upgrade failed        | Nginx not configured         | Add WebSocket upgrade headers to Nginx config             |
| SSL/WSS errors                  | Certificate issues           | Ensure SSL is properly configured for chat subdomain      |
| Host inbox empty                | User not a host              | User must have host role in conversations                 |
| Guest details not loading       | API endpoint wrong           | Check `/guests/info/:userId` endpoint in server.me        |

### Debug Mode

**Enable debug logging in chat server:**

```env
LOG_LEVEL=debug
```

**Enable debug in browser:**

```javascript
// In browser console
localStorage.setItem("debug", "socket.io-client:*");
// Refresh page
```

### Checking Connection Status

**In browser console:**

```javascript
// Check if socket is connected
// Look for these logs:
// "[Chat] Socket connected, socket id: ..."
// "[HostInbox] Socket connected"
// "[Chat] Joining room on connect: ..."
```

**Chat server logs to look for:**

```
INFO: Client connected
INFO: Socket authenticated
INFO: Joined conversation room
INFO: Message sent successfully
```

### API Testing Commands

**PowerShell:**

```powershell
# Health check
Invoke-RestMethod -Uri "http://localhost:3001/health"

# Get conversations (replace TOKEN)
$headers = @{ Authorization = "Bearer YOUR_JWT_TOKEN" }
Invoke-RestMethod -Uri "http://localhost:3001/api/chat/conversations" -Headers $headers

# Create conversation
$body = @{
    propertyId = "PROPERTY_ID"
    hostId = "HOST_ID"
    guestId = "GUEST_ID"
} | ConvertTo-Json
Invoke-RestMethod -Uri "http://localhost:3001/api/chat/conversations" -Method Post -Headers $headers -Body $body -ContentType "application/json"
```

**curl (Git Bash/WSL):**

```bash
# Health check
curl http://localhost:3001/health

# Get conversations
curl -H "Authorization: Bearer YOUR_JWT_TOKEN" http://localhost:3001/api/chat/conversations
```

---

## Section 10: Quick Reference Commands

### Local Development

```bash
# ===== MAJESTIC-CHAT =====
cd majestic-chat

# Install dependencies
npm install

# Build all packages
npm run build

# Build individual packages
npm run build:shared
npm run build:server
npm run build:client

# Start development server
npm run dev:server

# Clean build artifacts
npm run clean

# ===== USER.WEBSITE =====
cd user.website

# Install dependencies
npm install

# Start development server
npm run dev

# Build for production
npm run build

# ===== SERVER.ME =====
cd server.me

# Install dependencies
npm install

# Start development server
npm run dev

# Start production server
npm run railway
```

### Development Deployment

```bash
# Deploy chat server to Railway
cd majestic-chat
git add .
git commit -m "feat: chat feature update"
git push origin main
# Railway auto-deploys from main branch

# Deploy user.website to Vercel
cd user.website
git add .
git commit -m "feat: chat integration update"
git push origin main
# Vercel auto-deploys from main branch

# Deploy server.me
cd server.me
git add .
git commit -m "chore: update chat config"
git push origin main
```

### Production Deployment

```bash
# Same as development, but ensure:
# 1. Environment variables are set for production
# 2. CORS_ORIGIN includes production domains
# 3. NODE_ENV=production
```

### Logs and Debugging

```bash
# Railway logs
railway logs

# Docker logs (if using Docker)
docker logs majestic-chat-server

# Heroku logs (if using Heroku)
heroku logs --tail

# Check chat server health
curl https://chat.majesticescape.in/health

# Test WebSocket connection (browser console)
# Open https://www.majesticescape.in
# Press F12 -> Console
# Look for "[Chat] Socket connected"
```

### Database Commands

```bash
# Connect to MongoDB (using mongosh)
mongosh "<your-mongodb-connection-string>"

# View conversations
db.conversations.find().limit(5).pretty()

# View messages for a conversation
db.messages.find({ conversationId: "CONVERSATION_ID" }).sort({ createdAt: -1 }).limit(10).pretty()

# Count messages
db.messages.countDocuments()

# Count conversations
db.conversations.countDocuments()
```

### Emergency Commands

```bash
# Stop chat server (Railway)
# Use Railway dashboard -> Settings -> Delete service

# Rollback deployment (Railway)
# Use Railway dashboard -> Deployments -> Rollback

# Clear Redis cache (if needed)
redis-cli FLUSHALL

# Force disconnect all sockets (restart server)
# Redeploy the chat server
```

---

## Additional Resources

- **majestic-chat README**: `majestic-chat/README.md`
- **Integration Guide**: `majestic-chat/INTEGRATION_GUIDE.md`
- **Deployment Guide**: `majestic-chat/DEPLOYMENT.md`
- **Socket.io Documentation**: https://socket.io/docs/v4/
- **Railway Documentation**: https://docs.railway.app/

---

_Last updated: January 2026_
_Version: 1.0.0_
