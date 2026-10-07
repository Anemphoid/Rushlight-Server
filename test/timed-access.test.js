// What happens when a timed join code expires, and when a member's timed access
// ends. Runs the real server against a stand-in LiveKit that records who gets
// disconnected. Expiries are a few seconds long and the sweep runs every 200 ms.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import Database from 'better-sqlite3'
import { startServer, newAccount } from './helpers.js'
import { startFakeLiveKit } from './fake-livekit.js'

let fake
let srv

before(async () => {
  fake = await startFakeLiveKit()
  srv = await startServer({ env: { LIVEKIT_URL: fake.url, PRESENCE_SWEEP_MS: '200' } })
})
after(async () => {
  await srv.stop()
  await fake.stop()
})

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function waitFor(check, ms = 12000, what = 'condition') {
  const end = Date.now() + ms
  while (Date.now() < end) {
    const v = await check()
    if (v) return v
    await sleep(100)
  }
  throw new Error(`timed out waiting for ${what}`)
}

// An owner with a server and one voice channel.
async function world() {
  const owner = await newAccount(srv)
  const s = (await srv.call('POST', '/api/servers', { name: 'Timed' }, owner.token)).data
  const voice = (await srv.call('POST', `/api/servers/${s.id}/channels`, { name: 'voice', mode: 'voice' }, owner.token)).data
  return { owner, s, voice, room: `s${s.id}-channel-${voice.id}` }
}

const makeCode = async (w, minutes, singleUse = false) =>
  (await srv.call('POST', `/api/servers/${w.s.id}/codes`, { singleUse, expiresInMinutes: minutes }, w.owner.token)).data

const view = (w, token) => srv.call('GET', `/api/servers/${w.s.id}`, undefined, token)
const hasAccess = async (w, token) => (await view(w, token)).status === 200

// Joins with a timed code, gets a voice token and checks in to the voice channel.
async function joinAndEnterVoice(w, member, minutes) {
  const code = await makeCode(w, minutes)
  assert.equal((await srv.call('POST', '/api/servers/join', { code: code.code }, member.token)).status, 200)
  assert.equal((await srv.call('POST', '/api/voice/token', { type: 'channel', id: w.voice.id }, member.token)).status, 200)
  assert.equal((await srv.call('POST', '/api/presence', { type: 'channel', id: w.voice.id }, member.token)).status, 200)
}

test('a member who joined with a timed code loses access when it expires, while idle', async () => {
  const w = await world()
  const member = await newAccount(srv)
  const code = await makeCode(w, 0.04) // about 2.4 seconds
  assert.equal((await srv.call('POST', '/api/servers/join', { code: code.code }, member.token)).status, 200)
  assert.equal(await hasAccess(w, member.token), true)
  assert.ok((await srv.call('GET', '/api/servers', undefined, member.token)).data.servers.some((x) => x.id === w.s.id))

  await waitFor(async () => !(await hasAccess(w, member.token)), 10000, 'the member to lose access')
  assert.ok(!(await srv.call('GET', '/api/servers', undefined, member.token)).data.servers.some((x) => x.id === w.s.id))
})

test('expiry during voice disconnects from LiveKit first, then clears presence', async () => {
  const w = await world()
  const member = await newAccount(srv)
  fake.reset()
  // When LiveKit is told to remove the member, look at what the server still shows.
  fake.onCall(async (call) => {
    if (call.method !== 'RemoveParticipant' || call.body.identity !== `acct-${member.id}`) return null
    const tree = (await view(w, w.owner.token)).data
    const here = (tree.presence[`channel:${w.voice.id}`] || []).some((p) => p.id === member.id)
    return { stillPresentWhenDisconnected: here }
  })
  try {
    await joinAndEnterVoice(w, member, 0.05)

    await waitFor(() => fake.removals().some((r) => r.identity === `acct-${member.id}`), 10000, 'the LiveKit disconnect')
    const removal = fake.removals().find((r) => r.identity === `acct-${member.id}`)
    assert.equal(removal.room, w.room)
    assert.equal(removal.seen.stillPresentWhenDisconnected, true, 'presence was cleared before LiveKit was told')

    await waitFor(
      async () => !((await view(w, w.owner.token)).data.presence[`channel:${w.voice.id}`] || []).some((p) => p.id === member.id),
      5000,
      'presence to clear'
    )
    assert.equal(await hasAccess(w, member.token), false)
  } finally {
    fake.onCall(null)
  }
})

test('guests who used an expired code are removed from voice, the way a revoked code removes them', async () => {
  const w = await world()
  fake.reset()
  const code = await makeCode(w, 0.1) // 6 seconds
  const guest = (await srv.call('POST', '/api/join', { code: code.code, screenName: 'Short Stay' })).data
  const tok = await srv.call('POST', '/api/voice/token', { type: 'channel', id: w.voice.id }, guest.guestToken)
  assert.equal(tok.status, 200)
  const identity = JSON.parse(Buffer.from(guest.guestToken.split('.')[1], 'base64url')).identity

  await waitFor(() => fake.removals().some((r) => r.identity === identity), 15000, 'the guest to be disconnected')
  assert.equal(fake.removals().find((r) => r.identity === identity).room, w.room)
  // and the expired token no longer gets a voice token
  assert.notEqual((await srv.call('POST', '/api/voice/token', { type: 'channel', id: w.voice.id }, guest.guestToken)).status, 200)
})

test('expired people can come back with a new code, they are not banned', async () => {
  const w = await world()
  const member = await newAccount(srv)
  const code = await makeCode(w, 0.04)
  await srv.call('POST', '/api/servers/join', { code: code.code }, member.token)
  await waitFor(async () => !(await hasAccess(w, member.token)), 10000, 'expiry')

  const bans = (await srv.call('GET', `/api/servers/${w.s.id}/bans`, undefined, w.owner.token)).data.bans
  assert.equal(bans.length, 0)
  const fresh = await makeCode(w, null)
  assert.equal((await srv.call('POST', '/api/servers/join', { code: fresh.code }, member.token)).status, 200)
  assert.equal(await hasAccess(w, member.token), true)
})

test('the owner and other admins never expire, even if a stray expiry is on their row', async () => {
  const w = await world()
  const second = await newAccount(srv)
  const code = await makeCode(w, null)
  await srv.call('POST', '/api/servers/join', { code: code.code }, second.token)

  const db = new Database(srv.dbPath)
  db.prepare('UPDATE server_members SET is_admin = 1 WHERE server_id = ? AND account_id = ?').run(w.s.id, second.id)
  db.prepare('UPDATE server_members SET access_expires_at = ? WHERE server_id = ?').run(Date.now() - 60000, w.s.id)
  db.close()

  await sleep(2500) // many sweeps
  assert.equal(await hasAccess(w, w.owner.token), true, 'the owner lost access')
  assert.equal(await hasAccess(w, second.token), true, 'an admin lost access')
})

test('a permanent member who redeems a timed code stays permanent', async () => {
  const w = await world()
  const member = await newAccount(srv)
  const permanent = await makeCode(w, null)
  await srv.call('POST', '/api/servers/join', { code: permanent.code }, member.token)
  const timed = await makeCode(w, 0.04)
  assert.equal((await srv.call('POST', '/api/servers/join', { code: timed.code }, member.token)).status, 200)
  await sleep(3500)
  assert.equal(await hasAccess(w, member.token), true)
})

test('an admin can put a timer on a member directly, and it expires the same way', async () => {
  const w = await world()
  const member = await newAccount(srv)
  const code = await makeCode(w, null)
  await srv.call('POST', '/api/servers/join', { code: code.code }, member.token)
  assert.equal((await srv.call('PATCH', `/api/servers/${w.s.id}/members/${member.id}`, { accessExpiresInMinutes: 0.04 }, w.owner.token)).status, 200)
  await waitFor(async () => !(await hasAccess(w, member.token)), 10000, 'the timer to run out')
})

test('the server says why access ended, so the client can show a clear message', async () => {
  const w = await world()
  const expired = await newAccount(srv)
  const kicked = await newAccount(srv)
  const banned = await newAccount(srv)
  const stranger = await newAccount(srv)
  const open = await makeCode(w, null)
  for (const m of [kicked, banned]) await srv.call('POST', '/api/servers/join', { code: open.code }, m.token)
  const timed = await makeCode(w, 0.04)
  await srv.call('POST', '/api/servers/join', { code: timed.code }, expired.token)
  await srv.call('POST', `/api/servers/${w.s.id}/members/${kicked.id}/kick`, {}, w.owner.token)
  await srv.call('POST', `/api/servers/${w.s.id}/members/${banned.id}/ban`, {}, w.owner.token)
  await waitFor(async () => !(await hasAccess(w, expired.token)), 10000, 'expiry')

  const r1 = await view(w, expired.token)
  assert.equal(r1.status, 403)
  assert.equal(r1.data.reason, 'expired')
  assert.match(r1.data.error, /expired/i)
  assert.equal((await view(w, kicked.token)).data.reason, 'removed')
  assert.equal((await view(w, banned.token)).data.reason, 'banned')
  const r4 = await view(w, stranger.token)
  assert.equal(r4.status, 403)
  assert.equal(r4.data.reason, undefined)

  // rejoining clears it
  assert.equal((await srv.call('POST', '/api/servers/join', { code: open.code }, expired.token)).status, 200)
  assert.equal(await hasAccess(w, expired.token), true)
})
