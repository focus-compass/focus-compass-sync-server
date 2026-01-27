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

COPY --from=deps /app/node_modules ./node_modules
COPY package*.json ./
COPY src ./src

# Create data directory
RUN mkdir -p /app/data

EXPOSE 8080

CMD ["node", "src/server.js"]
