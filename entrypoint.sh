#!/bin/sh
set -e

CONFIG_DIR="${CONFIG_DIR:-/app/config}"
PUID="${PUID:-1000}"
PGID="${PGID:-1000}"
mkdir -p "$CONFIG_DIR"

if [ "${AUTO_UPDATE_EXTRACTORS:-false}" = "true" ]; then
  echo "[!] AUTO_UPDATE_EXTRACTORS isn't used any more. Install yt-dlp under Plugins in the admin panel and tick automatic updates there."
fi

if [ "$(id -u)" = "0" ] && [ "$PUID" != "0" ]; then
  # Run as an ordinary user. Hand it any config files it doesn't own yet (e.g. from older root-run versions).
  find "$CONFIG_DIR" \( ! -user "$PUID" -o ! -group "$PGID" \) -exec chown "$PUID:$PGID" {} + 2>/dev/null || true
  export HOME=/tmp/axdio-home
  mkdir -p "$HOME" && chown "$PUID:$PGID" "$HOME"
  echo "[+] Starting Axdio as uid $PUID"
  exec setpriv --reuid="$PUID" --regid="$PGID" --clear-groups gunicorn -c /app/gunicorn.conf.py server:app
fi

echo "[+] Starting Axdio as uid $(id -u)"
exec gunicorn -c /app/gunicorn.conf.py server:app
