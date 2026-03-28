# WM31Bot

WM31Bot is a Vercel-compatible Discord bot for self-assignable roles. It does not rely on a persistent gateway connection. Instead, Discord sends slash-command and component interactions to a serverless endpoint, which makes it a good fit for Vercel.

## What it does

- Publishes a `/roles` slash command.
- Shows users an ephemeral multi-select menu with the roles you allow.
- Adds newly selected roles and removes managed roles that were unselected.
- Restricts the bot to one guild if `DISCORD_GUILD_ID` is set.

## Why this works on Vercel

Traditional Discord bots keep a websocket connection open. Vercel functions are not built for that model. This project uses the Discord Interactions API instead:

- Discord sends requests to `/api/interactions`
- The app verifies the Ed25519 signature using your public key
- The app responds with interaction payloads and uses REST calls to update roles

## Local setup

1. Install dependencies.
2. Copy `.env.example` to `.env.local`.
3. Fill in the Discord application ID, public key, bot token, optional guild ID, and the JSON array of self-assignable roles.
4. Run the slash-command registration script.
5. Start the app locally.

```bash
npm install
cp .env.example .env.local
npm run register:commands
npm run dev
```

## Environment variables

| Name | Required | Description |
| --- | --- | --- |
| `DISCORD_APPLICATION_ID` | Yes | Discord application ID |
| `DISCORD_PUBLIC_KEY` | Yes | Public key used to verify interaction signatures |
| `DISCORD_BOT_TOKEN` | Yes | Bot token used for Discord REST role updates |
| `DISCORD_GUILD_ID` | No | Restricts the bot to a single guild and registers faster guild-scoped commands |
| `SELF_ASSIGNABLE_ROLES` | Yes | JSON array of up to 25 allowed role definitions |

Example role config:

```json
[
  {
    "id": "123456789012345678",
    "label": "Announcements",
    "description": "Ping me for updates",
    "emoji": "📣"
  },
  {
    "id": "234567890123456789",
    "label": "Events",
    "description": "Community event notifications",
    "emoji": "🎉"
  }
]
```

## Discord application setup

1. Create a Discord application and add a bot user.
2. Invite the bot to your server with `Manage Roles` permission.
3. Move the bot role above every self-assignable role in the server role hierarchy.
4. Deploy the app to Vercel.
5. In the Discord Developer Portal, set the Interactions Endpoint URL to `https://your-domain/api/interactions`.
6. Run `npm run register:commands` with your production environment variables to publish `/roles`.

## Deploy to Vercel

1. Import the repository into Vercel.
2. Add the same environment variables from `.env.local` in the Vercel project settings.
3. Deploy.
4. Visit `/api/health` to confirm the app sees your environment configuration.

## Notes and limits

- Discord select menus support at most 25 roles.
- The bot only manages roles listed in `SELF_ASSIGNABLE_ROLES`.
- The bot must have a higher role than any role it should assign.
- The interaction response is ephemeral, so only the invoking user sees the role picker.