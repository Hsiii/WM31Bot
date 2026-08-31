# Configuration

The checked-in environment examples are the mechanical source of truth:

- `.env.example` for local development and the Mac helper;
- `.env.production.example` for the hosted Discord service; and
- `.env.worker.example` for the headless Oracle worker.

Image and installer defaults live in `Dockerfile.worker` and
`scripts/worker.mjs`. This reference explains each setting; setup procedures
live in [Discord setup](discord-setup.md) and [Workers](workers.md).

## Hosted service

| Name                                   | Required  | Purpose                                                 |
| -------------------------------------- | --------- | ------------------------------------------------------- |
| `DISCORD_APPLICATION_ID`               | Yes       | Discord application ID                                  |
| `DISCORD_BOT_TOKEN`                    | Yes       | Discord REST and Gateway authentication                 |
| `DISCORD_GUILD_ID`                     | No        | Guild for configured-guild features; defaults to WM31   |
| `DISCORD_GATEWAY_DISABLED`             | No        | Use `true` for HTTP-only instances                      |
| `MINISAGO_CHATBOT_OWNER_USER_ID`       | Yes       | Sole owner of privileged routing and mutations          |
| `MINISAGO_CHATBOT_GUILD_IDS`           | No        | Comma-separated guilds whose members may use chat       |
| `MINISAGO_CHATBOT_CHANNEL_IDS`         | No        | Comma-separated channel exceptions                      |
| `MINISAGO_CHATBOT_ROLE_IDS`            | No        | Comma-separated roles that may mention the chatbot      |
| `MINISAGO_AMBIENT_REACTIONS_ENABLED`   | No        | Enable occasional ambient reactions                     |
| `MINISAGO_AMBIENT_ATTENTION_CHANCE`    | No        | Chance from 0 to 1 that a burst schedules evaluation    |
| `MINISAGO_AMBIENT_MAX_CHECKS_PER_HOUR` | No        | Hourly ambient model-call ceiling; defaults to 4        |
| `MINISAGO_REMINDER_STATE_FILE`         | No        | Persistent reminder state                               |
| `MINISAGO_GUILD_MEMORY_DIRECTORY`      | No        | Per-server Markdown memory and local Git history        |
| `MINISAGO_FEATURE_AVAILABILITY_FILE`   | No        | Persistent guild and channel feature policy             |
| `MINISAGO_SERVICE_SUBSCRIPTIONS_FILE`  | No        | Persistent background-service destinations              |
| `MINISAGO_TRIP_WORKSPACE_URL`          | No        | Kyushu workspace API; defaults to the shared planner    |
| `MINISAGO_TRIP_WORKSPACE_TOKEN`        | No        | Dedicated token enabling guild-bound itinerary edits    |
| `MINISAGO_MAC_BRIDGE_SECRET`           | Chatbot   | Authenticate the fixed Mac worker profile               |
| `MINISAGO_WORKER_BRIDGE_SECRET`        | Chatbot   | Authenticate the fixed Oracle worker profile            |
| `GITHUB_WEBHOOK_SECRET`                | PR bridge | Verify GitHub's `X-Hub-Signature-256`                   |
| `GITHUB_PR_THREAD_CHANNEL_ID`          | No        | Discord destination for PR review threads               |
| `GITHUB_PR_THREAD_STATE_FILE`          | No        | Persistent PR-to-thread mapping                         |
| `TOEFL_VOCAB_CHANNEL_ID`               | No        | Vocabulary destination; blank disables posting          |
| `TOEFL_VOCAB_TIME`                     | No        | Local `HH:MM` posting time                              |
| `TOEFL_VOCAB_TIMEZONE`                 | No        | IANA timezone for vocabulary posting                    |
| `TOEFL_VOCAB_STATE_FILE`               | No        | Persistent daily-send state                             |
| `GAMER_FORUM_*`                        | No        | Forum source, destination, schedule, reader, and state  |
| `THREADS_SEARCH_*`                     | No        | Threads queries, reader, polling interval, and state    |
| `X_POST_*`                             | No        | X feed source, destination, polling interval, and state |

See `.env.production.example` for production state paths and the complete
scheduled-monitor variable names.

The X monitor keeps the configurable primary pipe and also reposts
`@thsottiaux` to Discord channel `1515569479541854218` and
`@hololive_dreams` to channel `1290252977621176361`. Each additional pipe
stores an isolated checkpoint beside `X_POST_STATE_FILE` and validates its
destination guild independently.

The Threads search monitor reads the public Recent search pages through Jina
Reader, using `清大,NTHU,學生會` by default. Its managed service initially
reposts to channel `1543897041350950982`; the destination can be changed at
runtime through the existing service-subscription tool. The first successful
result set for each query becomes its checkpoint, so enabling the service does
not repost the existing search backlog.

## Workers

| Name                             | Required | Purpose                                                 |
| -------------------------------- | -------- | ------------------------------------------------------- |
| `MINISAGO_BRIDGE_URL`            | No       | Hosted WebSocket URL; plain `ws://` is local-only       |
| `MINISAGO_MCP_URL`               | No       | MCP endpoint; derived from the bridge origin by default |
| `MINISAGO_MAC_BRIDGE_SECRET`     | Yes      | Profile secret matching the hosted service              |
| `MINISAGO_MAC_FILE_ROOTS`        | No       | Colon-separated roots for owner Mac file requests       |
| `MINISAGO_CODEX_PATH`            | No       | Codex executable                                        |
| `MINISAGO_CODEX_HOME`            | No       | Isolated Codex state                                    |
| `MINISAGO_SESSION_MONITOR_PATH`  | Mac      | Compiled macOS lock monitor                             |
| `MINISAGO_TRACE_DATABASE_PATH`   | No       | Local response-trace database                           |
| `MINISAGO_WORKSPACE_ROOT`        | Dev      | Parent of disposable repository worktrees               |
| `MINISAGO_MAX_CONCURRENT_JOBS`   | No       | Capacity advertised to the bridge, from 1 to 16         |
| `MINISAGO_SANDBOX_URL`           | Linux    | Internal request-local computation broker URL           |
| `MINISAGO_HEADLESS`              | Linux    | Keep a worker connected without a session monitor       |
| `MINISAGO_WORKER_ID`             | No       | Stable worker identity                                  |
| `MINISAGO_CHATBOT_REPOSITORY`    | No       | Repository that owns chatbot behavior                   |
| `MINISAGO_CHATBOT_OWNER_USER_ID` | Yes      | Same owner ID as the hosted service                     |
| `MINISAGO_GITHUB_CONFIG_DIR`     | Dev      | Dedicated GitHub CLI state                              |
| `MINISAGO_GITHUB_WORKTREE_ROOT`  | No       | Disposable per-job checkout root                        |

Worker URLs must use TLS outside local or container-local hosts. Bridge secrets
must contain at least 32 bytes. The owner ID is validated as a Discord snowflake
on both sides.

The prompt harness has one production path rather than a runtime rollout flag.
Its authority layers and context budgets are versioned in code, covered by
tests, and rolled back through the corresponding atomic Git commit if needed.

Workers discover repositories from their dedicated GitHub CLI login at startup.
Set `MINISAGO_CHATBOT_REPOSITORY` when that login can access multiple repositories
so requests to change MiniSago itself do not rely on name inference.

## Persistent state

Production state must live under `/app/state` on the persistent
`sago_cloud_bot-core-state` volume. Configure:

- `GITHUB_PR_THREAD_STATE_FILE`
- `TOEFL_VOCAB_STATE_FILE`
- `GAMER_FORUM_STATE_FILE`
- `THREADS_SEARCH_STATE_FILE`
- `X_POST_STATE_FILE`
- `MINISAGO_REMINDER_STATE_FILE`
- `MINISAGO_GUILD_MEMORY_DIRECTORY`
- `MINISAGO_FEATURE_AVAILABILITY_FILE`
- `MINISAGO_SERVICE_SUBSCRIPTIONS_FILE`

Do not place these files on the container's ephemeral filesystem.

Server memory defaults to `.data/guild-memory` outside production. The
directory is an independent local-only Git repository with no configured
remote. Its files and Git history must never be committed to the application
repository. Each guild file is capped at 4,000 characters.

Feature availability defaults to `/app/state/feature-availability.json` in
production and `.data/feature-availability.json` elsewhere. On the first
change, MiniSago writes a complete policy initialized from the existing chatbot
environment lists and built-in behavior. After that, the file is the source of
truth. An owner can ask MiniSago to list, enable, disable, or restore inherited
availability for a feature in an exact server or channel. Channel rules
override server rules, and server rules override the feature default. The
scoped features are chatbot access, ambient reactions, and the trip
planner. Always-on capabilities do not appear in this policy.

Background-service subscriptions default to
`.data/service-subscriptions.json`. The initial destination list comes from the
existing Gamer Forum, X repost, Threads search, and TOEFL settings. After the owner changes a
subscription, the file becomes the source of truth. MiniSago can list the
services and their clickable Discord channel mentions, then subscribe or
unsubscribe an exact channel without a deployment. Running jobs read the list
on every scheduled check, so changes apply without restarting the service.

## Current deployment-specific defaults

The repository still contains these Hsi-specific defaults:

- configured-guild fallback `1282936453134815275`; and
- PR review repository and reviewer mapping for `sago-cream/health-check-system`.

Feature coverage and scheduled feed destinations no longer need source changes.
Feed sources, schedules, and checkpoint settings remain deployment
configuration. The PR review mapping remains deployment-specific code.
