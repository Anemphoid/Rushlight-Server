// Switching encryption on for an existing server: the owner's password, the preview of what will be wiped, the wipe
// itself (messages, pictures, and the words lingering in the database files), and what is and is not touched.
// Real server process.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { createECDH } from 'node:crypto'
import { readFileSync, existsSync } from 'node:fs'
import Database from 'better-sqlite3'
import { startServer, newAccount } from './helpers.js'
import { JPEG } from './image-fixtures.js'

const NEW = { 'x-rushlight-client': '0.28.0' }
let srv
before(async () => {
  srv = await startServer({ env: { ACCOUNT_LIMIT: '1000', DEVICE_LIMIT: '1000', ACCOUNT_SECRETS_LIMIT: '1000' } })
})
after(async () => {
  await srv.stop()
})

const call = (method, path, body, token, headers = {}) =>
  fetch(srv.url + path, {
    method,
    headers: { 'content-type': 'application/json', ...(token ? { authorization: 'Bearer ' + token } : {}), ...headers },
    body: body === undefined ? undefined : JSON.stringify(body)
  }).then(async (res) => ({ status: res.status, data: await res.json().catch(() => null) }))
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

async function world({ device = true } = {}) {
  const owner = await newAccount(srv)
  const s = (await call('POST', '/api/servers', { name: 'Old' }, owner.token)).data
  const code = (await call('POST', `/api/servers/${s.id}/codes`, { singleUse: false, expiresInMinutes: null }, owner.token)).data
  const member = await newAccount(srv)
  await call('POST', '/api/servers/join', { code: code.code }, member.token)
  const channel = (await call('POST', `/api/servers/${s.id}/channels`, { name: 'chat', mode: 'both', persistent: true }, owner.token)).data
  const room = (await call('POST', `/api/servers/${s.id}/channels/${channel.id}/rooms`, { name: 'side', mode: 'text', persistent: false }, owner.token)).data
  if (device) await call('POST', '/api/devices', { publicKey: pub(), label: 'pc' }, owner.token)
  return { owner, member, s, channel, room, password: 'password123' }
}
const say = (w, space, text, who = w.owner) => call('POST', `/api/${space}/messages`, { text }, who.token)
const picture = (w, who = w.member) =>
  fetch(srv.url + `/api/channels/${w.channel.id}/images`, { method: 'POST', headers: { 'content-type': 'image/jpeg', authorization: 'Bearer ' + who.token }, body: JPEG })
const enable = (w, body = {}, headers = NEW, who = w.owner) =>
  call('POST', `/api/servers/${w.s.id}/encryption/enable`, { password: w.password, wipe: true, ...body }, who.token, headers)

test('the preview is the owner’s alone and counts what would be wiped', async () => {
  const w = await world()
  await say(w, `channels/${w.channel.id}`, 'hello there')
  await say(w, `rooms/${w.room.id}`, 'in the side room', w.member)
  assert.equal((await picture(w)).status, 200)
  assert.equal((await call('GET', `/api/servers/${w.s.id}/encryption`, undefined, w.member.token)).status, 403)
  const p = (await call('GET', `/api/servers/${w.s.id}/encryption`, undefined, w.owner.token)).data
  assert.deepEqual({ ...p }, { enabled: false, epoch: 0, plainMessages: 3, plainPictures: 1, members: 2, membersReady: 1, minClient: p.minClient })
})

test('it needs the password, the owner, an app new enough, a device, and the wipe confirmed', async () => {
  const w = await world()
  await say(w, `channels/${w.channel.id}`, 'keep me safe')
  assert.equal((await enable(w, { password: '' })).status, 400)
  assert.equal((await enable(w, { password: 'wrong-password' })).status, 401)
  assert.equal((await enable(w, {}, NEW, w.member)).status, 403)
  const old = await enable(w, {}, { 'x-rushlight-client': '0.21.0' })
  assert.equal(old.status, 426)
  assert.equal(old.data.reason, 'client_too_old')
  const noWipe = await enable(w, { wipe: false })
  assert.equal(noWipe.status, 409)
  assert.equal(noWipe.data.reason, 'wipe_required')
  assert.equal(noWipe.data.plainMessages, 1)
  const bare = await world({ device: false })
  assert.equal((await enable(bare)).data.reason, 'owner_needs_device')
  // nothing happened to any of them
  assert.equal(rows('SELECT e2ee_enabled FROM servers WHERE id = ?', w.s.id)[0].e2ee_enabled, 0)
  assert.equal(rows('SELECT COUNT(*) AS n FROM messages WHERE channel_id = ?', w.channel.id)[0].n, 1)
})

test('switching on wipes every message and picture of that server only, leaves no old words in the database files, and cannot be repeated', async () => {
  const w = await world()
  const other = await world()
  const WORDS = 'ZEBRA-LANTERN-OLD-SECRET-' + Date.now()
  await say(w, `channels/${w.channel.id}`, WORDS)
  await say(w, `rooms/${w.room.id}`, WORDS + ' again', w.member)
  assert.equal((await picture(w)).status, 200)
  await say(other, `channels/${other.channel.id}`, 'another server, untouched')
  assert.equal((await picture(other, other.member)).status, 200)

  const r = await enable(w)
  assert.equal(r.status, 200, JSON.stringify(r.data))
  assert.deepEqual(r.data, { enabled: true, wiped: { messages: 3, pictures: 1 } })

  assert.deepEqual({ ...rows('SELECT e2ee_enabled, e2ee_epoch, rekey_needed FROM servers WHERE id = ?', w.s.id)[0] }, { e2ee_enabled: 1, e2ee_epoch: 0, rekey_needed: 0 })
  assert.equal(rows('SELECT COUNT(*) AS n FROM messages WHERE channel_id = ? OR room_id = ?', w.channel.id, w.room.id)[0].n, 0)
  assert.equal(rows('SELECT COUNT(*) AS n FROM message_images WHERE message_id NOT IN (SELECT id FROM messages)')[0].n, 0, 'no picture is left without its message')
  assert.equal(rows('SELECT COUNT(*) AS n FROM messages WHERE channel_id = ?', other.channel.id)[0].n, 2, 'another server keeps its messages (the text and the picture message)')
  assert.equal(rows('SELECT COUNT(*) AS n FROM message_images mi JOIN messages m ON m.id = mi.message_id WHERE m.channel_id = ?', other.channel.id)[0].n, 1, 'and its picture')

  // the text is gone from the files on disk, not just from the tables
  for (const file of [srv.dbPath, srv.dbPath + '-wal']) {
    if (existsSync(file)) assert.equal(readFileSync(file).includes(Buffer.from(WORDS)), false, `${file} still holds the old words`)
  }

  // plain text is refused from now on, and a second switch-on is refused
  assert.equal((await say(w, `channels/${w.channel.id}`, 'plain again')).status, 426, 'an app that cannot encrypt is turned away')
  assert.equal((await call('POST', `/api/channels/${w.channel.id}/messages`, { text: 'plain again' }, w.owner.token, NEW)).status, 400, 'and plain text from a new one is refused')
  const again = await enable(w)
  assert.equal(again.status, 409)
  assert.equal(again.data.reason, 'already_enabled')
  const p = (await call('GET', `/api/servers/${w.s.id}/encryption`, undefined, w.owner.token)).data
  assert.equal(p.enabled, true)
  assert.equal(p.plainMessages, 0)
})

test('with nothing to wipe it goes straight through, and the first key can then be made', async () => {
  const w = await world()
  const r = await enable(w, { wipe: undefined })
  assert.equal(r.status, 200)
  assert.deepEqual(r.data.wiped, { messages: 0, pictures: 0 })
  const dev = (await call('GET', '/api/devices', undefined, w.owner.token)).data.devices[0]
  const key = await call(
    'POST',
    `/api/servers/${w.s.id}/rekey`,
    { epoch: 1, senderDeviceId: dev.id, envelopes: [{ recipientDeviceId: dev.id, data: 'A'.repeat(80) }] },
    w.owner.token,
    NEW
  )
  assert.equal(key.status, 200, JSON.stringify(key.data))
  // the other member has no device yet; the server still lists them
  const state = (await call('GET', `/api/servers/${w.s.id}`, undefined, w.member.token, NEW)).data.e2ee
  assert.equal(state.enabled, true)
  assert.equal(state.epoch, 1)
})
