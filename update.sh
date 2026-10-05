#!/usr/bin/env bash
# Updates this install to the newest released version (the newest git tag that
# looks like vX.Y.Z), safely.
#
#   ./update.sh              update to the newest release
#   ./update.sh --check      say whether there is one, change nothing
#   ./update.sh --tag v1.2.3 move to a specific release (also how to go back)
#
# What it does: stops the service, copies the database to backups/, checks out
# the release, installs its dependencies, starts the service and waits for it
# to answer. If any of that fails it puts the database and the code back the way
# they were and starts the old version again. Your .env and database are never
# touched by git (they are ignored), so an update can't overwrite them.
#
# Run it as root (it restarts the systemd service), from the install folder.
# Releases only: whatever is on the main branch never reaches this machine until
# someone tags it.
set -euo pipefail

SERVICE="${RUSHLIGHT_SERVICE:-rushlight-server}"
HEALTH_TRIES="${RUSHLIGHT_HEALTH_TRIES:-30}"

say() { printf '%s\n' "$*"; }
die() { printf 'update: %s\n' "$*" >&2; exit 1; }

# Everything lives in a function, and the script ends with "main; exit". Bash
# reads a script as it runs, and this script's own file is replaced when the
# code is checked out; having parsed the whole function first makes that safe.
main() {
  DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
  cd "$DIR"

  local check_only=0 want_tag=""
  while [ $# -gt 0 ]; do
    case "$1" in
      --check) check_only=1 ;;
      --tag) shift; want_tag="${1:-}"; [ -n "$want_tag" ] || die "--tag needs a version, like v1.2.3" ;;
      -h|--help) sed -n '2,19p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; return 0 ;;
      *) die "unknown option: $1" ;;
    esac
    shift
  done

  command -v git >/dev/null || die "git isn't installed."
  command -v node >/dev/null || die "node isn't installed."
  command -v npm >/dev/null || die "npm isn't installed."
  git rev-parse --git-dir >/dev/null 2>&1 || die "$DIR is not a git checkout. See docs/migrate-existing-install.md."

  # Local edits to tracked files would be lost or collide with the checkout.
  if ! git diff --quiet HEAD --; then
    die "tracked files here have local changes; commit, stash or revert them first (git status shows which)."
  fi

  git fetch --tags --force --quiet origin || die "couldn't reach the git remote."

  local target
  if [ -n "$want_tag" ]; then
    target="$want_tag"
    git rev-parse -q --verify "refs/tags/$target^{commit}" >/dev/null || die "no release tagged $target."
  else
    target="$(git tag --list 'v[0-9]*' --sort=-v:refname | head -n 1)"
    [ -n "$target" ] || die "the remote has no releases (tags like v1.2.3) yet."
  fi

  local current_commit target_commit current_name
  current_commit="$(git rev-parse HEAD)"
  target_commit="$(git rev-parse "refs/tags/$target^{commit}")"
  current_name="$(git describe --tags --exact-match 2>/dev/null || git rev-parse --short HEAD)"

  if [ "$current_commit" = "$target_commit" ]; then
    say "Already on $current_name; nothing to do."
    return 0
  fi
  say "Installed: $current_name"
  say "Available: $target"
  if [ "$check_only" = 1 ]; then
    say "Run ./update.sh to install it."
    return 0
  fi

  local port
  port="$(grep -E '^PORT=' .env 2>/dev/null | tail -n 1 | cut -d= -f2 | tr -d '[:space:]"' || true)"
  port="${port:-4000}"

  healthy() {
    local i
    for ((i = 0; i < HEALTH_TRIES; i++)); do
      if curl -fsS -m 2 "http://127.0.0.1:$port/api/health" >/dev/null 2>&1; then return 0; fi
      sleep 1
    done
    return 1
  }

  local db_path backup=""
  db_path="$(node scripts/db-path.js)"

  say "Stopping $SERVICE..."
  systemctl stop "$SERVICE"

  if [ -f "$db_path" ]; then
    backup="$(node scripts/backup-db.js)" || { systemctl start "$SERVICE" || true; die "the database backup failed; nothing was changed."; }
    say "Database backed up to $backup"
  fi

  roll_back() {
    say "Rolling back to $current_name..."
    systemctl stop "$SERVICE" || true
    git checkout --quiet --force "$current_commit"
    if [ -n "$backup" ] && [ -f "$backup" ]; then
      cp -f "$backup" "$db_path"
      rm -f "$db_path-wal" "$db_path-shm"
    fi
    # Put the old dependencies back from the copy taken before the update, so a
    # rollback doesn't need the network.
    if [ -d node_modules.prev ]; then
      rm -rf node_modules
      mv node_modules.prev node_modules
    else
      npm ci --omit=dev --no-audit --no-fund --silent || true
    fi
    systemctl start "$SERVICE" || true
    if healthy; then
      say "The previous version ($current_name) is running again, with the database as it was."
    else
      say "The previous version did not come back up either. Look at: journalctl -u $SERVICE -n 50 --no-pager" >&2
    fi
  }

  say "Installing $target..."
  rm -rf node_modules.prev
  [ -d node_modules ] && cp -a node_modules node_modules.prev
  if ! git checkout --quiet --force "$target_commit"; then
    roll_back; die "couldn't check out $target."
  fi
  if ! npm ci --omit=dev --no-audit --no-fund --silent; then
    roll_back; die "installing dependencies for $target failed."
  fi

  say "Starting $SERVICE..."
  systemctl start "$SERVICE" || true
  if ! healthy; then
    say "$target did not start answering within ${HEALTH_TRIES}s." >&2
    roll_back
    die "update to $target failed and was rolled back."
  fi

  rm -rf node_modules.prev
  say "Updated to $target. The server is up."
}

main "$@"
exit $?
