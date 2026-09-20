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
- `MONGODB_URI` — Atlas connection string. **Cluster + DB-name encode the env**:
  - Prod   (Railway, `majesticescape.in`):     `…@majesticescapewebsite.nvgz1dl.mongodb.net/majestic-chat?…`
  - Dev    (Railway, `user.me.coderelix.in`):  `…@majestic-escape.nk49u.mongodb.net/majestic-chat-dev?…`
  - Local                                    : `…@majestic-escape.nk49u.mongodb.net/majestic-chat-localdev?…`
  - **Prod was migrated from `nk49u` → `nvgz1dl` on 2026-05-22** to put prod chat on the real prod cluster (same one as server.me prod), giving cluster-level isolation from dev/local — not just DB-name separation. Before the move, `nk49u/majestic-chat` had accumulated months of dev-era test conversations (pre-`-dev`/`-localdev` split) that surfaced on prod `/messages`; those were purged and the 6 real-property conversations were copied across as part of the migration.

Optional:
- `REDIS_URL` — enables horizontal scaling via Redis adapter; safe to omit locally
- `CORS_ORIGIN` — comma-separated allow-list. Defaults to `localhost:{3000,3001,3002}` if unset.
- `MAIN_API_URL` — `server.me` base URL for property/user validation **and session freshness**: every socket handshake and REST call asks `POST {MAIN_API_URL}/auth/check-token` once per token (`lib/session.ts`, verdict cached in memory + Redis for 5 min; 401/403/404 = rejected, network/5xx = fail-open for 30 s) and connected sockets are re-checked every 15 min (`socket/server.ts`). Without it, tokens are only signature-checked (logout-all / bans / deleted users are not enforced).
- `PORT` — defaults to `3001` in code, `3002` in deployed `.env`
- `LOG_LEVEL` — `debug` | `info` | `warn` | `error`

## Data isolation — critical

Production lives on a **different Atlas cluster** from dev/local:

- **Prod chat**: `nvgz1dl` cluster (`majesticescapewebsite.nvgz1dl.mongodb.net`), DB `majestic-chat`. Same cluster as `server.me` prod (`master-db` lives there too — separate DB). Credentials: `majesticescapein_db_user`.
- **Dev + local chat**: `nk49u` cluster (`majestic-escape.nk49u.mongodb.net`), DBs `majestic-chat-dev` and `majestic-chat-localdev`. Same cluster as `server.me` preview (`master-db` lives there too — separate DB). Credentials: `admin`.

Different clusters mean different credentials AND different hostnames — a DB-name typo can no longer cross prod and dev. Inside `nk49u` the DB-name still separates dev from local (and the historical un-suffixed `majestic-chat` DB still exists there as a fallback backup of the pre-migration prod data; do not write to it). Do not "fix" a misbehaving local server by pasting in the prod URI — you'll write to real customer threads.

If you see suspicious "production-looking" data in dev (or vice-versa), check **which cluster** the URI points at first, then the DB segment.

Pre-migration history: before 2026-05-22, prod chat lived on `nk49u/majestic-chat` (shared cluster with dev/local). Months of pre-split dev test conversations had accumulated in that DB and were surfacing on prod `/messages` — that's why the move happened.

## Auth model

Tokens are minted by `server.me` (HS256 with `JWT_SECRET`). This server only **verifies** them — sockets in `middleware/socketAuth.ts`, REST via the inline `verifyToken` in `routes/conversationRoutes.ts` — it never issues them. Never add a login endpoint here.

The verified payload's `userId` becomes the actor for all downstream chat operations (`decodeToken` also requires it to be a 24-hex ObjectId). Trust nothing from `socket.handshake.query` beyond the token. A token that `server.me` reports as invalidated (`tokenVersion` rotated, ban, deleted user) is rejected with `Token invalidated` on connect / 401 on REST, and a live socket is disconnected at the next 15-minute re-check.

## Common tasks

### Message send semantics (read before touching `sendMessage`)

- **Idempotent on `(conversationId, clientMessageId)`** — unique index. A retry of a logical send **reuses the same `clientMessageId`**; the server answers `created: false`, touches no DB state, and still re-broadcasts `message:new` (delivery is *at-least-once*; every client de-duplicates by message id / `clientMessageId`).
- **The insert and the conversation update (`lastMessage`, per-recipient unread `$inc`) run in one Mongo transaction** (`MessageRepository.createWithConversationUpdate`) — both or neither, so a crash between commit and broadcast is healed by the client's same-id retry. Needs a replica set (every Atlas tier; tests use `MongoMemoryReplSet`).
- **Acks carry an error `code`** (`MessageResponse.code`). Clients treat only deterministic codes (`VALIDATION_ERROR`, `MESSAGE_NOT_FOUND`, `USER_NOT_PARTICIPANT`, `MODERATION_BLOCKED`, `RATE_LIMITED`, …) as "nothing was stored"; anything else (`INTERNAL_ERROR`, timeout, disconnect) is ambiguous and must be retried with the same id.
- **Reply / quote**: a client may send `replyTo: { messageId }` only. The server resolves it with `MessageRepository.findReplyTarget(conversationId, id)` (same conversation, not deleted — one `MESSAGE_NOT_FOUND` for unknown/foreign/deleted) and stores a `ReplyRef` snapshot `{ messageId, senderId, text (≤ REPLY_SNIPPET_MAX), type }` built by `buildReplyRef` in shared. Never trust quoted text from a client; never nest `replyTo`.
- **Text cap**: `CHAT_CONFIG.MAX_MESSAGE_LENGTH` (4000) is enforced by the Zod schema on every send.
- Redis is an **optional** cache (`lib/cache.ts`): reads degrade to Mongo when it is unavailable; never let a Redis failure fail a send. The helpers (`cacheGet/cacheMget/cacheSetEx/cacheDel`) swallow every error, open a 10 s breaker after a failure (no Redis command at all while it is open), and remember keys whose write/invalidation was skipped so they are `DEL`'d the first time Redis answers again — an outage never leaves a stale conversation / unread entry behind. Use them; never call `getRedisClient()` from a service.
- **Unread totals** (`UnreadCountService.recalculateUnread`) are serialised per user+role — two concurrent sends to the same recipient cannot write an older aggregate last.
- **Attachments are rejected** (`content.attachments` must be empty) until an upload path exists; legacy rows with attachments still render/quote.
- **Every socket payload is validated with `safeParse` before any field is read** (ObjectId-shaped ids, `clientMessageId` ≤ 128 chars, `message:read` ≤ 200 ids). Malformed input answers `VALIDATION_ERROR` (ack for `message:send`, `error` event for the rest) and never throws. Catch blocks must not touch the raw payload.
- **Rate limits are per process** (in-memory): 60 `message:send`/min/user, 300 light events (join/leave/typing/read)/min/user, 20 conversation creations/min/user. With N Railway replicas the effective limit is N× — acceptable for one replica; move the counters to Redis before scaling out.
- **Existence oracle**: unknown and foreign conversations answer the same `USER_NOT_PARTICIPANT` / 403 on join, send and REST; `message:read` silently ignores ids outside the conversation.
- **Join / leave are serialised per socket** (`serial()` in `messageEvents.ts`) so room membership follows emission order; `typing:*` is only broadcast for rooms the socket has actually joined and never echoes to the typist's own sockets.
- **History pagination** is cursor-based on `(createdAt, _id)` (index `{ conversationId, createdAt: -1, _id: -1 }`); the cursor must belong to the conversation; `limit` is clamped to `MAX_PAGE_SIZE` and invalid `limit`/`cursor` answer 400.
- **`unread:update` carries `conversationId`** (additive) so a client can notice a conversation it has never listed and refresh.
- **Read receipts** (`ChatService.markAsRead`): the reader's per-conversation counter is never reset to 0. It moves by what the receipt newly marked read and converges to the readBy truth (`MessageRepository.countUnreadFor`): raised when below it, and compared-and-set down to it when above (the CAS matches only if nothing moved the counter since it was read, so a message that lands during the receipt is never lost — `ConversationRepository.applyReadToUnreadCount`). The update runs with `timestamps: false` — a read must not bump `updatedAt`, which orders conversation lists. Only a changed counter invalidates the caches and recounts the role total; a repeated receipt costs the cached total plus the two broadcasts.
- **Logging** (`lib/logger.ts` `logFailure`): a `ChatError` with a 4xx status is expected client behaviour (or a probe) and logs at `warn` with `code`/`statusCode`/`reason`; everything else is a real fault and logs at `error` with the Error under `err`. Do not log expected rejections at `error` — that is what pages people.
- **Shutdown** (`lib/shutdown.ts`): SIGTERM/SIGINT close every socket first (clients reconnect to the replacement instance), then Redis and Mongo, with an 8 s hard deadline — do not add work after `io.close()` that can hang.

### Contact lock-down invariants (read before touching moderation, participants or history reads)

The product rule: a guest and a host must never be able to exchange phone numbers, emails, handles, links, payment ids or an exact address through chat, and neither party ever sees the other's last name. Everything below exists to keep that true across two instances, retries and legacy data.

- **One detector, one corpus.** `packages/shared/src/moderation/patterns.ts` is the only contact detector (normaliser → PHONE / INTL_PHONE / SPLIT_PHONE / EMAIL / OBFUSCATED_EMAIL / EMAIL_PROVIDER / UPI / URL / SOCIAL / OFF_PLATFORM / ADDRESS block, CONTACT_INTENT flag-only). Its contract is the golden corpus `packages/shared/src/moderation/__fixtures__/contact-vectors.json`; `moderation.corpus.test.ts` pins the file's sha256, `server.me` carries a byte-identical copy plus a generated CommonJS mirror (`utils/contactModeration.js`, emitted by `packages/shared/scripts/emit-contact-moderation-cjs.js`), and the release harness (`tests/pw-final/corpus-parity.mjs`) fails when the two files differ. To change a rule: edit `patterns.ts`, regenerate the corpus, re-pin **both** repos, re-emit the mirror. Never special-case a vector in one repo.
- **A blocked candidate is never stored and never becomes context.** `ChatService.sendMessage` runs *lock → idempotency check → context read → detect → persist* inside one per-`(conversation, sender)` critical section (`lib/moderationLock.ts`). The context is Mongo, not Redis: `MessageRepository.recentTextsBySender` (last 7 days, ≤ 30 rows, ≤ 1500 normalised chars), so only persisted logical messages count, exactly once per `clientMessageId`. Do not add a Redis window, a per-process cache or a "fast path" that skips the section — that is exactly how `98765` + `43210` sent from two sockets on two instances gets through.
- **The lock**: Redis `SET NX PX` with a random token, compare-and-delete release and owner-checked renewal (Lua, `RELEASE_SCRIPT` / `RENEW_SCRIPT`); Mongo `moderationlocks` (TTL index, insert / compare-delete) when Redis is unavailable; in-process FIFO queue in front of both, and memory-only when `REDIS_URL` is unset. Contention past the bounded backoff answers the definitive, retryable `MODERATION_BUSY` (429) — a message is never accepted outside the section. A Redis outage therefore never weakens the protection; it just costs two extra Mongo ops per send. Measured cost (`tests/pw-final/chat-cost.mjs`): a plain send went from 8 to 10 Redis commands (acquire + compare-and-delete release, whose return value doubles as the fencing check) and from 2 to 3 Mongo finds (the context query); an idempotent retry from 5 to 7 Redis commands.
- **Legacy rows are untrusted.** Every message written by this code carries `moderation.version: 2` (`MODERATION_VERSION`); rows without it were moderated by the old single-message detector. `MessageRepository` masks them on every read, *history-aware*: a page containing legacy rows also loads up to `LEGACY_CONTEXT_ROWS` adjacent legacy rows per sender on both sides, masks across the whole sequence with `maskContactInfoParts`, and returns exactly the requested page. `lastMessage` previews and `replyTo` snippets of legacy rows are masked conservatively (any fragment-bearing token ⇒ `•••`). Do not add a read path (REST, socket, cache, aggregation) that returns `content.text` without going through these helpers.
- **Participant names are server-resolved and first-name only.** `POST /conversations` ignores every client-supplied name; the host's first name comes from the property, the guest's from `GET {MAIN_API_URL}/guests/info/:id` with the caller's token, each accepted only if `isAcceptableName` passes. `lastName` is never written, and `ConversationRepository.toPublicParticipant` drops it from Mongo reads *and* cache reads (a pre-deploy `conv:` / `convlist:` entry can still hold one). Do not serialise a participant with any field beyond `userId, role, joinedAt, firstName`.
- **The rejection is explained, not silent.** `ChatError.moderationBlocked` carries the user-facing reason (`MODERATION_BLOCKED_MESSAGE`); the site toasts it and keeps the composer text. `MODERATION_BUSY` / `MODERATION_UNAVAILABLE` are retryable with the same `clientMessageId`.
- **Tests that guard all of this**: `moderation.corpus.test.ts` (corpus + pin), `moderation.window.test.ts` (split identifiers, 7-day window, two-socket race, in-process queue, Mongo fallback, `MODERATION_BUSY`, legacy masking across pages, participants/cache), `messaging.audit.test.ts` (forged names ignored), `reply.audit.test.ts` (no URL in hostile quoted text), and S16 of `tests/pw-final/chat-cluster.mjs` on the real two-instance stack (corpus over the socket, cross-instance splits, 25-round race, Redis outage, pre-deploy cache entry, Redis cost per send). Keep them green; extend the corpus rather than a single test when a new tactic is found.

### Adding a new socket event
1. Define the event name + payload schema in `packages/shared/src/types.ts` (or a typed sub-module)
2. Add a handler in `packages/server/src/events/<file>.ts` and register it from `index.ts`
3. Call it from `packages/client/src/hooks/useChat.ts` (or a new hook)
4. If it persists data, route through `ChatService` — never touch Mongoose models from event handlers directly

### Adding a REST endpoint
Add to `routes/conversationRoutes.ts` (or create a sibling under `routes/`). Mount it in `index.ts` under `/api/chat`. Always wrap in the auth middleware.

### Changing a Mongo schema
Update the Mongoose model under `repositories/`, AND update the corresponding Zod/TS type in `packages/shared`. Run a quick scan of `services/` for `.find()` / `.update()` calls that may now mismatch.

## Upstash keep-alive cron

`.github/workflows/redis-keepalive.yml` PINGs the Upstash instance and touches a
`keepalive:last-run` key every 5 days. **Upstash archives free-tier databases
after a minimum of 30 days of inactivity** — and this repo's Socket.IO adapter,
conversation cache and unread counts all live there, so archival means a cold,
broken chat backend.

Requires a `REDIS_URL` **repo secret** (Settings → Secrets and variables →
Actions). The workflow splits the URL into host/port/password so the credential
travels via `REDISCLI_AUTH` in the environment and never appears in argv.

Two caveats that are easy to get wrong:

- `cron: "0 6 */5 * *"` is **not** literally every 5 days. It fires on days 1, 6,
  11, 16, 21, 26 and resets at the month boundary, so the worst-case gap is
  **6 days** (26th → 1st). Still well inside the 30-day window.
- **GitHub disables scheduled workflows after 60 days of repository inactivity,
  and only new commits reset that timer** — issues, PRs, tags and manual
  `workflow_dispatch` runs do not count. A quiet period here would silently kill
  the schedule. That is why a PING-only backup copy lives in
  `majestic-escape-ops`, which is actively committed. Either workflow alone keeps
  the database warm; don't delete one assuming the other is redundant noise.

## Testing & deploy

- `npm test` at the workspace root runs the server's Jest suite (`packages/server/src/__tests__`, ts-jest + `mongodb-memory-server` replica set + real `socket.io-client`; no Redis). First run downloads a mongod binary (~65 MB) into `node_modules/.cache`. Build `shared` first (`npm run build:shared`) — the server imports it from `dist`. `messaging.audit.test.ts` covers the hardened contract (payload validation, oracle parity, typing gate, read bounds, pagination, session freshness against a stub main API, the Redis breaker, graceful shutdown); the `reply.*` suites cover send semantics. Jest must exit on its own — close every Redis client (`closeRedisClients()`) and socket a test opens.
- Real-stack harnesses (not in this repo): `D:/majestic-escape/tests/pw-final/chat-cluster.mjs` (two instances behind the Redis adapter: rooms/isolation, ordering, rate limits, Redis outage, instance restart, load) and the Playwright bodies `chat-system` / `chat-restart` / `chat-reply` / `chat-network` for the site; evidence under `tests/pw-final/evidence/`.
- `npm run lint` is declared per package but ESLint is not installed yet.
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
