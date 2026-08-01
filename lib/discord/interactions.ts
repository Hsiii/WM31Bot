import {
  JOIN_BRAWL_STARS_CHANNEL_COMMAND_NAME,
  JOIN_VC_COMMAND_NAME,
  JOIN_WORDLE_CHANNEL_COMMAND_NAME,
  LEAVE_BRAWL_STARS_CHANNEL_COMMAND_NAME,
  LEAVE_VC_COMMAND_NAME,
  LEAVE_WORDLE_CHANNEL_COMMAND_NAME,
} from "./constants";
import { createDiscordRequest } from "./chatbot";
import { getBrawlStarsRole, getDiscordConfig, getWordleRole } from "./env";
import {
  buildChannelAccessPanel,
  isChannelAccessSelect,
  type ChannelAccessRoleCounts,
  parseChannelAccessButton,
} from "./panel";
import {
  applyManagedRoleSelection,
  formatRoleMemberSummary,
  getManagedRolesById,
  getRoleMemberSummary,
} from "./roles";
import { verifyDiscordRequest } from "./verify";
import { joinMemberVoiceChannel, leaveVoiceChannel } from "./voice";

type DiscordInteraction = {
  type: number;
  guild_id?: string;
  data?: {
    component_type?: number;
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

function isGuildAllowed(
  guildId: string | undefined,
  allowedGuildId: string | undefined,
) {
  if (!allowedGuildId) {
    return true;
  }

  return guildId === allowedGuildId;
}

function buildEphemeralResponse(message: string) {
  return {
    type: 4,
    data: {
      flags: 64,
      content: message,
    },
  };
}

function buildPanelUpdateResponse(
  roles: ReturnType<typeof getDiscordConfig>["managedRoles"],
  counts: ChannelAccessRoleCounts,
) {
  return {
    type: 7,
    data: buildChannelAccessPanel(roles, counts),
  };
}

async function buildRoleMemberSummaryMessage({
  guildId,
  roleId,
  roleLabel,
  botToken,
}: {
  guildId: string;
  roleId: string;
  roleLabel: string;
  botToken: string;
}) {
  const summary = await getRoleMemberSummary({
    guildId,
    roleId,
    botToken,
  });

  return formatRoleMemberSummary({
    roleLabel,
    memberIds: summary.memberIds,
    totalCount: summary.totalCount,
    usedFallbackCount: summary.usedFallbackCount,
  });
}

async function getPanelRoleCounts({
  guildId,
  botToken,
  roles,
}: {
  guildId: string;
  botToken: string;
  roles: ReturnType<typeof getDiscordConfig>["managedRoles"];
}) {
  const entries = await Promise.all(
    roles.map(async (role) => {
      const summary = await getRoleMemberSummary({
        guildId,
        roleId: role.id,
        botToken,
      });

      return [role.id, summary.totalCount] as const;
    }),
  );

  return Object.fromEntries(entries);
}

async function handleChannelAccessComponent({
  customId,
  selectedRoleIds,
  config,
  guildId,
  userId,
  currentRoleIds,
}: {
  customId: string | undefined;
  selectedRoleIds: string[];
  config: ReturnType<typeof getDiscordConfig>;
  guildId: string;
  userId: string;
  currentRoleIds: string[];
}) {
  const buttonAction = parseChannelAccessButton(customId);

  if (buttonAction) {
    const role = config.managedRoles.find(
      (managedRole) => managedRole.id === buttonAction.roleId,
    );

    if (!role) {
      return buildEphemeralResponse(
        "這個頻道選項已經失效了 請使用最新的頻道選單",
      );
    }

    await applyManagedRoleSelection({
      guildId,
      userId,
      botToken: config.botToken,
      currentRoleIds,
      selectedRoleIds: buttonAction.action === "join" ? [role.id] : [],
      managedRolesById: getManagedRolesById([role]),
    });

    try {
      const counts = await getPanelRoleCounts({
        guildId,
        botToken: config.botToken,
        roles: config.managedRoles,
      });

      return buildPanelUpdateResponse(config.managedRoles, counts);
    } catch (error) {
      console.error("Failed to refresh channel access counts:", error);
      return buildEphemeralResponse(ROLE_UPDATED_WITHOUT_COUNTS_MESSAGE);
    }
  }

  if (isChannelAccessSelect(customId)) {
    await applyManagedRoleSelection({
      guildId,
      userId,
      botToken: config.botToken,
      currentRoleIds,
      selectedRoleIds,
      managedRolesById: getManagedRolesById(config.managedRoles),
    });

    try {
      const counts = await getPanelRoleCounts({
        guildId,
        botToken: config.botToken,
        roles: config.managedRoles,
      });

      return buildPanelUpdateResponse(config.managedRoles, counts);
    } catch (error) {
      console.error("Failed to refresh channel access counts:", error);
      return buildEphemeralResponse(ROLE_UPDATED_WITHOUT_COUNTS_MESSAGE);
    }
  }

  return null;
}

function buildRoleCommandResponse(message: string) {
  return {
    type: 4,
    data: {
      content: message,
    },
  };
}

const ROLE_UPDATE_ERROR_MESSAGE = "我現在沒辦法更新頻道權限 晚點再試一次";

const ROLE_UPDATED_WITHOUT_COUNTS_MESSAGE =
  "頻道權限更新成功 但成員人數剛剛卡住了";

function logRoleUpdateError(error: unknown) {
  console.error("Failed to update Discord channel access:", error);
}

export async function handleDiscordInteractionRequest(request: Request) {
  const signature = request.headers.get("x-signature-ed25519");
  const timestamp = request.headers.get("x-signature-timestamp");
  const rawBody = await request.text();

  if (!signature || !timestamp) {
    return new Response("缺少 Discord 簽章標頭", { status: 401 });
  }

  let config;

  try {
    config = getDiscordConfig();
  } catch (error) {
    console.error("Invalid Discord bot configuration:", error);
    return new Response("Discord 機器人目前無法使用", { status: 500 });
  }

  const isValid = verifyDiscordRequest({
    body: rawBody,
    signature,
    timestamp,
    publicKey: config.publicKey,
  });

  if (!isValid) {
    return new Response("Discord 請求簽章無效", { status: 401 });
  }

  let interaction: DiscordInteraction;

  try {
    interaction = JSON.parse(rawBody) as DiscordInteraction;
  } catch (error) {
    console.error("Invalid Discord interaction payload:", error);
    return new Response("Discord 請求格式無效", { status: 400 });
  }
  const commandName = interaction.data?.name;
  const customId = interaction.data?.custom_id;

  if (interaction.type === 1) {
    return jsonResponse({ type: 1 });
  }

  const userId = getUserId(interaction);
  if (!isGuildAllowed(interaction.guild_id, config.guildId)) {
    return jsonResponse({
      type: 4,
      data: {
        flags: 64,
        content: "我在這裡沒有這個功能 換到指定的伺服器找我",
      },
    });
  }

  if (interaction.type === 3) {
    if (!interaction.guild_id || !userId) {
      return jsonResponse(
        buildEphemeralResponse("我剛剛認不出你的伺服器身分 再試一次"),
      );
    }

    try {
      const response = await handleChannelAccessComponent({
        customId,
        selectedRoleIds: interaction.data?.values ?? [],
        config,
        guildId: interaction.guild_id,
        userId,
        currentRoleIds: getMemberRoleIds(interaction),
      });

      if (response) {
        return jsonResponse(response);
      }
    } catch (error) {
      logRoleUpdateError(error);
      return jsonResponse(buildEphemeralResponse(ROLE_UPDATE_ERROR_MESSAGE));
    }
  }

  if (
    commandName === JOIN_VC_COMMAND_NAME ||
    commandName === LEAVE_VC_COMMAND_NAME
  ) {
    if (!interaction.guild_id || !userId) {
      return jsonResponse(
        buildEphemeralResponse("我剛剛認不出你的伺服器身分 再試一次"),
      );
    }

    const result =
      commandName === JOIN_VC_COMMAND_NAME
        ? joinMemberVoiceChannel(interaction.guild_id, userId)
        : leaveVoiceChannel(interaction.guild_id);

    if (result.status === "member_not_in_voice") {
      return jsonResponse(
        buildEphemeralResponse("你要先加入一個語音頻道 我才找得到你"),
      );
    }

    if (result.status === "gateway_unavailable") {
      return jsonResponse(
        buildEphemeralResponse("我現在連不上語音頻道 晚點再試一次"),
      );
    }

    return jsonResponse(
      buildEphemeralResponse(
        result.status === "joined"
          ? "來了 我會安靜待在這裡"
          : "我先離開語音頻道了",
      ),
    );
  }

  const wordleRole = getWordleRole(config.managedRoles);
  const brawlStarsRole = getBrawlStarsRole(config.managedRoles);
  const roleCommand = [
    {
      name: JOIN_WORDLE_CHANNEL_COMMAND_NAME,
      role: wordleRole,
      selectedRoleIds: [wordleRole.id],
      includeMemberSummary: true,
    },
    {
      name: LEAVE_WORDLE_CHANNEL_COMMAND_NAME,
      role: wordleRole,
      selectedRoleIds: [],
      includeMemberSummary: false,
    },
    {
      name: JOIN_BRAWL_STARS_CHANNEL_COMMAND_NAME,
      role: brawlStarsRole,
      selectedRoleIds: [brawlStarsRole.id],
      includeMemberSummary: true,
    },
    {
      name: LEAVE_BRAWL_STARS_CHANNEL_COMMAND_NAME,
      role: brawlStarsRole,
      selectedRoleIds: [],
      includeMemberSummary: false,
    },
  ].find((command) => command.name === commandName);

  if (!roleCommand) {
    return jsonResponse({
      type: 4,
      data: {
        flags: 64,
        content: "這個操作已經不能用了 請使用最新的選單",
      },
    });
  }

  if (!interaction.guild_id || !userId) {
    return jsonResponse({
      type: 4,
      data: {
        flags: 64,
        content: "我剛剛認不出你的伺服器身分 再試一次",
      },
    });
  }

  const currentRoleIds = getMemberRoleIds(interaction);
  const managedRolesById = getManagedRolesById([roleCommand.role]);

  try {
    const result = await applyManagedRoleSelection({
      guildId: interaction.guild_id,
      userId,
      botToken: config.botToken,
      currentRoleIds,
      selectedRoleIds: roleCommand.selectedRoleIds,
      managedRolesById,
    });

    let message = result.message;

    if (roleCommand.includeMemberSummary) {
      try {
        const summary = await buildRoleMemberSummaryMessage({
          guildId: interaction.guild_id,
          roleId: roleCommand.role.id,
          roleLabel: roleCommand.role.label,
          botToken: config.botToken,
        });

        message = `${message}\n\n${summary}`;
      } catch (error) {
        console.error("Failed to load role member summary:", error);
        message = `${message}\n\n${ROLE_UPDATED_WITHOUT_COUNTS_MESSAGE}`;
      }
    }

    return jsonResponse(buildRoleCommandResponse(message));
  } catch (error) {
    logRoleUpdateError(error);
    return jsonResponse(buildEphemeralResponse(ROLE_UPDATE_ERROR_MESSAGE));
  }
}
