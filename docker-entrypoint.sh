#!/bin/sh
# Make the data directory writable by the unprivileged `node` user, then drop
# to it. This matters on the upgrade path: a data volume created by an older
# root-based image (or a root-owned host bind-mount, as some deploy platforms
# use) stays owned by root, and a `node`-user container can't write to it
# (EACCES on ./data/images, chmod EPERM on ./data). Fixing it here means the
# same image works whether the volume is fresh, root-owned, or bind-mounted.
set -e

if [ "$(id -u)" = "0" ]; then
  mkdir -p /app/data
  # Recursive chown is only needed when ownership is actually wrong — skip it on
  # normal restarts so we don't walk the whole volume every boot.
  if [ "$(stat -c '%u' /app/data 2>/dev/null)" != "$(id -u node)" ]; then
    chown -R node:node /app/data
  fi
  exec su-exec node "$@"
fi

# Already unprivileged (e.g. compose set `user:`) — just run.
exec "$@"
