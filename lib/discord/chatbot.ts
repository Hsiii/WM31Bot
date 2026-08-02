import { randomUUID } from "node:crypto";

import type { ChatbotAccessConfig } from "../chatbot/access";
import { macAgentBridge, type MacAgentJobResult } from "../chatbot/bridge";
import { CHATBOT_CONTEXT_LIMITS } from "../chatbot/context-limits";
import {
  registerChatbotMcpSession,
  type ChatbotMcpSessionSnapshot,
} from "../chatbot/mcp";
import type {
  ChatbotAttachment,
  ChatbotExecutionMode,
  ChatbotExecutionTarget,
  ChatbotMutationScope,
  ChatbotOutgoingFile,
  ChatbotJob,
  ChatbotMemberResult,
  ChatbotMessage,
  ChatbotTraceContext,
} from "../chatbot/protocol";
import {
  DiscordReactionBroker,
  type DiscordReactionCapabilities,
} from "./reactions";
import {
  copyGuildEmoji,
  listGuildEmojis,
  listSharedEmojiGuilds,
} from "./emojis";
import { getChatbotReminderScheduler } from "./reminders";
import { joinMemberVoiceChannel, leaveVoiceChannel } from "./voice";

const DISCORD_API_BASE_URL = "https://discord.com/api/v10";
const DISCORD_MESSAGE_LIMIT = 2_000;
const TYPING_REFRESH_MS = 8_000;
const ACTIVE_CONVERSATION_TTL_MS = 90_000;

type DiscordAttachment = {
  id: string;
  filename: string;
  content_type?: string;
  size: number;
  url: string;
};

type DiscordMessage = {
  id: string;
  channel_id: string;
  guild_id?: string;
  content?: string;
  timestamp: string;
  webhook_id?: string;
  author?: {
    id?: string;
    username?: string;
    global_name?: string | null;
    bot?: boolean;
  };
  mentions?: Array<{
    id?: string;
  }>;
  member?: {
    nick?: string | null;
    roles?: string[];
  };
  attachments?: DiscordAttachment[];
  embeds?: Array<{
    title?: string;
    description?: string;
    url?: string;
  }>;
  sticker_items?: Array<{ name?: string }>;
  reactions?: Array<{
    count: number;
    me?: boolean;
    emoji: {
      id?: string | null;
      name?: string | null;
      animated?: boolean;
    };
  }>;
  referenced_message?: DiscordMessage | null;
};

type DiscordGuildMember = {
  nick?: string | null;
  user?: {
    id?: string;
    username?: string;
    global_name?: string | null;
  };
};

type DiscordChannel = {
  id: string;
  name?: string;
  type?: number;
  permission_overwrites?: Array<{
    id: string;
    type: number;
    allow: string;
    deny: string;
  }>;
};

type DiscordRole = {
  id: string;
  permissions: string;
};

type DiscordMessageSearchResponse = {
  code?: number;
  retry_after?: number;
  messages?: DiscordMessage[][];
};

type SearchHas =
  | "image"
  | "sound"
  | "video"
  | "file"
  | "sticker"
  | "embed"
  | "link"
  | "poll"
  | "snapshot";
type SearchEmbedType = "image" | "video" | "gif" | "sound" | "article";

export type DiscordSearchQuery = {
  author?: string;
  mentions?: string;
  content?: string;
  has?: SearchHas[];
  embedType?: SearchEmbedType;
  linkHostname?: string;
  attachmentExtension?: string;
  sortBy?: "relevance" | "timestamp";
  sortOrder?: "asc" | "desc";
};

export type DiscordRequest = <T>(
  path: string,
  options?: { method?: string; body?: unknown; formData?: FormData },
) => Promise<T>;

type ActiveConversation = {
  requesterUserId: string;
  expiresAt: number;
};

export class ChatbotConversationTracker {
  private conversations = new Map<string, ActiveConversation>();

  constructor(
    private readonly ttlMs = ACTIVE_CONVERSATION_TTL_MS,
    private readonly now = () => Date.now(),
  ) {}

  activate(channelId: string, requesterUserId: string) {
    const now = this.now();
    for (const [activeChannelId, conversation] of this.conversations) {
      if (conversation.expiresAt <= now) {
        this.conversations.delete(activeChannelId);
      }
    }
    this.conversations.set(channelId, {
      requesterUserId,
      expiresAt: now + this.ttlMs,
    });
  }

  take(message: DiscordMessage) {
    const conversation = this.conversations.get(message.channel_id);
    if (!conversation) return false;

    this.conversations.delete(message.channel_id);
    return (
      conversation.expiresAt > this.now() &&
      message.author?.id === conversation.requesterUserId
    );
  }
}

export type ChatbotAnswerDecision = {
  reply: string | null;
  reactionEmoji?: string;
};

export function parseChatbotAnswerDecision(
  content: string,
): ChatbotAnswerDecision {
  try {
    const value = JSON.parse(content) as {
      reply?: unknown;
      reaction?: unknown;
    };
    const reply =
      typeof value.reply === "string"
        ? value.reply.trim()
        : value.reply === null
          ? null
          : undefined;
    const reaction =
      value.reaction &&
      typeof value.reaction === "object" &&
      "emoji" in value.reaction &&
      typeof value.reaction.emoji === "string"
        ? value.reaction.emoji.trim()
        : undefined;
    if (
      reply !== undefined &&
      (value.reaction === null || reaction !== undefined) &&
      (reply || reaction)
    ) {
      return {
        reply: reply || null,
        ...(reaction ? { reactionEmoji: reaction } : {}),
      };
    }
    return { reply: null };
  } catch {
    return { reply: content.trim() || null };
  }
}

export async function executeChatbotAnswerDecision({
  content,
  message,
  reactionBroker,
  reactionCapabilities,
  discordRequest,
}: {
  content: string;
  message: Pick<ChatbotMention, "id" | "channel_id">;
  reactionBroker?: Pick<DiscordReactionBroker, "addReaction">;
  reactionCapabilities?: DiscordReactionCapabilities;
  discordRequest: DiscordRequest;
}) {
  const decision = parseChatbotAnswerDecision(content);
  let reacted = false;
  if (decision.reactionEmoji && reactionBroker && reactionCapabilities) {
    try {
      reacted = await reactionBroker.addReaction({
        channelId: message.channel_id,
        messageId: message.id,
        emoji: decision.reactionEmoji,
        capabilities: reactionCapabilities,
        discordRequest,
      });
    } catch {
      console.warn("Discord mention reaction failed.");
    }
  }
  return { reply: decision.reply, reacted };
}

export type ChatbotMention = DiscordMessage;

function authorAliases(message: DiscordMessage) {
  return [
    message.member?.nick,
    message.author?.global_name,
    message.author?.username,
  ].filter(
    (name, index, names): name is string =>
      Boolean(name) &&
      names.findIndex(
        (candidate) =>
          candidate?.toLocaleLowerCase() === name?.toLocaleLowerCase(),
      ) === index,
  );
}

function authorName(message: DiscordMessage) {
  return authorAliases(message)[0] || message.author?.id || "Unknown user";
}

function attachment(attachment: DiscordAttachment): ChatbotAttachment {
  return {
    id: attachment.id,
    filename: attachment.filename,
    contentType: attachment.content_type,
    size: attachment.size,
    url: attachment.url,
  };
}

function messageContent(message: DiscordMessage) {
  const parts = [message.content?.trim() ?? ""];

  for (const embed of message.embeds ?? []) {
    parts.push(
      [embed.title, embed.description, embed.url].filter(Boolean).join("\n"),
    );
  }

  for (const sticker of message.sticker_items ?? []) {
    if (sticker.name) {
      parts.push(`[Sticker: ${sticker.name}]`);
    }
  }

  return parts.filter(Boolean).join("\n");
}

function messageReactions(message: DiscordMessage) {
  return (message.reactions ?? []).flatMap((reaction) => {
    const name = reaction.emoji.name;
    if (!name) return [];

    return [
      {
        emoji: reaction.emoji.id
          ? `<${reaction.emoji.animated ? "a" : ""}:${name}:${reaction.emoji.id}>`
          : name,
        count: reaction.count,
        ...(reaction.me ? { me: true } : {}),
      },
    ];
  });
}

function contextMessage(
  message: DiscordMessage,
  botUserId?: string,
): Omit<ChatbotMessage, "referencedMessage"> {
  const aliases = authorAliases(message);

  return {
    id: message.id,
    role: message.author?.id === botUserId ? "assistant" : "user",
    author: authorName(message),
    ...(aliases.length > 1 ? { authorAliases: aliases } : {}),
    timestamp: message.timestamp,
    content: messageContent(message),
    attachments: (message.attachments ?? []).map(attachment),
    ...(message.reactions?.length
      ? { reactions: messageReactions(message) }
      : {}),
  };
}

export function toChatbotMessage(
  message: DiscordMessage,
  botUserId?: string,
): ChatbotMessage {
  return {
    ...contextMessage(message, botUserId),
    referencedMessage: message.referenced_message
      ? contextMessage(message.referenced_message, botUserId)
      : undefined,
  };
}

export function isConversationContextMessage(
  message: DiscordMessage,
  requestMessageId: string,
  botUserId: string,
) {
  return (
    message.id !== requestMessageId &&
    !message.webhook_id &&
    (!message.author?.bot || message.author?.id === botUserId)
  );
}

export function isHumanContextMessage(
  message: DiscordMessage,
  requestMessageId: string,
) {
  return (
    message.id !== requestMessageId &&
    !message.webhook_id &&
    !message.author?.bot
  );
}

export function extractMentionRequest(content: string, botUserId: string) {
  const mentionPattern = new RegExp(`<@!?${botUserId}>`, "g");

  if (!mentionPattern.test(content)) {
    return null;
  }

  return content.replace(mentionPattern, "").trim();
}

export function extractChatbotRequest(
  message: ChatbotMention,
  botUserId: string,
  accessConfig: ChatbotAccessConfig,
) {
  const content = message.content ?? "";
  const mentionRequest = extractMentionRequest(content, botUserId);

  if (mentionRequest !== null) {
    return mentionRequest;
  }

  if (!message.guild_id && message.author?.id === accessConfig.ownerUserId) {
    return content.trim();
  }

  return message.referenced_message?.author?.id === botUserId &&
    message.mentions?.some((user) => user.id === botUserId)
    ? content.trim()
    : null;
}

export function isChatbotAuthorized(
  userId: string,
  accessConfig: ChatbotAccessConfig,
  guildId?: string,
  channelId?: string,
) {
  return (
    userId === accessConfig.ownerUserId ||
    (guildId !== undefined && accessConfig.guildIds.has(guildId)) ||
    (channelId !== undefined && accessConfig.channelIds.has(channelId))
  );
}

function normalizeDiscordAnswer(content: string) {
  const normalized = content.trim();

  if (!normalized) {
    return "我剛剛腦袋一片空白 再問我一次";
  }

  return normalized;
}

function limitDiscordMessage(content: string) {
  return content.length <= DISCORD_MESSAGE_LIMIT
    ? content
    : `${content.slice(0, DISCORD_MESSAGE_LIMIT - 1).trimEnd()}…`;
}

export function formatDiscordAnswer(content: string) {
  return limitDiscordMessage(normalizeDiscordAnswer(content));
}

export function formatDiscordAnswers(content: string) {
  return normalizeDiscordAnswer(content)
    .split(/\n{2,}/u)
    .map((part) => limitDiscordMessage(part.trim()))
    .filter(Boolean);
}

const SELF_AUTHOR_PATTERN = /^(?:self|i|me|myself|我|自己)$/iu;
const USER_MENTION_PATTERN = /^<@!?(\d+)>$/u;
export function parsePreviousTraceLookup(content: string): {
  status: "complete" | "not_found" | "unavailable";
  trace?: ChatbotTraceContext;
} {
  try {
    const payload = JSON.parse(content) as {
      status?: unknown;
      trace?: unknown;
    };
    if (payload.status === "not_found") return { status: "not_found" };
    if (
      payload.status !== "complete" ||
      !payload.trace ||
      typeof payload.trace !== "object"
    ) {
      return { status: "unavailable" };
    }
    const trace = payload.trace as Partial<ChatbotTraceContext>;
    if (
      typeof trace.contextMessageCount !== "number" ||
      typeof trace.searchResultCount !== "number" ||
      typeof trace.elapsedMs !== "number" ||
      !Array.isArray(trace.searchQueries) ||
      !Array.isArray(trace.memberQueries)
    ) {
      return { status: "unavailable" };
    }
    return {
      status: "complete",
      trace: trace as ChatbotTraceContext,
    };
  } catch {
    return { status: "unavailable" };
  }
}

export function parseExecutionRoute(
  content: string,
  availableRepositories: string[] = [],
): {
  mode: ChatbotExecutionMode;
  target: ChatbotExecutionTarget;
  mutationScope?: ChatbotMutationScope;
  repository?: string;
} {
  const advertisedRepositories = new Map(
    availableRepositories.map((repository) => [
      repository.toLocaleLowerCase("en-US"),
      repository,
    ]),
  );

  try {
    const normalized = content
      .trim()
      .replace(/^```(?:json)?\s*/iu, "")
      .replace(/\s*```$/u, "");
    const payload = JSON.parse(normalized) as {
      mode?: unknown;
      target?: unknown;
      repository?: unknown;
      mutationScope?: unknown;
    };
    if (payload.mode === "dev" || payload.mode === "chat") {
      const mutationScope = ["code", "issue", "deploy"].includes(
        payload.mutationScope as string,
      )
        ? (payload.mutationScope as ChatbotMutationScope)
        : undefined;
      const mode = mutationScope ? "dev" : payload.mode;
      const target = payload.target === "mac" ? "mac" : "default";
      const repository =
        typeof payload.repository === "string"
          ? advertisedRepositories.get(
              payload.repository.toLocaleLowerCase("en-US"),
            )
          : undefined;
      return {
        mode,
        target,
        ...(mutationScope ? { mutationScope } : {}),
        ...(mode === "dev" && repository ? { repository } : {}),
      };
    }
  } catch {
    // Fall through to the deterministic safety net.
  }

  return {
    mode: "chat",
    target: "default",
  };
}

export function missingDeveloperRepositoryResponse(
  mode: ChatbotExecutionMode,
  repository?: string,
  availableRepositories: string[] = [],
) {
  if (mode !== "dev" || repository) return undefined;
  const choices =
    availableRepositories.length > 0
      ? `\n目前可用的有 ${availableRepositories.map((value) => `\`${value}\``).join(" ")}`
      : "";
  return `這題要碰程式碼 但我還不知道是哪個 GitHub repo${choices}\n告訴我是哪個 我就能繼續`;
}

function memberNames(member: DiscordGuildMember) {
  return [member.nick, member.user?.global_name, member.user?.username].filter(
    (name, index, names): name is string =>
      Boolean(name) &&
      names.findIndex(
        (candidate) =>
          candidate?.toLocaleLowerCase() === name?.toLocaleLowerCase(),
      ) === index,
  );
}

async function resolveGuildMember({
  guildId,
  memberQuery,
  discordRequest,
}: {
  guildId: string;
  memberQuery: string;
  discordRequest: DiscordRequest;
}) {
  const mentionedUserId = memberQuery.match(USER_MENTION_PATTERN)?.[1];
  if (mentionedUserId) {
    return discordRequest<DiscordGuildMember>(
      `/guilds/${guildId}/members/${mentionedUserId}`,
    );
  }

  const query = new URLSearchParams({
    query: memberQuery,
    limit: String(CHATBOT_CONTEXT_LIMITS.memberSearchResults),
  });
  const members = await discordRequest<DiscordGuildMember[]>(
    `/guilds/${guildId}/members/search?${query}`,
  );
  const normalizedQuery = memberQuery.toLocaleLowerCase();
  const exactMatches = members.filter((member) =>
    memberNames(member).some(
      (name) => name.toLocaleLowerCase() === normalizedQuery,
    ),
  );
  const match =
    exactMatches.length === 1
      ? exactMatches[0]
      : members.length === 1
        ? members[0]
        : undefined;

  return match;
}

export async function lookupGuildMembers({
  guildId,
  queries,
  discordRequest,
}: {
  guildId: string;
  queries: string[];
  discordRequest: DiscordRequest;
}) {
  const results = await Promise.all(
    queries
      .slice(0, CHATBOT_CONTEXT_LIMITS.maximumMemberLookups)
      .map(async (query): Promise<ChatbotMemberResult[]> => {
        const member = await resolveGuildMember({
          guildId,
          memberQuery: query,
          discordRequest,
        });
        const names = member ? memberNames(member) : [];
        return names.length > 0 ? [{ query, names }] : [];
      }),
  );

  return results.flat();
}

const ADMINISTRATOR = 1n << 3n;
const VIEW_CHANNEL = 1n << 10n;
const READ_MESSAGE_HISTORY = 1n << 16n;
const SEARCHABLE_CHANNEL_TYPES = new Set([0, 5, 15, 16]);

export function canMemberSearchChannel({
  guildId,
  userId,
  roleIds,
  roles,
  channel,
}: {
  guildId: string;
  userId: string;
  roleIds: string[];
  roles: DiscordRole[];
  channel: DiscordChannel;
}) {
  const memberRoleIds = new Set([guildId, ...roleIds]);
  let permissions = roles.reduce(
    (value, role) =>
      memberRoleIds.has(role.id) ? value | BigInt(role.permissions) : value,
    0n,
  );

  if ((permissions & ADMINISTRATOR) === ADMINISTRATOR) return true;

  const overwrites = channel.permission_overwrites ?? [];
  const applyOverwrite = (deny: bigint, allow: bigint) => {
    permissions = (permissions & ~deny) | allow;
  };
  const everyone = overwrites.find(
    (overwrite) => overwrite.type === 0 && overwrite.id === guildId,
  );
  if (everyone) applyOverwrite(BigInt(everyone.deny), BigInt(everyone.allow));

  let roleDeny = 0n;
  let roleAllow = 0n;
  for (const overwrite of overwrites) {
    if (overwrite.type === 0 && roleIds.includes(overwrite.id)) {
      roleDeny |= BigInt(overwrite.deny);
      roleAllow |= BigInt(overwrite.allow);
    }
  }
  applyOverwrite(roleDeny, roleAllow);

  const member = overwrites.find(
    (overwrite) => overwrite.type === 1 && overwrite.id === userId,
  );
  if (member) applyOverwrite(BigInt(member.deny), BigInt(member.allow));

  return (
    (permissions & VIEW_CHANNEL) === VIEW_CHANNEL &&
    (permissions & READ_MESSAGE_HISTORY) === READ_MESSAGE_HISTORY
  );
}

async function requesterSearchChannels({
  guildId,
  requesterUserId,
  requesterRoleIds,
  currentChannelId,
  discordRequest,
}: {
  guildId: string;
  requesterUserId: string;
  requesterRoleIds?: string[];
  currentChannelId: string;
  discordRequest: DiscordRequest;
}) {
  if (!requesterRoleIds) {
    return { ids: [currentChannelId], names: new Map<string, string>() };
  }

  try {
    const [roles, channels] = await Promise.all([
      discordRequest<DiscordRole[]>(`/guilds/${guildId}/roles`),
      discordRequest<DiscordChannel[]>(`/guilds/${guildId}/channels`),
    ]);
    const visible = channels.filter(
      (channel) =>
        SEARCHABLE_CHANNEL_TYPES.has(channel.type ?? -1) &&
        canMemberSearchChannel({
          guildId,
          userId: requesterUserId,
          roleIds: requesterRoleIds,
          roles,
          channel,
        }),
    );
    const ids = [currentChannelId, ...visible.map((channel) => channel.id)]
      .filter((id, index, values) => values.indexOf(id) === index)
      .slice(0, CHATBOT_CONTEXT_LIMITS.maximumSearchChannels);
    const names = new Map(
      visible.flatMap((channel) =>
        channel.name ? [[channel.id, channel.name] as const] : [],
      ),
    );
    return { ids, names };
  } catch {
    return { ids: [currentChannelId], names: new Map<string, string>() };
  }
}

function toSearchResult(
  message: DiscordMessage,
  guildId: string,
  channelNames: Map<string, string>,
): ChatbotMessage {
  return {
    ...toChatbotMessage(message),
    channelId: message.channel_id,
    channelName: channelNames.get(message.channel_id),
    jumpUrl: `https://discord.com/channels/${guildId}/${message.channel_id}/${message.id}`,
  };
}

export async function searchGuildMessages({
  guildId,
  requesterUserId,
  requesterRoleIds,
  currentChannelId,
  requestMessageId,
  queries,
  knownMembers = [],
  discordRequest,
}: {
  guildId: string;
  requesterUserId: string;
  requesterRoleIds?: string[];
  currentChannelId: string;
  requestMessageId: string;
  queries: DiscordSearchQuery[];
  knownMembers?: DiscordGuildMember[];
  discordRequest: DiscordRequest;
}) {
  const searchableChannels = await requesterSearchChannels({
    guildId,
    requesterUserId,
    requesterRoleIds,
    currentChannelId,
    discordRequest,
  });
  const memberIds = new Map<string, string | undefined>();
  for (const member of knownMembers) {
    for (const name of memberNames(member)) {
      memberIds.set(name.toLocaleLowerCase(), member.user?.id);
    }
  }
  const matches = new Map<string, DiscordMessage>();

  for (const search of queries.slice(
    0,
    CHATBOT_CONTEXT_LIMITS.maximumSearchQueries,
  )) {
    const resolveMemberId = async (memberQuery: string) => {
      const normalizedMember = memberQuery.toLocaleLowerCase();
      let memberId = SELF_AUTHOR_PATTERN.test(memberQuery)
        ? requesterUserId
        : memberIds.get(normalizedMember);
      if (!memberId && !memberIds.has(normalizedMember)) {
        const member = await resolveGuildMember({
          guildId,
          memberQuery,
          discordRequest,
        });
        memberId = member?.user?.id;
        memberIds.set(normalizedMember, memberId);
      }
      return memberId;
    };
    const authorId = search.author
      ? await resolveMemberId(search.author)
      : undefined;
    const mentionedId = search.mentions
      ? await resolveMemberId(search.mentions)
      : undefined;
    if ((search.author && !authorId) || (search.mentions && !mentionedId)) {
      continue;
    }

    const query = new URLSearchParams({
      limit: String(CHATBOT_CONTEXT_LIMITS.searchResultsPerQuery),
      author_type: "user",
      sort_by: search.sortBy ?? (search.content ? "relevance" : "timestamp"),
      sort_order: search.sortOrder ?? "desc",
    });
    if (authorId) query.append("author_id", authorId);
    if (mentionedId) query.append("mentions", mentionedId);
    if (search.content) query.set("content", search.content);
    for (const has of search.has ?? []) query.append("has", has);
    if (search.embedType) query.append("embed_type", search.embedType);
    if (search.linkHostname) query.append("link_hostname", search.linkHostname);
    if (search.attachmentExtension)
      query.append("attachment_extension", search.attachmentExtension);
    for (const channelId of searchableChannels.ids) {
      query.append("channel_id", channelId);
    }

    for (
      let attempt = 0;
      attempt < CHATBOT_CONTEXT_LIMITS.searchRetryAttempts;
      attempt += 1
    ) {
      const response = await discordRequest<DiscordMessageSearchResponse>(
        `/guilds/${guildId}/messages/search?${query}`,
      );

      if (response.messages) {
        for (const message of response.messages.flat()) {
          if (
            message.id === requestMessageId ||
            message.webhook_id ||
            message.author?.bot
          ) {
            continue;
          }
          if (matches.has(message.id)) continue;
          if (matches.size >= CHATBOT_CONTEXT_LIMITS.maximumSearchResults)
            continue;
          matches.set(message.id, message);
        }
        break;
      }

      if (
        response.code !== 110000 ||
        attempt === CHATBOT_CONTEXT_LIMITS.searchRetryAttempts - 1
      )
        break;
      await Bun.sleep(Math.max(response.retry_after ?? 1, 1) * 1_000);
    }

    if (matches.size >= CHATBOT_CONTEXT_LIMITS.maximumSearchResults) break;
  }

  if (matches.size === 0) return [];

  return [...matches.values()].map((message) =>
    toSearchResult(message, guildId, searchableChannels.names),
  );
}

export async function getNearbyHumanMessages({
  channelId,
  requestMessageId,
  botUserId,
  discordRequest,
}: {
  channelId: string;
  requestMessageId: string;
  botUserId: string;
  discordRequest: DiscordRequest;
}) {
  const query = new URLSearchParams({
    around: requestMessageId,
    limit: String(CHATBOT_CONTEXT_LIMITS.nearbyFetchMessages),
  });
  const messages = await discordRequest<DiscordMessage[]>(
    `/channels/${channelId}/messages?${query}`,
  );

  return messages
    .filter((message) =>
      isConversationContextMessage(message, requestMessageId, botUserId),
    )
    .slice(0, CHATBOT_CONTEXT_LIMITS.nearbyMessages)
    .map((message) => toChatbotMessage(message, botUserId))
    .reverse();
}

export async function getRecentHumanMessages({
  channelId,
  requestMessageId,
  botUserId,
  discordRequest,
  messageLimit = CHATBOT_CONTEXT_LIMITS.maximumHistoryMessages,
  now = new Date(),
}: {
  channelId: string;
  requestMessageId: string;
  botUserId: string;
  discordRequest: DiscordRequest;
  messageLimit?: number;
  now?: Date;
}) {
  const cutoff = new Date(
    now.getTime() - CHATBOT_CONTEXT_LIMITS.historyWindowMs,
  );
  const messages: ChatbotMessage[] = [];
  let before: string | undefined;

  for (;;) {
    const query = new URLSearchParams({
      limit: String(CHATBOT_CONTEXT_LIMITS.historyPageMessages),
    });
    if (before) {
      query.set("before", before);
    }

    const page = await discordRequest<DiscordMessage[]>(
      `/channels/${channelId}/messages?${query}`,
    );

    for (const message of page) {
      const withinHistoryWindow = new Date(message.timestamp) >= cutoff;
      const needsBackfill = messages.length < messageLimit;

      if (
        isConversationContextMessage(message, requestMessageId, botUserId) &&
        (withinHistoryWindow || needsBackfill)
      ) {
        messages.push(toChatbotMessage(message, botUserId));
      }

      if (messages.length >= messageLimit) {
        return messages.slice(0, messageLimit).reverse();
      }
    }

    const oldestMessage = page.at(-1);
    if (
      page.length < CHATBOT_CONTEXT_LIMITS.historyPageMessages ||
      !oldestMessage
    ) {
      break;
    }

    if (oldestMessage.id === before) break;

    before = oldestMessage.id;
  }

  return messages.reverse();
}

function replyBody(message: DiscordMessage, content: string | null) {
  return {
    ...(content ? { content } : {}),
    message_reference: {
      message_id: message.id,
      fail_if_not_exists: false,
    },
    allowed_mentions: {
      parse: [],
      replied_user: true,
    },
  };
}

function channelMessageBody(content: string | null) {
  return {
    ...(content ? { content } : {}),
    allowed_mentions: {
      parse: [],
    },
  };
}

export async function postChatbotResponse(
  message: DiscordMessage,
  content: string | string[] | null,
  discordRequest: DiscordRequest,
  files: ChatbotOutgoingFile[] = [],
) {
  const contents = Array.isArray(content) ? content : [content];
  let canPostDirectly = false;

  try {
    const latestMessages = await discordRequest<DiscordMessage[]>(
      `/channels/${message.channel_id}/messages?limit=1`,
    );
    canPostDirectly = latestMessages[0]?.id === message.id;
  } catch {
    // A reply keeps the relationship clear when the latest message is unknown.
  }

  for (const [index, content] of contents.entries()) {
    const body =
      canPostDirectly || index > 0
        ? channelMessageBody(content)
        : replyBody(message, content);
    const uploadFiles = index === 0 ? files : [];
    const formData =
      uploadFiles.length > 0
        ? (() => {
            const form = new FormData();
            form.append("payload_json", JSON.stringify(body));
            for (const [fileIndex, file] of uploadFiles.entries()) {
              form.append(
                `files[${fileIndex}]`,
                new Blob([Buffer.from(file.data, "base64")], {
                  type: file.contentType,
                }),
                file.filename,
              );
            }
            return form;
          })()
        : undefined;
    await discordRequest(`/channels/${message.channel_id}/messages`, {
      method: "POST",
      ...(formData ? { formData } : { body }),
    });
  }
}

async function withTyping<T>(
  channelId: string,
  discordRequest: DiscordRequest,
  task: () => Promise<T>,
) {
  await discordRequest(`/channels/${channelId}/typing`, {
    method: "POST",
  }).catch(() => undefined);
  const timer = setInterval(() => {
    void discordRequest(`/channels/${channelId}/typing`, {
      method: "POST",
    }).catch(() => undefined);
  }, TYPING_REFRESH_MS);

  try {
    return await task();
  } finally {
    clearInterval(timer);
  }
}

export async function handleChatbotMention({
  message,
  botUserId,
  discordRequest,
  accessConfig,
  reactionBroker,
  conversationTracker,
}: {
  message: ChatbotMention;
  botUserId: string;
  discordRequest: DiscordRequest;
  accessConfig: ChatbotAccessConfig;
  reactionBroker?: DiscordReactionBroker;
  conversationTracker?: ChatbotConversationTracker;
}) {
  const requesterUserId = message.author?.id;

  if (!requesterUserId || message.author?.bot || message.webhook_id) {
    return false;
  }

  let request = extractChatbotRequest(message, botUserId, accessConfig);
  if (request === null && conversationTracker?.take(message)) {
    request = message.content?.trim() ?? "";
  }
  if (request === null) {
    return false;
  }

  if (
    !isChatbotAuthorized(
      requesterUserId,
      accessConfig,
      message.guild_id,
      message.channel_id,
    )
  ) {
    if (!message.guild_id) {
      return false;
    }

    await postChatbotResponse(
      message,
      `在這個伺服器裡我暫時只聽 <@${accessConfig.ownerUserId}> 的 抱歉啦`,
      discordRequest,
    );
    return true;
  }

  const acquired = macAgentBridge.acquireWorkflow();

  if (acquired.status === "offline") {
    await postChatbotResponse(
      message,
      "我現在沒接上工作機 晚點再叫我一次 💤",
      discordRequest,
    );
    return true;
  }

  if (acquired.status === "busy") {
    await postChatbotResponse(
      message,
      "我正在幫別人做事 等我一下下",
      discordRequest,
    );
    return true;
  }

  const { workflow } = acquired;
  let result: MacAgentJobResult;
  let mcpSession: ReturnType<typeof registerChatbotMcpSession> | undefined;
  let mcpSnapshot: ChatbotMcpSessionSnapshot = {
    reacted: false,
    searchUnavailable: false,
  };
  let reactionCapabilities: DiscordReactionCapabilities | undefined;
  try {
    result = await withTyping(message.channel_id, discordRequest, async () => {
      const requestMessage = toChatbotMessage(message, botUserId);
      let messages = message.guild_id
        ? await getNearbyHumanMessages({
            channelId: message.channel_id,
            requestMessageId: message.id,
            botUserId,
            discordRequest,
          })
        : await getRecentHumanMessages({
            channelId: message.channel_id,
            requestMessageId: message.id,
            botUserId,
            discordRequest,
          });
      let executionMode: ChatbotExecutionMode = "chat";
      let executionTarget: ChatbotExecutionTarget = "default";
      let mutationScope: ChatbotMutationScope | undefined;
      let selectedRepository: string | undefined;

      if (requesterUserId === accessConfig.ownerUserId) {
        const routeJob: ChatbotJob = {
          id: randomUUID(),
          requesterUserId,
          purpose: "execution_route",
          channelId: message.channel_id,
          requestMessageId: message.id,
          request,
          requestMessage,
          messages,
          availableRepositories: workflow.availableRepositories,
          ...(workflow.chatbotRepository
            ? { chatbotRepository: workflow.chatbotRepository }
            : {}),
        };
        const routeDispatch = workflow.dispatch(routeJob);
        let route = parseExecutionRoute("", workflow.availableRepositories);
        if (routeDispatch.status === "accepted") {
          const routeResult = await routeDispatch.result;
          route = parseExecutionRoute(
            routeResult.ok ? routeResult.content : "",
            workflow.availableRepositories,
          );
        }
        executionMode = route.mode;
        executionTarget = route.target;
        mutationScope = route.mutationScope;
        selectedRepository = route.repository;

        const missingRepository = missingDeveloperRepositoryResponse(
          executionMode,
          selectedRepository,
          workflow.availableRepositories,
        );
        if (missingRepository) {
          return { ok: true as const, content: missingRepository };
        }
        const workerRoute = workflow.route(
          [
            executionMode === "chat" ? "chat" : executionMode,
            ...(executionTarget === "mac" ? (["mac"] as const) : []),
          ],
          selectedRepository,
        );
        if (workerRoute.status !== "accepted") {
          return {
            ok: false as const,
            error:
              workerRoute.status === "busy"
                ? "The compatible worker is busy."
                : "No compatible worker is online.",
          };
        }
      }
      let previousTrace: {
        status: "complete" | "not_found" | "unavailable";
        trace?: ChatbotTraceContext;
      } = { status: "unavailable" };
      const traceDispatch = workflow.dispatch({
        id: randomUUID(),
        requesterUserId,
        purpose: "trace_lookup",
        channelId: message.channel_id,
        requestMessageId: message.id,
        request,
        requestMessage,
        messages: [],
      });
      if (traceDispatch.status === "accepted") {
        const traceResult = await traceDispatch.result;
        previousTrace = traceResult.ok
          ? parsePreviousTraceLookup(traceResult.content)
          : { status: "unavailable" };
      }

      if (message.guild_id && reactionBroker) {
        try {
          reactionCapabilities = await reactionBroker.discover({
            guildId: message.guild_id,
            channelId: message.channel_id,
            botUserId,
            discordRequest,
          });
        } catch {
          console.warn("Discord reaction capabilities unavailable.");
        }
      }

      const recentMessages = (historyCount: number) =>
        historyCount <= CHATBOT_CONTEXT_LIMITS.nearbyMessages
          ? Promise.resolve(
              historyCount === 0 ? [] : messages.slice(-historyCount),
            )
          : getRecentHumanMessages({
              channelId: message.channel_id,
              requestMessageId: message.id,
              botUserId,
              discordRequest,
              messageLimit: historyCount,
            });
      const searchMessages = message.guild_id
        ? (queries: DiscordSearchQuery[]) =>
            searchGuildMessages({
              guildId: message.guild_id!,
              requesterUserId,
              requesterRoleIds: message.member?.roles,
              currentChannelId: message.channel_id,
              requestMessageId: message.id,
              queries,
              discordRequest,
            })
        : undefined;
      const lookupMembers = message.guild_id
        ? (queries: string[]) =>
            lookupGuildMembers({
              guildId: message.guild_id!,
              queries,
              discordRequest,
            })
        : undefined;
      const reactionTool = reactionCapabilities?.tools.find(
        (tool) => tool.name === "discord.add_reaction",
      );
      const addReaction =
        reactionBroker && reactionCapabilities && reactionTool
          ? (emoji: string) =>
              reactionBroker.addReaction({
                channelId: message.channel_id,
                messageId: message.id,
                emoji,
                capabilities: reactionCapabilities!,
                discordRequest,
              })
          : undefined;
      const reminderScheduler = getChatbotReminderScheduler();

      mcpSession = registerChatbotMcpSession({
        getRecentMessages: recentMessages,
        ...(searchMessages ? { searchMessages } : {}),
        ...(lookupMembers ? { lookupMembers } : {}),
        getPreviousTrace: async () => previousTrace,
        getCodexUsage: () => workflow.getCodexUsage(),
        resolveContext: async ({
          historyCount,
          includePreviousTrace,
          memberQueries,
          queries,
        }) => {
          const historyPromise = recentMessages(historyCount)
            .then((resolvedMessages) => ({
              status: "complete" as const,
              messages: resolvedMessages,
            }))
            .catch(() => ({
              status: "unavailable" as const,
              messages: [] as ChatbotMessage[],
            }));
          const searchPromise =
            queries.length > 0
              ? searchMessages
                ? searchMessages(queries)
                    .then((results) => ({
                      status: "complete" as const,
                      results,
                    }))
                    .catch(() => ({
                      status: "unavailable" as const,
                      results: [] as ChatbotMessage[],
                    }))
                : Promise.resolve({
                    status: "unavailable" as const,
                    results: [] as ChatbotMessage[],
                  })
              : Promise.resolve({
                  status: "not_requested" as const,
                  results: [] as ChatbotMessage[],
                });
          const membersPromise =
            memberQueries.length > 0
              ? lookupMembers
                ? lookupMembers(memberQueries)
                    .then((results) => ({
                      status: "complete" as const,
                      results,
                    }))
                    .catch(() => ({
                      status: "unavailable" as const,
                      results: [] as ChatbotMemberResult[],
                    }))
                : Promise.resolve({
                    status: "unavailable" as const,
                    results: [] as ChatbotMemberResult[],
                  })
              : Promise.resolve({
                  status: "not_requested" as const,
                  results: [] as ChatbotMemberResult[],
                });

          const [history, search, members] = await Promise.all([
            historyPromise,
            searchPromise,
            membersPromise,
          ]);
          return {
            history,
            search,
            members,
            previousTrace: includePreviousTrace
              ? previousTrace
              : { status: "not_requested" as const },
          };
        },
        ...(addReaction ? { addReaction } : {}),
        ...(reactionTool
          ? {
              addReactionDescription: `${reactionTool.description} Available values: ${JSON.stringify(reactionTool.metadata ?? {})}`,
            }
          : {}),
        ...(requesterUserId === accessConfig.ownerUserId && message.guild_id
          ? {
              listSharedGuilds: async () =>
                (await listSharedEmojiGuilds(discordRequest)).map((guild) => ({
                  ...guild,
                  current: guild.id === message.guild_id,
                })),
              listGuildEmojis: (guild: string) =>
                listGuildEmojis({ guild, discordRequest }),
              copyGuildEmoji: (input: {
                emoji: string;
                sourceGuild: string;
                destinationGuild: string;
                name?: string;
              }) =>
                copyGuildEmoji({
                  ...input,
                  discordRequest,
                }),
            }
          : {}),
        ...(reminderScheduler
          ? {
              createReminder: async (input) => {
                const reminder = await reminderScheduler.create({
                  ...input,
                  requesterUserId,
                  channelId: message.channel_id,
                });
                return {
                  id: reminder.id,
                  content: reminder.content,
                  nextRunAt: reminder.nextRunAt,
                  ...(reminder.cron ? { cron: reminder.cron } : {}),
                  ...(reminder.timezone ? { timezone: reminder.timezone } : {}),
                };
              },
              listReminders: async () =>
                (
                  await reminderScheduler.list(
                    requesterUserId,
                    message.channel_id,
                  )
                ).map((reminder) => ({
                  id: reminder.id,
                  content: reminder.content,
                  nextRunAt: reminder.nextRunAt,
                  ...(reminder.cron ? { cron: reminder.cron } : {}),
                  ...(reminder.timezone ? { timezone: reminder.timezone } : {}),
                })),
              cancelReminder: (reminderId: string) =>
                reminderScheduler.cancel(
                  requesterUserId,
                  message.channel_id,
                  reminderId,
                ),
            }
          : {}),
        ...(message.guild_id
          ? {
              joinVoiceChannel: () =>
                joinMemberVoiceChannel(message.guild_id!, requesterUserId),
              leaveVoiceChannel: () => leaveVoiceChannel(message.guild_id!),
            }
          : {}),
      });

      const job: ChatbotJob = {
        id: randomUUID(),
        requesterUserId,
        purpose: "answer",
        executionMode,
        executionTarget,
        mutationScope,
        repository: selectedRepository,
        channelId: message.channel_id,
        requestMessageId: message.id,
        request,
        requestMessage,
        messages,
        mcpAccessToken: mcpSession.token,
      };
      const dispatch = workflow.dispatch(job);

      if (dispatch.status === "offline") {
        return { ok: false as const, error: "The worker disconnected." };
      }

      if (dispatch.status === "busy") {
        return { ok: false as const, error: "The worker became busy." };
      }

      return dispatch.result;
    });
  } catch (error) {
    console.error(`Chatbot request ${message.id} failed:`, error);
    result = { ok: false, error: "聊天機器人請求失敗" };
  } finally {
    if (mcpSession) {
      mcpSnapshot = mcpSession.snapshot();
      mcpSession.revoke();
    }
    workflow.release();
  }
  let reacted = mcpSnapshot.reacted;
  let reply: string | null = null;
  const files = result.ok ? (result.files ?? []) : [];
  if (result.ok) {
    const decision = await executeChatbotAnswerDecision({
      content: result.content,
      message,
      reactionBroker,
      reactionCapabilities,
      discordRequest,
    });
    reply = decision.reply;
    reacted ||= decision.reacted;
  } else {
    reply = "我剛剛卡住了 晚點再叫我一次";
  }

  if (mcpSnapshot.searchUnavailable && reply) {
    reply = `我剛剛翻不到伺服器的舊訊息 這次回答可能不太完整\n\n${reply}`;
  }
  if (!reply && !reacted && files.length === 0) {
    reply = "我剛剛卡住了 晚點再叫我一次";
  }
  if (reply || files.length > 0) {
    await postChatbotResponse(
      message,
      reply ? formatDiscordAnswers(reply) : null,
      discordRequest,
      files,
    );
    conversationTracker?.activate(message.channel_id, requesterUserId);
  }

  return true;
}

export function createDiscordRequest(botToken: string): DiscordRequest {
  async function discordRequest<T>(
    path: string,
    options: { method?: string; body?: unknown; formData?: FormData } = {},
    retries = 3,
  ): Promise<T> {
    const headers: Record<string, string> = {
      Authorization: `Bot ${botToken}`,
    };

    if (options.body !== undefined) {
      headers["Content-Type"] = "application/json";
    }

    const response = await fetch(`${DISCORD_API_BASE_URL}${path}`, {
      method: options.method ?? "GET",
      headers,
      body:
        options.formData ??
        (options.body === undefined ? undefined : JSON.stringify(options.body)),
    });

    if (response.status === 429 && retries > 0) {
      const payload = (await response.json()) as { retry_after?: number };
      await Bun.sleep(Math.ceil((payload.retry_after ?? 1) * 1_000));
      return discordRequest<T>(path, options, retries - 1);
    }

    if (!response.ok) {
      throw new Error(`${response.status} ${await response.text()}`);
    }

    if (response.status === 204) {
      return undefined as T;
    }

    return (await response.json()) as T;
  }

  return discordRequest;
}
