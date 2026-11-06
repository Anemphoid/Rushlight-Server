# When something is wrong

Run this first:

    cd ~/rushlight
    ./rushlight check

Every line starts with `ok`, `note` or `PROBLEM`. Fix the `PROBLEM` lines from the top. Each one says what to do; this page explains the
common ones in more words. Then run `check` again.

| It says | It means | What to do |
| --- | --- | --- |
| Docker is not installed | Docker is missing | [Get a computer ready](get-ready.md) step 2 |
| Docker is not running, or you are not allowed to use it | Docker stopped, or you have not logged out and in since adding yourself to the docker group | `sudo systemctl start docker`; log out and in |
| Your Docker Compose is too old | Needs 2.24+ | Install Docker with the official installer in the guide |
| No .env | You are in the wrong folder, or have not run setup | `cd ~/rushlight`; `./rushlight setup` |
| The server container is not running | It stopped | `./rushlight start`, then `./rushlight logs server` |
| The voice container is not running | LiveKit stopped | `./rushlight start`, then `./rushlight logs livekit` |
| This computer's address is now X but Rushlight was set up for Y | Your home router gave it a new address | `./rushlight address` (and reserve the address in your router) |
| (Public) X does not point anywhere / points to Z | The domain's A record is missing or wrong | Fix it at your domain's DNS; wait a few minutes |
| (Public) https://X does not answer | The doors (80, 443) are not open, or the name has not spread | Port forwarding in [the Public guide](public.md) step 4; wait and retry |
| (Public) Voice signalling is not reachable | The web server is not passing `/rtc` on, or is stopped | `./rushlight logs caddy` |
| (Public) LiveKit's own port 7880 is reachable | It should be closed | Do not forward 7880; check your firewall |
| (Public) public address is now X | Your address changed | Update the DNS record, then `./rushlight address X` |
| (Tailscale) not signed in to Tailscale | The one-time key was wrong, expired or the sign-in was lost | New key at https://login.tailscale.com/admin/settings/keys; `./rushlight tailscale key` |
| (Tailscale) Tailscale address is now X | Tailscale gave it a new address | `./rushlight address` |

## Other things people hit

- **"command not found: ./rushlight".** You are not in the folder, or the file lost its permission: `cd ~/rushlight; chmod +x rushlight`.
- **"This folder is already set up".** That is on purpose: running `setup` twice would replace the secrets and sign everyone out. Use
  `./rushlight start` or `check`.
- **A friend can join but cannot hear anyone.** Voice uses different doors from the website. On Public, check 7881, 7882 and 3478
  are forwarded. On Private, check the firewall lines `check` prints.
- **The update failed and it rolled back.** That is the safety net working. Nothing is lost. Look at `./rushlight logs server`, and tell us.
- **The computer ran out of disk space.** Old Docker images pile up: `docker image prune -a` removes unused ones (the running ones stay).

## Asking for help

Say what you chose (Private, Tailscale or Public), what you ran, and paste the output of `./rushlight check`. That output is safe to
share. **Never paste your `.env` file or your 12 backup words.**
