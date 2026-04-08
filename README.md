# WM31Bot

WM31Bot is a serverless Discord bot for managing Wordle channel access through slash commands on Vercel.

## Use it

1. Install dependencies and create `.env.local`.
2. Set `DISCORD_APPLICATION_ID`, `DISCORD_PUBLIC_KEY`, and `DISCORD_BOT_TOKEN`.
3. Optionally set `DISCORD_GUILD_ID` and `SELF_ASSIGNABLE_ROLES`.
4. Publish the slash commands.
5. Run locally or deploy to Vercel, then point the Discord Interactions Endpoint URL at `/api/interactions`.

```bash
npm install
npm run register:commands
npm run dev
```

## Environment variables

| Name | Required | Description |
| --- | --- | --- |
| `DISCORD_APPLICATION_ID` | Yes | Discord application ID |
| `DISCORD_PUBLIC_KEY` | Yes | Public key used to verify interaction signatures |
| `DISCORD_BOT_TOKEN` | Yes | Bot token used for Discord REST role updates |
| `DISCORD_GUILD_ID` | No | Restricts the bot to a single guild. Defaults to `1282936453134815275` |
| `SELF_ASSIGNABLE_ROLES` | No | JSON array of managed role configs. Defaults to the Wordle role `1451976411152781466` |

Default `SELF_ASSIGNABLE_ROLES` value:

```json
[
  {
    "id": "1451976411152781466",
    "label": "Wordle Channel",
    "description": "Access to the Wordle channel",
    "emoji": "🟩"
  }
]
```
