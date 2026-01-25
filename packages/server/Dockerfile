FROM node:20-alpine

WORKDIR /app

# Copy workspace files
COPY package*.json ./
COPY tsconfig.base.json ./
COPY packages/shared ./packages/shared
COPY packages/server ./packages/server

# Install dependencies
RUN npm install

# Build packages
RUN npm run build:shared
RUN npm run build:server

# Expose port
EXPOSE 3001

# Start server
CMD ["npm", "run", "start", "-w", "@majestic/chat-server"]
