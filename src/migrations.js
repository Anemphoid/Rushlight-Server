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
  },
  {
    id: 5,
    name: 'usernames are unique regardless of capitalization',
    up(db) {
      // Registration now refuses "alice" when "Alice" exists. This index makes
      // the database enforce it too. If an existing install already has two
      // accounts that differ only by case, the index can't be built; rather
      // than refuse to start over that, skip it. The application check still
      // applies to every new registration.
      const clashes = db
        .prepare('SELECT lower(username) AS name, COUNT(*) AS n FROM accounts GROUP BY lower(username) HAVING n > 1')
        .all()
      if (clashes.length > 0) {
        console.warn(
          `Skipping the case-insensitive username index: ${clashes
            .map((c) => c.name)
            .join(', ')} exist(s) more than once with different capitalization.`
        )
        return
      }
      db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_accounts_username_nocase ON accounts(username COLLATE NOCASE)')
    }
  },
  {
    id: 6,
    name: 'revocable join codes',
    up(db) {
      db.exec('ALTER TABLE join_codes ADD COLUMN revoked INTEGER NOT NULL DEFAULT 0')
    }
  },
  {
    id: 7,
    name: 'remember why someone lost access to a server',
    up(db) {
      // Removing a member deletes their membership row, so afterwards nothing says
      // whether they expired, were kicked or were banned. This keeps that one fact,
      // so the person can be told plainly instead of getting a generic error.
      // Joining again clears it; old rows are tidied up after a month.
      db.exec(`
        CREATE TABLE IF NOT EXISTS access_ends (
          server_id INTEGER NOT NULL,
          account_id INTEGER NOT NULL,
          reason TEXT NOT NULL,
          ended_at INTEGER NOT NULL,
          PRIMARY KEY (server_id, account_id)
        );
        CREATE INDEX IF NOT EXISTS idx_access_ends_ended_at ON access_ends(ended_at);
      `)
    }
  },
  {
    id: 8,
    name: 'join codes can be limited to one channel or room',
    up(db) {
      // Both columns are nullable: a code with no scope is a server-wide code, so
      // every code made before this stays exactly as it was. scope_type is 'channel'
      // or 'room'; scope_id is that channel's or room's id.
      db.exec(`
        ALTER TABLE join_codes ADD COLUMN scope_type TEXT;
        ALTER TABLE join_codes ADD COLUMN scope_id INTEGER;
      `)
    }
  },
  {
    id: 9,
    name: 'account recovery keys and sign-out-everywhere',
    up(db) {
      // recovery_key_hash is the key that works now (SHA-256 of the 12 words); it stays
      // null until the person has confirmed they saved one, so every account made before
      // this starts without one and nobody is locked out. pending_recovery_key_hash holds a
      // key that has been shown but not yet confirmed, and takes over when it is. A key
      // that was shown and then abandoned never replaces a working one.
      // session_epoch is stamped into login tokens; changing or resetting a password
      // raises it, which ends every older session.
      db.exec(`
        ALTER TABLE accounts ADD COLUMN recovery_key_hash TEXT;
        ALTER TABLE accounts ADD COLUMN pending_recovery_key_hash TEXT;
        ALTER TABLE accounts ADD COLUMN recovery_key_set_at INTEGER;
        ALTER TABLE accounts ADD COLUMN session_epoch INTEGER NOT NULL DEFAULT 0;
      `)
    }
  },
  {
    id: 10,
    name: 'messages can be redacted when their author deletes their account',
    up(db) {
      // 1 once the author has deleted their account. The text, name and avatar colour of such a
      // message are wiped when it happens; the row stays so a conversation still reads in order.
      // Only adds a column, so every existing message is unchanged (0).
      db.exec('ALTER TABLE messages ADD COLUMN redacted INTEGER NOT NULL DEFAULT 0')
    }
  },
  {
    id: 11,
    name: 'a server can link a Jellyfin library for the Jellybox music bot',
    up(db) {
      // One link per server. token_enc is the Jellyfin access token, encrypted with a key derived from
      // the server's own secret; the address is kept as typed (after checks). Only adds a table.
      db.exec(`
        CREATE TABLE IF NOT EXISTS server_music (
          server_id INTEGER PRIMARY KEY,
          address TEXT NOT NULL,
          token_enc TEXT NOT NULL,
          kind TEXT NOT NULL,
          linked_at INTEGER NOT NULL
        )
      `)
    }
  },
  {
    // Ids are not reused: 11 is the Jellybox music link (its own release), so this one is 12.
    id: 12,
    name: 'persistent chat history is kept for a number of months per server',
    up(db) {
      // 12 for every existing server, so nothing is deleted on update that the owner has not chosen:
      // the first cleanup only removes messages older than a year, and the owner can pick 3, 6, 9 or 12.
      db.exec('ALTER TABLE servers ADD COLUMN retention_months INTEGER NOT NULL DEFAULT 12')
    }
  },
  {
    id: 13,
    name: 'chat messages can carry one picture',
    up(db) {
      // The picture is stored as an opaque file by id (already stripped of metadata), apart from the
      // message so listing messages never loads image bytes. The triggers tie its life to the message:
      // whatever deletes the message (the nightly history cleanup, an ephemeral room emptying, a room,
      // channel or server being deleted) takes the picture with it, and redacting a message (its author
      // deleted their account) removes it too. Only adds a table and two triggers.
      db.exec(`
        CREATE TABLE IF NOT EXISTS message_images (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          message_id INTEGER NOT NULL UNIQUE,
          mime TEXT NOT NULL,
          width INTEGER NOT NULL,
          height INTEGER NOT NULL,
          size INTEGER NOT NULL,
          data BLOB NOT NULL,
          created_at INTEGER NOT NULL
        );
        CREATE TRIGGER IF NOT EXISTS message_images_on_delete AFTER DELETE ON messages
        BEGIN
          DELETE FROM message_images WHERE message_id = OLD.id;
        END;
        CREATE TRIGGER IF NOT EXISTS message_images_on_redact AFTER UPDATE OF redacted ON messages
        WHEN NEW.redacted = 1
        BEGIN
          DELETE FROM message_images WHERE message_id = NEW.id;
        END;
      `)
    }
  },
  {
    id: 14,
    name: 'end-to-end encryption: device keys, wrapped server keys and encrypted messages',
    up(db) {
      // Only adds. Nothing changes for an existing server until encryption is switched on for it
      // (e2ee_enabled stays 0), and the server never holds a key it could read anything with:
      // public_key is a device's public half, and an envelope is a key wrapped to one device.
      db.exec(`
        CREATE TABLE IF NOT EXISTS device_keys (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          account_id INTEGER NOT NULL REFERENCES accounts(id),
          public_key TEXT NOT NULL,
          label TEXT NOT NULL,
          created_at INTEGER NOT NULL,
          revoked_at INTEGER
        );
        CREATE INDEX IF NOT EXISTS idx_device_keys_account ON device_keys(account_id);

        CREATE TABLE IF NOT EXISTS key_envelopes (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          server_id INTEGER NOT NULL REFERENCES servers(id),
          epoch INTEGER NOT NULL,
          recipient_device_id INTEGER NOT NULL REFERENCES device_keys(id),
          sender_device_id INTEGER,           -- who wrapped it; NULL once that account is gone. The wrapped data is self-contained.
          data TEXT NOT NULL,
          created_at INTEGER NOT NULL,
          UNIQUE (server_id, epoch, recipient_device_id)
        );
        CREATE INDEX IF NOT EXISTS idx_key_envelopes_recipient ON key_envelopes(recipient_device_id);
      `)
      db.exec('ALTER TABLE servers ADD COLUMN e2ee_enabled INTEGER NOT NULL DEFAULT 0')
      db.exec('ALTER TABLE servers ADD COLUMN e2ee_epoch INTEGER NOT NULL DEFAULT 0')
      db.exec('ALTER TABLE servers ADD COLUMN rekey_needed INTEGER NOT NULL DEFAULT 0')
      // NULL = plain text (every message so far, and the music bot's); a number = the text column holds
      // ciphertext made with that epoch's key.
      db.exec('ALTER TABLE messages ADD COLUMN enc_epoch INTEGER')
    }
  },
  {
    id: 15,
    name: 'join codes can carry sealed encryption keys',
    up(db) {
      // An invite to an encrypted server carries keys that only the secret half of the code (which the server never
      // sees) can open. key_package is the sealed keys, key_secret is that secret half sealed to the server key, so
      // an admin's app can list the full code and add a new epoch's key to the package. The server stores both
      // blind. key_version lets two admins refresh one package without overwriting each other. Only adds columns.
      db.exec(`
        ALTER TABLE join_codes ADD COLUMN key_package TEXT;
        ALTER TABLE join_codes ADD COLUMN key_secret TEXT;
        ALTER TABLE join_codes ADD COLUMN key_epoch INTEGER;
        ALTER TABLE join_codes ADD COLUMN key_version INTEGER NOT NULL DEFAULT 0;
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
