# MiniSago

<img src="assets/minisago.png" alt="MiniSago icon" width="160">

**迷你西米露 — a small Discord companion for chat, links, community access,
and useful updates.**

MiniSago quietly improves the Discord servers she joins. She fixes Instagram
and Twitter/X embeds, answers questions with conversation context, manages
optional channels, posts selected community updates, and organizes pull-request
discussions.

## Features

- Rewrites Instagram and Twitter/X links through `kkinstagram.com` and
  `fxtwitter.com` for more reliable embeds.
- Answers mentions using nearby conversation, supported attachments, public web
  search, and permission-filtered Discord history.
- Supports one unmentioned follow-up from the same person for 90 seconds when
  her answer remains the latest part of the conversation.
- Creates reminders, joins a requester's voice channel silently, copies custom
  emoji for the owner, and sends owner-requested channel messages.
- Lets members opt into configured Wordle and Brawl Stars channels.
- Publishes TOEFL vocabulary and selected Gamer forum and X updates.
- Opens and maintains Discord review threads for GitHub pull requests.
- Can occasionally acknowledge fresh community messages with an ambient
  reaction when that opt-in feature is enabled.

MiniSago never replaces the original social-link message, never sends
unsolicited ambient replies, and searches only Discord channels the requester
can access.

## Using the chatbot

Mention the **MiniSago bot account** and ask a question. To continue, reply to
her answer with Discord's reply ping enabled. Turn the reply ping off when you
only want to quote her without starting another request.

MiniSago can answer questions about images, PDFs, and text attachments; find
older Discord messages and link to the originals; search the public web; and
explain the observable sources used for her previous answer. When Discord
permits reactions, an answer may be text, a reaction, or both.

> [!TIP]
> In Discord's mention picker, choose MiniSago under **Members/Apps**, not a
> similarly named role. A role mention does not start the chatbot.

Community chat is read-only outside MiniSago's bounded Discord actions.
Repository work, GitHub mutations, and access to Hsi's Mac are owner-only.
Requests are handled only while a compatible Codex worker has free capacity;
they are not queued when every worker is unavailable.

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

MiniSago requires [Bun](https://bun.sh/), a Discord application, and a
compatible worker with a working Codex login.

```bash
bun install
bun run dev
```

For a complete installation, start with [Discord setup](docs/discord-setup.md)
and [worker setup](docs/workers.md), then consult:

- [Architecture](docs/architecture.md) for system and request flow;
- [Configuration](docs/configuration.md) for environment variables and state;
- [Security](docs/security.md) for trust boundaries and data handling; and
- [Operations](docs/operations.md) for deployment, health, recovery, and
  removal.

## Development

```bash
bun install
bun run build
bun run --cwd mac-agent build
bun test
bun run format:check
```
