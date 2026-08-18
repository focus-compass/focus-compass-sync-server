#!/usr/bin/env bash
# Thin wrapper around the Node launcher. Prefer
# `npm run test:install-script:local` from PowerShell — Windows `bash` is WSL.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
exec node "${SCRIPT_DIR}/run-install-test-in-container.mjs" "$@"
