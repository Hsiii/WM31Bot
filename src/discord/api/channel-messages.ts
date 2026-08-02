import type { DiscordRequest } from "../gateway/chatbot";

const DISCORD_SNOWFLAKE = /^\d{17,20}$/u;
const SENDABLE_CHANNEL_TYPES = new Set([0, 5, 10, 11, 12]);

type DiscordGuild = {
  id: string;
  name: string;
};

type DiscordChannel = {
  id: string;
  guild_id?: string;
  name?: string;
  type: number;
};

type DiscordMessage = {
  id: string;
};

export type SendChannelMessageInput = {
  content: string;
  channelId?: string;
  server?: string;
  channel?: string;
};

function resolveExact<T extends { id: string; name: string }>(
  values: T[],
  query: string,
  kind: "server" | "channel",
) {
  const normalized = query.trim().toLocaleLowerCase();
  const matches = values.filter(
    (value) =>
      value.id === query.trim() ||
      value.name.toLocaleLowerCase() === normalized,
  );
  if (matches.length !== 1) {
    throw new Error(
      matches.length > 1
        ? `More than one ${kind} is named ${query}; use the channel ID.`
        : `Sago could not find a ${kind} named ${query}.`,
    );
  }
  return matches[0]!;
}

async function resolveDestination(
  input: SendChannelMessageInput,
  discordRequest: DiscordRequest,
) {
  if (input.channelId) {
    if (input.server || input.channel) {
      throw new Error(
        "Provide either channelId or both server and channel, not both.",
      );
    }
    if (!DISCORD_SNOWFLAKE.test(input.channelId)) {
      throw new Error("channelId must be a Discord channel ID.");
    }
    const channel = await discordRequest<DiscordChannel>(
      `/channels/${input.channelId}`,
    );
    if (!channel.guild_id) {
      throw new Error("The destination must be a server channel.");
    }
    return channel;
  }

  if (!input.server || !input.channel) {
    throw new Error("Provide channelId or both server and channel.");
  }

  const guilds = await discordRequest<DiscordGuild[]>("/users/@me/guilds");
  const guild = resolveExact(guilds, input.server, "server");
  const channels = await discordRequest<DiscordChannel[]>(
    `/guilds/${guild.id}/channels`,
  );
  const namedChannels = channels.flatMap((channel) =>
    channel.name && SENDABLE_CHANNEL_TYPES.has(channel.type)
      ? [{ ...channel, name: channel.name }]
      : [],
  );
  return {
    ...resolveExact(namedChannels, input.channel, "channel"),
    guild_id: guild.id,
    guildName: guild.name,
  };
}

export async function sendChannelMessage({
  discordRequest,
  ...input
}: SendChannelMessageInput & { discordRequest: DiscordRequest }) {
  const destination = await resolveDestination(input, discordRequest);
  if (!SENDABLE_CHANNEL_TYPES.has(destination.type)) {
    throw new Error("The destination is not a sendable text channel.");
  }

  const message = await discordRequest<DiscordMessage>(
    `/channels/${destination.id}/messages`,
    {
      method: "POST",
      body: { content: input.content },
    },
  );
  const guildName =
    "guildName" in destination ? destination.guildName : undefined;

  return {
    id: message.id,
    channelId: destination.id,
    ...(destination.name ? { channelName: destination.name } : {}),
    guildId: destination.guild_id!,
    ...(guildName ? { guildName } : {}),
    jumpUrl: `https://discord.com/channels/${destination.guild_id}/${destination.id}/${message.id}`,
  };
}
