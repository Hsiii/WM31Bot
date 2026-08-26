import { randomUUID } from "node:crypto";

import type { ChatbotAccessConfig } from "../../chatbot/access";
import {
  macAgentBridge,
  type MacAgentJobResult,
  type WorkflowLease,
} from "../../chatbot/bridge";
import { CHATBOT_CONTEXT_LIMITS } from "../../chatbot/context-limits";
import { ChatbotMediaRegistry } from "../../chatbot/media-assets";
import {
  registerChatbotMcpSession,
  type ChatbotGuildExpressionInput,
  type ChatbotMcpCapability,
  type ChatbotMcpSessionSnapshot,
} from "../../chatbot/mcp";
import {
  createTripPlannerClient,
  tripPlannerAvailableForGuild,
} from "../../chatbot/trip-planner";
import { getGuildMemoryStore } from "../../chatbot/guild-memory";
import type {
  ChatbotFailureKind,
  ChatbotAddressingMode,
  ChatbotExecutionRoute,
  ChatbotOutgoingFile,
  ChatbotJob,
  ChatbotMemberResult,
  ChatbotMessage,
  ChatbotTraceContext,
  ChatbotTaskProgress,
  AnswerJob,
  OracleAnswerJob,
} from "../../chatbot/protocol";
import { parseChatbotAnswerDecision } from "../../chatbot/answer-contract";

import {
  DiscordReactionBroker,
  type DiscordReactionCapabilities,
} from "../api/reactions";
import {
  addGuildEmojiFromMedia,
  addGuildStickerFromMedia,
  copyGuildEmoji,
  listGuildEmojis,
  listSharedEmojiGuilds,
  type ExpressionFetch,
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
import {
  ChannelQuietTracker,
  isChannelQuietRequest,
  isChannelWakeRequest,
} from "./channel-quiet";

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
export { parseChatbotAnswerDecision } from "../../chatbot/answer-contract";

const DISCORD_API_BASE_URL = "https://discord.com/api/v10";
const DISCORD_MESSAGE_LIMIT = 2_000;
const TYPING_REFRESH_MS = 8_000;
const ACTIVE_CONVERSATION_TTL_MS = 90_000;
const DEVELOPER_TASK_TTL_MS = 3 * 24 * 60 * 60_000;
const guildMemoryStore = getGuildMemoryStore();

export function chatbotFailureReply(kind: ChatbotFailureKind) {
  if (kind === "unavailable") {
    return "我現在暫時忙不過來 稍後再試一次";
  }
  if (kind === "timeout") {
    return "我沒等到操作結果 先確認一下再重試";
  }
  return "我這次沒完成 稍後再試一次";
}

function supplementalCapabilities({
  isOwner,
  hasAttachments,
  hasReactions,
  availableRepositories,
  chatbotRepository,
  executionRoute,
}: {
  isOwner: boolean;
  hasAttachments: boolean;
  hasReactions: boolean;
  availableRepositories: string[];
  chatbotRepository?: string;
  executionRoute: ChatbotExecutionRoute;
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
      availability: executionRoute === "oracle" ? "available" : "conditional",
      description:
        "Inspect repositories visible to the dedicated GitHub account and handle debugging, tests, builds, code changes, commits, feature-branch pushes, issue work, and draft pull requests.",
      condition:
        executionRoute === "oracle"
          ? "This owner request is running in Oracle."
          : "The owner must make a request that identifies an accessible repository.",
    });
  }
  if (isOwner && chatbotRepository) {
    capabilities.push({
      id: "self_development",
      category: "development",
      availability: executionRoute === "oracle" ? "available" : "conditional",
      description:
        "Inspect or change MiniSago's own behavior and implementation through her configured chatbot repository.",
      condition:
        executionRoute === "oracle"
          ? "This owner request is running in Oracle."
          : "The owner must explicitly request a change to MiniSago.",
    });
  }
  if (isOwner) {
    capabilities.push({
      id: "mac_file_delivery",
      category: "attachments",
      availability: executionRoute === "mac" ? "available" : "conditional",
      description:
        "Find and send one requested file from the owner's allowlisted Mac folders without reading its contents.",
      condition:
        executionRoute === "mac"
          ? "This request has already been routed to the connected Mac."
          : "The owner must explicitly request a file and a compatible Mac worker must be connected.",
    });
  }

  return capabilities;
}

type ActiveConversation = {
  requesterUserId: string;
  expiresAt: number;
  activeAfterSequence: number;
};

export class ChatbotConversationTracker {
  private conversations = new Map<string, ActiveConversation>();
  private receivedSequence = 0;

  constructor(
    private readonly ttlMs = ACTIVE_CONVERSATION_TTL_MS,
    private readonly now = () => Date.now(),
  ) {}

  recordMessage() {
    this.receivedSequence += 1;
    return this.receivedSequence;
  }

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
      activeAfterSequence: this.receivedSequence,
    });
  }

  take(message: DiscordMessage, receivedSequence: number) {
    const conversation = this.conversations.get(message.channel_id);
    if (!conversation) return false;

    if (receivedSequence <= conversation.activeAfterSequence) {
      return false;
    }

    this.conversations.delete(message.channel_id);
    return (
      conversation.expiresAt > this.now() &&
      message.author?.id === conversation.requesterUserId &&
      !message.mentions?.length
    );
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

export type ChatbotInvocation = {
  request: string;
  addressingMode: ChatbotAddressingMode;
  chatOnly?: boolean;
  recentContext?: boolean;
  silent?: boolean;
  respond?: (
    content: string | string[] | null,
    files?: ChatbotOutgoingFile[],
  ) => Promise<void>;
};

export function extractMentionRequest(
  content: string,
  botUserId: string,
  botRoleIds: ReadonlySet<string> = new Set(),
) {
  const mentionPattern = new RegExp(`<@!?${botUserId}>`, "g");
  let addressed = false;
  let request = content.replace(mentionPattern, () => {
    addressed = true;
    return "";
  });

  request = request.replace(/<@&(\d{17,20})>/gu, (mention, roleId) => {
    if (!botRoleIds.has(roleId)) return mention;
    addressed = true;
    return "";
  });

  return addressed ? request.trim() : null;
}

export function extractChatbotRequest(
  message: ChatbotMention,
  botUserId: string,
  accessConfig: ChatbotAccessConfig,
) {
  const content = message.content ?? "";
  const mentionRequest = extractMentionRequest(
    content,
    botUserId,
    accessConfig.roleIds,
  );

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

export function chatbotAddressingMode(
  message: ChatbotMention,
  botUserId: string,
  accessConfig: ChatbotAccessConfig,
): ChatbotAddressingMode | null {
  if (
    message.referenced_message?.author?.id === botUserId &&
    message.mentions?.some((user) => user.id === botUserId)
  ) {
    return "reply";
  }
  if (
    extractMentionRequest(
      message.content ?? "",
      botUserId,
      accessConfig.roleIds,
    ) !== null
  ) {
    return "mention";
  }
  if (!message.guild_id && message.author?.id === accessConfig.ownerUserId) {
    return "dm";
  }
  return null;
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

function splitDiscordAnswer(content: string) {
  const parts: string[] = [];
  let part: string[] = [];
  let fence: { marker: string; length: number } | undefined;

  const flush = () => {
    const value = part.join("\n").trim();
    if (value) {
      parts.push(value);
    }
    part = [];
  };

  for (const line of content.split(/\r?\n/u)) {
    const fenceMatch = line.match(/^ {0,3}(`{3,}|~{3,})/u);

    if (fence) {
      part.push(line);
      const closingFence = line.match(/^ {0,3}(`{3,}|~{3,})[ \t]*$/u)?.[1];
      if (
        closingFence?.startsWith(fence.marker) &&
        closingFence.length >= fence.length
      ) {
        fence = undefined;
      }
      continue;
    }

    if (fenceMatch?.[1]) {
      fence = {
        marker: fenceMatch[1][0]!,
        length: fenceMatch[1].length,
      };
      part.push(line);
      continue;
    }

    if (line.trim()) {
      part.push(line);
    } else {
      flush();
    }
  }

  flush();
  return parts;
}

export function formatDiscordAnswers(content: string) {
  return splitDiscordAnswer(normalizeDiscordAnswer(content))
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

type DeveloperTask = {
  id: string;
  threadId: string;
  requesterUserId: string;
  repository: string;
  request: string;
  job: OracleAnswerJob;
  workflow?: WorkflowLease;
  state: "running" | "stopping" | "stopped" | "completed" | "failed";
  summary: string;
  sessionId?: string;
  activeJobId?: string;
  nextRequest?: string;
  traceMessageIds: string[];
  messageQueue: Promise<void>;
  cleanupTimer?: ReturnType<typeof setTimeout>;
  revokeMcp: () => void;
  extendMcp: () => void;
  discordRequest: DiscordRequest;
};

export function developerThreadName(title?: string) {
  return title?.replace(/\s+/gu, " ").trim().slice(0, 100) || "Coding task";
}

async function createDeveloperThread(
  message: DiscordMessage,
  title: string | undefined,
  discordRequest: DiscordRequest,
) {
  const thread = await discordRequest<{ id: string }>(
    `/channels/${message.channel_id}/messages/${message.id}/threads`,
    {
      method: "POST",
      body: {
        name: developerThreadName(title),
        auto_archive_duration: 4320,
      },
    },
  );
  return thread.id;
}

class DeveloperTaskRegistry {
  private tasks = new Map<string, DeveloperTask>();

  has(threadId: string) {
    return this.tasks.has(threadId);
  }

  start(task: DeveloperTask) {
    this.tasks.set(task.threadId, task);
    this.launch(task, task.request);
  }

  async handle(message: DiscordMessage) {
    const task = this.tasks.get(message.channel_id);
    if (!task || message.author?.id !== task.requesterUserId) return false;
    if (message.author.bot || message.webhook_id) return false;
    const request = message.content?.trim() ?? "";
    if (!request) return true;

    if (/^(?:stop|pause|停止|暫停)[.!。！\s]*$/iu.test(request)) {
      if (task.state === "running" && task.activeJobId && task.workflow) {
        task.state = "stopping";
        task.summary =
          "Stopping after the current operation; work is preserved.";
        task.workflow.stop(task.activeJobId);
      } else {
        await this.post(task, "This coding task is not currently running.");
      }
      return true;
    }

    if (/^(?:status|進度|狀態)[?？\s]*$/iu.test(request)) {
      await this.post(task, this.status(task));
      return true;
    }

    if (task.state === "running" && task.activeJobId && task.workflow) {
      const activeJobId = task.activeJobId;
      if (await task.workflow.steer(activeJobId, request)) {
        task.summary = "Applying new direction to the active turn.";
      } else {
        task.nextRequest = task.nextRequest
          ? `${task.nextRequest}\n${request}`
          : request;
        if (task.activeJobId !== activeJobId && task.state !== "running") {
          const nextRequest = task.nextRequest;
          task.nextRequest = undefined;
          this.launch(task, nextRequest);
        }
      }
    } else if (task.state !== "stopping") {
      this.launch(task, request);
    }
    return true;
  }

  private launch(task: DeveloperTask, request: string) {
    void this.run(task, request).catch(async (error) => {
      task.state = "failed";
      task.summary = `Failed: ${
        error instanceof Error
          ? error.message.slice(0, 500)
          : "unexpected error"
      }`;
      this.releaseWorkflow(task);
      await this.finishWithoutAnswer(task, task.summary);
      this.scheduleCleanup(task);
    });
  }

  private async run(task: DeveloperTask, request: string) {
    if (task.cleanupTimer) {
      clearTimeout(task.cleanupTimer);
      task.cleanupTimer = undefined;
    }
    if (!task.sessionId && request !== task.request) {
      request = `${task.request}\n\nAdditional direction: ${request}`;
    }
    task.extendMcp();
    if (!task.workflow) {
      const acquired = macAgentBridge.acquireWorkflow(["dev"]);
      if (acquired.status !== "accepted") {
        task.state = "stopped";
        task.summary =
          acquired.status === "busy"
            ? "Waiting for an available coding worker. Reply `continue` to retry."
            : "The coding worker is offline. Reply `continue` when it is back.";
        await this.finishWithoutAnswer(task, task.summary);
        this.scheduleCleanup(task);
        return;
      }
      task.workflow = acquired.workflow;
      const route = task.workflow.route(["dev"], task.repository);
      if (route.status !== "accepted") {
        task.workflow.release();
        task.workflow = undefined;
        task.state = "stopped";
        task.summary = "The repository is not available on the coding worker.";
        await this.finishWithoutAnswer(task, task.summary);
        this.scheduleCleanup(task);
        return;
      }
    }

    const job: OracleAnswerJob = {
      ...task.job,
      id: randomUUID(),
      channelId: task.threadId,
      request,
      developerTask: {
        id: task.id,
        ...(task.job.developerTask?.title
          ? { title: task.job.developerTask.title }
          : {}),
        ...(task.sessionId ? { resumeSessionId: task.sessionId } : {}),
      },
    };
    task.state = "running";
    task.activeJobId = job.id;
    task.summary = task.sessionId
      ? "Continuing the preserved coding task."
      : "Preparing an isolated workspace.";
    const dispatch = task.workflow.dispatch(job, (progress) =>
      this.onProgress(task, progress),
    );
    if (dispatch.status !== "accepted") {
      task.state = "stopped";
      task.summary = "The coding worker could not start this turn.";
      this.releaseWorkflow(task);
      await this.finishWithoutAnswer(task, task.summary);
      this.scheduleCleanup(task);
      return;
    }

    const result = await dispatch.result;
    delete task.activeJobId;
    if (!result.ok && result.stopped) {
      await this.settleTrace(task, false);
      task.state = "stopped";
      task.summary = "Stopped. The workspace and Codex session are preserved.";
      this.releaseWorkflow(task);
      await this.post(task, task.summary);
      this.scheduleCleanup(task);
      return;
    }

    if (!result.ok) {
      task.state = "failed";
      task.summary = `Failed: ${result.error.slice(0, 500)}`;
      this.releaseWorkflow(task);
      await this.finishWithoutAnswer(task, task.summary);
      this.scheduleCleanup(task);
      return;
    }

    task.state = "completed";
    task.summary = "Completed. Reply in this thread to continue the same task.";
    await this.settleTrace(task, true);
    if (result.content.trim()) {
      for (const answer of formatDiscordAnswers(result.content)) {
        await this.post(task, answer);
      }
    }
    const nextRequest = task.nextRequest;
    task.nextRequest = undefined;
    if (nextRequest) {
      await this.run(task, nextRequest);
      return;
    }
    this.releaseWorkflow(task);
    this.scheduleCleanup(task);
  }

  private onProgress(task: DeveloperTask, progress: ChatbotTaskProgress) {
    if (progress.sessionId) task.sessionId = progress.sessionId;
    task.summary = progress.summary;
    if (progress.kind === "trace") this.postTrace(task, progress.summary);
  }

  private releaseWorkflow(task: DeveloperTask) {
    task.workflow?.release();
    task.workflow = undefined;
  }

  private scheduleCleanup(task: DeveloperTask) {
    if (task.cleanupTimer) clearTimeout(task.cleanupTimer);
    task.cleanupTimer = setTimeout(() => {
      task.revokeMcp();
      this.tasks.delete(task.threadId);
    }, DEVELOPER_TASK_TTL_MS);
    task.cleanupTimer.unref?.();
  }

  private status(task: DeveloperTask) {
    const state =
      task.state === "running"
        ? "Working"
        : task.state === "stopping"
          ? "Stopping"
          : task.state === "stopped"
            ? "Stopped"
            : task.state === "completed"
              ? "Complete"
              : "Failed";
    return `**${state} · ${task.repository}**\n${task.summary}\n\nReply here to steer me. Say \`stop\` to pause or \`status\` for an update.`;
  }

  private postTrace(task: DeveloperTask, content: string) {
    task.messageQueue = task.messageQueue
      .then(async () => {
        const message = await task.discordRequest<{ id: string }>(
          `/channels/${task.threadId}/messages`,
          {
            method: "POST",
            body: {
              content: formatDiscordAnswer(content),
              allowed_mentions: { parse: [] },
            },
          },
        );
        task.traceMessageIds.push(message.id);
      })
      .catch(() => undefined);
  }

  private async settleTrace(task: DeveloperTask, removeMessages: boolean) {
    await task.messageQueue.catch(() => undefined);
    task.messageQueue = Promise.resolve();
    const messageIds = task.traceMessageIds.splice(0);
    if (!removeMessages) return;
    await Promise.all(
      messageIds.map((messageId) =>
        task
          .discordRequest(`/channels/${task.threadId}/messages/${messageId}`, {
            method: "DELETE",
          })
          .catch(() => undefined),
      ),
    );
  }

  private async finishWithoutAnswer(task: DeveloperTask, content: string) {
    await this.settleTrace(task, false);
    await this.post(task, content);
  }

  private async post(task: DeveloperTask, content: string) {
    await task.discordRequest(`/channels/${task.threadId}/messages`, {
      method: "POST",
      body: { content, allowed_mentions: { parse: [] } },
    });
  }
}

const developerTasks = new DeveloperTaskRegistry();

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

export async function addGuildExpressionForRequest({
  input,
  guildId,
  mediaRegistry,
  discordRequest,
  fetchEmoji,
}: {
  input: ChatbotGuildExpressionInput;
  guildId: string;
  mediaRegistry: ChatbotMediaRegistry;
  discordRequest: DiscordRequest;
  fetchEmoji?: ExpressionFetch;
}) {
  const destinationGuild = input.destinationGuild ?? guildId;

  if (input.emoji || input.sourceGuild) {
    if (input.kind === "sticker") {
      throw new Error(
        "Existing sticker copying is not supported; attach the sticker file instead.",
      );
    }
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
      fetchEmoji,
    });
  }

  if (!input.mediaId) {
    throw new Error(
      "Provide mediaId from an attachment, member avatar, or media tool output.",
    );
  }
  const media = await mediaRegistry.read(input.mediaId, fetchEmoji);
  if (input.kind === "sticker") {
    if (!input.tags) {
      throw new Error(
        "Provide a related Unicode emoji or search tag for the sticker.",
      );
    }
    return addGuildStickerFromMedia({
      destinationGuild,
      media,
      name: input.name,
      description: input.description,
      tags: input.tags,
      discordRequest,
    });
  }
  return addGuildEmojiFromMedia({
    destinationGuild,
    media,
    name: input.name,
    discordRequest,
  });
}

export async function handleChatbotMention({
  message,
  botUserId,
  discordRequest,
  accessConfig,
  reactionBroker,
  conversationTracker,
  quietTracker,
  receivedSequence,
  invocation,
}: {
  message: ChatbotMention;
  botUserId: string;
  discordRequest: DiscordRequest;
  accessConfig: ChatbotAccessConfig;
  reactionBroker?: DiscordReactionBroker;
  conversationTracker?: ChatbotConversationTracker;
  quietTracker?: ChannelQuietTracker;
  receivedSequence?: number;
  invocation?: ChatbotInvocation;
}) {
  const requesterUserId = message.author?.id;
  const respond = (
    content: string | string[] | null,
    files: ChatbotOutgoingFile[] = [],
  ) =>
    invocation?.respond
      ? invocation.respond(content, files)
      : postChatbotResponse(message, content, discordRequest, files);

  if (!requesterUserId || message.author?.bot || message.webhook_id) {
    return false;
  }

  if (!invocation && developerTasks.has(message.channel_id)) {
    return developerTasks.handle(message);
  }

  let addressingMode =
    invocation?.addressingMode ??
    chatbotAddressingMode(message, botUserId, accessConfig);
  let request =
    invocation?.request ??
    extractChatbotRequest(message, botUserId, accessConfig);
  if (
    request === null &&
    receivedSequence !== undefined &&
    conversationTracker?.take(message, receivedSequence)
  ) {
    request = message.content?.trim() ?? "";
    addressingMode = "continuation";
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

    const content = `在這個伺服器裡我暫時只聽 <@${accessConfig.ownerUserId}> 的 抱歉啦`;
    await respond(content);
    return true;
  }

  if (quietTracker?.isPaused(message.channel_id)) {
    if (
      addressingMode !== "continuation" &&
      isChannelWakeRequest(request || message.content || "")
    ) {
      quietTracker.wake(message.channel_id);
    } else {
      return true;
    }
  }

  const acquired = macAgentBridge.acquireWorkflow();

  if (acquired.status === "offline") {
    const content = "我現在沒接上工作機 晚點再叫我一次 💤";
    await respond(content);
    return true;
  }

  if (acquired.status === "busy") {
    const content = "我正在幫別人做事 等我一下下";
    await respond(content);
    return true;
  }

  const { workflow } = acquired;
  let result: MacAgentJobResult;
  let deferredDeveloperTask = false;
  let mcpSession: ReturnType<typeof registerChatbotMcpSession> | undefined;
  let mcpSnapshot: ChatbotMcpSessionSnapshot = {
    searchUnavailable: false,
  };
  let reactionCapabilities: DiscordReactionCapabilities | undefined;
  try {
    const execute = async () => {
      const requestMessage = toChatbotMessage(message, botUserId);
      let messages = invocation?.recentContext
        ? await getRecentHumanMessages({
            channelId: message.channel_id,
            requestMessageId: message.id,
            botUserId,
            discordRequest,
            messageLimit: CHATBOT_CONTEXT_LIMITS.nearbyMessages,
          })
        : message.guild_id
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
      const mediaRegistry = new ChatbotMediaRegistry();
      mediaRegistry.registerMessages([requestMessage, ...messages]);
      let serverMemory: ChatbotJob["serverMemory"];
      if (message.guild_id) {
        try {
          const snapshot = await guildMemoryStore.load(message.guild_id);
          if (snapshot.entries.length) {
            serverMemory = {
              revision: snapshot.revision,
              entries: snapshot.entries.map(({ id, content }) => ({
                id,
                content,
              })),
            };
          }
        } catch {
          console.warn("Discord server memory unavailable.");
        }
      }
      let executionRoute: ChatbotExecutionRoute = "chat";
      let selectedRepository: string | undefined;
      let developerThreadTitle: string | undefined;

      if (
        requesterUserId === accessConfig.ownerUserId &&
        !invocation?.chatOnly &&
        !isChannelQuietRequest(request)
      ) {
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
        executionRoute = route.route === "unclear" ? "chat" : route.route;
        selectedRepository = route.repository;
        developerThreadTitle = route.threadTitle;

        const missingRepository = missingDeveloperRepositoryResponse(
          route.route,
          selectedRepository,
          workflow.availableRepositories,
        );
        if (missingRepository) {
          return { ok: true as const, content: missingRepository };
        }
        const workerRoute = workflow.route(
          [
            executionRoute === "oracle" ? "dev" : "chat",
            ...(executionRoute === "mac" ? (["mac"] as const) : []),
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
            failureKind: "unavailable" as const,
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

      const recentMessages = async (historyCount: number) => {
        const resolved = await (historyCount <=
        CHATBOT_CONTEXT_LIMITS.nearbyMessages
          ? Promise.resolve(
              historyCount === 0 ? [] : messages.slice(-historyCount),
            )
          : getRecentHumanMessages({
              channelId: message.channel_id,
              requestMessageId: message.id,
              botUserId,
              discordRequest,
              messageLimit: historyCount,
            }));
        mediaRegistry.registerMessages(resolved);
        return resolved;
      };
      const searchMessages = message.guild_id
        ? async (queries: DiscordSearchQuery[]) => {
            const resolved = await searchGuildMessages({
              guildId: message.guild_id!,
              requesterUserId,
              requesterRoleIds: message.member?.roles,
              currentChannelId: message.channel_id,
              requestMessageId: message.id,
              queries,
              discordRequest,
            });
            mediaRegistry.registerMessages(resolved);
            return resolved;
          }
        : undefined;
      const lookupMembers = message.guild_id
        ? async (queries: string[]) => {
            const resolved = await lookupGuildMembers({
              guildId: message.guild_id!,
              queries,
              discordRequest,
            });
            return resolved.map(({ avatarUrl, ...result }) => {
              const avatarUrl128 = new URL(avatarUrl);
              avatarUrl128.pathname = avatarUrl128.pathname.replace(
                /\.[^.]+$/u,
                ".png",
              );
              avatarUrl128.searchParams.set("size", "128");
              return {
                ...result,
                avatar: mediaRegistry.registerUrl({
                  filename: `${result.names[0] ?? "member"}-avatar.png`,
                  contentType: "image/png",
                  url: avatarUrl128.toString(),
                }),
              };
            });
          }
        : undefined;
      const reminderScheduler = getChatbotReminderScheduler();
      const tripPlanner = tripPlannerAvailableForGuild(message.guild_id)
        ? createTripPlannerClient(process.env, `minisago-${message.id}`)
        : undefined;

      mcpSession = registerChatbotMcpSession({
        mediaRegistry,
        getPreviousTrace: async () => previousTrace,
        getCodexUsage: () => workflow.getCodexUsage(),
        ...(quietTracker
          ? {
              pauseChannelActivity: (durationMinutes?: number) =>
                quietTracker.pause(message.channel_id, durationMinutes),
            }
          : {}),
        ...(tripPlanner
          ? {
              readTripPlan: tripPlanner.read,
              ...(tripPlanner.edit ? { editTripPlan: tripPlanner.edit } : {}),
            }
          : {}),
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
              addGuildExpression: (input: ChatbotGuildExpressionInput) =>
                addGuildExpressionForRequest({
                  input,
                  guildId: message.guild_id!,
                  mediaRegistry,
                  discordRequest,
                }),
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
        ...(message.guild_id
          ? {
              manageServerMemory: async (
                input:
                  | { action: "add"; content: string }
                  | {
                      action: "replace";
                      entryId: string;
                      content: string;
                    }
                  | { action: "remove"; entryId: string },
              ) => {
                const result = await guildMemoryStore.mutate(
                  message.guild_id!,
                  input,
                  message.id,
                  requesterUserId,
                );
                return {
                  revision: result.revision,
                  action: result.action,
                  entryId: result.entryId,
                };
              },
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
            executionRoute,
          }),
      });
      if (executionRoute === "oracle") mcpSession.extend(DEVELOPER_TASK_TTL_MS);
      const answerBase = {
        id: randomUUID(),
        requesterUserId,
        purpose: "answer" as const,
        channelId: message.channel_id,
        requestMessageId: message.id,
        request,
        ...(addressingMode ? { addressingMode } : {}),
        requestMessage,
        messages,
        mcpAccessToken: mcpSession.token,
        ...(reactionCapabilities?.tools.length
          ? { availableTools: reactionCapabilities.tools }
          : {}),
        ...(serverMemory ? { serverMemory } : {}),
      };
      let job: AnswerJob;
      if (executionRoute === "oracle") {
        const repository = selectedRepository;
        if (!repository) {
          return {
            ok: false as const,
            error: "The router selected Oracle without a repository.",
            failureKind: "internal" as const,
          };
        }
        job = {
          ...answerBase,
          executionRoute,
          repository,
        };
      } else if (executionRoute === "mac") {
        job = { ...answerBase, executionRoute };
      } else {
        job = { ...answerBase, executionRoute };
      }

      if (job.executionRoute === "oracle" && message.guild_id) {
        const taskId = randomUUID();
        const threadId = await createDeveloperThread(
          message,
          developerThreadTitle,
          discordRequest,
        );
        deferredDeveloperTask = true;
        developerTasks.start({
          id: taskId,
          threadId,
          requesterUserId,
          repository: job.repository,
          request,
          job: {
            ...job,
            developerTask: {
              id: taskId,
              title: developerThreadName(developerThreadTitle),
            },
          },
          workflow,
          state: "running",
          summary: "Preparing an isolated workspace.",
          traceMessageIds: [],
          messageQueue: Promise.resolve(),
          revokeMcp: () => mcpSession?.revoke(),
          extendMcp: () => mcpSession?.extend(DEVELOPER_TASK_TTL_MS),
          discordRequest,
        });
        return { ok: true as const, content: "" };
      }
      const dispatch = workflow.dispatch(job);

      if (dispatch.status === "offline") {
        return {
          ok: false as const,
          error: "The worker disconnected.",
          failureKind: "unavailable" as const,
        };
      }

      if (dispatch.status === "busy") {
        return {
          ok: false as const,
          error: "The worker became busy.",
          failureKind: "unavailable" as const,
        };
      }

      return dispatch.result;
    };
    result = invocation?.silent
      ? await execute()
      : await withTyping(message.channel_id, discordRequest, execute);
  } catch (error) {
    console.error(`Chatbot request ${message.id} failed:`, error);
    result = {
      ok: false,
      error: "聊天機器人請求失敗",
      failureKind: "internal",
    };
  } finally {
    if (mcpSession && !deferredDeveloperTask) {
      mcpSnapshot = mcpSession.snapshot();
      mcpSession.revoke();
    }
    if (!deferredDeveloperTask) workflow.release();
  }
  if (deferredDeveloperTask) return true;
  if (quietTracker?.isPaused(message.channel_id)) return true;
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
    reply = chatbotFailureReply(result.failureKind);
  }

  if (mcpSnapshot.searchUnavailable && reply) {
    reply = `我剛剛翻不到伺服器的舊訊息 這次回答可能不太完整\n\n${reply}`;
  }
  if (!reply && !reacted && files.length === 0) {
    reply = "我剛剛卡住了 晚點再叫我一次";
  }
  if (reply || files.length > 0) {
    const content = reply ? formatDiscordAnswers(reply) : null;
    await respond(content, files);
    if (!invocation) {
      conversationTracker?.activate(message.channel_id, requesterUserId);
    }
  }

  return true;
}

export function createDiscordRequest(botToken: string): DiscordRequest {
  async function discordRequest<T>(
    path: string,
    options: {
      method?: string;
      body?: unknown;
      formData?: FormData;
      authenticated?: boolean;
    } = {},
    retries = 3,
  ): Promise<T> {
    const headers: Record<string, string> = {};
    if (options.authenticated !== false) {
      headers.Authorization = `Bot ${botToken}`;
    }

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
