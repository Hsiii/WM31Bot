import type { DiscordRequest } from "../gateway/chatbot";

const CREATE_GUILD_EXPRESSIONS = 1n << 43n;
const ADMINISTRATOR = 1n << 3n;
const MAX_EMOJI_BYTES = 256 * 1024;
const MAX_STICKER_BYTES = 512 * 1024;
const DISCORD_CDN_HOSTS = new Set([
  "cdn.discordapp.com",
  "media.discordapp.net",
]);
const CUSTOM_EMOJI = /^<(a?):([A-Za-z0-9_]{2,32}):(\d{17,20})>$/u;
const EMOJI_NAME = /^[A-Za-z0-9_]{2,32}$/u;
const DISCORD_SNOWFLAKE = /^\d{17,20}$/u;
const IMAGE_CONTENT_TYPES = new Set([
  "image/gif",
  "image/jpeg",
  "image/png",
  "image/webp",
]);
const STICKER_CONTENT_TYPES = new Set([
  "application/json",
  "image/apng",
  "image/gif",
  "image/png",
]);

type DiscordGuild = {
  id: string;
  name: string;
  permissions: string;
};

export type SharedGuildEmoji = {
  id: string;
  name: string;
  animated?: boolean;
  available?: boolean;
};

export type ExpressionFetch = (
  input: string | URL | Request,
) => Promise<Response>;

export type ExpressionAttachment = {
  id: string;
  filename: string;
  contentType?: string;
  url: string;
};

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

export async function listGuildEmojis({
  guild,
  discordRequest,
}: {
  guild: string;
  discordRequest: DiscordRequest;
}) {
  const resolvedGuild = resolveGuild(
    await listSharedEmojiGuilds(discordRequest),
    guild,
  );
  const emojis = await discordRequest<SharedGuildEmoji[]>(
    `/guilds/${resolvedGuild.id}/emojis`,
  );
  return {
    guild: resolvedGuild,
    emojis: emojis
      .map(({ id, name, animated = false, available = true }) => ({
        id,
        name,
        animated,
        available,
      }))
      .sort((left, right) => left.name.localeCompare(right.name)),
  };
}

function resolveEmoji(emojis: SharedGuildEmoji[], value: string) {
  const query = value.trim();
  const mention = query.match(CUSTOM_EMOJI);
  const id =
    mention?.[3] ?? (DISCORD_SNOWFLAKE.test(query) ? query : undefined);
  const name =
    mention?.[2] ?? (!id && EMOJI_NAME.test(query) ? query : undefined);
  if (!id && !name) {
    throw new Error(
      "Use an exact emoji name, ID, or custom emoji such as <:sago:123456789012345678>.",
    );
  }
  const matches = emojis.filter((emoji) =>
    id
      ? emoji.id === id
      : emoji.name.toLocaleLowerCase() === name!.toLocaleLowerCase(),
  );
  if (matches.length !== 1) {
    throw new Error(
      matches.length > 1
        ? `More than one source emoji is named ${name}; use the emoji ID.`
        : `No source emoji matched ${query}. Use list_guild_emojis first.`,
    );
  }
  if (matches[0]!.available === false) {
    throw new Error(`The source emoji ${matches[0]!.name} is unavailable.`);
  }
  return matches[0]!;
}

function attachmentContentType(attachment: ExpressionAttachment) {
  const declared = attachment.contentType?.toLocaleLowerCase();
  if (declared && IMAGE_CONTENT_TYPES.has(declared)) return declared;

  const extension = attachment.filename.split(".").at(-1)?.toLocaleLowerCase();
  return extension === "jpg" || extension === "jpeg"
    ? "image/jpeg"
    : extension && IMAGE_CONTENT_TYPES.has(`image/${extension}`)
      ? `image/${extension}`
      : undefined;
}

function stickerContentType(attachment: ExpressionAttachment) {
  const declared = attachment.contentType?.toLocaleLowerCase();
  if (declared && STICKER_CONTENT_TYPES.has(declared)) return declared;

  const extension = attachment.filename.split(".").at(-1)?.toLocaleLowerCase();
  return extension === "json"
    ? "application/json"
    : extension && STICKER_CONTENT_TYPES.has(`image/${extension}`)
      ? `image/${extension}`
      : undefined;
}

export function selectExpressionAttachment({
  attachments,
  referencedAttachments = [],
  selector,
  kind = "emoji",
}: {
  attachments: ExpressionAttachment[];
  referencedAttachments?: ExpressionAttachment[];
  selector?: string;
  kind?: "emoji" | "sticker";
}) {
  const images = [...attachments, ...referencedAttachments].filter(
    (attachment) =>
      (kind === "sticker" ? stickerContentType : attachmentContentType)(
        attachment,
      ) !== undefined,
  );
  if (selector) {
    const query = selector.trim().toLocaleLowerCase();
    const matches = images.filter(
      (attachment) =>
        attachment.id === selector ||
        attachment.filename.toLocaleLowerCase() === query,
    );
    if (matches.length === 1) return matches[0]!;
    throw new Error(
      matches.length > 1
        ? `More than one attached image is named ${selector}.`
        : `No attached image matched ${selector}.`,
    );
  }
  if (images.length !== 1) {
    throw new Error(
      images.length === 0
        ? "Attach an image or reply to a message containing one."
        : "More than one image is attached; specify the exact filename.",
    );
  }
  return images[0]!;
}

function assertDiscordAttachment(attachment: ExpressionAttachment) {
  const imageUrl = new URL(attachment.url);
  if (
    imageUrl.protocol !== "https:" ||
    !DISCORD_CDN_HOSTS.has(imageUrl.hostname)
  ) {
    throw new Error("The file must be a Discord attachment.");
  }
  return imageUrl;
}

function defaultEmojiName(filename: string) {
  const stem = filename.replace(/\.[^.]*$/u, "");
  const normalized = stem
    .replace(/[^A-Za-z0-9_]+/gu, "_")
    .replace(/^_+|_+$/gu, "")
    .slice(0, 32);
  return normalized.length === 1 ? `${normalized}_` : normalized;
}

export async function addGuildEmojiFromAttachment({
  destinationGuild,
  attachment,
  name,
  discordRequest,
  fetchEmoji = fetch,
}: {
  destinationGuild: string;
  attachment: ExpressionAttachment;
  name?: string;
  discordRequest: DiscordRequest;
  fetchEmoji?: ExpressionFetch;
}) {
  const destination = resolveGuild(
    await listSharedEmojiGuilds(discordRequest),
    destinationGuild,
  );
  if (!destination.canCreateExpressions) {
    throw new Error(
      `Sago needs the Create Expressions permission in ${destination.name}.`,
    );
  }

  const destinationName = name?.trim() || defaultEmojiName(attachment.filename);
  if (!EMOJI_NAME.test(destinationName)) {
    throw new Error(
      "Give the emoji a 2-32 character name using letters, numbers, or underscores.",
    );
  }
  const contentType = attachmentContentType(attachment);
  if (!contentType) {
    throw new Error("Discord emoji images must be PNG, JPEG, GIF, or WebP.");
  }
  const imageUrl = assertDiscordAttachment(attachment);

  const imageResponse = await fetchEmoji(imageUrl);
  if (!imageResponse.ok) {
    throw new Error("Discord could not download the attached image.");
  }
  const image = new Uint8Array(await imageResponse.arrayBuffer());
  if (image.byteLength > MAX_EMOJI_BYTES) {
    throw new Error(
      "The attached image is larger than Discord's 256 KiB limit.",
    );
  }

  const created = await discordRequest<SharedGuildEmoji>(
    `/guilds/${destination.id}/emojis`,
    {
      method: "POST",
      body: {
        name: destinationName,
        image: `data:${contentType};base64,${Buffer.from(image).toString("base64")}`,
      },
    },
  );
  return {
    kind: "emoji" as const,
    id: created.id,
    name: created.name,
    animated: created.animated ?? contentType === "image/gif",
    guild: destination,
  };
}

export function addGuildEmojiFromAvatar({
  destinationGuild,
  avatarUrl,
  name,
  discordRequest,
  fetchEmoji = fetch,
}: {
  destinationGuild: string;
  avatarUrl: string;
  name: string;
  discordRequest: DiscordRequest;
  fetchEmoji?: ExpressionFetch;
}) {
  const imageUrl = new URL(avatarUrl);
  imageUrl.pathname = imageUrl.pathname.replace(/\.[^.]+$/u, ".png");
  imageUrl.searchParams.set("size", "128");

  return addGuildEmojiFromAttachment({
    destinationGuild,
    attachment: {
      id: "member-avatar",
      filename: "member-avatar.png",
      contentType: "image/png",
      url: imageUrl.toString(),
    },
    name,
    discordRequest,
    fetchEmoji,
  });
}

export async function addGuildStickerFromAttachment({
  destinationGuild,
  attachment,
  name,
  description = "",
  tags,
  discordRequest,
  fetchSticker = fetch,
}: {
  destinationGuild: string;
  attachment: ExpressionAttachment;
  name?: string;
  description?: string;
  tags: string;
  discordRequest: DiscordRequest;
  fetchSticker?: ExpressionFetch;
}) {
  const destination = resolveGuild(
    await listSharedEmojiGuilds(discordRequest),
    destinationGuild,
  );
  if (!destination.canCreateExpressions) {
    throw new Error(
      `Sago needs the Create Expressions permission in ${destination.name}.`,
    );
  }

  const destinationName = name?.trim() || defaultEmojiName(attachment.filename);
  if (destinationName.length < 2 || destinationName.length > 30) {
    throw new Error("Give the sticker a 2-30 character name.");
  }
  if (description.length === 1 || description.length > 100) {
    throw new Error("Sticker descriptions must be empty or 2-100 characters.");
  }
  if (!tags.trim() || tags.length > 200) {
    throw new Error(
      "Give the sticker a related emoji or tag (max 200 characters).",
    );
  }
  const contentType = stickerContentType(attachment);
  if (!contentType) {
    throw new Error("Discord stickers must be PNG, APNG, GIF, or Lottie JSON.");
  }

  const fileUrl = assertDiscordAttachment(attachment);
  const fileResponse = await fetchSticker(fileUrl);
  if (!fileResponse.ok) {
    throw new Error("Discord could not download the attached sticker.");
  }
  const file = new Uint8Array(await fileResponse.arrayBuffer());
  if (file.byteLength > MAX_STICKER_BYTES) {
    throw new Error(
      "The attached sticker is larger than Discord's 512 KiB limit.",
    );
  }

  const formData = new FormData();
  formData.append("name", destinationName);
  formData.append("description", description);
  formData.append("tags", tags.trim());
  formData.append(
    "file",
    new Blob([file], { type: contentType }),
    attachment.filename,
  );
  const created = await discordRequest<{
    id: string;
    name: string;
    description?: string | null;
    tags: string;
    format_type: number;
  }>(`/guilds/${destination.id}/stickers`, {
    method: "POST",
    formData,
  });

  return {
    kind: "sticker" as const,
    id: created.id,
    name: created.name,
    description: created.description ?? "",
    tags: created.tags,
    formatType: created.format_type,
    guild: destination,
  };
}

export async function copyGuildEmoji({
  sourceGuild,
  destinationGuild,
  emoji,
  name,
  discordRequest,
  fetchEmoji = fetch,
}: {
  sourceGuild: string;
  destinationGuild: string;
  emoji: string;
  name?: string;
  discordRequest: DiscordRequest;
  fetchEmoji?: ExpressionFetch;
}) {
  const guilds = await listSharedEmojiGuilds(discordRequest);
  const source = resolveGuild(guilds, sourceGuild);
  const destination = resolveGuild(guilds, destinationGuild);
  if (destination.id === source.id) {
    throw new Error("Choose a different destination guild.");
  }
  if (!destination.canCreateExpressions) {
    throw new Error(
      `Sago needs the Create Expressions permission in ${destination.name}.`,
    );
  }

  const sourceEmojis = await discordRequest<SharedGuildEmoji[]>(
    `/guilds/${source.id}/emojis`,
  );
  const sourceEmoji = resolveEmoji(sourceEmojis, emoji);
  const destinationName = name?.trim() || sourceEmoji.name;
  if (!EMOJI_NAME.test(destinationName)) {
    throw new Error(
      "Emoji names must be 2-32 letters, numbers, or underscores.",
    );
  }

  const animated = sourceEmoji.animated ?? false;
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

  const created = await discordRequest<SharedGuildEmoji>(
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
    kind: "emoji" as const,
    id: created.id,
    name: created.name,
    animated: created.animated ?? animated,
    sourceGuild: source,
    guild: destination,
  };
}
