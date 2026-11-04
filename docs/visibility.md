# Who can see what (audit, Nov 2026)

This is the working table behind the privacy policy, checked against the routes in `src/index.js` (the check is the middleware on
each route: `requireAuth`, `requireServerMember`, `requireServerAdmin`, `requireServerOwner`, `requireSpaceMember`,
`requireAuthOrGuest`). Where it matters, a test holds it: `test/log-privacy.test.js` (the log), `test/server.test.js`,
`test/e2ee*.test.js`.

Roles: **anyone** (no account), **guest** (joined with a code, voice only), **member**, **admin**, **owner**. An admin is a
member; the owner is an admin.

## What the server stores

| Data | Where | Readable by the server? |
| --- | --- | --- |
| Username, password hash (scrypt), recovery key hash | `accounts` | Names yes. Passwords and the recovery key no: only hashes. |
| When an account was last seen (v0.21.0) | `accounts.last_seen_at` | Yes. Shown only to the admins of a server the person owns, and only for the owner. |
| Avatar image | `accounts` | Yes. See finding 1. |
| Chat text and pictures | `messages`, `message_images` | Plain in a server that is not encrypted. In an encrypted server only scrambled text and bytes. |
| Server keys per member computer, keyring backup | `key_envelopes`, `accounts.keyring_blob` | Scrambled; the server cannot open them. |
| Device public keys, a computer label (operating system only) | `device_keys` | Yes, they are public. |
| Server membership, roles, bans, join codes (the visible half) | several | Yes. The secret half of an invite in an encrypted server is never sent to the server in the clear. |
| Presence (who is in which space now) | memory | Yes; it is not written to disk. |
| Jellyfin address and key (if the owner links one) | `music_links` | The key is encrypted at rest with a key from `JWT_SECRET`. |
| IP addresses | memory only (rate limits) | Not stored and not logged. |

## What each role can read

| Thing | Anyone | Guest | Member | Admin | Owner |
| --- | --- | --- | --- | --- | --- |
| That the server is up (`/api/health`) | yes | yes | yes | yes | yes |
| Whether an invite code is good, and its server id (`/api/code-check`) | yes (rate limited) | yes | yes | yes | yes |
| An account's avatar by id (`/api/avatars/:id`) | **yes** | yes | yes | yes | yes |
| Server name, channel tree, who is present | no | own space only | yes | yes | yes |
| Member list (names, roles, mute, when they joined, access end) | no | no | yes | yes | yes |
| Messages and pictures of a space | no | no | yes, if a member of that server | yes | yes |
| Device list of the server (public keys, labels) | no | no | yes | yes | yes |
| Key envelopes | no | no | only their own computers' | only their own | only their own |
| Join codes list and the guests list | no | no | no | yes | yes |
| Banned list | no | no | no | yes | yes |
| When the owner was last seen, an open claim | no | no | claim only | yes | no |
| Jellyfin link state (not the key) | no | no | yes | yes | yes |
| Search and browse the Jellyfin library | no | no | no | yes | yes |
| Other people's passwords, recovery keys, keyring backups | never | never | never | never | never |
| Another account's session, or a reset of it | never | never | never | never | never |

What an admin or the owner can do to someone's account is limited to the server: mute, kick, ban, timed access, admin role.
Nobody can reset, take over or read the account of another person.

## What leaves the server

- **LiveKit** (the voice server the owner runs): the server mints tokens naming the room and the person's screen name. The audio goes
  to LiveKit, encrypted end to end in an encrypted server. LiveKit sees who is connected and when.
- **Jellyfin** (only if the owner links one): the server sends the owner's key and search words to the owner's own Jellyfin, and the
  audio goes into the voice room. In an encrypted room this is off until an admin allows it for that room, and voice there is then
  not end-to-end encrypted.
- Nothing else: no analytics, no third-party calls, no telemetry.

## Findings

1. **Avatars are public by account id.** `/api/avatars/:accountId` needs no sign-in, and ids count up from 1, so anyone can
   download every avatar and learn how many accounts exist. A picture and a number, no names. Closing it means the app fetching
   avatars with its token (a client and a server change). Owner decision: leave and say so in the policy, or close it before 1.0.
2. **The error log wrote the request path with its query string and the whole error object.** Fixed: only the method, the path
   without its query, the error name and code, and the first lines of the stack are logged, and `test/log-privacy.test.js` fails if
   a message, picture, password, token, invite or recovery word reaches the log.
3. In a server that is not encrypted the owner of the machine can read chat text in the database. That is what "not encrypted" means;
   the policy says it plainly, and turning encryption on wipes the old text first.
