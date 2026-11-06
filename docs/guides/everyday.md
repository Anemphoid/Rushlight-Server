# Keep it healthy: updates, backups, and what to do if things go wrong

All commands are run in your Rushlight folder: `cd ~/rushlight`.

## Backups: do this today

Backups are encrypted copies of your server's data. **Make them before you need them.**

    ./rushlight backup setup

It shows you **12 words**. **Write them on paper and keep them somewhere safe, away from this computer.** Nobody, including
the Rushlight developers, can recover them for you; without them a backup cannot be opened. It will ask you to type three of them
back to prove you saved them. After that a backup is made every night while the server is running (it keeps the last 7 nights and
one a week for the 4 weeks before).

Other things you can do:

    ./rushlight backup now            # make one right now
    ./rushlight backup list           # see them, and whether the last one worked
    ./rushlight backup export ~/Desktop   # copy the newest one out of the container

**A backup on the same computer does not protect you if the computer dies.** Copy the exported file somewhere else: a USB stick, another
computer, a cloud drive. The file is encrypted, so that is safe. Do it now and then.

### Getting it back

    ./rushlight restore /path/to/rushlight-2026-01-01.rlbak

It asks for your 12 words. It works on a brand-new computer too: set up the folder as in [Get a computer ready](get-ready.md), skip
`setup`, run `restore`, and your accounts, messages and settings come back. What it replaced is kept (in the data volume
under `/data/before-restore`, and your old settings as `.env.before-restore`). A wrong phrase changes nothing. On a new computer
with Tailscale you also need a new Tailscale key; it tells you. On Public, if the new computer has a different public address, update the
DNS record and run `./rushlight address NEWADDRESS`.

## Updates

    ./rushlight update

It downloads the new version first (if that fails nothing changes), makes an encrypted backup if you have set them up, keeps a copy
of your data, starts the new version and checks it works. **If the new version does not start, it puts the old version and your data
back and tells you.** Nothing updates by itself in the background and a restart never changes your version, so you are in charge.
Update when the project announces a release.

To go to one exact version: `./rushlight update --version v1.2.3`.

## Everyday commands

| Command | What it does |
| --- | --- |
| `./rushlight check` | Looks for problems and says what to do |
| `./rushlight status` | What is running |
| `./rushlight logs server` | The server's recent messages (also `livekit`, `caddy`, `tailscale`) |
| `./rushlight stop` / `start` / `restart` | |
| `./rushlight address` | The computer's address changed |

## If a secret may have leaked

For example, you posted your `.env` file in a chat by mistake.

    ./rushlight rotate-secrets --all

This replaces the sign-in secret and the voice key. **Everyone is signed out** and signs in again with their password; guests join
again with their code. It tries the new secrets before dropping the old ones and puts the old ones back if the new ones do not work.
Old backup files still hold the old secrets (encrypted with your phrase): delete ones you do not need. Use `--livekit` alone if only
the voice key leaked (calls just reconnect).

## Never share these

- Your **`.env`** file: it holds your server's secrets.
- Your **12 backup words**.
- Never paste either in a chat when asking for help. `./rushlight check` output is safe to share.
