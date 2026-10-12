// Deleting an account: password required, owners refused, everything tied to the account goes
// in one step, messages stay but are wiped and redacted, the username is freed. Real server,
// stand-in LiveKit.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import Database from 'better-sqlite3'
import { startServer, newAccount, jwtClaims } from './helpers.js'
import { startFakeLiveKit } from './fake-livekit.js'

let fake
let srv
const PASSWORD = 'password123'

before(async () => {
  fake = await startFakeLiveKit()
  srv = await startServer({ env: { LIVEKIT_URL: fake.url, ACCOUNT_LIMIT: '1000', PRESENCE_SWEEP_MS: '200' } })
})
after(async () => {
  await srv.stop()
  await fake.stop()
})

const del = (who, password = PASSWORD, server = srv) => server.call('DELETE', '/api/me', { password }, who.token)
const readDb = () => new Database(srv.dbPath, { readonly: true })

// An owner with a server that has a persistent channel (so its messages stay), plus members.
async function world() {
  const owner = await newAccount(srv)
  const s = (await srv.call('POST', '/api/servers', { name: 'Leaving' }, owner.token)).data
  const ch = (await srv.call('POST', `/api/servers/${s.id}/channels`, { name: 'main', mode: 'both', persistent: true }, owner.token)).data
  const code = (await srv.call('POST', `/api/servers/${s.id}/codes`, { singleUse: false, expiresInMinutes: null }, owner.token)).data
  const join = async () => {
    const a = await newAccount(srv)
    assert.equal((await srv.call('POST', '/api/servers/join', { code: code.code }, a.token)).status, 200)
    return a
  }
  return { owner, s, ch, code, join }
}
const say = (w, who, text) => srv.call('POST', `/api/channels/${w.ch.id}/messages`, { text }, who.token)
const messages = async (w, token) => (await srv.call('GET', `/api/channels/${w.ch.id}/messages`, undefined, token)).data.messages
const name = async (a) => (await srv.call('GET', '/api/me', undefined, a.token)).data.username

test('deleting needs the password: not a missing one, a wrong one, a guest or a stranger', async () => {
  const w = await world()
  const a = await w.join()
  assert.equal((await srv.call('DELETE', '/api/me', {}, a.token)).status, 400)
  assert.equal((await del(a, 'wrong-wrong')).status, 401)
  const guest = (await srv.call('POST', '/api/join', { code: w.code.code, screenName: 'Just Looking' })).data
  assert.equal((await srv.call('DELETE', '/api/me', { password: PASSWORD }, guest.guestToken)).status, 401)
  assert.equal((await srv.call('DELETE', '/api/me', { password: PASSWORD })).status, 401)
  assert.equal((await srv.call('GET', '/api/me', undefined, a.token)).status, 200) // nothing above deleted it
})

test('an owner is refused, with the servers named, until they hand each one over or delete it', async () => {
  const w = await world()
  const second = (await srv.call('POST', '/api/servers', { name: 'Second Place' }, w.owner.token)).data
  const friend = await w.join()
  const r = await del(w.owner)
  assert.equal(r.status, 409, JSON.stringify(r.data))
  assert.equal(r.data.reason, 'owns_servers')
  assert.deepEqual(r.data.servers.map((s) => s.name), ['Leaving', 'Second Place'])
  assert.match(r.data.error, /Leaving, Second Place/)
  assert.equal((await srv.call('POST', '/api/login', { username: await name(w.owner), password: PASSWORD })).status, 200) // still there

  await srv.call('POST', `/api/servers/${w.s.id}/transfer`, { accountId: friend.id, password: PASSWORD }, w.owner.token)
  const still = await del(w.owner)
  assert.equal(still.status, 409)
  assert.deepEqual(still.data.servers.map((s) => s.name), ['Second Place'])
  assert.equal((await srv.call('DELETE', `/api/servers/${second.id}`, { password: PASSWORD }, w.owner.token)).status, 200)
  assert.equal((await del(w.owner)).status, 200)
  // the server they handed over is fine, owned by the friend
  assert.equal((await srv.call('GET', `/api/servers/${w.s.id}`, undefined, friend.token)).data.isOwner, true)
})

test('after deleting, the account is gone: no login, a clear message for any open window, and the name is free', async () => {
  const w = await world()
  const a = await w.join()
  const username = await name(a)
  assert.equal((await del(a)).status, 200)
  assert.equal((await srv.call('POST', '/api/login', { username, password: PASSWORD })).status, 401)
  const old = await srv.call('GET', '/api/me', undefined, a.token)
  assert.equal(old.status, 401)
  assert.equal(old.data.reason, 'session_expired')
  assert.match(old.data.error, /no longer exists/)
  assert.equal((await srv.call('POST', '/api/recover', { username, key: 'abandon '.repeat(12), newPassword: 'whatever-password' })).status, 401)
  // the name can be taken again, in any capitalization, by a new account with its own id
  const again = await srv.call('POST', '/api/register', { username: username.toUpperCase(), password: PASSWORD })
  assert.equal(again.status, 200, JSON.stringify(again.data))
  assert.notEqual(again.data.id, a.id)
  assert.equal(await name(again.data), username.toUpperCase())
  // and it does not inherit the old account's memberships
  assert.deepEqual((await srv.call('GET', '/api/servers', undefined, again.data.token)).data.servers, [])
})

test('messages stay in place but the text, name and avatar colour are wiped from the database', async () => {
  const w = await world()
  const a = await w.join()
  const b = await w.join()
  await say(w, a, 'a secret that should go')
  await say(w, b, 'this one stays')
  await say(w, a, 'and another of mine')
  await say(w, b, 'still here')
  const before = await messages(w, b.token)
  assert.deepEqual(before.map((m) => m.text), ['a secret that should go', 'this one stays', 'and another of mine', 'still here'])
  const aName = before[0].author

  assert.equal((await del(a)).status, 200)

  // the API: order and count unchanged, nothing identifying in the redacted ones
  const after = await messages(w, b.token)
  assert.equal(after.length, 4)
  assert.deepEqual(after.map((m) => m.id), before.map((m) => m.id))
  for (const i of [0, 2]) {
    assert.equal(after[i].redacted, true)
    assert.equal(after[i].text, '')
    assert.equal(after[i].author, null)
    assert.equal(after[i].authorId, null)
    assert.equal(after[i].avatarColor, null)
    assert.equal(after[i].avatarUpdatedAt, null)
    assert.equal(after[i].createdAt, before[i].createdAt)
  }
  assert.deepEqual(after.filter((m) => !m.redacted).map((m) => [m.author, m.text]), [[before[1].author, 'this one stays'], [before[3].author, 'still here']])
  assert.ok(!JSON.stringify(after).includes('secret'))
  assert.ok(!JSON.stringify(after).includes(aName))

  // the database itself: gone, not just hidden
  const db = readDb()
  const rows = db.prepare('SELECT id, text, author_name, author_avatar_color, author_account_id, redacted FROM messages WHERE id IN (?, ?)').all(before[0].id, before[2].id)
  db.close()
  assert.equal(rows.length, 2)
  for (const r of rows) assert.deepEqual(r, { id: r.id, text: '', author_name: '', author_avatar_color: null, author_account_id: null, redacted: 1 })
})

test('memberships, bans, access notes and codes tied to the account are cleaned up, and nothing dangles', async () => {
  const w = await world()
  const admin = await w.join()
  await srv.call('POST', `/api/servers/${w.s.id}/members/${admin.id}/admin`, { admin: true }, w.owner.token)
  const victim = await w.join()
  const banned = await w.join()
  const kicked = await w.join()
  // the admin makes a code, bans someone and kicks someone
  const adminCode = (await srv.call('POST', `/api/servers/${w.s.id}/codes`, { singleUse: false, expiresInMinutes: null }, admin.token)).data
  assert.equal((await srv.call('POST', `/api/servers/${w.s.id}/members/${banned.id}/ban`, {}, admin.token)).status, 200)
  assert.equal((await srv.call('POST', `/api/servers/${w.s.id}/members/${kicked.id}/kick`, {}, admin.token)).status, 200)
  // someone else is banned, and then deleted
  assert.equal((await srv.call('POST', `/api/servers/${w.s.id}/members/${victim.id}/ban`, {}, w.owner.token)).status, 200)

  assert.equal((await del(admin)).status, 200)
  assert.equal((await del(victim)).status, 200)
  assert.equal((await del(kicked)).status, 200)

  const members = (await srv.call('GET', `/api/servers/${w.s.id}/members`, undefined, w.owner.token)).data.members.map((m) => m.accountId)
  assert.ok(!members.includes(admin.id) && !members.includes(kicked.id))
  const bans = (await srv.call('GET', `/api/servers/${w.s.id}/bans`, undefined, w.owner.token)).data.bans.map((b) => b.accountId)
  assert.deepEqual(bans, [banned.id]) // the deleted person's own ban is gone; the one the admin made stays
  // the admin's code still works, and the ban they made still holds
  const newcomer = await newAccount(srv)
  assert.equal((await srv.call('POST', '/api/servers/join', { code: adminCode.code }, newcomer.token)).status, 200)
  assert.equal((await srv.call('POST', '/api/servers/join', { code: adminCode.code }, banned.token)).status, 403)

  const db = readDb()
  assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), [])
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM access_ends WHERE account_id IN (?, ?, ?)').get(admin.id, victim.id, kicked.id).n, 0)
  assert.equal(db.prepare('SELECT created_by FROM join_codes WHERE code = ?').get(adminCode.code).created_by, null)
  assert.equal(db.prepare('SELECT banned_by FROM server_bans WHERE account_id = ?').get(banned.id).banned_by, null)
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM accounts WHERE id IN (?, ?, ?)').get(admin.id, victim.id, kicked.id).n, 0)
  db.close()
})

test("the avatar goes with the account, and the account's rooms and presence are cleared", async () => {
  const w = await world()
  const a = await w.join()
  // a tiny valid PNG as the avatar
  const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=='
  assert.equal((await srv.call('POST', '/api/me/avatar', { image: png, mime: 'image/png' }, a.token)).status, 200)
  assert.equal((await fetch(`${srv.url}/api/avatars/${a.id}`)).status, 200)
  await srv.call('POST', '/api/presence', { type: 'channel', id: w.ch.id }, a.token)
  fake.reset()
  assert.equal((await del(a)).status, 200)
  assert.equal((await fetch(`${srv.url}/api/avatars/${a.id}`)).status, 404)
  assert.ok(fake.removals().some((r) => r.identity === `acct-${a.id}`), 'LiveKit was never told to drop them')
  const here = (await srv.call('GET', `/api/servers/${w.s.id}`, undefined, w.owner.token)).data.presence
  assert.deepEqual(Object.values(here).flat().filter((p) => p.id === a.id), [])
})

test('a vote someone was part of is settled without them, and one they started is cancelled', async () => {
  const w = await world()
  // an ephemeral room, so there is something to vote on
  const room = (await srv.call('POST', `/api/servers/${w.s.id}/channels`, { name: 'temp', mode: 'text', persistent: false }, w.owner.token)).data
  const [a, b, c] = [await w.join(), await w.join(), await w.join()]
  for (const who of [a, b, c]) await srv.call('POST', `/api/channels/${room.id}/messages`, { text: 'hello' }, who.token)
  await srv.call('POST', `/api/servers/${w.s.id}/members/${c.id}/admin`, { admin: true }, w.owner.token) // only admins start a vote
  const start = await srv.call('POST', `/api/servers/${w.s.id}/channels/${room.id}/persist-vote`, {}, c.token)
  assert.equal(start.status, 200, JSON.stringify(start.data))
  const view = async (token) => (await srv.call('GET', `/api/servers/${w.s.id}`, undefined, token)).data.proposals.find((p) => p.spaceId === room.id)
  assert.equal((await view(c.token)).status, 'open')
  await srv.call('POST', `/api/proposals/${start.data.proposal.id}/vote`, { vote: 'decline' }, b.token)
  assert.equal((await view(c.token)).status, 'open') // a still has to answer
  assert.equal((await del(a)).status, 200)
  assert.equal((await view(c.token)).status, 'failed') // without a: one yes, one no

  // a vote the deleted account started is cancelled
  const room2 = (await srv.call('POST', `/api/servers/${w.s.id}/channels`, { name: 'temp2', mode: 'text', persistent: false }, w.owner.token)).data
  const [d, e] = [await w.join(), await w.join()]
  for (const who of [d, e]) await srv.call('POST', `/api/channels/${room2.id}/messages`, { text: 'hi' }, who.token)
  await srv.call('POST', `/api/servers/${w.s.id}/members/${d.id}/admin`, { admin: true }, w.owner.token)
  assert.equal((await srv.call('POST', `/api/servers/${w.s.id}/channels/${room2.id}/persist-vote`, {}, d.token)).status, 200)
  assert.equal((await del(d)).status, 200)
  const p2 = (await srv.call('GET', `/api/servers/${w.s.id}`, undefined, e.token)).data.proposals.find((p) => p.spaceId === room2.id)
  assert.ok(!p2 || p2.status === 'cancelled', JSON.stringify(p2))
})

test('deleting is rate limited like the other password routes', async () => {
  const limited = await startServer({ env: { LIVEKIT_URL: fake.url, ACCOUNT_LIMIT: '3' } })
  try {
    const a = await newAccount(limited)
    const statuses = []
    for (let i = 0; i < 5; i++) statuses.push((await del(a, 'wrong-wrong', limited)).status)
    assert.deepEqual(statuses, [401, 401, 401, 429, 429])
  } finally {
    await limited.stop()
  }
})
