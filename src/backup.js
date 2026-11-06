// Encrypted nightly backups. The design (approved by the owner, Nov 7): the machine can WRITE backups but cannot READ them.
//
//  - At setup a key pair is made. The private half becomes a 12-word backup phrase, shown once and never stored on the
//    machine; only the public half is kept (backup-public.key). A stolen backup folder is useless, and so is a hacked server:
//    it cannot open the old backups. Restoring needs the phrase, and no user's account.
//  - Each backup is one file: a header, then the data in 1 MiB AES-256-GCM chunks under a fresh key for that file, made from
//    a one-time X25519 exchange with the public half. Each chunk is bound to its position and to whether it is the last,
//    so a changed, reordered or cut-short file is refused.
//  - What goes in: the whole database (taken with SQLite's own backup call, so it is consistent while the server runs) and
//    the server's .env if there is one (so a restore keeps people signed in and keeps the Jellyfin link).
//  - Kept: the newest 7 nights and the last file of each of the 4 weeks before that.
// Only Node's own crypto is used. Nothing here ever logs the phrase, a key or a message.
import { createHash, createCipheriv, createDecipheriv, createPrivateKey, createPublicKey, diffieHellman, generateKeyPairSync, hkdfSync, randomBytes } from 'node:crypto'
import { createReadStream, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync, copyFileSync, renameSync } from 'node:fs'
import { open } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import Database from 'better-sqlite3'
import { generateRecoveryKey, normalizeRecoveryKey } from './recoverykey.js'
import { migrations } from './migrations.js'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const MAGIC = Buffer.from('RLBAK001')
const CHUNK = 1024 * 1024
const PKCS8_X25519 = Buffer.from('302e020100300506032b656e04220420', 'hex')
export const BACKUP_EXT = '.rlbak'
export const DEFAULT_KEEP = { daily: 7, weekly: 4 }
const FILE_NAMES = new Set(['rushlight.db', 'server.env'])

export class BackupError extends Error {
  constructor(code, message) {
    super(message)
    this.code = code
  }
}

// ---- the phrase and the keys ----
export const makePhrase = () => generateRecoveryKey()
export const cleanPhrase = (text) => normalizeRecoveryKey(text)

// The same phrase always gives the same key pair. 12 words from 2048 is 132 bits, so no slow hash is needed.
export function keysFromPhrase(text) {
  const phrase = cleanPhrase(text)
  if (!phrase) throw new BackupError('bad_phrase', 'A backup phrase is 12 words from the list.')
  const seed = Buffer.from(hkdfSync('sha256', Buffer.from(phrase), Buffer.from('rushlight-backup-v1'), Buffer.from('x25519 seed'), 32))
  const privateKey = createPrivateKey({ key: Buffer.concat([PKCS8_X25519, seed]), format: 'der', type: 'pkcs8' })
  const publicRaw = Buffer.from(createPublicKey(privateKey).export({ format: 'jwk' }).x, 'base64url')
  return { privateKey, publicRaw, keyId: keyIdOf(publicRaw) }
}
const keyIdOf = (publicRaw) => createHash('sha256').update(publicRaw).digest().subarray(0, 8)

const spkiX25519 = (raw) => createPublicKey({ key: Buffer.concat([Buffer.from('302a300506032b656e032100', 'hex'), raw]), format: 'der', type: 'spki' })

// The only thing the machine keeps. It holds no secret: it can encrypt to the phrase's key, nothing more.
export function writePublicKeyFile(path, publicRaw) {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, JSON.stringify({ v: 1, publicKey: publicRaw.toString('base64url'), keyId: keyIdOf(publicRaw).toString('hex') }, null, 2) + '\n', { mode: 0o600 })
}
export function readPublicKeyFile(path) {
  const data = JSON.parse(readFileSync(path, 'utf8'))
  const publicRaw = Buffer.from(String(data.publicKey), 'base64url')
  if (data.v !== 1 || publicRaw.length !== 32) throw new BackupError('bad_key_file', 'The backup key file is not valid.')
  return { publicRaw, keyId: keyIdOf(publicRaw) }
}

// ---- where things live (the same defaults as the rest of the server) ----
export function backupSettings(env = process.env) {
  const dbPath = env.DB_PATH ? resolve(env.DB_PATH) : join(root, 'rushlight.db')
  const dataDir = dirname(dbPath)
  return {
    dbPath,
    dir: env.BACKUP_DIR ? resolve(env.BACKUP_DIR) : join(dataDir, 'backups'),
    copyDir: env.BACKUP_COPY_DIR ? resolve(env.BACKUP_COPY_DIR) : null,
    publicKeyPath: env.BACKUP_PUBLIC_KEY ? resolve(env.BACKUP_PUBLIC_KEY) : join(dataDir, 'backup-public.key'),
    envPath: env.BACKUP_ENV_FILE ? resolve(env.BACKUP_ENV_FILE) : join(root, '.env'),
    time: /^\d{1,2}:\d{2}$/.test(env.BACKUP_TIME || '') ? env.BACKUP_TIME : '03:30',
    keep: {
      daily: Number(env.BACKUP_KEEP_DAILY) || DEFAULT_KEEP.daily,
      weekly: env.BACKUP_KEEP_WEEKLY !== undefined && env.BACKUP_KEEP_WEEKLY !== '' ? Number(env.BACKUP_KEEP_WEEKLY) : DEFAULT_KEEP.weekly
    },
    checkMs: Number(env.BACKUP_CHECK_MS) || 10 * 60 * 1000
  }
}

// ---- the file format ----
const nonce = (counter) => {
  const n = Buffer.alloc(12)
  n.writeBigUInt64BE(BigInt(counter), 4)
  return n
}
const fileKey = (shared, ephPub, recipientPub) => Buffer.from(hkdfSync('sha256', shared, Buffer.concat([ephPub, recipientPub]), Buffer.from('rushlight-backup-v1 file'), 32))

async function sha256File(path) {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(path)) hash.update(chunk)
  return hash.digest('hex')
}

// Plain bytes in order: the manifest's length and text, then each file. Yielded in pieces; the caller re-cuts them to 1 MiB.
async function* plainStream(manifest, files) {
  const text = Buffer.from(JSON.stringify(manifest))
  const len = Buffer.alloc(4)
  len.writeUInt32BE(text.length)
  yield len
  yield text
  for (const f of files) for await (const chunk of createReadStream(f.path, { highWaterMark: CHUNK })) yield chunk
}
async function* chunked(source) {
  let held = Buffer.alloc(0)
  for await (const piece of source) {
    held = held.length ? Buffer.concat([held, piece]) : piece
    while (held.length > CHUNK) {
      yield held.subarray(0, CHUNK)
      held = held.subarray(CHUNK)
    }
  }
  yield held
}

// Writes one encrypted backup to `out` (through a .partial file, so a crash never leaves half a backup under its real name).
export async function encryptBackup({ files, out, publicRaw, extra = {} }) {
  const listed = []
  for (const f of files) listed.push({ name: f.name, path: f.path, size: statSync(f.path).size, sha256: await sha256File(f.path) })
  const manifest = { format: 1, createdAt: Date.now(), ...extra, files: listed.map(({ name, size, sha256 }) => ({ name, size, sha256 })) }
  const eph = generateKeyPairSync('x25519')
  const ephPub = Buffer.from(eph.publicKey.export({ format: 'jwk' }).x, 'base64url')
  const key = fileKey(diffieHellman({ privateKey: eph.privateKey, publicKey: spkiX25519(publicRaw) }), ephPub, publicRaw)
  const header = Buffer.concat([MAGIC, keyIdOf(publicRaw), ephPub])
  const partial = out + '.partial'
  const handle = await open(partial, 'w', 0o600)
  try {
    await handle.write(header)
    let counter = 0
    let previous = null
    const seal = async (plain, last) => {
      const cipher = createCipheriv('aes-256-gcm', key, nonce(counter++))
      cipher.setAAD(Buffer.concat([header, Buffer.from([last ? 1 : 0])]))
      const body = Buffer.concat([cipher.update(plain), cipher.final(), cipher.getAuthTag()])
      const len = Buffer.alloc(4)
      len.writeUInt32BE(body.length)
      await handle.write(Buffer.concat([len, body]))
    }
    for await (const chunk of chunked(plainStream(manifest, listed))) {
      if (previous) await seal(previous, false)
      previous = chunk
    }
    await seal(previous || Buffer.alloc(0), true)
    await handle.sync()
  } catch (err) {
    await handle.close()
    rmSync(partial, { force: true })
    throw err
  }
  await handle.close()
  renameSync(partial, out)
  return manifest
}

// Opens a backup with the phrase. `onFile(name, size)` returns a writer { write(buf), end() } or null to only check it.
// Throws BackupError: wrong_phrase, not_a_backup, damaged. Verifies every chunk and every file's hash.
export async function decryptBackup({ file, phrase, onFile }) {
  const keys = keysFromPhrase(phrase)
  const handle = await open(file, 'r')
  try {
    const total = (await handle.stat()).size
    const header = Buffer.alloc(MAGIC.length + 8 + 32)
    const got = await handle.read(header, 0, header.length, 0)
    if (got.bytesRead !== header.length || !header.subarray(0, MAGIC.length).equals(MAGIC)) throw new BackupError('not_a_backup', 'That is not a Rushlight backup file.')
    if (!header.subarray(MAGIC.length, MAGIC.length + 8).equals(keys.keyId)) throw new BackupError('wrong_phrase', 'That phrase does not open this backup. It may be from before the phrase was changed, or the words are wrong.')
    const key = fileKey(diffieHellman({ privateKey: keys.privateKey, publicKey: spkiX25519(header.subarray(MAGIC.length + 8)) }), header.subarray(MAGIC.length + 8), keys.publicRaw)
    const damaged = () => new BackupError('damaged', 'This backup file is damaged or has been changed, so it cannot be used.')

    let offset = header.length
    let counter = 0
    let buffer = Buffer.alloc(0)
    let manifest = null
    let state = null // { file, writer, hash, left }
    let fileIndex = 0
    const done = []
    const take = (n) => {
      const out = buffer.subarray(0, n)
      buffer = buffer.subarray(n)
      return out
    }
    const consume = async () => {
      for (;;) {
        if (!manifest) {
          if (buffer.length < 4) return
          const len = buffer.readUInt32BE(0)
          if (len > 1024 * 1024) throw damaged()
          if (buffer.length < 4 + len) return
          take(4)
          try {
            manifest = JSON.parse(take(len).toString('utf8'))
          } catch {
            throw damaged()
          }
          if (manifest.format !== 1 || !Array.isArray(manifest.files) || manifest.files.some((f) => !FILE_NAMES.has(f.name) || !Number.isInteger(f.size) || f.size < 0)) throw damaged()
          continue
        }
        if (!state) {
          if (fileIndex >= manifest.files.length) return
          const f = manifest.files[fileIndex++]
          state = { file: f, writer: onFile ? onFile(f.name, f.size) : null, hash: createHash('sha256'), left: f.size }
          if (state.left === 0) {
            await finishFile()
            continue
          }
        }
        if (!buffer.length) return
        const piece = take(Math.min(state.left, buffer.length))
        state.hash.update(piece)
        if (state.writer) await state.writer.write(piece)
        state.left -= piece.length
        if (state.left === 0) await finishFile()
      }
    }
    const finishFile = async () => {
      const ok = state.hash.digest('hex') === state.file.sha256
      if (state.writer) await state.writer.end()
      if (!ok) throw damaged()
      done.push(state.file.name)
      state = null
    }

    for (;;) {
      const lenBuf = Buffer.alloc(4)
      if ((await handle.read(lenBuf, 0, 4, offset)).bytesRead !== 4) throw damaged()
      const len = lenBuf.readUInt32BE(0)
      if (len < 16 || len > CHUNK + 16 || offset + 4 + len > total) throw damaged()
      const body = Buffer.alloc(len)
      if ((await handle.read(body, 0, len, offset + 4)).bytesRead !== len) throw damaged()
      offset += 4 + len
      const last = offset === total
      const decipher = createDecipheriv('aes-256-gcm', key, nonce(counter++))
      decipher.setAAD(Buffer.concat([header, Buffer.from([last ? 1 : 0])]))
      decipher.setAuthTag(body.subarray(len - 16))
      let plain
      try {
        plain = Buffer.concat([decipher.update(body.subarray(0, len - 16)), decipher.final()])
      } catch {
        throw damaged()
      }
      buffer = buffer.length ? Buffer.concat([buffer, plain]) : plain
      await consume()
      if (last) break
    }
    await consume()
    if (!manifest || state || buffer.length || done.length !== manifest.files.length) throw damaged()
    return manifest
  } finally {
    await handle.close()
  }
}

// ---- retention: the newest 7 nights, and the last file of each of the 4 weeks before them ----
const fileDate = (name) => (/^rushlight-(\d{4}-\d{2}-\d{2})(?:-\d{4})?\.rlbak$/.exec(name) || [])[1] || null
function weekOf(date) {
  const d = new Date(date + 'T00:00:00Z')
  d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7)) // back to Monday
  return d.toISOString().slice(0, 10)
}
// `names`: file names. Returns the names to keep; anything not listed is to be deleted.
export function selectToKeep(names, keep = DEFAULT_KEEP) {
  const newest = new Map() // date -> newest file that day (names sort by date and then time)
  for (const name of [...names].sort()) {
    const date = fileDate(name)
    if (date) newest.set(date, name)
  }
  const dates = [...newest.keys()].sort().reverse()
  const kept = new Set(dates.slice(0, keep.daily).map((d) => newest.get(d)))
  const weeks = new Map()
  for (const date of dates.slice(keep.daily)) if (!weeks.has(weekOf(date))) weeks.set(weekOf(date), newest.get(date)) // dates run newest first
  for (const name of [...weeks.values()].slice(0, keep.weekly)) kept.add(name)
  return kept
}
export function listBackups(dir) {
  if (!existsSync(dir)) return []
  return readdirSync(dir)
    .filter((n) => fileDate(n))
    .sort()
    .reverse()
    .map((name) => ({ name, path: join(dir, name), size: statSync(join(dir, name)).size, date: fileDate(name) }))
}
function applyRetention(dir, keep) {
  const names = listBackups(dir).map((b) => b.name)
  const kept = selectToKeep(names, keep)
  for (const name of names) if (!kept.has(name)) rmSync(join(dir, name), { force: true })
}

// ---- making a backup ----
const two = (n) => String(n).padStart(2, '0')
export const stampFor = (d = new Date()) => `${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())}-${two(d.getHours())}${two(d.getMinutes())}`

export async function runBackup(settings = backupSettings(), { now = new Date() } = {}) {
  if (!existsSync(settings.publicKeyPath)) throw new BackupError('not_set_up', 'Backups are not set up yet. Run the backup setup first.')
  if (!existsSync(settings.dbPath)) throw new BackupError('no_database', `No database at ${settings.dbPath}.`)
  const { publicRaw } = readPublicKeyFile(settings.publicKeyPath)
  mkdirSync(settings.dir, { recursive: true, mode: 0o700 })
  const tag = randomBytes(6).toString('hex')
  const tmpDb = join(settings.dir, `.tmp-${tag}.db`)
  const tmpEnv = join(settings.dir, `.tmp-${tag}.env`)
  const out = join(settings.dir, `rushlight-${stampFor(now)}${BACKUP_EXT}`)
  let schemaMigration = 0
  try {
    const source = new Database(settings.dbPath, { readonly: true })
    try {
      await source.backup(tmpDb)
      schemaMigration = source.prepare('SELECT MAX(id) AS id FROM schema_migrations').get().id || 0
    } finally {
      source.close()
    }
    const copy = new Database(tmpDb, { readonly: true })
    try {
      if (copy.pragma('quick_check', { simple: true }) !== 'ok') throw new BackupError('bad_copy', 'The copy of the database did not pass its check, so no backup was written.')
    } finally {
      copy.close()
    }
    const files = [{ name: 'rushlight.db', path: tmpDb }]
    if (existsSync(settings.envPath)) {
      writeFileSync(tmpEnv, readFileSync(settings.envPath), { mode: 0o600 })
      files.push({ name: 'server.env', path: tmpEnv })
    }
    await encryptBackup({ files, out, publicRaw, extra: { schemaMigration, node: process.version } })
  } finally {
    // the plain copy, its SQLite side files (opening it to check it makes them), and the env copy: nothing plain stays behind
    for (const p of [tmpDb, `${tmpDb}-wal`, `${tmpDb}-shm`, `${tmpDb}-journal`, tmpEnv]) rmSync(p, { force: true })
  }
  applyRetention(settings.dir, settings.keep)
  let copied = null
  if (settings.copyDir) {
    try {
      mkdirSync(settings.copyDir, { recursive: true })
      copyFileSync(out, join(settings.copyDir, out.split(/[\\/]/).pop()))
      applyRetention(settings.copyDir, settings.keep)
      copied = settings.copyDir
    } catch (err) {
      writeStatus(settings, { copyError: err.message })
    }
  }
  const result = { file: out, size: statSync(out).size, copied }
  writeStatus(settings, { lastSuccess: now.getTime(), lastFile: out.split(/[\\/]/).pop(), lastError: null })
  return result
}

// ---- restoring and checking ----
// Restores into an EMPTY folder: rushlight.db and, if there was one, server.env. It never overwrites anything.
export async function restoreBackup({ file, phrase, to }) {
  if (existsSync(to) && readdirSync(to).length) throw new BackupError('not_empty', `${to} is not empty. Restore into a new, empty folder.`)
  mkdirSync(to, { recursive: true, mode: 0o700 })
  const writers = []
  try {
    const manifest = await decryptBackup({
      file,
      phrase,
      onFile: (name) => {
        const handlePromise = open(join(to, name === 'server.env' ? 'restored.env' : 'rushlight.db'), 'w', 0o600)
        const w = { write: async (buf) => (await handlePromise).write(buf), end: async () => (await handlePromise).close() }
        writers.push(w)
        return w
      }
    })
    const latest = Number(readLatestMigration())
    if (latest && manifest.schemaMigration > latest) throw new BackupError('newer', 'This backup is from a newer server. Update the server first, then restore.')
    return manifest
  } catch (err) {
    for (const f of readdirSync(to)) rmSync(join(to, f), { force: true })
    throw err
  }
}
const readLatestMigration = () => migrations.reduce((max, m) => Math.max(max, m.id), 0)
export async function checkBackup({ file, phrase }) {
  return decryptBackup({ file, phrase, onFile: () => null })
}

// ---- status and the nightly schedule ----
const statusPath = (settings) => join(settings.dir, 'status.json')
function writeStatus(settings, patch) {
  try {
    mkdirSync(settings.dir, { recursive: true, mode: 0o700 })
    const now = readStatus(settings)
    writeFileSync(statusPath(settings), JSON.stringify({ ...now, ...patch }, null, 2) + '\n', { mode: 0o600 })
  } catch {
    // a status file is a convenience
  }
}
export function readStatus(settings = backupSettings()) {
  try {
    return JSON.parse(readFileSync(statusPath(settings), 'utf8'))
  } catch {
    return {}
  }
}

// True when tonight's time has passed and there is no backup since it. A computer that was asleep at 03:30 catches up when it wakes.
export function isDue(settings, now = new Date()) {
  const [h, m] = settings.time.split(':').map(Number)
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate(), h, m, 0, 0)
  if (now < today) return false
  const last = readStatus(settings).lastSuccess || 0
  return last < today.getTime()
}

export function startBackupScheduler(settings = backupSettings(), log = console) {
  let running = false
  let told = false
  const tick = async () => {
    if (running) return
    if (!existsSync(settings.publicKeyPath)) {
      if (!told) log.log('Backups are not set up. Run "npm run backups -- setup" to turn on encrypted nightly backups.')
      told = true
      return
    }
    if (!isDue(settings)) return
    running = true
    try {
      const done = await runBackup(settings)
      log.log(`Backup written: ${done.file.split(/[\\/]/).pop()} (${(done.size / 1048576).toFixed(1)} MB)`)
    } catch (err) {
      writeStatus(settings, { lastError: err.message, lastErrorAt: Date.now() })
      log.error('Backup failed:', err.message)
    } finally {
      running = false
    }
  }
  const timer = setInterval(tick, settings.checkMs)
  timer.unref()
  setTimeout(tick, Math.min(30_000, settings.checkMs)).unref()
  return () => clearInterval(timer)
}
