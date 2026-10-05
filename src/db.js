import Database from 'better-sqlite3'
import { fileURLToPath } from 'url'
import { dirname, join } from 'path'
import { runMigrations } from './migrations.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const dbPath = process.env.DB_PATH || join(__dirname, '..', 'rushlight.db')

export const db = new Database(dbPath)
db.pragma('journal_mode = WAL')

const applied = runMigrations(db)
if (applied.length) {
  console.log(
    `Applied ${applied.length} migration(s): ${applied.map((m) => m.name).join(', ')}`
  )
}

export default db
