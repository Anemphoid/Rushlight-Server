# Words you will see

- **Server.** The program on your computer that holds your friends' accounts and messages. It is the Rushlight server.
- **App (client).** The Rushlight program your friends install to join. It talks to your server.
- **Docker.** A tool that runs programs in tidy sealed boxes ("containers"), so installing the server does not mess up your computer
  or need dozens of steps. You install it once; `rushlight` does the rest.
- **Container.** One of those boxes. You will have two or three: the server, voice (LiveKit), and sometimes a web server or Tailscale.
- **LiveKit.** The program that carries voice. You never use it directly.
- **Join code / invite.** What a friend types to get in. Made in the app, in Admin Tools.
- **IP address.** The number a computer has on a network, like `192.168.1.20`. Your **local** address works inside your home; your
  **public** address is what the internet sees.
- **Router.** The box from your internet company. For Public mode you tell it to send certain doors ("ports") to your computer.
- **Port.** A numbered door on a computer. Rushlight uses a handful (the guides list them).
- **Domain name.** A name like `chat.example.com` that you rent for about ten dollars a year, so people do not type numbers.
- **HTTPS / certificate.** The padlock in a browser. In Public mode this is set up for you and renews itself.
- **Tailscale / tailnet.** A free service that gives your devices a private network over the internet. Your **tailnet** is your own
  private network of devices.
- **Backup phrase.** 12 words that open your encrypted backups. **Nobody can recover it for you.**
- **Recovery key.** A different 12 words that belong to each person's account, not to your server.
