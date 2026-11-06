#!/usr/bin/env bash
# Tests Tailscale mode as far as a CI machine can WITHOUT a Tailscale account: the settings and files it writes, that the sign-in key
# goes only where it should and never on a command line or in the server's environment, that a wrong key fails cleanly and tells
# the person what to do, and that nothing else starts until the computer has joined. If TS_TEST_AUTHKEY is set (a reusable,
# ephemeral key from the owner's Tailscale account, stored as a GitHub secret) it also does the real thing: joins, checks,
# and has two people hear each other over the Tailscale address.
#   docker/stack-test-tailscale.sh <server image>
set -euo pipefail

IMAGE="${1:?usage: stack-test-tailscale.sh <image>}"
REPO="$(cd "$(dirname "$0")/.." && pwd)"
DIR="$(mktemp -d)/rushlight"
mkdir -p "$DIR"
cp "$REPO"/deploy/compose.yaml "$REPO"/deploy/rushlight "$DIR"/
R="$DIR/rushlight"
FAKE="tskey-auth-kFAKEFAKE1CNTRL-fakefakefakefakefakefakefakefake"

pass() { printf '  ok   %s\n' "$*"; }
fail() {
  printf '  FAIL %s\n' "$*" >&2
  (cd "$DIR" && docker compose logs --tail 40 2>&1 | sed 's/^/    | /') >&2 || true
  exit 1
}
cleanup() { (cd "$DIR" && docker compose down -v >/dev/null 2>&1) || true; }
trap cleanup EXIT
echo "Tailscale mode test: $IMAGE"

printf '%s\n' "$FAKE" > "$DIR/key.txt"
out="$(cd "$DIR" && ./rushlight setup tailscale --authkey-file key.txt --yes --no-start --image "${IMAGE%:*}" --version "${IMAGE##*:}" 2>&1)" || fail "tailscale setup failed: $out"
grep -qF "$FAKE" <<<"$out" && fail "setup printed the key" || pass "setup finished and did not print the key"
grep -q '^COMPOSE_PROFILES=tailscale' "$DIR/.env" && grep -q '^HOST_IP=pending' "$DIR/.env" && pass "Tailscale mode is set, the address waits for the computer to join" || fail ".env is wrong"
grep -qF "$FAKE" "$DIR/.env" && fail "the key is in .env (and so in the server's environment and its backups)" || pass "the key is not in .env"
[ "$(stat -c %a "$DIR/tailscale.env")" = 600 ] && grep -qF "$FAKE" "$DIR/tailscale.env" && pass "the key is in tailscale.env, readable only by you" || fail "tailscale.env is wrong"
[ ! -f "$DIR/livekit.yaml" ] && pass "no voice settings are written before there is an address" || fail "livekit.yaml was written too early"

out="$(cd "$DIR" && echo "not-a-key" > bad.txt && mkdir -p b && cd b && cp ../rushlight . && ./rushlight setup tailscale --authkey-file ../bad.txt --yes --no-start 2>&1 || true)"
grep -q 'does not look like a Tailscale auth key' <<<"$out" && pass "something that is not a key is refused" || fail "a bad key was accepted"
out="$(cd "$DIR" && mkdir -p c && cd c && cp ../rushlight . && ./rushlight setup tailscale --authkey "$FAKE" --yes --no-start 2>&1 || true)"
grep -q "do not know" <<<"$out" && pass "a key on the command line is not accepted" || fail "a command line key was accepted"

# what each container is given
cfg="$(cd "$DIR" && docker compose config --format json)"
node -e '
const c = JSON.parse(process.argv[1]).services, key = process.argv[2]
const has = (s) => JSON.stringify(c[s] || {}).includes(key)
if (!c.tailscale) { console.error("no tailscale service"); process.exit(1) }
if (!has("tailscale")) { console.error("tailscale is not given the key"); process.exit(1) }
for (const s of ["server", "livekit"]) if (has(s)) { console.error(s + " is given the key"); process.exit(1) }
if (c.caddy) { console.error("caddy would start in Tailscale mode"); process.exit(1) }
' "$cfg" "$FAKE" && pass "only the Tailscale container is given the key, and no web server starts" || fail "the containers are given the wrong settings"

# a wrong key: the computer does not join, the person is told what to do, and nothing else starts
if (cd "$DIR" && RUSHLIGHT_TS_WAIT=30 ./rushlight start >"$DIR/start.out" 2>&1); then fail "start succeeded with a fake key"; fi
grep -q 'did not join Tailscale' "$DIR/start.out" && grep -q 'tailscale key' "$DIR/start.out" && pass "a wrong key fails with advice" || { cat "$DIR/start.out" >&2; fail "no advice after a wrong key"; }
running="$(cd "$DIR" && docker compose ps --status running --services | tr '\n' ' ')"
case "$running" in *server*|*livekit*) fail "the server or LiveKit started before the computer joined Tailscale" ;; *) pass "the server and LiveKit did not start without Tailscale" ;; esac
"$R" check >"$DIR/check.out" 2>&1 && fail "check passed while not signed in" || true
grep -q 'not signed in to Tailscale' "$DIR/check.out" && pass "check says the computer is not signed in, and how to fix it" || { cat "$DIR/check.out" >&2; fail "check did not say so"; }

if [ -n "${TS_TEST_AUTHKEY:-}" ]; then
  echo "A real key was given: joining Tailscale for real"
  (cd "$DIR" && docker compose down -v >/dev/null 2>&1)
  printf '%s\n' "$TS_TEST_AUTHKEY" > "$DIR/real.txt"
  "$R" tailscale key --authkey-file "$DIR/real.txt" >"$DIR/real.out" 2>&1 || { sed 's/tskey-[A-Za-z0-9_-]*/tskey-.../g' "$DIR/real.out" >&2; fail "could not join with the real key"; }
  TSIP="$(sed -n 's/^HOST_IP=//p' "$DIR/.env")"
  pass "joined Tailscale as $TSIP"
  grep -qF "$TS_TEST_AUTHKEY" "$DIR/tailscale.env" && fail "the key was left in tailscale.env after use" || pass "the key is removed after it was used"
  "$R" check >"$DIR/check2.out" 2>&1 && pass "check finds nothing wrong" || { cat "$DIR/check2.out" >&2; fail "check reported a problem"; }
  (cd "$REPO" && node docker/stack-check.mjs "http://$TSIP:4000") && pass "two people hear each other over Tailscale" || fail "voice over Tailscale failed"
  "$R" restart >/dev/null 2>&1; "$R" start >/dev/null 2>&1 && pass "restart keeps the sign-in (no key needed)" || fail "restart needed the key again"
else
  echo "  --   no TS_TEST_AUTHKEY: the real sign-in and voice over Tailscale were not run (owner test)"
fi
echo "All Tailscale checks passed."
