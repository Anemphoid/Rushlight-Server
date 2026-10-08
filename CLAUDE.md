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
- The server owner and other admins cannot be kicked, banned or muted, and the
  expiry sweep skips them even if a stray expiry is on their row.
- Kick, ban and expiry all go through `removeMember`, which deletes the
  membership, records why in `access_ends` (so the 403 can say `reason`), asks
  LiveKit to disconnect first and only then clears presence. Keep that order.
- Guests check in to presence (keyed by their identity string, flagged `guest`) and
  are visible to members; a guest only ever gets back the one space they are in.
  Anything keyed by account id must tolerate guest ids (strings) in presence.
- A guest session ending (code expiry or the 12 hour cap) also drops the guest from
  their voice rooms; `endGuestSession` does it, and the sweep calls `liveGuests()`
  so it happens without anyone making a request.
- Join codes may carry `scope_type`/`scope_id` (migration 8; null = whole server).
  Every guest path that picks a space (voice token, presence) must go through
  `guestCodeOrRefuse` + `scopeAllows`, and the guest's tree comes from
  `serializeTree(serverId, scopeOf(code))`. Scoped codes never make an account a
  member. Deleting a channel/room must `await revokeCodesScopedTo(...)`.
- Removing one guest (`DELETE .../guests/:identity`) adds the identity to `removedGuests`
  and ends the session; `guestCodeOrRefuse` refuses it, because the signed token would
  otherwise rebuild the session on the next check-in. The code list keeps a used
  single-use code while a guest of it is live.
- Owner-only actions (`requireServerOwner`: transfer and delete server) need the owner's
  password, which is re-verified after the async hash and the ownership re-checked in a
  synchronous step. Admins who are not the owner are refused. Don't make anything else
  owner-only without saying so.
- Account recovery keys (`src/recoverykey.js`, word list `src/recoverywords.js`): only a
  SHA-256 is stored, a new key is pending until `/api/me/recovery-key/ack`, and a
  password change or reset raises `accounts.session_epoch`, which `auth.js` checks on
  every account request. Never add a route that resets or reveals another account's
  password or key (a test scans the source for that), and never change the word list
  (it invalidates every issued key).
- Presence, open votes and the guest-session map are in memory on purpose; a
  restart clears ephemeral history anyway.
- Foreign key enforcement is off (as it has always been); deletes clean up their
  own children explicitly.

## Known gaps and backlog

- **Not tested against a real LiveKit server:** the tests use an unreachable
  LiveKit address, so disconnecting someone on kick or code revoke is best effort
  and is untested until someone tries it on a live server.
- **Possible next work:** real-time push (for example server-sent events) to
  replace the clients' polling, server-side unread counts, profile bio, status and
  banner fields, settings sync across machines, and more than one admin per server
  (only the creator is an admin today). A client screen to list and revoke join
  codes is planned in the client repo; the endpoints already exist here.
