// Pictures in chat: what is accepted, what is stripped from it, who can see it, the limits, and that it
// goes away with its message whichever way the message goes. Real server process.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import Database from 'better-sqlite3'
import { inspectImage } from '../src/images.js'
import { startServer, newAccount } from './helpers.js'
import { JPEG, PNG, WEBP, SECRET, jpegWithMetadata, pngWithMetadata, webpWithMetadata, webpSimple, has } from './image-fixtures.js'

// ---- the checker on its own ----
test('a JPEG loses its EXIF, XMP, comment and anything after the end, and keeps its colour profile', () => {
  const r = inspectImage(jpegWithMetadata(), 'image/jpeg')
  assert.ok(r.ok, r.error)
  assert.equal(r.width, 16)
  assert.equal(r.height, 12)
  assert.ok(!has(r.clean, SECRET) && !has(r.clean, 'TRAILER') && !has(r.clean, 'Exif'))
  assert.ok(has(r.clean, 'ICC_PROFILE'))
  assert.deepEqual([...r.clean.subarray(0, 2)], [0xff, 0xd8])
  assert.deepEqual([...r.clean.subarray(-2)], [0xff, 0xd9])
  // the picture itself is untouched: the plain file comes out byte for byte
  assert.ok(inspectImage(JPEG, 'image/jpeg').clean.equals(JPEG))
})

test('a PNG loses text, EXIF, time and trailing chunks, and keeps the picture', () => {
  const r = inspectImage(pngWithMetadata(), 'image/png')
  assert.ok(r.ok, r.error)
  assert.equal(r.width, 16)
  assert.equal(r.height, 12)
  assert.ok(!has(r.clean, SECRET) && !has(r.clean, 'TRAILER'))
  assert.ok(!has(r.clean, 'tEXt') && !has(r.clean, 'eXIf') && !has(r.clean, 'tIME') && !has(r.clean, 'iTXt'))
  assert.ok(r.clean.equals(PNG), 'the plain picture should come out the same')
})

test('a WebP loses EXIF and XMP, the flags that announce them, and still adds up', () => {
  const dirty = webpWithMetadata()
  assert.ok(has(dirty, SECRET))
  const r = inspectImage(dirty, 'image/webp')
  assert.ok(r.ok, r.error)
  assert.equal(r.width, 16)
  assert.equal(r.height, 12)
  assert.ok(!has(r.clean, SECRET) && !has(r.clean, 'EXIF') && !has(r.clean, 'XMP '))
  assert.equal(r.clean.readUInt32LE(4) + 8, r.clean.length, 'the RIFF size must match the file')
  const vp8xAt = r.clean.indexOf('VP8X')
  assert.equal(r.clean[vp8xAt + 8] & (0x08 | 0x04), 0, 'the EXIF and XMP flags must be cleared')
  // the browser's own file comes out the same, and so does the simple kind
  assert.ok(inspectImage(WEBP, 'image/webp').clean.equals(WEBP))
  const simple = webpSimple()
  assert.ok(!simple.includes('VP8X'))
  const s = inspectImage(simple, 'image/webp')
  assert.ok(s.ok && s.clean.equals(simple) && s.width === 16 && s.height === 12)
})

test('things that are not the picture they claim to be are refused', () => {
  const huge = Buffer.from(PNG)
  huge.writeUInt32BE(100000, 16) // width
  huge.writeUInt32BE(100000, 20) // height
  const cases = [
    ['a PNG called a JPEG', PNG, 'image/jpeg'],
    ['a JPEG called a PNG', JPEG, 'image/png'],
    ['text called a PNG', Buffer.from('<html><script>alert(1)</script></html>'), 'image/png'],
    ['a GIF', Buffer.from('GIF89a' + 'x'.repeat(40)), 'image/gif'],
    ['a cut-off JPEG', JPEG.subarray(0, 100), 'image/jpeg'],
    ['a cut-off PNG', PNG.subarray(0, 60), 'image/png'],
    ['a cut-off WebP', WEBP.subarray(0, 30), 'image/webp'],
    ['a WebP cut off between chunks, picture missing', WEBP.subarray(0, WEBP.indexOf('VP8 ')), 'image/webp'],
    ['an enormous picture (decompression bomb)', huge, 'image/png'],
    ['nothing', Buffer.alloc(0), 'image/png']
  ]
  for (const [name, buf, mime] of cases) assert.equal(inspectImage(buf, mime).ok, false, name)
})

// ---- over HTTP ----
let srv
before(async () => {
  srv = await startServer({
    env: { ACCOUNT_LIMIT: '1000', IMAGE_MAX_BYTES: '60000', IMAGE_LIMIT: '1000', RETENTION_EVERY_MS: '600', WIPE_GRACE_MS: '300', PRESENCE_SWEEP_MS: '100' }
  })
})
after(async () => {
  await srv.stop()
})

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
async function until(fn, ms = 8000) {
  const end = Date.now() + ms
  for (;;) {
    const v = await fn()
    if (v) return v
    if (Date.now() > end) throw new Error('timed out waiting')
    await sleep(100)
  }
}
const readDb = () => new Database(srv.dbPath, { readonly: true })
const imageRows = () => {
  const db = readDb()
  try {
    return db.prepare('SELECT id, message_id FROM message_images').all()
  } finally {
    db.close()
  }
}

async function send(path, body, token, { type = 'image/jpeg', query = '', server = srv } = {}) {
  const res = await fetch(server.url + path + query, {
    method: 'POST',
    headers: { 'content-type': type, ...(token ? { authorization: 'Bearer ' + token } : {}) },
    body
  })
  let data = null
  try {
    data = await res.json()
  } catch {
    // no body
  }
  return { status: res.status, data }
}
async function fetchImage(id, token) {
  const res = await fetch(srv.url + `/api/images/${id}`, { headers: token ? { authorization: 'Bearer ' + token } : {} })
  return { status: res.status, headers: res.headers, body: Buffer.from(await res.arrayBuffer()) }
}

async function world(persistent = true) {
  const owner = await newAccount(srv)
  const s = (await srv.call('POST', '/api/servers', { name: 'Pictures' }, owner.token)).data
  const code = (await srv.call('POST', `/api/servers/${s.id}/codes`, { singleUse: false, expiresInMinutes: null }, owner.token)).data
  const member = await newAccount(srv)
  await srv.call('POST', '/api/servers/join', { code: code.code }, member.token)
  const channel = (await srv.call('POST', `/api/servers/${s.id}/channels`, { name: 'chat', mode: 'both', persistent }, owner.token)).data
  const room = (await srv.call('POST', `/api/servers/${s.id}/channels/${channel.id}/rooms`, { name: 'side', mode: 'text', persistent }, owner.token)).data
  return { owner, member, s, channel, room }
}

test('a member sends a picture with a caption; the message carries it and the bytes come back cleaned', async () => {
  const w = await world()
  const dirty = jpegWithMetadata()
  const sent = await send(`/api/channels/${w.channel.id}/images`, dirty, w.member.token, { query: '?text=' + encodeURIComponent('the view  ') })
  assert.equal(sent.status, 200, JSON.stringify(sent.data))
  assert.equal(sent.data.text, 'the view')
  assert.equal(sent.data.author, w.member.username || sent.data.author)
  assert.deepEqual({ ...sent.data.image, id: 0 }, { id: 0, mime: 'image/jpeg', width: 16, height: 12 })

  const listed = (await srv.call('GET', `/api/channels/${w.channel.id}/messages`, undefined, w.owner.token)).data.messages
  assert.equal(listed.length, 1)
  assert.equal(listed[0].image.id, sent.data.image.id)
  assert.equal(JSON.stringify(listed).includes('base64'), false)

  const got = await fetchImage(sent.data.image.id, w.owner.token)
  assert.equal(got.status, 200)
  assert.equal(got.headers.get('content-type'), 'image/jpeg')
  assert.equal(got.headers.get('x-content-type-options'), 'nosniff')
  assert.match(got.headers.get('content-security-policy'), /default-src 'none'/)
  assert.match(got.headers.get('cache-control'), /private/)
  assert.ok(!has(got.body, SECRET) && !has(got.body, 'TRAILER'), 'personal details must not come back out')
  assert.ok(got.body.equals(inspectImage(dirty, 'image/jpeg').clean), 'what comes back is the cleaned file, colour profile included')

  // also in a room, as PNG and WebP, with no caption
  for (const [type, buf] of [['image/png', pngWithMetadata()], ['image/webp', webpWithMetadata()]]) {
    const r = await send(`/api/rooms/${w.room.id}/images`, buf, w.owner.token, { type })
    assert.equal(r.status, 200, JSON.stringify(r.data))
    assert.equal(r.data.text, '')
    const back = await fetchImage(r.data.image.id, w.member.token)
    assert.equal(back.status, 200)
    assert.ok(!has(back.body, SECRET))
  }
})

test('only members of that server can send or see a picture', async () => {
  const w = await world()
  const other = await world()
  const sent = await send(`/api/channels/${w.channel.id}/images`, JPEG, w.member.token)
  assert.equal(sent.status, 200)
  const id = sent.data.image.id
  assert.equal((await fetchImage(id, w.member.token)).status, 200)
  assert.equal((await fetchImage(id, null)).status, 401)
  assert.equal((await fetchImage(id, other.owner.token)).status, 404) // not 403: the id says nothing
  assert.equal((await fetchImage(999999, w.owner.token)).status, 404)
  assert.equal((await send(`/api/channels/${w.channel.id}/images`, JPEG, other.member.token)).status, 403)
  assert.equal((await send(`/api/channels/${w.channel.id}/images`, JPEG, null)).status, 401)
  // a guest (joined with a code, voice only) can neither send nor see pictures
  const code = (await srv.call('POST', `/api/servers/${w.s.id}/codes`, { singleUse: false, expiresInMinutes: null }, w.owner.token)).data
  const joined = await srv.call('POST', '/api/join', { code: code.code, screenName: 'Visitor' })
  assert.equal(joined.status, 200, JSON.stringify(joined.data))
  assert.equal((await fetchImage(id, joined.data.guestToken)).status, 401)
  assert.equal((await send(`/api/channels/${w.channel.id}/images`, JPEG, joined.data.guestToken)).status, 401)
})

test('bad uploads are turned away and nothing is stored', async () => {
  const w = await world()
  const path = `/api/channels/${w.channel.id}/images`
  const before = imageRows().length
  const cases = [
    ['an empty body', Buffer.alloc(0), 'image/jpeg', 400],
    ['a GIF', Buffer.from('GIF89a' + 'x'.repeat(40)), 'image/gif', 400],
    ['plain text', Buffer.from('hello hello hello'), 'text/plain', 400],
    ['text labelled as a JPEG', Buffer.from('<html>hello hello hello</html>'), 'image/jpeg', 400],
    ['a PNG labelled as a JPEG', PNG, 'image/jpeg', 400],
    ['too large', Buffer.concat([JPEG, Buffer.alloc(70000)]), 'image/jpeg', 413]
  ]
  for (const [name, body, type, status] of cases) {
    const r = await send(path, body, w.member.token, { type })
    assert.equal(r.status, status, name + ': ' + JSON.stringify(r.data))
  }
  const long = await send(path, JPEG, w.member.token, { query: '?text=' + 'x'.repeat(1001) })
  assert.equal(long.status, 400)
  assert.equal(imageRows().length, before)
  assert.equal((await srv.call('GET', `/api/channels/${w.channel.id}/messages`, undefined, w.owner.token)).data.messages.length, 0)
})

test('a person is limited on how many pictures a minute and how much a day', async () => {
  const limited = await startServer({ env: { ACCOUNT_LIMIT: '1000', IMAGE_LIMIT: '3', IMAGE_DAILY_BYTES: String(JPEG.length * 5 + 10) } })
  try {
    const owner = await newAccount(limited)
    const s = (await limited.call('POST', '/api/servers', { name: 'Slow' }, owner.token)).data
    const ch = (await limited.call('POST', `/api/servers/${s.id}/channels`, { name: 'c', mode: 'both', persistent: true }, owner.token)).data
    const other = await newAccount(limited)
    const code = (await limited.call('POST', `/api/servers/${s.id}/codes`, { singleUse: false, expiresInMinutes: null }, owner.token)).data
    await limited.call('POST', '/api/servers/join', { code: code.code }, other.token)
    const go = (who) => send(`/api/channels/${ch.id}/images`, JPEG, who.token, { server: limited })
    assert.equal((await go(owner)).status, 200)
    assert.equal((await go(owner)).status, 200)
    assert.equal((await go(owner)).status, 200)
    assert.equal((await go(owner)).status, 429) // the fourth in a minute
    assert.equal((await go(other)).status, 200) // someone else is not held up by it
  } finally {
    await limited.stop()
  }
  const capped = await startServer({ env: { ACCOUNT_LIMIT: '1000', IMAGE_LIMIT: '100', IMAGE_DAILY_BYTES: String(JPEG.length * 2 + 10) } })
  try {
    const owner = await newAccount(capped)
    const s = (await capped.call('POST', '/api/servers', { name: 'Cap' }, owner.token)).data
    const ch = (await capped.call('POST', `/api/servers/${s.id}/channels`, { name: 'c', mode: 'both', persistent: true }, owner.token)).data
    const go = () => send(`/api/channels/${ch.id}/images`, JPEG, owner.token, { server: capped })
    assert.equal((await go()).status, 200)
    assert.equal((await go()).status, 200)
    const third = await go()
    assert.equal(third.status, 429)
    assert.match(third.data.error, /today/)
  } finally {
    await capped.stop()
  }
})

test('the picture goes when the history cleanup deletes its message, and not before', async () => {
  const w = await world()
  const fresh = await send(`/api/channels/${w.channel.id}/images`, JPEG, w.member.token)
  const old = await send(`/api/channels/${w.channel.id}/images`, PNG, w.member.token, { type: 'image/png' })
  const db = new Database(srv.dbPath)
  const aYearAndABitAgo = Date.now() - 400 * 86400000
  db.prepare('UPDATE messages SET created_at = ? WHERE id = ?').run(aYearAndABitAgo, old.data.id)
  db.close()
  await until(async () => (await fetchImage(old.data.image.id, w.owner.token)).status === 404)
  assert.equal((await fetchImage(fresh.data.image.id, w.owner.token)).status, 200)
  assert.ok(!imageRows().some((r) => r.message_id === old.data.id))
})

test('an ephemeral room that empties takes its pictures with it; a persistent one keeps them', async () => {
  const temp = await world(false)
  const kept = await world(true)
  const a = await send(`/api/channels/${temp.channel.id}/images`, JPEG, temp.owner.token)
  const b = await send(`/api/channels/${kept.channel.id}/images`, JPEG, kept.owner.token)
  await srv.call('POST', '/api/presence', { type: 'channel', id: temp.channel.id }, temp.owner.token)
  await srv.call('POST', '/api/presence', { type: 'channel', id: kept.channel.id }, kept.owner.token)
  assert.equal((await fetchImage(a.data.image.id, temp.owner.token)).status, 200)
  await srv.call('POST', '/api/presence/leave', {}, temp.owner.token)
  await srv.call('POST', '/api/presence/leave', {}, kept.owner.token)
  await until(async () => (await fetchImage(a.data.image.id, temp.owner.token)).status === 404, 15000)
  assert.equal((await fetchImage(b.data.image.id, kept.owner.token)).status, 200)
})

test('deleting a room, a channel or the author\'s account removes the pictures', async () => {
  const w = await world()
  const inRoom = await send(`/api/rooms/${w.room.id}/images`, JPEG, w.member.token)
  const inChannel = await send(`/api/channels/${w.channel.id}/images`, JPEG, w.member.token)
  const byOwner = await send(`/api/channels/${w.channel.id}/images`, JPEG, w.owner.token)
  const ids = [inRoom, inChannel, byOwner].map((r) => r.data.image.id)

  // the author deletes their account: their message stays, redacted, with no picture
  assert.equal((await srv.call('DELETE', '/api/me', { password: 'password123' }, w.member.token)).status, 200)
  assert.equal((await fetchImage(ids[0], w.owner.token)).status, 404)
  assert.equal((await fetchImage(ids[1], w.owner.token)).status, 404)
  assert.equal((await fetchImage(ids[2], w.owner.token)).status, 200)
  const left = (await srv.call('GET', `/api/channels/${w.channel.id}/messages`, undefined, w.owner.token)).data.messages
  const redacted = left.find((m) => m.id === inChannel.data.id)
  assert.equal(redacted.redacted, true)
  assert.equal(redacted.image, null)

  // deleting the channel (and its rooms) takes the rest
  const again = await send(`/api/rooms/${w.room.id}/images`, JPEG, w.owner.token)
  assert.equal((await srv.call('DELETE', `/api/servers/${w.s.id}/channels/${w.channel.id}`, undefined, w.owner.token)).status, 200)
  assert.equal((await fetchImage(ids[2], w.owner.token)).status, 404)
  assert.equal((await fetchImage(again.data.image.id, w.owner.token)).status, 404)
  assert.ok(!imageRows().some((r) => [...ids, again.data.image.id].includes(r.id)))
})
