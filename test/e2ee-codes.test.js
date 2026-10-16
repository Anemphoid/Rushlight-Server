// Invites that carry keys, server side. In an encrypted server every invite holds sealed keys (made by the app of
// whoever creates it, opened only with the secret half of the code, which the server never sees): the server checks
// their shape, stores them blind, hands them to whoever presents the code, and lets an admin's app add a newer
// epoch's keys. The bytes in these tests are random, since the server cannot tell; what is tested is who gets what.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { createECDH, randomBytes } from 'node:crypto'
import Database from 'better-sqlite3'
import { startServer, newAccount, jwtClaims } from './helpers.js'

const CLIENT = { 'x-rushlight-client': '0.26.0' }
let srv
before(async () => {
  srv = await startServer({ env: { ACCOUNT_LIMIT: '1000', DEVICE_LIMIT: '1000' } })
})
after(async () => {
  await srv.stop()
})

async function call(method, path, body, token, headers = CLIENT) {
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
const b64 = (n) => randomBytes(n).toString('base64url')
const pub = () => {
  const e = createECDH('prime256v1')
  e.generateKeys()
  return e.getPublicKey().toString('base64url')
}
const sealedPackage = () => `rlp1.${b64(12)}.${b64(300)}`
const sealedSecret = (epoch) => `rlc1.${epoch}.${b64(12)}.${b64(40)}`
const keys = (epoch = 1) => ({ package: sealedPackage(), secret: sealedSecret(epoch), epoch })
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
  const s = (await call('POST', '/api/servers', { name: 'Keys' }, owner.token)).data
  const member = await newAccount(srv)
  const plainCode = (await call('POST', `/api/servers/${s.id}/codes`, { singleUse: false, expiresInMinutes: null }, owner.token)).data
  await call('POST', '/api/servers/join', { code: plainCode.code }, member.token)
  const channel = (await call('POST', `/api/servers/${s.id}/channels`, { name: 'Lounge', mode: 'both', persistent: true }, owner.token)).data
  const devs = []
  if (encrypted) {
    for (const a of [owner, member]) devs.push((await call('POST', '/api/devices', { publicKey: pub(), label: 'pc' }, a.token)).data)
    const db = new Database(srv.dbPath)
    db.prepare('UPDATE servers SET e2ee_enabled = 1 WHERE id = ?').run(s.id)
    db.close()
    const r = await call(
      'POST',
      `/api/servers/${s.id}/rekey`,
      { epoch: 1, senderDeviceId: devs[0].id, envelopes: devs.map((d) => ({ recipientDeviceId: d.id, data: b64(80) })) },
      owner.token
    )
    assert.equal(r.status, 200, JSON.stringify(r.data))
  }
  const rekey = async (epoch) =>
    call('POST', `/api/servers/${s.id}/rekey`, { epoch, senderDeviceId: devs[0].id, envelopes: devs.map((d) => ({ recipientDeviceId: d.id, data: b64(80) })) }, owner.token)
  return { owner, member, s, channel, plainCode, devs, rekey }
}
const mk = (w, body, who = w.owner) => call('POST', `/api/servers/${w.s.id}/codes`, body, who.token)
const info = async (w) => (await call('GET', `/api/servers/${w.s.id}`, undefined, w.owner.token)).data.e2ee

test('an invite made in an encrypted server must carry its keys, in the right shape, for a key the server has', async () => {
  const w = await world()
  const base = { singleUse: false, expiresInMinutes: null }
  const bad = {
    'no keys at all': {},
    'a package that is not one': { e2ee: { ...keys(), package: 'hello' } },
    'a package with the wrong prefix': { e2ee: { ...keys(), package: `rlx1.${b64(12)}.${b64(300)}` } },
    'a package that is far too long': { e2ee: { ...keys(), package: `rlp1.${b64(12)}.${b64(9000)}` } },
    'a secret that is not one': { e2ee: { ...keys(), secret: 'nope' } },
    'a secret for an epoch that does not exist': { e2ee: { ...keys(), secret: sealedSecret(2) } },
    'an epoch of zero': { e2ee: keys(0) },
    'an epoch the server does not have': { e2ee: keys(2) },
    'an epoch that is not a number': { e2ee: { ...keys(), epoch: '1' } }
  }
  for (const [name, extra] of Object.entries(bad)) {
    const r = await mk(w, { ...base, ...extra })
    assert.equal(r.status, 400, `${name}: ${JSON.stringify(r.data)}`)
  }
  assert.equal((await mk(w, base)).data.reason, 'package_required')
  const ok = await mk(w, { ...base, e2ee: keys() })
  assert.equal(ok.status, 200, JSON.stringify(ok.data))
  assert.ok(Number.isInteger(ok.data.id))
  const stored = rows('SELECT key_package, key_secret, key_epoch, key_version FROM join_codes WHERE id = ?', ok.data.id)[0]
  assert.equal(stored.key_epoch, 1)
  assert.equal(stored.key_version, 0)
  assert.match(stored.key_package, /^rlp1\./)
})

test('an app that does not say its version cannot make an invite in an encrypted server; a plain server is unchanged', async () => {
  const w = await world()
  const none = await call('POST', `/api/servers/${w.s.id}/codes`, { singleUse: false, expiresInMinutes: null, e2ee: keys() }, w.owner.token, {})
  assert.equal(none.status, 426)
  const p = await world({ encrypted: false })
  const plain = await mk(p, { singleUse: false, expiresInMinutes: null })
  assert.equal(plain.status, 200)
  const sneaky = await mk(p, { singleUse: false, expiresInMinutes: null, e2ee: keys() })
  assert.equal(sneaky.status, 409)
  assert.equal(sneaky.data.reason, 'e2ee_off')
  assert.equal((await call('GET', `/api/servers/${p.s.id}/codes`, undefined, p.owner.token, {})).data.codes.every((c) => c.e2ee === null), true)
})

test("an admin's app lists each invite's sealed keys; members cannot, and older invites have none", async () => {
  const w = await world()
  const k = keys()
  const made = await mk(w, { singleUse: false, expiresInMinutes: null, e2ee: k })
  const list = (await call('GET', `/api/servers/${w.s.id}/codes`, undefined, w.owner.token)).data.codes
  const row = list.find((c) => c.id === made.data.id)
  assert.deepEqual(row.e2ee, { package: k.package, secret: k.secret, epoch: 1, version: 0 })
  assert.equal(list.find((c) => c.id === w.plainCode.id).e2ee, null)
  assert.equal((await call('GET', `/api/servers/${w.s.id}/codes`, undefined, w.member.token)).status, 403)
})

test('a member who joins with an invite is given its sealed keys, and the server key epoch', async () => {
  const w = await world()
  const k = keys()
  const made = (await mk(w, { singleUse: true, expiresInMinutes: null, e2ee: k })).data
  const newcomer = await newAccount(srv)
  const joined = await call('POST', '/api/servers/join', { code: made.code }, newcomer.token)
  assert.equal(joined.status, 200)
  assert.deepEqual(joined.data.e2ee, { enabled: true, epoch: 1, package: k.package, packageEpoch: 1 })
  // an old invite still lets a member in (the keys then arrive from another member's app)
  const other = await newAccount(srv)
  const viaOld = await call('POST', '/api/servers/join', { code: w.plainCode.code }, other.token)
  assert.equal(viaOld.status, 200)
  assert.deepEqual(viaOld.data.e2ee, { enabled: true, epoch: 1, package: null, packageEpoch: 0 })
  // an ordinary server says it is not encrypted
  const p = await world({ encrypted: false })
  const third = await newAccount(srv)
  const plain = await call('POST', '/api/servers/join', { code: p.plainCode.code }, third.token)
  assert.deepEqual(plain.data.e2ee, { enabled: false })
})

test('a guest needs an invite that carries keys, and the old invite is not used up by being refused', async () => {
  const w = await world()
  const old = (await call('POST', '/api/join', { code: w.plainCode.code, screenName: 'Visitor' })).data
  assert.equal(old.error !== undefined, true)
  const single = await world({ encrypted: false })
  const oneShot = (await mk(single, { singleUse: true, expiresInMinutes: null })).data
  const db = new Database(srv.dbPath)
  db.prepare('UPDATE servers SET e2ee_enabled = 1 WHERE id = ?').run(single.s.id)
  db.close()
  const refused = await call('POST', '/api/join', { code: oneShot.code, screenName: 'Visitor' })
  assert.equal(refused.status, 409)
  assert.equal(refused.data.reason, 'old_invite')
  assert.equal(rows('SELECT used FROM join_codes WHERE id = ?', oneShot.id)[0].used, 0, 'a refused invite is not used up')

  const k = keys()
  const made = (await mk(w, { singleUse: false, expiresInMinutes: null, e2ee: k, scope: { type: 'channel', id: w.channel.id } })).data
  const ok = await call('POST', '/api/join', { code: made.code, screenName: 'Visitor' })
  assert.equal(ok.status, 200, JSON.stringify(ok.data))
  assert.deepEqual(ok.data.server.e2ee, { enabled: true, epoch: 1, package: k.package, packageEpoch: 1 })
  assert.equal((await call('POST', '/api/join', { code: made.code, screenName: 'Visitor Two' }, undefined, {})).status, 426, 'an app that does not say its version is turned away')
})

test('a guest with such an invite gets a voice connection to an encrypted room; one whose invite predates encryption does not', async () => {
  const w = await world()
  const made = (await mk(w, { singleUse: false, expiresInMinutes: null, e2ee: keys(), scope: { type: 'channel', id: w.channel.id } })).data
  const g = (await call('POST', '/api/join', { code: made.code, screenName: 'Visitor' })).data
  const t = await call('POST', '/api/voice/token', { type: 'channel', id: w.channel.id }, g.guestToken)
  assert.equal(t.status, 200, JSON.stringify(t.data))
  assert.equal(t.data.encrypted, true)
  assert.equal(t.data.epoch, 1)
  assert.equal(jwtClaims(t.data.token).video.room, `s${w.s.id}-channel-${w.channel.id}`)
  assert.equal((await call('POST', '/api/voice/token', { type: 'channel', id: w.channel.id }, g.guestToken, {})).status, 426)

  // a guest who came in before the server was encrypted holds no keys
  const p = await world({ encrypted: false })
  const code = (await mk(p, { singleUse: false, expiresInMinutes: null })).data
  const early = (await call('POST', '/api/join', { code: code.code, screenName: 'Early Bird' })).data
  const db = new Database(srv.dbPath)
  db.prepare('UPDATE servers SET e2ee_enabled = 1 WHERE id = ?').run(p.s.id)
  db.close()
  const refused = await call('POST', '/api/voice/token', { type: 'channel', id: p.channel.id }, early.guestToken)
  assert.equal(refused.status, 409)
  assert.equal(refused.data.reason, 'guest_encrypted')
  assert.equal(refused.data.token, undefined)
})

test('a guest can ask again for its invite\'s package, and only a guest whose invite is still good', async () => {
  const w = await world()
  const k = keys()
  const made = (await mk(w, { singleUse: false, expiresInMinutes: null, e2ee: k, scope: { type: 'channel', id: w.channel.id } })).data
  const g = (await call('POST', '/api/join', { code: made.code, screenName: 'Visitor' })).data
  const r = await call('GET', '/api/guest/key-package', undefined, g.guestToken)
  assert.deepEqual(r.data, { epoch: 1, package: k.package, packageEpoch: 1, version: 0 })
  assert.equal((await call('GET', '/api/guest/key-package', undefined, g.guestToken, {})).status, 426)
  assert.equal((await call('GET', '/api/guest/key-package', undefined, w.member.token)).status, 403, 'members are not guests')
  assert.equal((await call('GET', '/api/guest/key-package')).status, 401)
  await call('DELETE', `/api/servers/${w.s.id}/codes/${made.id}`, undefined, w.owner.token)
  assert.equal((await call('GET', '/api/guest/key-package', undefined, g.guestToken)).status, 403, 'a revoked invite gives nothing more')
})

test("an admin's app adds a newer epoch's keys to an invite; two doing it at once cannot overwrite each other", async () => {
  const w = await world()
  const made = (await mk(w, { singleUse: false, expiresInMinutes: null, e2ee: keys(), scope: { type: 'channel', id: w.channel.id } })).data
  const put = (body, who = w.owner, headers = CLIENT) => call('PUT', `/api/servers/${w.s.id}/codes/${made.id}/package`, body, who.token, headers)
  const second = { package: sealedPackage(), epoch: 2, version: 0 }
  assert.equal((await put(second)).data.reason, 'bad_epoch', 'the server is not on epoch 2 yet')
  assert.equal((await w.rekey(2)).status, 200)

  assert.equal((await put(second, w.member)).status, 403)
  assert.equal((await put(second, w.owner, {})).status, 426)
  for (const bad of [{ ...second, package: 'x' }, { ...second, epoch: 1 }, { ...second, epoch: 3 }, { ...second, version: '0' }, { package: second.package }]) {
    assert.equal((await put(bad)).status, 400, JSON.stringify(bad).slice(0, 60))
  }
  const ok = await put(second)
  assert.deepEqual(ok.data, { updated: true, version: 1 })
  // the other admin's app, working from the version it read, is told it lost
  const late = await put({ package: sealedPackage(), epoch: 2, version: 0 })
  assert.equal(late.status, 409)
  assert.equal(late.data.reason, 'package_changed')
  assert.equal((await call('GET', `/api/servers/${w.s.id}/codes`, undefined, w.owner.token)).data.codes.find((c) => c.id === made.id).e2ee.package, second.package)
  // and the guest sees the new package
  const g = (await call('POST', '/api/join', { code: made.code, screenName: 'Visitor' })).data
  assert.equal(g.server.e2ee.package, second.package)
  assert.equal(g.server.e2ee.packageEpoch, 2)
  // a code without keys, and a revoked one, have nothing to update
  assert.equal((await call('PUT', `/api/servers/${w.s.id}/codes/${w.plainCode.id}/package`, { ...second, version: 0 }, w.owner.token)).status, 404)
  await call('DELETE', `/api/servers/${w.s.id}/codes/${made.id}`, undefined, w.owner.token)
  assert.equal((await put({ package: sealedPackage(), epoch: 2, version: 1 })).status, 404)
})

test('taking back an invite that carried keys, or removing a guest, asks for a new key', async () => {
  const w = await world()
  assert.equal((await info(w)).rekeyNeeded, false)
  const plainOne = (await mk(w, { singleUse: false, expiresInMinutes: null, e2ee: keys() })).data
  const old = w.plainCode
  await call('DELETE', `/api/servers/${w.s.id}/codes/${old.id}`, undefined, w.owner.token)
  assert.equal((await info(w)).rekeyNeeded, false, 'an invite with no keys held nobody a key')
  await call('DELETE', `/api/servers/${w.s.id}/codes/${plainOne.id}`, undefined, w.owner.token)
  assert.equal((await info(w)).rekeyNeeded, true)
  assert.equal((await w.rekey(2)).status, 200)
  assert.equal((await info(w)).rekeyNeeded, false)

  const scoped = (await mk(w, { singleUse: false, expiresInMinutes: null, e2ee: keys(2), scope: { type: 'channel', id: w.channel.id } })).data
  const g = (await call('POST', '/api/join', { code: scoped.code, screenName: 'Visitor' })).data
  await call('POST', '/api/presence', { type: 'channel', id: w.channel.id }, g.guestToken)
  const identity = jwtClaims(g.guestToken).identity
  assert.equal((await call('DELETE', `/api/servers/${w.s.id}/guests/${identity}`, undefined, w.owner.token)).status, 200)
  assert.equal((await info(w)).rekeyNeeded, true)
})

test('a code can be looked at without being used, so a wrong or missing secret half is caught before an invite is spent', async () => {
  const w = await world()
  const k = keys()
  const oneShot = (await mk(w, { singleUse: true, expiresInMinutes: null, e2ee: k, scope: { type: 'channel', id: w.channel.id } })).data
  const first = await call('POST', '/api/code-check', { code: oneShot.code }, undefined, {})
  assert.equal(first.status, 200, JSON.stringify(first.data))
  assert.deepEqual(first.data, { guestsOnly: true, e2ee: { enabled: true, epoch: 1, package: k.package, packageEpoch: 1 } })
  await call('POST', '/api/code-check', { code: oneShot.code }, undefined, {})
  assert.equal(rows('SELECT used FROM join_codes WHERE id = ?', oneShot.id)[0].used, 0, 'looking is not using')
  assert.equal((await call('POST', '/api/join', { code: oneShot.code, screenName: 'Visitor' })).status, 200, 'it still works for the guest it was made for')
  assert.equal((await call('POST', '/api/code-check', { code: oneShot.code }, undefined, {})).status, 410, 'a used one says so')

  // an older invite in an encrypted server shows that it carries nothing, a plain server says it is not encrypted
  const old = await call('POST', '/api/code-check', { code: w.plainCode.code }, undefined, {})
  assert.deepEqual(old.data, { guestsOnly: false, e2ee: { enabled: true, epoch: 1, package: null, packageEpoch: 0 } })
  const p = await world({ encrypted: false })
  assert.deepEqual((await call('POST', '/api/code-check', { code: p.plainCode.code }, undefined, {})).data, { guestsOnly: false, e2ee: { enabled: false } })
  // unknown, revoked, and nonsense
  assert.equal((await call('POST', '/api/code-check', { code: 'no-such-0000' }, undefined, {})).status, 404)
  assert.equal((await call('POST', '/api/code-check', {}, undefined, {})).status, 400)
  const gone = (await mk(w, { singleUse: false, expiresInMinutes: null, e2ee: keys() })).data
  await call('DELETE', `/api/servers/${w.s.id}/codes/${gone.id}`, undefined, w.owner.token)
  assert.equal((await call('POST', '/api/code-check', { code: gone.code }, undefined, {})).status, 404)
})
