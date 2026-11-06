# Tailscale: the easy way for friends who are far away

Before you start: [Get a computer ready](get-ready.md).

**What this does.** Your computer joins a free private network (your *tailnet*) run by Tailscale. Rushlight lives at a private
address on it, like `http://100.64.1.5:4000`. Only devices on your tailnet, or that you share the computer with, can see it.
Nothing is opened on your router.

**The trade, in plain words.** Tailscale the company can see which of your devices connect to which (never what is said). The
free plan limits devices (check Tailscale's own pricing page for today's limit). Everyone needs the Tailscale app.

## 1. Make a Tailscale account

Go to https://login.tailscale.com and sign up (it uses an existing Google, Microsoft or GitHub login; there is no new password).

## 2. Make a one-time key

In the Tailscale admin, open **Settings > Keys** (https://login.tailscale.com/admin/settings/keys), click **Generate auth key**.
A one-time key is enough. Copy it; it starts with `tskey-`. Keys expire on their own.

## 3. Set it up

    cd ~/rushlight
    ./rushlight setup tailscale

Paste the key when it asks (you will not see it as you type; that is on purpose) and press Enter.

It joins your tailnet, starts everything and ends with something like `Joined Tailscale as 100.64.1.5` and
`Rushlight is running at http://100.64.1.5:4000`. **That address is what you give your friends.** To name the computer in
Tailscale, add `--name my-rushlight`.

The key is used once and then emptied; it is never put in the file the server reads. If something goes wrong with the key
(wrong, expired, already used), the message says so and what to do: make a new key and run `./rushlight tailscale key`.

## 4. Check it

    ./rushlight check

All `ok`. It will remind you that nothing is open to the internet (good; do not forward ports on your router for this mode).

## 5. Let friends in

Each friend needs the Tailscale app (https://tailscale.com/download) **and** a way onto your server. Pick one:

- **Share just this computer (recommended).** In the Tailscale admin, **Machines**, click the `...` next to your computer, **Share**,
  and send the link to your friend. They sign in to their own Tailscale (a free account) and accept. They see only this
  computer, not the rest of your devices.
- **Or invite them to your tailnet** (**Users** > **Invite**). Simpler, but they join your whole network; use it only for people
  you trust with that.

Then they open the Rushlight app and use **Server > Change** to type your address (`http://100.64.1.5:4000`), and you
[invite them with a code](invite-friends.md).

## Things to know

- **Voice goes over the same private network.** Nothing extra to set up.
- **If the computer is rebuilt or Tailscale's data is lost,** make a new key and run `./rushlight tailscale key`.
- **After a restore on a new computer** you also need a new key; the restore tells you.
