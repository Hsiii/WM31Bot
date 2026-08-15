const applicationId = process.env.DISCORD_APPLICATION_ID;
const botToken = process.env.DISCORD_BOT_TOKEN;
const guildId = process.env.DISCORD_GUILD_ID?.trim();

if (!applicationId || !botToken) {
  console.error("DISCORD_APPLICATION_ID and DISCORD_BOT_TOKEN are required.");
  process.exit(1);
}

const DISCORD_API_BASE_URL = "https://discord.com/api/v10";
const GUILD_INSTALL = "0";

const requiredGuildPermissionFlags = [
  ["ADD_REACTIONS", 1n << 6n],
  ["VIEW_CHANNEL", 1n << 10n],
  ["SEND_MESSAGES", 1n << 11n],
  ["MANAGE_MESSAGES", 1n << 13n],
  ["EMBED_LINKS", 1n << 14n],
  ["READ_MESSAGE_HISTORY", 1n << 16n],
  ["CONNECT", 1n << 20n],
  ["MANAGE_WEBHOOKS", 1n << 29n],
  ["MANAGE_THREADS", 1n << 34n],
  ["CREATE_PUBLIC_THREADS", 1n << 35n],
  ["SEND_MESSAGES_IN_THREADS", 1n << 38n],
  ["CREATE_GUILD_EXPRESSIONS", 1n << 43n],
];

const guildInstallScopes = ["bot"];
const guildInstallPermissions = requiredGuildPermissionFlags
  .reduce((permissions, [, flag]) => permissions | flag, 0n)
  .toString();

async function discordApi(path, options = {}) {
  const response = await fetch(`${DISCORD_API_BASE_URL}${path}`, {
    ...options,
    headers: {
      Authorization: `Bot ${botToken}`,
      "Content-Type": "application/json",
      ...options.headers,
    },
  });

  if (response.ok) {
    return response;
  }

  const body = await response.text();
  throw new Error(`${response.status} ${response.statusText}: ${body}`);
}

const currentApplicationResponse = await discordApi("/applications/@me");
const currentApplication = await currentApplicationResponse.json();

if (currentApplication.id !== applicationId) {
  throw new Error(
    `DISCORD_APPLICATION_ID (${applicationId}) does not match the application for DISCORD_BOT_TOKEN (${currentApplication.id}).`,
  );
}

const integrationTypesConfig = {
  ...(currentApplication.integration_types_config ?? {}),
  [GUILD_INSTALL]: {
    ...(currentApplication.integration_types_config?.[GUILD_INSTALL] ?? {}),
    oauth2_install_params: {
      scopes: guildInstallScopes,
      permissions: guildInstallPermissions,
    },
  },
};

await discordApi("/applications/@me", {
  method: "PATCH",
  body: JSON.stringify({
    install_params: {
      scopes: guildInstallScopes,
      permissions: guildInstallPermissions,
    },
    integration_types_config: integrationTypesConfig,
  }),
});

const commandPaths = [
  `/applications/${applicationId}/commands`,
  ...(guildId
    ? [`/applications/${applicationId}/guilds/${guildId}/commands`]
    : []),
];

await Promise.all(
  commandPaths.map((path) =>
    discordApi(path, {
      method: "PUT",
      body: "[]",
    }),
  ),
);

const permissionNames = requiredGuildPermissionFlags
  .map(([name]) => name)
  .join(", ");
const inviteUrl = new URL("https://discord.com/oauth2/authorize");
inviteUrl.searchParams.set("client_id", applicationId);
inviteUrl.searchParams.set("scope", guildInstallScopes.join(" "));
inviteUrl.searchParams.set("permissions", guildInstallPermissions);
inviteUrl.searchParams.set("integration_type", GUILD_INSTALL);

console.log("Updated Discord Guild Install default settings.");
console.log(
  `Cleared slash commands globally${guildId ? ` and for guild ${guildId}` : ""}.`,
);
console.log(`Scopes: ${guildInstallScopes.join(", ")}`);
console.log(`Permissions: ${guildInstallPermissions} (${permissionNames})`);
console.log(`Direct guild install URL: ${inviteUrl.toString()}`);
