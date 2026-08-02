# MiniSago

<img src="assets/minisago.png" alt="MiniSago icon" width="160">

A Discord companion for chat, links, community access, and updates.

## Features

- Reacts to community messages with emotes in configured server.
- Answers mentions in configured server using conversation context, attachments, public web search, and accessible Discord history.
- Performs emote management on demand including adding new emote from attachment and moving emotes to other servers.
- Publishes daily TOEFL vocabulary, AniGamer forum voucher code updates, and Codex news on X to configured channels.
- Improves Instagram and Twitter/X embeds with `kkinstagram.com` and `fxtwitter.com` links.
- Creates reminders when asked to and pings you when the reminder expires.
- Listen to GitHub activities and maintains PR review threads for certain repo in configured server.
- Find files in my Mac and send it in chat when asked by me.
- Codes and publishes PR when asked by me.
 
> [!TIP]
> When mentioning her, choose MiniSago under **Members/Apps**, not role.  
> When quoting her messages, disable reply ping to prevent triggering another reply.  
> She searches only channels the requester can access, so feel free to continue to talk behind someone's back.  

## Self-host MiniSago

MiniSago requires [Bun](https://bun.sh/), a Discord application, and a Codex
worker.

Start with [Discord setup](docs/discord-setup.md) and
[worker setup](docs/workers.md). See also:

- [Architecture](docs/architecture.md)
- [Configuration](docs/configuration.md)
- [Security](docs/security.md)
- [Operations](docs/operations.md)
