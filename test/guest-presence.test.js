// Guests in presence: they check in, members see them, they see only their own
// space, and they are cleaned up on leave, revoke and expiry (LiveKit first, then
// presence). Runs the real server against a stand-in LiveKit.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { startServer, newAccount, jwtClaims } from './helpers.js'
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
async function waitFor(check, ms = 8000, what = 'condition') {
  const end = Date.now() + ms
  while (Date.now() < end) {
    if (await check()) return
    await sleep(100)
  }
  throw new Error(`timed out waiting for ${what}`)
}

// An owner with a server that has two voice channels (a and b), and a reusable code.
async function world(server = srv) {
  const owner = await newAccount(server)
  const s = (await server.call('POST', '/api/servers', { name: 'Guests' }, owner.token)).data
  const a = (await server.call('POST', `/api/servers/${s.id}/channels`, { name: 'a', mode: 'both' }, owner.token)).data
  const b = (await server.call('POST', `/api/servers/${s.id}/channels`, { name: 'b', mode: 'voice' }, owner.token)).data
  const code = (await server.call('POST', `/api/servers/${s.id}/codes`, { singleUse: false, expiresInMinutes: null }, owner.token)).data
  return { owner, s, a, b, code, keyA: `channel:${a.id}`, keyB: `channel:${b.id}`, roomA: `s${s.id}-channel-${a.id}` }
}

async function joinGuest(w, name, code = w.code, server = srv) {
  const r = await server.call('POST', '/api/join', { code: code.code, screenName: name })
  assert.equal(r.status, 200, JSON.stringify(r.data))
  return { token: r.data.guestToken, name: r.data.screenName, identity: jwtClaims(r.data.guestToken).identity }
}

const checkIn = (w, who, space, color, server = srv) =>
  server.call('POST', '/api/presence', { type: 'channel', id: space.id, avatarColor: color }, who.token)
const treeAsOwner = async (w) => (await srv.call('GET', `/api/servers/${w.s.id}`, undefined, w.owner.token)).data

test('a guest checks in, and a member sees them with their name and no avatar image', async () => {
  const w = await world()
  const guest = await joinGuest(w, 'Visitor One')
  const r = await checkIn(w, guest, w.a, '#aabbcc')
  assert.equal(r.status, 200)

  const tree = await treeAsOwner(w)
  const here = tree.presence[w.keyA]
  assert.equal(here.length, 1)
  assert.equal(here[0].name, 'Visitor One')
  assert.equal(here[0].guest, true)
  assert.equal(here[0].id, guest.identity)
  assert.equal(here[0].avatarUpdatedAt, null)
  assert.equal(here[0].avatarColor, '#aabbcc')
})

test("a member's avatar lookup copes with guests in the mix", async () => {
  const w = await world()
  const member = await newAccount(srv)
  await srv.call('POST', '/api/servers/join', { code: w.code.code }, member.token)
  await checkIn(w, member, w.a)
  const guest = await joinGuest(w, 'Mixed Room')
  await checkIn(w, guest, w.a)
  const here = (await treeAsOwner(w)).presence[w.keyA]
  assert.deepEqual(here.map((p) => p.name).sort(), [(await srv.call('GET', '/api/me', undefined, member.token)).data.username, 'Mixed Room'].sort())
  assert.equal(here.filter((p) => p.guest).length, 1)
})

test("a guest's answer holds only their own space; a member still gets the whole server", async () => {
  const w = await world()
  const member = await newAccount(srv)
  await srv.call('POST', '/api/servers/join', { code: w.code.code }, member.token)
  await checkIn(w, member, w.b) // a member in the other channel

  const guest = await joinGuest(w, 'Nosy Guest')
  const mine = await checkIn(w, guest, w.a)
  assert.deepEqual(Object.keys(mine.data.presence), [w.keyA])
  assert.deepEqual(mine.data.presence[w.keyA].map((p) => p.name), ['Nosy Guest'])

  const seen = await checkIn(w, member, w.b)
  assert.deepEqual(Object.keys(seen.data.presence).sort(), [w.keyA, w.keyB].sort())
})

test('the join answer shows a guest no presence yet', async () => {
  const w = await world()
  const member = await newAccount(srv)
  await srv.call('POST', '/api/servers/join', { code: w.code.code }, member.token)
  await checkIn(w, member, w.a)
  const joined = await srv.call('POST', '/api/join', { code: w.code.code, screenName: 'Fresh Face' })
  assert.deepEqual(joined.data.server.presence, {})
})

test('a guest cannot check in to a space in another server, or with a bad id', async () => {
  const w = await world()
  const other = await world()
  const guest = await joinGuest(w, 'Wanderer')
  assert.equal((await srv.call('POST', '/api/presence', { type: 'channel', id: other.a.id }, guest.token)).status, 403)
  assert.equal((await srv.call('POST', '/api/presence', { type: 'channel', id: 999999 }, guest.token)).status, 404)
  assert.equal((await srv.call('POST', '/api/presence', { type: 'channel', id: { a: 1 } }, guest.token)).status, 400)
  // nothing leaked into the other server
  assert.deepEqual((await treeAsOwner(other)).presence, {})
})

test('a guest moving to another space leaves the first one', async () => {
  const w = await world()
  const guest = await joinGuest(w, 'Mover')
  await checkIn(w, guest, w.a)
  await checkIn(w, guest, w.b)
  const p = (await treeAsOwner(w)).presence
  assert.equal(p[w.keyA], undefined)
  assert.equal(p[w.keyB].length, 1)
})

test('leaving removes the guest at once', async () => {
  const w = await world()
  const guest = await joinGuest(w, 'Quick Exit')
  await checkIn(w, guest, w.a)
  assert.equal((await srv.call('POST', '/api/presence/leave', {}, guest.token)).status, 200)
  assert.deepEqual((await treeAsOwner(w)).presence, {})
})

test('revoking the code disconnects the guest from LiveKit first, then clears presence', async () => {
  const w = await world()
  const code = (await srv.call('POST', `/api/servers/${w.s.id}/codes`, { singleUse: false, expiresInMinutes: null }, w.owner.token)).data
  const guest = await joinGuest(w, 'Revoked Rex', code)
  await checkIn(w, guest, w.a)
  fake.reset()
  fake.onCall(async (call) => {
    if (call.method !== 'RemoveParticipant' || call.body.identity !== guest.identity) return null
    const here = ((await treeAsOwner(w)).presence[w.keyA] || []).some((p) => p.id === guest.identity)
    return { stillPresentWhenDisconnected: here }
  })
  try {
    const row = (await srv.call('GET', `/api/servers/${w.s.id}/codes`, undefined, w.owner.token)).data.codes.find((c) => c.code === code.code)
    assert.equal((await srv.call('DELETE', `/api/servers/${w.s.id}/codes/${row.id}`, undefined, w.owner.token)).status, 200)
  } finally {
    fake.onCall(null)
  }
  const removal = fake.removals().find((r) => r.identity === guest.identity)
  assert.ok(removal, 'LiveKit was never told to drop the guest')
  assert.equal(removal.room, w.roomA)
  assert.equal(removal.seen.stillPresentWhenDisconnected, true, 'presence was cleared before LiveKit was told')
  assert.deepEqual((await treeAsOwner(w)).presence, {})
  // and they cannot check back in
  assert.equal((await checkIn(w, guest, w.a)).status, 403)
})

test('when the code expires the guest is dropped from voice and presence', async () => {
  const w = await world()
  const code = (await srv.call('POST', `/api/servers/${w.s.id}/codes`, { singleUse: false, expiresInMinutes: 0.1 }, w.owner.token)).data
  const guest = await joinGuest(w, 'Short Stay', code)
  assert.equal((await checkIn(w, guest, w.a)).status, 200)
  fake.reset()
  await waitFor(() => fake.removals().some((r) => r.identity === guest.identity), 15000, 'the guest to be dropped')
  assert.equal(fake.removals().find((r) => r.identity === guest.identity).room, w.roomA)
  await waitFor(async () => !((await treeAsOwner(w)).presence[w.keyA] || []).some((p) => p.id === guest.identity), 5000, 'presence to clear')
})

test('guests cannot vote on, start or withdraw a persistence vote', async () => {
  const w = await world()
  const guest = await joinGuest(w, 'No Vote')
  assert.equal((await srv.call('POST', '/api/proposals/1/vote', { vote: 'agree' }, guest.token)).status, 401)
  assert.equal((await srv.call('DELETE', '/api/proposals/1', undefined, guest.token)).status, 401)
  assert.equal((await srv.call('POST', `/api/servers/${w.s.id}/channels/${w.a.id}/persist-vote`, {}, guest.token)).status, 401)
  assert.equal((await srv.call('POST', `/api/channels/${w.a.id}/messages`, { text: 'hi' }, guest.token)).status, 401)
})

test('admins can list the guests here, members and guests cannot', async () => {
  const w = await world()
  const member = await newAccount(srv)
  await srv.call('POST', '/api/servers/join', { code: w.code.code }, member.token)
  const guest = await joinGuest(w, 'On The List')
  // listed from the moment they join, before they are in any room
  let list = await srv.call('GET', `/api/servers/${w.s.id}/guests`, undefined, w.owner.token)
  assert.equal(list.status, 200)
  assert.equal(list.data.guests.length, 1)
  const row = list.data.guests[0]
  assert.equal(row.name, 'On The List')
  assert.equal(row.code, w.code.code)
  assert.equal(row.space, null)
  assert.ok(row.joinedAt <= Date.now() && row.joinedAt > Date.now() - 60000)
  assert.ok(row.expiresAt > Date.now())

  await checkIn(w, guest, w.a)
  list = await srv.call('GET', `/api/servers/${w.s.id}/guests`, undefined, w.owner.token)
  assert.equal(list.data.guests[0].space, w.keyA)

  assert.equal((await srv.call('GET', `/api/servers/${w.s.id}/guests`, undefined, member.token)).status, 403)
  assert.equal((await srv.call('GET', `/api/servers/${w.s.id}/guests`, undefined, guest.token)).status, 401)
  // another server's admin cannot see this server's guests
  const other = await world()
  assert.equal((await srv.call('GET', `/api/servers/${w.s.id}/guests`, undefined, other.owner.token)).status, 403)

  // revoking the code takes them off the list
  const codeRow = (await srv.call('GET', `/api/servers/${w.s.id}/codes`, undefined, w.owner.token)).data.codes.find((c) => c.code === w.code.code)
  await srv.call('DELETE', `/api/servers/${w.s.id}/codes/${codeRow.id}`, undefined, w.owner.token)
  list = await srv.call('GET', `/api/servers/${w.s.id}/guests`, undefined, w.owner.token)
  assert.deepEqual(list.data.guests, [])
})

test('a guest who stops checking in disappears after the presence timeout', async () => {
  const quick = await startServer({ env: { LIVEKIT_URL: fake.url, PRESENCE_TTL_MS: '1200', PRESENCE_SWEEP_MS: '200' } })
  try {
    const w = await world(quick)
    const guest = await joinGuest(w, 'Closed The Window', w.code, quick)
    await checkIn(w, guest, w.a, undefined, quick)
    const owner = async () => (await quick.call('GET', `/api/servers/${w.s.id}`, undefined, w.owner.token)).data.presence
    assert.equal((await owner())[w.keyA].length, 1)
    await waitFor(async () => (await owner())[w.keyA] === undefined, 6000, 'the guest to time out')
  } finally {
    await quick.stop()
  }
})

test('an ephemeral room does not wipe while only a guest is in it, and wipes after they leave', async () => {
  const quick = await startServer({ env: { LIVEKIT_URL: fake.url, WIPE_GRACE_MS: '800', PRESENCE_SWEEP_MS: '200' } })
  try {
    const w = await world(quick) // channel a is ephemeral
    const member = await newAccount(quick)
    await quick.call('POST', '/api/servers/join', { code: w.code.code }, member.token)
    const guest = await joinGuest(w, 'Last One Standing', w.code, quick)

    await checkIn(w, member, w.a, undefined, quick)
    await checkIn(w, guest, w.a, undefined, quick)
    assert.equal((await quick.call('POST', `/api/channels/${w.a.id}/messages`, { text: 'still here?' }, member.token)).status, 200)

    // the member leaves; only the guest is left
    await quick.call('POST', '/api/presence/leave', {}, member.token)
    await sleep(2500) // several sweeps, well past the grace
    const kept = (await quick.call('GET', `/api/channels/${w.a.id}/messages`, undefined, w.owner.token)).data.messages
    assert.equal(kept.length, 1, 'the room wiped while a guest was in it')

    // the guest leaves; now it wipes
    await quick.call('POST', '/api/presence/leave', {}, guest.token)
    await waitFor(
      async () => (await quick.call('GET', `/api/channels/${w.a.id}/messages`, undefined, w.owner.token)).data.messages.length === 0,
      6000,
      'the room to wipe after the guest left'
    )
  } finally {
    await quick.stop()
  }
})

test('check-ins are rate limited per address, for guests and accounts alike', async () => {
  const limited = await startServer({ env: { LIVEKIT_URL: fake.url, PRESENCE_LIMIT: '5' } })
  try {
    const w = await world(limited)
    const guest = await joinGuest(w, 'Eager Beaver', w.code, limited)
    const statuses = []
    for (let i = 0; i < 7; i++) statuses.push((await checkIn(w, guest, w.a, undefined, limited)).status)
    assert.deepEqual(statuses.slice(0, 5), [200, 200, 200, 200, 200])
    assert.deepEqual(statuses.slice(5), [429, 429])
    // the limit is per address, so an account is held to the same one
    assert.equal((await limited.call('POST', '/api/presence', { type: 'channel', id: w.a.id }, w.owner.token)).status, 429)
  } finally {
    await limited.stop()
  }
})
