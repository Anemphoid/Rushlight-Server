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
- Deleting an account (`DELETE /api/me`) is irreversible: password, owners refused, one transaction,
  messages wiped (not hidden) and marked `redacted`, username freed. If you add a table that
  references accounts, add it to that transaction (a test runs `PRAGMA foreign_key_check`).
- `auth.js` 401s carry `reason: session_ended | session_expired` for a dead session and nothing
  for a wrong password; clients rely on that split, so keep it. Making or removing an admin is
  owner-only (`POST .../members/:accountId/admin`).
- Owner-only actions (`requireServerOwner`: transfer and delete server) need the owner's
  password, which is re-verified after the async hash and the ownership re-checked in a
  synchronous step. Admins who are not the owner are refused. Don't make anything else
  owner-only without saying so.
- Container image (`Dockerfile`, `.dockerignore`, `docker/smoke-test.sh`, `.github/workflows/docker.yml`, `docs/docker.md`; step 1 of the Compose packaging): Node 22 bookworm-slim, ffmpeg and tini, runs as the `node` user, everything that must survive an update on ONE volume `/data` (`DB_PATH=/data/rushlight.db`, so backups and `backup-public.key` land there too), no secret in it (`.dockerignore` keeps `.env` and databases out), healthcheck asks `/api/health`, labelled with the version. GitHub builds it on every change (amd64, smoke test) and on a `v*` tag (amd64 and arm64 each smoke tested, then published to `ghcr.io/anemphoid/rushlight-server` as `vX.Y.Z`, `X.Y` and `stable`). The smoke test cannot run in the Code sandbox (no Docker daemon); CI is where it runs. Compose, `rushlight setup` and the rest follow in later steps.
- Compose stack, Private mode (`deploy/compose.yaml`, `deploy/rushlight`, `docker/stack-test.sh`, `docker/stack-check.mjs`, `docs/compose.md`; step 2): server + LiveKit (pinned in `.env`, `LIVEKIT_VERSION`) both on `network_mode: host` (Linux), LiveKit on ONE UDP port 7882 with `node_ip` = the host address, server reaches it at `ws://127.0.0.1:7880` and clients are handed the host they used (`src/livekit-url.js`). `deploy/` is copied into the image at `/app/deploy`. `./rushlight setup` writes `.env` (random secrets, never printed, refuses to run twice) and `livekit.yaml`; `check` prints `ok`/`PROBLEM`/`note` lines and exits 1 on a problem. CI (`docker.yml`) runs the stack test: setup, check, two `@livekit/rtc-node` clients where one must hear the other's tone, restart keeps data, a stopped LiveKit is named by `check`, no secret in logs. Step 3: `update [--version]` (pull first; encrypted backup if set up; stop; plain copy in the volume at /data/rollback; switch `RUSHLIGHT_VERSION` in .env; wait for /api/health; on failure restore the copy, retag the old image id as the old tag, start it; `start` never pulls so only `update` moves versions), `backup ...` (the server's backup CLI in the container; `backup export`), `restore FILE` (restores into /data/restore-tmp via a one-off container, keeps the old data in /data/before-restore and settings in .env.before-restore, works with no .env because the backup carries it; keeps this computer's versions). Helpers `volrun`/`ensure_volume` use the volume `rushlight_data` with Compose's labels. Step 4, Public mode (`setup public --domain NAME | --sslip [--public-ip IP] [--email]`, `--tls-internal` for tests only): `.env` gets `RUSHLIGHT_MODE=public`, `COMPOSE_PROFILES=public` (starts the `caddy` service, pinned `CADDY_VERSION`), `PUBLIC_HOST`/`PUBLIC_HOST_KIND` (domain|sslip), `LIVEKIT_PUBLIC_URL=wss://host`, `TRUST_PROXY=1`; `write_configs` makes `livekit.yaml` (public: `bind_addresses: [127.0.0.1]`, `node_ip` = public IP, built-in TURN on UDP 3478 with relay 50000-50100) and the `Caddyfile` (`/rtc*` to LiveKit 7880, the rest to the server). The sslip name is the public IP with dashes + `.sslip.io`, so `address NEWIP` changes the name and everyone's app address. `check` in public mode tests DNS, the certificate, `/rtc` (not a 404 from the server), that 7880 is closed, and a changed public IP. CI: `docker/stack-test-public.sh` (Caddy with `tls internal`, `rushlight.test` added to /etc/hosts). A real Let's Encrypt certificate, router port forwarding and TURN on mobile data are untested. Step 5, Tailscale mode (`setup tailscale [--authkey-file F] [--name N]`, `tailscale key`): the `tailscale` service (pinned `TAILSCALE_VERSION`, host network, NET_ADMIN, /dev/net/tun, kernel mode) in the `tailscale` profile; `.env` has `HOST_IP=pending` until `tailscale_connect` learns the address from `tailscale ip -4` (then LiveKit's `node_ip` is the 100.x address); the one-time auth key is in `tailscale.env` (mode 600, `required: false` env_file of ONLY that service, emptied by `clear_ts_key` after sign-in), never in `.env` (which every container and the backups see) and never taken from the command line; Compose 2.24+ is required (`need_docker`). `restore` onto a new computer sets HOST_IP pending and asks for a new key. CI: `docker/stack-test-tailscale.sh` works with no account (files, key placement, wrong key, nothing else starts); the real sign-in and two-person voice run only if a `TS_TEST_AUTHKEY` secret exists and have never run. Later step: rotate-secrets.
- Encrypted nightly backups (`src/backup.js`, `src/backup-cli.js`, `npm run backups -- setup|now|list|check|restore|new-phrase`, `docs/backups.md`; no migration): the machine can WRITE backups but not READ them. Setup makes an X25519 key pair; the private half becomes a 12 word phrase shown once (never stored), only the public half is kept (`backup-public.key`, next to the database). Each backup is one `.rlbak` file: header, then 1 MiB AES-256-GCM chunks under a fresh per-file key from a one-time X25519 exchange, each chunk bound to its position and to being the last, with a manifest of file hashes and the newest migration id. Contents: the whole database (SQLite backup API, so consistent while running; images and avatars are in it) and the server's `.env`. Kept: newest 7 nights + one older file for each of 4 weeks. The scheduler (`startBackupScheduler` in `index.js`) checks every 10 minutes whether tonight's time has passed with no backup since (so a sleeping computer catches up) and notices a key file added later, so setup needs no restart. A restore writes `rushlight.db` and `restored.env` into a NEW EMPTY folder, never overwrites, refuses a backup from a newer database. `update.sh`'s own pre-update copies (`scripts/backup-db.js`) are still plain, on purpose (rollback must work without a phrase). Tests `backup.test.js` (real server, real files, the CLI driven through its prompts).
- LiveKit address handed to clients (`src/livekit-url.js`, no migration): `LIVEKIT_URL` is what the server uses; the voice token's `livekitUrl` is `LIVEKIT_PUBLIC_URL` if set, else, when `LIVEKIT_URL` is a plain `ws://` IP address or localhost, the host the request came to (`req.hostname`) with LiveKit's port, else `LIVEKIT_URL` as written (a name, `wss://`, or an https request behind a proxy). A moved server therefore needs only the client's address changed. A bad `LIVEKIT_PUBLIC_URL` stops the server at start. Tests `livekit-url.test.js` (the Host header is set by hand; fetch will not).
- Recovery keys made by the app (v0.22.0, no migration): the app sends `recoveryProofHash` (SHA-256 of a proof it derives from words the server never sees) at sign-up, `POST /api/me/recovery-key`, and as `newRecoveryProofHash` on a reset; the server stores `p1:` + that hash in `recovery_key_hash` (`isProofKey`, `proofMatches`, `recoveryMatches` in `recoverykey.js`), answers `recoveryKey: null`, and `recoveryKeyBy` (`app`/`server`/null) on login and `/api/me`. `/api/recover` takes `proof`; an account whose key an older server made answers `reason: legacy_key` to a proof and is opened with `key` (the words) instead. The keyring PUT takes `recoveryProof` for an app-made key (`legacy: true` in the refusal otherwise). An older app sending no hash still gets server-made words. Avatars (`/api/avatars/:id`) need a sign-in and answer only for the person themself and people who share a server (a guest: their server), 404 otherwise. Tests `recovery-app-made.test.js`; the audit tables are in `docs/visibility.md`.
- Account recovery keys (`src/recoverykey.js`, word list `src/recoverywords.js`): only a
  SHA-256 is stored, a new key is pending until `/api/me/recovery-key/ack`, and a
  password change or reset raises `accounts.session_epoch`, which `auth.js` checks on
  every account request. Never add a route that resets or reveals another account's
  password or key (a test scans the source for that), and never change the word list
  (it invalidates every issued key).
- End-to-end encryption (`src/e2ee.js`, migration 14, README "End-to-end encryption (groundwork)"): the server stores
  device public keys and opaque envelopes and never decrypts. Nothing may turn `servers.e2ee_enabled` on until the
  later step that wipes the server's plain messages (a test tries the obvious routes and checks the flag stays 0). In an encrypted server
  `postMessage` stores `rl1.` ciphertext as sent and must never parse slash commands (they use the commands
  route); a picture there must be sealed (`postSealedImage`, framing in `src/e2ee.js`): the server cannot inspect it, so the
  type, size and metadata are the client's job, and `image.sealed` is only present on sealed pictures (plain pictures keep
  their old shape, a test pins it); every message/picture/command route and the member voice token call `refuseOldClient`. Voice: the token answers `encrypted` and `epoch`; Jellybox is refused in an encrypted server unless an admin allows it in that room (migration 16, `jellybox_open` on channels and rooms, `PUT /api/music/:type/:spaceId/allowed {open}`): an allowed room's voice token answers `encrypted: false, jellyboxOpen: true` (its voice runs without the end-to-end layer because the bot's audio comes from the server; chat stays encrypted), the tree carries `jellyboxOpen` per space, flipping posts a plain bot notice naming the admin in rooms with chat, and switching off stops the bot. Commands/controls in a closed room answer `jellybox_closed`. Owner succession and the operator tool (migration 19, `ownership.js`, `accounts.last_seen_at` written by `markSeen` in `auth.js`, claims/votes/notices/`ownership_log`; `OWNER_DORMANT_MS` 90 days, `SUCCESSION_NOTICE_MS` 14 days, both settable for tests; `src/cli.js` set-owner/servers; tests `succession.test.js` run the whole flow in seconds). Keyring backup (migration 18, `accounts.keyring_blob/keyring_proof_hash/keyring_version`, `keyring_history` keeps 3; `GET/PUT /api/me/keyring`, `POST /api/devices/:id/recover`; changing the proof needs the recovery key in the body; tests `e2ee-keyring.test.js`). New computers wait for approval (migration 17, `device_keys.approved_at`, pairing code, `POST /api/devices/approvals` then `.../confirm` with the password and a challenge only an approved device's key can open; `sealToDevice` in `e2ee.js` is the one place the server encrypts; waiting devices are left out of `memberDevices`; tests `e2ee-gate.test.js`, which also holds the mutation-checked cases). Switching on (`GET /api/servers/:id/encryption`, `POST .../encryption/enable`, owner + password + wipe confirmation, wipes the server's messages and pictures, VACUUM and WAL truncate, epoch 0, one way; test `e2ee-switch.test.js` proves the old words are gone from the db and -wal files). Invites (migration 15): in an encrypted server a code must carry `e2ee` sealed keys (`cleanCodePackage`/`cleanCodeSecret` check only the shape; the server can never open them), guests need one (`old_invite` otherwise, refused before the code is used up), an admin's app adds newer epochs with a compare-and-swap on `key_version`, and revoking such a code or removing a guest asks for a new key. Anything that ends a
  membership or a device must call `forgetMemberKeys`/`markRekeyNeeded`. Envelopes are insert-only. Account
  deletion removes the person's devices and envelopes in its transaction.
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
- Jellybox (`src/music/`): the owner links one Jellyfin library per server (`server_music`, token sealed
  with a key from `JWT_SECRET`, migration 11). Only the owner links/tests/unlinks; members see only whether
  it is linked; the token never leaves the server and never appears in a log or URL. Jellyfin is only ever
  fetched through `Jellyfin` in `jellyfin.js` (one origin, no cross-origin redirects, metadata and
  link-local refused). Slash commands are handled in `postMessage`: the person's message is stored as typed,
  then Jellybox answers with a `bot: true` message (no account behind it; its words are in `voice.js`, so
  the personality lives in one file and every variant must carry the same facts). Players are in memory,
  keyed by LiveKit room name, and must be stopped when a space, server or link goes away. Tests use
  `JELLYBOX_TEST_SINK_DIR` (frames to a file) because a test cannot listen to a LiveKit room: real
  publishing through `@livekit/rtc-node` is only checked on a real install. Needs ffmpeg on the machine.
- History retention: `servers.retention_months` (3, 6, 9 or 12, default 12; migration 12). Only the owner changes it.
  `purgeExpiredHistory` runs at start and every 24 h and deletes messages older than the window in PERSISTENT spaces
  only (calendar months). Ephemeral spaces have their own wipe. Pictures are deleted with their messages by triggers
  (migration 13), so any DELETE of a message takes its picture. The log may count what was removed but must never print message content or names.
- Jellybox commands: everyone gets /play /search /queue /nowplaying (/np) /skip /help; admins and the owner also get /stop (ends the
  song, empties the queue and shuffle, the bot stays), /shuffle (random songs from the whole library, topped up as the queue runs low,
  gives up after three songs in a row that will not play), /pause /resume /previous /volume /seek /clear /remove. The bot posts a short
  note of the everyone-commands when it joins a room. Library browsing (`GET .../music/browse`) is admin-only like search. Add new
  commands to `COMMANDS` and, if they change the room's music, to `ADMIN_COMMANDS`, and to the help text in `voice.js`.

- Pictures in chat (migration 13, `message_images`, `src/images.js`): raw-body upload to `/api/channels|rooms/:id/images`, fetched from
  `GET /api/images/:id` (members only, 404 otherwise, no guests). `inspectImage` checks the real signature and size and strips
  EXIF/XMP/text/comments/trailing data by editing bytes, never decoding. Two triggers (after delete, after redact) tie a picture's life to
  its message, so keep deleting messages with plain DELETE/UPDATE and the picture follows; never add a code path that removes a message
  without them. List queries join the picture's id/size but never its bytes. Limits: IMAGE_MAX_BYTES, IMAGE_LIMIT, IMAGE_DAILY_BYTES.
