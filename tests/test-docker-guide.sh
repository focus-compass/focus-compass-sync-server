#!/usr/bin/env bash
# Tests the "Docker" setup guide from https://focus-compass.com/sync-server:
#
#   docker run -d \
#     --name focus-compass-sync-server \
#     --restart unless-stopped \
#     -p 8080:8080 \
#     -v hocuspocus-data:/app/data \
#     ghcr.io/focus-compass/focus-compass-sync-server:latest
#
# What it verifies:
#   1. The published image can be pulled anonymously.
#   2. The container starts and /health answers from the host.
#   3. The container stays up (no restart loop, no crash logs).
#   4. A client that behaves exactly like the Focus Compass app can
#      authenticate, sync, and write data (tests/e2e-client.mjs).
#   5. Data survives `docker restart` and a full stop/start (named volume).
#
# Usage:
#   bash tests/test-docker-guide.sh
#
# Environment overrides:
#   IMAGE       image to test (default: ghcr.io/focus-compass/focus-compass-sync-server:latest)
#   HOST_PORT   host port to publish (default: first free port from 18090)
#   DOCKER_BIN  docker | podman (default: docker, falls back to podman)
#   KEEP=1      keep the container and volume around for debugging
#
# Requires: bash, curl, node >= 24 (for the e2e client), docker or podman.
set -u -o pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(dirname "${SCRIPT_DIR}")"

IMAGE="${IMAGE:-ghcr.io/focus-compass/focus-compass-sync-server:latest}"
RUN_ID="$(date +%s)-$RANDOM"
CONTAINER_NAME="fc-sync-guide-test-${RUN_ID}"
VOLUME_NAME="fc-sync-guide-data-${RUN_ID}"
STATE_FILE="${TMPDIR:-/tmp}/fc-sync-e2e-state-${RUN_ID}.json"
HEALTH_TIMEOUT_SECONDS="${HEALTH_TIMEOUT_SECONDS:-90}"
STABILITY_WINDOW_SECONDS="${STABILITY_WINDOW_SECONDS:-10}"

PASS_COUNT=0
FAIL_COUNT=0

log()  { printf '\n=== %s\n' "$*"; }
ok()   { PASS_COUNT=$((PASS_COUNT + 1)); printf '[ok]   %s\n' "$*"; }
fail() { FAIL_COUNT=$((FAIL_COUNT + 1)); printf '[FAIL] %s\n' "$*" >&2; }

# --- container engine ---------------------------------------------------------
DOCKER_BIN="${DOCKER_BIN:-}"
if [ -z "${DOCKER_BIN}" ]; then
  if command -v docker >/dev/null 2>&1; then
    DOCKER_BIN="docker"
  elif command -v podman >/dev/null 2>&1; then
    DOCKER_BIN="podman"
  else
    echo "[FAIL] Neither docker nor podman found in PATH." >&2
    exit 1
  fi
fi

if ! "${DOCKER_BIN}" info >/dev/null 2>&1; then
  echo "[FAIL] ${DOCKER_BIN} daemon is not reachable." >&2
  exit 1
fi
echo "Using container engine: ${DOCKER_BIN}"

# --- pick a free host port ----------------------------------------------------
port_is_free() {
  ! curl -s -o /dev/null --connect-timeout 1 "http://127.0.0.1:$1/" 2>/dev/null
}

HOST_PORT="${HOST_PORT:-}"
if [ -z "${HOST_PORT}" ]; then
  for candidate in 18090 18091 18092 18093 18094; do
    if port_is_free "${candidate}"; then
      HOST_PORT="${candidate}"
      break
    fi
  done
fi
if [ -z "${HOST_PORT}" ]; then
  echo "[FAIL] Could not find a free host port (tried 18090-18094)." >&2
  exit 1
fi
BASE_URL="http://127.0.0.1:${HOST_PORT}"

# --- cleanup ------------------------------------------------------------------
cleanup() {
  if [ "${KEEP:-0}" = "1" ]; then
    echo "KEEP=1 — leaving container ${CONTAINER_NAME} and volume ${VOLUME_NAME} in place."
    return
  fi
  "${DOCKER_BIN}" rm -f "${CONTAINER_NAME}" >/dev/null 2>&1 || true
  "${DOCKER_BIN}" volume rm "${VOLUME_NAME}" >/dev/null 2>&1 || true
  rm -f "${STATE_FILE}" >/dev/null 2>&1 || true
}
trap cleanup EXIT

wait_for_health() {
  local deadline=$(( $(date +%s) + $1 ))
  while [ "$(date +%s)" -lt "${deadline}" ]; do
    if curl -fsS --max-time 3 "${BASE_URL}/health" 2>/dev/null | grep -q '"ok":true'; then
      return 0
    fi
    sleep 2
  done
  return 1
}

# --- 1. pull ------------------------------------------------------------------
log "Step 1: pull published image (${IMAGE})"
if "${DOCKER_BIN}" pull "${IMAGE}" >/dev/null 2>&1; then
  ok "image pulled anonymously"
else
  fail "cannot pull ${IMAGE} — image missing or GHCR package not public"
  echo "RESULT: FAIL (${FAIL_COUNT} failed)"
  exit 1
fi

# --- 2. run exactly like the guide (parameterized name/port/volume) -----------
log "Step 2: docker run (guide command, port ${HOST_PORT})"
if "${DOCKER_BIN}" run -d \
  --name "${CONTAINER_NAME}" \
  --restart unless-stopped \
  -p "${HOST_PORT}:8080" \
  -v "${VOLUME_NAME}:/app/data" \
  "${IMAGE}" >/dev/null; then
  ok "container started"
else
  fail "docker run failed"
  echo "RESULT: FAIL (${FAIL_COUNT} failed)"
  exit 1
fi

# --- 3. health ----------------------------------------------------------------
log "Step 3: wait for /health (max ${HEALTH_TIMEOUT_SECONDS}s)"
if wait_for_health "${HEALTH_TIMEOUT_SECONDS}"; then
  ok "/health answers from the host"
else
  fail "/health never became reachable on ${BASE_URL}"
  echo "--- container logs (last 40 lines):"
  "${DOCKER_BIN}" logs --tail=40 "${CONTAINER_NAME}" 2>&1 || true
  echo "RESULT: FAIL (${FAIL_COUNT} failed)"
  exit 1
fi

# --- 4. stability window ------------------------------------------------------
log "Step 4: stability — watch the container for ${STABILITY_WINDOW_SECONDS}s"
sleep "${STABILITY_WINDOW_SECONDS}"
STATE="$("${DOCKER_BIN}" inspect --format '{{.State.Status}} restarts={{.RestartCount}}' "${CONTAINER_NAME}" 2>/dev/null || echo missing)"
case "${STATE}" in
  "running restarts=0") ok "container stays up (${STATE})" ;;
  *) fail "container is not stable: ${STATE}"
     "${DOCKER_BIN}" logs --tail=40 "${CONTAINER_NAME}" 2>&1 || true ;;
esac

if "${DOCKER_BIN}" logs "${CONTAINER_NAME}" 2>&1 | grep -Eq "UnhandledPromiseRejection|FATAL|Failed to start server"; then
  fail "container logs contain crash markers"
  "${DOCKER_BIN}" logs --tail=40 "${CONTAINER_NAME}" 2>&1 || true
else
  ok "container logs are free of crash markers"
fi

# health must still answer after the crash-marker probe hit HTTP endpoints
if curl -fsS --max-time 3 "${BASE_URL}/health" >/dev/null 2>&1; then
  ok "/health still answers after repeated requests"
else
  fail "/health stopped answering after repeated requests (crash on HTTP request?)"
fi

# --- 5. app-level e2e ---------------------------------------------------------
log "Step 5: app-equivalent client e2e (write + read back + REST)"
if (cd "${REPO_ROOT}" && node tests/e2e-client.mjs --server "${BASE_URL}" --state-file "${STATE_FILE}"); then
  ok "e2e client passed"
else
  fail "e2e client failed"
fi

# --- 6. restart persistence ---------------------------------------------------
log "Step 6: docker restart — data must survive"
if "${DOCKER_BIN}" restart "${CONTAINER_NAME}" >/dev/null 2>&1 && wait_for_health "${HEALTH_TIMEOUT_SECONDS}"; then
  if (cd "${REPO_ROOT}" && node tests/e2e-client.mjs --phase verify --server "${BASE_URL}" --state-file "${STATE_FILE}"); then
    ok "data survived docker restart"
  else
    fail "data check failed after docker restart"
  fi
else
  fail "container did not come back after docker restart"
fi

# --- 7. full stop/start persistence (host reboot simulation) ------------------
log "Step 7: docker stop + start — data must survive"
if "${DOCKER_BIN}" stop "${CONTAINER_NAME}" >/dev/null 2>&1 \
  && "${DOCKER_BIN}" start "${CONTAINER_NAME}" >/dev/null 2>&1 \
  && wait_for_health "${HEALTH_TIMEOUT_SECONDS}"; then
  if (cd "${REPO_ROOT}" && node tests/e2e-client.mjs --phase verify --server "${BASE_URL}" --state-file "${STATE_FILE}"); then
    ok "data survived stop/start"
  else
    fail "data check failed after stop/start"
  fi
else
  fail "container did not come back after stop/start"
fi

# --- summary ------------------------------------------------------------------
echo
if [ "${FAIL_COUNT}" -gt 0 ]; then
  echo "RESULT: FAIL (${FAIL_COUNT} failed, ${PASS_COUNT} passed)"
  exit 1
fi
echo "RESULT: PASS (${PASS_COUNT} checks)"
