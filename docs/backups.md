# Backups

Rushlight can make an encrypted backup of your server every night. This page says how to turn it on, how to check it, and how to
get your server back from one. It is written for someone who has never done this before. Take it one step at a time.

## What you get

- **A backup every night**, at 03:30 by default. If the computer was off or asleep then, the backup is made as soon as it is
  back on.
- **The last 7 nights are kept**, and one older backup for each of the 4 weeks before that. Older ones are deleted.
- **Everything is in the backup**: your people, servers, messages, pictures, and the server's secrets file (so after a restore
  nobody has to sign in again and the Jellyfin link still works).
- **The backups are encrypted, and this computer cannot open them.** That is on purpose. Only your **backup phrase** (12 words)
  can open them. If someone steals the backup folder, or breaks into this computer, they cannot read your old backups.

## Turn it on (once)

In the server's folder, run:

    npm run backups -- setup

It shows you **12 words**. Write them down on paper and keep the paper somewhere safe, away from this computer. It then asks you
for three of the words, to be sure you wrote them correctly. After that, backups are on. You do not need to restart the server.

**Nobody can recover this phrase for you.** Not the Rushlight developers, not anyone. This computer does not keep it. If you
lose it, your backups can never be opened. If someone else gets it *and* a backup file, they can read that backup. Treat it like
the key to a safe.

## Keep a copy somewhere else

A backup on the same computer does not help if the computer breaks. Copy the `backups` folder (it is next to the database,
unless you set `BACKUP_DIR`) to another drive, a USB stick, or a folder your cloud storage syncs. The files are encrypted, so
that is safe. You can also set `BACKUP_COPY_DIR` to a second folder and the server writes every backup there too.

## Check that it works

    npm run backups -- list

shows the backups and when the last one worked. Once a month, prove a backup really opens:

    npm run backups -- check <backup file>

It asks for your 12 words and says "Good" if the file opens and nothing in it has changed. It writes nothing.

## Get your server back (restore)

Do this on a new computer, or after a disaster. It never overwrites anything.

1. Install the server, but do not start it yet.
2. Copy a backup file (the newest is best) onto the computer.
3. Restore it into a **new, empty folder**:

       npm run backups -- restore <backup file> <new folder>

   Type your 12 words when it asks. It checks the file, then writes two files into that folder: `rushlight.db` (everything) and
   `restored.env` (the server's secrets).
4. Put `rushlight.db` where the server keeps its database (the file named by `DB_PATH`, or `rushlight.db` in the server folder).
   Copy `restored.env` over `.env` to keep people signed in and keep the Jellyfin link. Without it, everyone signs in again and
   the owner links Jellyfin again.
5. Start the server and open Rushlight. Check that you can sign in and your messages are there.

If it says the backup is **from a newer server**, update the server first and then restore. If it says **that phrase does not open
this backup**, the words are wrong, or the backup was made before you changed your phrase (each backup needs the phrase that was
current when it was made).

## If you lose the phrase

Make a new one for future backups: `npm run backups -- new-phrase`. Backups made before that stay locked, because they need the
old phrase. Your running server is not affected.

## Settings (in `.env`)

| Setting | What it does | Default |
| --- | --- | --- |
| `BACKUP_TIME` | The time each night, 24 hour `HH:MM` | `03:30` |
| `BACKUP_DIR` | Where backups are written | `backups` next to the database |
| `BACKUP_COPY_DIR` | A second folder that also gets every backup | none |
| `BACKUP_KEEP_DAILY` | How many nights to keep | `7` |
| `BACKUP_KEEP_WEEKLY` | How many older weeks to keep one backup of | `4` |
| `BACKUP_PUBLIC_KEY` | Where the (public) key file is | `backup-public.key` next to the database |
| `BACKUP_ENV_FILE` | The secrets file to include | `.env` in the server folder |

## How it works (for the curious)

The server keeps only the *public* half of a key pair. The private half is turned into your 12 words. Each night the server makes
a one-time key, agrees a secret with the public half (X25519), and encrypts the database in 1 MiB pieces (AES-256-GCM). Each piece
is tied to its position and to whether it is the last, so a changed, reordered or cut-short file is refused. The server never
holds anything that can open a backup. The code is `src/backup.js`.

## Not covered

- `update.sh` takes its own plain copy of the database before an update, so it can roll back by itself. Those copies (the newest
  10, in `backups/`) are **not** encrypted. They are only for a failed update, and you can delete them.
- A backup protects the server's data. It does not include the Jellyfin library or LiveKit.
