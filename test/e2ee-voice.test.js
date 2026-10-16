// Voice in an encrypted server, server side: the clients encrypt the audio themselves, so the server's part is to
// tell them the room is encrypted (and which key epoch), to hand a connection only to an up-to-date member app,
// to keep guests out until invites can carry a key, and to keep Jellybox (server-made audio) out. Real server process.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { createECDH, randomBytes } from 'node:crypto'
import Database from 'better-sqlite3'
import { startServer, newAccount, jwtClaims } from './helpers.js'

const CLIENT = { 'x-rushlight-client': '0.25.0' }
let srv
before(async () => {
  srv = await startServer({ env: { ACCOUNT_LIMIT: '1000', DEVICE_LIMIT: '1000' } })
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
  const s = (await call('POST', '/api/servers', { name: 'Voice' }, owner.token)).data
  const code = (await call('POST', `/api/servers/${s.id}/codes`, { singleUse: false, expiresInMinutes: null }, owner.token)).data
  const member = await newAccount(srv)
  await call('POST', '/api/servers/join', { code: code.code }, member.token)
  const channel = (await call('POST', `/api/servers/${s.id}/channels`, { name: 'Lounge', mode: 'both', persistent: true }, owner.token)).data
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
  return { owner, member, s, channel, code }
}
const voiceToken = (w, who, headers = CLIENT) => call('POST', '/api/voice/token', { type: 'channel', id: w.channel.id }, who.token, headers)

test('a member of an encrypted server is told the room is encrypted, and which key epoch it is on', async () => {
  const w = await world()
  const r = await voiceToken(w, w.member)
  assert.equal(r.status, 200, JSON.stringify(r.data))
  assert.equal(r.data.encrypted, true)
  assert.equal(r.data.epoch, 1)
  assert.equal(r.data.room, `s${w.s.id}-channel-${w.channel.id}`)
  assert.equal(jwtClaims(r.data.token).video.room, r.data.room)
})

test('a server without encryption says so, and needs no version', async () => {
  const w = await world({ encrypted: false })
  const r = await voiceToken(w, w.member, {})
  assert.equal(r.status, 200)
  assert.equal(r.data.encrypted, false)
  assert.equal(r.data.epoch, 0)
})

test('an encrypted server gives no voice connection to an app that cannot encrypt', async () => {
  const w = await world()
  for (const headers of [{}, { 'x-rushlight-client': '0.21.2' }, { 'x-rushlight-client': 'nonsense' }]) {
    const r = await voiceToken(w, w.member, headers)
    assert.equal(r.status, 426, JSON.stringify(headers))
    assert.equal(r.data.reason, 'client_too_old')
    assert.equal(r.data.token, undefined)
  }
})

test("someone who is not a member still gets the usual refusal, not a hint about encryption", async () => {
  const w = await world()
  const outsider = await newAccount(srv)
  const r = await voiceToken(w, outsider)
  assert.equal(r.status, 403)
  assert.equal(r.data.encrypted, undefined)
})

test('a guest cannot join the voice of an encrypted server, and still can in an ordinary one', async () => {
  const w = await world()
  const joined = await call('POST', '/api/join', { code: w.code.code, screenName: 'Visitor' })
  assert.equal(joined.status, 200, JSON.stringify(joined.data))
  const guest = { token: joined.data.guestToken }
  const refused = await voiceToken(w, guest, {})
  assert.equal(refused.status, 409)
  assert.equal(refused.data.reason, 'guest_encrypted')
  assert.equal(refused.data.token, undefined)
  const withVersion = await voiceToken(w, guest)
  assert.equal(withVersion.status, 409)

  const plain = await world({ encrypted: false })
  const g2 = await call('POST', '/api/join', { code: plain.code.code, screenName: 'Visitor Two' })
  const ok = await voiceToken(plain, { token: g2.data.guestToken }, {})
  assert.equal(ok.status, 200)
  assert.equal(ok.data.encrypted, false)
})

test("Jellybox says it isn't available in an encrypted server, and its controls refuse", async () => {
  const w = await world()
  await call('POST', `/api/channels/${w.channel.id}/commands`, { text: '/play something' }, w.owner.token, CLIENT)
  let bot
  for (let i = 0; i < 50 && !bot; i++) {
    const m = (await call('GET', `/api/channels/${w.channel.id}/messages`, undefined, w.owner.token, CLIENT)).data.messages
    bot = m.find((x) => x.bot)
    if (!bot) await new Promise((r) => setTimeout(r, 100))
  }
  assert.match(bot.text, /isn't available in encrypted servers/)
  const control = await call('POST', `/api/music/channel/${w.channel.id}/control`, { action: 'pause' }, w.owner.token, CLIENT)
  assert.equal(control.status, 409)
  assert.equal(control.data.reason, 'encrypted')
  assert.equal(rows('SELECT COUNT(*) AS n FROM messages WHERE author_account_id IS NULL AND channel_id = ?', w.channel.id)[0].n, 1)
})
