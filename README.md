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

- `POST /api/servers/:id/codes` creates one (`singleUse`, `expiresInMinutes`, and
  optionally `scope`, below).
- `GET /api/servers/:id/codes` lists the ones still usable, with how many guests
  each has brought in who are still around. A single-use code that has been used
  stays listed (`used: true`) for as long as a guest who came in with it is still
  here, so there is something to revoke; it drops off when that guest's session ends.
- `DELETE /api/servers/:id/codes/:codeId` **revokes** one: it admits nobody new,
  every guest who came in with it is refused a new voice token, and anyone
  already in a voice room is disconnected. This is how a guest is removed, since
  guests have no account to kick or ban.
- **Scoped codes.** `scope: { type: "channel" | "room", id }` limits a code to one
  channel (and its rooms) or one room, which must have voice and belong to that
  server. A guest with one gets voice tokens and presence only for what it covers
  (403 "Your invite doesn't cover that space" otherwise), and the tree they are
  sent holds only that: for a room code, the parent channel with `joinable: false`
  so they can see where the room lives, and just that room. Members never get a
  filtered tree. A scoped code is for guests only: an account redeeming one under
  `POST /api/servers/join` gets a 403 saying so, and the code is not used up. The
  code list returns each code's `scope` with a `name`. Deleting the channel or room
  revokes the codes for it and drops the guests who came in with them, like a
  revoke. Codes made before scopes existed stay server-wide.
- `DELETE /api/servers/:id/guests/:identity` (admins only) removes one guest without
  revoking their code, so other guests of a reusable code stay. LiveKit is told first,
  then presence is cleared. The guest's token is refused for the rest of its life
  ("You were removed from this server"). That refusal is kept in memory, so a server
  restart forgets it, and a guest holding a reusable code can come back in under a new
  identity: revoke the code to keep someone out.
- A single-use code is not used up by someone who is already a member.
- A guest's access never outlasts the code: the guest token expires with it (or
  after 12 hours, whichever is sooner).
- A guest can't use the name of any account (so a muted or banned member can't
  come straight back as a guest under their own name) or of another guest who is
  currently in the server.
- **Guests are visible.** A guest checks in to presence like an account does
  (`POST /api/presence`, and `POST /api/presence/leave`), so members see them in
  the channel tree by screen name, with no avatar image. A guest can only check in
  to a space in the server their code belongs to, and what they get back is limited
  to the one space they are in, so they see the people they can already hear and
  nothing about other rooms. A guest counts as an occupant, so an ephemeral room
  does not wipe while one is in it. Guests have no account, so they cannot vote on
  keeping history or write in chat. A guest who stops checking in drops out after
  the presence timeout. Revoking their code or its expiry clears their presence
  too, after LiveKit has been told to drop them.
- `GET /api/servers/:id/guests` (admins only) lists the guests here now, for Admin
  Tools: screen name, the code they came in with, when they joined, when their
  session ends, and which space they are in. They are listed from the moment they
  join. Like the sessions behind it, the list is in memory and starts empty after a
  server restart, then refills as guests check in.
- The check-in is rate limited per address (`PRESENCE_LIMIT`, 600 a minute by
  default), generously, because several clients behind one address each check in
  every 5 seconds. Accounts and guests share the limit.

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

### Owners: handing a server on, and deleting it

Each server has one **owner** (`servers.owner_id`, the creator to start with) and any
number of admins. An owner can do everything an admin can, plus two things only the
owner can do, both needing their **password** (checked again after the slow hash, so a
stolen session or a race can't slip through) and rate limited like the other password
routes (`ACCOUNT_LIMIT`):

- `POST /api/servers/:id/transfer` with `accountId` and `password` hands the server to
  any current member. It is immediate: the old owner stays an admin, the new owner is
  made one, and loses any mute or access timer, because an owner never expires. Not
  yourself, not a non-member (a banned person is not one), not if you are no longer the
  owner by the time the password check finishes. The new owner is then protected from
  kick, ban and mute like any owner.
- `DELETE /api/servers/:id` with `password` deletes the server and everything in it.
  **This used to be allowed for any admin without a password**; it is now the owner's
  alone. A client from before this release has no delete button, so nothing breaks.

`GET /api/servers`, `GET /api/servers/:id` and the members list carry `isOwner`. No
migration.

### Deleting an account

`DELETE /api/me` with `{ password }`. **Permanent and immediate**; take a database backup before
installing the release that adds it, because there is no way back. Migration 10 only adds a
`messages.redacted` column, so it changes no data.

- Needs the password (wrong: 401). An account that **owns a server is refused** with 409,
  `reason: "owns_servers"` and `servers: [{ id, name }]`, because a server must not be left
  without an owner. Hand each over (`POST /api/servers/:id/transfer`) or delete it first.
- Everything below happens in one transaction: the account's **messages are wiped, not hidden**
  (text and author name set to empty, avatar colour and author link cleared, `redacted = 1`, the
  row kept so conversations still read in order); its memberships, bans and "access ended" notes go;
  codes it made and bans it issued stay, with the "created by" link cleared; the avatar (stored on
  the account row) goes with the row; the account row is deleted, which **frees the username**
  for anyone, in any capitalization.
- Before that, LiveKit is told to drop it from its voice rooms; afterwards its presence is
  cleared and open persistence votes lose it (a vote it started is cancelled, one it was part of
  is settled without it, and its name is scrubbed from any that remain in memory).
- Every other window is signed out at once: a token for a missing account gets a 401 with
  `reason: "session_expired"` and "This account no longer exists."
- A redacted message comes back from the message routes as `{ id, authorId: null, author: null,
  avatarColor: null, avatarUpdatedAt: null, text: "", createdAt, redacted: true }`, so nothing
  identifying leaves the server. Every other message has `redacted: false`.
- Rate limited like the other password routes (`ACCOUNT_LIMIT`).

### Admins, and why a request failed

- `POST /api/servers/:id/members/:accountId/admin` with `{ admin: true | false }` makes a
  member an admin or takes it away. **Owner only** (an admin can't promote or demote), no
  password because the same button undoes it. Accounts only: a guest has no membership, so
  there is nobody to promote (400). The owner is always an admin and can't be demoted (400;
  hand the server over instead). Becoming an admin clears a mute and any access timer, since
  admins never expire. It takes effect on the next request, and a client's regular check of the
  server (`isAdmin`, `isOwner`) picks it up within seconds.
- A **401 carries a `reason`** when the session itself is no longer good: `session_ended` (the
  password was changed or reset, so the session ended) or `session_expired` (the token ran out
  or the account is gone). A wrong password on a route that asks for one is also a 401 but has
  no reason, so a client can tell them apart and only send the person to sign-in for the first.
- A request about a **deleted server** gets `403` with `reason: "deleted"` and the message
  "This server was deleted.", where a kick says "removed", an expiry "expired" and so on.

### Recovery keys, password change and reset

There is no admin reset anywhere: a server admin has no account-level access, and the
only way back into an account after a forgotten password is its **recovery key**. A
test fails if any route touching a password or key is added beyond the four below.

- **A key** is 12 words from a 2048 word list (about 132 bits). `POST /api/register`
  returns it once, as `recoveryKey`. Only a SHA-256 of it is stored (a key this strong
  gains nothing from a slow hash, and bcrypt would cut it at 72 bytes), so it can never
  be shown again. It counts only once the client confirms the person saved it with
  `POST /api/me/recovery-key/ack`; until then it is *pending* and a working key, if any,
  is not replaced. `login` and `GET /api/me` return `recoveryKeyAcked`, false for every
  account made before keys existed and for sign-ups closed before the key was saved.
  Those accounts log in normally and the client asks them to make a key.
- `POST /api/me/recovery-key` (own account, current password required) makes a new
  pending key. It is only a replacement once confirmed with the ack route, so an
  abandoned one leaves the old key working.
- `POST /api/me/password` (current password required) changes the password.
- `POST /api/recover` takes `username`, `key` and `newPassword`. Typing is forgiving
  (case, spaces, dashes). A wrong key, an unknown username, a malformed key and an
  account with no confirmed key all get the same 401, so it doesn't reveal which
  usernames exist. A good key is spent: it returns the next key (pending, to be
  confirmed like any other) along with a fresh login token.
- **Sessions end on a password change or reset.** Login tokens carry a `session_epoch`
  (migration 9), and every authenticated request checks it, so changing or resetting a
  password signs out every other session of that account. It is one small lookup per
  request. Tokens issued before this carry no epoch, which counts as 0, so nobody is
  signed out by the update itself.
- Rate limits, per address, counting every attempt: reset 5 per 15 minutes
  (`RECOVER_LIMIT`), and change-password and make-a-key 10 per 15 minutes
  (`ACCOUNT_LIMIT`).
- If someone loses both their password and their key the account cannot be recovered.
  That is deliberate.

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
  or `null` to clear it) can be set directly on any ordinary member. Joining with a
  code that has its own expiry gives the new membership that same expiry. A
  background sweep removes anyone whose time has run out, exactly as a kick would:
  the membership goes, LiveKit is told to disconnect them first, and then their
  presence is cleared. They are not banned and can come back with a new code. The
  owner and other admins never expire, whatever is on their row.
- **Guests and expiry.** A guest's session ends when their code expires (or after 12
  hours, whichever is first), and ending it drops them from the voice rooms they
  were in, the same way revoking the code does. Guest sessions are kept in memory,
  so a server restart forgets who is connected. A guest who was already in a call
  before a restart is not dropped when their code expires, but their token stops
  working at that moment, so they can't rejoin.
- **Telling people why.** When someone who used to be a member asks for the server,
  the 403 says why: `reason` is `expired`, `removed` or `banned`, with a plain
  `error` message. It is remembered for 30 days or until they join again, and
  only that person sees it. Someone who was never a member gets the usual message
  with no `reason`.

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

## Music (Jellybox)

The owner can link one Jellyfin library per server. A bot called Jellybox then joins a voice room
as its own participant when someone there types `/play`, and plays songs from that library.

**Needs `ffmpeg` on the server machine** (`apt install ffmpeg`). Without it a `/play` answers that it
tripped over the song; nothing else is affected. The bot publishes audio with `@livekit/rtc-node`,
a native module installed by `npm ci`; if it cannot load on your machine, the rest of the server
still runs and the bot says it couldn't get into the room.

- **Linking** (owner only; Admin Tools, Music): `PUT /api/servers/:id/music` with the Jellyfin
  address and either `apiKey`, or `username` and `password` (exchanged once for an access token; the
  password is not kept). `POST .../music/test` checks the saved link, `DELETE .../music` unlinks and
  sends the bot away. Nothing is saved unless the details work. Only the token is stored, sealed with
  AES-256-GCM under a key derived from `JWT_SECRET` (or `MUSIC_SECRET` if you set one). It is never
  logged and never sent to a client; other members only learn whether music is set up. If you change
  the secret, the link can no longer be read and the owner links again.
- **Where it connects:** only the one address the owner entered, only Jellyfin's search, item, cover
  and audio endpoints, redirects only within that origin (max 3). Cloud-metadata names and link-local
  addresses (`169.254.x.x`, `fe80::`) are refused; LAN and local addresses are allowed on purpose.
  The address is checked when linking and testing; it is not re-resolved on every song.
- **Commands** typed in the chat of a voice room, by someone who is in that room: `/play` (a song,
  album or artist, or a number from `/search`), `/search`, `/queue`, `/nowplaying` (`/np`), `/skip`
  and `/help` for everyone; `/pause`, `/resume`, `/previous`, `/volume`, `/seek`, `/clear` and
  `/remove` for admins and the owner. The person's message stays as typed and Jellybox answers in the
  same chat (messages come back with `bot: true`). One person may have `JELLYBOX_QUEUE_CAP`
  songs (default 10) in the lineup, counting the one playing; admins are exempt. Commands are
  rate-limited per person (`JELLYBOX_RATE_MAX` per `JELLYBOX_RATE_WINDOW_MS`, default 6 per 10 s).
  The name "Jellybox" cannot be registered as a username.
- **Panel routes:** `GET /api/music/:channel|room/:id/state` (any member; says `available: false`
  when nothing is linked), `POST .../control` (admins and the owner, who must be in the room),
  `GET /api/servers/:id/music/search?q=` (admins) and `.../music/cover/:itemId` (members).
- **Streaming:** each song is fetched from Jellyfin, decoded by ffmpeg and sent to the room as 20 ms
  frames. The request timeout (10 s, `JELLYBOX_REQUEST_TIMEOUT_MS`) only covers waiting for Jellyfin to start
  answering, never the song itself. If a stream breaks part way it is picked up again where it stopped, up to
  five times, and then Jellybox says so and moves on. Nothing is downloaded or stored. One bot per room; it leaves 5 seconds after the room empties
  (`JELLYBOX_LEAVE_MS`), when the owner unlinks, or when the room, channel or server is deleted.
  Players live in memory, so a restart empties the queues.
## How long chat history is kept

Persistent chat is kept for a number of months, then the oldest messages are deleted. The window is per
server: **12 months by default**, and the owner can choose 3, 6, 9 or 12 (`PUT /api/servers/:id/retention`
with `{ "months": 6 }`, owner only; the answer says how many messages the new window will remove at the next
cleanup). Members see the current window as `retentionMonths` in `GET /api/servers/:id`.

- **The cleanup** runs when the server starts and then every 24 hours (`RETENTION_EVERY_MS` to change it). It
  counts calendar months back from now, and deletes messages older than that in persistent channels and rooms.
  A shorter window takes effect at the next cleanup; a longer one never brings anything back.
- **Not touched:** ephemeral spaces (they are wiped when empty, as before). Redacted messages and the music
  bot's messages age out like anyone's. The log says how many were removed, never what they said.
- **Updating** an existing install gives every server 12 months, so the first cleanup only removes messages
  older than a year. `update.sh` backs the database up first.
- Ids are not reused: migration 11 is the music link and 12 is this setting.

## Not built yet

- LiveKit bundled with the server, so one setup installs both. Today you install
  and configure LiveKit yourself (see `docs/livekit.md`).
- Real-time push: clients poll for tree and chat changes every few seconds.
- Fine-grained permissions: per-server admin is all-or-nothing, and only the
  creator is an admin.
- Guests can't read or post saved chat (no session to attach it to).

## License

Business Source License 1.1; see `LICENSE`.
