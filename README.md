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

# 2. Recommended for production: pin a release image in .env
# FOCUS_COMPASS_IMAGE=ghcr.io/focus-compass/focus-compass-sync-server:0.0.1

# 3. Start server
docker compose up -d

# 4. View logs
docker compose logs -f

# 5. Check status
docker ps

# Stop server
docker compose down

# Full cleanup (including data)
docker compose down -v
```

This compose file already uses the published GHCR image by default. `latest` is fine for trying the project quickly, but for production deployments you should pin `FOCUS_COMPASS_IMAGE` to a concrete release tag.

If you prefer not to use Compose, you can run the same image directly:

### Run Published Docker Image Directly

Published image URL:

```text
ghcr.io/focus-compass/focus-compass-sync-server
```

Try the latest published release:

```bash
docker run -d \
  --name focus-compass-sync-server \
  -p 8080:8080 \
  -v focus-compass-data:/app/data \
  -e HOCUSPOCUS_TOKEN=your-secret-token \
  ghcr.io/focus-compass/focus-compass-sync-server:latest
```

Production example with a pinned release:

```bash
docker run -d \
  --name focus-compass-sync-server \
  -p 8080:8080 \
  -v focus-compass-data:/app/data \
  -e HOCUSPOCUS_TOKEN=your-secret-token \
  ghcr.io/focus-compass/focus-compass-sync-server:0.0.1
```

Compose example using the published image:

```yaml
services:
  focus-compass:
    image: ghcr.io/focus-compass/focus-compass-sync-server:latest
    restart: unless-stopped
    ports:
      - "8080:8080"
    environment:
      PORT: 8080
      HOCUSPOCUS_TOKEN: your-secret-token
    volumes:
      - focus-compass-data:/app/data

volumes:
  focus-compass-data:
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

# Max Yjs document size decoded by REST/MCP read endpoints (bytes)
# Increase only if you need to inspect very large documents.
MAX_DOC_DECODE_BYTES=134217728

# CORS (comma-separated allowlist or '*')
CORS_ALLOW_ORIGINS=*

# Yjs GC (default: true). Smaller docs, but full Yjs history is discarded.
YJS_GC=true
```

`HOCUSPOCUS_TOKEN` is optional. If it is not set, the server starts in setup mode and the first visit to `/` can generate and persist a token to `./data/auth.json`.

`MAX_DOC_DECODE_BYTES` protects admin/workspace/MCP read endpoints from decoding extremely large Yjs documents in one request. This helps prevent out-of-memory crashes on small hosts.

`YJS_GC` defaults to `true` in this server. That keeps document size smaller, but full Yjs edit history is not preserved. Database backups still preserve point-in-time snapshots of the current state.

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
  token: 'your-auth-token',
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
5. **Pin Docker versions** - Use a fixed image tag (`:0.0.1`) for production instead of `:latest`.

Resource limits are intentionally not encoded in the default compose file, because support differs across runtimes and Compose implementations. Set CPU/memory limits in the platform that actually runs the container.

## Docker Publishing

This repository includes a GitHub Actions workflow at `.github/workflows/publish-docker.yml` that publishes images to GHCR.

Main branch pushes publish mutable development tags:

- `ghcr.io/focus-compass/focus-compass-sync-server:edge`
- `ghcr.io/focus-compass/focus-compass-sync-server:sha-<commit>`

Version tag pushes such as `v0.0.1` publish release tags:

- `ghcr.io/focus-compass/focus-compass-sync-server:v0.0.1`
- `ghcr.io/focus-compass/focus-compass-sync-server:0.0.1`
- `ghcr.io/focus-compass/focus-compass-sync-server:0.0`
- `ghcr.io/focus-compass/focus-compass-sync-server:latest`

Release flow:

```bash
git tag v0.0.1
git push origin v0.0.1
```

After the first publish, check the package visibility in GHCR. GitHub's container registry defaults new packages to private until you explicitly make them public.

## MCP (Model Context Protocol)

This server exposes a read-only MCP endpoint so that MCP clients (Claude Code, Claude Desktop, etc.) can query Focus Compass workspaces/projects directly from the SQLite database.

- **Endpoint:** `POST /mcp` (Streamable HTTP, stateless)
- **Auth:** `Authorization: Bearer <mcp-token>` (separate from the master token)
- **Persistence:** generated tokens are stored at `./data/mcp-auth.json` by default
- **Response mode:** JSON responses (no SSE), but clients must still send `Accept: application/json, text/event-stream` per MCP Streamable HTTP rules.
- **Request limit:** MCP request body is limited to 1 MiB.

MCP is disabled by default unless you set `MCP_TOKEN`. To enable it from the dashboard:

1) Open `http://localhost:8080/` and sign in with the master token
2) Go to the **MCP Access** section and click **Enable MCP**
3) Copy the generated MCP token

You can also manage MCP via API (master token required for write actions):

- `GET /api/mcp/status` - MCP enabled/env-managed flags
- `POST /api/mcp/enable` - generate and enable an MCP token
- `POST /api/mcp/rotate` - rotate MCP token (returns the new token)
- `POST /api/mcp/disable` - disable MCP and revoke the token

### Available MCP tools (read-only)

- `list_documents` - list all documents (workspaces) with basic summary
- `get_workspace` - workspace overview with configurable sections (`project_info`, `current_focus`, `next_tasks`, `completed_tasks`, `notes`)
- `list_projects` - list projects in a document (IDs/titles; optional `project_info`)
- `get_project` - get a single project by ID (includes tasks/notes)

### Connect from Claude Code

```bash
claude mcp add --transport http focus-compass http://localhost:8080/mcp \
  --header "Authorization: Bearer YOUR_MCP_TOKEN"
```

### Optional: /focus-compass skill

Claude Code can load a custom **skill** that adds a `/focus-compass` command.

- Skills docs: <https://code.claude.com/docs/en/skills>
- Skill template (served by this server): <http://localhost:8080/focus-compass-skill.md>

Install (macOS/Linux):

```bash
mkdir -p ~/.claude/skills/focus-compass
curl -fsSL http://localhost:8080/focus-compass-skill.md -o ~/.claude/skills/focus-compass/SKILL.md
```

Install (Windows PowerShell):

```powershell
New-Item -ItemType Directory -Force -Path "$env:USERPROFILE\.claude\skills\focus-compass" | Out-Null
Invoke-WebRequest "http://localhost:8080/focus-compass-skill.md" -OutFile "$env:USERPROFILE\.claude\skills\focus-compass\SKILL.md"
```

### Claude Code install prompt (optional)

Paste this into Claude Code (replace `YOUR_MCP_TOKEN`):

```text
Install Focus Compass integration:

1. Add MCP server:
   claude mcp add --transport http focus-compass http://localhost:8080/mcp --header "Authorization: Bearer YOUR_MCP_TOKEN"

2. Install skill (download template and save as personal skill):
   - Template URL: http://localhost:8080/focus-compass-skill.md
   - Save to: ~/.claude/skills/focus-compass/SKILL.md (macOS/Linux) or %USERPROFILE%\.claude\skills\focus-compass\SKILL.md (Windows)

After setup, show me a quick overview of my projects using /focus-compass.
```

Project-wide config (optional): create `.mcp.json` and use an env var so you don't commit tokens:

```json
{
  "mcpServers": {
    "focus-compass": {
      "type": "http",
      "url": "http://localhost:8080/mcp",
      "headers": {
        "Authorization": "Bearer ${FOCUS_COMPASS_MCP_TOKEN}"
      }
    }
  }
}
```

### Smoke test with curl

Initialize:

```bash
curl -X POST http://localhost:8080/mcp \
  -H "Authorization: Bearer YOUR_MCP_TOKEN" \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-03-26","capabilities":{},"clientInfo":{"name":"curl","version":"1"}}}'
```

List documents:

```bash
curl -X POST http://localhost:8080/mcp \
  -H "Authorization: Bearer YOUR_MCP_TOKEN" \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -d '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"list_documents","arguments":{}}}'
```

## License

Apache-2.0 - see [LICENSE](LICENSE).
