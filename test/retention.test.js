// How long persistent chat is kept: the per-server window (3, 6, 9 or 12 months, 12 by default), who may
// change it, what the daily cleanup removes and what it leaves alone. Real server process; old messages are
// written straight into its database file, since the API only ever makes new ones.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import Database from 'better-sqlite3'
import { startServer, newAccount } from './helpers.js'

let srv
before(async () => {
  srv = await startServer({ env: { RETENTION_EVERY_MS: '600', ACCOUNT_LIMIT: '1000' } })
})
after(async () => {
  await srv.stop()
})

const DAY = 86400000
const monthsAgo = (months, extraDays = 0) => {
  const d = new Date()
  d.setMonth(d.getMonth() - months)
  return d.getTime() - extraDays * DAY
}
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

async function world() {
  const owner = await newAccount(srv)
  const s = (await srv.call('POST', '/api/servers', { name: 'Keeps' }, owner.token)).data
  const code = (await srv.call('POST', `/api/servers/${s.id}/codes`, { singleUse: false, expiresInMinutes: null }, owner.token)).data
  const join = async () => {
    const a = await newAccount(srv)
    await srv.call('POST', '/api/servers/join', { code: code.code }, a.token)
    return a
  }
  const admin = await join()
  const member = await join()
  await srv.call('POST', `/api/servers/${s.id}/members/${admin.id}/admin`, { admin: true }, owner.token)
  const channel = (await srv.call('POST', `/api/servers/${s.id}/channels`, { name: 'kept', mode: 'both', persistent: true }, owner.token)).data
  const room = (await srv.call('POST', `/api/servers/${s.id}/channels/${channel.id}/rooms`, { name: 'kept room', mode: 'text', persistent: true }, owner.token)).data
  return { owner, s, admin, member, channel, room }
}

// write a message at a chosen age, straight into the database
function put({ channel = null, room = null, text, at, author = null, name = 'someone', redacted = 0 }) {
  const db = new Database(srv.dbPath)
  const info = db
    .prepare('INSERT INTO messages (channel_id, room_id, author_account_id, author_name, text, created_at, redacted) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(channel, room, author, name, text, at, redacted)
  db.close()
  return info.lastInsertRowid
}
const texts = (where, ...args) => {
  const db = new Database(srv.dbPath, { readonly: true })
  const rows = db.prepare(`SELECT text FROM messages WHERE ${where} ORDER BY id`).all(...args).map((r) => r.text)
  db.close()
  return rows
}
const setMonths = (w, who, months) => srv.call('PUT', `/api/servers/${w.s.id}/retention`, { months }, who.token)
const getServer = async (w, who) => (await srv.call('GET', `/api/servers/${w.s.id}`, undefined, who.token)).data

test('every server starts at 12 months, and members are told', async () => {
  const w = await world()
  for (const who of [w.owner, w.admin, w.member]) assert.equal((await getServer(w, who)).retentionMonths, 12)
})

test('only the owner changes the window, and only to 3, 6, 9 or 12', async () => {
  const w = await world()
  for (const who of [w.admin, w.member]) assert.equal((await setMonths(w, who, 6)).status, 403)
  assert.equal((await getServer(w, w.owner)).retentionMonths, 12)
  assert.equal((await srv.call('PUT', `/api/servers/${w.s.id}/retention`, { months: 6 })).status, 401)
  const stranger = await newAccount(srv)
  assert.equal((await setMonths(w, stranger, 6)).status, 403)

  for (const bad of [5, 0, 24, -3, 6.5, '6', null, undefined, [], {}, true, NaN]) {
    const r = await srv.call('PUT', `/api/servers/${w.s.id}/retention`, bad === undefined ? {} : { months: bad }, w.owner.token)
    assert.equal(r.status, 400, JSON.stringify(bad))
    assert.match(r.data.error, /3, 6, 9, 12/)
  }
  assert.equal((await getServer(w, w.owner)).retentionMonths, 12)

  for (const m of [3, 6, 9, 12]) {
    const r = await setMonths(w, w.owner, m)
    assert.equal(r.status, 200, JSON.stringify(r.data))
    assert.equal(r.data.retentionMonths, m)
    assert.equal((await getServer(w, w.member)).retentionMonths, m)
  }
})

test('the answer says how many messages the new window will remove, counting only persistent spaces', async () => {
  const w = await world()
  const eph = (await srv.call('POST', `/api/servers/${w.s.id}/channels`, { name: 'gone', mode: 'text', persistent: false }, w.owner.token)).data
  await srv.call('POST', '/api/presence', { type: 'channel', id: eph.id }, w.owner.token) // keep it occupied
  put({ channel: w.channel.id, text: 'a', at: monthsAgo(5) })
  put({ room: w.room.id, text: 'b', at: monthsAgo(7) })
  put({ channel: w.channel.id, text: 'c', at: monthsAgo(1) })
  put({ channel: eph.id, text: 'ephemeral and old', at: monthsAgo(8) })
  // 12 months: nothing; 6: the 7 month one; 3: the 5 and 7 month ones
  assert.equal((await setMonths(w, w.owner, 12)).data.willDeleteAtNextCleanup, 0)
  const six = (await setMonths(w, w.owner, 6)).data
  assert.equal(six.willDeleteAtNextCleanup, 1)
  assert.equal((await setMonths(w, w.owner, 3)).data.willDeleteAtNextCleanup, 2)
})

test('a dry run says what a window would remove and changes nothing', async () => {
  const w = await world()
  put({ channel: w.channel.id, text: 'five months', at: monthsAgo(5) })
  const dry = await srv.call('PUT', `/api/servers/${w.s.id}/retention`, { months: 3, dryRun: true }, w.owner.token)
  assert.equal(dry.status, 200)
  assert.equal(dry.data.saved, false)
  assert.equal(dry.data.willDeleteAtNextCleanup >= 0, true)
  assert.equal((await getServer(w, w.owner)).retentionMonths, 12)
  // not the owner: refused even for a dry run; a bad number: refused too
  assert.equal((await srv.call('PUT', `/api/servers/${w.s.id}/retention`, { months: 3, dryRun: true }, w.admin.token)).status, 403)
  assert.equal((await srv.call('PUT', `/api/servers/${w.s.id}/retention`, { months: 5, dryRun: true }, w.owner.token)).status, 400)
  // "dryRun" must be exactly true to count as one
  const real = await srv.call('PUT', `/api/servers/${w.s.id}/retention`, { months: 9, dryRun: 'yes' }, w.owner.token)
  assert.equal(real.data.saved, true)
  assert.equal((await getServer(w, w.owner)).retentionMonths, 9)
})

test('the cleanup removes the oldest persistent messages and keeps the rest', async () => {
  const w = await world()
  put({ channel: w.channel.id, text: 'channel old', at: monthsAgo(12, 2) })
  put({ channel: w.channel.id, text: 'channel just inside', at: monthsAgo(11, 25) })
  put({ channel: w.channel.id, text: 'channel three days short of a year', at: monthsAgo(12, -3) }) // calendar months, not 30 day ones
  put({ channel: w.channel.id, text: 'channel new', at: Date.now() - DAY })
  put({ room: w.room.id, text: 'room old', at: monthsAgo(14) })
  put({ room: w.room.id, text: 'room new', at: monthsAgo(2) })
  await until(() => texts('channel_id = ? OR room_id = ?', w.channel.id, w.room.id).length === 4)
  assert.deepEqual(texts('channel_id = ?', w.channel.id), ['channel just inside', 'channel three days short of a year', 'channel new'])
  assert.deepEqual(texts('room_id = ?', w.room.id), ['room new'])
})

test('a shorter window removes more at the next cleanup, and a longer one does not bring anything back', async () => {
  const w = await world()
  put({ channel: w.channel.id, text: 'four months', at: monthsAgo(4) })
  put({ channel: w.channel.id, text: 'two months', at: monthsAgo(2) })
  await sleep(1500) // several cleanups with the default 12 months: nothing goes
  assert.deepEqual(texts('channel_id = ?', w.channel.id), ['four months', 'two months'])
  await setMonths(w, w.owner, 3)
  await until(() => texts('channel_id = ?', w.channel.id).length === 1)
  assert.deepEqual(texts('channel_id = ?', w.channel.id), ['two months'])
  await setMonths(w, w.owner, 12)
  await sleep(1500)
  assert.deepEqual(texts('channel_id = ?', w.channel.id), ['two months'])
})

test('each server keeps its own window', async () => {
  const a = await world()
  const b = await world()
  await setMonths(a, a.owner, 3)
  put({ channel: a.channel.id, text: 'a: five months', at: monthsAgo(5) })
  put({ channel: b.channel.id, text: 'b: five months', at: monthsAgo(5) })
  await until(() => texts('channel_id = ?', a.channel.id).length === 0)
  assert.deepEqual(texts('channel_id = ?', b.channel.id), ['b: five months'])
})

test('ephemeral spaces are not touched by it', async () => {
  const w = await world()
  const eph = (await srv.call('POST', `/api/servers/${w.s.id}/channels`, { name: 'temp', mode: 'text', persistent: false }, w.owner.token)).data
  await srv.call('POST', '/api/presence', { type: 'channel', id: eph.id }, w.owner.token)
  await setMonths(w, w.owner, 3)
  // an ephemeral room inside a persistent channel is just as safe
  const ephRoom = (await srv.call('POST', `/api/servers/${w.s.id}/channels/${w.channel.id}/rooms`, { name: 'temp room', mode: 'text', persistent: false }, w.owner.token)).data
  await srv.call('POST', '/api/presence', { type: 'room', id: ephRoom.id }, w.admin.token)
  put({ room: ephRoom.id, text: 'old ephemeral room message', at: monthsAgo(9) })
  put({ channel: eph.id, text: 'old but ephemeral and occupied', at: monthsAgo(9) })
  put({ channel: w.channel.id, text: 'old persistent', at: monthsAgo(9) })
  await until(() => texts('channel_id = ?', w.channel.id).length === 0)
  assert.deepEqual(texts('channel_id = ?', eph.id), ['old but ephemeral and occupied'])
  assert.deepEqual(texts('room_id = ?', ephRoom.id), ['old ephemeral room message'])
})

test('redacted messages and the bot age out the same way as anyone\'s', async () => {
  const w = await world()
  await setMonths(w, w.owner, 6)
  put({ channel: w.channel.id, text: '', name: '', at: monthsAgo(8), redacted: 1 })
  put({ channel: w.channel.id, text: 'Jellybox says hi', name: 'Jellybox', at: monthsAgo(8) })
  put({ channel: w.channel.id, text: '', name: '', at: monthsAgo(1), redacted: 1 })
  await until(() => texts('channel_id = ?', w.channel.id).length === 1)
  const db = new Database(srv.dbPath, { readonly: true })
  const left = db.prepare('SELECT redacted FROM messages WHERE channel_id = ?').all(w.channel.id)
  db.close()
  assert.deepEqual(left, [{ redacted: 1 }])
})

test('the server says what it did, without naming anyone', async () => {
  const w = await world()
  await setMonths(w, w.owner, 3)
  put({ channel: w.channel.id, text: 'a very private sentence', name: 'PrivatePerson', at: monthsAgo(5) })
  await until(() => texts('channel_id = ?', w.channel.id).length === 0)
  assert.match(srv.log(), /Removed \d+ message\(s\) older than their server's history window/)
  assert.ok(!srv.log().includes('a very private sentence'))
  assert.ok(!srv.log().includes('PrivatePerson'))
  // nor anything else that is in the database
  const db = new Database(srv.dbPath, { readonly: true })
  const everything = db.prepare("SELECT text FROM messages WHERE length(text) >= 12").all().map((r) => r.text)
  db.close()
  assert.ok(everything.length > 0)
  for (const text of everything) assert.ok(!srv.log().includes(text), 'the log must not repeat message text: ' + text)
})
