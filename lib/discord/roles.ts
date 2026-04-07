import { TARGET_GUILD_ID, WORDLE_ROLE_ID } from "@/lib/discord/constants";
import type { ManagedRole } from "@/lib/discord/env";

type ApplyManagedRoleSelectionArgs = {
  guildId: string;
  userId: string;
  botToken: string;
  currentRoleIds: string[];
  selectedRoleIds: string[];
  managedRolesById: Map<string, ManagedRole>;
};

type DiscordApiErrorBody = {
  code?: number;
  message?: string;
};

function parseDiscordApiError(body: string): DiscordApiErrorBody | null {
  try {
    return JSON.parse(body) as DiscordApiErrorBody;
  } catch {
    return null;
  }
}

function getDiscordRoleErrorMessage(status: number, responseBody: string) {
  const parsedBody = parseDiscordApiError(responseBody);

  if (status === 404 && parsedBody?.code === 10004) {
    return "The bot user cannot access this server. Invite the bot with both the bot and applications.commands scopes, and verify DISCORD_BOT_TOKEN belongs to the same Discord application handling interactions.";
  }

  if (status === 403 && parsedBody?.code === 50001) {
    return "The bot does not have access to update roles in this server. Check that the bot is installed in the server and that the production token matches this application.";
  }

  if (status === 403 && parsedBody?.code === 50013) {
    return `Discord denied the role update in guild ${TARGET_GUILD_ID}. Ensure the bot has the Manage Roles permission and that its highest role is above role ${WORDLE_ROLE_ID} in the server role hierarchy.`;
  }

  return `${status}${parsedBody?.message ? ` ${parsedBody.message}` : ""}${responseBody ? `: ${responseBody}` : ""}`;
}

async function discordRoleRequest(url: string, botToken: string, method: "PUT" | "DELETE") {
  const response = await fetch(url, {
    method,
    headers: {
      Authorization: `Bot ${botToken}`,
    },
  });

  if (response.ok) {
    return;
  }

  const body = await response.text();
  throw new Error(getDiscordRoleErrorMessage(response.status, body));
}

function mentionRoles(roleIds: string[]) {
  return roleIds.map((roleId) => `<@&${roleId}>`).join(", ");
}

export function getManagedRolesById(managedRoles: ManagedRole[]) {
  return new Map(managedRoles.map((role) => [role.id, role]));
}

export async function applyManagedRoleSelection({
  guildId,
  userId,
  botToken,
  currentRoleIds,
  selectedRoleIds,
  managedRolesById,
}: ApplyManagedRoleSelectionArgs) {
  const managedRoleIds = [...managedRolesById.keys()];
  const invalidRoleId = selectedRoleIds.find((roleId) => !managedRolesById.has(roleId));

  if (invalidRoleId) {
    throw new Error(`Role ${invalidRoleId} is not managed by this bot`);
  }

  const currentRoleIdSet = new Set(currentRoleIds);
  const selectedRoleIdSet = new Set(selectedRoleIds);
  const rolesToAdd = [...selectedRoleIdSet].filter((roleId) => !currentRoleIdSet.has(roleId));
  const rolesToRemove = managedRoleIds.filter(
    (roleId) => currentRoleIdSet.has(roleId) && !selectedRoleIdSet.has(roleId),
  );

  const baseUrl = `https://discord.com/api/v10/guilds/${guildId}/members/${userId}/roles`;

  await Promise.all([
    ...rolesToAdd.map((roleId) => discordRoleRequest(`${baseUrl}/${roleId}`, botToken, "PUT")),
    ...rolesToRemove.map((roleId) => discordRoleRequest(`${baseUrl}/${roleId}`, botToken, "DELETE")),
  ]);

  const nextRoleIds = [
    ...currentRoleIds.filter((roleId) => !rolesToRemove.includes(roleId)),
    ...rolesToAdd.filter((roleId) => !currentRoleIdSet.has(roleId)),
  ];

  let message = "No changes were needed. Your managed roles already matched the selection.";

  if (rolesToAdd.length > 0 || rolesToRemove.length > 0) {
    const fragments = [];

    if (rolesToAdd.length > 0) {
      fragments.push(`Added ${mentionRoles(rolesToAdd)}`);
    }

    if (rolesToRemove.length > 0) {
      fragments.push(`Removed ${mentionRoles(rolesToRemove)}`);
    }

    message = `${fragments.join(". ")}.`;
  }

  return {
    nextRoleIds,
    message,
  };
}
