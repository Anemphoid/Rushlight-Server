# Rushlight Server

The backend for the [Rushlight](https://github.com/Anemphoid/Rushlight) client:
accounts, servers (channels and rooms), memberships, server-scoped join codes,
chat history, and LiveKit token issuing. A plain Node process with a SQLite
file; run it on any machine the clients (and your LiveKit server) can reach.

## Model

- An **account** can belong to many **servers**.
- A **server** is a permanent collection of channels and rooms. Its structure
  lives in the database until an admin deletes it.
- You get into a server by creating it (you become its admin and owner) or by
  redeeming a **join code** scoped to that server.
- **Guests** can enter with a code and no account. They see the server's real
  tree and can use voice, but have no saved membership and no shared chat.

## Setup

You need Node 20 or newer and a running [LiveKit](https://livekit.io) server.
LiveKit is a separate program that is **not bundled** with this server; see
[docs/livekit.md](docs/livekit.md) for a basic setup guide.

    cp .env.example .env      # then fill it in (see below)
    npm ci
    npm start

`.env` needs `JWT_SECRET` (generate with
`node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"`) and
`LIVEKIT_URL` / `LIVEKIT_API_KEY` / `LIVEKIT_API_SECRET` from your LiveKit
config. `LIVEKIT_URL` is handed to clients as-is, so it must be an address every
client can reach.

Check it from another machine: `curl http://<host>:4000/api/health` returns
`{"ok":true}`.

### Run it as a service (systemd)

Once, as root, after `.env` and `npm ci` are done:

    bash install-service.sh

That installs `rushlight-server.service`: it starts on boot, restarts itself if
it crashes, and logs to the journal.

    systemctl status rushlight-server
    journalctl -u rushlight-server -f

## Updating

Installs update by git tag. Releases are tags like `v0.2.0`; whatever is on the
`main` branch never reaches an install until someone tags it (see
`RELEASING.md`).

    ./update.sh --check      # is there a newer release?
    ./update.sh              # install it

An update stops the service, copies the database to `backups/`, checks out the
release, installs dependencies, starts the service and waits for it to answer. If
any of that fails it restores the database copy and the previous code and starts
the old version again. Your `.env` and database are git-ignored, so an update
can't overwrite them. `./update.sh --tag v0.1.0` goes back to an older release.

To update by itself each night: `bash install-auto-update.sh` (turn off with
`--remove`). Setting up an install that came from a zip:
`docs/migrate-existing-install.md`.

Back up the database on demand with `npm run backup` (safe while the server runs;
the newest 10 copies are kept in `backups/`).

## Tests

    npm test               # API, security and migration tests (real server processes)
    npm run test:update    # update.sh: update, rollback, refusing over local edits

## Voice

Each channel and room that has voice (mode `voice` or `both`) is its own LiveKit
room, named `s<serverId>-<room|channel>-<id>`. A client asks
`POST /api/voice/token` for the space it clicked and connects straight to LiveKit
with what comes back.

- Accounts must be members of the space's server. Identity is `acct-<id>`, so
  joining the same room from two machines closes the older connection.
- Guests get a narrow guest token from `POST /api/join`. It can request voice for
  the server they were invited to and nothing else; every account-only route
  rejects it.
- Deleting a channel, room or server ends its LiveKit rooms (best effort).

## Join codes and guests

Codes look like `amber-fox-4821`: two words and a four digit number from a
cryptographic random source, about 66 million combinations. Redeeming is rate
limited per address (`JOIN_LIMIT`, 20 per 15 minutes by default).

- `POST /api/servers/:id/codes` creates one (`singleUse`, `expiresInMinutes`).
- `GET /api/servers/:id/codes` lists the ones still usable, with how many guests
  each has brought in who are still around.
- `DELETE /api/servers/:id/codes/:codeId` **revokes** one: it admits nobody new,
  every guest who came in with it is refused a new voice token, and anyone
  already in a voice room is disconnected. This is how a guest is removed, since
  guests have no account to kick or ban.
- A single-use code is not used up by someone who is already a member.
- A guest's access never outlasts the code: the guest token expires with it (or
  after 12 hours, whichever is sooner).
- A guest can't use the name of any account (so a muted or banned member can't
  come straight back as a guest under their own name) or of another guest who is
  currently in the server.

## Ephemeral vs persistent

Each channel and room is either persistent (history kept) or ephemeral (history
wiped once nobody is in it). "In it" means a client has that space open and is
checking in every few seconds.

- The last person leaving starts a short countdown (`WIPE_GRACE_MS`, 10s). Coming
  back inside it keeps everything.
- A client that stops checking in (closed app, crash, lost network) is treated as
  gone after `PRESENCE_TTL_MS` (20s, four times the client's 5s check-in, so one
  dropped beat doesn't make someone flicker out), then the same countdown runs.
- Presence lives in memory. Restarting the server clears all ephemeral history on
  startup, because a restart means everyone is disconnected.
- Switching a space to ephemeral wipes it immediately if it's empty, or when the
  last person leaves if it isn't.

All the timings can be overridden in `.env`; the defaults are right for real use.
This check-in system stands in until LiveKit's own participant list can report who
is in a room.

## Turning on history (persistence votes)

Chats start ephemeral. To make one keep its history, everyone who has a message in
it right now gets a vote, because those are the words that would be kept.

- Only server admins can start one (`POST .../persist-vote` on a channel or room).
- If nobody but the person asking has written there, there's no one to ask and it
  switches on immediately.
- The person who starts it counts as a yes if they've written there too.
- More than half must agree. It fails as soon as passing is no longer possible,
  and passes as soon as it is, without waiting for the rest.
- An unanswered vote expires after 5 minutes (`PROPOSAL_TTL_MS`) and doesn't pass.
- If the chat auto-deletes first, there's nothing left to keep and the vote is
  cancelled.
- The plain update route refuses `persistent: true` when other people have written
  in the chat, so a vote can't be skipped.
- People see counts, never who voted which way. Open votes are held in memory, so a
  restart drops them (it also clears the ephemeral messages they were about).

## Accounts and rate limiting

Usernames are 3 to 32 printable characters, trimmed, and unique ignoring
capitalization (`Alice` and `alice` can't both exist; logging in as `alice` reaches
`Alice`). Passwords are 8 to 72 bytes (bcrypt only reads the first 72). Hashing is
asynchronous, so a login doesn't freeze the server for everyone else.

Login and registration are throttled per address: 10 login attempts per 15 minutes
and 10 registrations per hour (`LOGIN_LIMIT`, `REGISTER_LIMIT`). Every attempt
counts, successful or not, so there is no per-account counter that someone could
abuse to lock a real person out.

With no reverse proxy in front (the default), leave `TRUST_PROXY` unset. Behind one
(for example Caddy), set `TRUST_PROXY=1` so the real client's address is read from
`X-Forwarded-For`. Only set it with a real proxy actually in front; without one a
client could put anything in that header and dodge the limits.

## Moderation: kick, ban, mute, timed access

Any server admin can act on another member from `GET /api/servers/:id/members`
onward. Nobody can act on their own account, and **the server's owner and other
admins can't be moderated at all**, so an admin can't lock the owner out.

- **Kick** (`POST .../members/:accountId/kick`) removes their membership now. If
  they're in a voice room for this server, they're force-disconnected from LiveKit
  immediately. They can rejoin with a fresh invite.
- **Ban** (`POST .../members/:accountId/ban`) does everything kick does, plus
  records it in `server_bans`, so that account is refused even with a new valid
  code until an admin unbans them (`DELETE .../bans/:accountId`).
- **Mute** (`PATCH .../members/:accountId` with `{ muted: true }`) is
  server-enforced, not a UI restriction a modified client could ignore. Any new
  voice token they request can't publish, and if they're already connected their
  live LiveKit permissions are updated on the spot.
- **Timed access** (`PATCH .../members/:accountId` with `{ accessExpiresInMinutes }`,
  or `null` to clear it) can be set directly on anyone. Joining with a code that has
  its own expiry gives the new membership that same expiry. A background sweep
  removes anyone whose time has run out.

The force-disconnect and the live mute are best effort: they're driven by presence,
so they only reach someone who has a client open and checking in. Removing the
membership always takes effect immediately regardless.

## Input handling

Every request field is checked before it reaches the database: strings are trimmed
and length-limited, `mode` must be `voice`, `text` or `both`, flags must be real
booleans, ids and minutes must be real numbers. A bad request gets a `400`, never a
crash. Unknown `/api` paths and malformed JSON get JSON errors. A bug inside a
request becomes a `500` for that request only.

## Schema migrations

Schema changes go through `src/migrations.js`. Each migration runs once, ever,
tracked in a `schema_migrations` table, inside its own transaction: one that fails
leaves nothing half-applied and the server refuses to start rather than run against
a broken schema. This applies automatically on every startup.

To add one, append an entry with the next id and write whatever takes the schema
from its current shape to the new one. Never edit a migration that has been
released; add a new one. A migration must not stop an existing install from
starting.

## Avatars

Accounts can upload a custom picture (`POST /api/me/avatar`, base64 JPEG, PNG or
WebP, 1.5MB decoded limit, checked against the real file signature and not just the
claimed type). It's stored on the account, not in every message or presence
heartbeat. Anyone can fetch one at `GET /api/avatars/:accountId`, no auth, because
an `<img>` tag can't attach an auth header and it's a picture someone chose to show
people they share a server with.

Presence and message responses carry each account's current `avatarUpdatedAt`, so
changing your picture updates it everywhere, old messages included.

## Not built yet

- LiveKit bundled with the server, so one setup installs both. Today you install
  and configure LiveKit yourself (see `docs/livekit.md`).
- Real-time push: clients poll for tree and chat changes every few seconds.
- Fine-grained permissions: per-server admin is all-or-nothing, and only the
  creator is an admin.
- Guests can't read or post saved chat (no session to attach it to).

## License

Business Source License 1.1; see `LICENSE`.
