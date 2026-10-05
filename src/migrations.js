// Schema migrations. Each one runs at most once, ever, tracked in
// schema_migrations, and runs inside its own transaction: if it throws, none
// of its changes are kept and the server refuses to start rather than run
// against a half-migrated database.
//
// Migration 1 is exactly the CREATE TABLE IF NOT EXISTS block this project
// started with. It's safe to run against both a brand-new database and an
// existing one that predates this file (the tables already match, so it's a
// no-op there) — that's what lets every earlier installation adopt this
// system without losing anything. Every migration after it can assume
// migration 1 has already run.
export const migrations = [
  {
    id: 1,
    name: 'baseline schema',
    up(db) {
      db.exec(`
        CREATE TABLE IF NOT EXISTS accounts (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          username TEXT UNIQUE NOT NULL,
          password_hash TEXT NOT NULL,
          flare TEXT,
          is_admin INTEGER NOT NULL DEFAULT 0,
          created_at INTEGER NOT NULL
        );

        CREATE TABLE IF NOT EXISTS servers (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          name TEXT NOT NULL,
          owner_id INTEGER NOT NULL REFERENCES accounts(id),
          created_at INTEGER NOT NULL
        );

        CREATE TABLE IF NOT EXISTS server_members (
          server_id INTEGER NOT NULL REFERENCES servers(id),
          account_id INTEGER NOT NULL REFERENCES accounts(id),
          is_admin INTEGER NOT NULL DEFAULT 0,
          joined_at INTEGER NOT NULL,
          PRIMARY KEY (server_id, account_id)
        );

        CREATE TABLE IF NOT EXISTS channels (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          server_id INTEGER NOT NULL REFERENCES servers(id),
          name TEXT NOT NULL,
          mode TEXT NOT NULL DEFAULT 'both',
          persistent INTEGER NOT NULL DEFAULT 0,
          position INTEGER NOT NULL DEFAULT 0,
          created_at INTEGER NOT NULL
        );

        CREATE TABLE IF NOT EXISTS rooms (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          channel_id INTEGER NOT NULL REFERENCES channels(id),
          name TEXT NOT NULL,
          mode TEXT NOT NULL DEFAULT 'both',
          persistent INTEGER NOT NULL DEFAULT 0,
          position INTEGER NOT NULL DEFAULT 0,
          created_at INTEGER NOT NULL
        );

        CREATE TABLE IF NOT EXISTS messages (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          channel_id INTEGER REFERENCES channels(id),
          room_id INTEGER REFERENCES rooms(id),
          author_account_id INTEGER REFERENCES accounts(id),
          author_name TEXT NOT NULL,
          author_avatar_color TEXT,
          text TEXT NOT NULL,
          created_at INTEGER NOT NULL
        );

        CREATE TABLE IF NOT EXISTS join_codes (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          code TEXT UNIQUE NOT NULL,
          server_id INTEGER NOT NULL REFERENCES servers(id),
          created_by INTEGER REFERENCES accounts(id),
          persistent INTEGER NOT NULL DEFAULT 0,
          single_use INTEGER NOT NULL DEFAULT 1,
          expires_at INTEGER,
          used INTEGER NOT NULL DEFAULT 0,
          created_at INTEGER NOT NULL
        );
      `)
    }
  },
  {
    id: 2,
    name: 'index the columns every query filters or joins on',
    up(db) {
      // SQLite doesn't index foreign keys automatically. These are exactly
      // the columns index.js already filters or joins on (membership checks,
      // a room's or channel's messages, a server's channels), so every
      // install has been doing full table scans for these until now.
      db.exec(`
        CREATE INDEX IF NOT EXISTS idx_servers_owner ON servers(owner_id);
        CREATE INDEX IF NOT EXISTS idx_server_members_account ON server_members(account_id);
        CREATE INDEX IF NOT EXISTS idx_channels_server ON channels(server_id);
        CREATE INDEX IF NOT EXISTS idx_rooms_channel ON rooms(channel_id);
        CREATE INDEX IF NOT EXISTS idx_messages_channel ON messages(channel_id);
        CREATE INDEX IF NOT EXISTS idx_messages_room ON messages(room_id);
        CREATE INDEX IF NOT EXISTS idx_join_codes_server ON join_codes(server_id);
      `)
    }
  },
  {
    id: 3,
    name: 'account avatar images',
    up(db) {
      // Nullable: no image means "fall back to the color swatch", the
      // existing behavior. avatar_updated_at is what lets clients cache-bust
      // an <img> tag correctly when someone changes their picture.
      db.exec(`
        ALTER TABLE accounts ADD COLUMN avatar_image BLOB;
        ALTER TABLE accounts ADD COLUMN avatar_mime TEXT;
        ALTER TABLE accounts ADD COLUMN avatar_updated_at INTEGER;
      `)
    }
  },
  {
    id: 4,
    name: 'moderation: mute, ban, timed membership',
    up(db) {
      db.exec(`
        ALTER TABLE server_members ADD COLUMN muted INTEGER NOT NULL DEFAULT 0;
        ALTER TABLE server_members ADD COLUMN access_expires_at INTEGER;

        CREATE TABLE IF NOT EXISTS server_bans (
          server_id INTEGER NOT NULL REFERENCES servers(id),
          account_id INTEGER NOT NULL REFERENCES accounts(id),
          banned_by INTEGER REFERENCES accounts(id),
          reason TEXT,
          banned_at INTEGER NOT NULL,
          PRIMARY KEY (server_id, account_id)
        );
      `)
    }
  }
]

// Runs every migration newer than what this database has already applied,
// each in its own transaction, in order, and records each as it succeeds.
// Returns the ones it actually ran, so the caller can log something useful.
export function runMigrations(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      id INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      applied_at INTEGER NOT NULL
    )
  `)

  const sorted = [...migrations].sort((a, b) => a.id - b.id)
  const seenIds = new Set()
  for (const m of sorted) {
    if (seenIds.has(m.id)) {
      throw new Error(`Two migrations share id ${m.id} ("${m.name}"). Migration ids must be unique.`)
    }
    seenIds.add(m.id)
  }

  const applied = new Set(db.prepare('SELECT id FROM schema_migrations').all().map((r) => r.id))
  const ran = []
  for (const m of sorted) {
    if (applied.has(m.id)) continue
    // Transactional: if up() throws partway through, none of its statements
    // stick and the row recording it as applied is never written either —
    // so a failed migration is never mistaken for a successful one.
    db.transaction(() => {
      m.up(db)
      db.prepare('INSERT INTO schema_migrations (id, name, applied_at) VALUES (?, ?, ?)').run(
        m.id,
        m.name,
        Date.now()
      )
    })()
    ran.push(m)
  }
  return ran
}
