// The new-computer gate: a computer that signs in to an account that already has an approved computer is handed no
// keys until an approved computer of that account vouches for it. Real server process; the "computers" are P-256 keys
// made here, and the challenge is opened with the same ECIES the app uses.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { createECDH, createDecipheriv, hkdfSync, randomBytes } from 'node:crypto'
import Database from 'better-sqlite3'
import { startServer, newAccount } from './helpers.js'

const CLIENT = { 'x-rushlight-client': '0.30.0' }
let srv
before(async () => {
  srv = await startServer({ env: { ACCOUNT_LIMIT: '1000', DEVICE_LIMIT: '1000', ACCOUNT_SECRETS_LIMIT: '1000' } })
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
const dbRun = (sql, ...a) => {
  const db = new Database(srv.dbPath)
  try {
    return db.prepare(sql).run(...a)
  } finally {
    db.close()
  }
}
const dbAll = (sql, ...a) => {
  const db = new Database(srv.dbPath, { readonly: true })
  try {
    return db.prepare(sql).all(...a)
  } finally {
    db.close()
  }
}

// a "computer": a P-256 key pair, as the app makes
function computer() {
  const e = createECDH('prime256v1')
  e.generateKeys()
  return { ecdh: e, publicKey: e.getPublicKey().toString('base64url') }
}
// the inverse of the server's sealToDevice, as the app does it with WebCrypto
function open(pc, sealed, info) {
  const raw = Buffer.from(sealed, 'base64url')
  const eph = raw.subarray(0, 65)
  const iv = raw.subarray(65, 77)
  const ct = raw.subarray(77, raw.length - 16)
  const tag = raw.subarray(raw.length - 16)
  const key = Buffer.from(hkdfSync('sha256', pc.ecdh.computeSecret(eph), Buffer.alloc(0), Buffer.from(info), 32))
  const d = createDecipheriv('aes-256-gcm', key, iv)
  d.setAAD(Buffer.from(info))
  d.setAuthTag(tag)
  return Buffer.concat([d.update(ct), d.final()])
}
async function register(account, pc, label = 'pc') {
  const r = await call('POST', '/api/devices', { publicKey: pc.publicKey, label }, account.token)
  assert.equal(r.status, 200, JSON.stringify(r.data))
  return r.data
}
// the whole approval from an approved computer, returning the confirm answer
async function approve(account, approverPc, approver, code, password = 'password123') {
  const begin = await call('POST', '/api/devices/approvals', { code, approverDeviceId: approver.id }, account.token)
  if (begin.status !== 200) return { begin }
  const proof = open(approverPc, begin.data.challenge, `rushlight-approval-v1|${begin.data.approvalId}|${approver.id}`).toString('base64url')
  return { begin, confirm: await call('POST', `/api/devices/approvals/${begin.data.approvalId}/confirm`, { password, proof }, account.token) }
}

test('an account\'s first computer is approved at once; a second one waits and is shown a code', async () => {
  const me = await newAccount(srv)
  const a = computer()
  const first = await register(me, a, 'desktop')
  assert.equal(first.approved, true)
  assert.equal(first.pairing, undefined)
  const b = computer()
  const second = await register(me, b, 'laptop')
  assert.equal(second.approved, false)
  assert.match(second.pairing.code, /^[0-9A-Z]{4}-[0-9A-Z]{4}$/)
  assert.ok(second.pairing.expiresAt > Date.now() + 4 * 60 * 1000 && second.pairing.expiresAt <= Date.now() + 5 * 60 * 1000 + 1000)
  const mine = (await call('GET', '/api/devices', undefined, me.token)).data.devices
  assert.deepEqual(mine.map((d) => d.approved), [true, false])
  assert.equal(JSON.stringify(mine).includes(second.pairing.code), false, 'the code is shown once, to the new computer')
  // registering the same key again changes nothing and shows no code
  const again = await register(me, b, 'laptop')
  assert.equal(again.created, false)
  assert.equal(again.pairing, undefined)
})

test('a waiting computer is not wrapped to: it is not in the member list, and an envelope for it is refused', async () => {
  const owner = await newAccount(srv)
  const s = (await call('POST', '/api/servers', { name: 'Gate' }, owner.token)).data
  const a = computer()
  const b = computer()
  const first = await register(owner, a, 'desktop')
  const second = await register(owner, b, 'laptop')
  const list = (await call('GET', `/api/servers/${s.id}/devices`, undefined, owner.token)).data.devices
  assert.deepEqual(list.map((d) => d.id), [first.id])
  dbRun('UPDATE servers SET e2ee_enabled = 1 WHERE id = ?', s.id)
  const rekey = await call('POST', `/api/servers/${s.id}/rekey`, { epoch: 1, senderDeviceId: first.id, envelopes: [{ recipientDeviceId: first.id, data: 'A'.repeat(80) }] }, owner.token)
  assert.equal(rekey.status, 200, JSON.stringify(rekey.data))
  const toWaiting = await call('POST', `/api/servers/${s.id}/key-envelopes`, { epoch: 1, senderDeviceId: first.id, envelopes: [{ recipientDeviceId: second.id, data: 'B'.repeat(80) }] }, owner.token)
  assert.equal(toWaiting.status, 400)
  const fromWaiting = await call('POST', `/api/servers/${s.id}/key-envelopes`, { epoch: 1, senderDeviceId: second.id, envelopes: [{ recipientDeviceId: first.id, data: 'B'.repeat(80) }] }, owner.token)
  assert.equal(fromWaiting.status, 400, 'a waiting computer cannot hand out keys either')
})

test('approving: the code, the password and a proof from an approved computer make the new one approved, and then it is wrapped to', async () => {
  const me = await newAccount(srv)
  const s = (await call('POST', '/api/servers', { name: 'Gate2' }, me.token)).data
  const a = computer()
  const b = computer()
  const first = await register(me, a, 'desktop')
  const second = await register(me, b, 'laptop')
  const r = await approve(me, a, first, second.pairing.code.toLowerCase().replace('-', ' '))
  assert.equal(r.begin.data.device.label, 'laptop')
  assert.equal(r.confirm.status, 200, JSON.stringify(r.confirm.data))
  assert.equal(r.confirm.data.device.approved, true)
  const row = dbAll('SELECT approved_by, pairing_hash FROM device_keys WHERE id = ?', second.id)[0]
  assert.equal(row.approved_by, first.id)
  assert.equal(row.pairing_hash, null, 'the code is spent')
  const list = (await call('GET', `/api/servers/${s.id}/devices`, undefined, me.token)).data.devices
  assert.deepEqual(list.map((d) => d.id), [first.id, second.id])
  const again = await approve(me, a, first, second.pairing.code)
  assert.equal(again.begin.status, 404, 'a used code does nothing')
})

test('a wrong code, an old code, and too many wrong codes are refused', async () => {
  const me = await newAccount(srv)
  const a = computer()
  const first = await register(me, a)
  const second = await register(me, computer(), 'laptop')
  const bad = await call('POST', '/api/devices/approvals', { code: 'ZZZZ-ZZZZ', approverDeviceId: first.id }, me.token)
  assert.equal(bad.status, 404)
  assert.equal(bad.data.reason, 'bad_code')
  assert.equal((await call('POST', '/api/devices/approvals', { code: 'nonsense', approverDeviceId: first.id }, me.token)).status, 404)
  dbRun('UPDATE device_keys SET pairing_expires = ? WHERE id = ?', Date.now() - 1000, second.id)
  assert.equal((await approve(me, a, first, second.pairing.code)).begin.status, 404, 'a code older than 5 minutes is dead')
  // a fresh code works again, and the old one stays dead
  const fresh = (await call('POST', `/api/devices/${second.id}/pairing-code`, {}, me.token)).data.pairing
  assert.notEqual(fresh.code, second.pairing.code)
  const attempts = []
  for (let i = 0; i < 9; i++) attempts.push((await call('POST', '/api/devices/approvals', { code: 'AAAA-AAAA', approverDeviceId: first.id }, me.token)).status)
  assert.equal(attempts.at(-1), 429, JSON.stringify(attempts))
  assert.equal((await approve(me, a, first, fresh.code)).begin.status, 429, 'even the right code waits after too many wrong ones')
})

test('a wrong password is refused, and so is anyone who cannot open the challenge: a stolen password on a new computer cannot approve itself', async () => {
  const me = await newAccount(srv)
  const a = computer() // the real, approved computer
  const x = computer() // the attacker's computer: has the password and a session, not a
  const first = await register(me, a, 'desktop')
  const rogue = await register(me, x, 'rogue')
  // wrong password with a genuine proof
  const wrongPw = await approve(me, a, first, rogue.pairing.code, 'not-the-password')
  assert.equal(wrongPw.confirm.status, 401)
  // the rogue cannot name itself as the approver: it is not approved
  assert.equal((await call('POST', '/api/devices/approvals', { code: rogue.pairing.code, approverDeviceId: rogue.id }, me.token)).status, 400)
  // it can name the real computer as the approver (it has the session), but the challenge is sealed to that computer's key
  const begin = await call('POST', '/api/devices/approvals', { code: rogue.pairing.code, approverDeviceId: first.id }, me.token)
  assert.equal(begin.status, 200)
  const info = `rushlight-approval-v1|${begin.data.approvalId}|${first.id}`
  assert.throws(() => open(x, begin.data.challenge, info), 'the rogue computer cannot open it')
  for (const proof of [randomBytes(32).toString('base64url'), 'short', 12345, undefined]) {
    const r = await call('POST', `/api/devices/approvals/${begin.data.approvalId}/confirm`, { password: 'password123', proof }, me.token)
    assert.ok([403, 404, 429].includes(r.status), `${String(proof)} -> ${r.status}`)
  }
  assert.equal(dbAll('SELECT approved_at FROM device_keys WHERE id = ?', rogue.id)[0].approved_at, null, 'still waiting')
  // an approval belongs to the account that began it
  const other = await newAccount(srv)
  const b2 = await call('POST', '/api/devices/approvals', { code: rogue.pairing.code, approverDeviceId: first.id }, me.token)
  const stolen = await call('POST', `/api/devices/approvals/${b2.data.approvalId}/confirm`, { password: 'password123', proof: 'x'.repeat(43) }, other.token)
  assert.equal(stolen.status, 404)
})

test('a waiting computer can be removed without a new key; an approved one still needs one', async () => {
  const me = await newAccount(srv)
  const s = (await call('POST', '/api/servers', { name: 'Gate3' }, me.token)).data
  dbRun('UPDATE servers SET e2ee_enabled = 1 WHERE id = ?', s.id)
  const first = await register(me, computer(), 'desktop')
  const waiting = await register(me, computer(), 'unknown')
  assert.equal((await call('DELETE', `/api/devices/${waiting.id}`, undefined, me.token)).status, 200)
  assert.equal(dbAll('SELECT rekey_needed FROM servers WHERE id = ?', s.id)[0].rekey_needed, 0)
  assert.equal((await call('DELETE', `/api/devices/${first.id}`, undefined, me.token)).status, 200)
  assert.equal(dbAll('SELECT rekey_needed FROM servers WHERE id = ?', s.id)[0].rekey_needed, 1)
})

test('only 3 computers can wait at once, and a code can only be renewed for your own waiting computer', async () => {
  const me = await newAccount(srv)
  const other = await newAccount(srv)
  const first = await register(me, computer())
  const w = []
  for (let i = 0; i < 3; i++) w.push(await register(me, computer(), 'w' + i))
  const fourth = await call('POST', '/api/devices', { publicKey: computer().publicKey, label: 'w4' }, me.token)
  assert.equal(fourth.status, 409)
  assert.equal(fourth.data.reason, 'too_many_pending')
  assert.equal((await call('POST', `/api/devices/${first.id}/pairing-code`, {}, me.token)).status, 404, 'an approved computer has no code')
  assert.equal((await call('POST', `/api/devices/${w[0].id}/pairing-code`, {}, other.token)).status, 404)
})

test('switching encryption on needs an approved computer', async () => {
  const me = await newAccount(srv)
  const s = (await call('POST', '/api/servers', { name: 'Gate4' }, me.token)).data
  const first = await register(me, computer())
  await call('DELETE', `/api/devices/${first.id}`, undefined, me.token) // the only approved one is gone
  await register(me, computer(), 'new') // so this one waits, with nobody to approve it
  const r = await call('POST', `/api/servers/${s.id}/encryption/enable`, { password: 'password123', wipe: true }, me.token)
  assert.equal(r.status, 409)
  assert.equal(r.data.reason, 'owner_needs_device')
})
