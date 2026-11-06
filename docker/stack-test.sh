#!/usr/bin/env bash
# Tests the whole Compose stack the way a person uses it: copy deploy/ somewhere, run ./rushlight setup, start, check, hear a tone
# through the real LiveKit, restart and keep the data, break voice and see check say so.
#   docker/stack-test.sh <server image already built or pulled> [ip]
# Needs docker (with compose), curl, node and the server's npm dependencies (run it from the repository).
set -euo pipefail

IMAGE="${1:?usage: stack-test.sh <image> [ip]}"
REPO="$(cd "$(dirname "$0")/.." && pwd)"
IP="${2:-$(hostname -I | tr ' ' '\n' | grep -E '^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$' | head -n1)}"
[ -n "$IP" ] || { echo "no network address found; pass one as the second argument" >&2; exit 2; }
PORT=4000
DIR="$(mktemp -d)/rushlight"
mkdir -p "$DIR"
cp "$REPO"/deploy/compose.yaml "$REPO"/deploy/rushlight "$DIR"/

pass() { printf '  ok   %s\n' "$*"; }
fail() {
  printf '  FAIL %s\n' "$*" >&2
  (cd "$DIR" && docker compose logs --tail 60 2>&1 | sed 's/^/    | /') >&2 || true
  exit 1
}
cleanup() { (cd "$DIR" && docker compose down -v >/dev/null 2>&1) || true; }
trap cleanup EXIT

R="$DIR/rushlight"
echo "Stack test: $IMAGE on $IP"

"$R" setup --yes --ip "$IP" --image "${IMAGE%:*}" --version "${IMAGE##*:}" >"$DIR/setup.out" 2>&1 || { cat "$DIR/setup.out" >&2; fail "setup did not finish"; }
pass "setup finished and the server answers"

[ -f "$DIR/.env" ] && [ -f "$DIR/livekit.yaml" ] || fail "setup did not write .env and livekit.yaml"
if grep -q "$(sed -n 's/^JWT_SECRET=//p' "$DIR/.env")" "$DIR/setup.out"; then fail "setup printed a secret"; fi
pass "secrets are in .env and were not printed"
if [ "$("$R" setup --yes 2>&1 | grep -c 'already set up')" = 1 ]; then pass "setting up again is refused"; else fail "setup ran twice"; fi

"$R" check >"$DIR/check.out" 2>&1 && pass "check finds nothing wrong" || { cat "$DIR/check.out" >&2; fail "check reported a problem on a good stack"; }

(cd "$DIR" && docker compose exec -T server sh -c 'head -c1 /config/.env >/dev/null') && pass "the server can read the settings file for its backups" || fail "the server cannot read /config/.env"

node "$REPO/docker/stack-check.mjs" "http://$IP:$PORT" || fail "two people could not talk"
pass "voice works between two people through the stack"

U="stay$RANDOM"
curl -fsS -m 10 -H 'content-type: application/json' -d "{\"username\":\"$U\",\"password\":\"password123\"}" "http://$IP:$PORT/api/register" >/dev/null
"$R" restart >/dev/null 2>&1
for _ in $(seq 1 60); do curl -fsS -m 3 "http://$IP:$PORT/api/health" >/dev/null 2>&1 && break; sleep 1; done
curl -fsS -m 10 -H 'content-type: application/json' -d "{\"username\":\"$U\",\"password\":\"password123\"}" "http://$IP:$PORT/api/login" >/dev/null \
  && pass "an account is still there after a restart" || fail "the account was lost on restart"

"$R" stop >/dev/null 2>&1
"$R" start >/dev/null 2>&1 && pass "stop then start works" || fail "start after stop failed"

(cd "$DIR" && docker compose stop livekit >/dev/null 2>&1)
if "$R" check >"$DIR/broken.out" 2>&1; then fail "check passed with voice stopped"; fi
grep -q 'PROBLEM  The voice container' "$DIR/broken.out" && pass "check says so when voice is stopped" || { cat "$DIR/broken.out" >&2; fail "check did not name the voice problem"; }

# (output first, then grep: "grep -q" closing a pipe early can make the writer fail and hide a match)
all_logs="$(cd "$DIR" && docker compose logs 2>&1)"
if grep -qF "$(sed -n 's/^JWT_SECRET=//p' "$DIR/.env")" <<<"$all_logs"; then fail "a secret is in the logs"; else pass "no secret in the logs"; fi
echo "All stack checks passed."
