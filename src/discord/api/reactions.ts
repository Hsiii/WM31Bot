import type { ChatbotToolCapability } from "../../../contracts/worker-contract";
import type { DiscordRequest } from "../../chatbot/chatbot";
import {
  canAddDiscordReactions,
  channelPermissions,
  type DiscordPermissionOverwrite,
  type DiscordPermissionRole,
} from "./permissions";

const THREAD_CHANNEL_TYPES = new Set([10, 11, 12]);

type DiscordChannel = {
  id: string;
  type?: number;
  parent_id?: string | null;
  permission_overwrites?: DiscordPermissionOverwrite[];
};

type DiscordGuildMember = {
  roles?: string[];
};

type DiscordEmoji = {
  id: string;
  name?: string | null;
  animated?: boolean;
  available?: boolean;
};

export type DiscordReactionCapabilities = {
  expiresAt: number;
  tools: ChatbotToolCapability[];
  customEmojiValues: ReadonlySet<string>;
};

function isStandardUnicodeEmoji(value: string) {
  if (!value || value.length > 32 || /\s/u.test(value)) return false;
  const segments = [
    ...new Intl.Segmenter("en", { granularity: "grapheme" }).segment(value),
  ];
  return (
    segments.length === 1 &&
    /(?:\p{Extended_Pictographic}|\p{Regional_Indicator}|\u20e3)/u.test(value)
  );
}

export class DiscordReactionBroker {
  private cache = new Map<string, DiscordReactionCapabilities>();

  constructor(
    private readonly options: {
      now?: () => number;
      cacheMs?: number;
    } = {},
  ) {}

  private get now() {
    return this.options.now ?? Date.now;
  }

  private async permissionChannel(
    channel: DiscordChannel,
    discordRequest: DiscordRequest,
  ) {
    if (THREAD_CHANNEL_TYPES.has(channel.type ?? -1) && channel.parent_id) {
      return discordRequest<DiscordChannel>(`/channels/${channel.parent_id}`);
    }
    return channel;
  }

  async discover({
    guildId,
    channelId,
    botUserId,
    discordRequest,
  }: {
    guildId: string;
    channelId: string;
    botUserId: string;
    discordRequest: DiscordRequest;
  }) {
    const now = this.now();
    for (const [key, value] of this.cache) {
      if (value.expiresAt <= now) this.cache.delete(key);
    }
    const cacheKey = `${guildId}:${channelId}:${botUserId}`;
    const cached = this.cache.get(cacheKey);
    if (cached && cached.expiresAt > now) return cached;

    const [channel, member, roles, emojiResult] = await Promise.all([
      discordRequest<DiscordChannel>(`/channels/${channelId}`),
      discordRequest<DiscordGuildMember>(
        `/guilds/${guildId}/members/${botUserId}`,
      ),
      discordRequest<DiscordPermissionRole[]>(`/guilds/${guildId}/roles`),
      discordRequest<DiscordEmoji[]>(`/guilds/${guildId}/emojis`)
        .then((emojis) => ({ status: "complete" as const, emojis }))
        .catch(() => ({
          status: "unavailable" as const,
          emojis: [] as DiscordEmoji[],
        })),
    ]);
    const permissionChannel = await this.permissionChannel(
      channel,
      discordRequest,
    );
    const permissions = channelPermissions({
      guildId,
      botUserId,
      memberRoleIds: member.roles ?? [],
      roles,
      overwrites: permissionChannel.permission_overwrites ?? [],
    });
    const customEmojis = emojiResult.emojis.flatMap((emoji) => {
      const name = emoji.name?.trim();
      if (!name || emoji.available === false) return [];
      return [
        {
          value: `${name}:${emoji.id}`,
          name,
          ...(emoji.animated ? { animated: true } : {}),
        },
      ];
    });
    const customEmojiValues = new Set(customEmojis.map((emoji) => emoji.value));
    const tools: ChatbotToolCapability[] = canAddDiscordReactions(permissions)
      ? [
          {
            name: "discord.add_reaction",
            risk: "ambient",
            description: "Add one reaction to a host-approved Discord message.",
            inputSchema: {
              type: "object",
              additionalProperties: false,
              required: ["emoji"],
              properties: {
                emoji: { type: "string" },
              },
            },
            metadata: {
              target: "host_approved_message",
              standardUnicodeEmoji: true,
              customEmojiStatus: emojiResult.status,
              customEmojis,
            },
          },
        ]
      : [];
    const discovered = {
      expiresAt: now + (this.options.cacheMs ?? 10 * 60_000),
      tools,
      customEmojiValues,
    };
    this.cache.set(cacheKey, discovered);
    return discovered;
  }

  async addReaction({
    channelId,
    messageId,
    emoji,
    capabilities,
    discordRequest,
  }: {
    channelId: string;
    messageId: string;
    emoji: string;
    capabilities: DiscordReactionCapabilities;
    discordRequest: DiscordRequest;
  }) {
    const hasTool = capabilities.tools.some(
      (tool) => tool.name === "discord.add_reaction",
    );
    const validEmoji =
      capabilities.customEmojiValues.has(emoji) ||
      isStandardUnicodeEmoji(emoji);
    if (!hasTool || !validEmoji) return false;

    await discordRequest(
      `/channels/${channelId}/messages/${messageId}/reactions/${encodeURIComponent(emoji)}/@me`,
      { method: "PUT" },
    );
    return true;
  }
}
