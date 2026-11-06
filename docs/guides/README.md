# Run your own Rushlight server

These guides take you from "I have never run a server" to a Rushlight server your friends can join. You do not need to know
what Docker is. If a step has a command, you copy it, paste it, and press Enter. If something does not look like what the guide
says, go to [When something is wrong](when-something-is-wrong.md).

> **Status of these guides.** They were written from the automated tests that run on every change, **not yet from a real person
> following them on a fresh computer.** The first real run will find confusing spots; please tell us where you got stuck. This
> page and the ones below will be corrected from what really happens. Everything here is for **Linux** (including Raspberry Pi).
> A Windows version with a simple program instead of commands is planned.

## 1. Pick how your friends will reach you

Read [Which way is right for me?](choose.md) (two minutes). The short version:

| If... | Choose | You need |
| --- | --- | --- |
| Everyone is in the same house, or already on a VPN you run | **Private** | nothing extra |
| Your friends are far away and you want the **least setup** | **Tailscale** | a free Tailscale account; friends install Tailscale |
| Anyone with an invite should be able to join from anywhere | **Public** | a computer that is always on, access to your router, ideally a domain name |

## 2. Follow the guide for your choice

1. [Get a computer ready](get-ready.md): the one thing every path needs (Docker).
2. Then **one** of:
   - [Private](private.md)
   - [Tailscale](tailscale.md)
   - [Public (on the internet)](public.md)
3. [Invite your friends](invite-friends.md).
4. [Keep it healthy: updates and backups](everyday.md). **Do the backup step. It is the one thing you cannot do later after a disaster.**

## Need something else?

- [When something is wrong](when-something-is-wrong.md): what each message from `./rushlight check` means.
- [If a secret may have leaked](everyday.md#if-a-secret-may-have-leaked).
- [Advanced: running the pieces yourself](advanced.md), for people who want their own reverse proxy, their own LiveKit or no Docker.
- [Words you will see](words.md).
