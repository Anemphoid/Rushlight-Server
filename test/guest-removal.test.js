// Phase 1.6: a used single-use code stays listed while its guest is here, and an
// admin can remove one guest without revoking the code. Real server, stand-in LiveKit.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { startServer, newAccount, jwtClaims } from './helpers.js'
import { startFakeLiveKit } from './fake-livekit.js'

let fake
let srv

before(async () => {
  fake = await startFakeLiveKit()
  srv = await startServer({ env: { LIVEKIT_URL: fake.url } })
})
after(async () => {
  await srv.stop()
  await fake.stop()
})

async function world() {
  const owner = await newAccount(srv)
  const s = (await srv.call('POST', '/api/servers', { name: 'Removal' }, owner.token)).data
  const a = (await srv.call('POST', `/api/servers/${s.id}/channels`, { name: 'a', mode: 'both' }, owner.token)).data
  const code = async (singleUse) =>
    (await srv.call('POST', `/api/servers/${s.id}/codes`, { singleUse, expiresInMinutes: null }, owner.token)).data
  return { owner, s, a, code }
}
async function guestWith(code, name) {
  const r = await srv.call('POST', '/api/join', { code: code.code, screenName: name })
  assert.equal(r.status, 200, JSON.stringify(r.data))
  return { token: r.data.guestToken, identity: jwtClaims(r.data.guestToken).identity }
}
const codes = async (w) => (await srv.call('GET', `/api/servers/${w.s.id}/codes`, undefined, w.owner.token)).data.codes
const guests = async (w) => (await srv.call('GET', `/api/servers/${w.s.id}/guests`, undefined, w.owner.token)).data.guests
const checkIn = (w, who) => srv.call('POST', '/api/presence', { type: 'channel', id: w.a.id }, who.token)

test('a used single-use code stays listed, marked used, while its guest is here', async () => {
  const w = await world()
  const c = await w.code(true)
  assert.equal((await codes(w))[0].used, false)
  const g = await guestWith(c, 'Single Use')
  const row = (await codes(w)).find((x) => x.code === c.code)
  assert.ok(row, 'the used code vanished while its guest is still in')
  assert.equal(row.used, true)
  assert.equal(row.singleUse, true)
  assert.equal(row.guestsNow, 1)

  // revoking it drops the guest from presence and voice, and the code is gone
  await checkIn(w, g)
  fake.reset()
  assert.equal((await srv.call('DELETE', `/api/servers/${w.s.id}/codes/${row.id}`, undefined, w.owner.token)).status, 200)
  assert.ok(fake.removals().some((r) => r.identity === g.identity))
  assert.equal((await codes(w)).some((x) => x.code === c.code), false)
  assert.deepEqual((await srv.call('GET', `/api/servers/${w.s.id}`, undefined, w.owner.token)).data.presence, {})
})

test('a used single-use code with no guest left in is not listed', async () => {
  const w = await world()
  const c = await w.code(true)
  const g = await guestWith(c, 'Gone Soon')
  await srv.call('DELETE', `/api/servers/${w.s.id}/guests/${encodeURIComponent(g.identity)}`, undefined, w.owner.token)
  assert.equal((await codes(w)).some((x) => x.code === c.code), false)
})

test('an unused code and a reusable code list as before, with used false', async () => {
  const w = await world()
  const single = await w.code(true)
  const reusable = await w.code(false)
  await guestWith(reusable, 'Reuser')
  const list = await codes(w)
  assert.equal(list.find((x) => x.code === single.code).used, false)
  assert.equal(list.find((x) => x.code === reusable.code).used, false)
  assert.equal(list.find((x) => x.code === reusable.code).guestsNow, 1)
})

test('removing one guest leaves the other guest of the same code in place', async () => {
  const w = await world()
  const c = await w.code(false)
  const keep = await guestWith(c, 'Stays')
  const go = await guestWith(c, 'Goes')
  await checkIn(w, keep)
  await checkIn(w, go)
  fake.reset()
  const r = await srv.call('DELETE', `/api/servers/${w.s.id}/guests/${encodeURIComponent(go.identity)}`, undefined, w.owner.token)
  assert.equal(r.status, 200)
  const removal = fake.removals().find((x) => x.identity === go.identity)
  assert.ok(removal, 'LiveKit was never told to drop the guest')
  assert.equal(fake.removals().some((x) => x.identity === keep.identity), false)
  assert.deepEqual((await guests(w)).map((x) => x.name), ['Stays'])
  const here = (await srv.call('GET', `/api/servers/${w.s.id}`, undefined, w.owner.token)).data.presence[`channel:${w.a.id}`]
  assert.deepEqual(here.map((p) => p.name), ['Stays'])
  // the code is still good for new guests and for the one who stayed
  assert.equal((await checkIn(w, keep)).status, 200)
  assert.equal((await srv.call('POST', '/api/join', { code: c.code, screenName: 'Newcomer' })).status, 200)
})

test('LiveKit is told before presence is cleared', async () => {
  const w = await world()
  const g = await guestWith(await w.code(false), 'Ordered')
  await checkIn(w, g)
  fake.reset()
  fake.onCall(async (call) => {
    if (call.method !== 'RemoveParticipant' || call.body.identity !== g.identity) return null
    const here = ((await srv.call('GET', `/api/servers/${w.s.id}`, undefined, w.owner.token)).data.presence[`channel:${w.a.id}`] || [])
    return { stillPresent: here.some((p) => p.id === g.identity) }
  })
  try {
    await srv.call('DELETE', `/api/servers/${w.s.id}/guests/${encodeURIComponent(g.identity)}`, undefined, w.owner.token)
  } finally {
    fake.onCall(null)
  }
  assert.equal(fake.removals().find((x) => x.identity === g.identity).seen.stillPresent, true)
})

test('a removed guest cannot slip back in with the token they hold', async () => {
  const w = await world()
  const g = await guestWith(await w.code(false), 'Persistent')
  await checkIn(w, g)
  await srv.call('DELETE', `/api/servers/${w.s.id}/guests/${encodeURIComponent(g.identity)}`, undefined, w.owner.token)
  const again = await checkIn(w, g)
  assert.equal(again.status, 403)
  assert.match(again.data.error, /removed/)
  assert.equal((await srv.call('POST', '/api/voice/token', { type: 'channel', id: w.a.id }, g.token)).status, 403)
  assert.deepEqual(await guests(w), [])
})

test('only an admin of that server can remove a guest, and unknown or foreign identities are refused', async () => {
  const w = await world()
  const other = await world()
  const g = await guestWith(await w.code(false), 'Protected')
  const path = `/api/servers/${w.s.id}/guests/${encodeURIComponent(g.identity)}`
  const member = await newAccount(srv)
  await srv.call('POST', '/api/servers/join', { code: (await w.code(false)).code }, member.token)
  assert.equal((await srv.call('DELETE', path, undefined, member.token)).status, 403)
  assert.equal((await srv.call('DELETE', path, undefined, g.token)).status, 401)
  assert.equal((await srv.call('DELETE', path, undefined, other.owner.token)).status, 403)
  // the other server's admin cannot reach this guest by using their own server id
  assert.equal((await srv.call('DELETE', `/api/servers/${other.s.id}/guests/${encodeURIComponent(g.identity)}`, undefined, other.owner.token)).status, 404)
  assert.equal((await srv.call('DELETE', `/api/servers/${w.s.id}/guests/guest-nobody`, undefined, w.owner.token)).status, 404)
  assert.equal((await guests(w)).length, 1) // nothing above removed them
  assert.equal((await srv.call('DELETE', path, undefined, w.owner.token)).status, 200)
  assert.equal((await srv.call('DELETE', path, undefined, w.owner.token)).status, 404) // already gone
})

test('presence leave clears an account and a guest at once', async () => {
  const w = await world()
  const g = await guestWith(await w.code(false), 'Quick Leaver')
  await checkIn(w, g)
  await srv.call('POST', '/api/presence', { type: 'channel', id: w.a.id }, w.owner.token)
  const here = async () => (await srv.call('GET', `/api/servers/${w.s.id}`, undefined, w.owner.token)).data.presence[`channel:${w.a.id}`] || []
  assert.equal((await here()).length, 2)
  await srv.call('POST', '/api/presence/leave', {}, g.token)
  assert.equal((await here()).length, 1)
  await srv.call('POST', '/api/presence/leave', {}, w.owner.token)
  assert.equal((await here()).length, 0)
})
