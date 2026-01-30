# Majestic Chat - Complete Deployment Guide

This guide covers deploying the Majestic Chat server to Railway and configuring the frontend on Vercel.

## Architecture Overview

```
┌─────────────────┐     ┌──────────────────┐     ┌─────────────────┐
│  user.website   │────▶│  Chat Server     │────▶│   MongoDB       │
│  (Vercel)       │     │  (Railway)       │     │   (Atlas)       │
└─────────────────┘     └──────────────────┘     └─────────────────┘
                               │
┌─────────────────┐            │                 ┌─────────────────┐
│  admin.site     │────────────┘                 │   Redis         │
│  (Vercel)       │                              │   (Redis Cloud) │
└─────────────────┘                              └─────────────────┘
```

## Prerequisites

- Railway account (https://railway.app)
- Vercel account (https://vercel.com)
- GitHub repository connected to both platforms
- MongoDB Atlas database
- Redis instance (Redis Cloud or Upstash)

---

## Part 1: Railway Deployment (Chat Server)

### Step 1: Create Railway Project

1. Go to https://railway.app/dashboard
2. Click **"New Project"**
3. Select **"Deploy from GitHub repo"**
4. Choose the `majestic-chat` repository
5. Railway will create a new project

### Step 2: Configure Service Settings

1. Click on the created service
2. Go to **Settings** tab
3. Configure the following:

#### Source Settings

- **Root Directory**: Leave empty (or `/`)
- **Watch Paths**: `/packages/server/**`

#### Build Settings

- **Custom Build Command**:
  ```
  npm run build:shared && npm run build:server
  ```

#### Deploy Settings

- **Custom Start Command**:
  ```
  node packages/server/dist/index.js
  ```

### Step 3: Add Environment Variables

Go to **Variables** tab and add these variables:

| Variable       | Value                                                                                                                                 | Description                     |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------- |
| `MONGODB_URI`  | `mongodb+srv://admin:PASSWORD@cluster.mongodb.net/majestic-chat?retryWrites=true&w=majority&appName=Majestic-Escape&authSource=admin` | MongoDB connection string       |
| `REDIS_URL`    | `redis://default:PASSWORD@redis-host:port`                                                                                            | Redis connection string         |
| `JWT_SECRET`   | `your-jwt-secret`                                                                                                                     | Must match server.me JWT secret |
| `PORT`         | `3002`                                                                                                                                | Server port                     |
| `NODE_ENV`     | `production`                                                                                                                          | Environment mode                |
| `CORS_ORIGIN`  | `https://user.me.coderelix.in,https://admin.me.coderelix.in`                                                                          | Allowed frontend domains        |
| `MAIN_API_URL` | `https://server-me.coderelix.in/api/v1`                                                                                               | Backend API URL                 |

#### Development Environment Variables

```
MONGODB_URI=<copy from your .env file or MongoDB Atlas dashboard>
REDIS_URL=<copy from your Redis Cloud or Upstash dashboard>
JWT_SECRET=<must match JWT_SECRET in server.me>
PORT=3002
NODE_ENV=production
CORS_ORIGIN=https://user.me.coderelix.in,https://admin.me.coderelix.in
MAIN_API_URL=https://server-me.coderelix.in/api/v1
```

> **Note**: Get the actual values from your local `.env` file or from the respective service dashboards (MongoDB Atlas, Redis Cloud). Never commit secrets to version control.

### Step 4: Generate Public Domain

1. Go to **Settings** tab
2. Scroll to **Networking** section
3. Click **"Generate Domain"**
4. Copy the generated URL (e.g., `majesticchat-server-production.up.railway.app`)
5. **Save this URL** - you'll need it for frontend configuration

### Step 5: Deploy

1. Railway will auto-deploy when you push to GitHub
2. Or click **"Deploy"** button manually
3. Monitor the **Deployments** tab for build logs
4. Wait for status to show **"Active"** (green)

### Step 6: Verify Deployment

Test the health endpoint:

```
https://your-railway-domain.railway.app/health
```

Expected response:

```json
{ "status": "ok", "timestamp": "2026-01-30T12:00:00.000Z" }
```

---

## Part 2: Vercel Configuration (Frontend)

### Step 1: Add Environment Variable

For **user.website** project on Vercel:

1. Go to Vercel dashboard
2. Select the **user.website** project
3. Go to **Settings** → **Environment Variables**
4. Add new variable:
   - **Name**: `NEXT_PUBLIC_CHAT_URL`
   - **Value**: `https://your-railway-domain.railway.app`
   - **Environment**: Select all (Production, Preview, Development)

**Important**:

- Include `https://` prefix
- NO trailing slash
- Use the exact Railway domain

### Step 2: Redeploy Frontend

1. Go to **Deployments** tab
2. Click on the latest deployment
3. Click **"Redeploy"** (three dots menu)
4. Wait for deployment to complete

### Step 3: Repeat for admin.site (if needed)

If admin.site also uses chat functionality, repeat the same steps.

---

## Part 3: Environment Variables Reference

### Railway (Chat Server)

| Variable       | Required | Description                                 |
| -------------- | -------- | ------------------------------------------- |
| `MONGODB_URI`  | Yes      | MongoDB connection string for chat database |
| `REDIS_URL`    | Yes      | Redis connection for real-time pub/sub      |
| `JWT_SECRET`   | Yes      | JWT secret (must match server.me)           |
| `PORT`         | Yes      | Server port (default: 3002)                 |
| `NODE_ENV`     | Yes      | `production` or `development`               |
| `CORS_ORIGIN`  | Yes      | Comma-separated list of allowed origins     |
| `MAIN_API_URL` | Yes      | Backend API URL for property validation     |

### Vercel (Frontend)

| Variable               | Required | Description             |
| ---------------------- | -------- | ----------------------- |
| `NEXT_PUBLIC_CHAT_URL` | Yes      | Railway chat server URL |

---

## Part 4: Troubleshooting

### Build Fails on Railway

**Error**: `Cannot find module '@majestic/chat-shared'`

**Solution**: Ensure build command is:

```
npm run build:shared && npm run build:server
```

### CORS Errors

**Error**: `Access-Control-Allow-Origin` errors in browser

**Solution**:

1. Check `CORS_ORIGIN` variable includes your frontend domain
2. Ensure no trailing slashes in the domain
3. Redeploy after changing variables

### Connection Refused

**Error**: `Failed to connect to chat server`

**Solution**:

1. Verify Railway service is running (green status)
2. Check `NEXT_PUBLIC_CHAT_URL` has correct Railway domain
3. Ensure `https://` prefix is included
4. Redeploy frontend after updating variable

### JWT Verification Failed

**Error**: Authentication errors in chat

**Solution**:

1. Ensure `JWT_SECRET` in Railway matches `JWT_SECRET` in server.me
2. Check token is being passed correctly from frontend

### Redis Connection Failed

**Error**: Redis client errors in Railway logs

**Solution**:

1. Verify `REDIS_URL` is correct
2. Check Redis instance is running
3. Ensure Redis allows connections from Railway IP

### URL Appending Instead of Replacing

**Error**: Request URL shows `your-domain.com/railway-url/api/...`

**Solution**:

1. Ensure `NEXT_PUBLIC_CHAT_URL` starts with `https://`
2. No trailing slash at the end
3. Redeploy frontend after fixing

---

## Part 5: Useful Commands

### Local Development

```bash
# Start chat server locally
cd majestic-chat
npm install
npm run dev:server
```

### Build Locally

```bash
# Build all packages
npm run build

# Build specific packages
npm run build:shared
npm run build:server
```

### Check Logs on Railway

1. Go to Railway dashboard
2. Click on service
3. Go to **Deployments** tab
4. Click on deployment
5. View **Deploy Logs** or **HTTP Logs**

---

## Part 6: URLs Reference

### Development Environment

- **Frontend**: https://user.me.coderelix.in
- **Admin**: https://admin.me.coderelix.in
- **Backend API**: https://server-me.coderelix.in
- **Chat Server**: https://majesticchat-server-production.up.railway.app

### Production Environment

- **Frontend**: https://www.majesticescape.in
- **Admin**: https://admin.majesticescape.in
- **Backend API**: https://server-me.majesticscape.in
- **Chat Server**: (deploy separate Railway instance for production)

---

## Part 7: Updating Redis (Future)

When you're ready to use Upstash Redis:

1. Create account at https://upstash.com
2. Create a new Redis database
3. Copy the connection string
4. Update `REDIS_URL` in Railway Variables
5. Railway will auto-redeploy

---

## Quick Checklist

### Railway Setup

- [ ] GitHub repo connected
- [ ] Root Directory: empty
- [ ] Build Command: `npm run build:shared && npm run build:server`
- [ ] Start Command: `node packages/server/dist/index.js`
- [ ] All 7 environment variables added
- [ ] Domain generated
- [ ] Deployment successful (green status)
- [ ] Health endpoint returns OK

### Vercel Setup

- [ ] `NEXT_PUBLIC_CHAT_URL` added with `https://` prefix
- [ ] Frontend redeployed
- [ ] Chat functionality tested

---

## Support

If deployment fails:

1. Check Railway deployment logs
2. Verify all environment variables
3. Test health endpoint
4. Check browser console for frontend errors
5. Verify CORS configuration

Last updated: January 30, 2026
