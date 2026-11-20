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

- **The address can change.** Home routers sometimes give a computer a new address after a restart or an update, and then voice
  stops while chat carries on. Three layers, use all you can: (1) in your router's settings "reserve" this computer's address so
  it never changes (look for DHCP reservation or static lease), and do not set a different fixed address inside the computer
  unless it is the same one; (2) run `./rushlight autofix on`: the computer then checks every minute and fixes voice by itself when
  its address changes (what it did is written in `.autofix.log`); (3) if you have not, the admin screen in the app tells you the
  new address and gives you a message to send your friends, and `./rushlight check` then `./rushlight address` fixes it by hand.
  Your friends still have to type the new address in their app (**Settings > Connection**); they see "This server may have
  moved" and a field for it.
- **It starts again by itself** after the computer restarts (Docker starts it). If it does not, `./rushlight start`.
- **To stop it:** `./rushlight stop`. **To start:** `./rushlight start`.
- **Private means private.** Nobody outside your network can reach it. To let faraway friends in, you would need a VPN, or
  [Tailscale](tailscale.md), or [Public](public.md).
