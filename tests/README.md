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
| `test-install-script.sh` | The `curl -fsSL …/install-sync-server.sh \| bash` guide: `--check` stays read-only and chooses `LOCAL_INTEGRATION`, install exits 0, backend answers on the promised loopback port, no git checkout, client e2e through a real TLS nginx, idempotent re-run, data survives `compose down/up`, a second directory is refused. | A Linux host with docker (CI runner, scratch VPS) |
| `local/run-install-test-in-container.mjs` | Builds a cached Ubuntu+Docker CLI+Node image and runs `test-install-script.sh` against the host Podman/Docker socket (`--network=host`). Safe from Windows PowerShell / npm: talks to `podman.exe` directly. Nested `dockerd` is not used — rootless Podman cannot give it cgroups. On rootless Podman the launcher writes a user `containers.conf.d` drop-in (`firewall_driver = "none"`) so compose can create a custom network and publish `127.0.0.1:PORT` — netavark+nftables cannot apply rules in the user namespace. | Any machine with podman or docker |

## Quick start

```bash
# 1. App-level e2e against a server you already run somewhere:
node tests/e2e-client.mjs --server https://sync.example.com --token YOUR_TOKEN

# 2. Full check of the Docker guide (pulls ghcr.io …:latest):
npm run test:docker-guide            # DOCKER_BIN=podman is auto-detected

# 3. Full check of the curl|bash guide — on a Linux box with docker:
npm run test:install-script

# 3b. …or from this dev box via podman/docker (disposable container):
npm run test:install-script:local                                  # local installer
node tests/local/run-install-test-in-container.mjs                 # prod script
# From the app repo: npm run test:installer:e2e
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
- Rootless Podman on Windows: the first local run may restart the user
  `podman.service` API so the firewall drop-in is picked up. Running
  containers (including `local-postgres`) stay up; the machine is not
  rebooted. The drop-in lives at
  `~/.config/containers/containers.conf.d/99-fc-installer-e2e.conf` inside
  the Podman machine.
