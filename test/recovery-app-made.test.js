// Recovery keys made by the person's app (v0.22.0): the 12 words never reach the server, which keeps only a hash of a proof the
// app derives from them. Covers sign-up, a reset, a new key from Settings, the keyring backup under it, accounts whose key an
// older server made, and that avatars are shown only to the person and the people who share a server with them.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { createHash, randomBytes } from 'node:crypto'
import { readFileSync } from 'node:fs'
import Database from 'better-sqlite3'
import { startServer, newAccount } from './helpers.js'

let srv
before(async () => {
  srv = await startServer({ env: { RECOVER_LIMIT: '1000', ACCOUNT_LIMIT: '1000', REGISTER_LIMIT: '1000', LOGIN_LIMIT: '1000', JOIN_LIMIT: '1000', DEVICE_LIMIT: '1000' } })
})
after(async () => {
  await srv.stop()
})
const PASSWORD = 'password123'
let n = 0
// what the app does: make a secret, keep it, send only its hash
const makeProof = () => {
  const bytes = randomBytes(32)
  return { proof: bytes.toString('base64url'), proofHash: createHash('sha256').update(bytes).digest('hex') }
}
async function appAccount() {
  const username = `appkey${++n}x`
  const p = makeProof()
  const r = await srv.call('POST', '/api/register', { username, password: PASSWORD, recoveryProofHash: p.proofHash })
  assert.equal(r.status, 200, JSON.stringify(r.data))
  return { username, ...r.data, p }
}
const confirmed = async () => {
  const a = await appAccount()
  assert.equal((await srv.call('POST', '/api/me/recovery-key/ack', {}, a.token)).status, 200)
  return a
}
const db = () => new Database(srv.dbPath, { readonly: true })
const stored = (id) => {
  const d = db()
  try {
    return d.prepare('SELECT recovery_key_hash, pending_recovery_key_hash FROM accounts WHERE id = ?').get(id)
  } finally {
    d.close()
  }
}

test('sign-up with a proof returns no words, keeps only a marked hash, and the key counts once confirmed', async () => {
  const a = await appAccount()
  assert.equal(a.recoveryKey, null)
  assert.equal(a.recoveryKeyAcked, false)
  assert.equal(a.recoveryKeyBy, null)
  assert.equal(stored(a.id).pending_recovery_key_hash, 'p1:' + a.p.proofHash)
  assert.equal(stored(a.id).recovery_key_hash, null)
  await srv.call('POST', '/api/me/recovery-key/ack', {}, a.token)
  const me = (await srv.call('GET', '/api/me', undefined, a.token)).data
  assert.equal(me.recoveryKeyAcked, true)
  assert.equal(me.recoveryKeyBy, 'app')
  assert.equal((await srv.call('POST', '/api/register', { username: 'badhash1', password: PASSWORD, recoveryProofHash: 'nope' })).status, 400)
})

test('an older app that sends no proof is still given words by the server', async () => {
  const r = await newAccount(srv)
  assert.match(r.recoveryKey, /^([a-z]+ ){11}[a-z]+$/)
  assert.equal(r.recoveryKeyBy, null)
})

test('a reset with the proof works once, never takes the words, and the next key is made by the app', async () => {
  const a = await confirmed()
  const next = makeProof()
  const wrong = await srv.call('POST', '/api/recover', { username: a.username, proof: makeProof().proof, newPassword: 'newpassword1' })
  assert.equal(wrong.status, 401)
  assert.equal(wrong.data.reason, undefined, 'an app-made key does not announce itself')
  // words (of any kind) are no way in to an app-made account
  assert.equal((await srv.call('POST', '/api/recover', { username: a.username, key: 'abandon '.repeat(11) + 'ability', newPassword: 'newpassword1' })).status, 401)
  const ok = await srv.call('POST', '/api/recover', { username: a.username, proof: a.p.proof, newPassword: 'newpassword1', newRecoveryProofHash: next.proofHash })
  assert.equal(ok.status, 200, JSON.stringify(ok.data))
  assert.equal(ok.data.recoveryKey, null)
  assert.equal(ok.data.recoveryKeyAcked, false)
  assert.equal(stored(a.id).pending_recovery_key_hash, 'p1:' + next.proofHash)
  // spent: the same proof again does nothing, and so does the old password
  assert.equal((await srv.call('POST', '/api/recover', { username: a.username, proof: a.p.proof, newPassword: 'another-pass1' })).status, 401)
  assert.equal((await srv.call('POST', '/api/login', { username: a.username, password: PASSWORD })).status, 401)
  assert.equal((await srv.call('POST', '/api/login', { username: a.username, password: 'newpassword1' })).status, 200)
  await srv.call('POST', '/api/me/recovery-key/ack', {}, ok.data.token)
  assert.equal((await srv.call('POST', '/api/recover', { username: a.username, proof: next.proof, newPassword: 'third-pass12' })).status, 200)
})

test('a new key from Settings needs the password, replaces the old one only when confirmed, and moves an older account to app-made', async () => {
  const old = await newAccount(srv) // key made by the server
  await srv.call('POST', '/api/me/recovery-key/ack', {}, old.token)
  assert.equal((await srv.call('GET', '/api/me', undefined, old.token)).data.recoveryKeyBy, 'server')
  const p = makeProof()
  assert.equal((await srv.call('POST', '/api/me/recovery-key', { password: 'wrong-password', recoveryProofHash: p.proofHash }, old.token)).status, 401)
  const made = await srv.call('POST', '/api/me/recovery-key', { password: PASSWORD, recoveryProofHash: p.proofHash }, old.token)
  assert.equal(made.status, 200)
  assert.equal(made.data.recoveryKey, null)
  // until confirmed the old words still work
  assert.equal((await srv.call('GET', '/api/me', undefined, old.token)).data.recoveryKeyBy, 'server')
  await srv.call('POST', '/api/me/recovery-key/ack', {}, old.token)
  assert.equal((await srv.call('GET', '/api/me', undefined, old.token)).data.recoveryKeyBy, 'app')
  assert.equal((await srv.call('POST', '/api/recover', { username: old.username, key: old.recoveryKey, newPassword: 'newpassword1' })).status, 401)
  assert.equal((await srv.call('POST', '/api/recover', { username: old.username, proof: p.proof, newPassword: 'newpassword1' })).status, 200)
})

test('an account whose key an older server made is told to send its words, and can move to an app-made key while resetting', async () => {
  const old = await newAccount(srv)
  await srv.call('POST', '/api/me/recovery-key/ack', {}, old.token)
  const proofTry = await srv.call('POST', '/api/recover', { username: old.username, proof: makeProof().proof, newPassword: 'newpassword1' })
  assert.equal(proofTry.status, 401)
  assert.equal(proofTry.data.reason, 'legacy_key')
  const next = makeProof()
  const ok = await srv.call('POST', '/api/recover', { username: old.username, key: old.recoveryKey, newPassword: 'newpassword1', newRecoveryProofHash: next.proofHash })
  assert.equal(ok.status, 200)
  assert.equal(ok.data.recoveryKey, null)
  assert.equal(stored(old.id).pending_recovery_key_hash, 'p1:' + next.proofHash)
  // a username that does not exist gets the plain answer
  const none = await srv.call('POST', '/api/recover', { username: 'nobody-here', proof: makeProof().proof, newPassword: 'newpassword1' })
  assert.equal(none.status, 401)
  assert.equal(none.data.reason, undefined)
})

test('the keyring backup under an app-made key needs the proof, not words, and only the account\'s own proof', async () => {
  const a = await confirmed()
  const put = (body) => srv.call('PUT', '/api/me/keyring', { blob: 'rlk1.' + 'A'.repeat(16) + '.' + 'B'.repeat(40), baseVersion: 0, ...body }, a.token)
  assert.equal((await put({ proofHash: a.p.proofHash })).status, 401, 'no proof')
  assert.equal((await put({ proofHash: a.p.proofHash, recoveryProof: makeProof().proof })).status, 401, 'someone else\'s proof')
  const other = makeProof()
  assert.equal((await put({ proofHash: other.proofHash, recoveryProof: other.proof })).status, 401, 'a proof that is not the account key')
  assert.equal((await put({ proofHash: a.p.proofHash, recoveryKey: 'abandon '.repeat(11) + 'ability' })).status, 401, 'words are not accepted')
  const ok = await put({ proofHash: a.p.proofHash, recoveryProof: a.p.proof })
  assert.equal(ok.status, 200, JSON.stringify(ok.data))
  // once the backup is made under this proof, later updates carry only the hash, as before
  assert.equal((await srv.call('PUT', '/api/me/keyring', { blob: 'rlk1.' + 'C'.repeat(16) + '.' + 'D'.repeat(40), baseVersion: ok.data.version, proofHash: a.p.proofHash }, a.token)).status, 200)
})

test('the words are nowhere on the server: not in the database, not in the log', async () => {
  const a = await confirmed()
  const words = 'zebra '.repeat(11) + 'yellow'
  await srv.call('POST', '/api/recover', { username: a.username, proof: a.p.proof, newPassword: 'newpassword1' })
  const bytes = readFileSync(srv.dbPath)
  assert.equal(bytes.includes(Buffer.from(a.p.proof)), false, 'the proof itself is not stored, only its hash')
  assert.equal(srv.log().includes(a.p.proof), false)
  assert.equal(bytes.includes(Buffer.from(words)), false)
})

// ---- avatars ----
const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=='
const getAvatar = (id, token) => fetch(`${srv.url}/api/avatars/${id}`, { headers: token ? { authorization: 'Bearer ' + token } : {} })

test('an avatar is shown to its owner and to people who share a server, and to nobody else', async () => {
  const owner = await newAccount(srv)
  const server = (await srv.call('POST', '/api/servers', { name: 'Hall' }, owner.token)).data
  const code = (await srv.call('POST', `/api/servers/${server.id}/codes`, { singleUse: false, expiresInMinutes: null }, owner.token)).data
  const friend = await newAccount(srv)
  await srv.call('POST', '/api/servers/join', { code: code.code }, friend.token)
  const stranger = await newAccount(srv)
  const elsewhere = (await srv.call('POST', '/api/servers', { name: 'Elsewhere' }, stranger.token)).data
  assert.ok(elsewhere.id)
  assert.equal((await srv.call('POST', '/api/me/avatar', { image: png, mime: 'image/png' }, owner.token)).status, 200)

  assert.equal((await getAvatar(owner.id)).status, 401, 'no sign-in')
  assert.equal((await getAvatar(owner.id, owner.token)).status, 200, 'the owner of the picture')
  const seen = await getAvatar(owner.id, friend.token)
  assert.equal(seen.status, 200, 'a member of the same server')
  assert.match(seen.headers.get('cache-control'), /private/)
  const refused = await getAvatar(owner.id, stranger.token)
  assert.equal(refused.status, 404, 'a signed-in stranger')
  // the same answer as for an account with no picture at all, so ids cannot be walked
  assert.equal((await getAvatar(stranger.id, friend.token)).status, refused.status)
  assert.equal((await getAvatar(999999, stranger.token)).status, refused.status)

  // a guest who came in with a code sees the people of that server only
  const guest = (await srv.call('POST', '/api/join', { code: code.code, screenName: 'Visitor' })).data
  assert.ok(guest && guest.guestToken, JSON.stringify(guest))
  assert.equal((await getAvatar(owner.id, guest.guestToken)).status, 200)
  assert.equal((await getAvatar(stranger.id, guest.guestToken)).status, 404)
})
