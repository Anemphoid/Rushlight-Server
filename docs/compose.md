# Running Rushlight with Docker Compose (Linux)

This is step 2 of the Compose packaging: **Private mode** (people on your own network, or connected to it, for example over a VPN), with safe updates and backups (step 3).
Public mode (a domain and HTTPS), Tailscale mode and key rotation come in later steps. A beginner's guide is
written last, from real runs.

## What you get

Two containers sharing the computer's network: the Rushlight server (port 4000) and LiveKit (voice: 7880 and 7881 over TCP, **one
UDP port, 7882**). Open those ports on a firewall that is in the way. The data is in one Docker volume (`rushlight_data`).

## First time

    docker run --rm -v "$PWD":/out --entrypoint sh ghcr.io/anemphoid/rushlight-server:stable -c 'cp -r /app/deploy/. /out/'
    ./rushlight setup

`setup` finds this computer's address (or take one with `--ip`), makes the secrets from the system's random source, writes them to
`.env` (never printed; keep that file private; the encrypted backups include it) and `livekit.yaml`, then starts everything and
waits for the server to answer. It will not run twice in one folder: that would replace the secrets and sign everyone out.

People then connect their app to `http://ADDRESS:4000`.

## Everyday

| Command | What it does |
| --- | --- |
| `./rushlight check` | Looks for problems and says what to do about each (Docker, files, containers, ports, a changed address, a firewall) |
| `./rushlight status`, `logs [server\|livekit]` | What is running; the recent log |
| `./rushlight start`, `stop`, `restart` | |
| `./rushlight address [ADDRESS]` | This computer's network address changed: fix voice for it |

## Public mode (on the internet, with https)

    ./rushlight setup public --domain chat.example.com
    ./rushlight setup public --sslip          # no domain of your own: a free name made from your address

Use this when people outside your network join. A small web server (Caddy) gets and renews the HTTPS certificate by itself and
passes visitors on: everything to the Rushlight server, and `/rtc` (voice signalling) to LiveKit. People type
`https://chat.example.com` into their app. LiveKit's own port and the server's port 4000 stay closed to the network.

**You do three things first:**
1. Have a name that points at this computer: with your own domain, add an **A record** for it with this computer's public
   address (`setup` stops with advice if the name does not resolve yet). With `--sslip` the name is made for you from the
   address (`203-0-113-10.sslip.io`).
2. If the computer is at home, **forward ports on the router** to it: 80 and 443 (TCP), 7881 (TCP), 7882 and 3478 (UDP).
   On a rented server open those in its firewall. Do **not** open 4000 or 7880.
3. Use the computer's **public** address (`--public-ip` if it cannot be found).

`--sslip` works with nothing to buy, but the name changes whenever your address does (everyone then changes it in their app:
`./rushlight address NEWADDRESS` fixes your side and tells you so), and it depends on the free sslip.io service. A domain is better.
Voice has one UDP port (7882) for direct connections and a built-in relay (UDP 3478, 50000 to 50100) for networks that block
direct voice, such as some mobile and office networks. `./rushlight check` tests the name, the certificate, the voice route and
that port 7880 is closed. Anyone on the internet can reach the sign-in page; only people with a join code can get in.

## Updating

    ./rushlight update                 # the newest of what you follow (stable)
    ./rushlight update --version v1.2.3

Nothing else ever changes your version: `start` and `restart` do not download anything. `update` downloads first (if that fails,
nothing has changed), makes an **encrypted backup** if you have turned them on, stops the server, keeps a **plain copy of the
database** (inside the data volume, `/data/rollback`), starts the new version and waits for it to answer. If it does not, the old
version and the copy are put back and it says so; the copy is deleted after a good update.

## Backups and restoring

    ./rushlight backup setup           # the 12 word phrase (shown once), turns on nightly backups
    ./rushlight backup now | list | check FILE
    ./rushlight backup export [FOLDER] # copy the newest backup file out of the container; keep it OFF this computer
    ./rushlight restore FILE.rlbak     # asks for the 12 words

`restore` also works on a computer that has never run Rushlight: the backup carries the settings file, so the secrets and
everyone's sign-ins come back too (if the new computer's address differs, it is updated for you). What a restore replaces is kept:
the data in the volume at `/data/before-restore`, the settings as `.env.before-restore`. A wrong phrase changes nothing.
See `docs/backups.md` for what a backup holds.

## How it is tested

`docker/stack-test.sh` (run by GitHub on every change): copies `deploy/` to an empty folder, runs `setup`, runs `check`, makes two
accounts that join one voice channel through the real LiveKit and checks that one **hears** the other's tone, restarts and finds
the account still there, stops and starts, makes an encrypted backup and checks the secret is not visible in it, updates (a good
update keeps the data; an update whose new version empties the database and exits is rolled back to the old version and data),
restores into the running stack (later changes gone, wrong words change nothing) and onto a computer with no settings, stops voice and checks that `check` names the problem, and that no secret reached the
logs. Not covered there (owner tests): a real network with a firewall, a Raspberry Pi, phones, and people on other networks.

## Public mode test

`docker/stack-test-public.sh` (run by GitHub): the sslip name is made from the address, a missing or bad name is refused, Caddy
answers https for a name that points at the runner (with a certificate made there), `/rtc` reaches LiveKit and not the server, port
7880 is closed to the network, http is sent to https, `check` is clean and then names a stopped web server, and two people
hear each other. **Not tested by GitHub, so yours to try:** a real Let's Encrypt certificate, a router with port forwarding, the
relay (TURN) with a phone on mobile data, and `--sslip` against the real service.

## Versions

LiveKit is pinned in `.env` (`LIVEKIT_VERSION`, set by `setup`); the Rushlight server image follows `RUSHLIGHT_VERSION`
(`stable` unless set otherwise); Caddy is pinned as `CADDY_VERSION`.
