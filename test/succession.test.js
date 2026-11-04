// Owner succession and the operator command line tool. The 90 and 14 day periods are settings, so the whole flow runs here
// in seconds on a real server process: the owner counts as dormant after 1.5 s without a request, a claim waits 1.5 s.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import Database from 'better-sqlite3'
import { startServer, newAccount } from './helpers.js'

const PASSWORD = 'password123'
const DORMANT = 1500
const NOTICE = 1500
let srv
const env = { OWNER_DORMANT_MS: String(DORMANT), SUCCESSION_NOTICE_MS: String(NOTICE), SUCCESSION_CHECK_MS: '100', SEEN_EVERY_MS: '20', NOTICE_KEEP_MS: '60000', ACCOUNT_LIMIT: '1000', LOGIN_LIMIT: '1000' }
before(async () => {
  srv = await startServer({ env })
})
after(async () => {
  await srv.stop()
})
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const db = (readonly = true) => new Database(srv.dbPath, { readonly })
const rows = (sql, ...a) => {
  const d = db()
  try {
    return d.prepare(sql).all(...a)
  } finally {
    d.close()
  }
}
const call = (...a) => srv.call(...a)

// An owner and some members who are made admins; then nobody touches the owner's token while the clock runs.
async function world({ admins = 2, members = 1 } = {}) {
  const owner = await newAccount(srv)
  const s = (await call('POST', '/api/servers', { name: 'Vanished' }, owner.token)).data
  const code = (await call('POST', `/api/servers/${s.id}/codes`, { singleUse: false, expiresInMinutes: null }, owner.token)).data
  const join = async () => {
    const a = await newAccount(srv)
    assert.equal((await call('POST', '/api/servers/join', { code: code.code }, a.token)).status, 200)
    return a
  }
  const adm = []
  for (let i = 0; i < admins; i++) {
    const a = await join()
    assert.equal((await call('POST', `/api/servers/${s.id}/members/${a.id}/admin`, { admin: true }, owner.token)).status, 200)
    adm.push(a)
  }
  const plain = []
  for (let i = 0; i < members; i++) plain.push(await join())
  return { owner, s, adm, plain }
}
const goDormant = () => sleep(DORMANT + 200)
const claim = (w, who, password = PASSWORD) => call('POST', `/api/servers/${w.s.id}/succession`, { password }, who.token)
const vote = (w, who, v) => call('POST', `/api/servers/${w.s.id}/succession/vote`, { vote: v }, who.token)
const server = async (w, who) => (await call('GET', `/api/servers/${w.s.id}`, undefined, who.token)).data
const ownerId = (w) => rows('SELECT owner_id FROM servers WHERE id = ?', w.s.id)[0].owner_id
const admin = (w, id) => rows('SELECT is_admin FROM server_members WHERE server_id = ? AND account_id = ?', w.s.id, id)[0].is_admin

test('a server cannot be claimed while its owner has been seen recently, and only by an admin', async () => {
  const w = await world()
  const early = await claim(w, w.adm[0])
  assert.equal(early.status, 409)
  assert.equal(early.data.reason, 'owner_active')
  await goDormant()
  assert.equal((await claim(w, w.plain[0])).status, 403, 'a member who is not an admin')
  assert.equal((await claim(w, w.adm[0], 'wrong-password')).status, 401)
  const st = await server(w, w.adm[0])
  assert.equal(st.ownerStatus.dormant, true)
  assert.equal(st.ownerStatus.otherAdmins, 2)
  assert.equal((await server(w, w.plain[0])).ownerStatus, undefined, 'only admins are told how long the owner has been gone')
  // (the owner trying it is a request from their session, which is being seen: so this goes last)
  assert.equal((await claim(w, w.owner)).status, 400, 'the owner cannot claim their own server')
})

test('dormant owner, claim, banner for everyone, majority votes, and ownership moves when the notice is over', async () => {
  const w = await world({ admins: 3 })
  await goDormant()
  const started = await claim(w, w.adm[0])
  assert.equal(started.status, 200, JSON.stringify(started.data))
  assert.equal(started.data.claim.yes, 1)
  assert.equal(started.data.claim.eligible, 3)
  assert.equal(started.data.claim.needed, 2)
  assert.equal((await claim(w, w.adm[1])).status, 409, 'one claim at a time')
  // everyone sees the banner, a plain member cannot vote
  const banner = (await server(w, w.plain[0])).succession
  assert.equal(banner.claimantName, w.adm[0].username)
  assert.equal(banner.canVote, false)
  assert.equal((await vote(w, w.plain[0], 'yes')).status, 403)
})

test('the majority votes yes and the claim passes only after the notice period', async () => {
  const w = await world({ admins: 3 })
  await goDormant()
  await claim(w, w.adm[0])
  assert.equal((await vote(w, w.adm[1], 'yes')).data.claim.yes, 2)
  await sleep(300)
  assert.equal(ownerId(w), w.owner.id, 'a majority is not enough before the notice is over')
  await sleep(NOTICE + 400)
  assert.equal(ownerId(w), w.adm[0].id, 'then the claimant is the owner')
  assert.equal(admin(w, w.owner.id), 1, 'the old owner stays an admin')
  const st = await server(w, w.plain[0])
  assert.equal(st.succession, null)
  assert.match(st.notices[0].text, new RegExp(`${w.adm[0].username} is now the owner`))
  assert.equal(st.notices[0].kind, 'owner_changed')
  const log = rows('SELECT via, from_owner_id, to_owner_id FROM ownership_log WHERE server_id = ?', w.s.id)
  assert.deepEqual(log.map((l) => [l.via, l.from_owner_id, l.to_owner_id]), [['vote', w.owner.id, w.adm[0].id]])
  // the old owner returns: an admin with Admin Tools, no longer the owner
  const back = await server(w, w.owner)
  assert.equal(back.isOwner, false)
  assert.equal(back.isAdmin, true)
})

test('a claim without a majority does nothing', async () => {
  const w = await world({ admins: 3 })
  await goDormant()
  await claim(w, w.adm[0])
  await vote(w, w.adm[1], 'no')
  await vote(w, w.adm[2], 'no')
  await sleep(NOTICE + 500)
  assert.equal(ownerId(w), w.owner.id)
  assert.equal(rows("SELECT status, ended_reason FROM succession_claims WHERE server_id = ?", w.s.id)[0].ended_reason, 'no_majority')
  assert.deepEqual(rows('SELECT * FROM ownership_log WHERE server_id = ?', w.s.id), [])
  // and a vote can be changed while the claim is open
  const w2 = await world({ admins: 3 })
  await goDormant()
  await claim(w2, w2.adm[0])
  await vote(w2, w2.adm[1], 'no')
  assert.equal((await vote(w2, w2.adm[1], 'yes')).data.claim.yes, 2)
  assert.equal((await vote(w2, w2.adm[1], 'maybe')).status, 400)
})

test('with one admin, that admin has the only vote and the notice period still applies', async () => {
  const w = await world({ admins: 1 })
  await goDormant()
  const started = await claim(w, w.adm[0])
  assert.equal(started.data.claim.needed, 1)
  await sleep(500)
  assert.equal(ownerId(w), w.owner.id, 'not before the notice is over')
  await sleep(NOTICE + 300)
  assert.equal(ownerId(w), w.adm[0].id)
})

test('the owner signing in, or any request from their session, cancels the claim', async () => {
  const w = await world({ admins: 2 })
  await goDormant()
  await claim(w, w.adm[0])
  await vote(w, w.adm[1], 'yes')
  const login = await call('POST', '/api/login', { username: w.owner.username, password: PASSWORD })
  assert.equal(login.status, 200)
  assert.equal((await server(w, w.plain[0])).succession, null)
  assert.equal(rows("SELECT ended_reason FROM succession_claims WHERE server_id = ?", w.s.id)[0].ended_reason, 'owner_returned')
  await sleep(NOTICE + 500)
  assert.equal(ownerId(w), w.owner.id, 'nothing happens when the time is up')
  // and from a session that was already open: any request counts
  const w2 = await world({ admins: 2 })
  await goDormant()
  await claim(w2, w2.adm[0])
  assert.equal((await call('GET', '/api/me', undefined, w2.owner.token)).status, 200)
  assert.equal((await server(w2, w2.plain[0])).succession, null)
})

test('the person who started a claim can withdraw it, nobody else can', async () => {
  const w = await world({ admins: 2 })
  await goDormant()
  await claim(w, w.adm[0])
  assert.equal((await call('POST', `/api/servers/${w.s.id}/succession/cancel`, {}, w.adm[1].token)).status, 403)
  assert.equal((await call('POST', `/api/servers/${w.s.id}/succession/cancel`, {}, w.adm[0].token)).status, 200)
  assert.equal((await server(w, w.plain[0])).succession, null)
  assert.equal((await claim(w, w.adm[1])).status, 200, 'then someone else can start one')
})

test('deleting an account that voted or claimed, or deleting the server, leaves nothing behind that breaks', async () => {
  const w = await world({ admins: 3 })
  await goDormant()
  await claim(w, w.adm[0])
  await vote(w, w.adm[1], 'yes')
  assert.equal((await call('DELETE', '/api/me', { password: PASSWORD }, w.adm[1].token)).status, 200, 'a voter')
  assert.equal((await server(w, w.plain[0])).succession.eligible, 2)
  assert.equal((await call('DELETE', '/api/me', { password: PASSWORD }, w.adm[0].token)).status, 200, 'the claimant')
  assert.equal((await server(w, w.plain[0])).succession, null)
  assert.equal((await call('DELETE', `/api/servers/${w.s.id}`, { password: PASSWORD }, w.owner.token)).status, 200, 'the server with its history of claims')
  assert.deepEqual(rows('SELECT id FROM succession_claims WHERE server_id = ?', w.s.id), [])
})

// ---- the command line tool ----
function cli(args, { input = '' } = {}) {
  const r = spawnSync('node', [fileURLToPath(new URL('../src/cli.js', import.meta.url)), ...args], {
    env: { ...process.env, ...env, DB_PATH: srv.dbPath, JWT_SECRET: 'x'.repeat(40) },
    input,
    encoding: 'utf8'
  })
  return { code: r.status, out: r.stdout, err: r.stderr }
}

test('the command line tool names a new owner only for a server whose owner is its only admin, who has been gone long enough', async () => {
  const sole = await world({ admins: 0, members: 2 })
  const target = sole.plain[0]
  // the owner was just here
  const early = cli(['set-owner', String(sole.s.id), target.username, '--yes'])
  assert.equal(early.code, 1)
  assert.match(early.out, /last seen 0 day\(s\) ago/)
  assert.equal(ownerId(sole), sole.owner.id)
  await goDormant()
  // another admin exists: they vote instead
  const withAdmin = await world({ admins: 1, members: 1 })
  await goDormant()
  const refused = cli(['set-owner', String(withAdmin.s.id), withAdmin.plain[0].username, '--yes'])
  assert.equal(refused.code, 1)
  assert.match(refused.out, /other admins/)
  assert.equal(ownerId(withAdmin), withAdmin.owner.id)
  // not a member, no such server, wrong confirmation
  assert.match(cli(['set-owner', String(sole.s.id), 'nobody-here', '--yes']).out, /not a member/)
  assert.match(cli(['set-owner', '999999', target.username, '--yes']).out, /no server #999999/)
  const wrong = cli(['set-owner', String(sole.s.id), target.username], { input: 'not the name\n' })
  assert.match(wrong.out, /Not confirmed/)
  assert.equal(ownerId(sole), sole.owner.id)
  // and the real thing, confirmed by typing the name
  const ok = cli(['set-owner', String(sole.s.id), target.username], { input: 'Vanished\n' })
  assert.equal(ok.code, 0, ok.out + ok.err)
  assert.match(ok.err, /OWNER OF SERVER .* CHANGED BY THE OPERATOR/)
  assert.equal(ownerId(sole), target.id)
  assert.equal(admin(sole, sole.owner.id), 1, 'the old owner stays an admin')
  assert.equal(rows('SELECT via FROM ownership_log WHERE server_id = ?', sole.s.id)[0].via, 'operator')
  // every member is told, by name
  for (const who of [sole.plain[1], target]) {
    const st = await server(sole, who)
    assert.match(st.notices[0].text, new RegExp(`${target.username} is now the owner`))
    assert.match(st.notices[0].text, /person who runs this server/)
  }
  assert.match(cli(['servers']).out, /Vanished/)
})

test('the command line tool changes nothing but who the owner is', async () => {
  const sole = await world({ admins: 0, members: 1 })
  await goDormant()
  const before = JSON.stringify({
    messages: rows('SELECT COUNT(*) AS n FROM messages')[0].n,
    accounts: rows('SELECT id, password_hash, recovery_key_hash, keyring_blob FROM accounts ORDER BY id'),
    devices: rows('SELECT * FROM device_keys ORDER BY id'),
    envelopes: rows('SELECT COUNT(*) AS n FROM key_envelopes')[0].n
  })
  assert.equal(cli(['set-owner', String(sole.s.id), sole.plain[0].username, '--yes']).code, 0)
  const after = JSON.stringify({
    messages: rows('SELECT COUNT(*) AS n FROM messages')[0].n,
    accounts: rows('SELECT id, password_hash, recovery_key_hash, keyring_blob FROM accounts ORDER BY id'),
    devices: rows('SELECT * FROM device_keys ORDER BY id'),
    envelopes: rows('SELECT COUNT(*) AS n FROM key_envelopes')[0].n
  })
  assert.equal(after, before)
})
