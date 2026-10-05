#!/usr/bin/env bash
# Installs the Rushlight server as a systemd service, so it starts on boot,
# restarts if it crashes, and no longer depends on a tmux session.
#
# Run as root, once:   bash install-service.sh
# Re-running is safe; it just rewrites the unit and restarts the service.
#
# Set DRY_RUN=1 to print the unit that would be installed and change nothing.
set -euo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
UNIT_PATH="/etc/systemd/system/rushlight-server.service"

NODE="$(command -v node || true)"
if [ -z "$NODE" ]; then
  echo "node wasn't found on PATH, so there's nothing to run the server with." >&2
  exit 1
fi
if [ ! -f "$DIR/.env" ]; then
  echo "There's no .env in $DIR. The server can't start without it (see .env.example)." >&2
  exit 1
fi
if [ ! -d "$DIR/node_modules/better-sqlite3" ]; then
  echo "Dependencies aren't installed. Run 'npm install' in $DIR first." >&2
  exit 1
fi

PORT="$(grep -E '^PORT=' "$DIR/.env" | tail -1 | cut -d= -f2 | tr -d '[:space:]"' || true)"
PORT="${PORT:-4000}"

UNIT="[Unit]
Description=Rushlight server
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
# The server reads .env from its working directory.
WorkingDirectory=$DIR
ExecStart=$NODE src/index.js
Restart=always
RestartSec=3
NoNewPrivileges=true
PrivateTmp=true

[Install]
WantedBy=multi-user.target
"

if [ -n "${DRY_RUN:-}" ]; then
  echo "# Would write to $UNIT_PATH (port $PORT):"
  printf '%s' "$UNIT"
  exit 0
fi

# If something else already holds the port (the old tmux session, most likely),
# the service would fail to start. Say so instead of leaving a confusing error.
if ! systemctl is-active --quiet rushlight-server 2>/dev/null; then
  if command -v ss >/dev/null && ss -ltn "sport = :$PORT" | grep -q LISTEN; then
    echo "Something is already listening on port $PORT, probably the old tmux session." >&2
    echo "Stop it first:   tmux kill-session -t rushlight" >&2
    echo "Then run this script again." >&2
    exit 1
  fi
fi

printf '%s' "$UNIT" > "$UNIT_PATH"
systemctl daemon-reload
systemctl enable rushlight-server
systemctl restart rushlight-server

sleep 2
systemctl --no-pager --lines=6 status rushlight-server || true
echo
if command -v curl >/dev/null && curl -fsS "http://127.0.0.1:$PORT/api/health" >/dev/null; then
  echo "OK: the server is up and answering on port $PORT."
else
  echo "The service was installed but isn't answering yet. Check:  journalctl -u rushlight-server -n 30 --no-pager" >&2
  exit 1
fi
