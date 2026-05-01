# MajesticEscape Chat System

Real-time chat system for property rentals built with Socket.io and React.

## Architecture

This is a monorepo containing 3 packages:

- **@majestic/chat-shared**: Shared types, schemas, and utilities
- **@majestic/chat-server**: Socket.io server for real-time messaging
- **@majestic/chat-client**: React SDK for frontend integration

## Getting Started

```bash
# Install dependencies
npm install

# Build all packages
npm run build

# Build specific package
npm run build:shared
npm run build:server
npm run build:client

# Start development server
npm run dev:server
```

## Integration

This chat system integrates with:

- **server.me**: Express backend (JWT authentication)
- **user.website**: Next.js frontend (chat UI)

## Environment Variables

Copy `.env.example` to `.env` and configure:

```env
MONGODB_URI=mongodb+srv://.../majestic-chat-localdev?...
REDIS_URL=redis://...
JWT_SECRET=same_as_server_me
PORT=3002
CORS_ORIGIN=https://www.majesticescape.in
```

> **Database name encodes environment.** The DB segment of `MONGODB_URI` is the only thing isolating prod chat from staging from local — pick the right one:
>
> - `majestic-chat` → production only
> - `majestic-chat-dev` → staging (`user.me.coderelix.in`)
> - `majestic-chat-localdev` → local development
>
> See `DEPLOYMENT_GUIDE.md` for the full rationale and per-deployment values.

## Documentation

See `monorepo-prompt-roadmap.md` for complete implementation guide.
