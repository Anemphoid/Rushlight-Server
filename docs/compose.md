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

## Versions

LiveKit is pinned in `.env` (`LIVEKIT_VERSION`, set by `setup`); the Rushlight server image follows `RUSHLIGHT_VERSION`
(`stable` unless set otherwise).
