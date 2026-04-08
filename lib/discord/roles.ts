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

type DiscordGuildMember = {
  roles?: string[];
  user?: {
    id?: string;
  };
};

type RoleMemberSummary = {
  memberIds: string[];
  totalCount: number;
  usedFallbackCount: boolean;
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

async function discordApiRequest(url: string, botToken: string, method = "GET"): Promise<Response> {
  const response = await fetch(url, {
    method,
    headers: {
      Authorization: `Bot ${botToken}`,
    },
  });

  if (response.ok) {
    return response;
  }

  const body = await response.text();
  throw new Error(getDiscordRoleErrorMessage(response.status, body));
}

async function discordRoleRequest(url: string, botToken: string, method: "PUT" | "DELETE") {
  await discordApiRequest(url, botToken, method);
}

function mentionRoles(roleIds: string[]) {
  return roleIds.map((roleId) => `<@&${roleId}>`).join(", ");
}

export function getManagedRolesById(managedRoles: ManagedRole[]) {
  return new Map(managedRoles.map((role) => [role.id, role]));
}

export function formatRoleMemberSummary({
  roleLabel,
  memberIds,
  totalCount,
  usedFallbackCount,
}: {
  roleLabel: string;
  memberIds: string[];
  totalCount: number;
  usedFallbackCount: boolean;
}) {
  if (totalCount === 0) {
    return `Current ${roleLabel} members: none.`;
  }

  if (usedFallbackCount || memberIds.length === 0) {
    return `Current ${roleLabel} members: ${totalCount}.`;
  }

  const lines = [`Current ${roleLabel} members (${totalCount}):`];
  let visibleCount = 0;

  for (const memberId of memberIds) {
    const mention = `<@${memberId}>`;
    const candidate = `${lines.join("\n")}\n${mention}`;

    if (candidate.length > 1800) {
      break;
    }

    lines.push(mention);
    visibleCount += 1;
  }

  if (visibleCount < totalCount) {
    lines.push(`...and ${totalCount - visibleCount} more.`);
  }

  return lines.join("\n");
}

export async function getRoleMemberSummary({
  guildId,
  roleId,
  botToken,
}: {
  guildId: string;
  roleId: string;
  botToken: string;
}): Promise<RoleMemberSummary> {
  const memberIds: string[] = [];
  let after = "0";

  try {
    while (true) {
      const response = await discordApiRequest(
        `https://discord.com/api/v10/guilds/${guildId}/members?limit=1000&after=${after}`,
        botToken,
      );
      const page = (await response.json()) as DiscordGuildMember[];

      if (page.length === 0) {
        break;
      }

      for (const member of page) {
        const memberId = member.user?.id;

        if (!memberId) {
          continue;
        }

        if (member.roles?.includes(roleId)) {
          memberIds.push(memberId);
        }
      }

      after = page[page.length - 1]?.user?.id ?? after;

      if (page.length < 1000) {
        break;
      }
    }

    return {
      memberIds,
      totalCount: memberIds.length,
      usedFallbackCount: false,
    };
  } catch {
    const response = await discordApiRequest(
      `https://discord.com/api/v10/guilds/${guildId}/roles/member-counts`,
      botToken,
    );
    const roleCounts = (await response.json()) as Record<string, number>;

    return {
      memberIds: [],
      totalCount: roleCounts[roleId] ?? 0,
      usedFallbackCount: true,
    };
  }
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
