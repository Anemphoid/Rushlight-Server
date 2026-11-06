# Get a computer ready

Every path needs the same thing first: a **Linux computer** that stays on while people use Rushlight, with **Docker** installed.

## What counts as a computer

- A desktop or laptop running Ubuntu, Debian, Fedora or similar. A spare old one is fine.
- A **Raspberry Pi 4 or 5** with a 64-bit system. (Voice for a handful of friends is fine; do not expect a crowd.)
- A rented server (a "VPS") running Ubuntu or Debian. This is the easiest way to get Public mode, since it already has a public
  address and no router in the way.

It needs: 64-bit, about 1 GB of free memory, 5 GB of free disk, and a normal internet connection. **It must stay on and connected**:
if you turn it off, your server is off.

> **If you only have Windows or a Mac:** these guides are not for you yet. A Windows program is planned; ask in the project. Do not
> try to follow the Linux steps on Windows.

## Step 1. Open a terminal

On Ubuntu press `Ctrl + Alt + T`. This is a window where you type commands. In every guide, a block like this is something to
copy and paste into it, then press **Enter**:

    echo hello

You should see `hello`. If you do, you are ready.

## Step 2. Install Docker

Paste this and press Enter. It downloads Docker's own installer and runs it. It will ask for your password (nothing shows as you type; that
is normal).

    curl -fsSL https://get.docker.com | sudo sh

Then allow your account to use Docker without typing your password every time:

    sudo usermod -aG docker $USER

**Now log out and log back in** (or restart the computer). This step is easy to skip and then nothing works.

Check it:

    docker run --rm hello-world

If it prints "Hello from Docker!" you are done. If it says "permission denied", you did not log out and in yet. If it says "command
not found", the first step failed; run it again and read what it printed.

Prefer to read what that installer does first? The official instructions are at https://docs.docker.com/engine/install/ . Rushlight
needs Docker Compose version 2.24 or newer, which that installer includes.

## Step 3. Get the Rushlight files

Make a folder for your server and fetch the files into it. Pick a folder you will remember; it is where your settings (and secrets)
live.

    mkdir -p ~/rushlight && cd ~/rushlight
    docker run --rm --user "$(id -u):$(id -g)" -v "$PWD":/out --entrypoint sh ghcr.io/anemphoid/rushlight-server:stable -c 'cp -r /app/deploy/. /out/'
    ls

You should see `compose.yaml` and `rushlight`. From now on every command starts with `./rushlight` and is run **inside this folder**
(`cd ~/rushlight` gets you back to it).

> The picture of "inside this folder" matters: if you open a new terminal later, first type `cd ~/rushlight`.

Now go to your path: [Private](private.md), [Tailscale](tailscale.md) or [Public](public.md).
