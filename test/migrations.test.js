import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Database from 'better-sqlite3'
import { migrations } from '../src/migrations.js'
import { startServer } from './helpers.js'

// Build a database exactly as an install from before these fixes has it:
// migrations 1 to 4 applied, with real-looking data in it.
function oldDatabase(path, { clashingUsernames = false, upTo = 4 } = {}) {
  const db = new Database(path)
  db.exec('CREATE TABLE schema_migrations (id INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at INTEGER NOT NULL)')
  for (const m of migrations.filter((m) => m.id <= upTo)) {
    db.transaction(() => {
      m.up(db)
      db.prepare('INSERT INTO schema_migrations (id, name, applied_at) VALUES (?, ?, ?)').run(m.id, m.name, Date.now())
    })()
  }
  const add = db.prepare("INSERT INTO accounts (username, password_hash, is_admin, created_at) VALUES (?, 'x', 0, 1)")
  add.run('Anemphoid')
  add.run('dad')
  if (clashingUsernames) add.run('anemphoid')
  db.prepare("INSERT INTO servers (name, owner_id, created_at) VALUES ('Home', 1, 1)").run()
  db.prepare('INSERT INTO server_members (server_id, account_id, is_admin, joined_at) VALUES (1, 1, 1, 1)').run()
  db.prepare("INSERT INTO join_codes (code, server_id, created_by, created_at) VALUES ('old-code-12', 1, 1, 1)").run()
  db.close()
}

test('an existing database upgrades in place and keeps its data', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'rushlight-mig-'))
  const path = join(dir, 'old.db')
  oldDatabase(path)
  const srv = await startServer({ dbPath: path })
  try {
    assert.match(srv.log(), /Applied 5 migration/)
    const db = new Database(path, { readonly: true })
    assert.deepEqual(db.prepare('SELECT id FROM schema_migrations ORDER BY id').all().map((r) => r.id), [1, 2, 3, 4, 5, 6, 7, 8, 9])
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM accounts').get().n, 2)
    assert.equal(db.prepare('SELECT revoked FROM join_codes').get().revoked, 0)
    assert.ok(db.prepare("SELECT 1 FROM sqlite_master WHERE name = 'idx_accounts_username_nocase'").get())
    db.close()
    // an old, never-revoked code still works for a new account
    const r = await srv.call('POST', '/api/register', { username: 'newcomer', password: 'password123' })
    const join = await srv.call('POST', '/api/servers/join', { code: 'old-code-12' }, r.data.token)
    assert.equal(join.status, 200)
    // and the database now refuses case variants of existing names
    assert.equal((await srv.call('POST', '/api/register', { username: 'ANEMPHOID', password: 'password123' })).status, 409)
  } finally {
    await srv.stop()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('existing usernames that differ only by case do not stop the server from starting', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'rushlight-mig-'))
  const path = join(dir, 'clash.db')
  oldDatabase(path, { clashingUsernames: true })
  const srv = await startServer({ dbPath: path })
  try {
    assert.match(srv.log(), /Skipping the case-insensitive username index/)
    // both old accounts can still log in
    for (const name of ['Anemphoid', 'anemphoid']) {
      const r = await srv.call('POST', '/api/login', { username: name, password: 'x' })
      assert.equal(r.status, 401) // wrong password, but a clean answer, not a crash
    }
    // new registrations are still checked in code
    assert.equal((await srv.call('POST', '/api/register', { username: 'DAD', password: 'password123' })).status, 409)
  } finally {
    await srv.stop()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('an install already at migration 6 (the released v0.2.0) applies the newer ones', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'rushlight-mig-'))
  const path = join(dir, 'v020.db')
  oldDatabase(path, { upTo: 6 })
  const srv = await startServer({ dbPath: path })
  try {
    assert.match(srv.log(), /Applied 3 migration\(s\): remember why someone lost access to a server, join codes can be limited to one channel or room, account recovery keys and sign-out-everywhere/)
    const db = new Database(path, { readonly: true })
    assert.deepEqual(db.prepare('SELECT id FROM schema_migrations ORDER BY id').all().map((r) => r.id), [1, 2, 3, 4, 5, 6, 7, 8, 9])
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM accounts').get().n, 2)
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM access_ends').get().n, 0)
    db.close()
    // the existing server and account are untouched
    const login = await srv.call('POST', '/api/register', { username: 'afterwards', password: 'password123' })
    assert.equal(login.status, 200)
  } finally {
    await srv.stop()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('an install at migration 7 (the released v0.3.0) gets scoped codes and its old codes keep working', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'rushlight-mig-'))
  const path = join(dir, 'v030.db')
  oldDatabase(path, { upTo: 7 })
  const seed = new Database(path)
  seed.prepare("INSERT INTO join_codes (code, server_id, created_by, created_at) VALUES ('old-code-34', 1, 1, 1)").run()
  seed.close()
  const srv = await startServer({ dbPath: path })
  try {
    assert.match(srv.log(), /Applied 2 migration\(s\): join codes can be limited to one channel or room, account recovery keys and sign-out-everywhere/)
    const db = new Database(path, { readonly: true })
    assert.deepEqual(db.prepare('SELECT id FROM schema_migrations ORDER BY id').all().map((r) => r.id), [1, 2, 3, 4, 5, 6, 7, 8, 9])
    const row = db.prepare('SELECT scope_type, scope_id FROM join_codes').get()
    assert.deepEqual(row, { scope_type: null, scope_id: null }) // old codes stay server-wide
    db.close()
    const r = await srv.call('POST', '/api/register', { username: 'afterwards', password: 'password123' })
    assert.equal((await srv.call('POST', '/api/servers/join', { code: 'old-code-12' }, r.data.token)).status, 200)
    const guest = await srv.call('POST', '/api/join', { code: 'old-code-34', screenName: 'Old Code Guest' })
    assert.equal(guest.status, 200)
  } finally {
    await srv.stop()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('an install at migration 8 (the released v0.4.1) keeps every account working and asks for a key', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'rushlight-mig-'))
  const path = join(dir, 'v041.db')
  oldDatabase(path, { upTo: 8 })
  // a real account with a real password, made before accounts had keys
  const bcrypt = (await import('bcryptjs')).default
  const seed = new Database(path)
  seed.prepare("INSERT INTO accounts (username, password_hash, is_admin, created_at) VALUES ('veteran', ?, 0, 1)").run(bcrypt.hashSync('old-password-1', 4))
  seed.close()
  const srv = await startServer({ dbPath: path })
  try {
    assert.match(srv.log(), /Applied 1 migration\(s\): account recovery keys and sign-out-everywhere/)
    const db = new Database(path, { readonly: true })
    const cols = db.prepare('PRAGMA table_info(accounts)').all().map((c) => c.name)
    for (const c of ['recovery_key_hash', 'pending_recovery_key_hash', 'recovery_key_set_at', 'session_epoch']) assert.ok(cols.includes(c), c)
    const row = db.prepare("SELECT recovery_key_hash, session_epoch FROM accounts WHERE username = 'veteran'").get()
    assert.deepEqual(row, { recovery_key_hash: null, session_epoch: 0 })
    db.close()
    // they log in as before, are told they have no key yet, and can ask for one
    const login = await srv.call('POST', '/api/login', { username: 'veteran', password: 'old-password-1' })
    assert.equal(login.status, 200)
    assert.equal(login.data.recoveryKeyAcked, false)
    assert.equal((await srv.call('GET', '/api/me', undefined, login.data.token)).data.recoveryKeyAcked, false)
    const made = await srv.call('POST', '/api/me/recovery-key', { password: 'old-password-1' }, login.data.token)
    assert.equal(made.status, 200)
    assert.equal(made.data.recoveryKey.split(' ').length, 12)
  } finally {
    await srv.stop()
    rmSync(dir, { recursive: true, force: true })
  }
})
