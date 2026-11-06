# Which way is right for me?

There are three ways to let friends reach your server. You can change your mind later, but changing means setting up again, so it is
worth a few minutes now.

## Private: "only people in my house" (or on a VPN I already use)

The server has an address inside your home network (like `http://192.168.1.20:4000`). Only devices on that network, or connected to
it, can reach it.

- **Good:** nothing is open to the internet, nothing to buy, no accounts with anyone. The most private option.
- **Not so good:** friends who are not on your network cannot join, unless you already run a VPN.
- **Choose it if:** you play with people in your home, or you and your friends already share a VPN.

## Tailscale: "my friends are far away and I want it easy"

Your computer joins a free private network run by a company called Tailscale. Your friends install Tailscale too, and then Rushlight
works for them as if you were in the same room. Nothing is opened on your router.

- **Good:** the least setup of the options for faraway friends. No router settings. No domain. No certificate.
- **Not so good:** everyone needs a free Tailscale account and the Tailscale app. **Tailscale the company can see which of your
  devices connect to which** (never what you say), and the free plan has a limit on how many devices you can have.
- **Choose it if:** you want faraway friends in the shortest time and you are fine with that trade.

## Public: "anyone I invite, from anywhere, no extra app"

Your server is on the internet with a proper `https://` address. A friend installs only Rushlight and types a code.

- **Good:** nothing extra for friends to install. Works anywhere.
- **Not so good:** the most to set up. You must: have the computer on all the time, tell your router to send some doors to it, and
  have a name for it (a domain, about ten dollars a year, or a free name made from your address that changes when your address
  does). The sign-in page of your server is visible to the whole internet; only people with a code can get in, but you are now
  someone who runs something on the internet, and you should keep it updated.
- **Choose it if:** you want it to feel like any other chat service and you are happy to do a bit more setup.

## Not sure?

Start with **Tailscale** if your friends are far away, or **Private** if they are in your home. Public is the one to pick when you
cannot ask your friends to install anything else.

Not covered here, on purpose: running it for strangers or at a large scale. This is made for you and your friends.
