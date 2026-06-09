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

# Create the data dir and hand it to the unprivileged node user so the
# runtime (and named volume, which inherits this ownership) is writable.
RUN mkdir -p /app/data && chown -R node:node /app/data

EXPOSE 8080

ENV NODE_OPTIONS="--max-old-space-size=768"

# Drop root: run as the built-in unprivileged node user.
USER node

CMD ["node", "src/server.js"]
