# Configuration

Use the checked-in environment examples as the mechanical configuration
reference:

- `.env.example` for local development and the Mac helper;
- `.env.production.example` for the hosted Discord service; and
- `.env.worker.example` for the headless Codex worker.

Defaults enforced by an image or installer live in `Dockerfile.worker` and
`scripts/mac-agent.mjs`. This document records the boundaries and security
decisions that are not obvious from those files. Setup and deployment procedures
live in [operations.md](operations.md).

## Hosted service variables

| Name                                   | Required  | Purpose                                                                 |
| -------------------------------------- | --------- | ----------------------------------------------------------------------- |
| `DISCORD_APPLICATION_ID`               | Yes       | Discord application ID                                                  |
| `DISCORD_PUBLIC_KEY`                   | Yes       | Verifies interaction signatures                                         |
| `DISCORD_BOT_TOKEN`                    | Yes       | Discord REST and Gateway authentication                                 |
| `DISCORD_GUILD_ID`                     | No        | Guild allowed to use configured-guild features; defaults to WM31        |
| `DISCORD_GATEWAY_DISABLED`             | No        | Set to `true` for HTTP-only instances                                   |
| `MINISAGO_CHATBOT_OWNER_USER_ID`       | Yes       | Sole owner allowed to route privileged work and mutations               |
| `MINISAGO_CHATBOT_GUILD_IDS`           | No        | Comma-separated guilds whose members may use chatbot features           |
| `MINISAGO_CHATBOT_CHANNEL_IDS`         | No        | Comma-separated channel exceptions; blank allows none                   |
| `MINISAGO_AMBIENT_REACTIONS_ENABLED`   | No        | Set to `true` to let MiniSago consider occasional reactions             |
| `MINISAGO_AMBIENT_ATTENTION_CHANCE`    | No        | Chance from 0–1 that a notification burst schedules an ambient check    |
| `MINISAGO_AMBIENT_MAX_CHECKS_PER_HOUR` | No        | Global hourly ceiling for ambient model calls; defaults to 4            |
| `MINISAGO_REMINDER_STATE_FILE`         | No        | Persistent one-time and cron reminder state                             |
| `MINISAGO_MAC_BRIDGE_SECRET`           | Chatbot   | Authenticates the trusted Mac worker profile                            |
| `MINISAGO_WORKER_BRIDGE_SECRET`        | Chatbot   | Authenticates the server-owned cloud worker profile                     |
| `DISCORD_CHANNEL_ACCESS_CHANNEL_ID`    | No        | Default destination for `bun run publish:panel`                         |
| `SELF_ASSIGNABLE_ROLES`                | No        | JSON role definitions; the built-in fallback targets WM31               |
| `GITHUB_WEBHOOK_SECRET`                | PR bridge | Verifies GitHub's `X-Hub-Signature-256`; blank disables the endpoint    |
| `GITHUB_PR_THREAD_CHANNEL_ID`          | No        | Discord destination for PR review threads                               |
| `GITHUB_PR_THREAD_STATE_FILE`          | No        | Persistent PR-to-thread mapping                                         |
| `TOEFL_VOCAB_CHANNEL_ID`               | No        | Daily vocabulary destination; blank disables posting                    |
| `TOEFL_VOCAB_TIME`                     | No        | Local `HH:MM` posting time                                              |
| `TOEFL_VOCAB_TIMEZONE`                 | No        | IANA timezone for vocabulary posting                                    |
| `TOEFL_VOCAB_STATE_FILE`               | No        | Persistent daily-send state                                             |
| `GAMER_FORUM_*`                        | No        | Forum source, destination, schedule, reader, state, and disable switch  |
| `X_POST_*`                             | No        | X handle/feed, destination, polling interval, state, and disable switch |

See `.env.production.example` for production state paths and the complete
scheduled-monitor variable names.

## Worker variables

| Name                             | Required | Purpose                                                                                    |
| -------------------------------- | -------- | ------------------------------------------------------------------------------------------ |
| `MINISAGO_BRIDGE_URL`            | No       | Hosted WebSocket URL; plain `ws://` is accepted only for local/container-local targets     |
| `MINISAGO_MCP_URL`               | No       | Curated MCP endpoint; derived from the bridge origin and restricted to HTTPS or local HTTP |
| `MINISAGO_MAC_BRIDGE_SECRET`     | Mac      | Must match the hosted Mac-profile secret                                                   |
| `MINISAGO_MAC_FILE_ROOTS`        | No       | Colon-separated folders the owner may ask MiniSago to search and send files from           |
| `MINISAGO_CODEX_PATH`            | No       | Codex executable                                                                           |
| `MINISAGO_CODEX_HOME`            | No       | Isolated helper state                                                                      |
| `MINISAGO_SESSION_MONITOR_PATH`  | No       | Compiled macOS lock monitor                                                                |
| `MINISAGO_TRACE_DATABASE_PATH`   | No       | Local response-trace database                                                              |
| `MINISAGO_WORKSPACE_ROOT`        | Dev      | Parent directory for isolated repository work                                              |
| `MINISAGO_MAX_CONCURRENT_JOBS`   | No       | Advertised capacity, from 1 to 16                                                          |
| `MINISAGO_HEADLESS`              | Linux    | Keeps a non-macOS worker connected without a session monitor                               |
| `MINISAGO_WORKER_ID`             | No       | Stable worker identity                                                                     |
| `MINISAGO_WORKER_CAPABILITIES`   | No       | Comma-separated `chat`, `dev`, and `mac` capabilities                                      |
| `MINISAGO_WORKER_PRIORITY`       | No       | Scheduler priority from 0 to 1000                                                          |
| `MINISAGO_GITHUB_REPOSITORIES`   | Dev      | Exact `owner/repository` allowlist                                                         |
| `MINISAGO_CHATBOT_REPOSITORY`    | No       | Advertised repository that owns chatbot behavior; inferred when only one repo is listed    |
| `MINISAGO_CHATBOT_OWNER_USER_ID` | Yes      | Same owner Discord ID configured on the hosted service                                     |
| `MINISAGO_GITHUB_CONFIG_DIR`     | Dev      | Dedicated GitHub CLI state                                                                 |
| `MINISAGO_GITHUB_WORKTREE_ROOT`  | No       | Disposable per-job checkout root                                                           |

The Mac installer reads `.env.local`; the headless worker reads `.env.worker`.
Image and installer defaults are shown in the corresponding example files.

## Discord boundaries

`DISCORD_GUILD_ID` selects the only guild allowed to use the channel access
panel, role commands, and scheduled posts. Its fallback and the built-in
Wordle/Brawl Stars `SELF_ASSIGNABLE_ROLES` target WM31; they are deployment data,
not portable examples. Change both values together when moving or repurposing
those features. Every scheduled-post destination must belong to the configured
guild.

Chatbot authorization is independent. Configure its sole owner, allowed guilds,
and optional channel exceptions with the `MINISAGO_CHATBOT_*` variables. Every
value is validated as a Discord snowflake. The service and workers fail closed
when the owner is missing or malformed; empty guild and channel lists grant no
community access. The hosted service and every worker must use the same owner
ID.

The owner can mention MiniSago in any guild the bot has joined, even when that
guild is not in the community allowlist. In a guild mention, the owner can ask
MiniSago to copy a custom emoji by name, ID, or value between any two shared
guilds. The destination bot role must have Discord's Create Expressions
permission; this operation is never exposed to community users.

Ambient reactions are opt-in and use the same guild/channel community
boundaries. Fresh human messages first enter an in-memory notification buffer
without calling a model. MiniSago occasionally schedules one delayed attention
check for a conversation burst, then either ignores the batch or reacts to at
most one candidate message. The probability and hard hourly model-call ceiling
are configurable; the defaults notice 25% of eligible bursts and permit at most
four checks per hour. Unsolicited replies remain disabled.

The hosted service verifies the bot's effective channel permissions, advertises
available custom emoji through the bounded reaction capability, validates the
selected message and emoji, and applies channel, member, and hourly reaction
cooldowns before calling Discord. Ambient planning does not download
attachments. The Discord token never leaves the hosted service.

Mention answers use the same host-owned reaction broker and emoji inventory.
One answer inference can choose a reply, a reaction bound to the triggering
message, or both; it does not require a second reaction-planning model call.

Guild mention sessions expose host-bound voice tools. They can join only the
real requester's current voice channel in the current guild, or disconnect
MiniSago from that guild; model arguments cannot select another member, channel,
or guild. These tools are not exposed in direct messages.

Authorized chatbot users can create one-time timers or recurring five-field
cron reminders through the same host-bound MCP session. Reminder identity and
destination are bound to the real requester and current channel; model
arguments cannot target another user or channel. Wall-clock and recurring
requests require a timezone or unambiguous location; MiniSago asks when neither
is supplied, then includes the resolved IANA timezone in its setup message
without requiring a confirmation step. Relative-duration timers do not require
a timezone. A user can keep at most 50 active reminders. Listing and
cancellation are limited to that requester in the current channel.

The checked-in deployment still hardcodes:

- configured-guild fallback `1282936453134815275`;
- WM31 Wordle role `1451976411152781466` and Brawl Stars role
  `1450774352386719775`; and
- PR review repository and reviewer mapping for `Hsiii/health-check-system`.

A general self-host must change these remaining source-level boundaries or
disable the corresponding features. Installing the bot in another guild does
not expose the WM31 controls or scheduled feeds there.

Gateway features are enabled when a bot token is present unless
`DISCORD_GATEWAY_DISABLED=true`. Run only one Gateway-enabled instance per bot
token; use the disabled setting for local or temporary HTTP-only instances while
production is connected.

## Worker trust boundary

The hosted broker has separate worker profiles:

- `MINISAGO_WORKER_BRIDGE_SECRET` authenticates the server-owned `oracle`
  `chat,dev` worker; and
- `MINISAGO_MAC_BRIDGE_SECRET` authenticates a worker advertising `mac`.

Use independent random secrets of at least 32 bytes. The broker binds the cloud
secret to its server-owned identity and capabilities, and accepts the Mac secret
only from a worker advertising `mac`.

Workers advertise capacity, capabilities, and priority. The broker selects the
highest-priority compatible worker, falls back when it is unavailable or full,
and keeps all stages of a workflow on the selected worker. Only requests that
explicitly need a resource on Hsi's Mac may target `mac`.

Community and owner chat jobs run on GPT-5.6 Luna with high reasoning. Owner
requests first use Luna with low reasoning to select `chat` or `dev`; development
jobs then use GPT-5.6 Sol with medium reasoning. Mac targeting is an independent
decision. These profiles are part of the security and capability boundary, not
just quality preferences.

The Mac installer consumes `.env.local`. It creates an isolated Codex home that
links the existing `~/.codex/auth.json` but does not load normal Codex
configuration, skills, memories, plugins, user-configured MCP servers, or
repository instructions. Answer jobs receive only MiniSago's curated MCP server
with an opaque per-request bearer token. The server binds requester identity,
guild, channel permissions, and available actions outside model-controlled
arguments, expires the token after 16 minutes, and revokes it when the workflow
ends.

Answer sessions also expose the read-only `get_codex_usage` tool. The hosted MCP
handler requests a live `account/rateLimits/read` snapshot from the reserved
worker's authenticated Codex app-server and returns each available window's
used and remaining percentage plus its exact reset time. It cannot consume
reset credits or mutate the account.

The trace database is owner-readable, expires entries after 14 days, and prunes
oldest entries above 250 MB. When a user asks about a previous answer, the
`get_previous_trace` MCP tool returns bounded observable metadata from the same
channel without exposing private chain-of-thought.

## Owner development and GitHub

Only owner requests enter the development and Mac execution router. The worker
then rechecks the requester's declared capabilities before Codex runs;
authorization does not depend on matching request phrases. Community jobs and
ordinary chat cannot execute developer commands. Owner development jobs receive
only a selected disposable repository checkout.

GitHub access uses a dedicated persistent `gh` login; MiniSago does not accept,
copy, or inject its token through environment variables. A worker may accept a
development job only for an exact repository advertised in
`MINISAGO_GITHUB_REPOSITORIES`. Advertisement means the worker may clone or
reuse that repository on demand; it does not need to be cloned in advance.
Set `MINISAGO_CHATBOT_REPOSITORY` when a worker advertises multiple repositories
so behavioral-change requests can be routed without repository-name heuristics.

Use one fine-grained credential limited to those repositories. It may receive
repository contents, issues, and pull-request write access, with read access to
checks and Actions when needed. Do not grant administration, secrets,
environments, deployments, organization, or unrelated-repository access.

The router runs only for the configured owner and may select an `issue`, `code`,
or `deploy` mutation from the owner's current request. That selection directly
binds the repository and scope to the job; clear short follow-ups may continue
a single mutation identified by referenced or nearby conversation. Per-job
wrappers enforce the selected scope, require draft pull requests, and reject
merge, ready, protected-branch, and force-push operations through normal
command paths. GitHub rulesets must also block direct and force pushes to
protected branches; Hsi remains responsible for merging. Repository
content and command output remain untrusted data.
Credential and ruleset setup is tracked in
[issue #12](https://github.com/Hsiii/mini-sago/issues/12).

## Persistent state

The PR review bridge and scheduled monitors use state files for idempotency.
Local defaults live under `.data`; production paths must live under `/app/state`
on the persistent `sago_cloud_bot-core-state` volume. The relevant variables
are:

- `GITHUB_PR_THREAD_STATE_FILE`
- `TOEFL_VOCAB_STATE_FILE`
- `GAMER_FORUM_STATE_FILE`
- `X_POST_STATE_FILE`
- `MINISAGO_REMINDER_STATE_FILE`

Do not place these files on the container's ephemeral filesystem in production.
