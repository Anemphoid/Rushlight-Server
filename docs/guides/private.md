# Private: a server for people on your own network

Before you start: [Get a computer ready](get-ready.md) (Docker installed, files in `~/rushlight`).

## 1. Set it up

    cd ~/rushlight
    ./rushlight setup

It finds the computer's address on your home network and shows you something like:

    Setting up a Private Rushlight server.
      Address people will use: http://192.168.1.20:4000

Type `Y` and press Enter. It creates your secrets (random, never shown on screen, saved in a private file called `.env`),
downloads what it needs (the first time takes a minute or two), starts everything, and ends with
`Rushlight is running at http://192.168.1.20:4000`.

If it cannot work out the address it asks you to give one: `./rushlight setup --ip 192.168.1.20`.

## 2. Check it

    ./rushlight check

Every line should start with `ok`. A line starting with `note` is advice. A line starting with `PROBLEM` tells you what to do; see
[When something is wrong](when-something-is-wrong.md).

If you use a firewall (`ufw`) on this computer, `check` prints the lines to let people in.

## 3. Connect

Install the Rushlight app on your own computer, then on the first screen use **Server** > **Change** and type the address
(`http://192.168.1.20:4000`). Use **Test**, then **Save**. Create your account, then create your server from the Home screen.
You are the owner of that server.

Then [invite your friends](invite-friends.md).

## Things to know

- **The address can change.** Home routers sometimes give a computer a new address after a restart. If voice stops working,
  run `./rushlight check`; if it says the address changed, run `./rushlight address`. Better: in your router's settings, "reserve" this
  computer's address so it never changes.
- **It starts again by itself** after the computer restarts (Docker starts it). If it does not, `./rushlight start`.
- **To stop it:** `./rushlight stop`. **To start:** `./rushlight start`.
- **Private means private.** Nobody outside your network can reach it. To let faraway friends in, you would need a VPN, or
  [Tailscale](tailscale.md), or [Public](public.md).
