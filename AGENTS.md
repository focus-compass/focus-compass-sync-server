# AGENTS.md
This file is for agentic coding agents working in this repo.
Focus Compass Server is a small Node.js (ESM) WebSocket + REST server built on
Hocuspocus/Yjs with SQLite persistence.

## Project Snapshot
- Runtime: Node.js >= 24 (see `package.json`), ESM (`"type": "module"`)
- Entrypoint: `src/server.js`
- Persistence: SQLite file at `DB_PATH` (default `./data/db.sqlite`)
- Images: files under `IMAGES_DIR` (default `./data/images`) plus `*.meta.json`
- Auth: Bearer token (`ACCESS_TOKEN`) for WebSocket + all REST endpoints

## Commands
Local (no build step; plain Node runtime):
- Install deps: `npm ci` (preferred) or `npm install`
- Dev (watch): `npm run dev` (`node --watch src/server.js`)
- Start: `npm start` (`node src/server.js`)
- Lint: `npm run lint` (fix: `npm run lint:fix`)

Notes:
- Requires Node.js >= 24.
- npm is the expected package manager (`package-lock.json` is present).

Docker:
- Start: `docker compose up -d` (logs: `docker compose logs -f`)
- Stop: `docker compose down` (wipe volume: `docker compose down -v`, destructive)

Smoke checks:
- `curl http://localhost:8080/health`
- `curl -H "Authorization: Bearer $ACCESS_TOKEN" http://localhost:8080/api/images`
- Admin UI: `http://localhost:8080/`

### Tests
- No unit-test suite. `tests/` holds integration/e2e smoke tests for the
  published image and the setup guides; they need Docker and/or a running server:
  - `npm run test:e2e` — app-equivalent Hocuspocus client against a live server
  - `npm run test:docker-guide` — pulls and runs the published GHCR image
  - `npm run test:install-script` — exercises the `curl | bash` installer
- For a quick local check without Docker: `node --check src/server.js` (syntax)
  plus `npm run lint`.

### Linting
- ESLint v9 flat config in `eslint.config.js` (`@eslint/js` recommended).
- No formatter is configured; keep formatting changes local to the code you touch.
- Lint a single file: `npx eslint src/server.js` (add `--fix` to auto-fix).

## Repo Layout (high-signal files)
- `src/server.js`: entry point — Hocuspocus server + `onRequest` router that
  dispatches to `src/routes/*`; also sets CORS/security headers and auth hooks
- `src/routes/*.js`: REST handlers (`auth`, `images`, `admin`, `workspace`, `static`, `mcp`, `mcpAdmin`)
- `src/lib/*.js`: shared helpers (`auth`, `http`, `responses`, `db`, `fs`, `env`, …)
- `src/yjs/*.js`: Yjs document decoding/inspection helpers
- `src/services/backup.js`: `BackupService` used by `onStoreDocument`
- `src/index.html`: static admin UI served by the server
- `src/mcp/server.js`: MCP server factory (`createMcpServer`)
- `src/mcp/tools.js`: MCP tool definitions (read-only)
- `src/routes/mcp.js`: MCP HTTP handler (`POST /mcp`, stateless Streamable HTTP)
- `src/routes/mcpAdmin.js`: MCP admin API (`/api/mcp/*`)
- `src/focus-compass-skill.md`: Claude Code skill template (served as static)
- `eslint.config.js`: ESLint v9 flat config
- `docker-compose.yml`, `Dockerfile`: production containerization
- `CLAUDE.md`: repository-specific operational notes (keep consistent)

## Environment / Secrets
- Use `.env.example` as the source of truth for env var names.
- Do not commit secrets: `.env` is gitignored (see `.gitignore`).
- Do not commit runtime data: `data/`, `*.sqlite`, backups, images are ignored.
- Auth constraints (enforced in `src/server.js`):
  - If `ACCESS_TOKEN` is not set, the server starts in setup mode and the first
    visit to `/` can generate a token that is persisted to `AUTH_FILE_PATH` (default `./data/auth.json`).

## Code Style Guidelines
These guidelines reflect existing patterns and are designed to keep changes
coherent and ESLint-clean.

### JavaScript Modules & Imports
- Use ESM (`import`/`export`); do not introduce `require()`.
- Use `node:` specifiers for built-ins (e.g. `node:fs/promises`, `node:path`).
- Include file extensions for local imports (`./services/backup.js`) in ESM.
- Prefer named imports; keep imports at top; group roughly:
  side-effect imports, third-party, Node built-ins, local modules.

### Formatting
- Match the file's existing style first; for new/major edits prefer:
  - 2-space indentation; semicolons; double quotes
  - trailing commas in multi-line literals/args
- Keep functions small; avoid deep nesting by using early exits.

### Naming
- `camelCase` for variables and functions; verb phrases for functions.
- `PascalCase` for classes; `UPPER_SNAKE_CASE` for constants/regexes.
- Boolean names start with `is/has/should/can`.

### Types (JSDoc, not TypeScript)
- This repo is JavaScript-only today; use runtime validation for untrusted inputs.
- Use JSDoc for non-obvious shapes and exported APIs (`@param`, `@returns`).
- Avoid adding TypeScript without an explicit reason and repo-wide agreement.

### Error Handling & Control Flow (important)
Response helpers use a named sentinel — `RESPONSE_SENT`, a `Symbol` exported from
`src/lib/responses.js` — to short-circuit the router chain:
- `json()`, `text()`, and `noContent()` write the response then `throw RESPONSE_SENT`.
- After calling them, do not continue execution.
- In `catch` blocks meant for real errors, rethrow the sentinel first:
  `if (err === RESPONSE_SENT) throw err;`
- The top-level `onRequest` catch translates `RESPONSE_SENT` into the falsy
  `throw null` Hocuspocus expects (a truthy throw would crash the process).
- Avoid double-writing responses (Node errors if headers are already sent).

Practical implications:
- If you add a `try/catch` around route code, make sure the sentinel still escapes.
- If you stream a response manually (e.g. `pipeline(createReadStream(...), res)`),
  end by `throw RESPONSE_SENT` so later routes do not run.

### HTTP / REST Conventions
- All `/api/*` routes require Bearer token auth (see `checkAuth()`).
  - Respond `401` with `{ error: "Unauthorized" }` + `WWW-Authenticate: Bearer`.
- CORS + security headers are set at the top of `onRequest`; keep it that way.
- Handle preflight with `OPTIONS` -> `noContent()`.
- Use explicit status codes and stable JSON errors; prefer `Cache-Control: no-store`.

Caching in this codebase:
- JSON helpers default to `Cache-Control: no-store`.
- Images are served with an ETag and long-lived `Cache-Control`.

### Security / Input Validation
- Never compare auth tokens with `===`; reuse `safeEqual()` and token normalization.
- Validate path-like identifiers with an allowlist regex before `join()`.
- Do not trust client-provided MIME types; detect/verify server-side.
- Avoid logging sensitive values (tokens, raw auth headers, user-provided paths).

Common validation patterns:
- Image IDs must match `IMAGE_ID_RE` (`src/routes/images.js`) before any filesystem access.
- Document names are decoded and length-capped via `decodeDocName()` (`src/lib/db.js`).

### Filesystem & Data Handling
- Use `node:fs/promises` and `async` IO; keep operations best-effort when safe.
- Treat `ENOENT` as expected in cleanup paths and optional metadata reads.
- Prefer atomic/idempotent patterns (e.g. `COPYFILE_EXCL` for uploads).
- Keep `data/` as the only mutable on-disk area for runtime state.

For uploads/metadata:
- Temp uploads go under `IMAGES_DIR/.tmp` and are cleaned up best-effort.
- MIME metadata is written to `*.meta.json` as a best-effort optimization.

### Hocuspocus / Yjs Specifics
- WebSocket auth is enforced via `onAuthenticate`; keep REST + WS auth aligned.
- `onStoreDocument` is used for periodic DB backups; keep it fast and safe.
- `YJS_GC` toggles history retention; default is `true` (smaller docs, no full Yjs history).

When changing Yjs/Hocuspocus behavior:
- Prefer small, explicit changes; this server is intentionally minimal.
- Avoid expensive synchronous work inside request hooks.

### Admin UI (`src/index.html`)
- Served as a static file; no bundler and no external dependencies.
- Keep it self-contained (inline CSS/JS) and avoid adding frameworks.
- When changing API payload shapes, update both server handlers and this UI.
