# Sync Server Guide Tests

Self-contained smoke/e2e tests for the two setup guides published at
[focus-compass.com/sync-server](https://focus-compass.com/sync-server) and for
the sync path the Focus Compass app actually uses. Run them after releasing a
new server image, changing the installer, or whenever you want proof that
"install → connect from the app → data persists" still works.

| Test | What it proves | Where it runs |
| --- | --- | --- |
| `e2e-client.mjs` | An app-equivalent client (HocuspocusProvider + Yjs `root` map) can authenticate, sync, write a workspace, read it back from a second client and over REST; auth rejects bad tokens; data survives restarts (`--phase verify`). | Anywhere with node >= 24, against any server URL |
| `test-docker-guide.sh` | The published GHCR image + the exact `docker run` command from the guide: anonymous pull, `/health` on the host port, no restart loop, full client e2e, data survives `docker restart` and stop/start. | Linux/macOS/WSL/Git Bash with docker **or podman** |
| `test-install-script.sh` | The `curl -fsSL …/install-sync-server.sh \| bash` guide: fresh install exits 0, server answers on the promised host port, `.env`/git checkout in place, client e2e, idempotent re-run, data survives `compose down/up`, occupied port is refused. | A Linux host with docker (CI runner, scratch VPS) |
| `local/run-install-test-in-container.sh` | Wrapper that runs `test-install-script.sh` inside a disposable privileged ubuntu container (docker-in-docker), so the installer test can run from a dev box. | Any machine with podman or docker |

## Quick start

```bash
# 1. App-level e2e against a server you already run somewhere:
node tests/e2e-client.mjs --server https://sync.example.com --token YOUR_TOKEN

# 2. Full check of the Docker guide (pulls ghcr.io …:latest):
npm run test:docker-guide            # DOCKER_BIN=podman is auto-detected

# 3. Full check of the curl|bash guide — on a Linux box with docker:
npm run test:install-script

# 3b. …or from this dev box via podman/docker (disposable container):
bash tests/local/run-install-test-in-container.sh                  # prod script
bash tests/local/run-install-test-in-container.sh --local \
     ../focus-compass-app/public/install-sync-server.sh            # local copy
```

Every script prints `RESULT: PASS|FAIL` and exits non-zero on failure, so they
can run in CI or cron as-is.

## e2e-client.mjs details

```
node tests/e2e-client.mjs [--server URL] [--token TOKEN] [--doc NAME]
                          [--phase full|verify] [--state-file PATH]
                          [--sync-timeout MS] [--store-timeout MS]
```

- `--phase full` (default) exercises: `/health`, `/api/auth/status`, first-run
  `/api/auth/setup`, REST 401 without token, websocket rejection of an invalid
  token, client A connect + write (same `root` map structure as the app:
  `workspace`, `projects[]` with `info.description`), REST snapshot polling
  (covers the 2s store debounce), independent client B read-back, and a
  disconnect/reconnect cycle. Writes `--state-file` for later verification.
- `--phase verify --state-file X` re-checks the same document after a server
  restart: auth stays initialized (setup returns 409), websocket and REST both
  still return the written data. This is the persistence proof.
- On an already-initialized server pass `--token` (or `E2E_TOKEN`); the test
  writes to its own uniquely-named document (`e2e-test-…`) and does not touch
  real workspaces.

## Notes

- The guide tests intentionally re-use the exact commands from the public
  guides; only names/ports/volumes are parameterized so runs never collide
  and can execute repeatedly on the same machine.
- `KEEP=1` keeps containers/volumes/install dirs around for debugging.
- The container wrapper cannot exercise the installer's own
  "apt-install docker + systemctl" branch (no systemd inside containers);
  run `test-install-script.sh` on a real VPS or CI runner to cover that.
