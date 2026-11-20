// The host-side program fixes voice when the computer's address changes, on its own: `./rushlight address --auto` (what the
// every-minute watch runs), the same check at `start`, and the switch that turns the watch on and off. docker and crontab are
// stand-ins that record what they were asked to do, so no containers run here (the stack tests do that for real).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, readFileSync, copyFileSync, chmodSync, mkdirSync, existsSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')

function setup(env = '') {
  const dir = mkdtempSync(join(tmpdir(), 'rl-addr-'))
  const bin = join(dir, 'bin')
  mkdirSync(bin)
  copyFileSync(join(root, 'deploy/rushlight'), join(dir, 'rushlight'))
  copyFileSync(join(root, 'deploy/compose.yaml'), join(dir, 'compose.yaml'))
  chmodSync(join(dir, 'rushlight'), 0o755)
  const calls = join(dir, 'docker.calls')
  const cron = join(dir, 'crontab.txt')
  writeFileSync(join(bin, 'docker'), `#!/bin/sh
echo "$@" >> '${calls}'
case "$*" in
  "compose version --short") echo 2.30.0 ;;
esac
exit 0
`)
  writeFileSync(join(bin, 'crontab'), `#!/bin/sh
case "$1" in
  -l) [ -f '${cron}' ] && cat '${cron}' || exit 1 ;;
  -r) rm -f '${cron}' ;;
  -) cat > '${cron}' ;;
esac
`)
  writeFileSync(join(bin, 'curl'), '#!/bin/sh\nexit 0\n') // the server "answers" at once
  chmodSync(join(bin, 'curl'), 0o755)
  chmodSync(join(bin, 'docker'), 0o755)
  chmodSync(join(bin, 'crontab'), 0o755)
  writeFileSync(
    join(dir, '.env'),
    ['JWT_SECRET=x', 'LIVEKIT_API_KEY=k', 'LIVEKIT_API_SECRET=s', 'LIVEKIT_URL=ws://127.0.0.1:7880', 'HOST_IP=192.168.70.15', 'PORT=4000', 'LIVEKIT_VERSION=v1.9.0', env].filter(Boolean).join('\n') + '\n'
  )
  writeFileSync(join(dir, 'livekit.yaml'), 'node_ip: 192.168.70.15\n')
  const run = (args, extra = {}) =>
    spawnSync(join(dir, 'rushlight'), args, { cwd: dir, encoding: 'utf8', env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, ...extra } })
  const envOf = (k) => (readFileSync(join(dir, '.env'), 'utf8').match(new RegExp(`^${k}=(.*)$`, 'm')) || [])[1]
  const dockerCalls = () => (existsSync(calls) ? readFileSync(calls, 'utf8') : '')
  return { dir, run, envOf, dockerCalls, cron, yaml: () => readFileSync(join(dir, 'livekit.yaml'), 'utf8') }
}

test('--auto does nothing, quietly, while the computer still has the address in .env', () => {
  const t = setup()
  const r = t.run(['address', '--auto'], { RUSHLIGHT_TEST_ADDRESSES: '192.168.70.15 127.0.0.1', RUSHLIGHT_TEST_LAN_IP: '192.168.70.15' })
  assert.equal(r.status, 0)
  assert.equal(r.stdout + r.stderr, '')
  assert.equal(t.dockerCalls().includes('recreate'), false)
})

test('--auto fixes the settings and recreates voice when the address is gone', () => {
  const t = setup()
  const r = t.run(['address', '--auto'], { RUSHLIGHT_TEST_ADDRESSES: '192.168.70.11 127.0.0.1', RUSHLIGHT_TEST_LAN_IP: '192.168.70.11' })
  assert.equal(r.status, 0, r.stderr)
  assert.equal(t.envOf('HOST_IP'), '192.168.70.11')
  assert.match(t.yaml(), /node_ip: 192\.168\.70\.11/)
  assert.match(t.dockerCalls(), /up -d --force-recreate livekit/)
  assert.match(r.stdout, /changed from 192\.168\.70\.15 to 192\.168\.70\.11/)
})

test('--auto leaves a public server, an unknown address and a missing .env alone', () => {
  const pub = setup('RUSHLIGHT_MODE=public')
  assert.equal(pub.run(['address', '--auto'], { RUSHLIGHT_TEST_ADDRESSES: '10.0.0.9', RUSHLIGHT_TEST_LAN_IP: '10.0.0.9' }).stdout, '')
  assert.equal(pub.envOf('HOST_IP'), '192.168.70.15')
  const unknown = setup()
  assert.equal(unknown.run(['address', '--auto'], { RUSHLIGHT_TEST_ADDRESSES: '10.0.0.9', RUSHLIGHT_TEST_LAN_IP: '' }).stdout, '', 'no new address found: change nothing')
  assert.equal(unknown.envOf('HOST_IP'), '192.168.70.15')
  const none = setup()
  rmSync(join(none.dir, '.env'))
  assert.equal(none.run(['address', '--auto'], { RUSHLIGHT_TEST_ADDRESSES: '10.0.0.9', RUSHLIGHT_TEST_LAN_IP: '10.0.0.9' }).status, 0)
})

test('start sets voice up for the new address, and tells the owner what to send friends', () => {
  const t = setup()
  const r = t.run(['start'], { RUSHLIGHT_TEST_ADDRESSES: '192.168.70.11', RUSHLIGHT_TEST_LAN_IP: '192.168.70.11' })
  assert.equal(t.envOf('HOST_IP'), '192.168.70.11')
  assert.match(t.yaml(), /node_ip: 192\.168\.70\.11/)
  assert.match(r.stdout, /address changed from 192\.168\.70\.15 to 192\.168\.70\.11/)
  assert.match(r.stdout, /New address: http:\/\/192\.168\.70\.11:4000/)
})

test('start keeps an address chosen on purpose while the computer still has it', () => {
  const t = setup()
  t.run(['start'], { RUSHLIGHT_TEST_ADDRESSES: '192.168.70.15 192.168.70.11', RUSHLIGHT_TEST_LAN_IP: '192.168.70.11' })
  assert.equal(t.envOf('HOST_IP'), '192.168.70.15')
})

test('autofix on puts the watch in cron, off takes only that out, and status says which', () => {
  const t = setup()
  writeFileSync(t.cron, '0 4 * * * /usr/bin/something-else\n')
  assert.match(t.run(['autofix', 'status']).stdout, /^Off/)
  assert.equal(t.run(['autofix', 'on']).status, 0)
  const after = readFileSync(t.cron, 'utf8')
  assert.match(after, /something-else/)
  assert.match(after, /^\* \* \* \* \* cd '.*' && \.\/rushlight address --auto >> '.*\.autofix\.log' 2>&1 # rushlight-autofix$/m)
  assert.match(after, /^@reboot sleep 30 && cd '.*' && \.\/rushlight address --auto .*# rushlight-autofix$/m)
  assert.match(t.run(['autofix', 'status']).stdout, /^On/)
  t.run(['autofix', 'on'])
  assert.equal((readFileSync(t.cron, 'utf8').match(/rushlight-autofix/g) || []).length, 2, 'turning it on twice does not repeat it')
  t.run(['autofix', 'off'])
  const gone = readFileSync(t.cron, 'utf8')
  assert.match(gone, /something-else/)
  assert.equal(gone.includes('rushlight-autofix'), false)
})
