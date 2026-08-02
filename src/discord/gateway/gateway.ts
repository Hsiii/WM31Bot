import { getInstagramReplyUrls, getTwitterReplyUrls } from "./social-links";
import {
  ChatbotConversationTracker,
  createDiscordRequest,
  handleChatbotMention,
} from "./chatbot";
import {
  getChatbotAccessConfig,
  type ChatbotAccessConfig,
} from "../../chatbot/access";
import {
  AmbientReactionController,
  getAmbientReactionPolicy,
  type AmbientReactionPolicy,
} from "./social-reactions";
import { DiscordReactionBroker } from "../api/reactions";
import {
  QuickReplyNudgeTracker,
  QUICK_REPLY_TARGET_USER_ID,
} from "./quick-reply-nudge";
import {
  buildVoiceStateUpdate,
  registerVoiceGateway,
  VoiceStateTracker,
  type DiscordVoiceState,
  type JoinVoiceChannelResult,
  type LeaveVoiceChannelResult,
  type VoiceGateway,
} from "../api/voice";

const DISCORD_API_BASE_URL = "https://discord.com/api/v10";
const GATEWAY_URL = "wss://gateway.discord.gg/?v=10&encoding=json";
const MESSAGE_CONTENT_LIMIT = 2_000;
const MAX_RECONNECT_DELAY_MS = 60_000;
const GUILDS_INTENT = 1 << 0;
const GUILD_VOICE_STATES_INTENT = 1 << 7;
const GUILD_MESSAGES_INTENT = 1 << 9;
const DIRECT_MESSAGES_INTENT = 1 << 12;
const MESSAGE_CONTENT_INTENT = 1 << 15;

type GatewayPayload = {
  op: number;
  d?: unknown;
  s?: number | null;
  t?: string | null;
};

type GatewayHello = {
  heartbeat_interval: number;
};

type GatewayReady = {
  session_id: string;
  resume_gateway_url?: string;
  user?: {
    id?: string;
  };
};

type GatewayGuildCreate = {
  id: string;
  voice_states?: DiscordVoiceState[];
};

type DiscordUser = {
  id?: string;
  bot?: boolean;
};

type DiscordMessageCreate = {
  id: string;
  channel_id: string;
  guild_id?: string;
  content?: string;
  timestamp: string;
  attachments?: Array<{
    id: string;
    filename: string;
    content_type?: string;
    size: number;
    url: string;
  }>;
  embeds?: Array<{
    title?: string;
    description?: string;
    url?: string;
  }>;
  sticker_items?: Array<{ name?: string }>;
  referenced_message?: DiscordMessageCreate | null;
  mentions?: DiscordUser[];
  webhook_id?: string;
  author?: DiscordUser;
};

type InstagramGatewayConfig = {
  botToken: string;
  chatbotAccess: ChatbotAccessConfig;
  ambientReactionsEnabled: boolean;
  ambientReactionPolicy: AmbientReactionPolicy;
};

function getInstagramGatewayConfig(): InstagramGatewayConfig | null {
  const botToken = process.env.DISCORD_BOT_TOKEN?.trim();

  if (!botToken) {
    console.warn("Instagram gateway disabled: DISCORD_BOT_TOKEN is missing.");
    return null;
  }

  return {
    botToken,
    chatbotAccess: getChatbotAccessConfig(),
    ambientReactionsEnabled:
      process.env.MINISAGO_AMBIENT_REACTIONS_ENABLED?.trim().toLowerCase() ===
      "true",
    ambientReactionPolicy: getAmbientReactionPolicy(),
  };
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function readGatewayMessage(data: MessageEvent["data"]) {
  if (typeof data === "string") {
    return data;
  }

  if (data instanceof ArrayBuffer) {
    return new TextDecoder().decode(data);
  }

  return String(data);
}

export class ChannelTaskQueue {
  private tails = new Map<string, Promise<void>>();

  async run<T>(channelId: string, task: () => Promise<T>) {
    const previous = this.tails.get(channelId) ?? Promise.resolve();
    const current = previous.catch(() => undefined).then(task);
    const tail = current.then(
      () => undefined,
      () => undefined,
    );
    this.tails.set(channelId, tail);

    try {
      return await current;
    } finally {
      if (this.tails.get(channelId) === tail) {
        this.tails.delete(channelId);
      }
    }
  }
}

function getGatewayCloseReason(code: number) {
  if (code === 4004) {
    return "authentication failed; check DISCORD_BOT_TOKEN";
  }

  if (code === 4013) {
    return "invalid gateway intents requested";
  }

  if (code === 4014) {
    return "disallowed gateway intents; enable the Message Content privileged intent in the Discord Developer Portal";
  }

  return "no specific reason mapped";
}

class InstagramGatewayClient implements VoiceGateway {
  private ambientReactions: AmbientReactionController;
  private channelTasks = new ChannelTaskQueue();
  private conversations = new ChatbotConversationTracker();
  private quickReplyNudges = new QuickReplyNudgeTracker();
  private heartbeatAcked = true;
  private heartbeatTimer: ReturnType<typeof setInterval> | undefined;
  private reconnectAttempts = 0;
  private resumeGatewayUrl: string | null = null;
  private sequence: number | null = null;
  private sessionId: string | null = null;
  private socket: WebSocket | null = null;
  private stopped = false;
  private botUserId: string | null = null;
  private reactionBroker: DiscordReactionBroker;
  private voiceStates = new VoiceStateTracker();

  constructor(private readonly config: InstagramGatewayConfig) {
    this.reactionBroker = new DiscordReactionBroker({
      cacheMs: config.ambientReactionPolicy.capabilityCacheMs,
    });
    this.ambientReactions = new AmbientReactionController({
      policy: config.ambientReactionPolicy,
      reactionBroker: this.reactionBroker,
    });
  }

  connect() {
    void this.openSocket(false);
  }

  stop() {
    this.stopped = true;
    this.clearHeartbeat();
    this.ambientReactions.stop();
    this.socket?.close(1000, "MiniSago shutdown");
    registerVoiceGateway(null);
  }

  joinMemberVoiceChannel(
    guildId: string,
    userId: string,
  ): JoinVoiceChannelResult {
    const channelId = this.voiceStates.getChannelId(guildId, userId);

    if (!channelId) {
      return { status: "member_not_in_voice" };
    }

    if (!this.updateVoiceState(guildId, channelId)) {
      return { status: "gateway_unavailable" };
    }

    return { status: "joined", channelId };
  }

  leaveVoiceChannel(guildId: string): LeaveVoiceChannelResult {
    if (!this.updateVoiceState(guildId, null)) {
      return { status: "gateway_unavailable" };
    }

    return { status: "left" };
  }

  private async openSocket(resume: boolean) {
    const url =
      resume && this.resumeGatewayUrl
        ? `${this.resumeGatewayUrl}?v=10&encoding=json`
        : GATEWAY_URL;

    this.socket = new WebSocket(url);
    this.socket.addEventListener("message", (event) => {
      void this.handleGatewayPayload(event);
    });
    this.socket.addEventListener("close", (event) => {
      this.clearHeartbeat();

      if (this.stopped || !this.shouldReconnect(event.code)) {
        console.warn(
          `Discord gateway closed with code ${event.code}: ${getGatewayCloseReason(event.code)}.`,
        );
        return;
      }

      const canResume = Boolean(this.sessionId && this.sequence !== null);
      void this.reconnect(canResume);
    });
    this.socket.addEventListener("error", () => {
      console.warn("Discord gateway socket error.");
    });
  }

  private async handleGatewayPayload(event: MessageEvent) {
    const payload = JSON.parse(
      readGatewayMessage(event.data),
    ) as GatewayPayload;

    if (typeof payload.s === "number") {
      this.sequence = payload.s;
    }

    switch (payload.op) {
      case 0:
        await this.handleDispatch(payload);
        break;
      case 1:
        this.sendHeartbeat();
        break;
      case 7:
        this.socket?.close(4000, "Discord requested reconnect");
        break;
      case 9:
        await this.handleInvalidSession(Boolean(payload.d));
        break;
      case 10:
        this.handleHello(payload.d as GatewayHello);
        break;
      case 11:
        this.heartbeatAcked = true;
        break;
    }
  }

  private async handleDispatch(payload: GatewayPayload) {
    if (payload.t === "READY") {
      const ready = payload.d as GatewayReady;
      this.sessionId = ready.session_id;
      this.resumeGatewayUrl = ready.resume_gateway_url ?? null;
      this.botUserId = ready.user?.id ?? null;
      this.reconnectAttempts = 0;
      console.log("Discord gateway ready.");
      return;
    }

    if (payload.t === "RESUMED") {
      this.reconnectAttempts = 0;
      console.log("Discord gateway resumed.");
      return;
    }

    if (payload.t === "GUILD_CREATE") {
      const guild = payload.d as GatewayGuildCreate;
      this.voiceStates.replaceGuild(guild.id, guild.voice_states ?? []);
      return;
    }

    if (payload.t === "VOICE_STATE_UPDATE") {
      this.voiceStates.observe(payload.d as DiscordVoiceState);
      return;
    }

    if (payload.t === "MESSAGE_CREATE") {
      const message = payload.d as DiscordMessageCreate;
      await this.channelTasks.run(message.channel_id, () =>
        this.handleMessageCreate(message),
      );
    }
  }

  private handleHello(hello: GatewayHello) {
    this.startHeartbeat(hello.heartbeat_interval);

    if (this.sessionId && this.sequence !== null) {
      this.resume();
      return;
    }

    this.identify();
  }

  private startHeartbeat(intervalMs: number) {
    this.clearHeartbeat();
    this.heartbeatAcked = true;

    this.heartbeatTimer = setInterval(() => {
      if (!this.heartbeatAcked) {
        this.socket?.close(4000, "Heartbeat ACK timeout");
        return;
      }

      this.sendHeartbeat();
    }, intervalMs);

    setTimeout(() => this.sendHeartbeat(), Math.random() * intervalMs);
  }

  private clearHeartbeat() {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = undefined;
    }
  }

  private sendHeartbeat() {
    this.heartbeatAcked = false;
    this.send({
      op: 1,
      d: this.sequence,
    });
  }

  private identify() {
    this.send({
      op: 2,
      d: {
        token: this.config.botToken,
        intents:
          GUILDS_INTENT |
          GUILD_VOICE_STATES_INTENT |
          GUILD_MESSAGES_INTENT |
          DIRECT_MESSAGES_INTENT |
          MESSAGE_CONTENT_INTENT,
        properties: {
          os: process.platform,
          browser: "minisago",
          device: "minisago",
        },
      },
    });
  }

  private resume() {
    this.send({
      op: 6,
      d: {
        token: this.config.botToken,
        session_id: this.sessionId,
        seq: this.sequence,
      },
    });
  }

  private send(payload: GatewayPayload) {
    if (this.socket?.readyState !== WebSocket.OPEN) {
      return;
    }

    this.socket.send(JSON.stringify(payload));
  }

  private updateVoiceState(guildId: string, channelId: string | null) {
    if (this.socket?.readyState !== WebSocket.OPEN || !this.botUserId) {
      return false;
    }

    this.send(buildVoiceStateUpdate(guildId, channelId));
    return true;
  }

  private async handleInvalidSession(canResume: boolean) {
    if (!canResume) {
      this.sessionId = null;
      this.sequence = null;
      this.resumeGatewayUrl = null;
    }

    await sleep(1_000 + Math.random() * 4_000);
    this.socket?.close(4000, "Invalid session");
  }

  private shouldReconnect(code: number) {
    return ![4004, 4010, 4011, 4013, 4014].includes(code);
  }

  private async reconnect(canResume: boolean) {
    const delay = Math.min(
      1_000 * 2 ** this.reconnectAttempts,
      MAX_RECONNECT_DELAY_MS,
    );

    this.reconnectAttempts += 1;
    await sleep(delay);

    if (!this.stopped) {
      await this.openSocket(canResume);
    }
  }

  private async handleMessageCreate(message: DiscordMessageCreate) {
    const shouldNudgeQuickReply = this.quickReplyNudges.observe(message);

    if (shouldNudgeQuickReply) {
      try {
        await this.replyToMessage(
          message,
          `<@${QUICK_REPLY_TARGET_USER_ID}> 今天已經秒回超過三次了 去做點有意義的事啦`,
          [QUICK_REPLY_TARGET_USER_ID],
        );
      } catch (error) {
        console.error(
          `Failed to send quick reply nudge for ${message.id}:`,
          error,
        );
      }
    }

    if (this.botUserId) {
      try {
        const handled = await handleChatbotMention({
          message,
          botUserId: this.botUserId,
          discordRequest: createDiscordRequest(this.config.botToken),
          accessConfig: this.config.chatbotAccess,
          reactionBroker: this.reactionBroker,
          conversationTracker: this.conversations,
        });

        if (handled) {
          return;
        }
      } catch (error) {
        console.error(`Failed to handle chatbot mention ${message.id}:`, error);
        return;
      }

      if (this.config.ambientReactionsEnabled) {
        this.ambientReactions.observe({
          message,
          botUserId: this.botUserId,
          discordRequest: createDiscordRequest(this.config.botToken),
          accessConfig: this.config.chatbotAccess,
        });
      }
    }

    if (!this.shouldTransformMessage(message)) {
      return;
    }

    const content = message.content ?? "";
    const replyUrls = [
      ...getInstagramReplyUrls(content),
      ...getTwitterReplyUrls(content),
    ];

    if (replyUrls.length === 0) {
      return;
    }

    const replyContent = replyUrls.join("\n");

    if (replyContent.length > MESSAGE_CONTENT_LIMIT) {
      console.warn(
        `Skipped social link reply for message ${message.id}: reply content exceeds ${MESSAGE_CONTENT_LIMIT} characters.`,
      );
      try {
        await this.replyToMessage(
          message,
          "這則訊息裡的社群連結太多了 我一次回不完",
        );
      } catch (error) {
        console.error(
          `Failed to send social link length warning for message ${message.id}:`,
          error,
        );
      }
      return;
    }

    try {
      await this.replyToMessage(message, replyContent);
    } catch (error) {
      console.error(
        `Failed to reply to social link for message ${message.id}:`,
        error,
      );
    }
  }

  private shouldTransformMessage(message: DiscordMessageCreate) {
    if (!message.guild_id || !message.content) {
      return false;
    }

    if (message.webhook_id || message.author?.bot) {
      return false;
    }

    return message.author?.id !== this.botUserId;
  }

  private async replyToMessage(
    message: DiscordMessageCreate,
    content: string,
    mentionedUserIds: string[] = [],
  ) {
    await this.discordRequest(`/channels/${message.channel_id}/messages`, {
      method: "POST",
      body: {
        content,
        message_reference: {
          message_id: message.id,
          fail_if_not_exists: false,
        },
        allowed_mentions: {
          parse: [],
          users: mentionedUserIds,
          replied_user: false,
        },
      },
    });
  }

  private async discordRequest<T>(
    path: string,
    options: {
      method?: string;
      body?: unknown;
    } = {},
  ) {
    const headers: Record<string, string> = {
      Authorization: `Bot ${this.config.botToken}`,
    };

    if (options.body !== undefined) {
      headers["Content-Type"] = "application/json";
    }

    const response = await fetch(`${DISCORD_API_BASE_URL}${path}`, {
      method: options.method ?? "GET",
      headers,
      body:
        options.body === undefined ? undefined : JSON.stringify(options.body),
    });

    if (response.ok) {
      if (response.status === 204) {
        return undefined as T;
      }

      return (await response.json()) as T;
    }

    const body = await response.text();
    throw new Error(`${response.status} ${body}`);
  }
}

export function startInstagramGateway() {
  const config = getInstagramGatewayConfig();

  if (!config) {
    return null;
  }

  const client = new InstagramGatewayClient(config);
  registerVoiceGateway(client);
  client.connect();

  return client;
}
