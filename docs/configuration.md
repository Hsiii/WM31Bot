# Configuration

The checked-in environment examples are the mechanical source of truth:

- `.env.example` for local development and the Mac helper;
- `.env.production.example` for the hosted Discord service; and
- `.env.worker.example` for the headless Oracle worker.

Image and installer defaults live in `Dockerfile.worker` and
`scripts/mac-agent.mjs`. This reference explains each setting; setup procedures
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
| `MINISAGO_AMBIENT_REACTIONS_ENABLED`   | No        | Enable occasional ambient reactions                     |
| `MINISAGO_AMBIENT_ATTENTION_CHANCE`    | No        | Chance from 0 to 1 that a burst schedules evaluation    |
| `MINISAGO_AMBIENT_MAX_CHECKS_PER_HOUR` | No        | Hourly ambient model-call ceiling; defaults to 4        |
| `MINISAGO_REMINDER_STATE_FILE`         | No        | Persistent reminder state                               |
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
| `X_POST_*`                             | No        | X feed source, destination, polling interval, and state |

See `.env.production.example` for production state paths and the complete
scheduled-monitor variable names.

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
| `MINISAGO_HEADLESS`              | Linux    | Keep a worker connected without a session monitor       |
| `MINISAGO_WORKER_ID`             | No       | Stable worker identity                                  |
| `MINISAGO_GITHUB_REPOSITORIES`   | Dev      | Exact `owner/repository` allowlist                      |
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

Set `MINISAGO_CHATBOT_REPOSITORY` when a worker advertises multiple repositories
so requests to change MiniSago itself do not rely on name inference.

## Persistent state

Production state must live under `/app/state` on the persistent
`sago_cloud_bot-core-state` volume. Configure:

- `GITHUB_PR_THREAD_STATE_FILE`
- `TOEFL_VOCAB_STATE_FILE`
- `GAMER_FORUM_STATE_FILE`
- `X_POST_STATE_FILE`
- `MINISAGO_REMINDER_STATE_FILE`

Do not place these files on the container's ephemeral filesystem.

## Current deployment-specific defaults

The repository still contains these Hsi-specific boundaries:

- configured-guild fallback `1282936453134815275`; and
- PR review repository and reviewer mapping for `Hsiii/health-check-system`.

A general self-host must change these source-level defaults or disable the
corresponding features. Installing the bot in another guild does not expose
WM31 controls or scheduled feeds there.
