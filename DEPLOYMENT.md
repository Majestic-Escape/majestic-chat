# Deployment Guide - MajesticEscape Chat Server

Complete guide for deploying the chat server to production.

## 🎯 Deployment Options

### Option 1: Railway (Recommended)

Railway provides easy deployment with automatic HTTPS, environment variables, and scaling.

#### Step 1: Prepare Repository

Ensure your code is pushed to GitHub:

```bash
cd majestic-chat
git add .
git commit -m "Ready for deployment"
git push origin main
```

#### Step 2: Create Railway Project

1. Go to [railway.app](https://railway.app)
2. Click "New Project"
3. Select "Deploy from GitHub repo"
4. Choose `majestic-chat` repository
5. Select the `packages/server` directory as root

#### Step 3: Configure Build Settings

Railway will auto-detect the Dockerfile. If not, configure:

- **Build Command**: `npm install && npm run build`
- **Start Command**: `npm start`
- **Root Directory**: `packages/server`

#### Step 4: Set Environment Variables

In Railway dashboard, add these variables:

```env
# MongoDB (use your existing cluster)
MONGODB_URI=mongodb+srv://user:pass@cluster.mongodb.net/majestic-chat

# Redis (Railway provides this)
REDIS_URL=redis://default:password@redis.railway.internal:6379

# JWT (MUST match server.me)
JWT_SECRET=your-jwt-secret-from-server-me

# Server
PORT=3001
NODE_ENV=production

# CORS (your frontend URL)
CORS_ORIGIN=https://www.majesticescape.in

# Logging
LOG_LEVEL=info
```

#### Step 5: Add Redis Service

1. In Railway project, click "New"
2. Select "Database" → "Redis"
3. Copy the `REDIS_URL` to your environment variables

#### Step 6: Deploy

Railway will automatically deploy. Monitor logs for any errors.

#### Step 7: Get Your URL

Railway provides a URL like: `majestic-chat-production.up.railway.app`

Update your frontend to use: `wss://majestic-chat-production.up.railway.app`

---

### Option 2: Docker + VPS

Deploy to any VPS (DigitalOcean, AWS EC2, etc.) using Docker.

#### Step 1: Build Docker Image

```bash
cd majestic-chat
docker build -t majestic-chat-server -f packages/server/Dockerfile .
```

#### Step 2: Push to Registry

```bash
# Tag for your registry
docker tag majestic-chat-server your-registry/majestic-chat-server:latest

# Push
docker push your-registry/majestic-chat-server:latest
```

#### Step 3: Deploy on VPS

Create `docker-compose.yml`:

```yaml
version: "3.8"

services:
  chat-server:
    image: your-registry/majestic-chat-server:latest
    ports:
      - "3001:3001"
    environment:
      - MONGODB_URI=${MONGODB_URI}
      - REDIS_URL=redis://redis:6379
      - JWT_SECRET=${JWT_SECRET}
      - CORS_ORIGIN=${CORS_ORIGIN}
      - NODE_ENV=production
    depends_on:
      - redis
    restart: unless-stopped

  redis:
    image: redis:7-alpine
    ports:
      - "6379:6379"
    volumes:
      - redis-data:/data
    restart: unless-stopped

volumes:
  redis-data:
```

Run:

```bash
docker-compose up -d
```

#### Step 4: Setup Nginx Reverse Proxy

```nginx
server {
    listen 80;
    server_name chat.majesticescape.in;

    location / {
        proxy_pass http://localhost:3001;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```

#### Step 5: Setup SSL with Certbot

```bash
sudo certbot --nginx -d chat.majesticescape.in
```

---

### Option 3: Heroku

#### Step 1: Create Heroku App

```bash
heroku create majestic-chat-server
```

#### Step 2: Add Redis Add-on

```bash
heroku addons:create heroku-redis:mini
```

#### Step 3: Set Environment Variables

```bash
heroku config:set MONGODB_URI="mongodb+srv://..."
heroku config:set JWT_SECRET="your-secret"
heroku config:set CORS_ORIGIN="https://www.majesticescape.in"
heroku config:set NODE_ENV="production"
```

#### Step 4: Deploy

```bash
git subtree push --prefix packages/server heroku main
```

---

## 🔧 Environment Variables Reference

### Required Variables

| Variable      | Description                       | Example                                                     |
| ------------- | --------------------------------- | ----------------------------------------------------------- |
| `MONGODB_URI` | MongoDB connection string         | `mongodb+srv://user:pass@cluster.mongodb.net/majestic-chat` |
| `JWT_SECRET`  | JWT secret (must match server.me) | `your-secret-key`                                           |
| `CORS_ORIGIN` | Allowed frontend origin           | `https://www.majesticescape.in`                             |

### Optional Variables

| Variable    | Description             | Default                  |
| ----------- | ----------------------- | ------------------------ |
| `REDIS_URL` | Redis connection string | `redis://localhost:6379` |
| `PORT`      | Server port             | `3001`                   |
| `NODE_ENV`  | Environment             | `development`            |
| `LOG_LEVEL` | Logging level           | `info`                   |

---

## 🔍 Health Checks

### Basic Health Check

Add to `packages/server/src/index.ts`:

```typescript
// Health check endpoint
httpServer.on("request", (req, res) => {
  if (req.url === "/health" && req.method === "GET") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify({ status: "ok", timestamp: new Date().toISOString() })
    );
  }
});
```

Test:

```bash
curl https://your-chat-server.com/health
```

### Monitoring

Set up monitoring for:

1. **Server uptime**: Use UptimeRobot or similar
2. **Error rates**: Track ChatError occurrences
3. **Connection count**: Monitor active Socket.io connections
4. **Message throughput**: Track messages per second
5. **Database performance**: Monitor MongoDB query times

---

## 📊 Scaling

### Horizontal Scaling

The Redis adapter allows multiple server instances:

#### Railway

1. Go to Settings → Replicas
2. Increase replica count
3. Railway handles load balancing automatically

#### Docker

Use Docker Swarm or Kubernetes:

```yaml
# docker-compose.yml
services:
  chat-server:
    image: majestic-chat-server
    deploy:
      replicas: 3
      update_config:
        parallelism: 1
        delay: 10s
```

### Vertical Scaling

Increase server resources:

- **Railway**: Upgrade plan for more CPU/RAM
- **VPS**: Resize your droplet/instance
- **Heroku**: Upgrade dyno type

---

## 🔒 Security Checklist

- [ ] Use HTTPS/WSS in production
- [ ] Set strong JWT_SECRET (32+ characters)
- [ ] Configure CORS_ORIGIN to your domain only
- [ ] Enable rate limiting (already implemented)
- [ ] Use environment variables for secrets
- [ ] Keep dependencies updated
- [ ] Enable MongoDB authentication
- [ ] Use Redis password
- [ ] Set up firewall rules
- [ ] Enable DDoS protection (Cloudflare)
- [ ] Implement request logging
- [ ] Set up error tracking (Sentry)

---

## 🐛 Troubleshooting

### Server Won't Start

Check logs for:

```bash
# Railway
railway logs

# Docker
docker logs majestic-chat-server

# Heroku
heroku logs --tail
```

Common issues:

1. **MongoDB connection failed**: Check MONGODB_URI
2. **Redis connection failed**: Check REDIS_URL
3. **Port already in use**: Change PORT variable
4. **JWT verification failed**: Ensure JWT_SECRET matches server.me

### WebSocket Connection Failed

1. **Check CORS**: Ensure CORS_ORIGIN includes your frontend
2. **Check protocol**: Use `wss://` for HTTPS sites
3. **Check firewall**: Ensure port 3001 is open
4. **Check proxy**: Nginx must support WebSocket upgrade

### High Memory Usage

1. **Check connection leaks**: Monitor active connections
2. **Implement connection limits**: Set max connections
3. **Enable connection timeout**: Already configured
4. **Scale horizontally**: Add more instances

---

## 📈 Performance Optimization

### Database Indexes

Already configured in schemas:

```typescript
// Message indexes
{ conversationId: 1, createdAt: -1 }
{ conversationId: 1, clientMessageId: 1 }, { unique: true }
{ senderId: 1, createdAt: -1 }
{ 'moderation.status': 1, createdAt: -1 }

// Conversation indexes
{ 'participants.userId': 1, updatedAt: -1 }
{ propertyId: 1, status: 1 }
{ bookingId: 1 }, { sparse: true }
```

### Redis Configuration

For production, configure Redis persistence:

```bash
# In redis.conf
save 900 1
save 300 10
save 60 10000
```

### Connection Pooling

Already configured in `database.ts`:

```typescript
{
  maxPoolSize: 10,
  minPoolSize: 5,
  maxIdleTimeMS: 30000,
}
```

---

## 🔄 CI/CD Pipeline

### GitHub Actions

Create `.github/workflows/deploy.yml`:

```yaml
name: Deploy Chat Server

on:
  push:
    branches: [main]
    paths:
      - "packages/server/**"
      - "packages/shared/**"

jobs:
  deploy:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v3

      - name: Setup Node.js
        uses: actions/setup-node@v3
        with:
          node-version: "20"

      - name: Install dependencies
        run: npm install

      - name: Build packages
        run: npm run build

      - name: Run tests
        run: npm test

      - name: Deploy to Railway
        run: railway up
        env:
          RAILWAY_TOKEN: ${{ secrets.RAILWAY_TOKEN }}
```

---

## 📞 Post-Deployment

### Update Frontend

In `user.website/.env.production`:

```env
NEXT_PUBLIC_CHAT_URL=wss://chat.majesticescape.in
```

### Test Deployment

1. **Connection test**: Open browser console, check WebSocket connection
2. **Send message**: Test message sending
3. **Receive message**: Test with two users
4. **Moderation**: Test with phone number
5. **Reconnection**: Disconnect and reconnect
6. **Mobile**: Test on mobile devices

### Monitor

Set up alerts for:

- Server downtime
- High error rates
- Slow response times
- High memory usage
- Database connection issues

---

## 🎉 Success!

Your chat server is now deployed and ready for production use!

Next steps:

- Monitor logs for the first few days
- Set up automated backups
- Configure alerts
- Document any custom configurations
- Train team on monitoring tools
