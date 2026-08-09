import { randomUUID } from "node:crypto";

import type { ChatbotAccessConfig } from "../../chatbot/access";
import { macAgentBridge, type MacAgentJobResult } from "../../chatbot/bridge";
import { CHATBOT_CONTEXT_LIMITS } from "../../chatbot/context-limits";
import {
  registerChatbotMcpSession,
  type ChatbotMcpCapability,
  type ChatbotMcpSessionSnapshot,
} from "../../chatbot/mcp";
import type {
  ChatbotExecutionMode,
  ChatbotExecutionTarget,
  ChatbotMutationScope,
  ChatbotOutgoingFile,
  ChatbotJob,
  ChatbotMemberResult,
  ChatbotMessage,
  ChatbotTraceContext,
} from "../../chatbot/protocol";
import {
  DiscordReactionBroker,
  type DiscordReactionCapabilities,
} from "../api/reactions";
import {
  addGuildEmojiFromAttachment,
  copyGuildEmoji,
  listGuildEmojis,
  listSharedEmojiGuilds,
  selectEmojiImageAttachment,
} from "../api/emojis";
import { getChatbotReminderScheduler } from "../jobs/reminders";
import { sendChannelMessage } from "../api/channel-messages";
import { joinMemberVoiceChannel, leaveVoiceChannel } from "../api/voice";
import {
  getNearbyHumanMessages,
  getRecentHumanMessages,
  lookupGuildMembers,
  searchGuildMessages,
  toChatbotMessage,
  type DiscordMessage,
  type DiscordRequest,
  type DiscordSearchQuery,
} from "./chatbot-context";
import {
  missingDeveloperRepositoryResponse,
  parseExecutionRoute,
  parsePreviousTraceLookup,
} from "./chatbot-routing";

export {
  canMemberSearchChannel,
  getNearbyHumanMessages,
  getRecentHumanMessages,
  isConversationContextMessage,
  isHumanContextMessage,
  lookupGuildMembers,
  searchGuildMessages,
  toChatbotMessage,
} from "./chatbot-context";
export type { DiscordRequest, DiscordSearchQuery } from "./chatbot-context";
export {
  missingDeveloperRepositoryResponse,
  parseExecutionRoute,
  parsePreviousTraceLookup,
} from "./chatbot-routing";

const DISCORD_API_BASE_URL = "https://discord.com/api/v10";
const DISCORD_MESSAGE_LIMIT = 2_000;
const TYPING_REFRESH_MS = 8_000;
const ACTIVE_CONVERSATION_TTL_MS = 90_000;

function supplementalCapabilities({
  isOwner,
  hasAttachments,
  hasReactions,
  availableRepositories,
  chatbotRepository,
  executionMode,
  executionTarget,
}: {
  isOwner: boolean;
  hasAttachments: boolean;
  hasReactions: boolean;
  availableRepositories: string[];
  chatbotRepository?: string;
  executionMode: ChatbotExecutionMode;
  executionTarget: ChatbotExecutionTarget;
}): ChatbotMcpCapability[] {
  const capabilities: ChatbotMcpCapability[] = [
    {
      id: "conversation",
      category: "conversation",
      availability: "available",
      description:
        "Answer, explain, write, reason, and use the supplied nearby Discord conversation while matching the requester's language.",
    },
  ];

  if (hasReactions) {
    capabilities.push({
      id: "message_reactions",
      category: "discord",
      availability: "available",
      description:
        "React to the current Discord message with one host-approved Unicode or custom emoji when a reaction is useful.",
    });
  }
  capabilities.push(
    {
      id: "attachment_understanding",
      category: "attachments",
      availability: hasAttachments ? "available" : "conditional",
      description:
        "Read supported extracted text and attachment metadata supplied with a request.",
      ...(!hasAttachments
        ? { condition: "The request must include or reply to an attachment." }
        : {}),
    },
    {
      id: "media_processing",
      category: "attachments",
      availability: "conditional",
      description:
        "Inspect or transform request-local images, audio, and video with bounded offline tools, including image conversion, video frames, transcoding, and Python-based analysis.",
      condition:
        "A supported attachment and a compatible chat worker are required; outputs are temporary and bounded.",
    },
  );
  if (isOwner && availableRepositories.length > 0) {
    capabilities.push({
      id: "repository_work",
      category: "development",
      availability: executionMode === "dev" ? "available" : "conditional",
      description:
        "Inspect configured repositories and handle debugging, tests, builds, code changes, commits, feature-branch pushes, and draft pull requests within the routed permission scope.",
      condition:
        executionMode === "dev"
          ? "This request has already been routed to development mode."
          : "The owner must make an explicit request that identifies a configured repository.",
    });
  }
  if (isOwner && chatbotRepository) {
    capabilities.push({
      id: "self_development",
      category: "development",
      availability: executionMode === "dev" ? "available" : "conditional",
      description:
        "Inspect or change MiniSago's own behavior and implementation through her configured chatbot repository.",
      condition:
        executionMode === "dev"
          ? "This request has already been routed to development mode."
          : "The owner must explicitly request a change to MiniSago.",
    });
  }
  if (isOwner) {
    capabilities.push({
      id: "mac_file_delivery",
      category: "attachments",
      availability: executionTarget === "mac" ? "available" : "conditional",
      description:
        "Find and send one requested file from the owner's allowlisted Mac folders without reading its contents.",
      condition:
        executionTarget === "mac"
          ? "This request has already been routed to the connected Mac."
          : "The owner must explicitly request a file and a compatible Mac worker must be connected.",
    });
  }

  return capabilities;
}

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
      message.author?.id === conversation.requesterUserId &&
      !message.mentions?.length
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
      const reminderScheduler = getChatbotReminderScheduler();

      mcpSession = registerChatbotMcpSession({
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
        ...(requesterUserId === accessConfig.ownerUserId && message.guild_id
          ? {
              listSharedGuilds: async () =>
                (await listSharedEmojiGuilds(discordRequest)).map((guild) => ({
                  ...guild,
                  current: guild.id === message.guild_id,
                })),
              listGuildEmojis: (guild: string) =>
                listGuildEmojis({ guild, discordRequest }),
              addGuildEmoji: (input: {
                emoji?: string;
                sourceGuild?: string;
                destinationGuild?: string;
                name?: string;
                attachment?: string;
              }) => {
                const destinationGuild =
                  input.destinationGuild ?? message.guild_id!;
                if (input.emoji || input.sourceGuild) {
                  if (!input.emoji || !input.sourceGuild) {
                    throw new Error(
                      "Provide both sourceGuild and emoji when copying an existing emoji.",
                    );
                  }
                  return copyGuildEmoji({
                    emoji: input.emoji,
                    sourceGuild: input.sourceGuild,
                    destinationGuild,
                    name: input.name,
                    discordRequest,
                  });
                }
                const attachment = selectEmojiImageAttachment({
                  attachments: requestMessage.attachments,
                  referencedAttachments:
                    requestMessage.referencedMessage?.attachments,
                  selector: input.attachment,
                });
                return addGuildEmojiFromAttachment({
                  destinationGuild,
                  attachment,
                  name: input.name,
                  discordRequest,
                });
              },
            }
          : {}),
        ...(requesterUserId === accessConfig.ownerUserId
          ? {
              sendChannelMessage: (input: {
                content: string;
                channelId?: string;
                server?: string;
                channel?: string;
              }) => sendChannelMessage({ ...input, discordRequest }),
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
        describeCapabilities: () =>
          supplementalCapabilities({
            isOwner: requesterUserId === accessConfig.ownerUserId,
            hasAttachments:
              requestMessage.attachments.length > 0 ||
              Boolean(requestMessage.referencedMessage?.attachments.length),
            hasReactions: Boolean(reactionCapabilities?.tools.length),
            availableRepositories: workflow.availableRepositories,
            chatbotRepository: workflow.chatbotRepository,
            executionMode,
            executionTarget,
          }),
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
        ...(reactionCapabilities?.tools.length
          ? { availableTools: reactionCapabilities.tools }
          : {}),
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
  let reacted = false;
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
