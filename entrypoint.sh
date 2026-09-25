#!/bin/sh
set -e

CONFIG_DIR="${CONFIG_DIR:-/app/config}"
CHAT_DIR="${CHAT_DIR:-$CONFIG_DIR/chat}"
PUID="${PUID:-1000}"
PGID="${PGID:-1000}"
mkdir -p "$CONFIG_DIR" "$CHAT_DIR"

if [ "${AUTO_UPDATE_EXTRACTORS:-false}" = "true" ]; then
  echo "[!] AUTO_UPDATE_EXTRACTORS isn't used any more. Install yt-dlp under Plugins in the admin panel and tick automatic updates there."
fi

if [ "$(id -u)" = "0" ] && [ "$PUID" != "0" ]; then
  # Run as an ordinary user. Hand it any config files it doesn't own yet (e.g. from older root-run versions).
  find "$CONFIG_DIR" "$CHAT_DIR" \( ! -user "$PUID" -o ! -group "$PGID" \) -exec chown "$PUID:$PGID" {} + 2>/dev/null || true
  export HOME=/tmp/axdio-home
  mkdir -p "$HOME" && chown "$PUID:$PGID" "$HOME"
  # With the Docker socket mounted (for updates from the admin panel), the server joins the group that owns it.
  GROUPS_ARG="--clear-groups"
  if [ -S /var/run/docker.sock ]; then
    GROUPS_ARG="--groups $(stat -c %g /var/run/docker.sock)"
    echo "[+] Docker socket found: updates can be installed from the admin panel"
  fi
  echo "[+] Starting Axdio as uid $PUID"
  exec setpriv --reuid="$PUID" --regid="$PGID" $GROUPS_ARG gunicorn -c /app/gunicorn.conf.py server:app
fi

echo "[+] Starting Axdio as uid $(id -u)"
exec gunicorn -c /app/gunicorn.conf.py server:app
