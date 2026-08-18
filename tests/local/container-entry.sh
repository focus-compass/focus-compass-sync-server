#!/usr/bin/env bash
# Entry point inside the disposable Ubuntu container. The image already has
# Docker CLI, Compose, and Node. The daemon is the host engine, reached
# through a mounted Unix socket — nested dockerd cannot own cgroups under
# rootless Podman on Windows.
set -euo pipefail

export E2E_ROOT="${E2E_ROOT:-/opt/fc-e2e}"
export DOCKER_HOST="${DOCKER_HOST:-unix:///var/run/docker.sock}"

echo "=== container prep: host Docker API"
if ! docker info >/dev/null 2>&1; then
  echo "[FAIL] docker API is not reachable via ${DOCKER_HOST}" >&2
  docker info >&2 || true
  exit 1
fi
docker info --format 'docker API up, server {{.ServerVersion}}, driver {{.Driver}}'
docker compose version
node --version

echo "=== running the installer guide test"
exec bash /repo/tests/test-install-script.sh
