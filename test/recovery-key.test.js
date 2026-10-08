// Account recovery keys: made at sign-up, confirmed by the person, used to reset a
// forgotten password, regenerated or password-changed from a signed-in session, and
// the rule that nobody (an admin included) can reset another account.
// Runs the real server.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import jwt from 'jsonwebtoken'
import Database from 'better-sqlite3'
import { startServer, newAccount } from './helpers.js'
import { RECOVERY_WORDS } from '../src/recoverywords.js'
import { generateRecoveryKey, normalizeRecoveryKey, recoveryKeyMatches, hashRecoveryKey } from '../src/recoverykey.js'

let srv
before(async () => {
  // the new routes are rate limited tightly; this suite makes many calls from one address
  srv = await startServer({ env: { RECOVER_LIMIT: '1000', ACCOUNT_LIMIT: '1000' } })
})
after(async () => {
  await srv.stop()
})

let n = 0
const name = () => `keyuser${++n}x`
const PASSWORD = 'password123'

// A new account whose key has been confirmed, the normal state of someone who finished sign-up.
async function confirmed(server = srv) {
  const username = name()
  const r = await server.call('POST', '/api/register', { username, password: PASSWORD })
  assert.equal(r.status, 200, JSON.stringify(r.data))
  const ack = await server.call('POST', '/api/me/recovery-key/ack', {}, r.data.token)
  assert.equal(ack.status, 200)
  return { username, token: r.data.token, key: r.data.recoveryKey, id: r.data.id }
}
const recover = (body, server = srv) => server.call('POST', '/api/recover', body)

test('the word list is 2048 distinct words and keys are 12 of them', () => {
  assert.equal(RECOVERY_WORDS.length, 2048)
  assert.equal(new Set(RECOVERY_WORDS).size, 2048)
  assert.equal(new Set(RECOVERY_WORDS.map((w) => w.slice(0, 4))).size, 2048) // told apart by four letters
  const a = generateRecoveryKey()
  const b = generateRecoveryKey()
  assert.notEqual(a, b)
  for (const key of [a, b]) {
    const words = key.split(' ')
    assert.equal(words.length, 12)
    assert.ok(words.every((w) => RECOVERY_WORDS.includes(w)))
  }
})

test('typed keys are forgiving about case and separators, and nothing else', () => {
  const key = generateRecoveryKey()
  assert.equal(normalizeRecoveryKey(key.toUpperCase()), key)
  assert.equal(normalizeRecoveryKey('  ' + key.split(' ').join(' - ') + '  '), key)
  assert.equal(normalizeRecoveryKey(key.split(' ').join(',')), key)
  assert.equal(normalizeRecoveryKey(key.split(' ').slice(0, 11).join(' ')), null) // too short
  assert.equal(normalizeRecoveryKey(key + ' abandon'), null) // too long
  assert.equal(normalizeRecoveryKey(key.replace(/^\w+/, 'zzzzzz')), null) // not a word of the list
  assert.equal(normalizeRecoveryKey(123), null)
  assert.equal(normalizeRecoveryKey('a '.repeat(500)), null)
  const hash = hashRecoveryKey(key)
  assert.equal(recoveryKeyMatches(key, hash), true)
  assert.equal(recoveryKeyMatches(generateRecoveryKey(), hash), false)
  assert.equal(recoveryKeyMatches(key, null), false)
  assert.equal(recoveryKeyMatches('', hash), false)
})

test('sign-up returns a key once, stores only a hash, and does not count it until it is confirmed', async () => {
  const dir = await startServer({ env: { RECOVER_LIMIT: '1000', ACCOUNT_LIMIT: '1000' } })
  try {
    const r = await dir.call('POST', '/api/register', { username: 'newcomer1', password: PASSWORD })
    assert.equal(r.status, 200)
    assert.equal(r.data.recoveryKeyAcked, false)
    assert.equal(r.data.recoveryKey.split(' ').length, 12)
    // the key is nowhere in the database, only a hash of it, and not yet the working one
    const db = new Database(dir.dbPath, { readonly: true })
    const row = db.prepare("SELECT recovery_key_hash, pending_recovery_key_hash FROM accounts WHERE username = 'newcomer1'").get()
    db.close()
    assert.equal(row.recovery_key_hash, null)
    assert.equal(row.pending_recovery_key_hash, hashRecoveryKey(r.data.recoveryKey))
    assert.ok(!JSON.stringify(row).includes(r.data.recoveryKey.split(' ')[0] + ' '))
    // login and /me never show the key again
    const login = await dir.call('POST', '/api/login', { username: 'newcomer1', password: PASSWORD })
    assert.equal(login.data.recoveryKey, undefined)
    assert.equal(login.data.recoveryKeyAcked, false)
    // an unconfirmed key can't reset anything yet
    const early = await recover({ username: 'newcomer1', key: r.data.recoveryKey, newPassword: 'another-password' }, dir)
    assert.equal(early.status, 401)
    // confirming it makes it the working key
    assert.equal((await dir.call('POST', '/api/me/recovery-key/ack', {}, r.data.token)).status, 200)
    assert.equal((await dir.call('GET', '/api/me', undefined, r.data.token)).data.recoveryKeyAcked, true)
    assert.equal((await dir.call('POST', '/api/login', { username: 'newcomer1', password: PASSWORD })).data.recoveryKeyAcked, true)
    // and there is nothing left to confirm
    assert.equal((await dir.call('POST', '/api/me/recovery-key/ack', {}, r.data.token)).status, 409)
  } finally {
    await dir.stop()
  }
})

test('the key resets a forgotten password, spends itself, and hands back the next key', async () => {
  const a = await confirmed()
  const r = await recover({ username: a.username, key: a.key, newPassword: 'a-brand-new-password' })
  assert.equal(r.status, 200, JSON.stringify(r.data))
  assert.equal(r.data.recoveryKeyAcked, false) // the old key is spent; the new one is not confirmed yet
  assert.equal(r.data.recoveryKey.split(' ').length, 12)
  assert.notEqual(r.data.recoveryKey, a.key)
  assert.equal((await srv.call('GET', '/api/me', undefined, r.data.token)).status, 200)

  assert.equal((await srv.call('POST', '/api/login', { username: a.username, password: PASSWORD })).status, 401)
  assert.equal((await srv.call('POST', '/api/login', { username: a.username, password: 'a-brand-new-password' })).status, 200)
  // the used key does nothing now
  assert.equal((await recover({ username: a.username, key: a.key, newPassword: 'third-password-here' })).status, 401)
  // the new key works once it is confirmed
  assert.equal((await recover({ username: a.username, key: r.data.recoveryKey, newPassword: 'third-password-here' })).status, 401)
  await srv.call('POST', '/api/me/recovery-key/ack', {}, r.data.token)
  const again = await recover({ username: a.username, key: r.data.recoveryKey, newPassword: 'third-password-here' })
  assert.equal(again.status, 200)
})

test('a key typed in capitals with dashes works, and the username ignores capitalization', async () => {
  const a = await confirmed()
  const r = await recover({
    username: a.username.toUpperCase(),
    key: a.key.toUpperCase().split(' ').join('-'),
    newPassword: 'another-new-password'
  })
  assert.equal(r.status, 200)
})

test('every way of getting it wrong gets the same answer: no clue which usernames or keys exist', async () => {
  const a = await confirmed()
  const unconfirmed = await srv.call('POST', '/api/register', { username: name(), password: PASSWORD })
  const answers = []
  for (const body of [
    { username: a.username, key: generateRecoveryKey(), newPassword: 'whatever-password' }, // wrong key
    { username: 'nobody-by-that-name', key: a.key, newPassword: 'whatever-password' }, // no such account
    { username: a.username, key: 'not a key at all', newPassword: 'whatever-password' }, // malformed
    { username: unconfirmed.data.username, key: unconfirmed.data.recoveryKey, newPassword: 'whatever-password' } // key not confirmed
  ]) {
    const r = await recover(body)
    answers.push([r.status, r.data.error])
  }
  assert.ok(answers.every((x) => x[0] === 401), JSON.stringify(answers))
  assert.equal(new Set(answers.map((x) => x[1])).size, 1)
  // and none of those changed a thing
  assert.equal((await srv.call('POST', '/api/login', { username: a.username, password: PASSWORD })).status, 200)
})

test('a weak new password is refused before anything else', async () => {
  const a = await confirmed()
  assert.equal((await recover({ username: a.username, key: a.key, newPassword: 'short' })).status, 400)
  assert.equal((await recover({ username: a.username, key: a.key, newPassword: 'x'.repeat(80) })).status, 400)
  assert.equal((await recover({ username: a.username, key: a.key })).status, 400)
  // the key was not spent by the refused attempts
  assert.equal((await recover({ username: a.username, key: a.key, newPassword: 'a-perfectly-fine-one' })).status, 200)
})

test('resetting is rate limited per address', async () => {
  const limited = await startServer({ env: { RECOVER_LIMIT: '3' } })
  try {
    const statuses = []
    for (let i = 0; i < 5; i++) {
      statuses.push((await recover({ username: 'nobody', key: generateRecoveryKey(), newPassword: 'whatever-password' }, limited)).status)
    }
    assert.deepEqual(statuses, [401, 401, 401, 429, 429])
  } finally {
    await limited.stop()
  }
})

test('a reset ends every older session; the one it hands back works', async () => {
  const a = await confirmed()
  const other = await srv.call('POST', '/api/login', { username: a.username, password: PASSWORD })
  assert.equal((await srv.call('GET', '/api/me', undefined, other.data.token)).status, 200)
  const r = await recover({ username: a.username, key: a.key, newPassword: 'fresh-password-1' })
  for (const old of [a.token, other.data.token]) {
    const me = await srv.call('GET', '/api/me', undefined, old)
    assert.equal(me.status, 401)
    assert.match(me.data.error, /password was changed/)
  }
  assert.equal((await srv.call('GET', '/api/me', undefined, r.data.token)).status, 200)
})

test('changing the password needs the current one, ends other sessions and keeps this one', async () => {
  const a = await confirmed()
  const other = await srv.call('POST', '/api/login', { username: a.username, password: PASSWORD })
  const path = '/api/me/password'
  assert.equal((await srv.call('POST', path, { newPassword: 'brand-new-pass-1' }, a.token)).status, 400)
  assert.equal((await srv.call('POST', path, { currentPassword: 'wrong-wrong', newPassword: 'brand-new-pass-1' }, a.token)).status, 401)
  assert.equal((await srv.call('POST', path, { currentPassword: PASSWORD, newPassword: 'short' }, a.token)).status, 400)
  assert.equal((await srv.call('POST', '/api/login', { username: a.username, password: PASSWORD })).status, 200) // nothing changed yet

  const r = await srv.call('POST', path, { currentPassword: PASSWORD, newPassword: 'brand-new-pass-1' }, a.token)
  assert.equal(r.status, 200)
  assert.equal(r.data.recoveryKeyAcked, true) // the key is untouched by a password change
  assert.equal((await srv.call('GET', '/api/me', undefined, r.data.token)).status, 200)
  assert.equal((await srv.call('GET', '/api/me', undefined, a.token)).status, 401)
  assert.equal((await srv.call('GET', '/api/me', undefined, other.data.token)).status, 401)
  assert.equal((await srv.call('POST', '/api/login', { username: a.username, password: PASSWORD })).status, 401)
  assert.equal((await srv.call('POST', '/api/login', { username: a.username, password: 'brand-new-pass-1' })).status, 200)
  // and the original key still works
  assert.equal((await recover({ username: a.username, key: a.key, newPassword: 'and-another-one-1' })).status, 200)
})

test('a new key needs the password, and does not replace the working key until it is confirmed', async () => {
  const a = await confirmed()
  assert.equal((await srv.call('POST', '/api/me/recovery-key', {}, a.token)).status, 400)
  assert.equal((await srv.call('POST', '/api/me/recovery-key', { password: 'wrong-wrong' }, a.token)).status, 401)
  const made = await srv.call('POST', '/api/me/recovery-key', { password: PASSWORD }, a.token)
  assert.equal(made.status, 200)
  const next = made.data.recoveryKey
  assert.notEqual(next, a.key)
  // shown but not confirmed (say the person closed the window): the old key still works
  const stillOld = await recover({ username: a.username, key: next, newPassword: 'should-not-work-1' })
  assert.equal(stillOld.status, 401)
  assert.equal((await srv.call('GET', '/api/me', undefined, a.token)).data.recoveryKeyAcked, true)

  await srv.call('POST', '/api/me/recovery-key/ack', {}, a.token)
  assert.equal((await recover({ username: a.username, key: a.key, newPassword: 'old-key-now-dead-1' })).status, 401)
  assert.equal((await recover({ username: a.username, key: next, newPassword: 'new-key-works-here-1' })).status, 200)
})

test('an abandoned new key leaves the working one in place', async () => {
  const a = await confirmed()
  await srv.call('POST', '/api/me/recovery-key', { password: PASSWORD }, a.token) // shown, never confirmed
  assert.equal((await recover({ username: a.username, key: a.key, newPassword: 'the-old-key-works-1' })).status, 200)
})

test('guests and strangers cannot use any of these routes', async () => {
  const owner = await newAccount(srv)
  const s = (await srv.call('POST', '/api/servers', { name: 'Keys' }, owner.token)).data
  const code = (await srv.call('POST', `/api/servers/${s.id}/codes`, { singleUse: false, expiresInMinutes: null }, owner.token)).data
  const guest = (await srv.call('POST', '/api/join', { code: code.code, screenName: 'Just Visiting' })).data
  for (const [path, body] of [
    ['/api/me/recovery-key', { password: PASSWORD }],
    ['/api/me/recovery-key/ack', {}],
    ['/api/me/password', { currentPassword: PASSWORD, newPassword: 'whatever-password' }]
  ]) {
    assert.equal((await srv.call('POST', path, body, guest.guestToken)).status, 401, path)
    assert.equal((await srv.call('POST', path, body)).status, 401, path)
  }
})

test('nobody can reset or read another account: a server admin changes only their own', async () => {
  const admin = await newAccount(srv)
  const s = (await srv.call('POST', '/api/servers', { name: 'Admins' }, admin.token)).data
  const victim = await confirmed()
  const code = (await srv.call('POST', `/api/servers/${s.id}/codes`, { singleUse: false, expiresInMinutes: null }, admin.token)).data
  await srv.call('POST', '/api/servers/join', { code: code.code }, victim.token)
  // the routes take no account id: they act on whoever the token belongs to
  const r = await srv.call('POST', '/api/me/password', { currentPassword: PASSWORD, newPassword: 'admins-own-new-pass', accountId: victim.id, username: victim.username }, admin.token)
  assert.equal(r.status, 200)
  assert.equal((await srv.call('POST', '/api/login', { username: victim.username, password: PASSWORD })).status, 200) // untouched
  // and there is no admin route for it, under any plausible name
  for (const path of [
    `/api/servers/${s.id}/members/${victim.id}/password`,
    `/api/servers/${s.id}/members/${victim.id}/reset`,
    `/api/servers/${s.id}/members/${victim.id}/recovery-key`,
    `/api/accounts/${victim.id}/password`,
    `/api/admin/accounts/${victim.id}/reset`
  ]) {
    for (const method of ['POST', 'PUT', 'PATCH', 'GET']) {
      const res = await srv.call(method, path, method === 'GET' ? undefined : { password: 'x', newPassword: 'y' }, admin.token)
      assert.ok([404, 405].includes(res.status), `${method} ${path} answered ${res.status}`)
    }
  }
  // the members list never shows a key or a hash
  const members = JSON.stringify((await srv.call('GET', `/api/servers/${s.id}/members`, undefined, admin.token)).data)
  assert.ok(!/recovery|hash|epoch/i.test(members))
})

test('every route that touches a password or key is one of the self-service routes', () => {
  const source = readFileSync(new URL('../src/index.js', import.meta.url), 'utf8')
  const found = [...source.matchAll(/app\.(?:get|post|put|patch|delete)\(\s*'([^']+)'/g)]
    .map((m) => m[1])
    .filter((p) => /password|recover/i.test(p))
    .sort()
  assert.deepEqual(found, ['/api/me/password', '/api/me/recovery-key', '/api/me/recovery-key/ack', '/api/recover'])
})

test('tokens issued before sessions could end still work, and a token for a missing account does not', async () => {
  const a = await confirmed()
  const secret = 'test-secret-test-secret-test-secret-test'
  const legacy = jwt.sign({ sub: a.id, username: a.username, isAdmin: false }, secret, { expiresIn: '30d' }) // no epoch claim
  assert.equal((await srv.call('GET', '/api/me', undefined, legacy)).status, 200)
  const ghost = jwt.sign({ sub: 987654, username: 'ghost', isAdmin: false, ep: 0 }, secret, { expiresIn: '30d' })
  assert.equal((await srv.call('GET', '/api/me', undefined, ghost)).status, 401)
  const future = jwt.sign({ sub: a.id, username: a.username, isAdmin: false, ep: 5 }, secret, { expiresIn: '30d' })
  assert.equal((await srv.call('GET', '/api/me', undefined, future)).status, 401)
})
