// Writes a consistent copy of the database to backups/ (next to the server) and
// prints its path. Safe to run while the server is up. Keeps the newest 10.
//
//   node scripts/backup-db.js
import 'dotenv/config'
import Database from 'better-sqlite3'
import { existsSync, mkdirSync, readdirSync, rmSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join, resolve } from 'node:path'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const dbPath = process.env.DB_PATH ? resolve(process.env.DB_PATH) : join(root, 'rushlight.db')
const KEEP = 10

if (!existsSync(dbPath)) {
  console.error(`No database at ${dbPath}, nothing to back up.`)
  process.exit(2)
}

const dir = join(root, 'backups')
mkdirSync(dir, { recursive: true })
const stamp = new Date().toISOString().replace(/[:.]/g, '-')
const target = join(dir, `rushlight-${stamp}.db`)

const db = new Database(dbPath, { readonly: true })
await db.backup(target)
db.close()

const old = readdirSync(dir)
  .filter((f) => /^rushlight-.*\.db$/.test(f))
  .sort()
  .reverse()
  .slice(KEEP)
for (const f of old) rmSync(join(dir, f), { force: true })

console.log(target)
