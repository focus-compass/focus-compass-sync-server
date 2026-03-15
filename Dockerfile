# Use official Node.js image
FROM node:24-alpine AS deps

WORKDIR /app

# Build deps for native modules (e.g. sqlite3)
RUN apk add --no-cache python3 make g++


# Install production dependencies
COPY package*.json ./
RUN npm ci --omit=dev


FROM node:24-alpine

WORKDIR /app
ENV NODE_ENV=production
LABEL org.opencontainers.image.source="https://github.com/focus-compass/focus-compass-sync-server"
LABEL org.opencontainers.image.description="Real-time collaboration server based on Hocuspocus/Yjs with SQLite persistence"

COPY --from=deps --chown=node:node /app/node_modules ./node_modules
COPY --chown=node:node package*.json ./
COPY --chown=node:node src ./src

RUN mkdir -p /app/data

EXPOSE 8080

ENV NODE_OPTIONS="--max-old-space-size=768"

CMD ["node", "src/server.js"]
