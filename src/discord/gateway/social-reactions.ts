import { randomUUID } from "node:crypto";

import type { ChatbotAccessConfig } from "../../chatbot/access";
import {
  macAgentBridge,
  type DispatchResult,
  type MacAgentJobResult,
} from "../../chatbot/bridge";
import type { ChatbotJob, ChatbotMessage } from "../../chatbot/protocol";
import {
  getNearbyHumanMessages,
  isChatbotAuthorized,
  toChatbotMessage,
  type ChatbotMention,
  type DiscordRequest,
} from "./chatbot";
import {
  DiscordReactionBroker,
  type DiscordReactionCapabilities,
} from "../api/reactions";

const HOUR_MS = 60 * 60_000;

export type AmbientReactionPolicy = {
  attentionProbability: number;
  minimumAttentionDelayMs: number;
  maximumAttentionDelayMs: number;
  missedNotificationCooldownMs: number;
  globalAttentionCooldownMs: number;
  maximumMessageAgeMs: number;
  reactionChannelCooldownMs: number;
  reactionUserCooldownMs: number;
  maximumEvaluationsPerHour: number;
  maximumReactionsPerHour: number;
  maximumBufferedChannels: number;
  maximumBufferedMessagesPerChannel: number;
  capabilityCacheMs: number;
};

export const DEFAULT_AMBIENT_REACTION_POLICY: AmbientReactionPolicy = {
  attentionProbability: 0.25,
  minimumAttentionDelayMs: 20_000,
  maximumAttentionDelayMs: 90_000,
  missedNotificationCooldownMs: 5 * 60_000,
  globalAttentionCooldownMs: 5 * 60_000,
  maximumMessageAgeMs: 10 * 60_000,
  reactionChannelCooldownMs: 15 * 60_000,
  reactionUserCooldownMs: 30 * 60_000,
  maximumEvaluationsPerHour: 4,
  maximumReactionsPerHour: 3,
  maximumBufferedChannels: 20,
  maximumBufferedMessagesPerChannel: 12,
  capabilityCacheMs: 10 * 60_000,
};

type SocialActionDecision =
  | { action: "ignore"; messageId: null; emoji: null }
  | {
      action: "discord.add_reaction";
      messageId: string;
      emoji: string;
    };

type BufferedChannel = {
  messages: ChatbotMention[];
  botUserId: string;
  discordRequest: DiscordRequest;
};

type ObserveAmbientMessageOptions = {
  message: ChatbotMention;
  botUserId: string;
  accessConfig: ChatbotAccessConfig;
  discordRequest: DiscordRequest;
};

type TimerHandle = unknown;

function configuredNumber({
  environment,
  name,
  fallback,
  minimum,
  maximum,
  integer = false,
}: {
  environment: NodeJS.ProcessEnv;
  name: string;
  fallback: number;
  minimum: number;
  maximum: number;
  integer?: boolean;
}) {
  const raw = environment[name]?.trim();
  if (!raw) return fallback;
  const value = Number(raw);
  if (
    !Number.isFinite(value) ||
    value < minimum ||
    value > maximum ||
    (integer && !Number.isInteger(value))
  ) {
    throw new Error(
      `${name} must be ${integer ? "an integer" : "a number"} from ${minimum} to ${maximum}.`,
    );
  }
  return value;
}

export function getAmbientReactionPolicy(
  environment: NodeJS.ProcessEnv = process.env,
): AmbientReactionPolicy {
  return {
    ...DEFAULT_AMBIENT_REACTION_POLICY,
    attentionProbability: configuredNumber({
      environment,
      name: "MINISAGO_AMBIENT_ATTENTION_CHANCE",
      fallback: DEFAULT_AMBIENT_REACTION_POLICY.attentionProbability,
      minimum: 0,
      maximum: 1,
    }),
    maximumEvaluationsPerHour: configuredNumber({
      environment,
      name: "MINISAGO_AMBIENT_MAX_CHECKS_PER_HOUR",
      fallback: DEFAULT_AMBIENT_REACTION_POLICY.maximumEvaluationsPerHour,
      minimum: 0,
      maximum: 60,
      integer: true,
    }),
  };
}

function parseSocialActionDecision(content: string): SocialActionDecision {
  try {
    const value = JSON.parse(content) as {
      action?: unknown;
      messageId?: unknown;
      emoji?: unknown;
    };
    if (
      value.action === "ignore" &&
      value.messageId === null &&
      value.emoji === null
    ) {
      return { action: "ignore", messageId: null, emoji: null };
    }
    if (
      value.action === "discord.add_reaction" &&
      typeof value.messageId === "string" &&
      typeof value.emoji === "string"
    ) {
      return {
        action: value.action,
        messageId: value.messageId,
        emoji: value.emoji.trim(),
      };
    }
  } catch {
    // Invalid model output is always a no-op.
  }
  return { action: "ignore", messageId: null, emoji: null };
}

function freshHumanMessage(
  message: ChatbotMention,
  botUserId: string,
  now: number,
  maximumAgeMs: number,
) {
  if (
    !message.guild_id ||
    !message.author?.id ||
    message.author.id === botUserId ||
    message.author.bot ||
    message.webhook_id
  ) {
    return false;
  }
  if (
    !message.content?.trim() &&
    !message.attachments?.length &&
    !message.embeds?.length &&
    !message.sticker_items?.length
  ) {
    return false;
  }
  const timestamp = Date.parse(message.timestamp);
  return (
    Number.isFinite(timestamp) &&
    timestamp <= now + 30_000 &&
    now - timestamp <= maximumAgeMs
  );
}

function pruneWindow(values: number[], cutoff: number) {
  while (values[0] !== undefined && values[0] < cutoff) values.shift();
}

function pruneTimes(values: Map<string, number>, cutoff: number) {
  for (const [key, timestamp] of values) {
    if (timestamp < cutoff) values.delete(key);
  }
}

function pruneDeadlines(values: Map<string, number>, now: number) {
  for (const [key, deadline] of values) {
    if (deadline <= now) values.delete(key);
  }
}

function mergeContext(nearby: ChatbotMessage[], candidates: ChatbotMessage[]) {
  const messages = new Map<string, ChatbotMessage>();
  for (const message of [...nearby, ...candidates]) {
    messages.set(message.id, message);
  }
  return [...messages.values()]
    .sort((left, right) => left.timestamp.localeCompare(right.timestamp))
    .slice(-20);
}

export class AmbientReactionController {
  private attentionTimer: TimerHandle | undefined;
  private buffers = new Map<string, BufferedChannel>();
  private evaluationTimes: number[] = [];
  private globalAttentionAvailableAt = 0;
  private lastReactionByChannel = new Map<string, number>();
  private lastReactionByUser = new Map<string, number>();
  private missedUntilByChannel = new Map<string, number>();
  private reactionTimes: number[] = [];
  private reactionBroker: DiscordReactionBroker;
  private scheduledChannelId: string | undefined;

  constructor(
    private readonly options: {
      now?: () => number;
      random?: () => number;
      schedule?: (task: () => void, delayMs: number) => TimerHandle;
      cancel?: (handle: TimerHandle) => void;
      dispatch?: (job: ChatbotJob) => DispatchResult;
      reactionBroker?: DiscordReactionBroker;
      policy?: AmbientReactionPolicy;
      log?: (event: Record<string, unknown>) => void;
    } = {},
  ) {
    this.reactionBroker =
      options.reactionBroker ??
      new DiscordReactionBroker({
        now: options.now,
        cacheMs: options.policy?.capabilityCacheMs,
      });
  }

  private get now() {
    return this.options.now ?? Date.now;
  }

  private get policy() {
    return this.options.policy ?? DEFAULT_AMBIENT_REACTION_POLICY;
  }

  private get random() {
    return this.options.random ?? Math.random;
  }

  private schedule(task: () => void, delayMs: number) {
    return (this.options.schedule ?? setTimeout)(task, delayMs);
  }

  private log(event: Record<string, unknown>) {
    (
      this.options.log ??
      ((value) =>
        console.log("MiniSago ambient attention:", JSON.stringify(value)))
    )(event);
  }

  stop() {
    if (this.attentionTimer !== undefined) {
      (
        this.options.cancel ??
        ((handle) => clearTimeout(handle as ReturnType<typeof setTimeout>))
      )(this.attentionTimer);
    }
    this.attentionTimer = undefined;
    this.scheduledChannelId = undefined;
    this.buffers.clear();
  }

  private prune(now: number) {
    const policy = this.policy;
    pruneWindow(this.evaluationTimes, now - HOUR_MS);
    pruneWindow(this.reactionTimes, now - HOUR_MS);
    pruneTimes(
      this.lastReactionByChannel,
      now - policy.reactionChannelCooldownMs,
    );
    pruneTimes(this.lastReactionByUser, now - policy.reactionUserCooldownMs);
    pruneDeadlines(this.missedUntilByChannel, now);
    for (const [channelId, buffer] of this.buffers) {
      buffer.messages = buffer.messages.filter((message) =>
        freshHumanMessage(
          message,
          buffer.botUserId,
          now,
          policy.maximumMessageAgeMs,
        ),
      );
      if (buffer.messages.length === 0) this.buffers.delete(channelId);
    }
  }

  private bufferMessage(
    message: ChatbotMention,
    botUserId: string,
    discordRequest: DiscordRequest,
  ) {
    const current = this.buffers.get(message.channel_id);
    const messages = current?.messages ?? [];
    messages.push(message);
    this.buffers.delete(message.channel_id);
    this.buffers.set(message.channel_id, {
      messages: messages.slice(-this.policy.maximumBufferedMessagesPerChannel),
      botUserId,
      discordRequest,
    });
    while (this.buffers.size > this.policy.maximumBufferedChannels) {
      const oldest = this.buffers.keys().next().value;
      if (!oldest) break;
      this.buffers.delete(oldest);
    }
  }

  observe({
    message,
    botUserId,
    accessConfig,
    discordRequest,
  }: ObserveAmbientMessageOptions) {
    const now = this.now();
    const policy = this.policy;
    const authorId = message.author?.id;
    this.prune(now);
    if (
      !authorId ||
      !freshHumanMessage(message, botUserId, now, policy.maximumMessageAgeMs) ||
      !message.guild_id ||
      !(
        accessConfig.guildIds.has(message.guild_id) ||
        accessConfig.channelIds.has(message.channel_id)
      ) ||
      !isChatbotAuthorized(
        authorId,
        accessConfig,
        message.guild_id,
        message.channel_id,
      )
    ) {
      return false;
    }

    this.bufferMessage(message, botUserId, discordRequest);
    if (
      this.attentionTimer !== undefined ||
      now < this.globalAttentionAvailableAt ||
      now < (this.missedUntilByChannel.get(message.channel_id) ?? 0) ||
      this.evaluationTimes.length >= policy.maximumEvaluationsPerHour ||
      this.reactionTimes.length >= policy.maximumReactionsPerHour
    ) {
      return false;
    }

    if (this.random() >= policy.attentionProbability) {
      this.missedUntilByChannel.set(
        message.channel_id,
        now + policy.missedNotificationCooldownMs,
      );
      return false;
    }

    const delayRange =
      policy.maximumAttentionDelayMs - policy.minimumAttentionDelayMs;
    const delay =
      policy.minimumAttentionDelayMs +
      Math.floor(this.random() * (delayRange + 1));
    this.scheduledChannelId = message.channel_id;
    this.attentionTimer = this.schedule(() => {
      const channelId = this.scheduledChannelId;
      this.attentionTimer = undefined;
      this.scheduledChannelId = undefined;
      if (!channelId) return;
      void this.checkNotifications(channelId).catch((error) => {
        this.log({
          action: "attention_failed",
          channelId,
          error: error instanceof Error ? error.message : "unknown error",
        });
      });
    }, delay);
    this.log({
      action: "attention_scheduled",
      channelId: message.channel_id,
      unreadCount: this.buffers.get(message.channel_id)?.messages.length ?? 0,
      delayMs: delay,
    });
    return true;
  }

  private async checkNotifications(channelId: string) {
    const startedAt = this.now();
    const policy = this.policy;
    this.prune(startedAt);
    this.globalAttentionAvailableAt =
      startedAt + policy.globalAttentionCooldownMs;
    const buffer = this.buffers.get(channelId);
    this.buffers.delete(channelId);
    if (
      !buffer ||
      this.evaluationTimes.length >= policy.maximumEvaluationsPerHour ||
      this.reactionTimes.length >= policy.maximumReactionsPerHour
    ) {
      return false;
    }

    const candidates = buffer.messages.filter((message) => {
      const authorId = message.author?.id;
      return (
        authorId &&
        freshHumanMessage(
          message,
          buffer.botUserId,
          startedAt,
          policy.maximumMessageAgeMs,
        ) &&
        startedAt -
          (this.lastReactionByUser.get(authorId) ?? Number.NEGATIVE_INFINITY) >=
          policy.reactionUserCooldownMs
      );
    });
    const latest = candidates.at(-1);
    const requesterUserId = latest?.author?.id;
    if (
      !latest?.guild_id ||
      !requesterUserId ||
      startedAt -
        (this.lastReactionByChannel.get(channelId) ??
          Number.NEGATIVE_INFINITY) <
        policy.reactionChannelCooldownMs
    ) {
      return false;
    }

    let discovered: DiscordReactionCapabilities;
    try {
      discovered = await this.reactionBroker.discover({
        guildId: latest.guild_id,
        channelId,
        botUserId: buffer.botUserId,
        discordRequest: buffer.discordRequest,
      });
    } catch {
      return false;
    }
    if (discovered.tools.length === 0) return false;

    const nearby = await getNearbyHumanMessages({
      channelId,
      requestMessageId: latest.id,
      botUserId: buffer.botUserId,
      discordRequest: buffer.discordRequest,
    }).catch(() => []);
    const candidateMessages = candidates.map((message) =>
      toChatbotMessage(message, buffer.botUserId),
    );
    const candidateIds = candidateMessages.map((message) => message.id);
    const job: ChatbotJob = {
      id: randomUUID(),
      requesterUserId,
      purpose: "social_action",
      channelId,
      requestMessageId: latest.id,
      request: "",
      requestMessage: toChatbotMessage(latest, buffer.botUserId),
      messages: mergeContext(nearby, candidateMessages),
      socialActionCandidateMessageIds: candidateIds,
      availableTools: discovered.tools,
    };
    const dispatch = (
      this.options.dispatch ??
      ((candidate) => macAgentBridge.dispatch(candidate, ["chat"]))
    )(job);
    if (dispatch.status !== "accepted") return false;
    this.evaluationTimes.push(startedAt);

    const result: MacAgentJobResult = await dispatch.result;
    if (!result.ok) return false;
    const decision = parseSocialActionDecision(result.content);
    if (
      decision.action !== "discord.add_reaction" ||
      !candidateIds.includes(decision.messageId)
    ) {
      return false;
    }

    const selected = candidates.find(
      (message) => message.id === decision.messageId,
    );
    const completedAt = this.now();
    const selectedAuthorId = selected?.author?.id;
    this.prune(completedAt);
    if (
      !selected ||
      !selectedAuthorId ||
      !freshHumanMessage(
        selected,
        buffer.botUserId,
        completedAt,
        policy.maximumMessageAgeMs,
      ) ||
      this.reactionTimes.length >= policy.maximumReactionsPerHour ||
      completedAt -
        (this.lastReactionByChannel.get(channelId) ??
          Number.NEGATIVE_INFINITY) <
        policy.reactionChannelCooldownMs ||
      completedAt -
        (this.lastReactionByUser.get(selectedAuthorId) ??
          Number.NEGATIVE_INFINITY) <
        policy.reactionUserCooldownMs
    ) {
      return false;
    }

    const reacted = await this.reactionBroker.addReaction({
      channelId,
      messageId: selected.id,
      emoji: decision.emoji,
      capabilities: discovered,
      discordRequest: buffer.discordRequest,
    });
    if (!reacted) return false;
    this.reactionTimes.push(completedAt);
    this.lastReactionByChannel.set(channelId, completedAt);
    this.lastReactionByUser.set(selectedAuthorId, completedAt);
    this.log({
      action: decision.action,
      guildId: selected.guild_id,
      channelId,
      messageId: selected.id,
      emoji: decision.emoji,
    });
    return true;
  }
}
