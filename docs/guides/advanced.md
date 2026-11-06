# Advanced: running the pieces yourself

For people who already know what a reverse proxy is. The beginner guides use the `rushlight` program; everything it does is plain
Docker Compose and a few config files, so you can do the same by hand or replace any part.

## What runs

- **The server**: the image `ghcr.io/anemphoid/rushlight-server` (tags `vX.Y.Z`, `X.Y`, `stable`; amd64 and arm64), one data volume
  `/data`, listens on `PORT` (4000). See [docker.md](../docker.md) for the settings it needs.
- **LiveKit** (voice): `livekit/livekit-server`, pinned (setup writes the version it was tested with into `.env`). The server talks to
  it at `LIVEKIT_URL`; clients are handed `LIVEKIT_PUBLIC_URL` or, when that is empty and `LIVEKIT_URL` is a plain `ws://` address, the host
  they reached the server on with LiveKit's port ([livekit.md](../livekit.md)).
- **Caddy** (Public mode) and **Tailscale** (Tailscale mode): optional, in Compose profiles.

## Your own reverse proxy

Terminate TLS yourself and send:

- `/rtc` and `/rtc/*` (WebSocket) to LiveKit on 7880, and everything else to the server on `PORT`.
- Set `TRUST_PROXY=1` so rate limits see real client addresses (**only** behind a proxy that sets `X-Forwarded-For`).
- Set `LIVEKIT_PUBLIC_URL=wss://your.host`.
- Keep 7880 and `PORT` closed to the network. Open 7881/TCP and the UDP port you configure in LiveKit (`rtc.udp_port`, we use 7882), and set
  `rtc.node_ip` to the address clients should send media to. A TURN relay needs LiveKit's `turn:` section (we use UDP 3478 and
  relay ports 50000 to 50100).

## Your own LiveKit

Point `LIVEKIT_URL` at it (what the server reaches) and `LIVEKIT_API_KEY`/`LIVEKIT_API_SECRET` at its key. LiveKit Cloud works.

## No Docker

The older install (a systemd service and `update.sh`) still works: see the repository README and
[migrate-existing-install.md](../migrate-existing-install.md).

## Reading the program

`deploy/rushlight` is one bash file and `deploy/compose.yaml` the Compose file. Everything `rushlight` writes (`.env`, `livekit.yaml`,
`Caddyfile`, `tailscale.env`) is plain text in the folder. `docker/stack-test*.sh` are the tests GitHub runs on every change; they
show exactly what is promised and checked. [compose.md](../compose.md) is the reference.
