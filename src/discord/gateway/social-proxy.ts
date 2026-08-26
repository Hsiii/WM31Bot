type DiscordProxyMessage = {
  guild_id?: string;
  author?: {
    id?: string;
    username?: string;
    global_name?: string | null;
    avatar?: string | null;
    discriminator?: string;
  };
  member?: {
    nick?: string | null;
    avatar?: string | null;
  };
};

type ReplaceableDiscordMessage = {
  type?: number;
  attachments?: unknown[];
  sticker_items?: unknown[];
  components?: unknown[];
  message_snapshots?: unknown[];
  poll?: unknown;
  referenced_message?: unknown;
};

function avatarExtension(hash: string) {
  return hash.startsWith("a_") ? "gif" : "png";
}

function defaultAvatarIndex(message: DiscordProxyMessage) {
  const discriminator = message.author?.discriminator;

  if (discriminator && discriminator !== "0") {
    return Number(discriminator) % 5;
  }

  const userId = message.author?.id;
  return userId ? Number((BigInt(userId) >> 22n) % 6n) : 0;
}

export function getDiscordAvatarUrl(message: DiscordProxyMessage, size = 128) {
  const author = message.author;
  if (message.guild_id && author?.id && message.member?.avatar) {
    const hash = message.member.avatar;
    return `https://cdn.discordapp.com/guilds/${message.guild_id}/users/${author.id}/avatars/${hash}.${avatarExtension(hash)}?size=${size}`;
  }

  if (author?.id && author.avatar) {
    const hash = author.avatar;
    return `https://cdn.discordapp.com/avatars/${author.id}/${hash}.${avatarExtension(hash)}?size=${size}`;
  }

  return `https://cdn.discordapp.com/embed/avatars/${defaultAvatarIndex(message)}.png`;
}

export function getSocialProxyIdentity(message: DiscordProxyMessage) {
  const author = message.author;
  const username =
    message.member?.nick?.trim() ||
    author?.global_name?.trim() ||
    author?.username?.trim() ||
    "Discord User";

  return {
    username: username.slice(0, 80),
    avatarUrl: getDiscordAvatarUrl(message),
  };
}

export function canReplaceSocialMessage(message: ReplaceableDiscordMessage) {
  return (
    (message.type === undefined || message.type === 0) &&
    (message.attachments?.length ?? 0) === 0 &&
    (message.sticker_items?.length ?? 0) === 0 &&
    (message.components?.length ?? 0) === 0 &&
    (message.message_snapshots?.length ?? 0) === 0 &&
    !message.poll &&
    !message.referenced_message
  );
}
