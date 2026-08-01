import type { DiscordRequest } from "./chatbot";

const CREATE_GUILD_EXPRESSIONS = 1n << 43n;
const ADMINISTRATOR = 1n << 3n;
const MAX_EMOJI_BYTES = 256 * 1024;
const CUSTOM_EMOJI = /^<(a?):([A-Za-z0-9_]{2,32}):(\d{17,20})>$/u;
const EMOJI_NAME = /^[A-Za-z0-9_]{2,32}$/u;

type DiscordGuild = {
  id: string;
  name: string;
  permissions: string;
};

type DiscordEmoji = {
  id: string;
  name: string;
  animated?: boolean;
};

type EmojiFetch = (input: string | URL | Request) => Promise<Response>;

export type SharedEmojiGuild = {
  id: string;
  name: string;
  canCreateExpressions: boolean;
};

function canCreateExpressions(permissions: string) {
  const bits = BigInt(permissions);
  return (
    (bits & ADMINISTRATOR) === ADMINISTRATOR ||
    (bits & CREATE_GUILD_EXPRESSIONS) === CREATE_GUILD_EXPRESSIONS
  );
}

export async function listSharedEmojiGuilds(discordRequest: DiscordRequest) {
  const guilds = await discordRequest<DiscordGuild[]>("/users/@me/guilds");
  return guilds
    .map(
      (guild): SharedEmojiGuild => ({
        id: guild.id,
        name: guild.name,
        canCreateExpressions: canCreateExpressions(guild.permissions),
      }),
    )
    .sort((left, right) => left.name.localeCompare(right.name));
}

function resolveGuild(guilds: SharedEmojiGuild[], value: string) {
  const query = value.trim().toLocaleLowerCase();
  const matches = guilds.filter(
    (guild) =>
      guild.id === value.trim() || guild.name.toLocaleLowerCase() === query,
  );
  if (matches.length !== 1) {
    throw new Error(
      matches.length > 1
        ? `More than one shared guild is named ${value}; use its guild ID.`
        : `Sago is not in a guild named ${value}. Use list_shared_guilds first.`,
    );
  }
  return matches[0]!;
}

function parseCustomEmoji(value: string) {
  const match = value.trim().match(CUSTOM_EMOJI);
  if (!match) {
    throw new Error(
      "Use the custom emoji itself, such as <:sago:123456789012345678>.",
    );
  }
  return {
    animated: match[1] === "a",
    name: match[2]!,
    id: match[3]!,
  };
}

export async function copyGuildEmoji({
  sourceGuildId,
  destinationGuild,
  emoji,
  name,
  discordRequest,
  fetchEmoji = fetch,
}: {
  sourceGuildId: string;
  destinationGuild: string;
  emoji: string;
  name?: string;
  discordRequest: DiscordRequest;
  fetchEmoji?: EmojiFetch;
}) {
  const parsedEmoji = parseCustomEmoji(emoji);
  const destinationName = name?.trim() || parsedEmoji.name;
  if (!EMOJI_NAME.test(destinationName)) {
    throw new Error(
      "Emoji names must be 2-32 letters, numbers, or underscores.",
    );
  }

  const guilds = await listSharedEmojiGuilds(discordRequest);
  if (!guilds.some((guild) => guild.id === sourceGuildId)) {
    throw new Error("Sago is no longer in the source guild.");
  }
  const destination = resolveGuild(guilds, destinationGuild);
  if (destination.id === sourceGuildId) {
    throw new Error("Choose a different destination guild.");
  }
  if (!destination.canCreateExpressions) {
    throw new Error(
      `Sago needs the Create Expressions permission in ${destination.name}.`,
    );
  }

  const sourceEmojis = await discordRequest<DiscordEmoji[]>(
    `/guilds/${sourceGuildId}/emojis`,
  );
  const sourceEmoji = sourceEmojis.find((item) => item.id === parsedEmoji.id);
  if (!sourceEmoji) {
    throw new Error(
      "That emoji does not belong to the guild this request came from.",
    );
  }

  const animated = sourceEmoji.animated ?? parsedEmoji.animated;
  const imageResponse = await fetchEmoji(
    `https://cdn.discordapp.com/emojis/${sourceEmoji.id}.webp?size=128${animated ? "&animated=true" : ""}`,
  );
  if (!imageResponse.ok) {
    throw new Error("Discord could not download the source emoji.");
  }
  const image = new Uint8Array(await imageResponse.arrayBuffer());
  if (image.byteLength > MAX_EMOJI_BYTES) {
    throw new Error("The copied emoji is larger than Discord's 256 KiB limit.");
  }

  const created = await discordRequest<DiscordEmoji>(
    `/guilds/${destination.id}/emojis`,
    {
      method: "POST",
      body: {
        name: destinationName,
        image: `data:image/webp;base64,${Buffer.from(image).toString("base64")}`,
      },
    },
  );

  return {
    id: created.id,
    name: created.name,
    animated: created.animated ?? animated,
    guild: destination,
  };
}
