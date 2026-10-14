# Changelog

## 0.1.0 - 2026-10-14

### Added
- Multiple access tokens. Issue any number of named tokens from the admin
  page (name optional; auto-named `Token N`), see their masked prefix,
  creation date and last use, and revoke them individually. The full token is
  shown exactly once after creation, with a copy button.
- `GET/POST /api/auth/tokens` and `DELETE /api/auth/tokens/:id`.
- Tokens are stored as SHA-256 hashes in `TOKENS_FILE_PATH`
  (default `./data/tokens.json`); plaintext is never written to disk.

### Changed
- REST and WebSocket auth accept any non-revoked access token.
- First-run setup now creates a token named "Default".
- `ACCESS_TOKEN` (if set) is accepted alongside UI-managed tokens and is
  listed as an env-managed, non-revocable entry.

### Removed (breaking)
- The single master token stored in `auth.json` is no longer read, and there
  is no automatic migration. After upgrading, a server without `ACCESS_TOKEN`
  starts in setup mode again: open the admin page, generate a new token and
  reconnect clients with it. `AUTH_FILE_PATH` is no longer used.
- `POST /api/auth/rotate` and the "Change master token" dialog were removed;
  issue a new token and revoke the old one instead.
