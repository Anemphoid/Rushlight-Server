// Join codes limited to one channel or room: what a guest with one can reach, what
// they see, that an account can't use one to become a member, and that removing
// the channel or room ends the invite. Runs the real server against a stand-in LiveKit.
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

// Channel a (voice+text) with rooms a1 and a2, channel b with room b1.
async function world() {
  const owner = await newAccount(srv)
  const o = owner.token
  const s = (await srv.call('POST', '/api/servers', { name: 'Scoped' }, o)).data
  const mkChannel = async (name) => (await srv.call('POST', `/api/servers/${s.id}/channels`, { name, mode: 'both' }, o)).data
  const mkRoom = async (ch, name) =>
    (await srv.call('POST', `/api/servers/${s.id}/channels/${ch.id}/rooms`, { name, mode: 'both' }, o)).data
  const a = await mkChannel('a')
  const b = await mkChannel('b')
  const a1 = await mkRoom(a, 'a1')
  const a2 = await mkRoom(a, 'a2')
  const b1 = await mkRoom(b, 'b1')
  const code = async (scope, extra = {}) =>
    srv.call('POST', `/api/servers/${s.id}/codes`, { singleUse: false, expiresInMinutes: null, scope, ...extra }, o)
  return { owner, s, a, b, a1, a2, b1, code }
}

async function joinGuest(code, name) {
  const r = await srv.call('POST', '/api/join', { code, screenName: name })
  assert.equal(r.status, 200, JSON.stringify(r.data))
  return { token: r.data.guestToken, tree: r.data.server.channels, identity: jwtClaims(r.data.guestToken).identity }
}
const voice = (who, type, id) => srv.call('POST', '/api/voice/token', { type, id }, who.token)
const checkIn = (who, type, id) => srv.call('POST', '/api/presence', { type, id }, who.token)

test('a room code gets a token for that room only', async () => {
  const w = await world()
  const c = (await w.code({ type: 'room', id: w.a1.id })).data
  assert.deepEqual(c.scope, { type: 'room', id: w.a1.id, name: 'a / a1' })
  const g = await joinGuest(c.code, 'Room Guest')
  assert.equal((await voice(g, 'room', w.a1.id)).status, 200)
  assert.equal((await voice(g, 'room', w.a2.id)).status, 403) // sibling room
  assert.equal((await voice(g, 'room', w.b1.id)).status, 403) // other channel's room
  assert.equal((await voice(g, 'channel', w.a.id)).status, 403) // the parent channel
  assert.equal((await voice(g, 'channel', w.b.id)).status, 403)
})

test('a channel code covers the channel and its rooms, nothing else', async () => {
  const w = await world()
  const c = (await w.code({ type: 'channel', id: w.a.id })).data
  const g = await joinGuest(c.code, 'Channel Guest')
  assert.equal((await voice(g, 'channel', w.a.id)).status, 200)
  assert.equal((await voice(g, 'room', w.a1.id)).status, 200)
  assert.equal((await voice(g, 'room', w.a2.id)).status, 200)
  assert.equal((await voice(g, 'channel', w.b.id)).status, 403)
  assert.equal((await voice(g, 'room', w.b1.id)).status, 403)
})

test('a server-wide code still covers everything', async () => {
  const w = await world()
  const c = (await w.code(undefined)).data
  assert.equal(c.scope, null)
  const g = await joinGuest(c.code, 'Everywhere')
  for (const [t, id] of [['channel', w.a.id], ['channel', w.b.id], ['room', w.a1.id], ['room', w.b1.id]]) {
    assert.equal((await voice(g, t, id)).status, 200, `${t} ${id}`)
  }
  assert.equal(g.tree.length, 2)
})

test('a scoped guest sees only what the code covers', async () => {
  const w = await world()
  const room = await joinGuest((await w.code({ type: 'room', id: w.a2.id })).data.code, 'Sees One Room')
  assert.equal(room.tree.length, 1)
  assert.equal(room.tree[0].id, w.a.id)
  assert.equal(room.tree[0].joinable, false) // the parent is there for context only
  assert.deepEqual(room.tree[0].rooms.map((r) => r.id), [w.a2.id])

  const chan = await joinGuest((await w.code({ type: 'channel', id: w.b.id })).data.code, 'Sees One Channel')
  assert.equal(chan.tree.length, 1)
  assert.equal(chan.tree[0].id, w.b.id)
  assert.equal(chan.tree[0].joinable, undefined)
  assert.deepEqual(chan.tree[0].rooms.map((r) => r.id), [w.b1.id])

  // members still get the whole tree, untouched
  const full = (await srv.call('GET', `/api/servers/${w.s.id}`, undefined, w.owner.token)).data.channels
  assert.equal(full.length, 2)
  assert.ok(full.every((ch) => ch.joinable === undefined))
  assert.equal(full.find((ch) => ch.id === w.a.id).rooms.length, 2)
})

test('a scoped guest cannot check in outside their scope', async () => {
  const w = await world()
  const g = await joinGuest((await w.code({ type: 'room', id: w.a1.id })).data.code, 'Stays Put')
  assert.equal((await checkIn(g, 'room', w.a1.id)).status, 200)
  assert.equal((await checkIn(g, 'room', w.a2.id)).status, 403)
  assert.equal((await checkIn(g, 'channel', w.b.id)).status, 403)
  const here = (await srv.call('GET', `/api/servers/${w.s.id}`, undefined, w.owner.token)).data.presence
  assert.deepEqual(Object.keys(here), [`room:${w.a1.id}`])
})

test('an account cannot become a member with a scoped code, and the code is not used up', async () => {
  const w = await world()
  const c = (await w.code({ type: 'room', id: w.a1.id }, { singleUse: true })).data
  const me = await newAccount(srv)
  const r = await srv.call('POST', '/api/servers/join', { code: c.code }, me.token)
  assert.equal(r.status, 403)
  assert.match(r.data.error, /guest invite for one room/)
  // still good for the guest it was meant for
  const g = await joinGuest(c.code, 'Intended Guest')
  assert.equal((await voice(g, 'room', w.a1.id)).status, 200)
  // and the account did not become a member
  assert.equal((await srv.call('GET', `/api/servers/${w.s.id}`, undefined, me.token)).status, 403)
})

test('codes can only be scoped to a real channel or room of this server', async () => {
  const w = await world()
  const other = await world()
  const bad = async (scope) => (await w.code(scope)).status
  assert.equal(await bad({ type: 'room', id: other.a1.id }), 400) // another server's room
  assert.equal(await bad({ type: 'channel', id: other.a.id }), 400)
  assert.equal(await bad({ type: 'room', id: 999999 }), 400)
  assert.equal(await bad({ type: 'server', id: w.s.id }), 400)
  assert.equal(await bad({ type: 'room' }), 400)
  assert.equal(await bad('room'), 400)
  assert.equal(await bad({ type: 'room', id: { a: 1 } }), 400)
  // a text-only space has no voice, so a guest invite to it is pointless
  const text = (await srv.call('POST', `/api/servers/${w.s.id}/channels`, { name: 'chat', mode: 'text' }, w.owner.token)).data
  assert.equal(await bad({ type: 'channel', id: text.id }), 400)
  assert.equal((await srv.call('GET', `/api/servers/${w.s.id}/codes`, undefined, w.owner.token)).data.codes.length, 0)
})

test('the code list shows each code\'s scope with a name', async () => {
  const w = await world()
  await w.code(undefined)
  await w.code({ type: 'channel', id: w.b.id })
  await w.code({ type: 'room', id: w.a2.id })
  const list = (await srv.call('GET', `/api/servers/${w.s.id}/codes`, undefined, w.owner.token)).data.codes
  const scopes = list.map((c) => c.scope && `${c.scope.type}:${c.scope.name}`).sort((x, y) => String(x).localeCompare(String(y)))
  assert.deepEqual(scopes, ['channel:b', null, 'room:a / a2'])
})

test('deleting the room ends the invite: the guest is dropped and the code dies', async () => {
  const w = await world()
  const c = (await w.code({ type: 'room', id: w.a1.id })).data
  const g = await joinGuest(c.code, 'Doomed')
  await checkIn(g, 'room', w.a1.id)
  await voice(g, 'room', w.a1.id)
  fake.reset()
  const del = await srv.call('DELETE', `/api/servers/${w.s.id}/channels/${w.a.id}/rooms/${w.a1.id}`, undefined, w.owner.token)
  assert.equal(del.status, 200)
  assert.ok(fake.removals().some((r) => r.identity === g.identity), 'LiveKit was never told to drop the guest')
  assert.equal((await srv.call('POST', '/api/join', { code: c.code, screenName: 'Too Late' })).status, 404)
  const list = (await srv.call('GET', `/api/servers/${w.s.id}/codes`, undefined, w.owner.token)).data.codes
  assert.equal(list.some((x) => x.code === c.code), false)
  assert.equal((await srv.call('GET', `/api/servers/${w.s.id}/guests`, undefined, w.owner.token)).data.guests.length, 0)
})

test('deleting a channel ends its channel code and its rooms\' codes, and leaves others alone', async () => {
  const w = await world()
  const chanCode = (await w.code({ type: 'channel', id: w.a.id })).data
  const roomCode = (await w.code({ type: 'room', id: w.a2.id })).data
  const keep = (await w.code({ type: 'room', id: w.b1.id })).data
  const wide = (await w.code(undefined)).data
  const del = await srv.call('DELETE', `/api/servers/${w.s.id}/channels/${w.a.id}`, undefined, w.owner.token)
  assert.equal(del.status, 200)
  for (const dead of [chanCode, roomCode]) {
    assert.equal((await srv.call('POST', '/api/join', { code: dead.code, screenName: 'Nope' + dead.code.slice(0, 3) })).status, 404)
  }
  assert.equal((await srv.call('POST', '/api/join', { code: keep.code, screenName: 'Still Fine' })).status, 200)
  assert.equal((await srv.call('POST', '/api/join', { code: wide.code, screenName: 'Wide Fine' })).status, 200)
})
