# MajesticEscape Chat System - Complete Discussion Summary

## Document Created: January 2026
## Purpose: Summary of all discussions for building a real-time chat system

---

# 📋 TABLE OF CONTENTS

1. [Project Overview](#1-project-overview)
2. [Initial Requirements](#2-initial-requirements)
3. [Architecture Decisions](#3-architecture-decisions)
4. [Technical Design](#4-technical-design)
5. [Repository Strategy](#5-repository-strategy)
6. [Vibe Coding Strategy](#6-vibe-coding-strategy)
7. [Prompt Execution Plan](#7-prompt-execution-plan)
8. [Deliverables Created](#8-deliverables-created)
9. [Next Steps](#9-next-steps)

---

# 1. PROJECT OVERVIEW

## What is MajesticEscape?
- A property rental platform (like Airbnb) at **www.majesticescape.in**
- Connects property **Hosts** with **Guests**
- Currently has 3 repositories:
  - `server.me` - Express.js backend (Node, MongoDB)
  - `user.website` - Next.js frontend (TypeScript, Tailwind)
  - `admin.site` - Admin panel (Next.js, Tailwind)

## What We're Building
A **real-time chat system** that allows:
- Guests to message Hosts about properties
- Instant message delivery (like WhatsApp)
- Typing indicators ("User is typing...")
- Read receipts (blue ticks)
- Content moderation to prevent contact info sharing

---

# 2. INITIAL REQUIREMENTS

## Functional Requirements
| Requirement | Description |
|-------------|-------------|
| Real-time messaging | Instant delivery between host and guest |
| Message persistence | Store in MongoDB |
| Typing indicators | Show when someone is typing |
| Read receipts | Show when message is read |
| File/image sharing | Upload and share media |
| Conversation history | Paginated message loading |
| Unread counts | Badge showing unread messages |

## Technical Requirements
| Requirement | Description |
|-------------|-------------|
| Web support | Works on Next.js frontend (Vercel) |
| Mobile-ready | Future React Native app support |
| Scalable | From startup to 100K+ users |
| Cost-conscious | Open-source focused, minimal costs |
| Content moderation | Detect phone numbers, emails, WhatsApp mentions |

## Platform Constraints
- Main website hosted on **Vercel** (serverless, 10s timeout)
- Vercel CANNOT run persistent WebSocket connections
- Need separate always-on server for Socket.io

---

# 3. ARCHITECTURE DECISIONS

## Key Decision: Separate Repository
**Question:** Should chat be in the existing repos or a new repo?

**Answer:** NEW SEPARATE REPOSITORY (`majestic-chat`)

### Reasons:
| Benefit | Explanation |
|---------|-------------|
| Independent deployment | Socket.io needs Railway/Fly.io, not Vercel |
| Team isolation | Build & test without touching production |
| Easier handoff | Developer just clones, configures, deploys |
| Microservice pattern | Chat is a distinct bounded context |
| Scaling independence | Chat can scale separately |

## Architecture Pattern: Monorepo with 3 Packages

```
majestic-chat/                    # NEW REPO
├── packages/
│   ├── shared/                   # @majestic/chat-shared
│   │   └── Types, schemas, moderation (internal)
│   │
│   ├── server/                   # @majestic/chat-server
│   │   └── Socket.io server → Deploys to Railway
│   │
│   └── client/                   # @majestic/chat-client
│       └── React SDK → Installs in user.website
```

## System Flow
```
┌─────────────────────────────────────────────────────────────┐
│                    EXISTING SYSTEM                           │
│   user.website ◄──REST──► server.me                         │
│        │                       │                             │
│        │ WebSocket             │ JWT Verify                  │
│        ▼                       ▼                             │
│   ┌─────────────────────────────────────────────────────┐   │
│   │              majestic-chat (NEW)                     │   │
│   │   Socket.io Server (Railway) ◄── React SDK          │   │
│   │   MongoDB (same Atlas) ◄── Moderation               │   │
│   └─────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────┘
```

---

# 4. TECHNICAL DESIGN

## Tech Stack

| Component | Technology | Version |
|-----------|------------|---------|
| Real-time | Socket.io | 4.7.x |
| Scaling | @socket.io/redis-adapter | 8.x |
| Database | MongoDB via Mongoose | 8.x |
| Cache | Redis (Upstash) | - |
| Queue | BullMQ | 5.x |
| Storage | Cloudflare R2 | - |
| Validation | Zod | 3.x |
| Frontend | React | 18.x |
| Language | TypeScript | 5.3+ |

## Database Collections

### messages
```javascript
{
  _id: ObjectId,
  conversationId: ObjectId,
  senderId: ObjectId,
  clientMessageId: String,        // For idempotency
  type: 'text' | 'image' | 'file' | 'system',
  content: {
    text: String,
    attachments: [{
      url: String,
      type: String,
      filename: String,
      size: Number,
      thumbnailUrl: String
    }]
  },
  moderation: {
    status: 'clean' | 'flagged' | 'blocked',
    flags: [String],
    confidence: Number
  },
  readBy: [{ userId: ObjectId, readAt: Date }],
  status: 'sending' | 'sent' | 'delivered' | 'read' | 'failed',
  createdAt: Date,
  updatedAt: Date
}
```

### conversations
```javascript
{
  _id: ObjectId,
  propertyId: ObjectId,
  bookingId: ObjectId,            // Optional
  participants: [{
    userId: ObjectId,
    role: 'host' | 'guest',
    joinedAt: Date
  }],
  lastMessage: {
    content: String,
    senderId: ObjectId,
    sentAt: Date
  },
  unreadCount: { [userId]: Number },
  status: 'active' | 'archived' | 'blocked',
  createdAt: Date,
  updatedAt: Date
}
```

## Socket.io Events

### Client → Server
| Event | Payload | Description |
|-------|---------|-------------|
| `message:send` | `{ conversationId, content, type, clientMessageId }` | Send message |
| `message:read` | `{ conversationId, messageIds }` | Mark as read |
| `conversation:join` | `{ conversationId }` | Join room |
| `conversation:leave` | `{ conversationId }` | Leave room |
| `typing:start` | `{ conversationId }` | Started typing |
| `typing:stop` | `{ conversationId }` | Stopped typing |

### Server → Client
| Event | Payload | Description |
|-------|---------|-------------|
| `message:new` | `{ message, conversationId }` | New message |
| `message:sent` | `{ messageId, clientMessageId }` | Confirm sent |
| `message:read` | `{ conversationId, messageIds, userId }` | Read receipt |
| `typing:update` | `{ conversationId, userId, isTyping }` | Typing status |
| `error` | `{ code, message }` | Error |

## Content Moderation

### Detection Patterns (Indian Market)
| Pattern | Regex | Examples |
|---------|-------|----------|
| Indian Phone | `/(\+91[\s.-]?)?[6-9]\d{4}[\s.-]?\d{5}/gi` | +91 98765 43210 |
| Spaced Phone | `/[6-9](\s*\d){9}/gi` | 9 8 7 6 5 4 3 2 1 0 |
| Email | `/[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/gi` | user@example.com |
| WhatsApp | `/whats?\s*app\|wa\.me/gi` | WhatsApp, wa.me |
| Telegram | `/telegram\|t\.me\|@[a-z0-9_]{5,}/gi` | @username |

### Moderation Actions
| Confidence | Status | Action |
|------------|--------|--------|
| ≥ 0.9 | blocked | Message blocked, warning shown |
| ≥ 0.6 | flagged | Message delivered with warning |
| < 0.6 | clean | Normal delivery |

## Scaling Strategy

| Stage | Users | Infrastructure | Cost |
|-------|-------|----------------|------|
| Startup | 0-1K | 1 Socket.io, MongoDB M10 | $50-100/mo |
| Growth | 1K-10K | 2-3 Socket.io + Redis | $200-400/mo |
| Scale | 10K-100K | Auto-scaling cluster | $800-1,500/mo |
| Enterprise | 100K+ | Multi-region | $3,000+/mo |

---

# 5. REPOSITORY STRATEGY

## Final Structure
```
Majestic-Escape (GitHub Organization)
├── server.me          (existing) - Express backend
├── user.website       (existing) - Next.js frontend
├── admin.site         (existing) - Admin panel
└── majestic-chat      (NEW)      - Chat system monorepo
```

## Deployment Map
| Package | Platform | Domain |
|---------|----------|--------|
| @majestic/chat-server | Railway | chat.majesticescape.in |
| @majestic/chat-client | npm package | Installed in user.website |
| @majestic/chat-shared | Internal | Not deployed separately |

## Integration Points
1. **JWT Authentication**: Same secret as server.me
2. **MongoDB**: Same Atlas cluster, new collections
3. **Frontend**: Client SDK installed via npm

---

# 6. VIBE CODING STRATEGY

## What is Vibe Coding?
Building software through natural language prompts to AI coding assistants (GitHub Copilot). Key insight: It's NOT about being vague - it's about being extremely precise.

## The 6 Golden Rules

| Rule | Description |
|------|-------------|
| 1 | **ONE task per prompt** - Never combine multiple features |
| 2 | **Specify exact versions** - "Socket.io 4.7.x" not just "Socket.io" |
| 3 | **Provide file paths** - "src/services/ChatService.ts" not "create a service" |
| 4 | **Include acceptance criteria** - "Done when: tests pass, TypeScript compiles" |
| 5 | **Reference existing code** - "Follow pattern in src/services/AuthService.ts" |
| 6 | **Demand verification** - "Verify by running: npm test, npm run lint" |

## Master Prompt Template

```
## CONTEXT
[Current state, what exists, what you're building]

## TASK
[Single, specific action - ONE thing only]

## SPECIFICATIONS
[Exact file path, method signatures, types to use]

## CONSTRAINTS
[What NOT to do - prevents scope creep]

## REFERENCES
[@workspace path/to/file - files to load first]

## ACCEPTANCE CRITERIA
[How to verify completion]

## VERIFICATION
[Exact commands to run]
```

## Anti-Hallucination Techniques

1. **Specificity Ladder**: More specific = fewer hallucinations
2. **Constraint Anchoring**: Explicit "DO NOT" sections
3. **Show Don't Tell**: Provide exact code patterns to follow
4. **Version Pinning**: Always specify library versions
5. **Context Loading**: Use @workspace to load relevant files
6. **Session Summaries**: Recap what's built after 10+ prompts

## Phased Build Order

```
Phase 1: Types & Interfaces     → Creates contracts
Phase 2: Database Schemas       → Makes types persistent
Phase 3: Repository Layer       → CRUD operations
Phase 4: Service Layer          → Business logic
Phase 5: Socket Events          → Real-time handlers
Phase 6: REST API               → HTTP endpoints
Phase 7: Frontend Components    → React UI
Phase 8: Integration Tests      → Verify everything
```

---

# 7. PROMPT EXECUTION PLAN

## Overview
- **Total Prompts**: 25
- **Estimated Time**: 10 days
- **Verification**: After EVERY prompt

## Week 1: Foundation

### Day 1: Setup
| Prompt | Task | Output |
|--------|------|--------|
| 0.1 | Initialize monorepo | Project structure |
| 0.2 | Copilot instructions | .github/copilot-instructions.md |

### Day 1-2: Shared Types
| Prompt | Task | Output |
|--------|------|--------|
| 1.1 | Chat types | packages/shared/src/types/chat.types.ts |
| 1.2 | Socket event types | packages/shared/src/types/socket.types.ts |
| 1.3 | Error types | packages/shared/src/errors/ChatError.ts |
| 1.4 | Constants | packages/shared/src/constants/*.ts |
| 1.5 | Index exports | packages/shared/src/index.ts |

### Day 2-3: Database
| Prompt | Task | Output |
|--------|------|--------|
| 2.1 | Message schema | packages/shared/src/schemas/Message.schema.ts |
| 2.2 | Conversation schema | packages/shared/src/schemas/Conversation.schema.ts |
| 2.3 | Moderation patterns | packages/shared/src/moderation/patterns.ts |
| 2.4 | Final index update | Updated exports |

## Week 2: Server

### Day 4: Infrastructure
| Prompt | Task | Output |
|--------|------|--------|
| 3.1 | Database connection | packages/server/src/lib/database.ts |
| 3.2 | Redis connection | packages/server/src/lib/redis.ts |
| 3.3 | Message repository | packages/server/src/repositories/MessageRepository.ts |
| 3.4 | Conversation repository | packages/server/src/repositories/ConversationRepository.ts |

### Day 5: Services
| Prompt | Task | Output |
|--------|------|--------|
| 4.1 | Moderation service | packages/server/src/services/ModerationService.ts |
| 4.2 | Chat service | packages/server/src/services/ChatService.ts |

### Day 6: Socket.io
| Prompt | Task | Output |
|--------|------|--------|
| 5.1 | Socket server | packages/server/src/socket/server.ts |
| 5.2 | Auth middleware | packages/server/src/middleware/socketAuth.ts |
| 5.3 | Message events | packages/server/src/events/messageEvents.ts |
| 5.4 | Typing events | packages/server/src/events/typingEvents.ts |
| 5.5 | Server entry | packages/server/src/index.ts |

## Week 3: Client & Integration

### Day 7-8: Client SDK
| Prompt | Task | Output |
|--------|------|--------|
| 6.1 | Socket client | packages/client/src/socket/client.ts |
| 6.2 | Chat context | packages/client/src/context/ChatContext.tsx |
| 6.3 | useChat hook | packages/client/src/hooks/useChat.ts |
| 6.4 | useConversations | packages/client/src/hooks/useConversations.ts |
| 6.5 | Components | packages/client/src/components/*.tsx |
| 6.6 | Client index | packages/client/src/index.ts |

### Day 9-10: Testing & Docs
| Prompt | Task | Output |
|--------|------|--------|
| 7.1 | Integration tests | packages/server/src/__tests__/*.ts |
| 8.1 | README | README.md |

---

# 8. DELIVERABLES CREATED

## Documents for You (Building)

| File | Purpose |
|------|---------|
| `monorepo-prompt-roadmap.md` | All 25 prompts in exact order - YOUR MAIN GUIDE |
| `vibe-coding-playbook.docx` | Strategy guide for AI-assisted coding |
| `vibe-coding-prompts.md` | Quick reference prompts |
| `prompt-execution-roadmap.md` | Original single-repo version (superseded) |

## Documents for Developer (Integration)

| File | Purpose |
|------|---------|
| `developer-handoff.md` | Explains what they're getting - SHARE FIRST |
| `developer-quick-reference.md` | One-page integration cheatsheet |
| `chat-architecture.docx` | Detailed technical design reference |

## Which to Use When

```
BEFORE BUILDING:
└── Share: developer-handoff.md (to developer)

WHILE BUILDING:
└── Follow: monorepo-prompt-roadmap.md (your guide)

AFTER BUILDING:
└── Share: developer-quick-reference.md (for integration)

IF NEED DETAILS:
└── Reference: chat-architecture.docx
```

---

# 9. NEXT STEPS

## Immediate Actions

### Step 1: Share with Developer
Send `developer-handoff.md` so they understand what's coming.

### Step 2: Create New Repository
```
GitHub → Majestic-Escape → New Repository
Name: majestic-chat
Type: Private
Initialize: With README
```

### Step 3: Clone Locally
```powershell
cd E:\majestic-escape
git clone https://github.com/Majestic-Escape/majestic-chat.git
cd majestic-chat
code .
```

### Step 4: Start Building
1. Open VS Code with Copilot
2. Open `monorepo-prompt-roadmap.md`
3. Copy PROMPT 0.1
4. Paste into Copilot Chat (Agent mode)
5. Verify: `npm install && npm run build:shared`
6. Continue to next prompt

## Verification After Each Prompt
```bash
npx tsc --noEmit    # TypeScript compiles
npm run lint        # No lint errors
npm test            # Tests pass (when applicable)
```

## Final Deliverable
A complete `majestic-chat` repository that:
- ✅ Server deploys to Railway
- ✅ Client installs in user.website
- ✅ Real-time messaging works
- ✅ Moderation detects contact info
- ✅ Documentation complete

## Developer Integration (After You Build)
1. Deploy server to Railway (~30 mins)
2. Configure DNS for chat.majesticescape.in (~10 mins)
3. Install client in user.website (~20 mins)
4. Add chat pages (~30 mins)
5. **Total: ~2 hours**

---

# 📊 SUMMARY STATISTICS

| Metric | Value |
|--------|-------|
| Total Prompts | 25 |
| Estimated Build Time | 10 days |
| Developer Integration Time | ~2 hours |
| Monthly Infrastructure Cost | $5-30 |
| Documents Created | 7 |
| New Collections | 2 (messages, conversations) |
| Socket Events | 12 |
| React Hooks | 2 |
| React Components | 5 |

---

# ✅ READY TO BUILD

You have everything you need:
- ✅ Architecture designed
- ✅ Prompts prepared
- ✅ Strategy documented
- ✅ Developer handoff ready
- ✅ VS Code + Copilot set up

**Open `monorepo-prompt-roadmap.md` and start with PROMPT 0.1!**

---

*Document generated from chat discussion - January 2026*