#!/usr/bin/env bash
# Entry point executed INSIDE the disposable ubuntu container started by
# run-install-test-in-container.sh. Prepares a Linux box that looks like a
# fresh VPS (docker from the official repo + running daemon, node 24 for the
# e2e client) and then runs tests/test-install-script.sh against it.
#
# Limitation: the container has no systemd, so the daemon is started by hand
# and the installer's own "install docker via apt" path is only exercised up
# to detection (covered for real on CI runners / VPS instead).
set -euo pipefail

export DEBIAN_FRONTEND=noninteractive

echo "=== container prep: base packages"
apt-get update -y >/dev/null
apt-get install -y --no-install-recommends \
  ca-certificates curl git gnupg iproute2 openssl >/dev/null

echo "=== container prep: docker from the official repository"
install -d -m 0755 /etc/apt/keyrings
curl -fsSL https://download.docker.com/linux/ubuntu/gpg > /etc/apt/keyrings/docker.asc
chmod a+r /etc/apt/keyrings/docker.asc
. /etc/os-release
printf 'deb [arch=%s signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu %s stable\n' \
  "$(dpkg --print-architecture)" "${VERSION_CODENAME}" > /etc/apt/sources.list.d/docker.list
apt-get update -y >/dev/null
apt-get install -y docker-ce docker-ce-cli containerd.io docker-compose-plugin >/dev/null

echo "=== container prep: node 24 (for the app-equivalent e2e client)"
if ! command -v node >/dev/null 2>&1 || [ "$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)" -lt 22 ]; then
  curl -fsSL https://deb.nodesource.com/setup_24.x | bash - >/dev/null 2>&1
  apt-get install -y nodejs >/dev/null
fi
node --version

start_dockerd() {
  # vfs is deliberately slower than overlayfs, but it works both in Docker and
  # in a privileged container hosted by Podman. An overlay daemon can start
  # successfully in the latter and only fail later while extracting an image,
  # so a start-time fallback cannot detect the broken combination.
  dockerd --storage-driver=vfs >>/var/log/dockerd.log 2>&1 &
  DOCKERD_PID=$!
  for _ in $(seq 1 45); do
    if docker info >/dev/null 2>&1; then return 0; fi
    sleep 2
  done
  return 1
}

echo "=== container prep: starting dockerd"
DOCKERD_PID=""
DOCKERD_STARTED=0
for attempt in 1 2; do
  if start_dockerd; then
    DOCKERD_STARTED=1
    break
  fi
  echo "dockerd attempt ${attempt} did not become ready; retrying..." >&2
  [ -n "${DOCKERD_PID}" ] && kill "${DOCKERD_PID}" >/dev/null 2>&1 || true
  [ -n "${DOCKERD_PID}" ] && wait "${DOCKERD_PID}" >/dev/null 2>&1 || true
  rm -f /var/run/docker.pid /var/run/docker/containerd/containerd.pid
  sleep 3
done
if [ "${DOCKERD_STARTED}" -ne 1 ]; then
  echo "[FAIL] dockerd did not start. Log tail:" >&2
  tail -40 /var/log/dockerd.log >&2 || true
  exit 1
fi
docker info --format 'dockerd up, storage driver: {{.Driver}}'

echo "=== running the installer guide test"
exec bash /repo/tests/test-install-script.sh
