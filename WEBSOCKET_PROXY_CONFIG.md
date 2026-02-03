# WebSocket Proxy Configuration

If you're using Nginx or another reverse proxy in front of the chat server, you need to configure it properly for WebSocket connections.

## Nginx Configuration

Add this to your Nginx server block:

```nginx
location /socket.io/ {
    proxy_pass http://your-chat-server:3001;

    # WebSocket upgrade headers
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";

    # Preserve client IP
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;

    # Timeouts - must be longer than Socket.IO ping interval (25s)
    proxy_read_timeout 86400s;  # 24 hours
    proxy_send_timeout 86400s;

    # Disable buffering for real-time
    proxy_buffering off;

    # Cache settings
    proxy_cache_bypass $http_upgrade;
}
```

## Key Settings Explained

1. **proxy_http_version 1.1** - Required for WebSocket
2. **Upgrade headers** - Enable WebSocket protocol upgrade
3. **proxy_read_timeout** - Must be > ping interval (25s) to prevent premature disconnects
4. **proxy_buffering off** - Ensures real-time message delivery

## Common Issues

### "transport close" disconnects every 60 seconds

- Nginx default `proxy_read_timeout` is 60s
- Increase to at least 86400s (24 hours)

### Connection drops after 2 seconds

- Check if polling transport is being blocked
- Ensure WebSocket upgrade headers are set

### CORS errors

- Add your frontend domain to `CORS_ORIGIN` env variable
- Example: `CORS_ORIGIN=https://your-domain.com,https://www.your-domain.com`

## Vercel/Serverless Considerations

If deploying the chat server to Vercel or similar serverless platforms:

- WebSocket connections may not work due to function timeouts
- Consider using a dedicated server (DigitalOcean, Railway, Render) for the chat server
- Or use a managed WebSocket service (Pusher, Ably, etc.)

## Testing WebSocket Connection

```bash
# Test WebSocket connection
wscat -c "ws://your-server:3001/socket.io/?EIO=4&transport=websocket"
```
