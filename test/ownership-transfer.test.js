// Handing a server to another member, and deleting a server: both are the owner's alone and
// need their password. Real server, stand-in LiveKit.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { startServer, newAccount } from './helpers.js'
import { startFakeLiveKit } from './fake-livekit.js'

let fake
let srv
const PASSWORD = 'password123'

before(async () => {
  fake = await startFakeLiveKit()
  srv = await startServer({ env: { LIVEKIT_URL: fake.url, ACCOUNT_LIMIT: '1000' } })
})
after(async () => {
  await srv.stop()
  await fake.stop()
})

// An owner with a server (one voice channel) and two other members.
async function world(server = srv) {
  const owner = await newAccount(server)
  const s = (await server.call('POST', '/api/servers', { name: 'Handover' }, owner.token)).data
  const channel = (await server.call('POST', `/api/servers/${s.id}/channels`, { name: 'main', mode: 'both' }, owner.token)).data
  const code = (await server.call('POST', `/api/servers/${s.id}/codes`, { singleUse: false, expiresInMinutes: null }, owner.token)).data
  const join = async () => {
    const a = await newAccount(server)
    assert.equal((await server.call('POST', '/api/servers/join', { code: code.code }, a.token)).status, 200)
    return a
  }
  return { owner, s, channel, code, join, a: await join(), b: await join() }
}
const transfer = (w, who, accountId, password = PASSWORD, server = srv) =>
  server.call('POST', `/api/servers/${w.s.id}/transfer`, { accountId, password }, who.token)
const members = async (w, token) => (await srv.call('GET', `/api/servers/${w.s.id}/members`, undefined, token)).data.members
const del = (w, who, password = PASSWORD) => srv.call('DELETE', `/api/servers/${w.s.id}`, { password }, who.token)

test('a new server has its creator as owner, and everyone is told who is', async () => {
  const w = await world()
  const mine = await srv.call('GET', `/api/servers/${w.s.id}`, undefined, w.owner.token)
  assert.equal(mine.data.isOwner, true)
  assert.equal((await srv.call('GET', `/api/servers/${w.s.id}`, undefined, w.a.token)).data.isOwner, false)
  const list = (await srv.call('GET', '/api/servers', undefined, w.owner.token)).data.servers.find((x) => x.id === w.s.id)
  assert.equal(list.isOwner, true)
  assert.equal((await srv.call('GET', '/api/servers', undefined, w.a.token)).data.servers[0].isOwner, false)
  const ms = await members(w, w.a.token)
  assert.deepEqual(ms.filter((m) => m.isOwner).map((m) => m.accountId), [w.owner.id])
})

test('the owner hands the server to any member: it flips at once, the old owner stays an admin', async () => {
  const w = await world()
  const r = await transfer(w, w.owner, w.a.id)
  assert.equal(r.status, 200, JSON.stringify(r.data))
  assert.equal(r.data.ownerId, w.a.id)
  const ms = await members(w, w.owner.token)
  assert.deepEqual(ms.filter((m) => m.isOwner).map((m) => m.accountId), [w.a.id])
  assert.equal(ms.find((m) => m.accountId === w.owner.id).isAdmin, true) // the old owner is an admin
  assert.equal(ms.find((m) => m.accountId === w.a.id).isAdmin, true) // and the new owner is too
  assert.equal((await srv.call('GET', `/api/servers/${w.s.id}`, undefined, w.owner.token)).data.isOwner, false)
  assert.equal((await srv.call('GET', `/api/servers/${w.s.id}`, undefined, w.a.token)).data.isOwner, true)
  // the old owner is still a member and can still do admin things
  assert.equal((await srv.call('GET', `/api/servers/${w.s.id}/codes`, undefined, w.owner.token)).status, 200)
})

test('the new owner can transfer again and delete the server; the old owner can do neither', async () => {
  const w = await world()
  await transfer(w, w.owner, w.a.id)
  assert.equal((await transfer(w, w.owner, w.b.id)).status, 403) // no longer theirs to hand on
  assert.equal((await del(w, w.owner)).status, 403)
  assert.equal((await srv.call('GET', `/api/servers/${w.s.id}`, undefined, w.owner.token)).status, 200) // still there
  assert.equal((await transfer(w, w.a, w.b.id)).status, 200) // the new owner hands it on
  assert.equal((await transfer(w, w.b, w.owner.id)).status, 200) // and it can go back to the first
  assert.equal((await del(w, w.owner)).status, 200)
  assert.equal((await srv.call('GET', `/api/servers/${w.s.id}`, undefined, w.owner.token)).status, 403)
})

test('only the owner can start a transfer: not an admin who is not the owner, a member or a guest', async () => {
  const w = await world()
  await transfer(w, w.owner, w.a.id) // a is owner; the original owner is now just an admin
  for (const who of [w.owner, w.b]) {
    const r = await transfer(w, who, w.b.id)
    assert.equal(r.status, 403, JSON.stringify(r.data))
    assert.match(r.data.error, /owner/)
  }
  const guest = (await srv.call('POST', '/api/join', { code: w.code.code, screenName: 'Passing Through' })).data
  assert.equal((await srv.call('POST', `/api/servers/${w.s.id}/transfer`, { accountId: w.b.id, password: PASSWORD }, guest.guestToken)).status, 401)
  assert.equal((await srv.call('POST', `/api/servers/${w.s.id}/transfer`, { accountId: w.b.id, password: PASSWORD })).status, 401)
  const outsider = await newAccount(srv)
  assert.equal((await transfer(w, outsider, w.b.id)).status, 403)
  // nothing above moved it
  assert.deepEqual((await members(w, w.a.token)).filter((m) => m.isOwner).map((m) => m.accountId), [w.a.id])
})

test('a transfer needs the right password and a sensible target', async () => {
  const w = await world()
  const outsider = await newAccount(srv)
  assert.equal((await transfer(w, w.owner, w.a.id, 'wrong-wrong')).status, 401)
  assert.equal((await srv.call('POST', `/api/servers/${w.s.id}/transfer`, { accountId: w.a.id }, w.owner.token)).status, 400)
  assert.equal((await transfer(w, w.owner, w.owner.id)).status, 400) // yourself
  assert.equal((await transfer(w, w.owner, outsider.id)).status, 404) // not a member
  assert.equal((await transfer(w, w.owner, 99999999)).status, 404)
  for (const bad of [undefined, null, 'abc', 0, -3, 1.5, { id: 1 }]) {
    assert.equal((await srv.call('POST', `/api/servers/${w.s.id}/transfer`, { accountId: bad, password: PASSWORD }, w.owner.token)).status, 400, String(bad))
  }
  // a banned person is no longer a member, so they can't be handed it
  await srv.call('POST', `/api/servers/${w.s.id}/members/${w.b.id}/ban`, {}, w.owner.token)
  assert.equal((await transfer(w, w.owner, w.b.id)).status, 404)
  assert.deepEqual((await members(w, w.owner.token)).filter((m) => m.isOwner).map((m) => m.accountId), [w.owner.id])
})

test('handing it to a member with an access timer or a mute clears both, so an owner never expires', async () => {
  const w = await world()
  await srv.call('PATCH', `/api/servers/${w.s.id}/members/${w.a.id}`, { muted: true, accessExpiresInMinutes: 60 }, w.owner.token)
  const before = (await members(w, w.owner.token)).find((m) => m.accountId === w.a.id)
  assert.equal(before.muted, true)
  assert.ok(before.accessExpiresAt)
  await transfer(w, w.owner, w.a.id)
  const after = (await members(w, w.owner.token)).find((m) => m.accountId === w.a.id)
  assert.equal(after.muted, false)
  assert.equal(after.accessExpiresAt, null)
  assert.equal(after.isOwner, true)
})

test('after a transfer the new owner is protected from kick, ban and mute like an owner', async () => {
  const w = await world()
  await transfer(w, w.owner, w.a.id)
  // the old owner is now an ordinary admin and can't kick the new owner
  const kick = await srv.call('POST', `/api/servers/${w.s.id}/members/${w.a.id}/kick`, {}, w.owner.token)
  assert.equal(kick.status, 403)
  assert.equal((await srv.call('POST', `/api/servers/${w.s.id}/members/${w.a.id}/ban`, {}, w.owner.token)).status, 403)
  // and the new owner can't be kicked by a member either
  assert.equal((await srv.call('POST', `/api/servers/${w.s.id}/members/${w.a.id}/kick`, {}, w.b.token)).status, 403)
})

test('deleting a server needs the owner and their password; an admin who is not the owner is refused', async () => {
  const w = await world()
  assert.equal((await srv.call('DELETE', `/api/servers/${w.s.id}`, undefined, w.owner.token)).status, 400) // no password
  assert.equal((await del(w, w.owner, 'wrong-wrong')).status, 401)
  assert.equal((await del(w, w.a)).status, 403) // a member
  await transfer(w, w.owner, w.a.id)
  const old = await del(w, w.owner) // an admin, but not the owner
  assert.equal(old.status, 403)
  assert.match(old.data.error, /owner/)
  assert.equal((await srv.call('GET', `/api/servers/${w.s.id}`, undefined, w.a.token)).status, 200)
  assert.equal((await del(w, w.a)).status, 200)
  assert.equal((await srv.call('GET', `/api/servers/${w.s.id}`, undefined, w.a.token)).status, 403)
  assert.equal((await srv.call('GET', `/api/servers/${w.s.id}`, undefined, w.owner.token)).status, 403)
})

test('deleting a server removes its voice rooms and guests as before', async () => {
  const w = await world()
  const guest = (await srv.call('POST', '/api/join', { code: w.code.code, screenName: 'Last Guest' })).data
  await srv.call('POST', '/api/presence', { type: 'channel', id: w.channel.id }, guest.guestToken)
  fake.reset()
  assert.equal((await del(w, w.owner)).status, 200)
  assert.equal((await srv.call('POST', '/api/presence', { type: 'channel', id: w.channel.id }, guest.guestToken)).status, 404)
})

test('both are rate limited like the other password routes', async () => {
  const limited = await startServer({ env: { LIVEKIT_URL: fake.url, ACCOUNT_LIMIT: '4' } })
  try {
    const w = await world(limited)
    const statuses = []
    for (let i = 0; i < 6; i++) statuses.push((await transfer(w, w.owner, w.a.id, 'wrong-wrong', limited)).status)
    assert.deepEqual(statuses, [401, 401, 401, 401, 429, 429])
  } finally {
    await limited.stop()
  }
})
