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
