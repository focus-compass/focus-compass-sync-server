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

- **`server.js`** - Hocuspocus server configuration
- **`Dockerfile`** - Docker image for deployment
- **`docker-compose.yml`** - Container orchestration
- **`package.json`** - Project dependencies

### Environment Variables

Create a `.env` file in the project root (or copy `.env.example`):

```bash
# Port for Hocuspocus server (default 8080)
HOCUSPOCUS_PORT=8080

# Node.js environment (production/development)
NODE_ENV=production
```

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
