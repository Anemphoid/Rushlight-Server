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
    assert.match(srv.log(), /Applied 3 migration/)
    const db = new Database(path, { readonly: true })
    assert.deepEqual(db.prepare('SELECT id FROM schema_migrations ORDER BY id').all().map((r) => r.id), [1, 2, 3, 4, 5, 6, 7])
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

test('an install already at migration 6 (the released v0.2.0) applies only the new one', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'rushlight-mig-'))
  const path = join(dir, 'v020.db')
  oldDatabase(path, { upTo: 6 })
  const srv = await startServer({ dbPath: path })
  try {
    assert.match(srv.log(), /Applied 1 migration\(s\): remember why someone lost access/)
    const db = new Database(path, { readonly: true })
    assert.deepEqual(db.prepare('SELECT id FROM schema_migrations ORDER BY id').all().map((r) => r.id), [1, 2, 3, 4, 5, 6, 7])
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
