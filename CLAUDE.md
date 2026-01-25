# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Focus Compass Server is a real-time collaborative WebSocket server built on Hocuspocus with SQLite persistence. It implements CRDT (Conflict-free Replicated Data Type) synchronization using Yjs for conflict-free document collaboration.

## Development Commands

```bash
npm run dev      # Start server with file watching (node --watch)
npm start        # Run production server
npm run lint     # Check code with ESLint
npm run lint:fix # Auto-fix ESLint violations
npm run format   # Format code with Prettier
```

Requires Node.js >= 24.0.0. Uses ES modules (`"type": "module"`).

## Architecture

**Entry Point**: `src/server.js` - Hocuspocus server with SQLite extension

**Key Components**:
- Hocuspocus Server (30s timeout, 2-10s debounce) handles WebSocket connections
- SQLite extension persists Yjs documents to `DB_PATH`
- BackupService (`src/services/backup.js`) handles database backups on document updates

**REST API Endpoints** (all require Bearer token auth):
- `POST /api/upload` - Image upload with idempotency (skips existing files)
- `GET /api/images` - List all images
- `GET /api/images/{id}` - Retrieve image with MIME type

**Static Routes**:
- `/` or `/index.html` - Demo client UI
- `/inspector` or `/inspector.html` - Server debugging UI

## Key Patterns

- **Event-driven hooks**: `onAuthenticate`, `onStoreDocument`, `onRequest`
- **Image metadata**: Stored as separate `.meta.json` files alongside image files
- **Path sanitization**: Image IDs validated with regex `[a-zA-Z0-9_-]` to prevent traversal
- **Idempotent uploads**: Existing files return `existed: true` without overwriting

## Environment Configuration

```bash
PORT=8080                           # Server port
HOCUSPOCUS_TOKEN=your-secret-token  # Bearer token for auth
DB_PATH=./data/db.sqlite            # SQLite database path
BACKUP_INTERVAL_MINUTES=60          # Backup frequency
BACKUP_RETENTION_DAYS=7             # Backup retention
IMAGES_DIR=./data/images            # Image storage directory
```

## Docker

```bash
docker compose up -d    # Start with Docker Compose
```

Volume `hocuspocus-data` persists `/app/data` (database and images).

## Client Connection Example

```javascript
import { HocuspocusProvider } from '@hocuspocus/provider';
import * as Y from 'yjs';

const ydoc = new Y.Doc();
const provider = new HocuspocusProvider({
  url: 'ws://localhost:8080',
  name: 'document-name',
  document: ydoc,
  token: 'your-auth-token',
});
```
