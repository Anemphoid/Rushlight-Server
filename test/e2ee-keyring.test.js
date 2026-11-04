// The keyring backup: the person's server keys sealed on their computer under a key made from their recovery words, stored
// blind; and a waiting computer approving itself by proving it knows the words, without sending them. Real server process.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { createECDH, createHash, randomBytes } from 'node:crypto'
import Database from 'better-sqlite3'
import { startServer } from './helpers.js'

const CLIENT = { 'x-rushlight-client': '0.31.0' }
let srv
before(async () => {
  srv = await startServer({ env: { ACCOUNT_LIMIT: '1000', DEVICE_LIMIT: '1000', ACCOUNT_SECRETS_LIMIT: '1000', REGISTER_LIMIT: '1000' } })
})
after(async () => {
  await srv.stop()
})

const call = (method, path, body, token, headers = CLIENT) =>
  fetch(srv.url + path, {
    method,
    headers: { 'content-type': 'application/json', ...(token ? { authorization: 'Bearer ' + token } : {}), ...headers },
    body: body === undefined ? undefined : JSON.stringify(body)
  }).then(async (res) => ({ status: res.status, data: await res.json().catch(() => null) }))
const dbAll = (sql, ...a) => {
  const db = new Database(srv.dbPath, { readonly: true })
  try {
    return db.prepare(sql).all(...a)
  } finally {
    db.close()
  }
}
let n = 0
// an account whose recovery key has been confirmed, as the sign-up screen does
async function person() {
  const r = await call('POST', '/api/register', { username: `keyring${++n}x`, password: 'password123' })
  assert.equal(r.status, 200, JSON.stringify(r.data))
  assert.equal((await call('POST', '/api/me/recovery-key/ack', {}, r.data.token)).status, 200)
  return { token: r.data.token, words: r.data.recoveryKey, name: `keyring${n}x`, id: r.data.id }
}
const blob = () => `rlk1.${randomBytes(12).toString('base64url')}.${randomBytes(80).toString('base64url')}`
// a proof and the hash of it, as the app derives from the words
const proofOf = () => {
  const bytes = randomBytes(32)
  return { proof: bytes.toString('base64url'), hash: createHash('sha256').update(bytes).digest('hex') }
}
const device = async (p, label = 'pc') => {
  const e = createECDH('prime256v1')
  e.generateKeys()
  const r = await call('POST', '/api/devices', { publicKey: e.getPublicKey().toString('base64url'), label }, p.token)
  assert.equal(r.status, 200, JSON.stringify(r.data))
  return r.data
}

test('there is no backup until one is made, and reading it needs the session', async () => {
  const p = await person()
  const r = await call('GET', '/api/me/keyring', undefined, p.token)
  assert.deepEqual(r.data, { exists: false, version: 0, updatedAt: null })
  assert.equal((await call('GET', '/api/me/keyring', undefined, null)).status, 401)
})

test('the first backup needs the recovery key itself; a wrong key or none is refused and nothing is stored', async () => {
  const p = await person()
  const { hash } = proofOf()
  const put = (extra) => call('PUT', '/api/me/keyring', { blob: blob(), proofHash: hash, baseVersion: 0, ...extra }, p.token)
  assert.equal((await put({})).status, 401)
  const wrong = await put({ recoveryKey: 'abandon '.repeat(12).trim() })
  assert.equal(wrong.status, 401)
  assert.equal(wrong.data.reason, 'bad_recovery_key')
  assert.equal((await call('GET', '/api/me/keyring', undefined, p.token)).data.exists, false)
  const ok = await put({ recoveryKey: p.words.toUpperCase().replace(/ /g, ' - ') })
  assert.equal(ok.status, 200, JSON.stringify(ok.data))
  assert.equal(ok.data.version, 1)
  const got = (await call('GET', '/api/me/keyring?blob=1', undefined, p.token)).data
  assert.equal(got.exists, true)
  assert.ok(got.blob.startsWith('rlk1.'))
  assert.equal((await call('GET', '/api/me/keyring', undefined, p.token)).data.blob, undefined, 'the blob only comes when asked for')
})

test('an account that never confirmed a recovery key cannot make one', async () => {
  const r = await call('POST', '/api/register', { username: `keyring${++n}x`, password: 'password123' })
  const res = await call('PUT', '/api/me/keyring', { blob: blob(), proofHash: proofOf().hash, baseVersion: 0, recoveryKey: r.data.recoveryKey }, r.data.token)
  assert.equal(res.status, 409)
  assert.equal(res.data.reason, 'no_recovery_key')
})

test('updates with the same proof need only the session and the current version; the last three blobs are kept', async () => {
  const p = await person()
  const { hash } = proofOf()
  let v = 0
  const first = await call('PUT', '/api/me/keyring', { blob: blob(), proofHash: hash, baseVersion: v, recoveryKey: p.words }, p.token)
  v = first.data.version
  for (let i = 0; i < 5; i++) {
    const r = await call('PUT', '/api/me/keyring', { blob: blob(), proofHash: hash, baseVersion: v }, p.token)
    assert.equal(r.status, 200, JSON.stringify(r.data))
    v = r.data.version
  }
  assert.equal(v, 6)
  const stale = await call('PUT', '/api/me/keyring', { blob: blob(), proofHash: hash, baseVersion: 2 }, p.token)
  assert.equal(stale.status, 409)
  assert.equal(stale.data.reason, 'version_conflict')
  assert.equal(stale.data.version, 6)
  assert.equal(dbAll('SELECT COUNT(*) AS n FROM keyring_history WHERE account_id = ?', p.id)[0].n, 3)
  for (const bad of ['rlk1.x.y', 'hello', blob() + '!', 'a'.repeat(5), 12]) {
    assert.equal((await call('PUT', '/api/me/keyring', { blob: bad, proofHash: hash, baseVersion: v }, p.token)).status, 400)
  }
  assert.equal((await call('PUT', '/api/me/keyring', { blob: blob(), proofHash: 'nothex', baseVersion: v }, p.token)).status, 400)
})

test('a session cannot plant a proof of its own: changing the proof needs the recovery key', async () => {
  const p = await person()
  const real = proofOf()
  await call('PUT', '/api/me/keyring', { blob: blob(), proofHash: real.hash, baseVersion: 0, recoveryKey: p.words }, p.token)
  const attacker = proofOf()
  const planted = await call('PUT', '/api/me/keyring', { blob: blob(), proofHash: attacker.hash, baseVersion: 1 }, p.token)
  assert.equal(planted.status, 401, 'a different proof without the words is refused')
  const w = await device(p, 'desktop')
  const x = await device(p, 'rogue')
  assert.equal(w.approved, true)
  assert.equal(x.approved, false)
  const r = await call('POST', `/api/devices/${x.id}/recover`, { proof: attacker.proof }, p.token)
  assert.equal(r.status, 401, 'the attacker\'s own proof does not approve anything')
  assert.equal((await call('POST', `/api/devices/${x.id}/recover`, { proof: real.proof }, p.token)).status, 200, 'the real one does')
})

test('a waiting computer approves itself with the proof and nothing else, a wrong proof is counted, and an approved computer has nothing to recover', async () => {
  const p = await person()
  const real = proofOf()
  const keep = await device(p, 'desktop')
  const waiting = await device(p, 'laptop')
  // no backup yet: nothing can match
  assert.equal((await call('POST', `/api/devices/${waiting.id}/recover`, { proof: real.proof }, p.token)).status, 401)
  await call('PUT', '/api/me/keyring', { blob: blob(), proofHash: real.hash, baseVersion: 0, recoveryKey: p.words }, p.token)
  assert.equal((await call('POST', `/api/devices/${keep.id}/recover`, { proof: real.proof }, p.token)).status, 404)
  for (const proof of [randomBytes(32).toString('base64url'), 'short', undefined, 12]) {
    assert.equal((await call('POST', `/api/devices/${waiting.id}/recover`, { proof }, p.token)).status, 401)
  }
  const ok = await call('POST', `/api/devices/${waiting.id}/recover`, { proof: real.proof }, p.token)
  assert.equal(ok.status, 200)
  assert.equal(ok.data.device.approved, true)
  assert.equal(dbAll('SELECT approved_by FROM device_keys WHERE id = ?', waiting.id)[0].approved_by, null)
  // someone else's computer
  const other = await person()
  const theirs = await device(other, 'a')
  const theirsWaiting = await device(other, 'b')
  assert.equal((await call('POST', `/api/devices/${theirsWaiting.id}/recover`, { proof: real.proof }, p.token)).status, 404)
  void theirs
})

test('too many wrong proofs and the route waits', async () => {
  const p = await person()
  const real = proofOf()
  await device(p, 'desktop')
  const waiting = await device(p, 'laptop')
  await call('PUT', '/api/me/keyring', { blob: blob(), proofHash: real.hash, baseVersion: 0, recoveryKey: p.words }, p.token)
  const codes = []
  for (let i = 0; i < 9; i++) codes.push((await call('POST', `/api/devices/${waiting.id}/recover`, { proof: randomBytes(32).toString('base64url') }, p.token)).status)
  assert.equal(codes.at(-1), 429, JSON.stringify(codes))
  assert.equal((await call('POST', `/api/devices/${waiting.id}/recover`, { proof: real.proof }, p.token)).status, 429, 'even the right one waits')
})

test('a forgotten password resets with the recovery key and keeps the devices and the backup; deleting the account removes the backup', async () => {
  const p = await person()
  const real = proofOf()
  const d = await device(p, 'desktop')
  await call('PUT', '/api/me/keyring', { blob: blob(), proofHash: real.hash, baseVersion: 0, recoveryKey: p.words }, p.token)
  const reset = await call('POST', '/api/recover', { username: p.name, key: p.words, newPassword: 'a-brand-new-password' })
  assert.equal(reset.status, 200, JSON.stringify(reset.data))
  assert.ok(reset.data.recoveryKey, 'a new key is issued')
  const t = reset.data.token
  assert.equal((await call('GET', '/api/me/keyring', undefined, t)).data.exists, true, 'the backup stays')
  const devices = (await call('GET', '/api/devices', undefined, t)).data.devices
  assert.deepEqual(devices.map((x) => [x.id, x.approved]), [[d.id, true]], 'the computer is still approved')
  // after the new key is confirmed, the backup is made again under it (that is the app's job; here: the new words are accepted)
  assert.equal((await call('POST', '/api/me/recovery-key/ack', {}, t)).status, 200)
  const again = proofOf()
  const rekey = await call('PUT', '/api/me/keyring', { blob: blob(), proofHash: again.hash, baseVersion: 1, recoveryKey: reset.data.recoveryKey }, t)
  assert.equal(rekey.status, 200, JSON.stringify(rekey.data))
  assert.equal((await call('PUT', '/api/me/keyring', { blob: blob(), proofHash: proofOf().hash, baseVersion: 2, recoveryKey: p.words }, t)).status, 401, 'the old words no longer work')
  // deleting the account takes the backup and its history with it
  const del = await call('DELETE', '/api/me', { password: 'a-brand-new-password' }, t)
  assert.equal(del.status, 200, JSON.stringify(del.data))
  assert.equal(dbAll('SELECT COUNT(*) AS n FROM keyring_history WHERE account_id = ?', p.id)[0].n, 0)
})
