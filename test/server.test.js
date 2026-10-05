import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import Database from 'better-sqlite3'
import { startServer, newAccount, jwtClaims } from './helpers.js'
import { generateCode } from '../src/wordlist.js'

let srv
before(async () => {
  srv = await startServer()
})
after(async () => {
  await srv.stop()
})

// A server with an owner, one member (bob), a text channel and a voice channel.
async function world() {
  const owner = await newAccount(srv)
  const bob = await newAccount(srv)
  const s = (await srv.call('POST', '/api/servers', { name: 'S' }, owner.token)).data
  const code = (await srv.call('POST', `/api/servers/${s.id}/codes`, { singleUse: false, expiresInMinutes: null }, owner.token)).data
  await srv.call('POST', '/api/servers/join', { code: code.code }, bob.token)
  const text = (await srv.call('POST', `/api/servers/${s.id}/channels`, { name: 'chat', mode: 'text' }, owner.token)).data
  const voice = (await srv.call('POST', `/api/servers/${s.id}/channels`, { name: 'v', mode: 'voice' }, owner.token)).data
  return { owner, bob, s, code, text, voice }
}

test('bad input never crashes the server', async () => {
  const w = await world()
  const attempts = [
    ['POST', '/api/join', { code: { a: 1 }, screenName: 'x' }],
    ['POST', '/api/join', { code: ['a'], screenName: { b: 1 } }],
    ['POST', '/api/join', { code: 12345, screenName: 'xx' }],
    ['POST', '/api/servers/join', { code: { a: 1 } }, w.bob.token],
    ['POST', '/api/register', { username: { a: 1 }, password: 'password123' }],
    ['POST', '/api/register', { username: 'okname', password: 12345678 }],
    ['POST', '/api/login', { username: ['x'], password: { y: 1 } }],
    ['POST', '/api/voice/token', { type: 'channel', id: { a: 1 } }, w.bob.token],
    ['POST', `/api/servers/${w.s.id}/members/abc/ban`, {}, w.owner.token],
    ['POST', `/api/servers/${w.s.id}/members/abc/kick`, {}, w.owner.token],
    ['PATCH', `/api/servers/${w.s.id}/members/abc`, { muted: true }, w.owner.token],
    ['DELETE', `/api/servers/${w.s.id}/bans/abc`, undefined, w.owner.token],
    ['POST', '/api/servers', { name: { a: 1 } }, w.owner.token],
    ['POST', `/api/servers/${w.s.id}/channels`, { name: ['x'] }, w.owner.token],
    ['POST', `/api/channels/${w.text.id}/messages`, { text: { a: 1 } }, w.bob.token],
    ['POST', '/api/presence', { type: 'channel', id: 'nope' }, w.bob.token],
    ['POST', '/api/me/avatar', { image: { a: 1 }, mime: 'image/png' }, w.bob.token],
    ['POST', '/api/register', '{not json', undefined]
  ]
  for (const [method, path, body, token] of attempts) {
    const r = await srv.call(method, path, body, token)
    assert.ok(r.status >= 400 && r.status < 500, `${method} ${path} gave ${r.status}, expected a 4xx`)
    assert.ok(await srv.isAlive(), `server died after ${method} ${path}`)
  }
})

test('unknown API paths answer with JSON', async () => {
  const r = await srv.call('GET', '/api/nothing-here')
  assert.equal(r.status, 404)
  assert.ok(r.data && r.data.error)
})

test('usernames are unique ignoring case and whitespace, and login ignores case', async () => {
  const a = await srv.call('POST', '/api/register', { username: 'CaseTest', password: 'password123' })
  assert.equal(a.status, 200)
  for (const clash of ['casetest', 'CASETEST', 'casetest ', '  CaseTest']) {
    const r = await srv.call('POST', '/api/register', { username: clash, password: 'password123' })
    assert.equal(r.status, 409, `"${clash}" should be rejected`)
  }
  assert.equal((await srv.call('POST', '/api/register', { username: 12345, password: 'password123' })).status, 400)
  assert.equal((await srv.call('POST', '/api/register', { username: 'ab', password: 'password123' })).status, 400)
  assert.equal((await srv.call('POST', '/api/register', { username: 'x'.repeat(33), password: 'password123' })).status, 400)
  assert.equal((await srv.call('POST', '/api/register', { username: 'bad\u0000name', password: 'password123' })).status, 400)

  const login = await srv.call('POST', '/api/login', { username: 'casetest', password: 'password123' })
  assert.equal(login.status, 200)
  assert.equal(login.data.username, 'CaseTest')
  assert.equal((await srv.call('POST', '/api/login', { username: 'CaseTest', password: 'wrong-password' })).status, 401)
  assert.equal((await srv.call('POST', '/api/login', { username: 'nobody-here', password: 'password123' })).status, 401)
})

test('password length is bounded on both ends', async () => {
  assert.equal((await srv.call('POST', '/api/register', { username: 'shortpw', password: 'short' })).status, 400)
  assert.equal((await srv.call('POST', '/api/register', { username: 'longpw', password: 'x'.repeat(73) })).status, 400)
  assert.equal((await srv.call('POST', '/api/register', { username: 'okpw', password: 'x'.repeat(72) })).status, 200)
})

test('server, channel and room fields are validated', async () => {
  const w = await world()
  const base = `/api/servers/${w.s.id}`
  const bad = [
    ['POST', `${base}/channels`, { name: 'x', mode: 'banana' }],
    ['POST', `${base}/channels`, { name: 'x'.repeat(65) }],
    ['POST', `${base}/channels`, { name: '   ' }],
    ['POST', `${base}/channels`, { name: 'x', persistent: 'yes' }],
    ['PATCH', `${base}/channels/${w.text.id}`, { mode: 'banana' }],
    ['PATCH', `${base}/channels/${w.text.id}`, { persistent: 1 }],
    ['PATCH', `${base}/channels/${w.text.id}`, { persistent: 'false' }],
    ['PATCH', `${base}/channels/${w.text.id}`, { position: -1 }],
    ['PATCH', `${base}/channels/${w.text.id}`, { position: 'first' }],
    ['PATCH', `${base}/channels/${w.text.id}`, { name: '' }],
    ['POST', `${base}/channels/${w.text.id}/rooms`, { name: 'r', mode: 'banana' }],
    ['PATCH', base, { name: 'y'.repeat(65) }],
    ['POST', '/api/servers', { name: '' }]
  ]
  for (const [m, p, b] of bad) {
    const r = await srv.call(m, p, b, w.owner.token)
    assert.equal(r.status, 400, `${m} ${p} ${JSON.stringify(b)} should be 400, got ${r.status}`)
  }
  const ok = await srv.call('PATCH', `${base}/channels/${w.text.id}`, { name: '  renamed  ', position: 3, mode: 'both' }, w.owner.token)
  assert.equal(ok.status, 200)
  const tree = (await srv.call('GET', base, undefined, w.owner.token)).data.channels.find((c) => c.id === w.text.id)
  assert.equal(tree.name, 'renamed')
})

test('keeping history on needs a vote when others have written (and cannot be skipped)', async () => {
  const w = await world()
  const base = `/api/servers/${w.s.id}/channels/${w.text.id}`
  await srv.call('POST', `/api/channels/${w.text.id}/messages`, { text: 'hi from bob' }, w.bob.token)
  assert.equal((await srv.call('PATCH', base, { persistent: true }, w.owner.token)).status, 409)
  assert.equal((await srv.call('PATCH', base, { persistent: 1 }, w.owner.token)).status, 400)
  const tree = (await srv.call('GET', `/api/servers/${w.s.id}`, undefined, w.owner.token)).data.channels.find((c) => c.id === w.text.id)
  assert.equal(tree.persistent, false)
})

test('join codes: strong format, single use is not burned by existing members', async () => {
  for (let i = 0; i < 50; i++) assert.match(generateCode(), /^[a-z]+-[a-z]+-\d{4}$/)
  assert.ok(new Set(Array.from({ length: 200 }, generateCode)).size > 195)

  const w = await world()
  const once = (await srv.call('POST', `/api/servers/${w.s.id}/codes`, { singleUse: true, expiresInMinutes: null }, w.owner.token)).data
  // bob is already a member: redeeming does not consume it
  assert.equal((await srv.call('POST', '/api/servers/join', { code: once.code }, w.bob.token)).status, 200)
  const carol = await newAccount(srv)
  assert.equal((await srv.call('POST', '/api/servers/join', { code: once.code }, carol.token)).status, 200)
  const dave = await newAccount(srv)
  assert.equal((await srv.call('POST', '/api/servers/join', { code: once.code }, dave.token)).status, 410)
})

test('code options are validated', async () => {
  const w = await world()
  const p = `/api/servers/${w.s.id}/codes`
  for (const body of [{ expiresInMinutes: -5 }, { expiresInMinutes: 'soon' }, { expiresInMinutes: 0 }, { singleUse: 'yes' }]) {
    assert.equal((await srv.call('POST', p, body, w.owner.token)).status, 400, JSON.stringify(body))
  }
  assert.equal((await srv.call('POST', p, { expiresInMinutes: 60 }, w.owner.token)).status, 200)
})

test('guests cannot use an account name, or a name another guest is using', async () => {
  const w = await world()
  const bobName = (await srv.call('GET', '/api/me', undefined, w.bob.token)).data.username
  for (const name of [bobName, bobName.toUpperCase(), ` ${bobName} `]) {
    const r = await srv.call('POST', '/api/join', { code: w.code.code, screenName: name })
    assert.equal(r.status, 409, `"${name}" should be refused for a guest`)
  }
  const first = await srv.call('POST', '/api/join', { code: w.code.code, screenName: 'Visitor' })
  assert.equal(first.status, 200)
  assert.equal((await srv.call('POST', '/api/join', { code: w.code.code, screenName: 'visitor' })).status, 409)
  assert.equal((await srv.call('POST', '/api/join', { code: w.code.code, screenName: 'Other Visitor' })).status, 200)
})

test('a muted member cannot get around the mute by joining as a guest under their own name', async () => {
  const w = await world()
  const bobName = (await srv.call('GET', '/api/me', undefined, w.bob.token)).data.username
  assert.equal((await srv.call('PATCH', `/api/servers/${w.s.id}/members/${w.bob.id}`, { muted: true }, w.owner.token)).status, 200)
  const asAccount = await srv.call('POST', '/api/voice/token', { type: 'channel', id: w.voice.id }, w.bob.token)
  assert.equal(jwtClaims(asAccount.data.token).video.canPublish, false)
  assert.equal((await srv.call('POST', '/api/join', { code: w.code.code, screenName: bobName })).status, 409)
})

test('revoking a code ends access for the guests who came in with it', async () => {
  const w = await world()
  const code = (await srv.call('POST', `/api/servers/${w.s.id}/codes`, { singleUse: false, expiresInMinutes: null }, w.owner.token)).data
  const g = (await srv.call('POST', '/api/join', { code: code.code, screenName: 'Guesty' })).data
  const token = () => srv.call('POST', '/api/voice/token', { type: 'channel', id: w.voice.id }, g.guestToken)
  assert.equal((await token()).status, 200)

  const listed = (await srv.call('GET', `/api/servers/${w.s.id}/codes`, undefined, w.owner.token)).data.codes
  const row = listed.find((c) => c.code === code.code)
  assert.ok(row)
  assert.equal(row.guestsNow, 1)
  // not just any member can list or revoke
  assert.equal((await srv.call('GET', `/api/servers/${w.s.id}/codes`, undefined, w.bob.token)).status, 403)
  assert.equal((await srv.call('DELETE', `/api/servers/${w.s.id}/codes/${row.id}`, undefined, w.bob.token)).status, 403)

  assert.equal((await srv.call('DELETE', `/api/servers/${w.s.id}/codes/${row.id}`, undefined, w.owner.token)).status, 200)
  assert.equal((await token()).status, 403)
  assert.equal((await srv.call('POST', '/api/join', { code: code.code, screenName: 'Another' })).status, 404)
  assert.equal((await srv.call('POST', '/api/servers/join', { code: code.code }, (await newAccount(srv)).token)).status, 404)
  const after = (await srv.call('GET', `/api/servers/${w.s.id}/codes`, undefined, w.owner.token)).data.codes
  assert.ok(!after.some((c) => c.code === code.code))
  // a code from another server can't be revoked through this one
  const other = await world()
  const otherCode = (await srv.call('GET', `/api/servers/${other.s.id}/codes`, undefined, other.owner.token)).data.codes[0]
  assert.equal((await srv.call('DELETE', `/api/servers/${w.s.id}/codes/${otherCode.id}`, undefined, w.owner.token)).status, 404)
})

test('a guest token never outlives the code it came from', async () => {
  const w = await world()
  const code = (await srv.call('POST', `/api/servers/${w.s.id}/codes`, { singleUse: false, expiresInMinutes: 30 }, w.owner.token)).data
  const g = (await srv.call('POST', '/api/join', { code: code.code, screenName: 'Short Stay' })).data
  const c = jwtClaims(g.guestToken)
  const left = c.exp - c.iat
  assert.ok(left <= 30 * 60 && left > 29 * 60, `guest token lives ${left}s`)
  const permanent = (await srv.call('POST', `/api/servers/${w.s.id}/codes`, { singleUse: false, expiresInMinutes: null }, w.owner.token)).data
  const g2 = jwtClaims((await srv.call('POST', '/api/join', { code: permanent.code, screenName: 'Long Stay' })).data.guestToken)
  assert.equal(g2.exp - g2.iat, 12 * 3600)
})

test('guest tokens stay inside their own server and cannot reach account routes', async () => {
  const w = await world()
  const other = await world()
  const g = (await srv.call('POST', '/api/join', { code: w.code.code, screenName: 'Roamer' })).data
  assert.equal((await srv.call('POST', '/api/voice/token', { type: 'channel', id: other.voice.id }, g.guestToken)).status, 403)
  assert.equal((await srv.call('POST', '/api/voice/token', { type: 'channel', id: w.text.id }, g.guestToken)).status, 400)
  assert.equal((await srv.call('GET', '/api/servers', undefined, g.guestToken)).status, 401)
  assert.equal((await srv.call('POST', '/api/voice/token', { type: 'channel', id: w.voice.id }, g.guestToken)).status, 200)
})

test('moderation: the owner and admins are protected, targets are checked', async () => {
  const w = await world()
  const base = `/api/servers/${w.s.id}/members`
  assert.equal((await srv.call('POST', `${base}/${w.owner.id}/ban`, {}, w.bob.token)).status, 403) // bob isn't an admin at all
  // owner can't moderate themselves
  assert.equal((await srv.call('POST', `${base}/${w.owner.id}/kick`, {}, w.owner.token)).status, 400)
  // make bob an admin directly in the database, then check he can't act on the owner
  const db = new Database(srv.dbPath)
  db.prepare('UPDATE server_members SET is_admin = 1 WHERE server_id = ? AND account_id = ?').run(w.s.id, w.bob.id)
  db.close()
  for (const action of ['kick', 'ban']) {
    assert.equal((await srv.call('POST', `${base}/${w.owner.id}/${action}`, {}, w.bob.token)).status, 403, `admin ${action}s owner`)
  }
  assert.equal((await srv.call('PATCH', `${base}/${w.owner.id}`, { muted: true }, w.bob.token)).status, 403)
  // owner can't act on the admin either
  assert.equal((await srv.call('POST', `${base}/${w.bob.id}/ban`, {}, w.owner.token)).status, 403)
  // missing accounts
  assert.equal((await srv.call('POST', `${base}/999999/ban`, {}, w.owner.token)).status, 404)
  assert.equal((await srv.call('POST', `${base}/999999/kick`, {}, w.owner.token)).status, 404)
})

test('moderation: kick, ban, unban, mute and timed access work and are validated', async () => {
  const w = await world()
  const base = `/api/servers/${w.s.id}/members`
  const carol = await newAccount(srv)
  await srv.call('POST', '/api/servers/join', { code: w.code.code }, carol.token)

  for (const body of [{ muted: 'yes' }, { accessExpiresInMinutes: -1 }, { accessExpiresInMinutes: 'tomorrow' }, { accessExpiresInMinutes: 0 }]) {
    assert.equal((await srv.call('PATCH', `${base}/${carol.id}`, body, w.owner.token)).status, 400, JSON.stringify(body))
  }
  const timed = await srv.call('PATCH', `${base}/${carol.id}`, { accessExpiresInMinutes: 60 }, w.owner.token)
  assert.equal(timed.status, 200)
  assert.ok(timed.data.member.accessExpiresAt > Date.now())
  assert.equal((await srv.call('PATCH', `${base}/${carol.id}`, { accessExpiresInMinutes: null }, w.owner.token)).data.member.accessExpiresAt, null)

  assert.equal((await srv.call('POST', `${base}/${carol.id}/ban`, { reason: 'testing' }, w.owner.token)).status, 200)
  const bans = (await srv.call('GET', `/api/servers/${w.s.id}/bans`, undefined, w.owner.token)).data.bans
  assert.equal(bans.length, 1)
  assert.equal((await srv.call('POST', '/api/servers/join', { code: w.code.code }, carol.token)).status, 403)
  assert.equal((await srv.call('DELETE', `/api/servers/${w.s.id}/bans/${carol.id}`, undefined, w.owner.token)).status, 200)
  assert.equal((await srv.call('POST', '/api/servers/join', { code: w.code.code }, carol.token)).status, 200)
  assert.equal((await srv.call('POST', `${base}/${carol.id}/kick`, {}, w.owner.token)).status, 200)
  assert.equal((await srv.call('POST', `${base}/${carol.id}/kick`, {}, w.owner.token)).status, 404)
})

test('deleting a server removes its bans, codes and members', async () => {
  const w = await world()
  const carol = await newAccount(srv)
  await srv.call('POST', '/api/servers/join', { code: w.code.code }, carol.token)
  await srv.call('POST', `/api/servers/${w.s.id}/members/${carol.id}/ban`, {}, w.owner.token)
  assert.equal((await srv.call('DELETE', `/api/servers/${w.s.id}`, undefined, w.owner.token)).status, 200)
  const db = new Database(srv.dbPath, { readonly: true })
  const left = (table) => db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE server_id = ?`).get(w.s.id).n
  assert.equal(left('server_bans'), 0)
  assert.equal(left('join_codes'), 0)
  assert.equal(left('server_members'), 0)
  assert.equal(left('channels'), 0)
  db.close()
  assert.equal((await srv.call('GET', `/api/servers/${w.s.id}`, undefined, w.owner.token)).status, 403)
  assert.ok(await srv.isAlive())
})

test('voice tokens: members only, voice spaces only', async () => {
  const w = await world()
  const outsider = await newAccount(srv)
  assert.equal((await srv.call('POST', '/api/voice/token', { type: 'channel', id: w.voice.id }, outsider.token)).status, 403)
  assert.equal((await srv.call('POST', '/api/voice/token', { type: 'channel', id: w.text.id }, w.bob.token)).status, 400)
  const ok = await srv.call('POST', '/api/voice/token', { type: 'channel', id: w.voice.id }, w.bob.token)
  assert.equal(ok.status, 200)
  assert.equal(jwtClaims(ok.data.token).video.canPublish, true)
})

test('messages and presence still work', async () => {
  const w = await world()
  const posted = await srv.call('POST', `/api/channels/${w.text.id}/messages`, { text: '  hello  ' }, w.bob.token)
  assert.equal(posted.status, 200)
  assert.equal(posted.data.text, 'hello')
  const list = await srv.call('GET', `/api/channels/${w.text.id}/messages`, undefined, w.owner.token)
  assert.equal(list.data.messages.length, 1)
  assert.equal((await srv.call('POST', `/api/channels/${w.text.id}/messages`, { text: 'x'.repeat(4001) }, w.bob.token)).status, 400)
  const outsider = await newAccount(srv)
  assert.equal((await srv.call('GET', `/api/channels/${w.text.id}/messages`, undefined, outsider.token)).status, 403)
  const p = await srv.call('POST', '/api/presence', { type: 'channel', id: w.text.id, avatarColor: '#aabbcc' }, w.bob.token)
  assert.equal(p.status, 200)
  assert.equal(p.data.presence[`channel:${w.text.id}`].length, 1)
})

test('join attempts are rate limited per address', async () => {
  const limited = await startServer({ env: { JOIN_LIMIT: '5' } })
  try {
    const statuses = []
    for (let i = 0; i < 8; i++) {
      statuses.push((await limited.call('POST', '/api/join', { code: `wolf-wren-${1000 + i}`, screenName: 'guesser' })).status)
    }
    assert.deepEqual(statuses.slice(0, 5), [404, 404, 404, 404, 404])
    assert.deepEqual(statuses.slice(5), [429, 429, 429])
  } finally {
    await limited.stop()
  }
})

test('login and registration stay rate limited per address', async () => {
  const limited = await startServer({ env: { LOGIN_LIMIT: '3', REGISTER_LIMIT: '2' } })
  try {
    const reg = []
    for (let i = 0; i < 4; i++) reg.push((await limited.call('POST', '/api/register', { username: `limited${i}`, password: 'password123' })).status)
    assert.deepEqual(reg, [200, 200, 429, 429])
    const login = []
    for (let i = 0; i < 5; i++) login.push((await limited.call('POST', '/api/login', { username: 'limited0', password: 'wrong-password' })).status)
    assert.deepEqual(login, [401, 401, 401, 429, 429])
  } finally {
    await limited.stop()
  }
})
