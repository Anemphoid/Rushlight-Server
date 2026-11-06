# Invite your friends

A friend joins with a **join code** you make in the app. Rushlight is the same whichever way you set up the server; only the
**server address** you give your friend differs.

## 1. Make a code

In the app, open your server, then **Admin Tools** (the button appears for the owner and admins) > **Join codes**. Make a code. You can
limit it to one use, to a time, or to one voice channel. A friend joins with the code and a screen name.

## 2. Send two things

1. **The server address**, from the setup you chose:
   - Private: `http://192.168.1.20:4000` (the address `setup` printed)
   - Tailscale: `http://100.64.1.5:4000`, plus the Tailscale steps in [that guide](tailscale.md)
   - Public: `https://chat.example.com`
2. **The code.**

## 3. What your friend does

1. Installs the Rushlight app (at the time of writing it is built for Linux; a Windows version is coming).
2. On the first screen, **Server > Change**, types the address, **Test**, **Save**.
3. Chooses **Join with a code**, enters the code and a screen name.

## If your friend cannot connect

1. Can they reach the address? On Public, ask them to open it in a browser. On Tailscale, ask if the Tailscale app shows as connected.
2. If it says it "couldn't reach the server at ...", the app offers a **Change server address** button; the address may be wrong
   or, on Private and Public at home, may have changed. Run `./rushlight check` on your computer.
3. Voice works but nothing is heard? On Public, make sure the voice doors (7881/TCP, 7882/UDP, 3478/UDP) are forwarded.

## Taking someone out

Admin Tools lists members and guests. You can remove them, and ban someone so they cannot come back with a code.
