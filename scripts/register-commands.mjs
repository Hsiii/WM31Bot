const applicationId = process.env.DISCORD_APPLICATION_ID;
const botToken = process.env.DISCORD_BOT_TOKEN;
const guildId = process.env.DISCORD_GUILD_ID;

if (!applicationId || !botToken) {
  console.error("DISCORD_APPLICATION_ID and DISCORD_BOT_TOKEN are required.");
  process.exit(1);
}

const url = guildId
  ? `https://discord.com/api/v10/applications/${applicationId}/guilds/${guildId}/commands`
  : `https://discord.com/api/v10/applications/${applicationId}/commands`;

const commands = [
  {
    name: "join-wordle-channel",
    description: "Grant the Wordle channel access role",
    dm_permission: false,
  },
  {
    name: "leave-wordle-channel",
    description: "Remove the Wordle channel access role",
    dm_permission: false,
  },
];

const response = await fetch(url, {
  method: "PUT",
  headers: {
    Authorization: `Bot ${botToken}`,
    "Content-Type": "application/json",
  },
  body: JSON.stringify(commands),
});

if (!response.ok) {
  console.error(await response.text());
  process.exit(1);
}

const result = await response.json();
console.log(`Registered ${result.length} command(s) ${guildId ? `for guild ${guildId}` : "globally"}.`);
