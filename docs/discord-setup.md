# Discord Setup

This guide configures the Discord application, Gateway, interactions, commands,
and permissions. Configure workers separately using [Workers](workers.md).

## Create and configure the application

1. Create a Discord application and bot.
2. Enable **Bot → Privileged Gateway Intents → Message Content**. Without it,
   Discord closes the Gateway with code `4014` and message features cannot read
   content.
3. Set **Installation → Install Link** to **Discord Provided Link**.
4. Copy `.env.example` to `.env.local` and provide the application ID, public
   key, bot token, owner ID, and intended guild/channel access.
5. Run `bun run sync:install` to update the application's Default Install
   Settings.
6. Point the Interactions Endpoint URL to
   `<public-origin>/api/interactions`. Production uses
   `https://bot.hsichen.dev/api/interactions`.

Install with the `bot` and `applications.commands` scopes. Application defaults
affect new installs only; update existing bot roles and channel overrides
manually.

## Permissions

The synchronized permission bitfield is `9122780097600`:

- Add Reactions
- View Channels
- Send Messages
- Manage Messages
- Read Message History
- Connect
- Manage Roles
- Manage Threads
- Create Public Threads
- Send Messages in Threads
- Create Expressions

Manage Roles is needed only for configured-guild channel access. The bot's
highest role must remain above every self-assignable role. Manage Messages pins
PR review requests; thread permissions support review discussions. Add
Reactions supports answer and ambient reactions. Connect supports `/join-vc`.
Create Expressions is needed in every destination guild where the owner may
copy emoji. MiniSago does not need Manage Webhooks.

## Commands and channel panel

Register commands against the configured guild:

```bash
bun run register:commands
```

The runtime rejects configured-guild commands elsewhere even if Discord has a
stale global registration.

Publish or refresh the optional-channel panel with:

```bash
bun run publish:panel -- <channel-id>
```

The panel and role commands operate only in `DISCORD_GUILD_ID` and only on the
configured managed roles.

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
