# MajesticEscape Chat - Integration Guide

Complete guide for integrating the chat system into user.website with **minimal changes**.

## � Quick Start (Local Testing)

### Prerequisites

- Chat server running: `npm run dev:server` in `majestic-chat/`
- MongoDB and Redis connected (check server logs)

### Step 1: Add Environment Variable to user.website

Add to `user.website/.env.local`:

```
NEXT_PUBLIC_CHAT_URL=http://localhost:3001
```

### Step 2: Install Dependencies in user.website

```bash
cd user.website
npm install socket.io-client
npm install ../majestic-chat/packages/client
```

### Step 3: Enable "Message Host" Button

In `user.website/src/app/(landing)/stay/[id]/components/host-profile.jsx`, find:

```jsx
<Button className='w-full hidden bg-primaryGreen hover:bg-brightGreen font-normal text-white rounded-lg text-sm'>
  Message host
</Button>
```

Change to:

```jsx
<Button
  className='w-full bg-primaryGreen hover:bg-brightGreen font-normal text-white rounded-lg text-sm'
  onClick={() => {
    const token = localStorage.getItem("token");
    if (!token) {
      // Redirect to login or show login modal
      window.location.href = "/login";
      return;
    }
    // Navigate to chat with this host
    window.location.href = `/chat/${propertyData._id}?hostId=${propertyData.host._id}`;
  }}
>
  <MessageCircle className='w-4 h-4 mr-2' />
  Message host
</Button>
```

### Step 4: Create Chat Page

Create `user.website/src/app/chat/[propertyId]/page.jsx`:

```jsx
"use client";

import { useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";
import { ChatProvider, ChatWindow } from "@majestic/chat-client";

export default function ChatPage({ params }) {
  const searchParams = useSearchParams();
  const hostId = searchParams.get("hostId");
  const propertyId = params.propertyId;
  const [token, setToken] = useState(null);
  const [userId, setUserId] = useState(null);
  const [conversationId, setConversationId] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const storedToken = localStorage.getItem("token");
    if (!storedToken) {
      window.location.href = "/login";
      return;
    }
    setToken(storedToken);

    // Decode JWT to get userId
    try {
      const payload = JSON.parse(atob(storedToken.split(".")[1]));
      setUserId(payload.userId);
    } catch (e) {
      console.error("Invalid token");
      window.location.href = "/login";
    }
  }, []);

  useEffect(() => {
    if (!token || !userId || !hostId || !propertyId) return;

    // Create or get conversation
    async function initConversation() {
      try {
        const res = await fetch(
          `${process.env.NEXT_PUBLIC_CHAT_URL}/api/chat/conversations`,
          {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Authorization: `Bearer ${token}`,
            },
            body: JSON.stringify({
              propertyId,
              hostId,
              guestId: userId,
            }),
          },
        );
        const data = await res.json();
        if (data.success) {
          setConversationId(data.data._id || data.data.id);
        }
      } catch (error) {
        console.error("Failed to create conversation:", error);
      } finally {
        setLoading(false);
      }
    }
    initConversation();
  }, [token, userId, hostId, propertyId]);

  if (!token || loading) {
    return (
      <div className='flex items-center justify-center h-screen'>
        <div className='animate-spin rounded-full h-8 w-8 border-b-2 border-primaryGreen'></div>
      </div>
    );
  }

  if (!conversationId) {
    return (
      <div className='flex items-center justify-center h-screen'>
        <p>Failed to load chat. Please try again.</p>
      </div>
    );
  }

  return (
    <ChatProvider
      socketUrl={process.env.NEXT_PUBLIC_CHAT_URL || "http://localhost:3001"}
      token={token}
    >
      <div className='h-screen'>
        <ChatWindow
          conversationId={conversationId}
          currentUserId={userId}
          onBack={() => window.history.back()}
        />
      </div>
    </ChatProvider>
  );
}
```

## 🎨 Styling

The chat components use CSS classes that match user.website's design system. You can customize by:

1. Using the example CSS: `import "@majestic/chat-client/example.css";`
2. Or override with Tailwind classes via `className` prop

## 🔧 API Endpoints

The chat server exposes these REST endpoints:

| Method | Endpoint                               | Description              |
| ------ | -------------------------------------- | ------------------------ |
| GET    | `/health`                              | Health check             |
| GET    | `/api/chat/conversations`              | Get user's conversations |
| POST   | `/api/chat/conversations`              | Create/get conversation  |
| GET    | `/api/chat/conversations/:id`          | Get single conversation  |
| GET    | `/api/chat/conversations/:id/messages` | Get messages (paginated) |

All endpoints require `Authorization: Bearer <token>` header.

### Test API (PowerShell)

```powershell
# Health check
Invoke-RestMethod -Uri "http://localhost:3001/health"

# Create conversation (replace TOKEN)
$headers = @{ Authorization = "Bearer YOUR_TOKEN" }
$body = @{ propertyId = "xxx"; hostId = "xxx"; guestId = "xxx" } | ConvertTo-Json
Invoke-RestMethod -Uri "http://localhost:3001/api/chat/conversations" -Method Post -Headers $headers -Body $body -ContentType "application/json"
```

## 🔐 Authentication

The chat system uses the same JWT tokens as server.me. Token structure:

```json
{
  "userId": "user-mongodb-id",
  "firstName": "John",
  "tokenVersion": 1
}
```

JWT_SECRET must match between server.me and chat server (currently: `secret126546`).

## 📱 Mobile Optimization

### Responsive Design

The components are mobile-friendly by default. Add viewport meta tag:

```html
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
```

### Full-Screen Chat on Mobile

```tsx
function MobileChatPage() {
  return (
    <div className='h-screen'>
      <ChatWindow
        conversationId={conversationId}
        currentUserId={userId}
        className='h-full'
      />
    </div>
  );
}
```

### Prevent iOS Zoom

Set font-size to 16px or larger on inputs:

```css
.message-input__textarea {
  font-size: 16px; /* Prevents iOS zoom */
}
```

## 🎯 Common Use Cases

### Property Inquiry Chat

```tsx
function PropertyInquiry({ propertyId, hostId }) {
  const { user } = useAuth();
  const [conversationId, setConversationId] = useState(null);

  useEffect(() => {
    // Create or get conversation
    async function initChat() {
      const response = await fetch("/api/chat/conversations", {
        method: "POST",
        body: JSON.stringify({ propertyId, hostId, guestId: user.id }),
      });
      const { conversationId } = await response.json();
      setConversationId(conversationId);
    }
    initChat();
  }, [propertyId, hostId, user.id]);

  if (!conversationId) return <div>Loading chat...</div>;

  return (
    <ChatWindow
      conversationId={conversationId}
      currentUserId={user.id}
      header={<PropertyChatHeader propertyId={propertyId} />}
    />
  );
}
```

### Booking-Related Chat

```tsx
function BookingChat({ bookingId }) {
  const { user } = useAuth();
  const { data: booking } = useBooking(bookingId);

  return (
    <div>
      <BookingDetails booking={booking} />
      <ChatWindow
        conversationId={booking.conversationId}
        currentUserId={user.id}
        header={
          <div>
            <h3>Chat about Booking #{bookingId}</h3>
            <p>{booking.propertyName}</p>
          </div>
        }
      />
    </div>
  );
}
```

### Unread Message Badge

```tsx
function ChatIcon() {
  const { conversations } = useConversations();
  const { user } = useAuth();

  const totalUnread = conversations.reduce(
    (sum, conv) => sum + (conv.unreadCount[user.id] || 0),
    0,
  );

  return (
    <div className='relative'>
      <MessageIcon />
      {totalUnread > 0 && <span className='badge'>{totalUnread}</span>}
    </div>
  );
}
```

## 🐛 Troubleshooting

### Connection Issues

```tsx
import { useChatContext } from "@majestic/chat-client";

function ChatStatus() {
  const { connectionState, error } = useChatContext();

  if (connectionState === "error") {
    return <div>Connection error: {error}</div>;
  }

  if (connectionState === "connecting") {
    return <div>Connecting...</div>;
  }

  return null;
}
```

### Debug Mode

Enable debug logging:

```tsx
<ChatProvider
  socketUrl={chatUrl}
  token={token}
  onError={(error) => {
    console.error("Chat error:", error);
    // Send to error tracking service
  }}
/>
```

## 🔒 Security Best Practices

1. **Always validate tokens server-side**
2. **Use HTTPS/WSS in production**
3. **Don't expose sensitive data in messages**
4. **Implement rate limiting on your API**
5. **Sanitize user input before display**

## 📊 Performance Tips

1. **Lazy load chat components**:

   ```tsx
   const ChatWindow = dynamic(() =>
     import("@majestic/chat-client").then((m) => m.ChatWindow),
   );
   ```

2. **Implement virtual scrolling for long message lists**

3. **Debounce typing indicators**

4. **Use pagination for message history**

## 🚀 Deployment Checklist

- [ ] Set `NEXT_PUBLIC_CHAT_URL` environment variable
- [ ] Ensure JWT_SECRET matches between server.me and chat server
- [ ] Configure CORS_ORIGIN on chat server
- [ ] Test on mobile devices
- [ ] Add error tracking
- [ ] Set up monitoring for chat server
- [ ] Test reconnection scenarios
- [ ] Verify content moderation is working

## 📞 Support

For issues or questions:

- Check the main README.md
- Review the monorepo-prompt-roadmap.md
- Contact the development team
