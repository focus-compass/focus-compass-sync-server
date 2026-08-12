# Focus Compass Sync Server

Self-hosted sync backend for Focus Compass, a quiet workspace for busy minds.

[Focus Compass](https://focus-compass.com) is built for entrepreneurs, freelancers, indie hackers, and ADHD-friendly multi-project minds who need visual clarity without the usual project-management overhead. It puts scattered projects on one clear map, keeps attention on the current focus and next step, and makes it easy to turn project context into AI-ready prompts.

This repository contains the optional server that powers secure realtime sync for Focus Compass. It is a small Node.js service built on Hocuspocus/Yjs with SQLite persistence, bearer-token auth, image storage, backups, an admin UI, and optional read-only MCP access.

## Features

- Realtime sync over WebSockets with Hocuspocus/Yjs
- SQLite persistence under `./data` by default
- Bearer-token auth for both REST and WebSocket clients
- Admin UI at `/` for setup, storage, backups, and MCP token management
- Image upload and serving with server-side MIME validation
- Automatic SQLite backups with restore support
- Optional read-only MCP endpoint for AI clients

## Quick Start

### Local

1. Install dependencies: `npm ci`
2. Start the server: `npm run dev`
3. Open [http://localhost:8080](http://localhost:8080).

The server starts in setup mode and the first visit to `/` can generate a token that is stored next to the database by default.

This public first-visit initialization is intentional: the dashboard is the
consumer setup boundary, and creating the master token is its primary first-run
action. It does not require a separate bootstrap secret or pairing step.
Operators who prefer pre-provisioned credentials can set `ACCESS_TOKEN` instead.

### Docker

Default container image reference used by this repo:

```text
  ghcr.io/focus-compass/focus-compass-sync-server:v0.0.6
```

Start with the included compose file:

```bash
docker compose up -d
docker compose logs -f
```

The default `docker-compose.yml` points at the GHCR image reference above and persists runtime data in a Docker volume mounted to `/app/data`.

#### Port publishing vs. reverse proxy

- A plain `docker compose up` in this repository auto-loads
  `docker-compose.override.yml`, which publishes the server on the host as
  `${HOCUSPOCUS_PORT:-8080}` for direct
  `http://<host>:<port>` access.
- Behind a reverse proxy (Dokploy/Traefik, Caddy, nginx, …) the base
  `docker-compose.yml` only `expose`s the port on the compose network so the
  proxy can route to it — the host port is not bound. Deploy platforms that run
  `docker compose -f docker-compose.yml ...` explicitly get this automatically
  (an explicit `-f` skips the override). With a bare `docker compose up` behind
  your own proxy, delete `docker-compose.override.yml`.

The public VPS installer does not clone this repository or use its override
file. It generates a pinned Compose project of its own and always binds the
backend to `127.0.0.1:18080-18099`; on a clean standalone VPS it additionally
creates its own Caddy service for ports 80/443.

## Configuration

Use [.env.example](.env.example) as the source of truth for environment variable names.

| Variable | Default | Purpose |
| --- | --- | --- |
| `PORT` | `8080` | HTTP and WebSocket port |
| `ACCESS_TOKEN` | empty | Master token for REST and WebSocket auth |
| `MCP_TOKEN` | empty | Optional token for read-only MCP access |
| `DB_PATH` | `./data/db.sqlite` | SQLite database path |
| `IMAGES_DIR` | `./data/images` | Image storage directory |
| `BACKUP_DIR` | `./data/backups` | Backup storage directory |

Backup interval and retention are managed from the admin UI and stored in `backup-settings.json` next to the database.

## API Overview

- `GET /health` - health check
- `GET /` - admin UI
- `POST /api/auth/setup` - initialize a token when running in setup mode
- `GET /api/workspace/:document` - read a workspace snapshot
- `GET /api/images` - list images
- `POST /api/upload` - upload an image
- `POST /mcp` - optional read-only MCP endpoint

Most `/api/*` routes require `Authorization: Bearer <token>`. Public exceptions are `GET /api/auth/status`, `POST /api/auth/setup` while the server is not initialized, and `GET /api/mcp/status`. WebSocket connections use the same master token. MCP uses a separate token.

## Client Example

```js
import * as Y from "yjs";
import { HocuspocusProvider } from "@hocuspocus/provider";

const doc = new Y.Doc();

const provider = new HocuspocusProvider({
  url: "ws://localhost:8080",
  name: "my-document",
  document: doc,
  token: "your-master-token",
});
```

## MCP

When MCP is enabled, either with `MCP_TOKEN` or an admin-generated persisted token, the server exposes a read-only Model Context Protocol endpoint at `POST /mcp`. This is useful for AI clients that need structured access to Focus Compass data without direct database access.

Available tools:

- `list_documents`
- `get_workspace`
- `list_projects`
- `get_project`

Example for Claude Code:

```bash
claude mcp add --transport http focus-compass http://localhost:8080/mcp \
  --header "Authorization: Bearer YOUR_MCP_TOKEN"
```

The repository also serves a skill template at `/focus-compass-skill.md`.

## Contributing

If you contribute, keep changes small, follow the existing ESM/Node.js style, and run `npm run lint` before opening a PR.

## License

[Apache-2.0](LICENSE)
