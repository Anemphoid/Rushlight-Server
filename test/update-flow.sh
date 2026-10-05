#!/usr/bin/env bash
# End-to-end check of update.sh against a throwaway git "remote", using a stand-in
# for systemctl that runs the real server as a background process. Covers: no
# update available, a good update, and a bad release that has to be rolled back
# with the database restored.
#
#   bash test/update-flow.sh
set -euo pipefail

SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
WORK="$(mktemp -d)"
trap 'kill "$(cat "$WORK/server.pid" 2>/dev/null)" 2>/dev/null || true; rm -rf "$WORK"' EXIT
PORT=$((20000 + RANDOM % 20000))

fail() { echo "FAIL: $*" >&2; echo "--- update output:" >&2; cat "$WORK/out.txt" >&2 2>/dev/null || true; exit 1; }
ok() { echo "ok - $*"; }

# A bare "origin" holding the project, with v0.1.0 tagged.
git init -q --bare -b main "$WORK/origin.git"


mkdir "$WORK/seed"
git -C "$SRC" ls-files -z --cached --others --exclude-standard | (cd "$SRC" && xargs -0 -I{} cp --parents {} "$WORK/seed/")
cd "$WORK/seed"
git init -q -b main
git config user.email t@example.com; git config user.name t
git add -A && git commit -q -m "v0.1.0"
git tag v0.1.0
git remote add origin "$WORK/origin.git"
git push -q origin main --tags

# The install being updated.
git clone -q "$WORK/origin.git" "$WORK/install"
cd "$WORK/install"
git config user.email t@example.com; git config user.name t
cp -a "$SRC/node_modules" node_modules
cat > .env <<ENV
JWT_SECRET=test-secret-test-secret-test-secret-test
LIVEKIT_URL=ws://127.0.0.1:9
LIVEKIT_API_KEY=k
LIVEKIT_API_SECRET=test-secret-test-secret-test-secret-12
PORT=$PORT
ENV

# Stand-in systemctl: start/stop the real server as a background process.
mkdir "$WORK/bin"
cat > "$WORK/bin/systemctl" <<SH
#!/usr/bin/env bash
cd "$WORK/install"
case "\$1" in
  start)
    set -a; . ./.env; set +a
    nohup node src/index.js >> "$WORK/server.log" 2>&1 &
    echo \$! > "$WORK/server.pid" ;;
  stop)
    if [ -f "$WORK/server.pid" ]; then kill "\$(cat "$WORK/server.pid")" 2>/dev/null || true; rm -f "$WORK/server.pid"; fi
    sleep 0.5 ;;
esac
SH
chmod +x "$WORK/bin/systemctl"
export PATH="$WORK/bin:$PATH"
export RUSHLIGHT_HEALTH_TRIES=8

systemctl start
for _ in $(seq 20); do curl -fsS "http://127.0.0.1:$PORT/api/health" >/dev/null 2>&1 && break; sleep 0.5; done
curl -fsS "http://127.0.0.1:$PORT/api/health" >/dev/null || fail "test server did not start"

curl -fsS -X POST "http://127.0.0.1:$PORT/api/register" -H 'content-type: application/json' \
  -d '{"username":"keeper","password":"password123"}' >/dev/null
count_accounts() { node -e "
const D=require('better-sqlite3');const d=new D(process.argv[1],{readonly:true});
console.log(d.prepare('SELECT COUNT(*) n FROM accounts').get().n)" "$(node scripts/db-path.js)"; }
[ "$(count_accounts)" = 1 ] || fail "expected the account to exist before updating"

# 1. nothing newer
bash update.sh > "$WORK/out.txt" 2>&1 || fail "update.sh errored with nothing to do"
grep -q "Already on v0.1.0" "$WORK/out.txt" || fail "should report it is up to date"
ok "reports up to date when there is no newer release"

# 2. a good release
cd "$WORK/seed"
echo "// v0.2.0" >> src/wordlist.js
git add -A && git commit -q -m "v0.2.0" && git tag v0.2.0 && git push -q origin main --tags
cd "$WORK/install"
bash update.sh --check > "$WORK/out.txt" 2>&1 || fail "--check errored"
grep -q "Available: v0.2.0" "$WORK/out.txt" || fail "--check should name v0.2.0"
[ "$(git describe --tags --exact-match)" = v0.1.0 ] || fail "--check must not change anything"
ok "--check reports the new release and changes nothing"

bash update.sh > "$WORK/out.txt" 2>&1 || fail "good update failed"
[ "$(git describe --tags --exact-match)" = v0.2.0 ] || fail "should be on v0.2.0"
curl -fsS "http://127.0.0.1:$PORT/api/health" >/dev/null || fail "server not answering after good update"
[ "$(count_accounts)" = 1 ] || fail "data lost in good update"
[ -f .env ] || fail ".env disappeared"
ls backups/*.db >/dev/null 2>&1 || fail "no backup written"
ok "updates to a good release, keeps .env and data, writes a backup"

# 3. a broken release is rolled back, with the database restored
curl -fsS -X POST "http://127.0.0.1:$PORT/api/register" -H 'content-type: application/json' \
  -d '{"username":"second","password":"password123"}' >/dev/null
[ "$(count_accounts)" = 2 ] || fail "expected 2 accounts before the bad update"
cd "$WORK/seed"
echo "this is not javascript (" >> src/index.js
git add -A && git commit -q -m "v0.3.0 (broken)" && git tag v0.3.0 && git push -q origin main --tags
cd "$WORK/install"
if bash update.sh > "$WORK/out.txt" 2>&1; then fail "a broken release should make update.sh fail"; fi
grep -q "rolled back" "$WORK/out.txt" || fail "should say it rolled back"
[ "$(git describe --tags --exact-match)" = v0.2.0 ] || fail "should be back on v0.2.0"
curl -fsS "http://127.0.0.1:$PORT/api/health" >/dev/null || fail "old version not running after rollback"
[ "$(count_accounts)" = 2 ] || fail "database not intact after rollback"
[ ! -d node_modules.prev ] || fail "stray node_modules.prev left behind"
ok "rolls a broken release back and the old version keeps running with its data"

# 4. local edits block an update instead of being overwritten
echo "// local edit" >> src/wordlist.js
if bash update.sh --tag v0.1.0 > "$WORK/out.txt" 2>&1; then fail "should refuse with local changes"; fi
grep -q "local changes" "$WORK/out.txt" || fail "should explain the refusal"
git checkout -q -- src/wordlist.js
ok "refuses to run over local edits"

# 5. going back to an older release on purpose
bash update.sh --tag v0.1.0 > "$WORK/out.txt" 2>&1 || fail "downgrade failed"
[ "$(git describe --tags --exact-match)" = v0.1.0 ] || fail "should be on v0.1.0"
ok "--tag moves to a specific release"
echo "all update checks passed"
