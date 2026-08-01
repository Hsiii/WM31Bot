# MiniSago

<img src="assets/minisago.png" alt="MiniSago icon" width="160">

**迷你西米露 — a small Discord companion for chat, links, community access,
and useful updates.**

MiniSago quietly improves the Discord servers she joins. She fixes Instagram
Reel embeds, answers questions with recent conversation context, lets members
open optional channels for themselves, posts selected community updates, and
organizes GitHub pull-request discussions.

## What MiniSago does

### Makes Instagram links easier to view

Post an Instagram link normally. MiniSago replies with the matching
`kkinstagram.com` link so the Reel or post embeds more reliably in Discord.

This works in every server and channel MiniSago can see. She never deletes or
replaces the original message.

### Answers questions about the conversation

Mention the **MiniSago bot account** and ask a question. You can also reply to
one of her answers with Discord's reply ping enabled to continue the
conversation without typing another mention. Turn off the reply ping when you
only want to quote or refer to something she said; MiniSago will stay quiet.
When her answer is still the latest part of the conversation, the same person
can also send one follow-up within 90 seconds without mentioning her again.
Another person's message or an expired window ends that continuation.
When Discord permits reactions, a mention answer may be a reply, a reaction to
your message, or both.

MiniSago can:

- summarize recent conversation;
- answer questions about images, PDFs, documents, and text attachments;
- search the public web when current information is needed;
- find older messages in Discord history and return links to the originals;
- reason carefully about identity questions using available server evidence;
- explain the observable sources and retrieval choices behind her previous
  answer.
- optionally react to fresh community messages when a quiet acknowledgment is
  more natural than interrupting the conversation.

Mention answers start with nearby conversation context. When that is
insufficient, the answer model can use MiniSago's short-lived MCP tools to read
more channel history, search only channels the requester can access, resolve
member aliases, inspect a previous answer's observable trace, or add one
validated reaction. Simple questions skip the former context-planning model
call.

Community members can discuss code and links through the read-only chat path,
but repository checkout, developer commands, GitHub mutations, Mac access, and
other privileged capabilities are owner-only. Community and owner chat requests
run on GPT-5.6 Luna; owner requests first use Luna to decide whether development
work should switch to GPT-5.6 Sol with medium reasoning. The worker checks
requester capabilities rather than trying to infer authorization from wording.

She only searches channels that the person asking can access. Member roles,
join dates, and presence are not sent to Codex. Temporary attachment downloads
are removed after the response, and local diagnostic traces expire after 14
days.

Chatbot access is limited to selected guilds and channels. The configured owner
can also use it in other visible servers, threads, and direct messages.
Ambient reactions are disabled by default. When enabled, fresh messages are
buffered without model calls and MiniSago only occasionally checks a
conversation burst; this never enables unsolicited replies.

> [!TIP]
> In Discord's mention picker, choose MiniSago under **Members/Apps**, not a
> similarly named role. A role mention does not start the chatbot.

Chat replies require a compatible Codex worker with free capacity. Oracle can
run as the preferred always-on worker while the unlocked Mac remains connected
as a lower-priority fallback and handles requests that need local Mac resources.
Requests received while every compatible worker is unavailable are not queued.

Hsi can route owner-only development requests to Sol for GitHub issue creation,
PR review, repository changes, tests, and draft-PR delivery. GitHub credentials
use one dedicated repo-scoped `gh` login; community and ordinary chat runs
cannot execute GitHub tooling. Owner development runs in `dev`; each job
receives only its selected disposable repository checkout. Remote mutation
remains disabled unless the owner-only router selects an issue/code/deploy scope
from Hsi's current request. Per-job wrappers enforce that exact scope. Oracle
runs one worker and one dedicated login. See
[issue #12](https://github.com/Hsiii/mini-sago/issues/12) for credential and
GitHub ruleset setup.

### Lets members open optional channels

Members of the configured WM31 server can use the channel-access panel to grant
or remove their own access to the Wordle and Brawl Stars channels. This keeps
optional channels out of the way without requiring a moderator to manage every
request.

Slash commands provide the same actions as a fallback:

| Command                     | Purpose                      |
| --------------------------- | ---------------------------- |
| `/join-wordle-channel`      | Open the Wordle channel      |
| `/leave-wordle-channel`     | Hide the Wordle channel      |
| `/join-brawlstars-channel`  | Open the Brawl Stars channel |
| `/leave-brawlstars-channel` | Hide the Brawl Stars channel |

### Posts useful community updates

MiniSago can publish a daily TOEFL vocabulary card and monitor selected Gamer
forum and X feeds. Each update stays in its configured destination instead of
following the bot into every server.

### Organizes pull-request reviews

For the configured GitHub repository, MiniSago opens a Discord discussion
thread for each pull request, adds the relevant reviewers, pins the review
request, pings the author with the server's `:approved:` emote when the pull
request is approved, and archives the thread when the pull request is closed.

## Where features work

| Feature                 | Availability                                      |
| ----------------------- | ------------------------------------------------- |
| Instagram link replies  | Every visible server and channel                  |
| Chatbot                 | Selected guilds/channels and the owner elsewhere  |
| Optional channel access | Configured WM31 server only                       |
| Vocabulary and feeds    | Their configured server and channel               |
| Pull-request threads    | The configured repository and Discord destination |

## Run your own instance

MiniSago requires [Bun](https://bun.sh/), a Discord application, and a
compatible worker with a working Codex login for chatbot responses.

Configure the Discord credentials and shared Mac bridge secret described in
[Configuration](docs/configuration.md), enable Discord's Message Content
privileged intent, then deploy and install the helper:

```bash
bun install
bun run deploy
bun run mac-agent:install
bun run mac-agent:status
```

The helper starts automatically at login, disconnects when the Mac locks, and
reconnects after unlock without replaying missed requests.

Install the Discord application with the `bot` and `applications.commands`
scopes. It needs permission to view channels, read message history, send
messages and thread replies, pin PR review requests, and manage only the
configured opt-in roles. Grant Create Expressions in guilds where the owner may
ask MiniSago to copy custom emoji. It does not need Manage Webhooks.

Run only one Gateway-enabled instance per bot token. See
[Configuration](docs/configuration.md) for environment settings and
[Operations](docs/operations.md) for registration, deployment, security, logs,
health checks, and removal.

## Development

```bash
bun install
bun run dev
bun test
```
