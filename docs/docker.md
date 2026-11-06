# The Rushlight server as a container

Most people will not use this page: the Compose stack (coming with `rushlight setup`) starts everything for you. This page is
for people who want to run the image by hand, and for anyone curious about what is inside it.

## The image

- **Name:** `ghcr.io/anemphoid/rushlight-server`. Tags: `vX.Y.Z` (an exact release), `X.Y` (the newest release of that line),
  and `stable` (the newest release). Use an exact tag for anything you care about.
- **For:** ordinary computers (amd64) and Raspberry Pi (arm64). Linux hosts.
- **Inside:** the server, Node 22, ffmpeg (for Jellybox) and nothing else. LiveKit (voice), Tailscale and Caddy are separate
  containers. **No secret is in the image.**
- **Runs as** a normal user, not root. The first process is `tini`, so `docker stop` ends it promptly.

## What it needs when it starts

| Setting | What it is |
| --- | --- |
| `JWT_SECRET` | A long random string (48 random bytes as hex). Signs everyone's sign-in. Change it and everyone signs in again. |
| `LIVEKIT_URL` | Where this server reaches LiveKit, for example `ws://127.0.0.1:7880` |
| `LIVEKIT_API_KEY`, `LIVEKIT_API_SECRET` | The key and secret LiveKit was started with |
| `LIVEKIT_PUBLIC_URL` | Optional. What clients are told to connect to; see `docs/livekit.md` |

Everything else in `.env.example` can be given the same way.

## The data

Everything that must survive an update is in **one volume, `/data`**: the database (`rushlight.db`), the encrypted backups
(`backups/`) and the backup key file (`backup-public.key`). Nothing else needs to be kept. To include the server's secrets in the
encrypted backups, give the container the file that holds them and set `BACKUP_ENV_FILE` to its path (the Compose stack does
this for you).

## Is it healthy?

The image has a health check that asks the server's own `/api/health`. `docker ps` shows `(healthy)` when the server answers.

## Running it by hand

    docker run -d --name rushlight --network host \
      -v rushlight-data:/data \
      -e JWT_SECRET=... -e LIVEKIT_URL=ws://127.0.0.1:7880 \
      -e LIVEKIT_API_KEY=... -e LIVEKIT_API_SECRET=... \
      ghcr.io/anemphoid/rushlight-server:v1.0.0

## How it is tested

`docker/smoke-test.sh <image>` starts the image with throwaway secrets and checks that it becomes healthy, runs as a normal user,
has ffmpeg, keeps its database on the volume, has no secret or database inside it, answers from outside, can make an account,
runs the backup tool, stops promptly, keeps its data across a restart, and never puts a secret in its log. GitHub runs it on every
change to the image, and on a release for both kinds of computer before anything is published.
