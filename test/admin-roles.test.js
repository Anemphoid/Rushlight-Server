// Making and removing admins (owner only), and the reasons a client uses to tell why a
// request failed: the session ended, or the server was deleted. Real server.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import jwt from 'jsonwebtoken'
import { startServer, newAccount } from './helpers.js'

let srv
const PASSWORD = 'password123'
before(async () => {
  srv = await startServer({ env: { ACCOUNT_LIMIT: '1000', RECOVER_LIMIT: '1000' } })
})
after(async () => {
  await srv.stop()
})

async function world() {
  const owner = await newAccount(srv)
  const s = (await srv.call('POST', '/api/servers', { name: 'Roles' }, owner.token)).data
  const code = (await srv.call('POST', `/api/servers/${s.id}/codes`, { singleUse: false, expiresInMinutes: null }, owner.token)).data
  const join = async () => {
    const a = await newAccount(srv)
    assert.equal((await srv.call('POST', '/api/servers/join', { code: code.code }, a.token)).status, 200)
    return a
  }
  return { owner, s, code, a: await join(), b: await join(), join }
}
const setAdmin = (w, who, targetId, admin) =>
  srv.call('POST', `/api/servers/${w.s.id}/members/${targetId}/admin`, { admin }, who.token)
const member = async (w, token, id) =>
  (await srv.call('GET', `/api/servers/${w.s.id}/members`, undefined, token)).data.members.find((m) => m.accountId === id)

test('the owner makes a member an admin and takes it away again', async () => {
  const w = await world()
  assert.equal((await srv.call('GET', `/api/servers/${w.s.id}`, undefined, w.a.token)).data.isAdmin, false)
  const r = await setAdmin(w, w.owner, w.a.id, true)
  assert.equal(r.status, 200, JSON.stringify(r.data))
  assert.equal(r.data.member.isAdmin, true)
  assert.equal(r.data.member.isOwner, false)
  // the new admin is told at once, on their next look at the server
  const seen = (await srv.call('GET', `/api/servers/${w.s.id}`, undefined, w.a.token)).data
  assert.equal(seen.isAdmin, true)
  assert.equal(seen.isOwner, false)
  assert.equal((await srv.call('GET', `/api/servers/${w.s.id}/codes`, undefined, w.a.token)).status, 200) // admin things now work
  assert.equal((await member(w, w.owner.token, w.a.id)).isAdmin, true)

  const back = await setAdmin(w, w.owner, w.a.id, false)
  assert.equal(back.status, 200)
  assert.equal(back.data.member.isAdmin, false)
  assert.equal((await srv.call('GET', `/api/servers/${w.s.id}`, undefined, w.a.token)).data.isAdmin, false)
  assert.equal((await srv.call('GET', `/api/servers/${w.s.id}/codes`, undefined, w.a.token)).status, 403) // and stop working
  // still a member
  assert.equal((await srv.call('GET', `/api/servers/${w.s.id}`, undefined, w.a.token)).status, 200)
  assert.equal((await member(w, w.owner.token, w.a.id)).isAdmin, false)
})

test('only the owner can make or remove admins: not an admin, a member or a guest', async () => {
  const w = await world()
  await setAdmin(w, w.owner, w.a.id, true)
  for (const who of [w.a, w.b]) {
    const r = await setAdmin(w, who, w.b.id, true)
    assert.equal(r.status, 403, JSON.stringify(r.data))
    assert.match(r.data.error, /owner/)
    assert.equal((await setAdmin(w, who, w.a.id, false)).status, 403)
  }
  const guest = (await srv.call('POST', '/api/join', { code: w.code.code, screenName: 'Visiting' })).data
  assert.equal((await srv.call('POST', `/api/servers/${w.s.id}/members/${w.b.id}/admin`, { admin: true }, guest.guestToken)).status, 401)
  assert.equal((await srv.call('POST', `/api/servers/${w.s.id}/members/${w.b.id}/admin`, { admin: true })).status, 401)
  assert.equal((await member(w, w.owner.token, w.b.id)).isAdmin, false) // nothing above changed it
  assert.equal((await member(w, w.owner.token, w.a.id)).isAdmin, true)
})

test('a guest cannot be made an admin, and neither can a stranger or the owner be demoted', async () => {
  const w = await world()
  const guest = (await srv.call('POST', '/api/join', { code: w.code.code, screenName: 'Code Guest' })).data
  const identity = JSON.parse(Buffer.from(guest.guestToken.split('.')[1], 'base64url').toString()).identity
  const asGuest = await srv.call('POST', `/api/servers/${w.s.id}/members/${identity}/admin`, { admin: true }, w.owner.token)
  assert.equal(asGuest.status, 400)
  assert.match(asGuest.data.error, /account/)
  const outsider = await newAccount(srv)
  assert.equal((await setAdmin(w, w.owner, outsider.id, true)).status, 404) // not a member
  assert.equal((await setAdmin(w, w.owner, 99999999, true)).status, 404)
  const owner = await setAdmin(w, w.owner, w.owner.id, false)
  assert.equal(owner.status, 400)
  assert.match(owner.data.error, /owner/)
  assert.equal((await srv.call('GET', `/api/servers/${w.s.id}`, undefined, w.owner.token)).data.isAdmin, true)
  for (const bad of [undefined, null, 'yes', 1]) {
    assert.equal((await srv.call('POST', `/api/servers/${w.s.id}/members/${w.a.id}/admin`, { admin: bad }, w.owner.token)).status, 400, String(bad))
  }
})

test('becoming an admin clears a mute and an access timer, and a banned person is not a member', async () => {
  const w = await world()
  await srv.call('PATCH', `/api/servers/${w.s.id}/members/${w.a.id}`, { muted: true, accessExpiresInMinutes: 60 }, w.owner.token)
  const before = await member(w, w.owner.token, w.a.id)
  assert.equal(before.muted, true)
  assert.ok(before.accessExpiresAt)
  await setAdmin(w, w.owner, w.a.id, true)
  const after = await member(w, w.owner.token, w.a.id)
  assert.equal(after.muted, false)
  assert.equal(after.accessExpiresAt, null)
  await srv.call('POST', `/api/servers/${w.s.id}/members/${w.b.id}/ban`, {}, w.owner.token)
  assert.equal((await setAdmin(w, w.owner, w.b.id, true)).status, 404)
})

test('an admin made by the owner can moderate, and an ex-admin can not', async () => {
  const w = await world()
  await setAdmin(w, w.owner, w.a.id, true)
  assert.equal((await srv.call('PATCH', `/api/servers/${w.s.id}/members/${w.b.id}`, { muted: true }, w.a.token)).status, 200)
  await setAdmin(w, w.owner, w.a.id, false)
  assert.equal((await srv.call('PATCH', `/api/servers/${w.s.id}/members/${w.b.id}`, { muted: false }, w.a.token)).status, 403)
  // an admin cannot kick another admin; the owner is protected from everyone
  await setAdmin(w, w.owner, w.a.id, true)
  const c = await w.join()
  await setAdmin(w, w.owner, c.id, true)
  assert.equal((await srv.call('POST', `/api/servers/${w.s.id}/members/${c.id}/kick`, {}, w.a.token)).status, 403)
  assert.equal((await srv.call('POST', `/api/servers/${w.s.id}/members/${w.owner.id}/kick`, {}, w.a.token)).status, 403)
})

test('a 401 says why the session is no good, so a client can send the person to sign-in', async () => {
  const a = await newAccount(srv)
  const other = await srv.call('POST', '/api/login', { username: JSON.parse(Buffer.from(a.token.split('.')[1], 'base64url').toString()).username, password: PASSWORD })
  // the password is changed from one window: the other one is told its session ended
  await srv.call('POST', '/api/me/password', { currentPassword: PASSWORD, newPassword: 'a-new-password-1' }, a.token)
  const ended = await srv.call('GET', '/api/me', undefined, other.data.token)
  assert.equal(ended.status, 401)
  assert.equal(ended.data.reason, 'session_ended')
  assert.match(ended.data.error, /password was changed/)
  // a token that was never good, and one for an account that does not exist
  const secret = 'test-secret-test-secret-test-secret-test'
  const ghost = jwt.sign({ sub: 987654, username: 'ghost', isAdmin: false, ep: 0 }, secret, { expiresIn: '30d' })
  assert.equal((await srv.call('GET', '/api/me', undefined, ghost)).data.reason, 'session_expired')
  assert.equal((await srv.call('GET', '/api/me', undefined, 'not-a-token')).data.reason, 'session_expired')
  const expired = jwt.sign({ sub: a.id, username: 'x', isAdmin: false, ep: 0 }, secret, { expiresIn: -10 })
  assert.equal((await srv.call('GET', '/api/me', undefined, expired)).data.reason, 'session_expired')
})

test('a 401 for a wrong password on a route that asks for one carries no reason', async () => {
  const a = await newAccount(srv)
  for (const [path, body] of [
    ['/api/me/password', { currentPassword: 'wrong-wrong', newPassword: 'whatever-password' }],
    ['/api/me/recovery-key', { password: 'wrong-wrong' }]
  ]) {
    const r = await srv.call('POST', path, body, a.token)
    assert.equal(r.status, 401, path)
    assert.equal(r.data.reason, undefined, path) // the session is fine; only the password was wrong
  }
  assert.equal((await srv.call('GET', '/api/me')).data.reason, undefined) // no token at all
})

test('people in a deleted server are told it was deleted, not that they were removed', async () => {
  const w = await world()
  const kicked = await w.join()
  await srv.call('POST', `/api/servers/${w.s.id}/members/${kicked.id}/kick`, {}, w.owner.token)
  const k = await srv.call('GET', `/api/servers/${w.s.id}`, undefined, kicked.token)
  assert.equal(k.status, 403)
  assert.equal(k.data.reason, 'removed') // kicks keep their wording
  assert.match(k.data.error, /removed/)

  assert.equal((await srv.call('DELETE', `/api/servers/${w.s.id}`, { password: PASSWORD }, w.owner.token)).status, 200)
  for (const who of [w.a, w.owner]) {
    const r = await srv.call('GET', `/api/servers/${w.s.id}`, undefined, who.token)
    assert.equal(r.status, 403)
    assert.equal(r.data.reason, 'deleted')
    assert.equal(r.data.error, 'This server was deleted.')
  }
  const guest = await srv.call('GET', `/api/servers/${w.s.id}/members`, undefined, w.b.token)
  assert.equal(guest.data.reason, 'deleted')
})
