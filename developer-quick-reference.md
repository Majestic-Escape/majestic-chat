# 🚀 MajesticEscape Chat - Developer Quick Reference

## One-Page Integration Guide

---

## 📦 What You're Getting

```
majestic-chat/                    # NEW REPO
├── packages/
│   ├── shared/                   # Types, schemas, moderation (internal)
│   ├── server/                   # Socket.io server → Deploy to Railway
│   └── client/                   # React SDK → Install in user.website
```

---

## 🔧 Server Setup (Railway)

### 1. Create Railway Project

```bash
# Railway CLI or dashboard
railway init
railway link
```

### 2. Set Environment Variables

```env
# Required — DB-name segment encodes environment:
#   majestic-chat          → production
#   majestic-chat-dev      → staging (user.me.coderelix.in)
#   majestic-chat-localdev → local development
MONGODB_URI=mongodb+srv://user:pass@cluster.mongodb.net/majestic-chat
REDIS_URL=redis://default:password@host:port
JWT_SECRET=<same-secret-as-server.me>
CORS_ORIGIN=https://www.majesticescape.in

# Optional
PORT=3002
NODE_ENV=production
AUTH_SERVICE_URL=https://api.majesticescape.in/auth/verify
```

### 3. Configure Domain

- Add custom domain: `chat.majesticescape.in`
- Point DNS CNAME to Railway

### 4. Deploy

```bash
railway up
# Or push to GitHub (auto-deploys)
```

---

## 📱 Client Integration (user.website)

### 1. Install Package

```bash
# In user.website directory
npm install @majestic/chat-client

# Or from GitHub directly:
npm install github:Majestic-Escape/majestic-chat#main
```

### 2. Add Environment Variable

```env
# .env.local
NEXT_PUBLIC_CHAT_URL=wss://chat.majesticescape.in
```

### 3. Wrap App with Provider

```tsx
// app/providers.tsx (or layout.tsx)
import { ChatProvider } from "@majestic/chat-client";

export function Providers({ children }) {
  const { token } = useAuth(); // Your existing auth hook

  if (!token) return <>{children}</>;

  return (
    <ChatProvider socketUrl={process.env.NEXT_PUBLIC_CHAT_URL!} token={token}>
      {children}
    </ChatProvider>
  );
}
```

### 4. Use Components

```tsx
// Inbox list page
import { useConversations } from "@majestic/chat-client";

function InboxPage() {
  const { conversations, isLoading } = useConversations();
  // render conversation list
}

// Chat page
import { ChatWindow } from "@majestic/chat-client";

function ChatPage({ conversationId }) {
  return (
    <ChatWindow
      conversationId={conversationId}
      currentUserId={currentUser.id}
    />
  );
}
```

---

## 🔗 API Endpoints (for custom integration)

### Socket.io Events

**Client → Server:**
| Event | Payload | Description |
|-------|---------|-------------|
| `message:send` | `{ conversationId, content, type, clientMessageId }` | Send message |
| `message:read` | `{ conversationId, messageIds }` | Mark as read |
| `conversation:join` | `{ conversationId }` | Join room |
| `conversation:leave` | `{ conversationId }` | Leave room |
| `typing:start` | `{ conversationId }` | Started typing |
| `typing:stop` | `{ conversationId }` | Stopped typing |

**Server → Client:**
| Event | Payload | Description |
|-------|---------|-------------|
| `message:new` | `{ message, conversationId }` | New message received |
| `message:sent` | `{ messageId, clientMessageId }` | Confirm sent |
| `message:read` | `{ conversationId, messageIds, userId }` | Read receipt |
| `typing:update` | `{ conversationId, userId, isTyping }` | Typing status |
| `error` | `{ code, message }` | Error occurred |

### Authentication

- Connect with token: `socket.auth = { token: 'jwt-token' }`
- Token must be valid JWT signed with same secret as server.me

---

## 🎨 Styling Components

Components have default class names. Override with CSS:

```css
/* Example styles */
.majestic-chat-window {
  height: 100vh;
  display: flex;
  flex-direction: column;
}

.majestic-message-list {
  flex: 1;
  overflow-y: auto;
}

.majestic-message-bubble {
  padding: 12px;
  border-radius: 16px;
  max-width: 70%;
}

.majestic-message-bubble--sent {
  background: #007aff;
  color: white;
  margin-left: auto;
}

.majestic-message-bubble--received {
  background: #e5e5ea;
  color: black;
}

.majestic-message-input {
  display: flex;
  padding: 12px;
  border-top: 1px solid #eee;
}

.majestic-typing-indicator {
  font-size: 12px;
  color: #666;
  padding: 4px 12px;
}
```

---

## 🗄️ Database Collections

### messages

```javascript
{
  _id: ObjectId,
  conversationId: ObjectId,
  senderId: ObjectId,
  clientMessageId: String,  // For idempotency
  type: 'text' | 'image' | 'file' | 'system',
  content: { text: String, attachments: Array },
  moderation: { status: String, flags: Array, confidence: Number },
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
  bookingId: ObjectId,  // Optional
  participants: [{ userId: ObjectId, role: 'host' | 'guest', joinedAt: Date }],
  lastMessage: { content: String, senderId: ObjectId, sentAt: Date },
  unreadCount: { [userId]: Number },
  status: 'active' | 'archived' | 'blocked',
  createdAt: Date,
  updatedAt: Date
}
```

---

## 🛡️ Moderation

Auto-detects and flags:

- Phone numbers (Indian format: +91, 10-digit)
- Email addresses
- WhatsApp/Telegram/Signal mentions
- Contact-sharing intent phrases

Actions:

- `confidence >= 0.9` → Message blocked
- `confidence >= 0.6` → Message flagged (warning shown)
- `confidence < 0.6` → Clean

---

## 🐛 Troubleshooting

| Issue                  | Solution                                  |
| ---------------------- | ----------------------------------------- |
| Connection fails       | Check CORS_ORIGIN matches your domain     |
| Auth error             | Verify JWT_SECRET matches server.me       |
| Messages not appearing | Check user is participant in conversation |
| Typing not working     | Ensure both users joined same room        |

### Debug Mode

```tsx
<ChatProvider
  socketUrl={process.env.NEXT_PUBLIC_CHAT_URL!}
  token={token}
  debug={true}  // Enables console logging
>
```

---

## 📞 Support

- **Repo:** github.com/Majestic-Escape/majestic-chat
- **Issues:** Create GitHub issue with logs
- **Logs:** Railway dashboard → Logs tab

---

## ✅ Go-Live Checklist

- [ ] Railway deployment successful
- [ ] Custom domain configured (chat.majesticescape.in)
- [ ] SSL certificate active
- [ ] MongoDB connection working
- [ ] Redis connection working
- [ ] JWT secret matches server.me
- [ ] CORS origin correct
- [ ] Client package installed in user.website
- [ ] ChatProvider wrapped around app
- [ ] Test message sends/receives
- [ ] Test typing indicators
- [ ] Test on mobile browser
