# Setting up LiveKit for Rushlight

Rushlight uses [LiveKit](https://livekit.io) to carry voice. It is a separate
program, and **it is not bundled with the Rushlight server**: you install and run
it yourself, next to the server. Bundling it into one setup is planned (see "Not
built yet" in the README).

This is a basic guide to get voice working. LiveKit is the authority on its own
setup, so check [its documentation](https://docs.livekit.io) for anything beyond
this page, and for the install steps for your system.

## How the pieces fit

- The **Rushlight server** hands each client a short-lived token for the voice
  room they open, and uses LiveKit's admin API to disconnect or mute someone when
  an admin kicks or mutes them.
- **LiveKit** is where the audio actually goes. Clients connect to it directly,
  at the address you put in `LIVEKIT_URL`.
- Both use the same API key and secret. The Rushlight server reads them from its
  `.env`; LiveKit reads them from its own config file.

## 1. Install LiveKit

Install the LiveKit server on the same machine as the Rushlight server, or on
another machine both can reach. LiveKit publishes a Linux binary and a Docker
image (`livekit/livekit-server`); follow its documentation for the current install
command. Check that it runs with `livekit-server --version`.

## 2. Write its config

Create a config file, for example `livekit.yaml`:

```yaml
port: 7880
rtc:
  tcp_port: 7881
  port_range_start: 50000
  port_range_end: 60000
  # true asks a STUN server for the machine's public IP. Use it when the machine
  # is on the internet or behind a router and clients connect from outside.
  # Leave it false when everyone is on the same local network or VPN.
  use_external_ip: false
keys:
  rushlight: PUT-A-LONG-RANDOM-SECRET-HERE
```

Generate a secret with `openssl rand -hex 32`. The part before the colon
(`rushlight` above) is the API **key**; the part after it is the **secret**.

Do not use LiveKit's `--dev` mode for a real setup. It uses a well-known key and
secret, which anyone could use to join your rooms.

Start it with that file, for example `livekit-server --config livekit.yaml`, and
run it as a service (systemd or Docker with a restart policy) so it survives a
reboot.

## 3. Open the ports

These come from LiveKit's own sample configuration:

| Port | Protocol | What it is for |
| --- | --- | --- |
| 7880 | TCP | Connections from clients and from the Rushlight server. Can sit behind a reverse proxy that provides TLS. |
| 7881 | TCP | Fallback for clients that can't use UDP. LiveKit says this port cannot be behind a load balancer or TLS. |
| 50000 to 60000 | UDP | The voice traffic itself. |

If a firewall sits between your clients and the machine, these have to be allowed
in. Behind a home router, forward them to the machine.

## 4. Tell the Rushlight server

In the Rushlight server's `.env`:

```
LIVEKIT_URL=ws://your-livekit-host:7880
LIVEKIT_API_KEY=rushlight
LIVEKIT_API_SECRET=the-same-secret-as-in-livekit.yaml
```

Then restart the Rushlight server (`systemctl restart rushlight-server`).

- `LIVEKIT_URL` is given to every client as written, so it must be an address
  **every client can reach**, not `localhost` unless everyone is on that machine.
- The Rushlight server also uses it, so it has to be reachable from there too.
- Use `wss://` if LiveKit is behind a reverse proxy that provides HTTPS. Use
  `ws://` if it is not. Browsers and apps on the open internet should use `wss://`.

## 5. Check it

Open Rushlight on two machines, join the same voice room, and talk. The voice
panel shows `Connected` and a ping when it works.

## When it doesn't work

- **"Couldn't connect to voice"**: the client can't reach `LIVEKIT_URL`. Check the
  address from the client's machine, and that port 7880 is open.
- **Connects but nobody hears anyone**: the UDP range is probably blocked. Check
  the firewall and port forwarding for 50000 to 60000, and try
  `use_external_ip: true` if clients connect from outside your network.
- **Token errors, or LiveKit refuses the connection**: the key and secret in
  `.env` don't match the ones in `livekit.yaml`. They must be identical.
- **Works on your network, not for a friend elsewhere**: UDP is often blocked by
  strict networks. LiveKit has a built-in TURN server for this; see its
  documentation for the `turn` section, which needs a domain name and a TLS
  certificate.

## Status of this guide

The ports and settings above are from LiveKit's own sample configuration. The
steps themselves have not been tested from scratch on a clean machine, so if
something here is wrong or unclear, that is a bug in this guide.
