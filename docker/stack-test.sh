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


# ---- backups, updates and the way back ----
api_post() { curl -fsS -m 10 -H 'content-type: application/json' -d "$2" "http://$IP:$PORT$1"; }
can_login() { api_post /api/login "{\"username\":\"$1\",\"password\":\"password123\"}" >/dev/null 2>&1; }
wait_up() { for _ in $(seq 1 60); do curl -fsS -m 3 "http://$IP:$PORT/api/health" >/dev/null 2>&1 && return 0; sleep 1; done; return 1; }
env_val() { sed -n "s/^$1=//p" "$DIR/.env" | head -n1; }

# encrypted backups: turn them on the way setup would, with a throwaway phrase (the real command asks questions)
PHRASE="$(cd "$DIR" && docker compose exec -T server node --input-type=module -e "
import { makePhrase, keysFromPhrase, writePublicKeyFile } from './src/backup.js'
const p = makePhrase(); writePublicKeyFile('/data/backup-public.key', keysFromPhrase(p).publicRaw); console.log(p)" | tail -n1 | tr -d '\r')"
[ "$(wc -w <<<"$PHRASE")" = 12 ] || fail "could not turn backups on"
"$R" backup now >"$DIR/backup.out" 2>&1 || { cat "$DIR/backup.out" >&2; fail "backup now failed"; }
"$R" backup list >"$DIR/backup-list.out" 2>&1 || true
grep -q 'rushlight-' "$DIR/backup-list.out" && pass "an encrypted backup is made inside the stack and listed" || { cat "$DIR/backup-list.out" >&2; fail "backup list does not show it"; }
mkdir "$DIR/export" && "$R" backup export "$DIR/export" >/dev/null 2>&1 && ls "$DIR"/export/*.rlbak >/dev/null 2>&1 && pass "the newest backup can be copied out of the container" || fail "backup export failed"
grep -qaF "$(env_val JWT_SECRET)" "$DIR"/export/*.rlbak && fail "the backup file holds the secret in the clear" || pass "the backup file does not show the secret"

# an update that works: same image under a new tag is a real version change as far as the program can tell
docker tag "$IMAGE" "${IMAGE%:*}:next"
"$R" update --version next >"$DIR/update.out" 2>&1 || { cat "$DIR/update.out" >&2; fail "a good update did not finish"; }
[ "$(env_val RUSHLIGHT_VERSION)" = next ] && can_login "$U" && pass "update to a new version works and keeps the data" || fail "update lost the version or the data"
grep -qi 'encrypted backup' "$DIR/update.out" && pass "update made an encrypted backup first" || fail "update did not back up first"
if (cd "$DIR" && docker run --rm --network none -v rushlight_data:/data --entrypoint sh "${IMAGE%:*}:next" -c 'test -d /data/rollback'); then fail "the safety copy was left behind"; else pass "the safety copy is removed after a good update"; fi
"$R" update --version next >"$DIR/uptodate.out" 2>&1; grep -q 'Already up to date' "$DIR/uptodate.out" && pass "updating again says it is already current" || fail "no up-to-date message"

# an update that does not start: the new version breaks the database and exits; the old version and data must come back
printf 'FROM %s\nCMD ["sh","-c",": > /data/rushlight.db; exit 1"]\n' "${IMAGE%:*}:next" | docker build -q -t "${IMAGE%:*}:broken" - >/dev/null
if RUSHLIGHT_UPDATE_WAIT=15 "$R" update --version broken >"$DIR/rollback.out" 2>&1; then fail "a broken update was reported as fine"; fi
grep -q 'Rolled back' "$DIR/rollback.out" || { cat "$DIR/rollback.out" >&2; fail "the rollback did not happen"; }
[ "$(env_val RUSHLIGHT_VERSION)" = next ] && wait_up && can_login "$U" && pass "a broken update is rolled back: old version running, data intact" || fail "rollback left the stack broken"

# restore into the same stack, then onto a "new computer" (no .env)
EXTRA="late$RANDOM"
api_post /api/register "{\"username\":\"$EXTRA\",\"password\":\"password123\"}" >/dev/null
JWT_BEFORE="$(env_val JWT_SECRET)"
echo "$PHRASE" | "$R" restore --yes "$(ls "$DIR"/export/*.rlbak | head -n1)" >"$DIR/restore.out" 2>&1 || { cat "$DIR/restore.out" >&2; fail "restore failed"; }
wait_up && can_login "$U" && ! can_login "$EXTRA" && pass "restore brings back the data as it was at the backup (later changes gone)" || fail "restore did not give back the backed-up state"
[ -f "$DIR/.env.before-restore" ] && pass "the settings in place before the restore are kept" || fail "no .env.before-restore"
if echo "wrong words wrong words wrong words wrong words wrong words wrong words" | "$R" restore --yes "$(ls "$DIR"/export/*.rlbak | head -n1)" >"$DIR/badphrase.out" 2>&1; then fail "restore accepted wrong words"; fi
wait_up && can_login "$U" && pass "wrong words change nothing" || fail "a failed restore broke the stack"
"$R" stop >/dev/null 2>&1; rm -f "$DIR/.env" "$DIR/livekit.yaml" "$DIR/.env.before-restore"
echo "$PHRASE" | RUSHLIGHT_IMAGE="${IMAGE%:*}" RUSHLIGHT_VERSION=next "$R" restore "$(ls "$DIR"/export/*.rlbak | head -n1)" >"$DIR/fresh.out" 2>&1 || { cat "$DIR/fresh.out" >&2; fail "restore with no .env failed"; }
[ "$(env_val JWT_SECRET)" = "$JWT_BEFORE" ] && wait_up && can_login "$U" && pass "restoring on a computer with no settings brings the secrets back too" || fail "fresh restore did not bring back the secrets"

# ---- rotating secrets ----
token_of() { api_post /api/login "{\"username\":\"$1\",\"password\":\"password123\"}" | node -e 'process.stdout.write(JSON.parse(require("fs").readFileSync(0,"utf8")).token)'; }
token_ok() { curl -fsS -m 10 -H "authorization: Bearer $1" "http://$IP:$PORT/api/me" >/dev/null 2>&1; }
TOK="$(token_of "$U")"; token_ok "$TOK" || fail "could not get a working sign-in token to test with"
out="$("$R" rotate-secrets </dev/null 2>&1 || true)"
grep -q 'Say what to rotate' <<<"$out" && pass "rotate-secrets with nothing chosen and no terminal asks what to rotate" || fail "rotate-secrets did something unasked"

OLD_LK="$(env_val LIVEKIT_API_SECRET)"; OLD_JWT="$(env_val JWT_SECRET)"
"$R" rotate-secrets --livekit --yes >"$DIR/rot1.out" 2>&1 || { cat "$DIR/rot1.out" >&2; fail "rotating the voice key failed"; }
[ "$(env_val LIVEKIT_API_SECRET)" != "$OLD_LK" ] && [ "$(env_val JWT_SECRET)" = "$OLD_JWT" ] && token_ok "$TOK" && [ ! -f "$DIR/.env.before-rotate" ] && pass "a new voice key is in use, sign-ins are untouched, the old copy is removed" || fail "voice key rotation changed the wrong things"
node "$REPO/docker/stack-check.mjs" "http://$IP:$PORT" >"$DIR/rotvoice.out" 2>&1 && pass "two people still hear each other with the new voice key" || { cat "$DIR/rotvoice.out" >&2; fail "voice broke after rotating the key"; }

sed -i '/^MUSIC_SECRET=/d' "$DIR/.env"
"$R" rotate-secrets --jwt --yes >"$DIR/rot2.out" 2>&1 || { cat "$DIR/rot2.out" >&2; fail "rotating the sign-in secret failed"; }
[ "$(env_val JWT_SECRET)" != "$OLD_JWT" ] && [ "$(env_val MUSIC_SECRET)" = "$OLD_JWT" ] && pass "a new sign-in secret is in use and Jellybox's key stays readable (pinned to the old one)" || fail "jwt rotation did the wrong thing"
token_ok "$TOK" && fail "an old sign-in token still works after rotating the sign-in secret" || pass "old sign-ins no longer work"
can_login "$U" && token_ok "$(token_of "$U")" && pass "signing in again works" || fail "cannot sign in after rotation"

# a rotation that cannot restart puts the old settings back
sed -i 's/^LIVEKIT_VERSION=.*/LIVEKIT_VERSION=v0.0.0-nope/' "$DIR/.env"
BEFORE="$(env_val LIVEKIT_API_SECRET)"
if "$R" rotate-secrets --livekit --yes >"$DIR/rot3.out" 2>&1; then fail "a rotation that cannot restart was reported as fine"; fi
grep -q 'Putting the old ones back' "$DIR/rot3.out" && [ "$(env_val LIVEKIT_API_SECRET)" = "$BEFORE" ] && pass "a failed rotation puts the old secrets back" || { cat "$DIR/rot3.out" >&2; fail "failed rotation did not restore .env"; }
sed -i 's/^LIVEKIT_VERSION=.*/LIVEKIT_VERSION=v1.13.11/' "$DIR/.env"
"$R" start >/dev/null 2>&1 && wait_up && pass "and the stack comes back once the fault is gone" || fail "stack did not come back"

(cd "$DIR" && docker compose stop livekit >/dev/null 2>&1)
if "$R" check >"$DIR/broken.out" 2>&1; then fail "check passed with voice stopped"; fi
grep -q 'PROBLEM  The voice container' "$DIR/broken.out" && pass "check says so when voice is stopped" || { cat "$DIR/broken.out" >&2; fail "check did not name the voice problem"; }

# (output first, then grep: "grep -q" closing a pipe early can make the writer fail and hide a match)
all_logs="$(cd "$DIR" && docker compose logs 2>&1)"
if grep -qF "$(sed -n 's/^JWT_SECRET=//p' "$DIR/.env")" <<<"$all_logs"; then fail "a secret is in the logs"; else pass "no secret in the logs"; fi
echo "All stack checks passed."
