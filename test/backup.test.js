// Encrypted nightly backups. The machine can write them and cannot read them: the phrase is the key, and it is not kept.
// Covers the format (round trip, wrong phrase, any change refused), what is and is not in the file, retention, a backup taken
// while the server is writing, and the nightly job in a real server process.
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync, existsSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomBytes } from 'node:crypto'
import Database from 'better-sqlite3'
import { startServer, newAccount } from './helpers.js'
import { RECOVERY_WORDS } from '../src/recoverywords.js'
import { spawn } from 'node:child_process'
import { BackupError, backupSettings, checkBackup, decryptBackup, encryptBackup, keysFromPhrase, makePhrase, readPublicKeyFile, restoreBackup, runBackup, selectToKeep, writePublicKeyFile, isDue } from '../src/backup.js'

const scratch = []
const dir = () => {
  const d = mkdtempSync(join(tmpdir(), 'rushlight-backup-test-'))
  scratch.push(d)
  return d
}
after(() => scratch.forEach((d) => rmSync(d, { recursive: true, force: true })))
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const until = async (fn, what, ms = 20000) => {
  const end = Date.now() + ms
  for (;;) {
    const v = await fn()
    if (v) return v
    if (Date.now() > end) throw new Error('timed out waiting for ' + what)
    await sleep(100)
  }
}
const rejectsWith = (p, code) => assert.rejects(p, (e) => e instanceof BackupError && e.code === code, `expected ${code}`)

test('a phrase is 12 listed words, and the same phrase always gives the same keys, however it is typed', () => {
  const phrase = makePhrase()
  assert.equal(phrase.split(' ').length, 12)
  assert.ok(phrase.split(' ').every((w) => RECOVERY_WORDS.includes(w)))
  const a = keysFromPhrase(phrase)
  const b = keysFromPhrase(phrase.toUpperCase().replace(/ /g, ',  '))
  assert.ok(a.publicRaw.equals(b.publicRaw))
  assert.equal(a.publicRaw.length, 32)
  assert.ok(!a.publicRaw.equals(keysFromPhrase(makePhrase()).publicRaw))
  assert.throws(() => keysFromPhrase('only three words'), (e) => e.code === 'bad_phrase')
})

// a database-sized file (several chunks) and a small env file
function inputs(d) {
  const db = join(d, 'in.db')
  const env = join(d, 'in.env')
  writeFileSync(db, Buffer.concat([randomBytes(2_600_000), Buffer.from('MARKER-secret-chat-line-in-plain-text'), randomBytes(1_500_000)]))
  writeFileSync(env, 'JWT_SECRET=MARKER-jwt-secret\n')
  return { db, env, files: [{ name: 'rushlight.db', path: db }, { name: 'server.env', path: env }] }
}
async function encrypted(phrase = makePhrase(), extra = {}) {
  const d = dir()
  const i = inputs(d)
  const out = join(d, 'one.rlbak')
  await encryptBackup({ files: i.files, out, publicRaw: keysFromPhrase(phrase).publicRaw, extra })
  return { d, i, out, phrase }
}
async function restoredTo(out, phrase, to) {
  mkdirSync(to, { recursive: true })
  const written = {}
  await decryptBackup({
    file: out,
    phrase,
    onFile: (name) => {
      const chunks = []
      return { write: async (b) => chunks.push(Buffer.from(b)), end: async () => (written[name] = Buffer.concat(chunks)) }
    }
  })
  return written
}

test('a backup opens with its phrase and gives back exactly what went in, across several chunks', async () => {
  const { i, out, phrase } = await encrypted()
  const back = await restoredTo(out, phrase, dir())
  assert.ok(back['rushlight.db'].equals(readFileSync(i.db)))
  assert.ok(back['server.env'].equals(readFileSync(i.env)))
  assert.equal((await checkBackup({ file: out, phrase })).files.length, 2)
})

test('the file holds no readable text, and a different phrase does not open it', async () => {
  const { out, phrase } = await encrypted()
  const bytes = readFileSync(out)
  assert.equal(bytes.includes(Buffer.from('MARKER')), false)
  assert.equal(bytes.includes(Buffer.from('JWT_SECRET')), false)
  await rejectsWith(checkBackup({ file: out, phrase: makePhrase() }), 'wrong_phrase')
  await rejectsWith(checkBackup({ file: out, phrase: 'not twelve words' }), 'bad_phrase')
  assert.ok(phrase)
})

test('a file that has been changed in any way is refused: a flipped byte, a cut, an extra chunk of rubbish, two chunks swapped', async () => {
  const { out, phrase } = await encrypted()
  const original = readFileSync(out)
  const writeBad = (buf) => {
    const p = out + '.bad'
    writeFileSync(p, buf)
    return p
  }
  const flip = (at) => {
    const copy = Buffer.from(original)
    copy[at] ^= 1
    return writeBad(copy)
  }
  await rejectsWith(checkBackup({ file: flip(2_000_000), phrase }), 'damaged') // inside a chunk
  await rejectsWith(checkBackup({ file: flip(30), phrase }), 'damaged') // the one-time key in the header
  await rejectsWith(checkBackup({ file: flip(original.length - 1), phrase }), 'damaged') // the last chunk's tag
  await rejectsWith(checkBackup({ file: writeBad(original.subarray(0, original.length - 100)), phrase }), 'damaged') // cut short
  await rejectsWith(checkBackup({ file: writeBad(Buffer.concat([original, randomBytes(40)])), phrase }), 'damaged') // trailing rubbish
  // the last whole chunk removed: the new last chunk was not made as the last, so it is refused
  const lens = []
  for (let at = 48; at < original.length; ) {
    const len = original.readUInt32BE(at)
    lens.push([at, 4 + len])
    at += 4 + len
  }
  assert.ok(lens.length >= 3)
  const [lastAt] = lens[lens.length - 1]
  await rejectsWith(checkBackup({ file: writeBad(original.subarray(0, lastAt)), phrase }), 'damaged')
  // two chunks swapped
  const [aAt, aLen] = lens[0]
  const [bAt, bLen] = lens[1]
  const swapped = Buffer.concat([original.subarray(0, aAt), original.subarray(bAt, bAt + bLen), original.subarray(aAt, aAt + aLen), original.subarray(bAt + bLen)])
  await rejectsWith(checkBackup({ file: writeBad(swapped), phrase }), 'damaged')
  await rejectsWith(checkBackup({ file: writeBad(Buffer.from('this is not a backup file at all')), phrase }), 'not_a_backup')
})

test('the key file on the machine holds only the public half, so it cannot open a backup', async () => {
  const phrase = makePhrase()
  const keys = keysFromPhrase(phrase)
  const d = dir()
  const path = join(d, 'backup-public.key')
  writePublicKeyFile(path, keys.publicRaw)
  const text = readFileSync(path, 'utf8')
  assert.deepEqual(Object.keys(JSON.parse(text)).sort(), ['keyId', 'publicKey', 'v'])
  const secret = keys.privateKey.export({ format: 'jwk' }).d
  assert.equal(text.includes(secret), false, 'the private half is not in the file')
  for (const w of phrase.split(' ')) assert.equal(new RegExp(`\\b${w}\\b`).test(text), false, 'a word of the phrase is in the file')
  assert.ok(readPublicKeyFile(path).publicRaw.equals(keys.publicRaw))
  assert.equal(statSync(path).mode & 0o077, 0, 'only the owner can read it')
})

test('seven nights are kept, and one older file for each of four more weeks; everything else goes', () => {
  const names = []
  for (let i = 0; i < 40; i++) {
    const day = new Date(Date.UTC(2026, 9, 4 + i)).toISOString().slice(0, 10) // 2026-10-04 to 2026-11-12
    names.push(`rushlight-${day}-0330.rlbak`)
  }
  names.push('rushlight-2026-11-12-1400.rlbak', 'notes.txt', 'rushlight-old.db')
  const kept = [...selectToKeep(names)].sort()
  const expect = ['11-06', '11-07', '11-08', '11-09', '11-10', '11-11'].map((d) => `rushlight-2026-${d}-0330.rlbak`)
  assert.deepEqual(
    kept,
    [...expect, 'rushlight-2026-11-12-1400.rlbak', 'rushlight-2026-11-05-0330.rlbak', 'rushlight-2026-11-01-0330.rlbak', 'rushlight-2026-10-25-0330.rlbak', 'rushlight-2026-10-18-0330.rlbak'].sort(),
    'two files on the newest day: only the later one is kept'
  )
  assert.equal(kept.length, 11)
  assert.equal(selectToKeep(names, { daily: 7, weekly: 0 }).size, 7)
  assert.equal(selectToKeep([], undefined).size, 0)
})

test('a backup is only due once tonight\'s time has passed and there is none since, so a sleeping computer catches up', () => {
  const settings = { ...backupSettings({ DB_PATH: join(dir(), 'x.db'), BACKUP_TIME: '03:30' }) }
  assert.equal(isDue(settings, new Date(2026, 10, 7, 3, 29)), false)
  assert.equal(isDue(settings, new Date(2026, 10, 7, 3, 31)), true)
  assert.equal(isDue(settings, new Date(2026, 10, 7, 14, 0)), true, 'woke up in the afternoon: still due')
})

// ---- against a real database and a real server ----
async function liveSetup(extraEnv = {}, { keyLater = false } = {}) {
  const d = dir()
  const phrase = makePhrase()
  const publicKeyPath = join(d, 'keys', 'backup-public.key')
  const turnOn = () => writePublicKeyFile(publicKeyPath, keysFromPhrase(phrase).publicRaw)
  if (!keyLater) turnOn()
  const envFile = join(d, 'server.env')
  writeFileSync(envFile, 'JWT_SECRET=live-jwt-secret-for-the-test\nMARKER_ENV=env-marker\n')
  const env = { BACKUP_DIR: join(d, 'backups'), BACKUP_PUBLIC_KEY: publicKeyPath, BACKUP_ENV_FILE: envFile, BACKUP_TIME: '00:00', BACKUP_CHECK_MS: '300', ACCOUNT_LIMIT: '1000', ...extraEnv }
  const srv = await startServer({ env })
  return { d, phrase, srv, env, envFile, turnOn }
}
const settingsFor = (live) => backupSettings({ ...live.env, DB_PATH: live.srv.dbPath })
async function someChat(srv, text) {
  const owner = await newAccount(srv)
  const s = (await srv.call('POST', '/api/servers', { name: 'Hall' }, owner.token)).data
  const ch = (await srv.call('POST', `/api/servers/${s.id}/channels`, { name: 'General', mode: 'text', persistent: true }, owner.token)).data
  for (let i = 0; i < 5; i++) assert.equal((await srv.call('POST', `/api/channels/${ch.id}/messages`, { text: `${text} ${i}` }, owner.token)).status, 200)
  return { owner, ch }
}

test('the server writes the nightly backup by itself, once a day, and it restores to the same data', async () => {
  const live = await liveSetup({}, { keyLater: true }) // the server is already running when the operator sets backups up
  try {
    await someChat(live.srv, 'BACKUP-MARKER-chat')
    await sleep(800)
    assert.equal(existsSync(join(live.d, 'backups')), false, 'nothing is written before backups are set up')
    live.turnOn()
    const backups = join(live.d, 'backups')
    const file = await until(() => existsSync(backups) && readdirSync(backups).find((n) => n.endsWith('.rlbak')), 'the nightly backup')
    await sleep(1500) // several more checks: no second backup the same day
    assert.equal(readdirSync(backups).filter((n) => n.endsWith('.rlbak')).length, 1)
    const status = JSON.parse(readFileSync(join(backups, 'status.json'), 'utf8'))
    assert.ok(status.lastSuccess)
    assert.equal(status.lastFile, file)

    const bytes = readFileSync(join(backups, file))
    assert.equal(bytes.includes(Buffer.from('BACKUP-MARKER')), false, 'no message text in the backup')
    assert.equal(bytes.includes(Buffer.from('live-jwt-secret')), false, 'no secret in the backup')
    assert.equal(readdirSync(backups).some((n) => n.startsWith('.tmp-')), false, 'no plain copy left behind')

    const to = join(live.d, 'restored')
    const manifest = await restoreBackup({ file: join(backups, file), phrase: live.phrase, to })
    assert.deepEqual(readdirSync(to).sort(), ['restored.env', 'rushlight.db'])
    assert.equal(readFileSync(join(to, 'restored.env'), 'utf8'), readFileSync(live.envFile, 'utf8'))
    const restored = new Database(join(to, 'rushlight.db'), { readonly: true })
    assert.equal(restored.pragma('integrity_check', { simple: true }), 'ok')
    assert.equal(restored.prepare("SELECT COUNT(*) AS n FROM messages WHERE text LIKE 'BACKUP-MARKER-chat %'").get().n, 5)
    assert.equal(restored.prepare('SELECT MAX(id) AS id FROM schema_migrations').get().id, manifest.schemaMigration)
    restored.close()

    const log = live.srv.log()
    assert.match(log, /Backup written: rushlight-/)
    assert.equal(log.includes(live.phrase), false, 'the phrase is never in the log')
  } finally {
    await live.srv.stop()
  }
})

test('a backup taken while messages are being written is whole', async () => {
  const live = await liveSetup({ BACKUP_TIME: '23:59', BACKUP_CHECK_MS: '3600000' }) // the nightly job stays out of the way
  try {
    const { owner, ch } = await someChat(live.srv, 'busy')
    let stop = false
    let sent = 0
    const writer = (async () => {
      while (!stop) {
        const r = await live.srv.call('POST', `/api/channels/${ch.id}/messages`, { text: `busy while backing up ${sent}` }, owner.token)
        if (r.status === 200) sent++
      }
    })()
    await sleep(300)
    const results = []
    for (let i = 0; i < 3; i++) results.push(await runBackup(settingsFor(live), { now: new Date(2026, 10, 10 + i, 3, 30) }))
    stop = true
    await writer
    assert.ok(sent > 20, 'the writer kept going during the backups: ' + sent)
    for (const [i, r] of results.entries()) {
      const to = join(live.d, `restored-${i}`)
      await restoreBackup({ file: r.file, phrase: live.phrase, to })
      const db = new Database(join(to, 'rushlight.db'), { readonly: true })
      assert.equal(db.pragma('integrity_check', { simple: true }), 'ok')
      assert.ok(db.prepare('SELECT COUNT(*) AS n FROM messages').get().n >= 5)
      db.close()
    }
  } finally {
    await live.srv.stop()
  }
})

test('retention on real files: twelve nights in a row leave seven and the older ones by week', async () => {
  const live = await liveSetup({ BACKUP_TIME: '23:59', BACKUP_CHECK_MS: '3600000' })
  try {
    await someChat(live.srv, 'keep')
    for (let day = 1; day <= 12; day++) await runBackup(settingsFor(live), { now: new Date(2026, 9, day, 3, 30) })
    const names = readdirSync(join(live.d, 'backups')).filter((n) => n.endsWith('.rlbak')).sort()
    // the newest seven are 10-06 to 10-12, and the older ones are one per week (the week of 09-28 and, among 10-01 to 10-05, the 10-05 file)
    assert.deepEqual(names.slice(-7), [6, 7, 8, 9, 10, 11, 12].map((d) => `rushlight-2026-10-${String(d).padStart(2, '0')}-0330.rlbak`))
    assert.ok(names.length > 7 && names.length <= 11, names.join(', '))
    assert.equal(names.includes('rushlight-2026-10-01-0330.rlbak'), false)
  } finally {
    await live.srv.stop()
  }
})

test('restoring never overwrites, refuses a backup from a newer server, and checking writes nothing', async () => {
  const live = await liveSetup({ BACKUP_TIME: '23:59', BACKUP_CHECK_MS: '3600000' })
  try {
    await someChat(live.srv, 'safe')
    const made = await runBackup(settingsFor(live))
    const busy = join(live.d, 'busy')
    mkdirSync(busy)
    writeFileSync(join(busy, 'existing.txt'), 'keep me')
    await rejectsWith(restoreBackup({ file: made.file, phrase: live.phrase, to: busy }), 'not_empty')
    assert.equal(readFileSync(join(busy, 'existing.txt'), 'utf8'), 'keep me')
    await rejectsWith(restoreBackup({ file: made.file, phrase: makePhrase(), to: join(live.d, 'wrong') }), 'wrong_phrase')
    assert.equal(existsSync(join(live.d, 'wrong')) ? readdirSync(join(live.d, 'wrong')).length : 0, 0, 'a failed restore leaves nothing behind')
    // a backup that says it came from a server with a newer database
    const d = dir()
    const db = join(d, 'x.db')
    new Database(db).close()
    const newer = join(d, 'newer.rlbak')
    await encryptBackup({ files: [{ name: 'rushlight.db', path: db }], out: newer, publicRaw: keysFromPhrase(live.phrase).publicRaw, extra: { schemaMigration: 9999 } })
    await rejectsWith(restoreBackup({ file: newer, phrase: live.phrase, to: join(d, 'out') }), 'newer')
    assert.equal(readdirSync(join(d, 'out')).length, 0)
    const before = readdirSync(live.d).sort()
    await checkBackup({ file: made.file, phrase: live.phrase })
    assert.deepEqual(readdirSync(live.d).sort(), before, 'checking writes nothing')
  } finally {
    await live.srv.stop()
  }
})

test('without a backup key the server says so once and writes nothing', async () => {
  const d = dir()
  const srv = await startServer({ env: { BACKUP_DIR: join(d, 'backups'), BACKUP_PUBLIC_KEY: join(d, 'none.key'), BACKUP_TIME: '00:00', BACKUP_CHECK_MS: '200' } })
  try {
    await until(() => /Backups are not set up/.test(srv.log()), 'the notice')
    await sleep(800)
    assert.equal((srv.log().match(/Backups are not set up/g) || []).length, 1)
    assert.equal(existsSync(join(d, 'backups')), false)
  } finally {
    await srv.stop()
  }
})

// ---- the command line tool, driven through its real prompts ----
function cli(args, env, answer) {
  return new Promise((resolve) => {
    const child = spawn('node', ['src/backup-cli.js', ...args], { cwd: new URL('..', import.meta.url).pathname, env: { ...process.env, ...env, NODE_ENV: 'test' } })
    let output = ''
    child.stdout.on('data', (d) => {
      output += d
      const reply = answer && answer(output)
      if (reply) child.stdin.write(reply + '\n')
    })
    child.stderr.on('data', (d) => (output += d))
    child.on('close', (code) => resolve({ code, output }))
  })
}

test('the command line tool sets backups up, writes one, lists it, checks it and restores it, asking for the phrase and never taking it on the command line', async () => {
  const d = dir()
  const dbPath = join(d, 'data', 'rushlight.db')
  mkdirSync(join(d, 'data'))
  const seed = new Database(dbPath)
  seed.pragma('journal_mode = WAL')
  seed.exec("CREATE TABLE schema_migrations (id INTEGER PRIMARY KEY, name TEXT, applied_at INTEGER); INSERT INTO schema_migrations VALUES (1, 'x', 0); CREATE TABLE notes (t TEXT); INSERT INTO notes VALUES ('CLI-MARKER-row');")
  seed.close()
  const env = { DB_PATH: dbPath, BACKUP_ENV_FILE: join(d, 'none.env'), BACKUP_TIME: '03:30' }

  // setup: the tool shows twelve numbered words, then asks for three of them back
  const asked = new Set()
  const setup = await cli(['setup'], env, (out) => {
    const m = /type word number (\d+): $/.exec(out)
    if (!m || asked.has(out.length)) return null
    asked.add(out.length)
    const words = [...out.matchAll(/^\s+(\d+)\s+([a-z]+)$/gm)].map((x) => x[2])
    return words[Number(m[1]) - 1]
  })
  assert.equal(setup.code, 0, setup.output)
  assert.match(setup.output, /Backups are on/)
  const phrase = [...setup.output.matchAll(/^\s+(\d+)\s+([a-z]+)$/gm)].map((x) => x[2]).join(' ')
  assert.equal(phrase.split(' ').length, 12)
  assert.ok(existsSync(join(d, 'data', 'backup-public.key')))
  assert.equal(readFileSync(join(d, 'data', 'backup-public.key'), 'utf8').includes(phrase.split(' ')[0] + ' '), false)
  assert.match((await cli(['setup'], env)).output, /already set up/)

  const now = await cli(['now'], env)
  assert.equal(now.code, 0, now.output)
  const made = /Backup written: (.+\.rlbak)/.exec(now.output)[1]
  assert.equal(readFileSync(made).includes(Buffer.from('CLI-MARKER')), false)
  const list = await cli(['list'], env)
  assert.match(list.output, /Backups are on/)
  assert.match(list.output, /Last backup that worked/)

  const give = (out) => (/phrase: $/.test(out) ? phrase : null)
  const wrong = await cli(['check', made], env, (out) => (/phrase: $/.test(out) ? makePhrase() : null))
  assert.equal(wrong.code, 1)
  assert.match(wrong.output, /does not open this backup/)
  const good = await cli(['check', made], env, give)
  assert.equal(good.code, 0, good.output)
  assert.match(good.output, /Good\./)
  const to = join(d, 'restored')
  const restored = await cli(['restore', made, to], env, give)
  assert.equal(restored.code, 0, restored.output)
  const db = new Database(join(to, 'rushlight.db'), { readonly: true })
  assert.equal(db.prepare('SELECT t FROM notes').get().t, 'CLI-MARKER-row')
  db.close()
  const again = await cli(['restore', made, to], env, give)
  assert.equal(again.code, 1)
  assert.match(again.output, /not empty/)
})
