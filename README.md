# WM31Bot

WM31Bot is a Vercel-compatible Discord bot for Wordle channel access. It does not rely on a persistent gateway connection. Instead, Discord sends slash-command interactions to a serverless endpoint, which makes it a good fit for Vercel.

## What it does

- Publishes `/join-wordle-channel` and `/leave-wordle-channel`.
- Adds or removes the Wordle access role with a single slash command.
- Restricts the bot to guild `1282936453134815275`.

## Why this works on Vercel

Traditional Discord bots keep a websocket connection open. Vercel functions are not built for that model. This project uses the Discord Interactions API instead:

- Discord sends requests to `/api/interactions`
- The app verifies the Ed25519 signature using your public key
- The app responds with interaction payloads and uses REST calls to update roles

## Local setup

1. Install dependencies.
2. Copy `.env.example` to `.env.local`.
3. Fill in the Discord application ID, public key, bot token, and optional overrides for the fixed guild and role configuration.
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
| `DISCORD_GUILD_ID` | No | Overrides the default guild restriction. Defaults to `1282936453134815275` |
| `SELF_ASSIGNABLE_ROLES` | No | Optional JSON role config. Defaults to the Wordle role `1451976411152781466` |

Default role config:

```json
[
  {
    "id": "123456789012345678",
    "id": "1451976411152781466",
    "label": "Wordle Channel",
    "description": "Access to the Wordle channel",
    "emoji": "🟩"
  }
]
```

## Discord application setup

1. Create a Discord application and add a bot user.
2. Invite the bot to your server with `Manage Roles` permission.
3. Move the bot role above role `1451976411152781466` in the server role hierarchy.
4. Deploy the app to Vercel.
5. In the Discord Developer Portal, set the Interactions Endpoint URL to `https://your-domain/api/interactions`.
6. Run `npm run register:commands` with your production environment variables to publish `/join-wordle-channel` and `/leave-wordle-channel`.

## Deploy to Vercel

1. Import the repository into Vercel.
2. Add the same environment variables from `.env.local` in the Vercel project settings.
3. Deploy.
4. Visit `/api/health` to confirm the app sees your environment configuration.

## Notes and limits

- The bot only manages the Wordle role by default.
- The bot must have a higher role than `1451976411152781466` to assign or remove it.
- The interaction response is ephemeral, so only the invoking user sees the result.
