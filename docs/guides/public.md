# Public: on the internet, with a normal https:// address

Before you start: [Get a computer ready](get-ready.md). This is the longest guide because the internet needs some arranging. Take
it one step at a time; you can stop after any step.

**What this does.** Your server gets an address like `https://chat.example.com` with the padlock, and a friend needs only the
Rushlight app and a code. A small web server (Caddy) gets and renews the certificate by itself.

**What you are agreeing to.** Your server's sign-in page is visible to the whole internet. Only people with a code can get in, but you
now run something public: keep it updated ([updates](everyday.md)), and make backups.

## Step 1. Is this computer reachable from the internet at all?

- **A rented server (VPS)?** Yes. Skip to step 2. Open ports in the provider's firewall page as listed in step 4.
- **A computer at home?** Two things must be true:
  1. Your home internet gives you a public address that is really yours. Search the web for "what is my IP". Then look at the "WAN"
     or "Internet" address on your router's status page. **If they are different, your provider shares one address between
     many homes ("CGNAT") and Public mode cannot work at home.** Use [Tailscale](tailscale.md) instead, or rent a small server.
  2. You can change your router's settings (step 4).

## Step 2. A name for your server

Pick **one**:

- **A domain you own (best).** Buy one from any registrar (about ten dollars a year). In its DNS settings add an **A record**: name
  `chat` (or whatever you like), value = your public address from step 1. Wait a few minutes. Your server will be `chat.yourdomain.com`.
- **A free name made from your address (`--sslip`).** The name looks like `203-0-113-10.sslip.io` and is made from your address by a
  free service. Nothing to buy. **But the name changes whenever your address does** (then everyone must change it in their app), and
  you depend on that free service staying up. Fine for trying it out.

## Step 3. Make sure your computer's address does not change

In your router's settings, "reserve" (also called "static lease" or "DHCP reservation") this computer's local address so the router
always gives it the same one. Step 4 depends on it.

## Step 4. Send the doors to your computer (home only)

In your router's settings find **Port forwarding** (or "virtual server"). Add these, all pointing to this computer's **local** address:

| Port | Type | What it is |
| --- | --- | --- |
| 80 | TCP | getting the certificate |
| 443 | TCP | the website and signalling for voice |
| 7881 | TCP | voice (fallback) |
| 7882 | UDP | voice |
| 3478 | UDP | voice relay for people on strict networks |

**Do not open 4000 or 7880.** The web server on 443 is the only front door.

(On a rented server the same ports are opened in the provider's "firewall" or "security group" page, and in `ufw` if it is on:
`sudo ufw allow 80,443,7881/tcp` and `sudo ufw allow 7882,3478/udp`.)

## Step 5. Set it up

With your own domain:

    cd ~/rushlight
    ./rushlight setup public --domain chat.example.com

or with the free name:

    ./rushlight setup public --sslip

It checks the name points here, shows you the address people will use and the doors you must have opened, asks `Go ahead? [Y/n]`,
and starts everything. It ends with `Rushlight is running at https://chat.example.com`. Add `--email you@example.com` if you want
the certificate authority to be able to warn you before a certificate expires.

If it says the name does not point anywhere yet, wait a few minutes for DNS and run the same command again.

## Step 6. Check it

    ./rushlight check

This one tests a lot: the name points here, the padlock works from outside the computer, voice signalling is reachable, and
LiveKit's own door is closed. Every line should be `ok`. If you see `PROBLEM`, see
[When something is wrong](when-something-is-wrong.md). The two most common are a port that is not forwarded yet and a name that
has not spread yet.

**Test from outside.** On your phone with Wi-Fi turned **off** (mobile data), open `https://chat.example.com/api/health` in the browser. You
should see `{"ok":true}` and a padlock. If you cannot, the doors in step 4 are the usual cause.

## Step 7. Connect

Install the Rushlight app and use **Server > Change** to type `https://chat.example.com` (no `:4000`). Create your account, then
create your server. Then [invite your friends](invite-friends.md).

## If your address changes (home)

Home addresses change sometimes. With a domain: update the A record, then `./rushlight address NEWADDRESS`. With `--sslip`: run
`./rushlight address NEWADDRESS`; the name changes, so everyone must change it in their app. `./rushlight check` tells you when it has changed.

## What has not been proven yet

Getting a certificate from the real Let's Encrypt, port forwarding on real routers, and voice relaying for people on mobile data
have not been tested by anyone yet. If one of them does not work for you, that is what we need to hear about.
