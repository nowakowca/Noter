#!/bin/sh
set -e

# Run the app as an arbitrary host user so downloaded files and the database are
# owned by you rather than root. Defaults to 1000:1000.
PUID="${PUID:-1000}"
PGID="${PGID:-1000}"

DATA_DIR="${DATA_DIR:-/app/data}"
MEDIA_DIR="${MEDIA_DIR:-/app/media}"

mkdir -p "$DATA_DIR" "$MEDIA_DIR"

# Make the writable locations owned by the target user. DATA_DIR is small
# (database + sessions) so a recursive chown is cheap; for MEDIA_DIR only the
# top folder is chowned to avoid a slow pass over a large media archive — files
# the app creates are owned by the target user automatically.
chown -R "$PUID:$PGID" "$DATA_DIR" 2>/dev/null || true
chown "$PUID:$PGID" "$MEDIA_DIR" 2>/dev/null || true

# Chromium (Instagram backup) needs a writable HOME.
export HOME=/tmp

# Exec the app as root; it drops to PUID:PGID itself (see drop-privileges.js),
# which avoids needing an external privilege-drop tool.
echo "Starting Noter; will drop to UID:GID ${PUID}:${PGID}"
exec "$@"
