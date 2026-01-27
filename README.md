# Focus Compass - Hocuspocus Server

WebSocket server for real-time collaboration based on [Hocuspocus](https://tiptap.dev/docs/hocuspocus/introduction) with SQLite persistence.

## What is Hocuspocus?

Hocuspocus is a WebSocket backend based on CRDT (Conflict-free Replicated Data Type) using the Yjs library. It provides:

- ✅ **Real-time synchronization** of data between clients
- ✅ **Conflict-free collaboration** (multiple users can edit data simultaneously)
- ✅ **Persistence** of data in SQLite
- ✅ **Offline-first** approach
- ✅ **Automatic conflict resolution**

## Architecture

```
┌─────────────┐
│   Client 1  │──┐
└─────────────┘  │
                 │     ┌──────────────────┐      ┌──────────────┐
┌─────────────┐  ├────▶│  Hocuspocus WS   │─────▶│   SQLite DB  │
│   Client 2  │──┤     │     Server       │      │ (Persistent) │
└─────────────┘  │     └──────────────────┘      └──────────────┘
                 │            ▲
┌─────────────┐  │            │
│   Client N  │──┘            │
└─────────────┘               │
                        Port 8080
```

## Quick Start

### Run with Docker Compose (Recommended)

```bash
# 1. Copy example env file (optional)
cp .env.example .env

# 2. Start server
docker-compose up -d

# 3. View logs
docker-compose logs -f

# 4. Check status
docker ps

# Stop server
docker-compose down

# Full cleanup (including data)
docker-compose down -v
```

### Run Locally

```bash
# Install dependencies
npm install

# Start server
npm start
```

The server will be available at `ws://localhost:8080`.

## Configuration

### Key Files

- **`src/server.js`** - Hocuspocus server configuration
- **`Dockerfile`** - Docker image for deployment
- **`docker-compose.yml`** - Container orchestration
- **`package.json`** - Project dependencies

### Environment Variables

Create a `.env` file in the project root (or copy `.env.example`):

```bash
# HTTP/WebSocket port the server listens on
PORT=8080

# Docker Compose host port mapping (optional)
HOCUSPOCUS_PORT=8080

# Required in production (Bearer token for WS + REST)
HOCUSPOCUS_TOKEN=your-secret-token

# Data paths
DB_PATH=./data/db.sqlite
IMAGES_DIR=./data/images
BACKUP_DIR=./data/backups

# Backups
BACKUP_INTERVAL_MINUTES=60
BACKUP_RETENTION_DAYS=7

# Upload limits
MAX_UPLOAD_BYTES=10485760

# CORS (comma-separated allowlist or '*')
CORS_ALLOW_ORIGINS=*

# Yjs GC (set true to reduce doc size, loses full history)
YJS_GC=false
```

Note: when `NODE_ENV=production`, the server requires `HOCUSPOCUS_TOKEN` (and refuses to start with the demo token unless `ALLOW_INSECURE_DEMO_TOKEN=true`).

### Persistence

The SQLite database is saved in the Docker volume `hocuspocus-data`, mounted to `/app/data` inside the container.
Database file: `/app/data/db.sqlite`.

**Important**: Removing the volume with `docker-compose down -v` will lose all data!

## Client Connection

### JavaScript/TypeScript (Browser)

```bash
npm install @hocuspocus/provider yjs
```

```javascript
import * as Y from 'yjs'
import { HocuspocusProvider } from '@hocuspocus/provider'

// Create Yjs document
const doc = new Y.Doc()

// Connect to server
const provider = new HocuspocusProvider({
  url: 'ws://localhost:8080',
  name: 'my-document', // unique document name
  document: doc,
})
```

## Monitoring

### Healthcheck

Docker Compose is configured with an automatic healthcheck:
- **Interval**: 30s
- **Timeout**: 10s
- **Retries**: 3

The server also exposes `GET /health` (health-check) which returns `{ ok: true }`.

### Logs

Server outputs logs like:
- `🚀 Hocuspocus server starting on port 8080...`
- `✅ Server running at http://localhost:8080`

## Production Deployment

### Recommendations

1. **Use HTTPS/WSS** - Configure SSL certificates (e.g., via Nginx reverse proxy).
2. **Add Redis** - For scaling to multiple instances.
3. **Configure Auth** - Protect access to documents.
4. **Backup** - Regularly backup the SQLite database.

## License

Apache-2.0 - see [LICENSE](LICENSE).
