import {
  COMMAND_NAME,
  CLEAR_ROLES_CUSTOM_ID,
  ROLE_SELECT_CUSTOM_ID,
} from "@/lib/discord/constants";
import { getDiscordConfig } from "@/lib/discord/env";
import { buildRolePickerResponse, buildRoleUpdateResponse } from "@/lib/discord/messages";
import { applyManagedRoleSelection, getManagedRolesById } from "@/lib/discord/roles";
import { verifyDiscordRequest } from "@/lib/discord/verify";

export const runtime = "nodejs";

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

  if (interaction.type === 2 && interaction.data?.name === COMMAND_NAME) {
    return jsonResponse(buildRolePickerResponse(config.managedRoles, getMemberRoleIds(interaction)));
  }

  if (interaction.type !== 3 || !interaction.data?.custom_id) {
    return jsonResponse({
      type: 4,
      data: {
        flags: 64,
        content: "Unsupported interaction type.",
      },
    });
  }

  const userId = getUserId(interaction);

  if (!interaction.guild_id || !userId) {
    return jsonResponse({
      type: 4,
      data: {
        flags: 64,
        content: "Guild member details were missing from the interaction payload.",
      },
    });
  }

  const managedRolesById = getManagedRolesById(config.managedRoles);
  const customId = interaction.data.custom_id;
  const selectedRoleIds = customId === CLEAR_ROLES_CUSTOM_ID ? [] : interaction.data.values ?? [];

  if (customId !== ROLE_SELECT_CUSTOM_ID && customId !== CLEAR_ROLES_CUSTOM_ID) {
    return jsonResponse({
      type: 4,
      data: {
        flags: 64,
        content: "Unknown component interaction.",
      },
    });
  }

  const currentRoleIds = getMemberRoleIds(interaction);

  try {
    const result = await applyManagedRoleSelection({
      guildId: interaction.guild_id,
      userId,
      botToken: config.botToken,
      currentRoleIds,
      selectedRoleIds,
      managedRolesById,
    });

    return jsonResponse(
      buildRoleUpdateResponse({
        managedRoles: config.managedRoles,
        currentRoleIds: result.nextRoleIds,
        message: result.message,
      }),
    );
  } catch (error) {
    return jsonResponse({
      type: 7,
      data: {
        content:
          error instanceof Error
            ? `Could not update roles: ${error.message}`
            : "Could not update roles.",
        components: buildRoleUpdateResponse({
          managedRoles: config.managedRoles,
          currentRoleIds,
          message: "Try again after checking the bot permissions and role hierarchy.",
        }).data.components,
      },
    });
  }
}