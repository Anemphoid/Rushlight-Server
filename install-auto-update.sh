#!/usr/bin/env bash
# Optional: checks for a new release once a day (early morning, with a random
# delay) and installs it with update.sh, which backs up first and rolls back if
# the new version doesn't start. Releases only, never the main branch.
#
#   bash install-auto-update.sh            turn it on
#   bash install-auto-update.sh --remove   turn it off
#   DRY_RUN=1 bash install-auto-update.sh  show what would be installed
#
# Run as root. Look at past runs with:  journalctl -u rushlight-server-update
set -euo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SERVICE_PATH="/etc/systemd/system/rushlight-server-update.service"
TIMER_PATH="/etc/systemd/system/rushlight-server-update.timer"

if [ "${1:-}" = "--remove" ]; then
  systemctl disable --now rushlight-server-update.timer 2>/dev/null || true
  rm -f "$SERVICE_PATH" "$TIMER_PATH"
  systemctl daemon-reload
  echo "Automatic updates are off. ./update.sh still works by hand."
  exit 0
fi

SERVICE="[Unit]
Description=Update the Rushlight server to the newest release
After=network-online.target
Wants=network-online.target

[Service]
Type=oneshot
WorkingDirectory=$DIR
ExecStart=$DIR/update.sh
"
TIMER="[Unit]
Description=Check for a new Rushlight server release daily

[Timer]
OnCalendar=*-*-* 04:30:00
RandomizedDelaySec=30min
Persistent=true

[Install]
WantedBy=timers.target
"

if [ -n "${DRY_RUN:-}" ]; then
  echo "# $SERVICE_PATH"; printf '%s\n' "$SERVICE"
  echo "# $TIMER_PATH"; printf '%s\n' "$TIMER"
  exit 0
fi

[ -x "$DIR/update.sh" ] || chmod +x "$DIR/update.sh"
printf '%s\n' "$SERVICE" > "$SERVICE_PATH"
printf '%s\n' "$TIMER" > "$TIMER_PATH"
systemctl daemon-reload
systemctl enable --now rushlight-server-update.timer
systemctl --no-pager list-timers rushlight-server-update.timer || true
echo "Automatic updates are on."
