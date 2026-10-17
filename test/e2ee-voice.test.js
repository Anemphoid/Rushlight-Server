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

test('an invite made before the server was encrypted cannot bring a guest into it', async () => {
  const w = await world()
  const joined = await call('POST', '/api/join', { code: w.code.code, screenName: 'Visitor' }, undefined, CLIENT)
  assert.equal(joined.status, 409, JSON.stringify(joined.data))
  assert.equal(joined.data.reason, 'old_invite')
  assert.equal(joined.data.guestToken, undefined)
})

async function botMessages(w, id = w.channel.id, n = 1, type = 'channels') {
  let bots = []
  for (let i = 0; i < 50 && bots.length < n; i++) {
    const m = (await call('GET', `/api/${type}/${id}/messages`, undefined, w.owner.token, CLIENT)).data.messages
    bots = m.filter((x) => x.bot)
    if (bots.length < n) await new Promise((r) => setTimeout(r, 100))
  }
  return bots
}
const allow = (w, open, who = w.owner, type = 'channel', id = w.channel.id) =>
  call('PUT', `/api/music/${type}/${id}/allowed`, { open }, who.token, CLIENT)

test("Jellybox is not allowed in an encrypted server's rooms until an admin allows it, and its controls refuse", async () => {
  const w = await world()
  await call('POST', `/api/channels/${w.channel.id}/commands`, { text: '/play something' }, w.owner.token, CLIENT)
  let bot
  for (let i = 0; i < 50 && !bot; i++) {
    const m = (await call('GET', `/api/channels/${w.channel.id}/messages`, undefined, w.owner.token, CLIENT)).data.messages
    bot = m.find((x) => x.bot)
    if (!bot) await new Promise((r) => setTimeout(r, 100))
  }
  assert.match(bot.text, /isn't allowed in this room/)
  const tree = (await call('GET', `/api/servers/${w.s.id}`, undefined, w.owner.token, CLIENT)).data
  assert.equal(tree.channels[0].jellyboxOpen, false)
  const control = await call('POST', `/api/music/channel/${w.channel.id}/control`, { action: 'pause' }, w.owner.token, CLIENT)
  assert.equal(control.status, 409)
  assert.equal(control.data.reason, 'jellybox_closed')
  assert.equal(rows('SELECT COUNT(*) AS n FROM messages WHERE author_account_id IS NULL AND channel_id = ?', w.channel.id)[0].n, 1)
})

test('allowing Jellybox in one room takes only that room out of the end-to-end layer, and says so', async () => {
  const w = await world()
  const room = (await call('POST', `/api/servers/${w.s.id}/channels/${w.channel.id}/rooms`, { name: 'Side', mode: 'both', persistent: true }, w.owner.token)).data
  const first = await allow(w, true, w.owner, 'room', room.id)
  assert.equal(first.status, 200, JSON.stringify(first.data))
  assert.equal(first.data.jellyboxOpen, true)
  // that room: no end-to-end voice, and the token says why; the channel and the server's other voice are unchanged
  const open = await call('POST', '/api/voice/token', { type: 'room', id: room.id }, w.member.token, CLIENT)
  assert.equal(open.data.encrypted, false)
  assert.equal(open.data.jellyboxOpen, true)
  const other = await voiceToken(w, w.member)
  assert.equal(other.data.encrypted, true)
  assert.equal(other.data.jellyboxOpen, undefined)
  const tree = (await call('GET', `/api/servers/${w.s.id}`, undefined, w.member.token, CLIENT)).data.channels[0]
  assert.equal(tree.jellyboxOpen, false)
  assert.equal(tree.rooms[0].jellyboxOpen, true)
  // the room's chat is told, by name, in words that are not an alarm
  const [notice] = await botMessages(w, room.id, 1, 'rooms')
  assert.match(notice.text, /allowed Jellybox in this room/)
  assert.match(notice.text, /Chat stays private/)
  // a command now gets past the gate (there is no library linked here, so it says that instead)
  await call('POST', `/api/rooms/${room.id}/commands`, { text: '/play something' }, w.owner.token, CLIENT)
  const bots = await botMessages(w, room.id, 2, 'rooms')
  assert.doesNotMatch(bots[1].text, /isn't allowed in this room/)
  // allowing it again changes nothing and says nothing
  await allow(w, true, w.owner, 'room', room.id)
  assert.equal((await botMessages(w, room.id, 2, 'rooms')).length, 2)
  // switching it off puts the encryption back
  assert.equal((await allow(w, false, w.owner, 'room', room.id)).status, 200)
  assert.equal((await call('POST', '/api/voice/token', { type: 'room', id: room.id }, w.member.token, CLIENT)).data.encrypted, true)
  assert.match((await botMessages(w, room.id, 3, 'rooms'))[2].text, /end-to-end encrypted again/)
})

test('only an admin can change the switch, only in an encrypted server, only for a space with voice', async () => {
  const w = await world()
  assert.equal((await allow(w, true, w.member)).status, 403)
  assert.equal((await call('PUT', `/api/music/channel/${w.channel.id}/allowed`, { open: 'yes' }, w.owner.token, CLIENT)).status, 400)
  assert.equal((await call('POST', '/api/voice/token', { type: 'channel', id: w.channel.id }, w.member.token, CLIENT)).data.encrypted, true)
  const text = (await call('POST', `/api/servers/${w.s.id}/channels`, { name: 'Notes', mode: 'text', persistent: true }, w.owner.token)).data
  assert.equal((await allow(w, true, w.owner, 'channel', text.id)).status, 400)
  const plain = await world({ encrypted: false })
  const r = await allow(plain, true)
  assert.equal(r.status, 409)
  assert.equal(r.data.reason, 'not_encrypted')
})

test('a voice-only room has no chat to post the notice in, and still switches', async () => {
  const w = await world()
  const vo = (await call('POST', `/api/servers/${w.s.id}/channels`, { name: 'Talk', mode: 'voice', persistent: true }, w.owner.token)).data
  assert.equal((await allow(w, true, w.owner, 'channel', vo.id)).status, 200)
  assert.equal((await call('POST', '/api/voice/token', { type: 'channel', id: vo.id }, w.member.token, CLIENT)).data.encrypted, false)
  assert.equal(rows('SELECT COUNT(*) AS n FROM messages WHERE channel_id = ?', vo.id)[0].n, 0)
})
