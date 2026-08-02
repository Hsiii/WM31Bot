# Discord Setup

This guide configures the Discord application, Gateway, and permissions.
Configure workers separately using [Workers](workers.md).

## Create and configure the application

1. Create a Discord application and bot.
2. Enable **Bot → Privileged Gateway Intents → Message Content**. Without it,
   Discord closes the Gateway with code `4014` and message features cannot read
   content.
3. Set **Installation → Install Link** to **Discord Provided Link**.
4. Copy `.env.example` to `.env.local` and provide the application ID, bot
   token, owner ID, and intended guild/channel access.
5. Run `bun run sync:install` to update the application's Default Install
   Settings and clear any stale global or configured-guild slash commands.
   Install with the `bot` scope. Application defaults affect new installs only;
   update existing bot roles and channel overrides manually.

## Permissions

The synchronized permission bitfield is `9122511662144`:

- Add Reactions
- View Channels
- Send Messages
- Manage Messages
- Read Message History
- Connect
- Manage Threads
- Create Public Threads
- Send Messages in Threads
- Create Expressions

Manage Messages pins PR review requests; thread permissions support review
discussions. Add Reactions supports answer and ambient reactions. Connect lets
the host-bound MCP tools join and leave voice channels. Create Expressions is
needed in every destination guild where the owner may add emoji. MiniSago does
not need Manage Webhooks.

## Gateway ownership

Run only one Gateway-enabled deployment per bot token. Set
`DISCORD_GATEWAY_DISABLED=true` on temporary or HTTP-only instances while
production is connected.

If Instagram messages are deleted or reappear under a user's display name,
stop the retired webhook-based deployment and remove its webhook under
**Server Settings → Integrations → Webhooks**.

## GitHub review webhook

In the configured repository under **Settings → Webhooks**, create:

- Payload URL: `<public-origin>/api/github/webhook`
- Content type: `application/json`
- Secret: `GITHUB_WEBHOOK_SECRET`
- Events: **Pull requests** only

Production posts to the `專案討論` channel `1521506395034226830` in guild
`1521168712579682567`. MiniSago needs view, send, history, public-thread,
thread-send, and thread-management permission there. Persist the mapping state
so repeated deliveries reuse the same thread and closed pull requests archive
the correct discussion.
