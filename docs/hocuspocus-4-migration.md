# Hocuspocus 4 migration

This document records the migration of Focus Compass Sync Server from
Hocuspocus 3.4.4 to 4.6.0. It is both the compatibility record and the release
runbook. Do not remove the v3 fixture or its tests while v3 clients and the
v0.0.6 rollback image remain supported.

Primary references:

- [Official v3 to v4 upgrade guide](https://tiptap.dev/docs/hocuspocus/getting-started/upgrade)
- [Official Hocuspocus releases](https://github.com/ueberdosis/hocuspocus/releases)
- [Hocuspocus 4.6.0 source](https://github.com/ueberdosis/hocuspocus/tree/v4.6.0)
- [Pre-authentication resource-limit change](https://github.com/ueberdosis/hocuspocus/pull/1113)

## Selected version

All runtime Hocuspocus packages are pinned exactly to `4.6.0`. The npm registry
marked it as the stable `latest` release on 2026-08-10; no prerelease or
floating semver range is used. The repository already requires Node 24, which
is above Hocuspocus 4's Node 22 minimum.

The app remains on provider 3.4.4 for this server release. Hocuspocus documents
the wire protocol as compatible in both directions, and this repository tests
an actual 3.4.4 provider against the 4.6.0 server.

## Pre-migration behavior map

- `src/server.js` creates the built-in `Server` on one HTTP/WebSocket port.
- WebSocket authentication accepts the provider auth-frame token, the legacy
  `?token=` parameter, and the legacy first URL path segment. The returned
  connection context remains `{ user: { role: "authenticated" } }`.
- HTTP routes on the same listener provide health, first-visitor setup, auth
  administration, workspace snapshots, images, MCP, backups, and the unchanged
  admin dashboard assets.
- Public first-visitor setup atomically creates `auth.json`; this is an
  intentional onboarding decision. The installer does not create, accept, or
  print the master token.
- Yjs documents are stored in the `documents(name, data)` SQLite table. Images
  are separate files under `/app/data/images` and are not embedded in Yjs.
- `onStoreDocument` refreshes document metadata and schedules automatic
  backups after the SQLite extension has stored the document.
- Docker keeps the database, auth files, images, metadata, and backups in the
  existing `/app/data` volume. The root entrypoint fixes volume ownership and
  then runs the Node process as the unprivileged `node` user.
- The custom signal handler awaits `server.destroy()` before exit.

## Hocuspocus 4 changes and impact

| Upstream change | Focus Compass impact and resolution |
| --- | --- |
| Node.js 22 or newer is required. | No runtime change: Docker and `engines` already require Node 24. |
| Hook WebSocket payloads use web-standard `Request` and `Headers`; `onRequest` and `onUpgrade` retain Node HTTP objects. | `onAuthenticate` only uses the standard URL and `URLSearchParams` interfaces. Existing HTTP routing remains in `onRequest` and continues using Node request/response objects. |
| `onStoreDocument` uses `lastContext`/`lastTransactionOrigin` and removes connection-only fields. | Our hook only reads `document` and `documentName`, which are unchanged. No connection context is assumed during persistence. |
| Awareness payload and transaction origins are structured. | No affected hook or origin comparison exists in this server. |
| WebSocket options move into the server configuration. | `maxPayload` and compression policy are now set through `websocketOptions`. |
| Custom `handleConnection` and WebSocket types changed. | Not used; the built-in `Server` still owns HTTP upgrade and WebSocket lifecycle. |
| Provider close events retain only `code` and `reason`. | The app only consumes `code` and `reason`, so no app change is needed. |
| Default timeout increased from 30 to 60 seconds. | The established 30-second behavior is retained explicitly. Both v3 and v4 awareness heartbeats keep healthy idle clients connected. |
| SQLite moved from callback-based `sqlite3` to synchronous `better-sqlite3`. The file/schema format is declared compatible. | The old callback-await subclass is removed. The subclass now only enables `secure_delete` and closes the synchronous database. A real v3 database fixture and an old-image rollback test verify compatibility. |
| Messages are processed in arrival order; v4.5 batches outgoing updates. | This improves consistency and traffic under concurrent edits. Two-client v3/v4 tests cover bidirectional updates. |
| Store failures and graceful destroy handling were hardened in v4. | The existing custom signal path disables duplicate upstream signal handlers, awaits `destroy()`, and is verified on Linux with a document still inside the store debounce window. |
| v4.3 adds native pre-auth queue byte, message, and pending-document limits. | The server configures all three with tighter application-specific values. |
| v4 session awareness is opt-in. | It remains disabled by default. Enabling it would be incompatible with a rollback to the v3 server because a v3 server treats the composite routing key as a document name. |

## Security limits

| Setting | Default | Rationale |
| --- | ---: | --- |
| `MAX_WEBSOCKET_MESSAGE_BYTES` | 16 MiB | Hard cap on a complete message after fragmented frames are reassembled. It also bounds a single auth frame or Yjs update. Current production-style fixture documents are tens of KiB and images use the separate 10 MiB HTTP upload route, leaving a large safety margin without permitting unbounded messages. Compression is disabled to avoid compressed-message amplification. |
| `MAX_UNAUTHENTICATED_QUEUE_BYTES` | 256 KiB | Bounds queued non-auth messages per socket before any document authenticates. This is much tighter than Hocuspocus's 5 MiB default. |
| `MAX_UNAUTHENTICATED_QUEUE_MESSAGES` | 32 | Prevents many tiny messages from bypassing the byte limit. This is tighter than the upstream default of 1000. |
| `MAX_PENDING_DOCUMENTS` | 8 | Prevents one unauthenticated multiplexed socket from opening an excessive number of pending document handshakes. |
| `HOCUSPOCUS_TIMEOUT_MS` | 30000 | Absolute deadline until the first successful document authentication, not refreshed by hostile traffic. After authentication it is the idle-message timeout. Provider awareness renewals occur every 15 seconds. |
| document name | 512 UTF-16 code units | Reuses the existing REST document-name bound at WebSocket authentication. |

`maxPayload` is an update/message limit, not a cumulative Yjs document-size
limit. Hocuspocus has no reliable native total-document cap, and rejecting an
already-applied CRDT update would risk partial state or data loss. The existing
128 MiB REST/MCP decode guard and 768 MiB container heap remain separate last
lines of defence. Enforce aggregate connection/rate limits at the trusted
reverse proxy; Hocuspocus 4.6.0 does not expose a dependable built-in global
connection limit.

Malformed messages, fragmented messages whose reassembled size exceeds the
limit, oversized pre-auth queues, excess pending documents, and auth timeouts
close only the offending socket. The process remains healthy and accepts a
normal authenticated client afterward.

## Compatibility evidence

`tests/fixtures/hocuspocus-v3` was generated by the unmodified v0.0.6 server
with Hocuspocus 3.4.4 and the real E2E client before dependencies were upgraded.
It contains the resulting SQLite database and auth files, not a hand-built
approximation.

The integration suite verifies:

- first setup, setup locking, token secrecy, token rotation, and rejection of
  missing, wrong, and revoked tokens;
- real 3.4.4 and 4.6.0 providers, two-client synchronization, restart, and a
  connection held beyond the 30-second idle timeout;
- loading and round-tripping the v3 SQLite fixture without changing `auth.json`;
- no document creation by unauthorized clients;
- real RFC 6455 sockets, malformed frames/messages, fragmented oversize input,
  pre-auth limits, authenticated oversize updates, and recovery after attacks;
- graceful `SIGTERM` persistence while a store is still debounced (Linux).

Container E2E must additionally verify a fresh volume, the v3 fixture volume,
restart, container recreation, effective runtime UID, health, and `SIGTERM`.
Before release, run a v4 -> v0.0.6 -> v4 cycle on the same disposable volume.

## Release and rollback runbook

The next server version is `0.0.7`. Do not change the app installer until the
multi-architecture manifest exists and all commands below pass.
The server Compose file is prepared for the matching v0.0.7 tag. The app
installer intentionally remains pinned to published v0.0.6 until the new
multi-platform digest exists.

1. Re-run repository checks and build both platforms without publishing:

   ```sh
   npm ci
   npm test
   npm run lint
   npm audit --omit=dev
   docker buildx build --platform linux/amd64,linux/arm64 \
     --output=type=oci,dest=focus-compass-server-0.0.7.oci.tar .
   ```

2. Push the reviewed commit to `main`. The workflow must pass validation and
   publish only the multi-architecture `edge` and `sha-*` images. It must not
   move `latest` yet:

   ```sh
   git push origin main
   ```

3. Inspect the published `sha-*` image, confirm both target platforms, and run
   the smoke E2E against its immutable digest. Only then create and push the
   signed stable tag:

   ```sh
   docker buildx imagetools inspect \
     ghcr.io/focus-compass/focus-compass-sync-server:sha-<commit>
   git tag -s v0.0.7 -m "focus-compass-server v0.0.7"
   git push origin v0.0.7
   ```

4. Wait for the tag workflow and GitHub release, then resolve and record the
   immutable stable multi-platform manifest digest:

   ```sh
   docker buildx imagetools inspect \
     ghcr.io/focus-compass/focus-compass-sync-server:v0.0.7
   ```

   The release is not ready until the digest is known and both `linux/amd64`
   and `linux/arm64` are present.

5. In the app repository, make the minimal installer-only change:

   - increment `INSTALLER_VERSION`;
   - set `SYNC_SERVER_IMAGE_TAG="v0.0.7"`;
   - set `SYNC_SERVER_IMAGE_DIGEST` to the published manifest digest;
   - do not alter the stable Compose project, service, volume, URL, token, or
     first-visitor setup behavior;
   - run the installer test suite.

6. Canary one existing VPS: take a backup, record the current v0.0.6 digest,
   run the updated installer, verify health/setup remains locked, connect using
   an existing connection link, edit from two app clients, upload/read an image,
   restart the container, and verify the same document and token again. Watch
   memory, reconnects, auth failures, and store errors before wider rollout.

7. Rollback keeps the volume and restores only the previous immutable image:

   ```sh
   docker pull \
     ghcr.io/focus-compass/focus-compass-sync-server:v0.0.6@sha256:8215bee768f632a1059de0d8f6d231b582678ff6e0f181711b534f009d8442d7
   docker compose up -d --no-deps --force-recreate focus-compass
   ```

   First restore the previous `FOCUS_COMPASS_IMAGE` value in the managed `.env`.
   Do not delete or recreate the data volume. Verify health, the existing token,
   and a read/write/restart cycle after rollback.
