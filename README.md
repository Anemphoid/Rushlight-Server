# Rushlight Server

The Alpha 2 backend. Accounts, servers (channels + rooms), memberships,
server-scoped join codes, persisted chat history, and LiveKit token issuing.
Plain Node process; deploy it on the `unison` LXC on Catacombs.

## Model

- An **account** can belong to many **servers**.
- A **server** is a permanent collection of channels and rooms. Its structure
  lives in the database until an admin deletes it.
- You get into a server by creating it (you become its admin) or by redeeming
  a **join code** scoped to that server.
- Guests can enter with a code and no account — they see the server's real
  tree but have no saved membership and no shared chat history yet.

## Setup (on the unison LXC)

```
cp .env.example .env      # then fill it in (see below)
npm install
npm start
```

`.env` needs `JWT_SECRET` (generate with
`node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"`),
and `LIVEKIT_URL` / `LIVEKIT_API_KEY` / `LIVEKIT_API_SECRET` from this LXC's
own `livekit.yaml`.

Verify from another machine: `curl http://<lxc-ip>:4000/api/health` → `{"ok":true}`.

## Running it as a service (systemd)

On the machine that hosts the server, once:

    bash install-service.sh

That installs and starts `rushlight-server.service`: it starts on boot, restarts
itself if it crashes, and logs to the journal. It needs `.env` and `npm install`
to be done first, and refuses to run if the port is already taken (stop any old
tmux session with `tmux kill-session -t rushlight`).

Day to day:

    systemctl status rushlight-server          # is it running?
    journalctl -u rushlight-server -f          # live logs
    systemctl restart rushlight-server         # after unpacking a new version

## Voice

Each channel and room that has voice (mode `voice` or `both`) is its own
LiveKit room, named `s<serverId>-<room|channel>-<id>`. A client asks
`POST /api/voice/token` for the space it clicked and connects straight to
LiveKit with what comes back.

- Accounts must be members of the space's server. Identity is `acct-<id>`, so
  joining the same room from two machines closes the older connection.
- Guests (joined with a code, no account) get a narrow guest token from
  `POST /api/join`. It can request voice for the server they were invited to
  and nothing else; every account-only route rejects it.
- `LIVEKIT_URL` in `.env` is handed to clients as-is, so it must be an address
  every client can reach (for remote clients, that means routing to it).

## Ephemeral vs persistent

Each channel and room is either persistent (history kept) or ephemeral
(history wiped once nobody is in it). "In it" means a client has that space
open and is checking in every few seconds.

- The last person leaving starts a short countdown (`WIPE_GRACE_MS`, 10s).
  Coming back inside it keeps everything.
- A client that stops checking in (closed app, crash, lost network) is
  treated as gone after `PRESENCE_TTL_MS` (15s), then the same countdown runs.
- Presence lives in memory. Restarting the server clears all ephemeral history
  on startup, because a restart means everyone is disconnected.
- Switching a space to ephemeral wipes it immediately if it's empty, or when
  the last person leaves if it isn't.

All three timings can be overridden in `.env` (`PRESENCE_TTL_MS`,
`WIPE_GRACE_MS`, `PRESENCE_SWEEP_MS`). The defaults are right for real use.

This check-in system stands in until LiveKit's own participant list can
report who is in a room.

## Login and registration rate limiting

Both endpoints are throttled per IP: 10 login attempts per 15 minutes, 10
registrations per hour. This counts every attempt, successful or not, not
just failures — simpler than tracking failures alone, and it closes off the
version of this problem where someone could deliberately fail a real
account's login over and over to lock that person out, since there's no
separate per-account counter to abuse that way. A correct password still
gets refused once the window is used up; the limit is on the endpoint, not
on being wrong.

Self-hosted without a reverse proxy in front (the default): leave
`TRUST_PROXY` unset. Behind one (the planned Caddy setup): set
`TRUST_PROXY=1` so the real client's address is read from
`X-Forwarded-For` instead of the proxy's own. Only set this with a real
proxy actually in front — without one, a client can put anything it wants
in that header and dodge the limit entirely.

## Presence and network hiccups

`PRESENCE_TTL_MS` (default 20s) is deliberately 4x the client's own 5s
heartbeat interval, not a tighter margin — real networks occasionally drop
or delay a single beat, and voice itself (LiveKit) already recovers from
that transparently on its own. Presence deserves the same tolerance: without
enough slack, someone still genuinely connected can flicker in and out of
the room list even though they never actually left. The client also retries
quickly (1.5s) after any single failed heartbeat rather than waiting for its
next regularly scheduled one, so a brief blip recovers fast without needing
the full TTL margin to do it.

## Moderation: kick, ban, mute, timed access

Any server admin can act on another member from `GET /api/servers/:id/members`
onward. Nobody can act on their own account through these routes, including
the admin who created the server.

- **Kick** (`POST .../members/:accountId/kick`) removes their membership now.
  If they're actively in a voice room for this server, they're force-disconnected
  from LiveKit immediately, not just blocked from reconnecting later. They can
  rejoin with a fresh invite.
- **Ban** (`POST .../members/:accountId/ban`) does everything kick does, plus
  records it in `server_bans`, so that account is refused even with a brand
  new, valid join code until an admin unbans them
  (`DELETE .../bans/:accountId`).
- **Mute** (`PATCH .../members/:accountId` with `{ muted: true }`) is
  server-enforced, not a UI restriction a modified client could ignore. Any
  new voice token they request comes back unable to publish, and if they're
  already connected, their live LiveKit permissions are updated on the spot —
  a mute mid-call actually cuts off their mic that second.
- **Timed access** (`PATCH .../members/:accountId` with
  `{ accessExpiresInMinutes }`, or `null` to clear it) can be set directly on
  anyone, independent of how they joined. Joining via a code that has its own
  expiry inherits that same expiry onto the new membership automatically. A
  background sweep (same interval as the presence sweep) removes anyone whose
  time has run out with no manual kick needed — this is what makes a timed
  invite code actually revoke access when it expires, not just stop letting
  new people in.

Both the force-disconnect and the live mute are best-effort: they're driven
by presence, so they only reach someone who has an actual client open and
checking in. Removing their membership always takes effect immediately either
way, whether or not the live LiveKit side has anyone to reach.

## Schema migrations

Schema changes now go through src/migrations.js instead of deleting the
database. Each migration runs once, ever, tracked in a schema_migrations
table, inside its own transaction — a migration that fails leaves nothing
half-applied and the server refuses to start rather than run against a
broken schema. This applies automatically on every startup; there's nothing
to run by hand.

To add one: append a new entry to the migrations array in migrations.js
with the next id, and write whatever SQL takes the schema from its current
shape to the new one (ALTER TABLE, backfills, whatever it needs). Never
edit an already-published migration once anyone might have run it — add a
new one instead.

## Avatars

Accounts can upload a custom picture (`POST /api/me/avatar`, base64 JPEG/PNG/WebP,
1.5MB decoded limit, checked against the real file signature, not just the
claimed type). Stored on the account, not in every message or presence
heartbeat, since that would mean re-sending image bytes constantly. Anyone
can fetch one at `GET /api/avatars/:accountId`, no auth required, same as
the color swatch today: it's a picture someone chose to show people they
share a server with, and an `<img>` tag can't attach an auth header anyway.

Presence and message responses carry each account's *current*
`avatarUpdatedAt`, looked up live, not frozen at message-send time — change
your picture and it updates everywhere going forward, including in old
messages, the same way changing your name would. `avatarColor` keeps its
old, different behavior (frozen per message) unchanged, since only the
image needed the live lookup to avoid resending bytes constantly.

## Turning on history (persistence votes)

Chats start ephemeral. To make one keep its history, everyone who has a message
in it right now gets a vote, because those are the words that would be kept.

- Only server admins can start one (`POST .../persist-vote` on a channel or room).
- If nobody but the person asking has written there, there's no one to ask and it
  switches on immediately.
- The person who starts it counts as a yes if they've written there too.
- More than half must agree. It fails as soon as passing is no longer possible,
  and passes as soon as it is, without waiting for the rest.
- An unanswered vote expires after 5 minutes (`PROPOSAL_TTL_MS`) and doesn't pass.
- If the chat auto-deletes first, there's nothing left to keep and the vote is cancelled.
- The plain update route refuses `persistent: true` when other people have written
  in the chat, so a vote can't be skipped.
- People see counts, never who voted which way. Open votes are held in memory, so
  a restart drops them (it also clears the ephemeral messages they were about).

## Alpha caveat: schema changes need a fresh database

There's no migration system yet. When the schema changes between builds (as it
did for servers/channels/rooms), stop the server and delete the old database
before starting the new version:

```
rm -f rushlight.db rushlight.db-shm rushlight.db-wal
```

Accounts and servers are wiped by this — fine while everything is test data.

## Keeping it running

`npm start` runs in the foreground and dies with your terminal. Use `tmux`
(`tmux new -s rushlight`, run `npm start`, detach with Ctrl+B then D) or a
systemd unit.

## Not built yet

- Real-time push: the client polls for tree and chat changes every few
  seconds. Live delivery arrives with the LiveKit room connection.
- Fine-grained permissions: per-server admin is all-or-nothing for now.
- Guests can't read or post saved chat (no session to attach it to).
