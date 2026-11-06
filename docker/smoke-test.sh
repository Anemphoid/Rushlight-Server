#!/usr/bin/env bash
# Starts the Rushlight server image the way the Compose stack will (throwaway secrets, one data volume) and checks it.
# CI runs this on every change to the image; you can run it by hand too:
#
#   docker/smoke-test.sh <image> [expected version] [platform]
#
# It prints one line per check and stops at the first failure, showing the container's log. It needs docker, curl and bash.
set -euo pipefail

IMAGE="${1:?usage: smoke-test.sh <image> [expected version] [platform]}"
VERSION="${2:-}"
PLATFORM="${3:-}"
NAME="rushlight-smoke-$$"
VOLUME="rushlight-smoke-data-$$"
platform_args=()
[ -n "$PLATFORM" ] && platform_args=(--platform "$PLATFORM")

pass() { printf '  ok   %s\n' "$*"; }
fail() {
  printf '  FAIL %s\n' "$*" >&2
  printf '\n--- container log ---\n' >&2
  docker logs "$NAME" 2>&1 | tail -40 >&2 || true
  exit 1
}
cleanup() {
  docker rm -f "$NAME" >/dev/null 2>&1 || true
  docker volume rm "$VOLUME" >/dev/null 2>&1 || true
}
trap cleanup EXIT

secret() { head -c 24 /dev/urandom | od -An -tx1 | tr -d ' \n'; }
JWT="$(secret)"
LIVEKIT_SECRET="$(secret)"

start() {
  docker run -d --name "$NAME" "${platform_args[@]}" \
    -v "$VOLUME:/data" -p 127.0.0.1::4000 \
    -e "JWT_SECRET=$JWT" -e LIVEKIT_URL=ws://127.0.0.1:7880 -e LIVEKIT_API_KEY=smoke -e "LIVEKIT_API_SECRET=$LIVEKIT_SECRET" \
    "$IMAGE" >/dev/null
}
wait_healthy() {
  for _ in $(seq 1 90); do
    state="$(docker inspect -f '{{.State.Health.Status}}' "$NAME" 2>/dev/null || echo none)"
    [ "$state" = healthy ] && return 0
    [ "$(docker inspect -f '{{.State.Running}}' "$NAME" 2>/dev/null || echo false)" = true ] || return 1
    sleep 2
  done
  return 1
}
port() { docker port "$NAME" 4000/tcp | head -1 | sed 's/.*://'; }
api() { curl -fsS -m 10 -H 'content-type: application/json' "$@"; }

echo "Smoke test: $IMAGE${PLATFORM:+ ($PLATFORM)}"
start
wait_healthy && pass "starts and becomes healthy" || fail "did not become healthy"

[ "$(docker exec "$NAME" id -u)" != 0 ] && pass "runs as a normal user, not root" || fail "runs as root"
docker exec "$NAME" ffmpeg -version >/dev/null 2>&1 && pass "ffmpeg is there (Jellybox)" || fail "no ffmpeg"
docker exec "$NAME" test -f /data/rushlight.db && pass "the database is on the data volume" || fail "no database on /data"
docker exec "$NAME" sh -c 'test -z "$(ls -A /app | grep -E "^(\.env|.*\.db)$" || true)"' && pass "no secret or database inside the image" || fail "a .env or database is inside the image"
if [ -n "$VERSION" ]; then
  got="$(docker inspect -f '{{ index .Config.Labels "org.opencontainers.image.version" }}' "$NAME")"
  [ "$got" = "$VERSION" ] && pass "labelled as version $VERSION" || fail "version label is '$got', expected '$VERSION'"
fi

P="$(port)"
[ "$(api "http://127.0.0.1:$P/api/health")" = '{"ok":true}' ] && pass "/api/health answers from outside the container" || fail "/api/health did not answer"
TOKEN="$(api -X POST "http://127.0.0.1:$P/api/register" -d '{"username":"smoketest","password":"correct horse battery"}' | sed -n 's/.*"token":"\([^"]*\)".*/\1/p')"
[ -n "$TOKEN" ] && pass "an account can be made" || fail "could not register"

docker exec "$NAME" node src/backup-cli.js list 2>&1 | grep -q "not set up" && pass "the backup tool runs inside the container" || fail "the backup tool did not run"

# the data survives the container being stopped and started again
t0=$(date +%s)
docker stop "$NAME" >/dev/null
t1=$(date +%s)
[ $((t1 - t0)) -lt 8 ] && pass "stops promptly ($((t1 - t0))s)" || fail "took $((t1 - t0))s to stop, so it was killed instead of stopping"
docker start "$NAME" >/dev/null
wait_healthy && pass "starts again" || fail "did not come back after a restart"
P="$(port)"
api -X POST "http://127.0.0.1:$P/api/login" -d '{"username":"smoketest","password":"correct horse battery"}' >/dev/null && pass "the account is still there after a restart (the volume holds the data)" || fail "the account was lost on restart"

if docker logs "$NAME" 2>&1 | grep -qF -e "$JWT" -e "$LIVEKIT_SECRET"; then fail "a secret is in the log"; fi
pass "no secret in the log"
echo "All checks passed."
