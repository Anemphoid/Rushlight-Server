// A server whose machine changed its network address tells its owner and admins, and nobody else, and never judges a public
// server or an address it cannot compare. The decisions are unit tested; the screen the app reads is tested on a real server.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { localAddresses, configuredAddress, judgeAddress, createAddressWatch } from '../src/address-watch.js'
import { startServer, newAccount } from './helpers.js'

const net = (name, address, extra = {}) => [name, [{ address, family: 'IPv4', internal: false, ...extra }]]
const ifaces = (...rows) => Object.fromEntries(rows)

test('the machine addresses worth offering leave out loopback, link-local and bridges', () => {
  const got = localAddresses(
    ifaces(net('lo', '127.0.0.1', { internal: true }), net('eth0', '192.168.70.11'), net('docker0', '172.17.0.1'), net('br-abc', '172.18.0.1'), net('wlan0', '169.254.3.4'), net('tailscale0', '100.64.1.2'))
  )
  assert.deepEqual(got.map((g) => g.ip), ['192.168.70.11', '100.64.1.2'])
})

test('the settings address comes from HOST_IP, else a real address in a LiveKit setting, and a public server has none', () => {
  assert.equal(configuredAddress({ HOST_IP: '192.168.1.5', LIVEKIT_URL: 'ws://127.0.0.1:7880' }), '192.168.1.5')
  assert.equal(configuredAddress({ LIVEKIT_URL: 'ws://192.168.70.15:7880' }), '192.168.70.15')
  assert.equal(configuredAddress({ LIVEKIT_URL: 'ws://127.0.0.1:7880' }), null)
  assert.equal(configuredAddress({ LIVEKIT_PUBLIC_URL: 'wss://voice.example.com', LIVEKIT_URL: 'ws://127.0.0.1:7880' }), null)
  assert.equal(configuredAddress({ RUSHLIGHT_MODE: 'public', HOST_IP: '203.0.113.7' }), null)
  assert.equal(configuredAddress({ HOST_IP: 'pending' }), null)
})

test('an address the machine still has is fine; one it lost names the new one', () => {
  const local = [{ ip: '192.168.70.11', name: 'eth0' }, { ip: '100.64.1.2', name: 'tailscale0' }]
  assert.equal(judgeAddress({ configured: '192.168.70.11', local, mode: '' }).state, 'ok')
  const moved = judgeAddress({ configured: '192.168.70.15', local, mode: '' })
  assert.equal(moved.state, 'changed')
  assert.equal(moved.suggested, '192.168.70.11', 'a private address, not the Tailscale one')
  const ts = judgeAddress({ configured: '100.64.9.9', local, mode: 'tailscale' })
  assert.equal(ts.suggested, '100.64.1.2', 'in Tailscale mode the Tailscale address')
  assert.equal(judgeAddress({ configured: null, local, mode: '' }).state, 'unknown')
})

test('with no address left to suggest it still says that it changed, and logs once per change', () => {
  const lines = []
  let now = ifaces(net('eth0', '192.168.70.11'))
  const w = createAddressWatch({ env: { HOST_IP: '192.168.70.15' }, interfaces: () => now, log: (l) => lines.push(l), port: 4000 })
  w.refresh()
  w.refresh()
  assert.equal(lines.length, 1, 'one line however often it looks')
  assert.match(lines[0], /192\.168\.70\.15.*192\.168\.70\.11/)
  assert.match(w.view().message, /http:\/\/192\.168\.70\.11:4000/)
  now = ifaces()
  w.refresh()
  assert.equal(w.view().suggested, null)
  assert.equal(w.view().message, null)
  now = ifaces(net('eth0', '192.168.70.15'))
  w.refresh()
  assert.equal(w.view(), null, 'back to the address in the settings: nothing to say')
})

test('on a real server only the owner and admins are told, and only when the address is wrong', async () => {
  const real = localAddresses()[0]
  if (!real) return // a machine with no network address cannot be tested this way
  const wrong = await startServer({ env: { HOST_IP: '10.254.253.252', RUSHLIGHT_MODE: 'private', ACCOUNT_LIMIT: '1000' } })
  const fine = await startServer({ env: { HOST_IP: real.ip, ACCOUNT_LIMIT: '1000' } })
  const pub = await startServer({ env: { HOST_IP: '10.254.253.252', RUSHLIGHT_MODE: 'public', ACCOUNT_LIMIT: '1000' } })
  try {
    for (const [srv, expectNotice] of [[wrong, true], [fine, false], [pub, false]]) {
      const owner = await newAccount(srv)
      const s = (await srv.call('POST', '/api/servers', { name: 'Hall' }, owner.token)).data
      const code = (await srv.call('POST', `/api/servers/${s.id}/codes`, { singleUse: false, expiresInMinutes: null }, owner.token)).data
      const member = await newAccount(srv)
      await srv.call('POST', '/api/servers/join', { code: code.code }, member.token)
      const asOwner = (await srv.call('GET', `/api/servers/${s.id}`, undefined, owner.token)).data
      const asMember = (await srv.call('GET', `/api/servers/${s.id}`, undefined, member.token)).data
      assert.equal('addressChange' in asMember, false, 'a plain member is never told')
      if (expectNotice) {
        assert.equal(asOwner.addressChange.configured, '10.254.253.252')
        assert.equal(asOwner.addressChange.suggested, real.ip)
        assert.match(asOwner.addressChange.message, new RegExp(`New address: http://${real.ip.replace(/\./g, '\\.')}:`))
        assert.match(srv.log(), /address changed/)
        await srv.call('POST', `/api/servers/${s.id}/members/${member.id}/admin`, { admin: true }, owner.token)
        const asAdmin = (await srv.call('GET', `/api/servers/${s.id}`, undefined, member.token)).data
        assert.ok(asAdmin.addressChange, 'an admin who is not the owner is told too')
      } else {
        assert.equal('addressChange' in asOwner, false)
      }
    }
  } finally {
    await Promise.all([wrong.stop(), fine.stop(), pub.stop()])
  }
})
