import {
  JOIN_WORDLE_CHANNEL_COMMAND_NAME,
  LEAVE_WORDLE_CHANNEL_COMMAND_NAME,
} from "@/lib/discord/constants";
import { getDiscordConfig, getWordleRole } from "@/lib/discord/env";
import {
  applyManagedRoleSelection,
  formatRoleMemberSummary,
  getManagedRolesById,
  getRoleMemberSummary,
} from "@/lib/discord/roles";
import { verifyDiscordRequest } from "@/lib/discord/verify";

export const runtime = "nodejs";

const EPHEMERAL_FLAG = 64;

type DiscordInteraction = {
  type: number;
  guild_id?: string;
  data?: {
    name?: string;
    custom_id?: string;
    values?: string[];
  };
  member?: {
    roles?: string[];
    user?: {
      id: string;
    };
  };
  user?: {
    id: string;
  };
};

function jsonResponse(body: unknown, status = 200) {
  return Response.json(body, { status });
}

function getUserId(interaction: DiscordInteraction) {
  return interaction.member?.user?.id ?? interaction.user?.id;
}

function getMemberRoleIds(interaction: DiscordInteraction) {
  return interaction.member?.roles ?? [];
}

function isGuildAllowed(guildId: string | undefined, allowedGuildId: string | undefined) {
  if (!allowedGuildId) {
    return true;
  }

  return guildId === allowedGuildId;
}

export async function POST(request: Request) {
  const signature = request.headers.get("x-signature-ed25519");
  const timestamp = request.headers.get("x-signature-timestamp");
  const rawBody = await request.text();

  if (!signature || !timestamp) {
    return new Response("Missing Discord signature headers", { status: 401 });
  }

  let config;

  try {
    config = getDiscordConfig();
  } catch (error) {
    return new Response(
      error instanceof Error ? error.message : "Discord bot configuration is invalid",
      { status: 500 },
    );
  }

  const isValid = verifyDiscordRequest({
    body: rawBody,
    signature,
    timestamp,
    publicKey: config.publicKey,
  });

  if (!isValid) {
    return new Response("Invalid request signature", { status: 401 });
  }

  const interaction = JSON.parse(rawBody) as DiscordInteraction;
  const commandName = interaction.data?.name;

  if (interaction.type === 1) {
    return jsonResponse({ type: 1 });
  }

  if (!isGuildAllowed(interaction.guild_id, config.guildId)) {
    return jsonResponse({
      type: 4,
      data: {
        flags: 64,
        content: "This bot is restricted to a different Discord server.",
      },
    });
  }

  const userId = getUserId(interaction);

  if (
    commandName !== JOIN_WORDLE_CHANNEL_COMMAND_NAME &&
    commandName !== LEAVE_WORDLE_CHANNEL_COMMAND_NAME
  ) {
    return jsonResponse({
      type: 4,
      data: {
        flags: 64,
        content: "Unsupported interaction type.",
      },
    });
  }

  if (!interaction.guild_id || !userId) {
    return jsonResponse({
      type: 4,
      data: {
        flags: 64,
        content: "Guild member details were missing from the interaction payload.",
      },
    });
  }

  const wordleRole = getWordleRole(config.managedRoles);
  const currentRoleIds = getMemberRoleIds(interaction);
  const managedRolesById = getManagedRolesById([wordleRole]);
  const selectedRoleIds =
    commandName === JOIN_WORDLE_CHANNEL_COMMAND_NAME ? [wordleRole.id] : [];

  try {
    const result = await applyManagedRoleSelection({
      guildId: interaction.guild_id,
      userId,
      botToken: config.botToken,
      currentRoleIds,
      selectedRoleIds,
      managedRolesById,
    });

    let message = result.message;

    if (commandName === JOIN_WORDLE_CHANNEL_COMMAND_NAME) {
      const summary = await getRoleMemberSummary({
        guildId: interaction.guild_id,
        roleId: wordleRole.id,
        botToken: config.botToken,
      });

      message = `${message}\n\n${formatRoleMemberSummary({
        roleLabel: wordleRole.label,
        memberIds: summary.memberIds,
        totalCount: summary.totalCount,
        usedFallbackCount: summary.usedFallbackCount,
      })}`;
    }

    return jsonResponse(buildRoleCommandResponse(message));
  } catch (error) {
    return jsonResponse(
      buildRoleCommandResponse(error instanceof Error ? `Could not update roles: ${error.message}` : "Could not update roles."),
    );
  }
}

function buildRoleCommandResponse(message: string) {
  return {
    type: 4,
    data: {
      flags: EPHEMERAL_FLAG,
      content: message,
    },
  };
}
