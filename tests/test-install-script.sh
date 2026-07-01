#!/usr/bin/env bash
# Tests the "one command over SSH" setup guide from
# https://focus-compass.com/sync-server:
#
#   curl -fsSL https://focus-compass.com/install-sync-server.sh | bash
#
# What it verifies:
#   1. The installer downloads from the production URL.
#   2. A fresh install exits 0 and the server answers /health on the host
#      port the installer promised (the "open this URL in your browser" one).
#   3. The install directory is a proper git checkout and .env is written.
#   4. First-time setup + app-equivalent sync works (tests/e2e-client.mjs,
#      or a REST-only fallback when node >= 22 is unavailable).
#   5. Re-running the installer on the same directory is idempotent and
#      does not lose data (the documented update flow).
#   6. Data survives `compose down` + `up` (persistent volume).
#   7. The installer refuses a port that is already taken.
#
# This script needs a LINUX host with Docker (a CI runner, a scratch VPS, or
# tests/local/run-install-test-in-container.sh which wraps it for dev boxes).
#
# Usage:
#   bash tests/test-install-script.sh
#
# Environment overrides:
#   INSTALLER_URL   (default: https://focus-compass.com/install-sync-server.sh)
#   INSTALLER_FILE  test a local copy of the script instead of downloading
#   INSTALL_DIR     (default: ~/fc-sync-install-test-<runid>; must not exist)
#   HOST_PORT       (default: first free port from 18100)
#   KEEP=1          keep the install dir + stack around for debugging
set -u -o pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(dirname "${SCRIPT_DIR}")"

INSTALLER_URL="${INSTALLER_URL:-https://focus-compass.com/install-sync-server.sh}"
INSTALLER_FILE="${INSTALLER_FILE:-}"
RUN_ID="$(date +%s)-$RANDOM"
INSTALL_DIR="${INSTALL_DIR:-${HOME}/fc-sync-install-test-${RUN_ID}}"
SECOND_DIR="${INSTALL_DIR}-portclash"
STATE_FILE="${TMPDIR:-/tmp}/fc-sync-install-e2e-${RUN_ID}.json"
INSTALL_TIMEOUT_SECONDS="${INSTALL_TIMEOUT_SECONDS:-900}"

PASS_COUNT=0
FAIL_COUNT=0

log()  { printf '\n=== %s\n' "$*"; }
ok()   { PASS_COUNT=$((PASS_COUNT + 1)); printf '[ok]   %s\n' "$*"; }
fail() { FAIL_COUNT=$((FAIL_COUNT + 1)); printf '[FAIL] %s\n' "$*" >&2; }

[ "$(uname -s)" = "Linux" ] || { echo "[FAIL] This test must run on Linux (the installer is Linux-only)." >&2; exit 1; }
command -v curl >/dev/null 2>&1 || { echo "[FAIL] curl is required." >&2; exit 1; }

if [ -e "${INSTALL_DIR}" ]; then
  echo "[FAIL] INSTALL_DIR already exists: ${INSTALL_DIR} — refusing to touch it." >&2
  exit 1
fi

compose_in() {
  local dir="$1"
  shift
  if docker compose version >/dev/null 2>&1; then
    (cd "${dir}" && docker compose "$@")
  else
    (cd "${dir}" && docker-compose "$@")
  fi
}

cleanup() {
  if [ "${KEEP:-0}" = "1" ]; then
    echo "KEEP=1 — leaving ${INSTALL_DIR} and its stack in place."
    return
  fi
  if [ -f "${INSTALL_DIR}/docker-compose.yml" ]; then
    compose_in "${INSTALL_DIR}" down -v --remove-orphans >/dev/null 2>&1 || true
  fi
  rm -rf "${INSTALL_DIR}" "${SECOND_DIR}" "${STATE_FILE}" >/dev/null 2>&1 || true
}
trap cleanup EXIT

port_is_free() {
  if command -v ss >/dev/null 2>&1; then
    ! ss -ltnH "( sport = :$1 )" 2>/dev/null | grep -q .
  else
    ! curl -s -o /dev/null --connect-timeout 1 "http://127.0.0.1:$1/" 2>/dev/null
  fi
}

HOST_PORT="${HOST_PORT:-}"
if [ -z "${HOST_PORT}" ]; then
  for candidate in 18100 18101 18102 18103 18104; do
    if port_is_free "${candidate}"; then HOST_PORT="${candidate}"; break; fi
  done
fi
[ -n "${HOST_PORT}" ] || { echo "[FAIL] No free port found (18100-18104)." >&2; exit 1; }
BASE_URL="http://127.0.0.1:${HOST_PORT}"

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

node_is_usable() {
  command -v node >/dev/null 2>&1 || return 1
  local major
  major="$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)"
  [ "${major}" -ge 22 ]
}

# REST-only fallback used when node is unavailable: proves setup mode, token
# issuance and auth enforcement, but not the Yjs websocket path.
rest_smoke() {
  local status token
  status="$(curl -fsS "${BASE_URL}/api/auth/status")" || return 1
  echo "auth status: ${status}"

  if printf '%s' "${status}" | grep -q '"initialized":false'; then
    token="$(curl -fsS -X POST "${BASE_URL}/api/auth/setup" | sed -n 's/.*"token":"\([^"]*\)".*/\1/p')"
    [ -n "${token}" ] || { echo "setup did not return a token" >&2; return 1; }
    echo "setup issued a token"
  fi

  local code
  code="$(curl -s -o /dev/null -w '%{http_code}' "${BASE_URL}/api/workspace/some-doc")"
  [ "${code}" = "401" ] || { echo "expected 401 without token, got ${code}" >&2; return 1; }
  return 0
}

# --- 1. obtain the installer ---------------------------------------------------
log "Step 1: obtain installer"
INSTALLER_PATH="${TMPDIR:-/tmp}/install-sync-server-${RUN_ID}.sh"
if [ -n "${INSTALLER_FILE}" ]; then
  cp "${INSTALLER_FILE}" "${INSTALLER_PATH}" || { fail "cannot copy ${INSTALLER_FILE}"; exit 1; }
  ok "using local installer copy: ${INSTALLER_FILE}"
else
  if curl -fsSL "${INSTALLER_URL}" -o "${INSTALLER_PATH}"; then
    ok "downloaded from ${INSTALLER_URL}"
  else
    fail "cannot download installer from ${INSTALLER_URL}"
    echo "RESULT: FAIL (${FAIL_COUNT} failed)"
    exit 1
  fi
fi

if head -1 "${INSTALLER_PATH}" | grep -q "bash"; then
  ok "installer looks like a bash script"
else
  fail "installer does not start with a bash shebang: $(head -1 "${INSTALLER_PATH}")"
fi

# --- 2. fresh install ----------------------------------------------------------
log "Step 2: fresh install (--dir ${INSTALL_DIR} --port ${HOST_PORT})"
INSTALL_LOG="${TMPDIR:-/tmp}/fc-sync-install-${RUN_ID}.log"
if timeout "${INSTALL_TIMEOUT_SECONDS}" bash "${INSTALLER_PATH}" --dir "${INSTALL_DIR}" --port "${HOST_PORT}" >"${INSTALL_LOG}" 2>&1; then
  ok "installer exited 0"
else
  fail "installer exited non-zero (see log tail below)"
  tail -30 "${INSTALL_LOG}" >&2 || true
fi

if wait_for_health 30; then
  ok "server answers on the promised host port (${BASE_URL}/health)"
else
  fail "server does not answer on ${BASE_URL} — the guide promises this URL works in a browser"
  if [ -f "${INSTALL_DIR}/docker-compose.yml" ]; then
    echo "--- compose ps:" >&2
    compose_in "${INSTALL_DIR}" ps 2>&1 || true
    echo "--- compose logs (tail):" >&2
    compose_in "${INSTALL_DIR}" logs --tail=30 2>&1 || true
  fi
fi

log "Step 3: install artifacts"
if [ -d "${INSTALL_DIR}/.git" ]; then
  ok "install dir is a git checkout"
else
  fail "install dir is not a git checkout: ${INSTALL_DIR}"
fi

if [ -f "${INSTALL_DIR}/.env" ] && grep -q "HOCUSPOCUS_PORT=${HOST_PORT}" "${INSTALL_DIR}/.env"; then
  ok ".env written with HOCUSPOCUS_PORT=${HOST_PORT}"
else
  fail ".env missing or HOCUSPOCUS_PORT not persisted (${INSTALL_DIR}/.env)"
fi

CONTAINER_STATE="$(compose_in "${INSTALL_DIR}" ps --format '{{.State}}' 2>/dev/null | head -1 || true)"
if [ "${CONTAINER_STATE}" = "running" ]; then
  ok "compose service is running"
else
  fail "compose service state: ${CONTAINER_STATE:-not found}"
fi

# --- 4. app-level e2e ----------------------------------------------------------
log "Step 4: app-equivalent client e2e"
E2E_AVAILABLE=0
if node_is_usable && [ -f "${REPO_ROOT}/tests/e2e-client.mjs" ] && [ -d "${REPO_ROOT}/node_modules/@hocuspocus/provider" ]; then
  E2E_AVAILABLE=1
fi

if [ "${E2E_AVAILABLE}" = "1" ]; then
  if (cd "${REPO_ROOT}" && node tests/e2e-client.mjs --server "${BASE_URL}" --state-file "${STATE_FILE}"); then
    ok "e2e client passed (websocket sync + persistence + REST)"
  else
    fail "e2e client failed"
  fi
else
  echo "(node >= 22 with repo node_modules not available — REST-only fallback)"
  if rest_smoke; then
    ok "REST smoke passed (setup mode, token issuance, auth enforcement)"
  else
    fail "REST smoke failed"
  fi
fi

# --- 5. idempotent re-run (documented update flow) ------------------------------
log "Step 5: re-run installer on the same dir (update flow)"
if timeout "${INSTALL_TIMEOUT_SECONDS}" bash "${INSTALLER_PATH}" --dir "${INSTALL_DIR}" --port "${HOST_PORT}" >"${INSTALL_LOG}.rerun" 2>&1; then
  ok "re-run exited 0"
else
  fail "re-run exited non-zero"
  tail -20 "${INSTALL_LOG}.rerun" >&2 || true
fi

if wait_for_health 60; then
  ok "server healthy after re-run"
else
  fail "server unhealthy after re-run"
fi

if [ "${E2E_AVAILABLE}" = "1" ] && [ -f "${STATE_FILE}" ]; then
  if (cd "${REPO_ROOT}" && node tests/e2e-client.mjs --phase verify --server "${BASE_URL}" --state-file "${STATE_FILE}"); then
    ok "data survived the installer re-run"
  else
    fail "data lost after installer re-run"
  fi
fi

# --- 6. compose down/up persistence ---------------------------------------------
log "Step 6: compose down + up — data must survive"
if compose_in "${INSTALL_DIR}" down >/dev/null 2>&1 \
  && compose_in "${INSTALL_DIR}" up -d >/dev/null 2>&1 \
  && wait_for_health 60; then
  if [ "${E2E_AVAILABLE}" = "1" ] && [ -f "${STATE_FILE}" ]; then
    if (cd "${REPO_ROOT}" && node tests/e2e-client.mjs --phase verify --server "${BASE_URL}" --state-file "${STATE_FILE}"); then
      ok "data survived compose down/up"
    else
      fail "data lost after compose down/up"
    fi
  else
    # Without the e2e client at least prove the auth token persisted.
    if curl -fsS "${BASE_URL}/api/auth/status" | grep -q '"initialized":true'; then
      ok "auth state survived compose down/up"
    else
      fail "auth state lost after compose down/up"
    fi
  fi
else
  fail "stack did not come back after compose down/up"
fi

# --- 7. port-clash guard ---------------------------------------------------------
log "Step 7: installer refuses an occupied port"
if timeout 300 bash "${INSTALLER_PATH}" --dir "${SECOND_DIR}" --port "${HOST_PORT}" >"${INSTALL_LOG}.clash" 2>&1; then
  fail "installer accepted a port that is already in use"
else
  if grep -qi "already in use" "${INSTALL_LOG}.clash"; then
    ok "installer refused the occupied port with a clear message"
  else
    ok "installer refused the occupied port"
  fi
fi
rm -rf "${SECOND_DIR}" >/dev/null 2>&1 || true

# --- summary ---------------------------------------------------------------------
echo
if [ "${FAIL_COUNT}" -gt 0 ]; then
  echo "RESULT: FAIL (${FAIL_COUNT} failed, ${PASS_COUNT} passed)"
  exit 1
fi
echo "RESULT: PASS (${PASS_COUNT} checks)"
