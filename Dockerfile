# Use official Node.js image
FROM node:24-alpine AS deps

WORKDIR /app

# Build deps for native modules (e.g. sqlite3)
RUN apk add --no-cache python3 make g++ py3-setuptools


# Install production dependencies
COPY package*.json ./
RUN npm ci --omit=dev


FROM node:24-alpine

WORKDIR /app
ENV NODE_ENV=production
LABEL org.opencontainers.image.source="https://github.com/focus-compass/focus-compass-sync-server"
LABEL org.opencontainers.image.description="Real-time collaboration server based on Hocuspocus/Yjs with SQLite persistence"

# su-exec lets the entrypoint drop from root to the node user after fixing
# data-dir ownership (see docker-entrypoint.sh).
RUN apk add --no-cache su-exec

COPY --from=deps --chown=node:node /app/node_modules ./node_modules
COPY --chown=node:node package*.json ./
COPY --chown=node:node src ./src
COPY docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN chmod 0755 /usr/local/bin/docker-entrypoint.sh

# Create the data dir and hand it to the unprivileged node user so the
# runtime (and named volume, which inherits this ownership) is writable.
RUN mkdir -p /app/data && chown -R node:node /app/data

EXPOSE 8080

ENV NODE_OPTIONS="--max-old-space-size=768"

# Start as root so the entrypoint can take ownership of a root-owned data
# volume, then it drops to the unprivileged node user (su-exec) before running
# the server. A fresh/correctly-owned volume skips the chown and drops straight
# through, so the effective runtime user is still node in every case.
USER root
ENTRYPOINT ["docker-entrypoint.sh"]
CMD ["node", "src/server.js"]
