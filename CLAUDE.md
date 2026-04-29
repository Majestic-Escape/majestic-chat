# CLAUDE.md — `majestic-chat`

Guidance for Claude Code when working in this repository.

## What this repo is

Real-time chat backend (and a thin client SDK) powering the in-app messaging between guests and hosts on the Majestic Escape platform. It is consumed by:

- `user.website` (Next.js app at `majesticescape.in` and `user.me.coderelix.in`) — guest `/messages` and host `/host/inbox` pages
- `majestic-escape-rag-ai-chat-widget` — uses the same socket infrastructure for the AI support `/support` namespace

This is not a standalone product — every change here ripples into the consumers above.

## Layout

Yarn-style npm workspaces monorepo. Three packages:

```
packages/
  server/     → Socket.IO + Express server (this is what runs in prod)
  client/     → React hooks + socket manager consumed by user.website
  shared/     → Types, Zod schemas, constants, moderation rules — imported by both
```

### `packages/server/src/` — the deployed server

| Path | Role |
|---|---|
| `index.ts` | Boots Express, Mongo, Socket.IO, registers events |
| `lib/database.ts` | Mongoose connect (reads `MONGODB_URI`) |
| `lib/logger.ts` | Pino logger |
| `socket/server.ts` | `createSocketServer` — Socket.IO setup, CORS, ping/pong, connection-state-recovery, optional Redis adapter |
| `middleware/socketAuth.ts` | JWT verification on socket handshake (must accept tokens from `server.me`) |
| `events/messageEvents.ts` | `send_message`, `mark_read`, `join_conversation` etc. |
| `events/typingEvents.ts` | `typing_start` / `typing_stop` broadcast |
| `services/ChatService.ts` | Conversation + message CRUD, used by routes and events |
| `services/ModerationService.ts` | Content filtering hooks |
| `services/UnreadCountService.ts` | Aggregates unread counts per role (host/guest) |
| `routes/conversationRoutes.ts` | REST: `/api/chat/conversations`, `/api/chat/unread-count`, etc. |
| `repositories/` | Mongoose model wrappers |

### `packages/shared/src/` — shared with consumers

Zod schemas, TS types, error classes, and CHAT_CONFIG constants live here. **Never duplicate types in server or client** — add them here and re-export.

## Running locally

From repo root:

```bash
npm install                # installs all workspaces
npm run dev:server         # starts the chat server only
```

The server's `dev` script reads `dotenv_config_path=../../.env`, i.e. **the chat repo's root `.env`** (not `packages/server/.env`).

Default port: `3002` (overridable via `PORT`).

## Environment variables

Required:
- `JWT_SECRET` — must equal `server.me`'s secret so user tokens validate.
- `MONGODB_URI` — Atlas connection string. **DB-name segment encodes which environment**:
  - `majestic-chat` → production (Railway, `majesticescape.in`)
  - `majestic-chat-dev` → staging/dev (Railway, `user.me.coderelix.in`)
  - `majestic-chat-localdev` → local dev only

Optional:
- `REDIS_URL` — enables horizontal scaling via Redis adapter; safe to omit locally
- `CORS_ORIGIN` — comma-separated allow-list. Defaults to `localhost:{3000,3001,3002}` if unset.
- `MAIN_API_URL` — `server.me` base URL for property/user validation
- `PORT` — defaults to `3001` in code, `3002` in deployed `.env`
- `LOG_LEVEL` — `debug` | `info` | `warn` | `error`

## Data isolation — critical

`server.me` (auth/users) and this chat server share the same Atlas cluster but different databases. The DB segment in `MONGODB_URI` is the **only** thing separating prod chat from dev chat from local chat. Do not "fix" a misbehaving local server by pasting in the prod URI — you'll write to real customer threads.

If you see suspicious "production-looking" data in dev, the first thing to check is the DB segment of `MONGODB_URI` in whichever env you're running.

## Auth model

Tokens are minted by `server.me` (HS256 with `JWT_SECRET`). This server only **verifies** them in `middleware/socketAuth.ts` and `middleware/auth.ts` — it never issues them. Never add a login endpoint here.

The verified payload's `userId` becomes the actor for all downstream chat operations. Trust nothing from `socket.handshake.query` beyond the token.

## Common tasks

### Adding a new socket event
1. Define the event name + payload schema in `packages/shared/src/types.ts` (or a typed sub-module)
2. Add a handler in `packages/server/src/events/<file>.ts` and register it from `index.ts`
3. Call it from `packages/client/src/hooks/useChat.ts` (or a new hook)
4. If it persists data, route through `ChatService` — never touch Mongoose models from event handlers directly

### Adding a REST endpoint
Add to `routes/conversationRoutes.ts` (or create a sibling under `routes/`). Mount it in `index.ts` under `/api/chat`. Always wrap in the auth middleware.

### Changing a Mongo schema
Update the Mongoose model under `repositories/`, AND update the corresponding Zod/TS type in `packages/shared`. Run a quick scan of `services/` for `.find()` / `.update()` calls that may now mismatch.

## Testing & deploy

- `npm run lint` (ESLint) and `npm run test` (Jest) at workspace root run across all packages.
- Production: deployed to **Railway**, two services (one per environment).
- Redeploy is required when env vars change (Railway picks them up only on next build).

## Things to avoid

- **Don't add a login/registration flow here.** Auth lives in `server.me`.
- **Don't bypass `ChatService`** for writes — it enforces participant checks and moderation.
- **Don't add Express routes that read JWT but skip the auth middleware** — easy way to leak a user's conversations.
- **Don't import from `packages/server` into `packages/client`.** They're shipped to different environments. Use `packages/shared`.
- **Don't swap CORS to `*`** to chase a connection error — fix the origin instead.
- **Don't add `.env`, `.env.local`, `.env.*` to git.** Atlas/JWT credentials live there.

## Consumers to keep in mind when changing the wire protocol

- `user.website/src/lib/socket.js` — singleton SocketManager
- `user.website/src/contexts/UnreadCountContext.jsx`
- `user.website/src/app/(landing)/messages/Messaging.jsx` — guest UI
- `user.website/src/app/host/inbox/page.jsx` — host UI

Any breaking change to event names, payload shapes, or REST response shapes requires coordinated updates in the above files. Ship the shared types first, server second, consumers last.
