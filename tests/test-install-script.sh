#!/usr/bin/env bash
# Real Linux/Docker E2E for the public `curl | bash` installer.
#
# The disposable test host deliberately has an existing listener on 80/443 and
# a healthy Docker/Compose installation. That makes the only safe classification
# LOCAL_INTEGRATION: the installer must bind the backend to loopback, leave the
# existing proxy alone, persist its state, and remain idempotent. Public-IP ACME
# issuance for STANDALONE needs a separately routed VPS and cannot be simulated
# truthfully inside Docker-in-Docker.
#
# Usage:
#   bash tests/test-install-script.sh
#
# Environment overrides:
#   INSTALLER_URL   production URL (default: focus-compass.com installer)
#   INSTALLER_FILE  local installer copy instead of a download
#   INSTALL_DIR     fresh test directory
#   HOST_PORT       loopback port (default: first free port from 18100)
#   VERIFY_DOMAIN   TLS test name resolving to 127.0.0.1
#   KEEP=1          keep the test stack and files for debugging
set -u -o pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(dirname "${SCRIPT_DIR}")"

INSTALLER_URL="${INSTALLER_URL:-https://focus-compass.com/install-sync-server.sh}"
INSTALLER_FILE="${INSTALLER_FILE:-}"
RUN_ID="$(date +%s)-$RANDOM"
INSTALL_DIR="${INSTALL_DIR:-${HOME}/fc-sync-install-test-${RUN_ID}}"
SECOND_DIR="${INSTALL_DIR}-ownership-clash"
STATE_FILE="${TMPDIR:-/tmp}/fc-sync-install-e2e-${RUN_ID}.json"
INSTALLER_PATH="${TMPDIR:-/tmp}/install-sync-server-${RUN_ID}.sh"
INSTALL_LOG="${TMPDIR:-/tmp}/fc-sync-install-${RUN_ID}.log"
PROXY_NAME="fc-existing-proxy-${RUN_ID}"
PROXY_IMAGE="${PROXY_IMAGE:-nginx:1.27.5-alpine}"
PROXY_DIR="${TMPDIR:-/tmp}/fc-existing-proxy-${RUN_ID}"
CA_CERT="${PROXY_DIR}/ca.crt"
CA_BUNDLE="${PROXY_DIR}/ca-bundle.crt"
INSTALL_TIMEOUT_SECONDS="${INSTALL_TIMEOUT_SECONDS:-900}"
VERIFY_DOMAIN="${VERIFY_DOMAIN:-sync.127-0-0-1.sslip.io}"

BACKEND_CONTAINER="focus-compass-sync-server"
DATA_VOLUME="focus_compass_sync_server_hocuspocus-data"
NETWORK_NAME="focus_compass_sync_server_default"
METADATA_FILE="focus-compass-install.json"

PASS_COUNT=0
FAIL_COUNT=0
PROXY_BASELINE=""
PROXY_FILES_BASELINE=""

log()  { printf '\n=== %s\n' "$*"; }
ok()   { PASS_COUNT=$((PASS_COUNT + 1)); printf '[ok]   %s\n' "$*"; }
fail() { FAIL_COUNT=$((FAIL_COUNT + 1)); printf '[FAIL] %s\n' "$*" >&2; }

[ "$(uname -s)" = "Linux" ] || { echo "[FAIL] This test must run on Linux." >&2; exit 1; }
command -v curl >/dev/null 2>&1 || { echo "[FAIL] curl is required." >&2; exit 1; }
command -v docker >/dev/null 2>&1 || { echo "[FAIL] docker is required." >&2; exit 1; }
command -v openssl >/dev/null 2>&1 || { echo "[FAIL] openssl is required." >&2; exit 1; }
docker info >/dev/null 2>&1 || { echo "[FAIL] Docker daemon is not reachable." >&2; exit 1; }
docker compose version >/dev/null 2>&1 || { echo "[FAIL] Docker Compose plugin is required." >&2; exit 1; }

if [ -e "${INSTALL_DIR}" ]; then
  echo "[FAIL] INSTALL_DIR already exists: ${INSTALL_DIR} — refusing to touch it." >&2
  exit 1
fi

for reserved in "${BACKEND_CONTAINER}" focus-compass-caddy; do
  if docker container inspect "${reserved}" >/dev/null 2>&1; then
    echo "[FAIL] Reserved container already exists: ${reserved}" >&2
    exit 1
  fi
done
for reserved in "${DATA_VOLUME}" "${NETWORK_NAME}"; do
  if docker volume inspect "${reserved}" >/dev/null 2>&1 || docker network inspect "${reserved}" >/dev/null 2>&1; then
    echo "[FAIL] Reserved Docker resource already exists: ${reserved}" >&2
    exit 1
  fi
done

compose_in() {
  local dir="$1"
  shift
  docker compose -f "${dir}/docker-compose.yml" --project-directory "${dir}" "$@"
}

cleanup() {
  if [ "${KEEP:-0}" = "1" ]; then
    echo "KEEP=1 — leaving ${INSTALL_DIR}, ${PROXY_NAME}, and test resources in place."
    return
  fi
  if [ -f "${INSTALL_DIR}/docker-compose.yml" ]; then
    docker network disconnect "${NETWORK_NAME}" "${PROXY_NAME}" >/dev/null 2>&1 || true
    compose_in "${INSTALL_DIR}" down -v --remove-orphans >/dev/null 2>&1 || true
  fi
  docker rm -f "${PROXY_NAME}" >/dev/null 2>&1 || true
  rm -rf -- "${INSTALL_DIR}" "${SECOND_DIR}" "${PROXY_DIR}" >/dev/null 2>&1 || true
  rm -f -- "${STATE_FILE}" "${INSTALLER_PATH}" "${INSTALL_LOG}" "${INSTALL_LOG}."* >/dev/null 2>&1 || true
}
trap cleanup EXIT

port_is_free() {
  ! ss -ltnH "( sport = :$1 )" 2>/dev/null | grep -q .
}

HOST_PORT="${HOST_PORT:-}"
if [ -z "${HOST_PORT}" ]; then
  for candidate in 18100 18101 18102 18103 18104; do
    if port_is_free "${candidate}"; then HOST_PORT="${candidate}"; break; fi
  done
fi
[ -n "${HOST_PORT}" ] || { echo "[FAIL] No free port found (18100-18104)." >&2; exit 1; }
BASE_URL="http://127.0.0.1:${HOST_PORT}"
PUBLIC_BASE_URL="https://${VERIFY_DOMAIN}"

if ! getent ahostsv4 "${VERIFY_DOMAIN}" 2>/dev/null | awk '{ print $1 }' | grep -qx '127.0.0.1'; then
  echo "[FAIL] VERIFY_DOMAIN must resolve to 127.0.0.1: ${VERIFY_DOMAIN}" >&2
  exit 1
fi
export NO_PROXY="${NO_PROXY:+${NO_PROXY},}${VERIFY_DOMAIN},127.0.0.1,localhost"
export no_proxy="${NO_PROXY}"

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

wait_for_public_health() {
  local deadline=$(( $(date +%s) + $1 ))
  while [ "$(date +%s)" -lt "${deadline}" ]; do
    if curl -fsS --max-time 3 "${PUBLIC_BASE_URL}/health" 2>/dev/null | grep -q '"ok":true'; then
      return 0
    fi
    sleep 2
  done
  return 1
}

run_installer() {
  # stdin invocation intentionally matches `curl ... | bash -s -- ...`; this
  # catches BASH_SOURCE/$0 and deferred-trap behavior that file execution hides.
  timeout "${INSTALL_TIMEOUT_SECONDS}" bash -s -- "$@" < "${INSTALLER_PATH}"
}

proxy_snapshot() {
  docker inspect --format '{{.Id}}|{{.RestartCount}}|{{json .HostConfig.PortBindings}}' "${PROXY_NAME}" 2>/dev/null
}

proxy_files_snapshot() {
  sha256sum "${PROXY_DIR}/nginx.conf" "${PROXY_DIR}/server.crt" "${PROXY_DIR}/server.key" 2>/dev/null
}

assert_proxy_unchanged() {
  local stage="$1" current
  current="$(proxy_snapshot || true)"
  if [ -n "${current}" ] && [ "${current}" = "${PROXY_BASELINE}" ] \
    && [ "$(proxy_files_snapshot || true)" = "${PROXY_FILES_BASELINE}" ]; then
    ok "existing proxy untouched ${stage}"
  else
    fail "existing proxy changed ${stage}: ${current:-missing}"
  fi
}

node_is_usable() {
  command -v node >/dev/null 2>&1 || return 1
  local major
  major="$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)"
  [ "${major}" -ge 22 ]
}

rest_smoke() {
  local status token code
  status="$(curl -fsS "${PUBLIC_BASE_URL}/api/auth/status")" || return 1
  if printf '%s' "${status}" | grep -q '"initialized":false'; then
    token="$(curl -fsS -X POST "${PUBLIC_BASE_URL}/api/auth/setup" | sed -n 's/.*"token":"\([^"]*\)".*/\1/p')"
    [ -n "${token}" ] || return 1
  fi
  code="$(curl -s -o /dev/null -w '%{http_code}' "${PUBLIC_BASE_URL}/api/workspace/some-doc")"
  [ "${code}" = "401" ]
}

log "Step 1: obtain installer"
if [ -n "${INSTALLER_FILE}" ]; then
  cp "${INSTALLER_FILE}" "${INSTALLER_PATH}" || { fail "cannot copy ${INSTALLER_FILE}"; exit 1; }
  ok "using local installer copy: ${INSTALLER_FILE}"
elif curl -fsSL "${INSTALLER_URL}" -o "${INSTALLER_PATH}"; then
  ok "downloaded from ${INSTALLER_URL}"
else
  fail "cannot download installer from ${INSTALLER_URL}"
  exit 1
fi
if head -1 "${INSTALLER_PATH}" | grep -q 'bash'; then
  ok "installer looks like a bash script"
else
  fail "installer does not start with a bash shebang"
fi
if grep -qE 'SYNC_SERVER_IMAGE_TAG="[^"]+"' "${INSTALLER_PATH}" \
  && ! grep -q 'SYNC_SERVER_IMAGE_TAG="latest"' "${INSTALLER_PATH}" \
  && grep -qE 'SYNC_SERVER_IMAGE_DIGEST="sha256:[0-9a-f]{64}"' "${INSTALLER_PATH}"; then
  ok "installer pins a versioned server image and immutable digest"
else
  fail "installer server image is not fully pinned"
fi

log "Step 2: create an existing proxy boundary on ports 80/443"
if ! port_is_free 80 || ! port_is_free 443; then
  fail "test host already uses port 80 or 443"
  exit 1
fi

mkdir -p "${PROXY_DIR}"
chmod 700 "${PROXY_DIR}"
openssl req -x509 -newkey rsa:2048 -nodes -days 2 \
  -subj '/CN=Focus Compass installer E2E CA' \
  -keyout "${PROXY_DIR}/ca.key" -out "${CA_CERT}" >/dev/null 2>&1
openssl req -newkey rsa:2048 -nodes -subj "/CN=${VERIFY_DOMAIN}" \
  -keyout "${PROXY_DIR}/server.key" -out "${PROXY_DIR}/server.csr" >/dev/null 2>&1
printf 'subjectAltName=DNS:%s\nextendedKeyUsage=serverAuth\n' "${VERIFY_DOMAIN}" > "${PROXY_DIR}/server.ext"
openssl x509 -req -days 2 -sha256 \
  -in "${PROXY_DIR}/server.csr" -CA "${CA_CERT}" -CAkey "${PROXY_DIR}/ca.key" \
  -CAcreateserial -extfile "${PROXY_DIR}/server.ext" \
  -out "${PROXY_DIR}/server.crt" >/dev/null 2>&1
chmod 600 "${PROXY_DIR}"/*.key
cat /etc/ssl/certs/ca-certificates.crt "${CA_CERT}" > "${CA_BUNDLE}"

cat > "${PROXY_DIR}/nginx.conf" <<EOF
events {}
http {
  map \$http_upgrade \$connection_upgrade {
    default upgrade;
    '' close;
  }

  server {
    listen 80;
    server_name ${VERIFY_DOMAIN};
    return 308 https://${VERIFY_DOMAIN}\$request_uri;
  }

  server {
    listen 443 ssl;
    server_name ${VERIFY_DOMAIN};
    ssl_certificate /etc/nginx/test-certs/server.crt;
    ssl_certificate_key /etc/nginx/test-certs/server.key;

    resolver 127.0.0.11 ipv6=off valid=5s;
    set \$focus_compass_upstream focus-compass-sync-server:8080;

    location / {
      proxy_pass http://\$focus_compass_upstream;
      proxy_http_version 1.1;
      proxy_set_header Host \$host;
      proxy_set_header Upgrade \$http_upgrade;
      proxy_set_header Connection \$connection_upgrade;
      proxy_read_timeout 1d;
      proxy_send_timeout 1d;
    }
  }
}
EOF

export CURL_CA_BUNDLE="${CA_BUNDLE}"
if docker run -d --name "${PROXY_NAME}" \
    -p 80:80 -p 443:443 \
    -v "${PROXY_DIR}/nginx.conf:/etc/nginx/nginx.conf:ro" \
    -v "${PROXY_DIR}:/etc/nginx/test-certs:ro" \
    "${PROXY_IMAGE}" >/dev/null; then
  PROXY_BASELINE="$(proxy_snapshot)"
  PROXY_FILES_BASELINE="$(proxy_files_snapshot)"
  ok "existing proxy sentinel is running"
else
  fail "could not start proxy sentinel"
  exit 1
fi

log "Step 3: --check is read-only and classifies LOCAL_INTEGRATION"
if run_installer --check --dir "${INSTALL_DIR}" --port "${HOST_PORT}" >"${INSTALL_LOG}.check" 2>&1; then
  ok "--check exited 0"
else
  fail "--check exited non-zero"
  tail -30 "${INSTALL_LOG}.check" >&2 || true
fi
if grep -q 'LOCAL_INTEGRATION' "${INSTALL_LOG}.check"; then
  ok "--check selected LOCAL_INTEGRATION"
else
  fail "--check did not select LOCAL_INTEGRATION"
fi
if [ ! -e "${INSTALL_DIR}" ] \
  && ! docker container inspect "${BACKEND_CONTAINER}" >/dev/null 2>&1 \
  && ! docker volume inspect "${DATA_VOLUME}" >/dev/null 2>&1; then
  ok "--check created no files, containers, or data volume"
else
  fail "--check mutated installer-managed state"
fi
assert_proxy_unchanged "after --check"

log "Step 4: install through bash stdin (--dir ${INSTALL_DIR} --port ${HOST_PORT})"
if run_installer --dir "${INSTALL_DIR}" --port "${HOST_PORT}" >"${INSTALL_LOG}" 2>&1; then
  ok "installer exited 0"
else
  fail "installer exited non-zero"
  tail -40 "${INSTALL_LOG}" >&2 || true
fi
if wait_for_health 60; then
  ok "backend answers on ${BASE_URL}/health"
else
  fail "backend is not reachable on the promised loopback port"
  [ -f "${INSTALL_DIR}/docker-compose.yml" ] && compose_in "${INSTALL_DIR}" logs --tail=40 2>&1 || true
fi

log "Step 5: managed artifacts and reverse-proxy boundary"
if [ -f "${INSTALL_DIR}/docker-compose.yml" ] \
  && [ -f "${INSTALL_DIR}/.env" ] \
  && [ -f "${INSTALL_DIR}/${METADATA_FILE}" ]; then
  ok "managed compose, env, and metadata files exist"
else
  fail "one or more managed files are missing"
fi
if [ ! -d "${INSTALL_DIR}/.git" ]; then
  ok "installer does not clone or depend on a mutable git checkout"
else
  fail "installer unexpectedly created a git checkout"
fi
if grep -q "^FOCUS_COMPASS_MODE=integration$" "${INSTALL_DIR}/.env" \
  && grep -q "^FOCUS_COMPASS_LOOPBACK_PORT=${HOST_PORT}$" "${INSTALL_DIR}/.env" \
  && ! grep -q '^ACCESS_TOKEN=' "${INSTALL_DIR}/.env"; then
  ok "mode and loopback port persisted without a master token"
else
  fail ".env does not match the integration/token contract"
fi
if grep -q '"managedBy": "focus-compass-installer"' "${INSTALL_DIR}/${METADATA_FILE}" \
  && grep -q '"mode": "integration"' "${INSTALL_DIR}/${METADATA_FILE}" \
  && grep -q "\"loopbackPort\": ${HOST_PORT}" "${INSTALL_DIR}/${METADATA_FILE}"; then
  ok "installer metadata identifies the managed integration"
else
  fail "installer metadata is incomplete or inconsistent"
fi

COMPOSE_CFG="$(compose_in "${INSTALL_DIR}" config 2>/dev/null || true)"
COMPOSE_SERVICES="$(compose_in "${INSTALL_DIR}" config --services 2>/dev/null || true)"
if printf '%s\n' "${COMPOSE_CFG}" | grep -q 'host_ip: 127.0.0.1' \
  && printf '%s\n' "${COMPOSE_CFG}" | grep -qE "published: ['\"]?${HOST_PORT}['\"]?" \
  && ! printf '%s\n' "${COMPOSE_CFG}" | grep -q 'host_ip: 0.0.0.0'; then
  ok "backend is published only on 127.0.0.1:${HOST_PORT}"
else
  fail "compose does not enforce the loopback-only binding"
fi
if [ "${COMPOSE_SERVICES}" = "focus-compass" ] && [ ! -e "${INSTALL_DIR}/Caddyfile" ]; then
  ok "integration mode creates no managed Caddy service or config"
else
  fail "integration mode unexpectedly owns Caddy"
fi
if compose_in "${INSTALL_DIR}" ps --status running --services 2>/dev/null | grep -qx 'focus-compass'; then
  ok "managed backend service is running"
else
  fail "managed backend service is not running"
fi
assert_proxy_unchanged "after install"

log "Step 6: --verify against a real TLS nginx WebSocket proxy"
FILES_BEFORE="$(sha256sum "${INSTALL_DIR}/docker-compose.yml" "${INSTALL_DIR}/.env" "${INSTALL_DIR}/${METADATA_FILE}")"
if run_installer --verify --dir "${INSTALL_DIR}" --domain "${VERIFY_DOMAIN}" >"${INSTALL_LOG}.verify-broken" 2>&1; then
  fail "--verify produced a false positive before nginx could reach the backend"
elif grep -q 'WebSocket upgrade did not reach' "${INSTALL_LOG}.verify-broken"; then
  ok "--verify failure reached the real HTTPS/WebSocket checks"
else
  fail "--verify failed before exercising the HTTPS/WebSocket route"
  tail -30 "${INSTALL_LOG}.verify-broken" >&2 || true
fi
assert_proxy_unchanged "after failed --verify"

if docker network connect "${NETWORK_NAME}" "${PROXY_NAME}" \
  && wait_for_public_health 30; then
  ok "test nginx reaches the backend over the managed Docker network"
else
  fail "test nginx could not reach the managed backend"
fi
if run_installer --verify --dir "${INSTALL_DIR}" --domain "${VERIFY_DOMAIN}" >"${INSTALL_LOG}.verify" 2>&1; then
  ok "--verify accepted real HTTPS health and RFC 6455 upgrade responses"
else
  fail "--verify rejected the working nginx TLS/WebSocket proxy"
  tail -30 "${INSTALL_LOG}.verify" >&2 || true
fi
FILES_AFTER="$(sha256sum "${INSTALL_DIR}/docker-compose.yml" "${INSTALL_DIR}/.env" "${INSTALL_DIR}/${METADATA_FILE}")"
if [ "${FILES_BEFORE}" = "${FILES_AFTER}" ]; then
  ok "successful and failed --verify calls rewrote no managed files"
else
  fail "--verify changed managed files"
fi
assert_proxy_unchanged "after successful --verify"

log "Step 7: app-equivalent HTTPS/WSS setup, auth, sync, and persistence"
E2E_AVAILABLE=0
if node_is_usable && [ -f "${REPO_ROOT}/tests/e2e-client.mjs" ] \
  && [ -d "${REPO_ROOT}/node_modules/@hocuspocus/provider" ]; then
  E2E_AVAILABLE=1
fi
if [ "${E2E_AVAILABLE}" = "1" ]; then
  if (cd "${REPO_ROOT}" && NODE_EXTRA_CA_CERTS="${CA_CERT}" \
      node tests/e2e-client.mjs --server "${PUBLIC_BASE_URL}" --state-file "${STATE_FILE}"); then
    ok "app-equivalent HTTPS/WSS E2E passed through nginx"
  else
    fail "app-equivalent HTTPS/WSS E2E failed"
  fi
elif rest_smoke; then
  ok "REST setup/auth fallback passed"
else
  fail "REST setup/auth fallback failed"
fi

log "Step 8: idempotent re-run adopts the persisted port"
if run_installer --dir "${INSTALL_DIR}" >"${INSTALL_LOG}.rerun" 2>&1; then
  ok "re-run without --port exited 0"
else
  fail "re-run exited non-zero"
  tail -30 "${INSTALL_LOG}.rerun" >&2 || true
fi
if wait_for_health 60 \
  && grep -q "^FOCUS_COMPASS_LOOPBACK_PORT=${HOST_PORT}$" "${INSTALL_DIR}/.env"; then
  ok "re-run kept the persisted loopback port"
else
  fail "re-run changed or lost the persisted port"
fi
if [ "${E2E_AVAILABLE}" = "1" ] && [ -f "${STATE_FILE}" ]; then
  if (cd "${REPO_ROOT}" && NODE_EXTRA_CA_CERTS="${CA_CERT}" \
      node tests/e2e-client.mjs --phase verify --server "${PUBLIC_BASE_URL}" --state-file "${STATE_FILE}"); then
    ok "data survived installer re-run"
  else
    fail "data did not survive installer re-run"
  fi
fi
assert_proxy_unchanged "after re-run"

log "Step 9: compose down/up preserves the Docker volume"
if docker network disconnect "${NETWORK_NAME}" "${PROXY_NAME}" >/dev/null 2>&1 \
  && compose_in "${INSTALL_DIR}" down >/dev/null 2>&1 \
  && docker volume inspect "${DATA_VOLUME}" >/dev/null 2>&1 \
  && compose_in "${INSTALL_DIR}" up -d >/dev/null 2>&1 \
  && docker network connect "${NETWORK_NAME}" "${PROXY_NAME}" >/dev/null 2>&1 \
  && wait_for_health 60 \
  && wait_for_public_health 30; then
  if [ "${E2E_AVAILABLE}" = "1" ] && [ -f "${STATE_FILE}" ]; then
    if (cd "${REPO_ROOT}" && NODE_EXTRA_CA_CERTS="${CA_CERT}" \
        node tests/e2e-client.mjs --phase verify --server "${PUBLIC_BASE_URL}" --state-file "${STATE_FILE}"); then
      ok "data volume survived compose down/up"
    else
      fail "data was lost after compose down/up"
    fi
  else
    ok "data volume survived compose down/up"
  fi
else
  fail "stack or data volume did not survive compose down/up"
fi

log "Step 10: a second directory cannot adopt reserved managed resources"
if run_installer --dir "${SECOND_DIR}" --port "${HOST_PORT}" >"${INSTALL_LOG}.clash" 2>&1; then
  fail "installer accepted a conflicting second install directory"
else
  ok "installer refused the conflicting second install"
fi
if [ ! -e "${SECOND_DIR}" ] && wait_for_health 30; then
  ok "conflicting run made no files and left the existing backend healthy"
else
  fail "conflicting run mutated state or broke the existing backend"
fi
assert_proxy_unchanged "after conflicting run"

echo
if [ "${FAIL_COUNT}" -gt 0 ]; then
  echo "RESULT: FAIL (${FAIL_COUNT} failed, ${PASS_COUNT} passed)"
  exit 1
fi
echo "RESULT: PASS (${PASS_COUNT} checks)"
