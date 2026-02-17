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
- `GET /api/mcp/status` - MCP enabled/env-managed status (no auth required)
- `POST /api/mcp/enable` - Generate and enable MCP token (master token required)
- `POST /api/mcp/rotate` - Rotate MCP token (master token required)
- `POST /api/mcp/disable` - Disable MCP and revoke token (master token required)

**Static Routes**:
- `/` or `/index.html` - Admin UI (see `src/index.html`)
- `/mcp.html` - MCP help/setup page
- `/focus-compass-skill.md` - Claude Code skill template

**Healthcheck**:
- `GET /health` (health-check) - Returns `{ ok: true }`

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
IMAGES_DIR=./data/images            # Image storage directory
BACKUP_DIR=./data/backups           # Backup directory
BACKUP_INTERVAL_MINUTES=60          # Backup frequency
BACKUP_RETENTION_DAYS=7             # Backup retention
MAX_UPLOAD_BYTES=10485760           # Upload limit (bytes)
CORS_ALLOW_ORIGINS=*                # CORS allowlist (comma-separated) or '*'
YJS_GC=false                        # Enable Yjs GC (smaller docs, less history)
```

## Docker

```bash
docker compose up -d    # Start with Docker Compose
```

Volume `hocuspocus-data` persists `/app/data` (database and images).

## MCP Server (Model Context Protocol)

The server exposes a read-only MCP endpoint at `POST /mcp` (Streamable HTTP, stateless mode) so that Claude Code and other MCP clients can read project/workspace data directly from the database.

Notes:
- `POST /mcp` only (no long-lived GET SSE streams).
- The Streamable HTTP transport expects `Accept: application/json, text/event-stream` and `Content-Type: application/json`.
- The server replies with JSON (no SSE streaming), but clients still send the Accept header above.
- Request body is limited to 1 MiB.
- MCP uses a separate token (`MCP_TOKEN`) and is disabled by default unless configured.
- Enable/rotate/disable MCP from the admin UI (`/`) or via `/api/mcp/*` endpoints (master token required).
- A small help page is available at `/mcp.html`.

**MCP Tools** (read-only):
- `list_documents` - List all documents/workspaces with summary info
- `get_workspace` - Get workspace overview with configurable sections (project info, current focus, tasks, notes)
- `list_projects` - List projects in a document (IDs/titles; optional project info)
- `get_project` - Get a single project by ID

**Architecture**: `src/mcp/server.js` (factory), `src/mcp/tools.js` (tool definitions), `src/routes/mcp.js` (HTTP handler). Each request creates a fresh McpServer + transport pair (stateless pattern).

**Connect from Claude Code**:
```bash
claude mcp add --transport http focus-compass http://localhost:8080/mcp \
  --header "Authorization: Bearer YOUR_MCP_TOKEN"
```

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
