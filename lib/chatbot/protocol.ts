export const CHATBOT_PROTOCOL_VERSION = 24;
export const CHATBOT_JOB_TIMEOUT_MS = 120_000;
export const CHATBOT_DEV_JOB_TIMEOUT_MS = 15 * 60_000;

export const CHATBOT_WORKER_CAPABILITIES = ["chat", "dev", "mac"] as const;
export type ChatbotWorkerCapability =
  (typeof CHATBOT_WORKER_CAPABILITIES)[number];

export type ChatbotAttachment = {
  id: string;
  filename: string;
  contentType?: string;
  size: number;
  url: string;
};

export type ChatbotOutgoingFile = {
  filename: string;
  contentType: string;
  size: number;
  data: string;
};

export type ChatbotReaction = {
  emoji: string;
  count: number;
  me?: boolean;
};

export type ChatbotExecutionMode = "chat" | "dev";
export type ChatbotExecutionTarget = "default" | "mac";
export type ChatbotMutationScope = "code" | "issue" | "deploy";

export type CodexUsageWindow = {
  label: string;
  windowMinutes: number;
  usedPercent: number;
  remainingPercent: number;
  resetsAt: string | null;
};

export type CodexUsageSnapshot = {
  windows: CodexUsageWindow[];
  updatedAt: string;
};

export type ChatbotToolCapability = {
  name: string;
  risk: "ambient" | "normal" | "owner_confirmed";
  description: string;
  inputSchema: Record<string, unknown>;
  metadata?: Record<string, unknown>;
};

export type ChatbotMemberResult = {
  query: string;
  names: string[];
};

export type ChatbotMcpTraceCall = {
  name: string;
  arguments: Record<string, unknown>;
  resultCount?: number;
  status?: string;
};

export type ChatbotTraceContext = {
  historyCount?: number;
  contextMessageCount: number;
  searchQueries: Array<Record<string, unknown>>;
  searchResultCount: number;
  memberQueries: string[];
  toolCalls?: ChatbotMcpTraceCall[];
  elapsedMs: number;
  model?: string;
  promptVersion?: number;
};

export type ChatbotMessage = {
  id: string;
  role?: "user" | "assistant";
  author: string;
  authorAliases?: string[];
  timestamp: string;
  content: string;
  attachments: ChatbotAttachment[];
  reactions?: ChatbotReaction[];
  channelId?: string;
  channelName?: string;
  jumpUrl?: string;
  referencedMessage?: Omit<ChatbotMessage, "referencedMessage">;
};

export type ChatbotJob = {
  id: string;
  requesterUserId: string;
  purpose?: "answer" | "execution_route" | "social_action" | "trace_lookup";
  executionMode?: ChatbotExecutionMode;
  executionTarget?: ChatbotExecutionTarget;
  mutationScope?: ChatbotMutationScope;
  repository?: string;
  availableRepositories?: string[];
  chatbotRepository?: string;
  mcpAccessToken?: string;
  availableTools?: ChatbotToolCapability[];
  socialActionCandidateMessageIds?: string[];
  channelId: string;
  requestMessageId: string;
  request: string;
  requestMessage?: ChatbotMessage;
  messages: ChatbotMessage[];
};

export type MacAgentClientMessage =
  | {
      type: "authenticate";
      protocolVersion: number;
      secret: string;
      workerId: string;
      capabilities: ChatbotWorkerCapability[];
      repositories: string[];
      chatbotRepository?: string;
      priority: number;
    }
  | {
      type: "availability";
      available: boolean;
      capacity: number;
    }
  | {
      type: "heartbeat";
    }
  | {
      type: "codex_usage_result";
      requestId: string;
      usage: CodexUsageSnapshot | null;
    }
  | {
      type: "result";
      jobId: string;
      ok: true;
      content: string;
      files?: ChatbotOutgoingFile[];
    }
  | {
      type: "result";
      jobId: string;
      ok: false;
      error: string;
    };

export type MacAgentServerMessage =
  | {
      type: "authenticated";
      protocolVersion: number;
    }
  | {
      type: "job";
      job: ChatbotJob;
    }
  | {
      type: "cancel";
      jobId: string;
    }
  | {
      type: "codex_usage_request";
      requestId: string;
    };
