#!/usr/bin/env bash
# Runs tests/test-install-script.sh (the `curl | bash` guide test) inside a
# disposable privileged ubuntu container with docker-in-docker, so it can be
# executed from any dev box (Windows + podman, macOS, Linux) without touching
# the host.
#
# Usage:
#   bash tests/local/run-install-test-in-container.sh            # test the PROD script
#   bash tests/local/run-install-test-in-container.sh --local FILE
#       FILE = local copy of install-sync-server.sh (e.g. the one in
#       focus-compass-app/public) to test unpublished changes.
#
# Environment overrides:
#   CONTAINER_BIN  podman | docker (default: podman, falls back to docker)
#   INSTALLER_URL  alternative download URL for the installer
#   KEEP=1         keep the inner install dir (inside the container) on failure —
#                  mostly useless since the container is removed; use for -it runs.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"

LOCAL_INSTALLER=""
if [ "${1:-}" = "--local" ]; then
  [ -n "${2:-}" ] || { echo "--local requires a path to install-sync-server.sh" >&2; exit 1; }
  LOCAL_INSTALLER="$2"
  [ -f "${LOCAL_INSTALLER}" ] || { echo "No such file: ${LOCAL_INSTALLER}" >&2; exit 1; }
fi

CONTAINER_BIN="${CONTAINER_BIN:-}"
if [ -z "${CONTAINER_BIN}" ]; then
  if command -v podman >/dev/null 2>&1; then CONTAINER_BIN="podman";
  elif command -v docker >/dev/null 2>&1; then CONTAINER_BIN="docker";
  else echo "Neither podman nor docker found." >&2; exit 1; fi
fi

# Git Bash on Windows mangles /paths in arguments; disable that and use
# native-style paths for mounts.
REPO_MOUNT_SRC="${REPO_ROOT}"
INSTALLER_MOUNT_SRC="${LOCAL_INSTALLER}"
case "$(uname -s)" in
  MINGW*|MSYS*|CYGWIN*)
    export MSYS2_ARG_CONV_EXCL="*"
    REPO_MOUNT_SRC="$(cygpath -m "${REPO_ROOT}")"
    [ -n "${LOCAL_INSTALLER}" ] && INSTALLER_MOUNT_SRC="$(cygpath -m "${LOCAL_INSTALLER}")"
    ;;
esac

RUN_ARGS=(
  run --rm --privileged
  -v "${REPO_MOUNT_SRC}:/repo:ro"
  -e "KEEP=${KEEP:-0}"
)

if [ -n "${LOCAL_INSTALLER}" ]; then
  RUN_ARGS+=( -v "${INSTALLER_MOUNT_SRC}:/installer.sh:ro" -e "INSTALLER_FILE=/installer.sh" )
  echo "Testing LOCAL installer copy: ${LOCAL_INSTALLER}"
else
  RUN_ARGS+=( -e "INSTALLER_URL=${INSTALLER_URL:-https://focus-compass.com/install-sync-server.sh}" )
  echo "Testing PRODUCTION installer: ${INSTALLER_URL:-https://focus-compass.com/install-sync-server.sh}"
fi

echo "Engine: ${CONTAINER_BIN}; this pulls ubuntu:24.04 + docker + node inside, first run takes a few minutes."
exec "${CONTAINER_BIN}" "${RUN_ARGS[@]}" ubuntu:24.04 bash /repo/tests/local/container-entry.sh
