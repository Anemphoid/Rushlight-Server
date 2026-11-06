#!/usr/bin/env bash
# Tests Public mode as far as a CI machine can: Caddy in front (with a certificate made on the spot, because a real one needs a
# real name on the internet), the name resolving to this computer, the server and voice reached the way a stranger would reach
# them, LiveKit's own port closed, and the settings it writes. What it cannot test: a real Let's Encrypt certificate, a router
# with port forwarding, and phones on mobile networks (those are for the owner).
#   docker/stack-test-public.sh <server image> [ip]
set -euo pipefail

IMAGE="${1:?usage: stack-test-public.sh <image> [ip]}"
REPO="$(cd "$(dirname "$0")/.." && pwd)"
IP="${2:-$(hostname -I | tr ' ' '\n' | grep -E '^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$' | head -n1)}"
HOST=rushlight.test
DIR="$(mktemp -d)/rushlight"
mkdir -p "$DIR"
cp "$REPO"/deploy/compose.yaml "$REPO"/deploy/rushlight "$DIR"/
R="$DIR/rushlight"

pass() { printf '  ok   %s\n' "$*"; }
fail() {
  printf '  FAIL %s\n' "$*" >&2
  (cd "$DIR" && docker compose logs --tail 40 2>&1 | sed 's/^/    | /') >&2 || true
  exit 1
}
cleanup() { (cd "$DIR" && docker compose down -v >/dev/null 2>&1) || true; }
trap cleanup EXIT
echo "Public mode test: $IMAGE, $HOST -> $IP"

# a name that points at this computer, as a domain's DNS record would
grep -q " $HOST" /etc/hosts || echo "$IP $HOST" | sudo tee -a /etc/hosts >/dev/null

# the sslip.io choice makes its name from the address (nothing started)
SDIR="$(mktemp -d)/s"; mkdir -p "$SDIR"; cp "$REPO"/deploy/compose.yaml "$REPO"/deploy/rushlight "$SDIR"/
(cd "$SDIR" && ./rushlight setup public --sslip --public-ip 203.0.113.10 --yes --no-start >/dev/null 2>&1) || fail "sslip setup failed"
grep -q '^203-0-113-10.sslip.io {' "$SDIR/Caddyfile" && grep -q '^LIVEKIT_PUBLIC_URL=wss://203-0-113-10.sslip.io$' "$SDIR/.env" && pass "the free sslip.io name is made from the address" || fail "sslip name wrong"
fresh() { local d; d="$(mktemp -d)/f"; mkdir -p "$d"; cp "$REPO"/deploy/rushlight "$d"/; printf '%s' "$d"; }
out="$(cd "$(fresh)" && ./rushlight setup public --yes --no-start 2>&1 || true)"
grep -q 'needs a name' <<<"$out" && pass "public mode with no name is refused with advice" || fail "no name was accepted"
out="$(cd "$(fresh)" && ./rushlight setup public --domain 'bad name!' --yes --no-start 2>&1 || true)"
grep -q 'does not look like a domain' <<<"$out" && pass "a bad domain name is refused" || fail "bad domain accepted"

"$R" setup public --domain "$HOST" --tls-internal --yes --image "${IMAGE%:*}" --version "${IMAGE##*:}" >"$DIR/setup.out" 2>&1 || { cat "$DIR/setup.out" >&2; fail "setup public did not finish"; }
pass "public setup finished and the server answers"
grep -q '^bind_addresses: \["127.0.0.1"\]' "$DIR/livekit.yaml" && grep -q '^  enabled: true' "$DIR/livekit.yaml" && pass "LiveKit listens only on this computer for signalling, with its relay on" || fail "livekit.yaml is not what Public mode needs"
grep -q '^TRUST_PROXY=1' "$DIR/.env" && grep -q "^LIVEKIT_PUBLIC_URL=wss://$HOST" "$DIR/.env" && pass "the server is told it is behind a proxy and what voice address to hand out" || fail ".env lacks the proxy settings"

for _ in $(seq 1 40); do curl -fsSk -m 3 "https://$HOST/api/health" >/dev/null 2>&1 && break; sleep 1; done
curl -fsSk -m 5 "https://$HOST/api/health" >/dev/null && pass "the server answers over https through Caddy" || fail "no https answer"
code="$(curl -sk -m 5 -o /dev/null -w '%{http_code}' "https://$HOST/rtc/validate" || true)"
[ "$code" != 404 ] && [ "$code" != 000 ] && pass "/rtc goes to LiveKit, not to the server (got $code)" || fail "/rtc did not reach LiveKit ($code)"
curl -fsS -m 3 "http://$IP:7880" >/dev/null 2>&1 && fail "LiveKit's port 7880 is open to the network" || pass "LiveKit's own port is closed to the network"
redir="$(curl -sS -m 5 -o /dev/null -w '%{http_code}' "http://$HOST/" 2>/dev/null || true)"
[[ "$redir" =~ ^30[1-8]$ ]] && pass "plain http is sent on to https" || fail "http is not redirected"

"$R" check >"$DIR/check.out" 2>&1 && pass "check finds nothing wrong" || { cat "$DIR/check.out" >&2; fail "check reported a problem on a good public stack"; }

# voice: signalling through the address the server hands out is https (a certificate made here), so the two test clients
# connect to LiveKit directly on this computer; the media still crosses the network address the stack was set up for
cd "$REPO"
NODE_TLS_REJECT_UNAUTHORIZED=0 node docker/stack-check.mjs "https://$HOST" "ws://127.0.0.1:7880" >"$DIR/voice.out" 2>&1 || { cat "$DIR/voice.out" >&2; fail "voice through the public stack failed"; }
grep -q "told to reach voice at wss://$HOST" "$DIR/voice.out" && pass "people are told to reach voice at wss://$HOST" || fail "wrong voice address handed out"
pass "voice works between two people"

(cd "$DIR" && docker compose stop caddy >/dev/null 2>&1)
if "$R" check >"$DIR/broken.out" 2>&1; then fail "check passed with the web server stopped"; fi
grep -q 'PROBLEM  The web server container' "$DIR/broken.out" && pass "check names a stopped web server" || { cat "$DIR/broken.out" >&2; fail "check did not name the web server"; }
"$R" start >/dev/null 2>&1 && pass "start brings it back" || fail "start failed"
echo "All public stack checks passed."
