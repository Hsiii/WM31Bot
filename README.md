# MiniSago

<img src="assets/minisago.png" alt="MiniSago icon" width="160">

**迷你西米露 — a Discord companion for chat, links, community access, and
updates.**

## Features

- Improves Instagram and Twitter/X embeds with `kkinstagram.com` and
  `fxtwitter.com` links.
- Answers mentions using conversation context, attachments, public web search,
  and accessible Discord history.
- Accepts one unmentioned follow-up from the same person within 90 seconds.
- Creates reminders and joins a requester's voice channel silently.
- Lets members opt into configured Wordle and Brawl Stars channels.
- Publishes TOEFL vocabulary and selected Gamer forum and X updates.
- Maintains Discord review threads for GitHub pull requests.
- Optionally reacts to new community messages.

## Using the chatbot

Mention the **MiniSago bot account** and ask a question. Reply with Discord's
reply ping enabled to continue the conversation; disable it to quote her
without making a request.

> [!TIP]
> In Discord's mention picker, choose MiniSago under **Members/Apps**, not a
> similarly named role. A role mention does not start the chatbot.

MiniSago searches only channels the requester can access. Repository changes,
GitHub mutations, custom emoji copying, sending messages on someone's behalf,
and access to Hsi's Mac are owner-only. Chat requests require an available
Codex worker and are not queued.

## Commands

| Command                     | Purpose                                               |
| --------------------------- | ----------------------------------------------------- |
| `/join-wordle-channel`      | Open the Wordle channel                               |
| `/leave-wordle-channel`     | Hide the Wordle channel                               |
| `/join-brawlstars-channel`  | Open the Brawl Stars channel                          |
| `/leave-brawlstars-channel` | Hide the Brawl Stars channel                          |
| `/join-vc`                  | Follow the requester into their current voice channel |
| `/leave-vc`                 | Disconnect from voice                                 |

## Availability

| Feature                 | Availability                                      |
| ----------------------- | ------------------------------------------------- |
| Instagram link replies  | Every visible server and channel                  |
| Chatbot                 | Selected guilds/channels and the owner elsewhere  |
| Optional channel access | Configured WM31 server only                       |
| Vocabulary and feeds    | Their configured server and channel               |
| Pull-request threads    | The configured repository and Discord destination |

## Run MiniSago

MiniSago requires [Bun](https://bun.sh/), a Discord application, and a Codex
worker.

```bash
bun install
bun run dev
```

Start with [Discord setup](docs/discord-setup.md) and
[worker setup](docs/workers.md). See also:

- [Architecture](docs/architecture.md)
- [Configuration](docs/configuration.md)
- [Security](docs/security.md)
- [Operations](docs/operations.md)

## Development

```bash
bun install
bun run build
bun run --cwd mac-agent build
bun test
bun run format:check
```
