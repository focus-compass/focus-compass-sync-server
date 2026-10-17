# Changelog

All notable changes to the Focus Compass sync server are documented here.

## Unreleased

### Added

- Admin UI: an opened workspace now lists its projects, and each project opens
  on its own with its JSON in an editor (the raw workspace JSON is still
  available). Saving shows a diff and needs explicit confirmation; invalid
  JSON or schema violations are listed by path and nothing is saved; a
  concurrent change is reported as a conflict with a reload option; previous
  versions can be reviewed and restored from History.
- Project editor API under `/api/admin/documents/{doc}/projects` (master
  token): list, get, `PUT`, `PATCH`, `validate`, `history`, `restore`.
- `PROJECT_HISTORY_DB_PATH` (default `project-history.sqlite` next to the DB)
  and `PROJECT_HISTORY_LIMIT` (default 20).

## 0.0.9 - 2026-10-17

### Breaking

- MCP now uses multiple, individually revocable tokens instead of a single
  token. The `MCP_TOKEN` environment variable, `MCP_AUTH_FILE_PATH`, and the
  `mcp-auth.json` file are no longer read; an existing token is **not**
  migrated. After upgrading, create a new MCP token in the admin UI and update
  your MCP clients. A warning is logged if `MCP_TOKEN` is still set.
- Removed `POST /api/mcp/enable`, `POST /api/mcp/rotate`, and
  `POST /api/mcp/disable`. `GET /api/mcp/status` now returns only
  `{ enabled }` (no `envManaged`).

### Added

- MCP token management (master token required):
  - `GET /api/mcp/tokens` lists active tokens (name, prefix, creation date,
    last use).
  - `POST /api/mcp/tokens` issues a token. `name` is optional; without it
    the token is named "Token N". The full token is returned only in this
    response.
  - `DELETE /api/mcp/tokens/{id}` revokes a token.
- `POST /mcp` accepts any active MCP token. MCP is disabled while no token is
  active.
- MCP tokens have the form `mcp_focus_<43 random chars>`; the admin UI and
  API show only the first 16 characters.
- Only SHA-256 hashes of MCP tokens are stored, in a separate SQLite file
  (`MCP_TOKENS_DB_PATH`, default `mcp-tokens.sqlite` next to the database), so
  restoring a document backup cannot bring back a revoked token.
- Admin UI: the MCP Access section has a token list, a "Create MCP token"
  button that opens a dialog for an optional name, a one-time token reveal
  with a copy button, and revoke with confirmation.
