# Rushlight server

Node/Express + SQLite (better-sqlite3) backend for the Rushlight client:
accounts, servers/channels/rooms, join codes, chat history, presence, ephemeral
wiping, persistence votes, moderation, avatars, and LiveKit token issuing. The
client lives in a separate repo (Anemphoid/Rushlight) and talks to this over
`/api/*`; keep changes compatible with it (check `src/renderer/src/api.js` there).

## Commands

- `npm ci`, `npm start`
- `npm test` runs the API/security/migration suite against real server processes
  with throwaway databases. `npm run test:update` exercises `update.sh`.
- Run both before committing. CI runs both.

## Rules that matter

- **No secrets or machine specifics in the repo.** `.env`, the database and
  `backups/` are git-ignored and live only on the machine that runs the server.
  Nothing here may assume one particular host.
- **Every request field is untrusted.** Check types before they reach SQLite
  (it throws on odd types). Validation helpers are at the top of `src/index.js`.
- **Async route handlers go through `asyncHandler`.** Express 4 does not catch a
  rejected promise, and an unhandled one used to kill the whole process (which
  also wipes ephemeral chats and presence for everyone).
- **Migrations are append-only** (`src/migrations.js`). Never edit one that has
  been released; add the next id. Each runs once, in a transaction. A migration
  must not make an existing install fail to start (see migration 5).
- Releases are git tags `vX.Y.Z`. Installs update to the newest tag with
  `update.sh`, which backs up the database and rolls back if the new version
  does not start answering `/api/health`. `main` never reaches an install until
  it is tagged.

## Design decisions

- Guests have no account, so they cannot be muted or banned by account. Instead:
  a guest cannot use any account's name or a live guest's name, a guest token
  never outlives its code, and revoking a code ends access for everyone who came
  in with it (token refused, live voice disconnected).
- The server owner and other admins cannot be kicked, banned or muted.
- Presence, open votes and the guest-session map are in memory on purpose; a
  restart clears ephemeral history anyway.
- Foreign key enforcement is off (as it has always been); deletes clean up their
  own children explicitly.

## Where we left off (temporary: delete this section after the migration)

- **v0.2.0 is released, but the owner's server machine still runs the old zip
  version.** They will move it onto this repo when they have a terminal there,
  following docs/migrate-existing-install.md. They also planned to rotate the
  LiveKit secret at the same time.
- **After they migrate**, ask them to confirm: `/api/health` answers, the log
  says it applied 2 migrations (usernames unique ignoring case, revocable codes),
  their own account still logs in, and their server and chat are intact. Then
  delete this section.
- **Not verified anywhere yet:** the systemd flow in install-service.sh,
  update.sh and install-auto-update.sh on a real machine, and a real LiveKit
  disconnect when a code is revoked or a member is kicked (tests use an
  unreachable LiveKit address, so that part is best effort and untested).
- **Possible next work:** real-time push (for example server-sent events) to
  replace the clients' polling, server-side unread counts, profile bio/status/
  banner fields, settings sync across machines, and more than one admin per
  server (only the creator is an admin today). A client screen to list and revoke
  join codes is planned in the client repo; the endpoints already exist here.
