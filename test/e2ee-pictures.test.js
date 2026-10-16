// Encrypted pictures, server side: a sealed upload is stored as opaque bytes next to its sealed message text,
// with only the size and the daily limit checked; plain pictures are refused in an encrypted server and sealed
// ones in a plain server; fetching, ownership, deletion and the client version gate behave as for any picture.
// The bytes here are random: the server cannot tell, and these tests are about that. Real server process.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { createECDH, randomBytes } from 'node:crypto'
import Database from 'better-sqlite3'
import { startServer, newAccount } from './helpers.js'
import { JPEG } from './image-fixtures.js'

const SEALED = 'application/x-rushlight-sealed'
const CLIENT = { 'x-rushlight-client': '0.23.0' }
let srv
before(async () => {
  srv = await startServer({ env: { ACCOUNT_LIMIT: '1000', DEVICE_LIMIT: '1000', IMAGE_LIMIT: '1000', IMAGE_MAX_BYTES: '20000', IMAGE_DAILY_BYTES: '50000' } })
})
after(async () => {
  await srv.stop()
})

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
const pub = () => {
  const e = createECDH('prime256v1')
  e.generateKeys()
  return e.getPublicKey().toString('base64url')
}
const sealedText = (epoch) => `rl1.${epoch}.${randomBytes(12).toString('base64url')}.${randomBytes(60).toString('base64url')}`
// the framed upload body
function frame(text, picture) {
  const t = Buffer.from(text, 'latin1')
  const n = Buffer.alloc(4)
  n.writeUInt32BE(t.length)
  return Buffer.concat([n, t, picture])
}
const picture = (n = 400) => randomBytes(n) // nonce + ciphertext + tag, as far as the server can tell
async function upload(path, body, token, { type = SEALED, headers = CLIENT } = {}) {
  const res = await fetch(srv.url + path, { method: 'POST', headers: { 'content-type': type, authorization: 'Bearer ' + token, ...headers }, body })
  let data = null
  try {
    data = await res.json()
  } catch {
    // no body
  }
  return { status: res.status, data }
}
const rows = (sql, ...a) => {
  const db = new Database(srv.dbPath, { readonly: true })
  try {
    return db.prepare(sql).all(...a)
  } finally {
    db.close()
  }
}

async function world({ encrypted = true } = {}) {
  const owner = await newAccount(srv)
  const s = (await call('POST', '/api/servers', { name: 'Sealed' }, owner.token)).data
  const code = (await call('POST', `/api/servers/${s.id}/codes`, { singleUse: false, expiresInMinutes: null }, owner.token)).data
  const member = await newAccount(srv)
  await call('POST', '/api/servers/join', { code: code.code }, member.token)
  const channel = (await call('POST', `/api/servers/${s.id}/channels`, { name: 'general', mode: 'text', persistent: true }, owner.token)).data
  if (encrypted) {
    const devs = []
    for (const a of [owner, member]) devs.push((await call('POST', '/api/devices', { publicKey: pub(), label: 'pc' }, a.token)).data)
    const db = new Database(srv.dbPath)
    db.prepare('UPDATE servers SET e2ee_enabled = 1 WHERE id = ?').run(s.id)
    db.close()
    const r = await call(
      'POST',
      `/api/servers/${s.id}/rekey`,
      { epoch: 1, senderDeviceId: devs[0].id, envelopes: devs.map((d) => ({ recipientDeviceId: d.id, data: randomBytes(80).toString('base64url') })) },
      owner.token,
      CLIENT
    )
    assert.equal(r.status, 200, JSON.stringify(r.data))
  }
  return { owner, member, s, channel, path: `/api/channels/${channel.id}/images` }
}

test('a sealed picture is stored as the bytes it was sent, with its sealed text as the message', async () => {
  const w = await world()
  const bytes = picture(900)
  const text = sealedText(1)
  const r = await upload(w.path, frame(text, bytes), w.member.token)
  assert.equal(r.status, 200, JSON.stringify(r.data))
  assert.equal(r.data.text, text)
  assert.equal(r.data.encrypted, true)
  assert.equal(r.data.epoch, 1)
  assert.equal(r.data.image.sealed, true)
  assert.equal(r.data.image.mime, SEALED)

  const stored = rows('SELECT mime, width, height, size, data FROM message_images WHERE id = ?', r.data.image.id)[0]
  assert.equal(stored.mime, SEALED)
  assert.equal(stored.size, bytes.length)
  assert.ok(Buffer.from(stored.data).equals(bytes))

  const res = await fetch(`${srv.url}/api/images/${r.data.image.id}`, { headers: { authorization: 'Bearer ' + w.owner.token } })
  assert.equal(res.status, 200)
  assert.equal(res.headers.get('content-type'), 'application/octet-stream')
  assert.equal(res.headers.get('x-content-type-options'), 'nosniff')
  assert.ok(Buffer.from(await res.arrayBuffer()).equals(bytes))

  const list = (await call('GET', `/api/channels/${w.channel.id}/messages`, undefined, w.owner.token, CLIENT)).data.messages
  assert.equal(list.length, 1)
  assert.equal(list[0].image.sealed, true)
  assert.equal(list[0].text, text)
})

test('only members can fetch it, and an outsider is told nothing', async () => {
  const w = await world()
  const r = await upload(w.path, frame(sealedText(1), picture()), w.member.token)
  const outsider = await newAccount(srv)
  const res = await fetch(`${srv.url}/api/images/${r.data.image.id}`, { headers: { authorization: 'Bearer ' + outsider.token } })
  assert.equal(res.status, 404)
  assert.equal((await fetch(`${srv.url}/api/images/${r.data.image.id}`)).status, 401)
})

test('plain pictures are refused in an encrypted server, and sealed ones in a plain server', async () => {
  const w = await world()
  const plain = await upload(w.path, JPEG, w.member.token, { type: 'image/jpeg' })
  assert.equal(plain.status, 400)
  assert.equal(plain.data.reason, 'encryption_required')

  const p = await world({ encrypted: false })
  const sealed = await upload(p.path, frame(sealedText(1), picture()), p.member.token)
  assert.equal(sealed.status, 409)
  assert.equal(sealed.data.reason, 'e2ee_off')
  assert.equal(rows('SELECT COUNT(*) AS n FROM message_images WHERE message_id IN (SELECT id FROM messages WHERE channel_id IN (?, ?))', w.channel.id, p.channel.id)[0].n, 0)
})

test('a body that is not a properly framed sealed picture is refused and nothing is stored', async () => {
  const w = await world()
  const before = rows('SELECT COUNT(*) AS n FROM message_images')[0].n
  const text = sealedText(1)
  const lengthOnly = Buffer.alloc(4)
  lengthOnly.writeUInt32BE(999999)
  const bad = {
    'an empty body': Buffer.alloc(0),
    'only a length': lengthOnly,
    'a text longer than the body': Buffer.concat([lengthOnly, Buffer.from(text), picture()]),
    'a zero length text': Buffer.concat([Buffer.alloc(4), picture()]),
    'text that is not sealed': frame('hello there, this is not sealed text', picture()),
    'an epoch of zero': frame(sealedText(0), picture()),
    'a picture too short to hold a nonce and tag': frame(text, picture(20)),
    'no picture at all': frame(text, Buffer.alloc(0)),
    'a picture over the size limit': frame(text, picture(20000 + 29))
  }
  for (const [name, body] of Object.entries(bad)) {
    const r = await upload(w.path, body, w.member.token)
    assert.equal(r.status, 400, `${name}: ${JSON.stringify(r.data)}`)
    assert.equal(r.data.reason, 'bad_sealed_picture', name)
  }
  assert.equal(rows('SELECT COUNT(*) AS n FROM message_images')[0].n, before)
  assert.equal((await call('GET', `/api/channels/${w.channel.id}/messages`, undefined, w.owner.token, CLIENT)).data.messages.length, 0)
})

test('the biggest allowed picture goes through, and anything much bigger is cut off', async () => {
  const w = await world()
  const biggest = await upload(w.path, frame(sealedText(1), picture(20000 + 28)), w.member.token)
  assert.equal(biggest.status, 200, JSON.stringify(biggest.data))
  const huge = await upload(w.path, frame(sealedText(1), picture(20000 + 14000 + 100)), w.member.token)
  assert.equal(huge.status, 413)
})

test('a picture sealed with a key the server does not have yet is refused', async () => {
  const w = await world()
  const r = await upload(w.path, frame(sealedText(2), picture()), w.member.token)
  assert.equal(r.status, 400)
  assert.equal(r.data.reason, 'unknown_epoch')
})

test('the version gate applies to sealed pictures too', async () => {
  const w = await world()
  const none = await upload(w.path, frame(sealedText(1), picture()), w.member.token, { headers: {} })
  assert.equal(none.status, 426)
  const old = await upload(w.path, frame(sealedText(1), picture()), w.member.token, { headers: { 'x-rushlight-client': '0.21.2' } })
  assert.equal(old.status, 426)
})

test('sealed pictures count against the daily limit by their size', async () => {
  const w = await world()
  const a = await upload(w.path, frame(sealedText(1), picture(19000)), w.member.token)
  const b = await upload(w.path, frame(sealedText(1), picture(19000)), w.member.token)
  assert.equal(a.status, 200)
  assert.equal(b.status, 200)
  const c = await upload(w.path, frame(sealedText(1), picture(19000)), w.member.token) // 57000 > 50000
  assert.equal(c.status, 429)
  // the other person still can
  assert.equal((await upload(w.path, frame(sealedText(1), picture(19000)), w.owner.token)).status, 200)
})

test('a sealed picture goes with its message, and with its author when they delete their account', async () => {
  const w = await world()
  const mine = await upload(w.path, frame(sealedText(1), picture()), w.member.token)
  const theirs = await upload(w.path, frame(sealedText(1), picture()), w.owner.token)
  assert.equal(rows('SELECT COUNT(*) AS n FROM message_images WHERE id IN (?, ?)', mine.data.image.id, theirs.data.image.id)[0].n, 2)
  // deleting the member's account redacts their message and drops its picture
  assert.equal((await call('DELETE', '/api/me', { password: 'password123' }, w.member.token)).status, 200)
  assert.equal(rows('SELECT COUNT(*) AS n FROM message_images WHERE id = ?', mine.data.image.id)[0].n, 0)
  const list = (await call('GET', `/api/channels/${w.channel.id}/messages`, undefined, w.owner.token, CLIENT)).data.messages
  assert.equal(list.find((m) => m.id === mine.data.id).redacted, true)
  assert.equal(list.find((m) => m.id === mine.data.id).image, null)
  assert.equal(list.find((m) => m.id === theirs.data.id).image.sealed, true)
  // deleting the channel removes the rest
  await call('DELETE', `/api/servers/${w.s.id}/channels/${w.channel.id}`, undefined, w.owner.token)
  assert.equal(rows('SELECT COUNT(*) AS n FROM message_images WHERE id = ?', theirs.data.image.id)[0].n, 0)
})

test('the server holds nothing that reveals what a sealed picture is', async () => {
  const w = await world()
  const r = await upload(w.path, frame(sealedText(1), picture(777)), w.member.token)
  const row = rows('SELECT mime, width, height, size FROM message_images WHERE id = ?', r.data.image.id)[0]
  assert.deepEqual({ ...row }, { mime: SEALED, width: 0, height: 0, size: 777 })
})
