# Operations

This runbook covers deployment, verification, logs, recovery, and removal.
Initial Discord and worker installation live in [Discord setup](discord-setup.md)
and [Workers](workers.md).

## Runtime endpoints

| Endpoint                   | Purpose                                                  |
| -------------------------- | -------------------------------------------------------- |
| `GET /api/health`          | Configuration, aggregate worker capacity, and Mac status |
| `GET /api/mac-agent/ws`    | Authenticated worker WebSocket                           |
| `POST /api/chatbot/mcp`    | Bearer-bound MCP requests from active answer jobs        |
| `POST /api/github/webhook` | Verified GitHub pull-request events                      |

Expose the HTTP routes through HTTPS and preserve WebSocket upgrade headers for
`/api/mac-agent/ws`. The worker WebSocket returns `404` when no bridge secret is
configured.

## Local operation

Install and start the hosted service:

```bash
bun install
bun run dev
```

Use `DISCORD_GATEWAY_DISABLED=true` whenever another deployment already owns
the bot token. Install workers using the dedicated setup guides.

Before committing changes, run:

```bash
bun run build
bun run --cwd mac-agent build
bun test
bun run format:check
```

## Container images

Every push to `main` publishes the core and worker images with moving `main`
tags and immutable `sha-<commit>` tags:

```text
ghcr.io/sago-cream/minisago
ghcr.io/sago-cream/minisago-worker
```

For a general self-host, run the core image with the hosted-service variables,
persist `/app/state`, expose port `3000` through an HTTPS reverse proxy, and run
at least one separately authenticated worker. Replace the
`bot.hsichen.dev` examples with the deployment's public origin.

## Sago Cloud deployment

Production changes flow through `main`. The deployment command requires a clean
local `main` exactly matching `origin/main`:

```bash
bun run deploy
```

The script waits for both images, then asks the operations checkout at
`/srv/sago-cloud/operations` to deploy core and worker as one release. It
connects through the local `sago-cloud` SSH alias over Tailscale and retries
connection timeouts three times. Use `SAGO_CLOUD_HOST` only for a replacement
host.

The VM pulls published images rather than cloning this repository. Production
secrets live under `/srv/sago-cloud/secrets`. Only the core container joins
`sago_cloud_edge` under the `bot-core` alias. The following remain in external
persistent volumes:

- bot monitor, reminder, and webhook state;
- worker Codex and GitHub CLI state;
- worker traces; and
- disposable repository/worktree storage.

## Verification

After deployment:

```bash
curl https://bot.hsichen.dev/api/health
```

A healthy response has `ok: true`, required configuration flags set, and at
least one available worker. `mac: offline` is normal while the Mac is locked,
asleep, disconnected, or not running.

Also verify the relevant behavior after risky changes:

- mention MiniSago in an authorized channel;
- confirm an owner development request routes to an advertised repository;
- confirm worker logs show protocol authentication rather than reconnect loops;
- deliver a GitHub webhook and ensure it reuses the mapped thread; and
- check scheduled state files remain under `/app/state`.

## Logs and traces

Core logs cover Gateway lifecycle, monitors, webhooks, worker connections, and
request failures. Worker logs intentionally contain metadata only.

Mac logs and traces live under:

```text
~/Library/Application Support/MiniSago/logs
~/Library/Application Support/MiniSago/traces.sqlite
```

Oracle stores equivalent state in its persistent worker volume. Traces expire
after 14 days and prune above 250 MB. See [Security](security.md#retention-and-privacy)
for their contents and exclusions.

## Common recovery procedures

### Worker unavailable

1. Check `/api/health` for connected, available, capacity, active, and Mac
   status.
2. Inspect worker logs for authentication, protocol-version, Codex-login, or
   reconnect failures.
3. Verify the worker and hosted service use the matching profile secret.
4. Confirm Codex authentication and account capacity.
5. Restart only the affected worker after correcting configuration.

Requests received while every compatible worker is unavailable are not queued;
ask the requester to retry.

### Mac helper unavailable

```bash
bun run mac-agent:status
bun run mac-agent:install
```

Confirm the session is unlocked, the bridge URL is reachable, and the edge
preserves WebSocket upgrades. Reinstalling refreshes the compiled session
monitor and LaunchAgent configuration.

### Oracle worker unavailable

```bash
docker compose -f compose.worker.yaml logs -f worker
docker compose -f compose.worker.yaml exec worker codex login status
docker compose -f compose.worker.yaml exec worker gh auth status
docker compose -f compose.worker.yaml up -d --force-recreate
```

Confirm persistent volumes are mounted and outbound HTTPS/WSS works. The worker
must not expose a public port.

### Gateway rejected

- Code `4004`: verify `DISCORD_BOT_TOKEN`.
- Code `4013`: inspect requested Gateway intents.
- Code `4014`: enable the Message Content privileged intent.
- Duplicate or transformed messages: verify only one Gateway deployment owns
  the bot token and remove retired webhooks.

### Deployment connection failure

Confirm `ssh sago-cloud` works and rerun `bun run deploy`. Do not bypass the
clean-main or image-success checks.

## Credential rotation

Rotate one boundary at a time:

1. Generate a new independent 32-byte-or-longer secret.
2. Update the hosted and matching worker configuration.
3. Restart that profile and confirm it authenticates.
4. Remove the old secret.

For GitHub credentials, authenticate the dedicated CLI state over standard
input, verify `gh auth status`, then revoke the old credential. Never copy
tokens into environment files or task text.

## Removal

Remove the Mac helper and all of its isolated state with:

```bash
bun run mac-agent:uninstall
```

This removes its secret, compiled monitor, logs, traces, and isolated GitHub
login without changing normal `~/.codex` or `~/.config/gh` state.

For a full deployment removal, stop core and worker containers, remove the
GitHub webhook, then deliberately archive or delete persistent state and
credentials according to the operator's retention requirements.
