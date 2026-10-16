// End-to-end encryption, step 1: the server side. Device keys, wrapped server keys ("envelopes"), epochs,
// encrypted messages, the commands route, the client version gate, and what removal does. The server never
// opens anything, so these tests only make keys of the right shape; real crypto is the client's job.
// Real server process. Encryption cannot be switched on through the API yet, so tests flip the flag in the
// database file the way the later "turn it on" step will.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { createECDH, randomBytes } from 'node:crypto'
import Database from 'better-sqlite3'
import { startServer, newAccount } from './helpers.js'

let srv
before(async () => {
  srv = await startServer({ env: { ACCOUNT_LIMIT: '1000', DEVICE_LIMIT: '1000' } })
})
after(async () => {
  await srv.stop()
})

const CLIENT = { 'x-rushlight-client': '0.22.0' }
async function call(method, path, body, token, headers = {}) {
  const res = await fetch(srv.url + path, {
    method,
    headers: { 'content-type': 'application/json', ...(token ? { authorization: 'Bearer ' + token } : {}), ...headers },
    body: body === undefined ? undefined : JSON.stringify(body)
  })
  let data = null
  try {
    data = await res.json()
  } catch {
    // no body
  }
  return { status: res.status, data }
}
const asClient = (method, path, body, token) => call(method, path, body, token, CLIENT)

const newPublicKey = () => {
  const e = createECDH('prime256v1')
  e.generateKeys()
  return e.getPublicKey().toString('base64url')
}
const wrapped = () => randomBytes(80).toString('base64url') // looks like a wrapped key to the server
const sealed = (epoch, text = 'hello') =>
  `rl1.${epoch}.${randomBytes(12).toString('base64url')}.${randomBytes(Buffer.byteLength(text) + 16).toString('base64url')}`

async function device(account, label = 'laptop') {
  const r = await call('POST', '/api/devices', { publicKey: newPublicKey(), label }, account.token)
  assert.equal(r.status, 200, JSON.stringify(r.data))
  return r.data
}

function setServerFlags(id, sql, ...args) {
  const db = new Database(srv.dbPath)
  db.prepare(`UPDATE servers SET ${sql} WHERE id = ?`).run(...args, id)
  db.close()
}
function readDb(sql, ...args) {
  const db = new Database(srv.dbPath, { readonly: true })
  const rows = db.prepare(sql).all(...args)
  db.close()
  return rows
}

// A server with an owner, an admin and a member, each with one device, a text channel and a text-and-voice room.
async function world({ encrypted = true } = {}) {
  const owner = await newAccount(srv)
  const s = (await call('POST', '/api/servers', { name: 'Sealed' }, owner.token)).data
  const code = (await call('POST', `/api/servers/${s.id}/codes`, { singleUse: false, expiresInMinutes: null }, owner.token)).data
  const join = async () => {
    const a = await newAccount(srv)
    await call('POST', '/api/servers/join', { code: code.code }, a.token)
    return a
  }
  const admin = await join()
  const member = await join()
  await call('POST', `/api/servers/${s.id}/members/${admin.id}/admin`, { admin: true }, owner.token)
  const channel = (await call('POST', `/api/servers/${s.id}/channels`, { name: 'general', mode: 'both', persistent: true }, owner.token)).data
  const room = (await call('POST', `/api/servers/${s.id}/channels/${channel.id}/rooms`, { name: 'side', mode: 'text', persistent: true }, owner.token)).data
  const dev = { owner: await device(owner), admin: await device(admin), member: await device(member) }
  if (encrypted) setServerFlags(s.id, 'e2ee_enabled = 1')
  return { owner, admin, member, s, channel, room, dev, code }
}

// the first epoch, wrapped to everyone
async function firstKey(w) {
  const r = await asClient(
    'POST',
    `/api/servers/${w.s.id}/rekey`,
    {
      epoch: 1,
      senderDeviceId: w.dev.owner.id,
      envelopes: [w.dev.owner, w.dev.admin, w.dev.member].map((d) => ({ recipientDeviceId: d.id, data: wrapped() }))
    },
    w.owner.token
  )
  assert.equal(r.status, 200, JSON.stringify(r.data))
}

// --- devices ---

test('a device key must be a real P-256 point, and signing in is required', async () => {
  const a = await newAccount(srv)
  assert.equal((await call('POST', '/api/devices', { publicKey: newPublicKey() })).status, 401)
  for (const bad of [undefined, '', 'abc', 'A'.repeat(87), 12, null, newPublicKey().slice(1) + '=']) {
    const r = await call('POST', '/api/devices', { publicKey: bad }, a.token)
    assert.equal(r.status, 400, String(bad))
  }
  // 65 bytes of the right length and prefix, but not on the curve
  const offCurve = Buffer.concat([Buffer.from([4]), Buffer.alloc(64, 1)]).toString('base64url')
  assert.equal((await call('POST', '/api/devices', { publicKey: offCurve }, a.token)).status, 400)
  assert.equal((await call('POST', '/api/devices', { publicKey: newPublicKey(), label: 'x'.repeat(41) }, a.token)).status, 400)
})

test('registering the same key twice gives the same device; a person has at most ten', async () => {
  const a = await newAccount(srv)
  const key = newPublicKey()
  const one = await call('POST', '/api/devices', { publicKey: key, label: 'desk' }, a.token)
  const two = await call('POST', '/api/devices', { publicKey: key, label: 'desk' }, a.token)
  assert.equal(one.data.created, true)
  assert.equal(two.data.created, false)
  assert.equal(two.data.id, one.data.id)
  for (let i = 0; i < 9; i++) await device(a)
  const over = await call('POST', '/api/devices', { publicKey: newPublicKey() }, a.token)
  assert.equal(over.status, 409)
  assert.equal(over.data.reason, 'device_limit')
  assert.equal((await call('GET', '/api/devices', undefined, a.token)).data.devices.length, 10)
})

test('only the owner of a device can list or remove it', async () => {
  const a = await newAccount(srv)
  const b = await newAccount(srv)
  const d = await device(a)
  assert.equal((await call('GET', '/api/devices', undefined, b.token)).data.devices.length, 0)
  assert.equal((await call('DELETE', `/api/devices/${d.id}`, undefined, b.token)).status, 404)
  assert.equal((await call('DELETE', `/api/devices/${d.id}`, undefined, a.token)).status, 200)
  assert.equal((await call('DELETE', `/api/devices/${d.id}`, undefined, a.token)).status, 404)
  assert.equal((await call('GET', '/api/devices', undefined, a.token)).data.devices.length, 0)
})

test("a server's device list is for its members, and lists every member's devices", async () => {
  const w = await world()
  const outsider = await newAccount(srv)
  await device(outsider)
  assert.equal((await call('GET', `/api/servers/${w.s.id}/devices`, undefined, outsider.token)).status, 403)
  const r = await call('GET', `/api/servers/${w.s.id}/devices`, undefined, w.member.token)
  assert.equal(r.status, 200)
  assert.deepEqual(r.data.devices.map((d) => d.id).sort(), [w.dev.owner.id, w.dev.admin.id, w.dev.member.id].sort())
  assert.ok(r.data.devices.every((d) => typeof d.publicKey === 'string' && d.accountId && d.username))
  assert.equal(r.data.epoch, 0)
})

// --- the key: epochs and envelopes ---

test('the first key must reach every member device or it is refused, and only admins can make one', async () => {
  const w = await world()
  const path = `/api/servers/${w.s.id}/rekey`
  const env = (...ds) => ds.map((d) => ({ recipientDeviceId: d.id, data: wrapped() }))
  const body = (epoch, ...ds) => ({ epoch, senderDeviceId: w.dev.owner.id, envelopes: env(...ds) })

  assert.equal((await asClient('POST', path, body(1, w.dev.owner, w.dev.admin, w.dev.member), w.member.token)).status, 403)

  const missing = await asClient('POST', path, body(1, w.dev.owner, w.dev.admin), w.owner.token)
  assert.equal(missing.status, 409)
  assert.equal(missing.data.reason, 'rekey_incomplete')
  assert.deepEqual(missing.data.missing, [w.dev.member.id])

  const stranger = await device(await newAccount(srv))
  const wrong = await asClient('POST', path, body(1, w.dev.owner, w.dev.admin, w.dev.member, stranger), w.owner.token)
  assert.equal(wrong.status, 400, 'a device that is not a member\'s cannot get the key')

  assert.equal((await asClient('POST', path, body(2, w.dev.owner, w.dev.admin, w.dev.member), w.owner.token)).data.reason, 'epoch_changed')
  const ok = await asClient('POST', path, body(1, w.dev.owner, w.dev.admin, w.dev.member), w.owner.token)
  assert.deepEqual(ok.data, { epoch: 1 })
  assert.equal(readDb('SELECT COUNT(*) AS n FROM key_envelopes WHERE server_id = ?', w.s.id)[0].n, 3)
  // the same epoch again is stale
  assert.equal((await asClient('POST', path, body(1, w.dev.owner, w.dev.admin, w.dev.member), w.owner.token)).data.reason, 'epoch_changed')
})

test('a rekey sent from someone else\'s device, or on a server without encryption, is refused', async () => {
  const w = await world()
  const all = [w.dev.owner, w.dev.admin, w.dev.member].map((d) => ({ recipientDeviceId: d.id, data: wrapped() }))
  const theirs = await asClient('POST', `/api/servers/${w.s.id}/rekey`, { epoch: 1, senderDeviceId: w.dev.admin.id, envelopes: all }, w.owner.token)
  assert.equal(theirs.status, 400)
  const plain = await world({ encrypted: false })
  const r = await asClient(
    'POST',
    `/api/servers/${plain.s.id}/rekey`,
    { epoch: 1, senderDeviceId: plain.dev.owner.id, envelopes: [plain.dev.owner, plain.dev.admin, plain.dev.member].map((d) => ({ recipientDeviceId: d.id, data: wrapped() })) },
    plain.owner.token
  )
  assert.equal(r.status, 409)
  assert.equal(r.data.reason, 'e2ee_off')
})

test('envelope data must look like a wrapped key', async () => {
  const w = await world()
  for (const bad of [undefined, '', 'short', 'has spaces and is long enough to pass the size check ok', 5, 'A'.repeat(2000)]) {
    const r = await asClient(
      'POST',
      `/api/servers/${w.s.id}/rekey`,
      { epoch: 1, senderDeviceId: w.dev.owner.id, envelopes: [w.dev.owner, w.dev.admin, w.dev.member].map((d) => ({ recipientDeviceId: d.id, data: bad })) },
      w.owner.token
    )
    assert.equal(r.status, 400, String(bad))
  }
})

test('a member reads only the envelopes for their own device, and can hand a key to a new device without overwriting', async () => {
  const w = await world()
  await firstKey(w)
  const mine = await asClient('GET', `/api/servers/${w.s.id}/key-envelopes?deviceId=${w.dev.member.id}`, undefined, w.member.token)
  assert.equal(mine.status, 200)
  assert.equal(mine.data.epoch, 1)
  assert.deepEqual(mine.data.envelopes.map((e) => e.epoch), [1])
  assert.equal(mine.data.envelopes[0].senderDeviceId, w.dev.owner.id)
  // someone else's device, and a device id that is not a number, are refused
  assert.equal((await asClient('GET', `/api/servers/${w.s.id}/key-envelopes?deviceId=${w.dev.admin.id}`, undefined, w.member.token)).status, 400)
  assert.equal((await asClient('GET', `/api/servers/${w.s.id}/key-envelopes?deviceId=abc`, undefined, w.member.token)).status, 400)

  // the member signs in on a second computer; the admin wraps the key to it
  const second = await device(w.member, 'second computer')
  const empty = await asClient('GET', `/api/servers/${w.s.id}/key-envelopes?deviceId=${second.id}`, undefined, w.member.token)
  assert.deepEqual(empty.data.envelopes, [])
  const give = await asClient('POST', `/api/servers/${w.s.id}/key-envelopes`, { epoch: 1, senderDeviceId: w.dev.admin.id, envelopes: [{ recipientDeviceId: second.id, data: wrapped() }] }, w.admin.token)
  assert.deepEqual(give.data, { added: 1, skipped: 0 })
  const got = await asClient('GET', `/api/servers/${w.s.id}/key-envelopes?deviceId=${second.id}`, undefined, w.member.token)
  assert.equal(got.data.envelopes.length, 1)
  const first = got.data.envelopes[0].data

  // trying to swap it for a different one changes nothing
  const swap = await asClient('POST', `/api/servers/${w.s.id}/key-envelopes`, { epoch: 1, senderDeviceId: w.dev.owner.id, envelopes: [{ recipientDeviceId: second.id, data: wrapped() }] }, w.owner.token)
  assert.deepEqual(swap.data, { added: 0, skipped: 1 })
  const still = await asClient('GET', `/api/servers/${w.s.id}/key-envelopes?deviceId=${second.id}`, undefined, w.member.token)
  assert.equal(still.data.envelopes[0].data, first)

  // not for an epoch that does not exist, and not to a stranger's device
  assert.equal((await asClient('POST', `/api/servers/${w.s.id}/key-envelopes`, { epoch: 2, senderDeviceId: w.dev.admin.id, envelopes: [{ recipientDeviceId: second.id, data: wrapped() }] }, w.admin.token)).status, 400)
  const stranger = await device(await newAccount(srv))
  assert.equal((await asClient('POST', `/api/servers/${w.s.id}/key-envelopes`, { epoch: 1, senderDeviceId: w.dev.admin.id, envelopes: [{ recipientDeviceId: stranger.id, data: wrapped() }] }, w.admin.token)).status, 400)
})

test('non-members cannot read or add envelopes', async () => {
  const w = await world()
  await firstKey(w)
  const outsider = await newAccount(srv)
  const od = await device(outsider)
  assert.equal((await asClient('GET', `/api/servers/${w.s.id}/key-envelopes?deviceId=${od.id}`, undefined, outsider.token)).status, 403)
  assert.equal((await asClient('POST', `/api/servers/${w.s.id}/key-envelopes`, { epoch: 1, senderDeviceId: od.id, envelopes: [{ recipientDeviceId: w.dev.member.id, data: wrapped() }] }, outsider.token)).status, 403)
})

// --- who must rekey ---

test('removing or banning someone, revoking a device and deleting an account all ask for a new key', async () => {
  const w = await world()
  await firstKey(w)
  const state = async () => (await call('GET', `/api/servers/${w.s.id}`, undefined, w.owner.token)).data.e2ee
  assert.equal((await state()).rekeyNeeded, false)

  await call('POST', `/api/servers/${w.s.id}/members/${w.member.id}/kick`, undefined, w.owner.token)
  assert.equal((await state()).rekeyNeeded, true)
  // the kicked person's envelope and device are no longer part of the server
  assert.equal(readDb('SELECT COUNT(*) AS n FROM key_envelopes WHERE recipient_device_id = ?', w.dev.member.id)[0].n, 0)
  assert.deepEqual((await call('GET', `/api/servers/${w.s.id}/devices`, undefined, w.owner.token)).data.devices.map((d) => d.id).sort(), [w.dev.owner.id, w.dev.admin.id].sort())

  // a new epoch for the two who remain clears it, and no longer includes the kicked person
  const re = await asClient('POST', `/api/servers/${w.s.id}/rekey`, { epoch: 2, senderDeviceId: w.dev.owner.id, envelopes: [w.dev.owner, w.dev.admin].map((d) => ({ recipientDeviceId: d.id, data: wrapped() })) }, w.owner.token)
  assert.deepEqual(re.data, { epoch: 2 })
  assert.equal((await state()).rekeyNeeded, false)
  assert.equal((await state()).epoch, 2)

  // revoking a device
  const extra = await device(w.admin, 'old phone')
  await call('DELETE', `/api/devices/${extra.id}`, undefined, w.admin.token)
  assert.equal((await state()).rekeyNeeded, true)
  await asClient('POST', `/api/servers/${w.s.id}/rekey`, { epoch: 3, senderDeviceId: w.dev.owner.id, envelopes: [w.dev.owner, w.dev.admin].map((d) => ({ recipientDeviceId: d.id, data: wrapped() })) }, w.owner.token)
  assert.equal((await state()).rekeyNeeded, false)

  // a ban
  const b = await newAccount(srv)
  await call('POST', '/api/servers/join', { code: w.code.code }, b.token)
  await device(b)
  await call('POST', `/api/servers/${w.s.id}/members/${b.id}/ban`, {}, w.owner.token)
  assert.equal((await state()).rekeyNeeded, true)
})

test('deleting an account removes its devices and leaves the others\' envelopes usable', async () => {
  const w = await world()
  await firstKey(w)
  const r = await call('DELETE', '/api/me', { password: 'password123' }, w.member.token)
  assert.equal(r.status, 200)
  assert.equal(readDb('SELECT COUNT(*) AS n FROM device_keys WHERE account_id = ?', w.member.id)[0].n, 0)
  assert.equal(readDb('SELECT COUNT(*) AS n FROM key_envelopes WHERE recipient_device_id = ?', w.dev.member.id)[0].n, 0)
  assert.equal((await call('GET', `/api/servers/${w.s.id}`, undefined, w.owner.token)).data.e2ee.rekeyNeeded, true)
  assert.deepEqual(readDb('PRAGMA foreign_key_check'), [])
})

test('when the person who wrapped a key deletes their account, the envelopes they made stay and still open', async () => {
  const w = await world()
  await firstKey(w) // wrapped by the owner's device, so use the admin as the sender of a later one
  const second = await device(w.member, 'second')
  await asClient('POST', `/api/servers/${w.s.id}/key-envelopes`, { epoch: 1, senderDeviceId: w.dev.admin.id, envelopes: [{ recipientDeviceId: second.id, data: wrapped() }] }, w.admin.token)
  await call('DELETE', '/api/me', { password: 'password123' }, w.admin.token)
  const got = await asClient('GET', `/api/servers/${w.s.id}/key-envelopes?deviceId=${second.id}`, undefined, w.member.token)
  assert.equal(got.data.envelopes.length, 1)
  assert.equal(got.data.envelopes[0].senderDeviceId, null)
})

// --- messages ---

test('an encrypted server refuses plain text and malformed ciphertext, and stores what it is given as it is', async () => {
  const w = await world()
  await firstKey(w)
  const post = (text, token = w.member.token, path = `/api/channels/${w.channel.id}/messages`) => asClient('POST', path, { text }, token)

  const plain = await post('hello there')
  assert.equal(plain.status, 400)
  assert.equal(plain.data.reason, 'encryption_required')
  assert.equal((await post('/play something')).status, 400)
  for (const bad of ['rl1.1.short.short', 'rl2.1.' + 'A'.repeat(16) + '.' + 'B'.repeat(30), 'rl1.0.' + 'A'.repeat(16) + '.' + 'B'.repeat(30), 'rl1.1.' + 'A'.repeat(16) + '.' + 'B'.repeat(12100)]) {
    assert.equal((await post(bad)).status, 400, bad.slice(0, 30))
  }
  assert.equal((await post(sealed(2))).data.reason, 'unknown_epoch')

  const text = sealed(1, 'a secret')
  const ok = await post(text)
  assert.equal(ok.status, 200)
  assert.equal(ok.data.text, text)
  assert.equal(ok.data.encrypted, true)
  assert.equal(ok.data.epoch, 1)
  assert.equal((await post(sealed(1), w.admin.token, `/api/rooms/${w.room.id}/messages`)).status, 200)

  const list = await asClient('GET', `/api/channels/${w.channel.id}/messages`, undefined, w.owner.token)
  assert.deepEqual(list.data.messages.map((m) => [m.text, m.encrypted, m.epoch, m.bot]), [[text, true, 1, false]])
  // what is on disk is exactly the ciphertext
  assert.equal(readDb('SELECT text, enc_epoch FROM messages WHERE channel_id = ?', w.channel.id)[0].text, text)
})

test('no key yet means no messages: epoch 1 does not exist until the first rekey', async () => {
  const w = await world()
  const r = await asClient('POST', `/api/channels/${w.channel.id}/messages`, { text: sealed(1) }, w.member.token)
  assert.equal(r.status, 400)
  assert.equal(r.data.reason, 'unknown_epoch')
})

test('a server without encryption behaves exactly as before: plain text, slash commands, no version needed', async () => {
  const w = await world({ encrypted: false })
  const r = await call('POST', `/api/channels/${w.channel.id}/messages`, { text: '  /help  ' }, w.member.token)
  assert.equal(r.status, 200)
  assert.equal(r.data.text, '/help')
  assert.equal(r.data.encrypted, false)
  assert.equal(r.data.epoch, null)
  const bot = await until(async () => {
    const m = (await call('GET', `/api/channels/${w.channel.id}/messages`, undefined, w.member.token)).data.messages
    return m.find((x) => x.bot)
  })
  assert.match(bot.text, /Jellybox/i)
  assert.equal(bot.encrypted, false)
})

test('the bot answers a command sent on the commands route, in plain text, without a chat message for the command', async () => {
  const w = await world()
  await firstKey(w)
  const r = await asClient('POST', `/api/channels/${w.channel.id}/commands`, { text: '/help' }, w.member.token)
  assert.deepEqual(r.data, { ok: true })
  const bot = await until(async () => {
    const m = (await asClient('GET', `/api/channels/${w.channel.id}/messages`, undefined, w.member.token)).data.messages
    return m.find((x) => x.bot)
  })
  assert.equal(bot.encrypted, false)
  assert.match(bot.text, /Jellybox/i)
  const all = (await asClient('GET', `/api/channels/${w.channel.id}/messages`, undefined, w.member.token)).data.messages
  assert.equal(all.length, 1, 'the command itself is not stored as chat')
  // only commands, only for members
  assert.equal((await asClient('POST', `/api/channels/${w.channel.id}/commands`, { text: 'hello' }, w.member.token)).status, 400)
  assert.equal((await asClient('POST', `/api/channels/${w.channel.id}/commands`, { text: '/' + 'x'.repeat(500) }, w.member.token)).status, 400)
  const outsider = await newAccount(srv)
  assert.equal((await asClient('POST', `/api/channels/${w.channel.id}/commands`, { text: '/help' }, outsider.token)).status, 403)
})

test('pictures are refused in an encrypted server until they are encrypted too', async () => {
  const w = await world()
  await firstKey(w)
  const png = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d49444154789c6360000002000001e221bc330000000049454e44ae426082', 'hex')
  const res = await fetch(srv.url + `/api/channels/${w.channel.id}/images`, {
    method: 'POST',
    headers: { 'content-type': 'image/png', authorization: 'Bearer ' + w.member.token, ...CLIENT },
    body: png
  })
  assert.equal(res.status, 400)
  assert.equal((await res.json()).reason, 'encryption_required')
  assert.equal(readDb('SELECT COUNT(*) AS n FROM message_images')[0].n, 0)
})

// --- the client version gate ---

test('an encrypted server turns away clients that do not say they are new enough', async () => {
  const w = await world()
  await firstKey(w)
  const paths = [
    ['GET', `/api/channels/${w.channel.id}/messages`],
    ['POST', `/api/channels/${w.channel.id}/messages`, { text: sealed(1) }],
    ['POST', `/api/channels/${w.channel.id}/commands`, { text: '/help' }]
  ]
  for (const [m, p, b] of paths) {
    const none = await call(m, p, b, w.member.token)
    assert.equal(none.status, 426, p)
    assert.equal(none.data.reason, 'client_too_old')
    assert.equal(none.data.minClient, '0.22.0')
    assert.equal((await call(m, p, b, w.member.token, { 'x-rushlight-client': '0.21.2' })).status, 426)
    assert.equal((await call(m, p, b, w.member.token, { 'x-rushlight-client': 'banana' })).status, 426)
    assert.equal((await call(m, p, b, w.member.token, { 'x-rushlight-client': '0.22.0' })).status, 200, p)
  }
  assert.equal((await call('GET', `/api/channels/${w.channel.id}/messages`, undefined, w.member.token, { 'x-rushlight-client': 'v1.0.0' })).status, 200)
  // the server's own state stays readable, so an old client can show a useful message
  const info = await call('GET', `/api/servers/${w.s.id}`, undefined, w.member.token)
  assert.equal(info.status, 200)
  assert.deepEqual(info.data.e2ee, { enabled: true, epoch: 1, rekeyNeeded: false, minClient: '0.22.0' })
})

test('the version gate does not touch servers without encryption', async () => {
  const w = await world({ encrypted: false })
  assert.equal((await call('GET', `/api/channels/${w.channel.id}/messages`, undefined, w.member.token)).status, 200)
  assert.equal((await call('GET', `/api/servers/${w.s.id}`, undefined, w.member.token)).data.e2ee.enabled, false)
})

// --- what the server must never be able to do ---

test('nothing in the server can turn encryption on, read a wrapped key or hand a key to the server', async () => {
  const w = await world({ encrypted: false })
  // there is no route that switches it on yet
  for (const [m, p] of [['POST', `/api/servers/${w.s.id}/e2ee`], ['PUT', `/api/servers/${w.s.id}/e2ee`], ['PATCH', `/api/servers/${w.s.id}`]]) {
    await call(m, p, { e2ee_enabled: 1, e2eeEnabled: true, enabled: true }, w.owner.token)
  }
  assert.equal(readDb('SELECT e2ee_enabled FROM servers WHERE id = ?', w.s.id)[0].e2ee_enabled, 0)
  // a rekey on a plain server and a message that claims an epoch are refused (covered above); and the server code
  // imports nothing that could decrypt: only ECDH validation of public keys
  const { readFileSync } = await import('node:fs')
  const src = readFileSync(new URL('../src/e2ee.js', import.meta.url), 'utf8')
  assert.ok(!/createDecipher|createCipher|privateDecrypt|subtle\.decrypt/.test(src))
})

async function until(fn, ms = 8000) {
  const end = Date.now() + ms
  for (;;) {
    const v = await fn()
    if (v) return v
    if (Date.now() > end) throw new Error('timed out waiting')
    await new Promise((r) => setTimeout(r, 100))
  }
}
