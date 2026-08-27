import type {
  ChatAnswerJob,
  ChatbotMessage,
} from "../../../contracts/worker-contract";

export type PromptCaseSource =
  | {
      kind: "stratified-v42-sample";
      sampleIndex: number;
      guild: "guild-a" | "guild-b" | "guild-c" | "unknown";
      requester: string;
      task: string;
    }
  | {
      kind: "discord-regression";
      thread: "Diagnose Discord reply and attachme…";
      symptom: "mention-only" | "missing-attachment";
    }
  | {
      kind: "assigned-regression";
      regression: "bounded-action-followup";
      variant: "recoverable" | "blocked";
    };

export type PromptCaseExpectation = {
  requiredTools?: string[];
  forbiddenTools?: string[];
  artifact?: string | null;
  requiredReplyPatterns?: RegExp[];
  forbiddenReplyPatterns?: RegExp[];
};

export type PromptCase = {
  id: string;
  source: PromptCaseSource;
  job: ChatAnswerJob;
  attachmentText?: string[];
  mockContext?: Record<string, unknown>;
  mediaId?: string;
  expectation: PromptCaseExpectation;
};

const timestamp = "2026-08-27T17:00:00+08:00";

function message(
  id: string,
  author: string,
  content: string,
  role: "user" | "assistant" = "user",
): ChatbotMessage {
  return { id, author, content, role, timestamp, attachments: [] };
}

function answerJob(
  id: string,
  request: string,
  options: {
    messages?: ChatbotMessage[];
    referencedMessage?: ChatbotMessage;
    addressingMode?: ChatAnswerJob["addressingMode"];
    attachments?: ChatbotMessage["attachments"];
  } = {},
): ChatAnswerJob {
  return {
    id: `prompt-eval-${id}`,
    requesterUserId: "prompt-eval-requester",
    purpose: "answer",
    executionRoute: "chat",
    mcpAccessToken: "prompt-eval",
    channelId: "prompt-eval-channel",
    requestMessageId: "prompt-eval-request",
    request,
    addressingMode: options.addressingMode ?? "mention",
    requestMessage: {
      ...message("prompt-eval-request", "Requester", request),
      attachments: options.attachments ?? [],
      referencedMessage: options.referencedMessage,
    },
    messages: options.messages ?? [],
  };
}

const sample = (
  sampleIndex: number,
  guild: Extract<PromptCaseSource, { kind: "stratified-v42-sample" }>["guild"],
  requester: string,
  task: string,
): PromptCaseSource => ({
  kind: "stratified-v42-sample",
  sampleIndex,
  guild,
  requester,
  task,
});

// Requests preserve the interaction pattern from the sampled session. Names,
// channel IDs, member IDs, and identifying details are replaced or paraphrased.
export const PROMPT_CASES: PromptCase[] = [
  {
    id: "correct-misread-action",
    source: sample(7, "guild-a", "requester-1", "context-search"),
    job: answerJob(
      "correct-misread-action",
      "不是 我是叫你跟她聊天 不是找她的聊天紀錄",
      {
        addressingMode: "continuation",
        messages: [
          message(
            "previous-answer",
            "迷你西米露",
            "我找到她之前聊過的內容了",
            "assistant",
          ),
        ],
      },
    ),
    mockContext: {
      members: [{ query: "她", names: ["Member A"], id: "111111111111111111" }],
      channels: [{ name: "general", id: "222222222222222222" }],
    },
    expectation: { requiredTools: ["resolve_context", "send_channel_message"] },
  },
  {
    id: "relationship-evidence",
    source: sample(12, "guild-a", "requester-2", "context-search"),
    job: answerJob("relationship-evidence", "你覺得他們兩個是什麼關係"),
    mockContext: {
      history: [
        { author: "Member A", content: "你們是室友嗎" },
        { author: "Member B", content: "先別亂猜啦" },
      ],
    },
    expectation: { requiredTools: ["resolve_context"] },
  },
  {
    id: "technical-recommendation",
    source: sample(13, "guild-a", "requester-3", "question"),
    job: answerJob(
      "technical-recommendation",
      "GitKraken 到期後有什麼免費開源替代",
    ),
    expectation: {},
  },
  {
    id: "conditional-reminder",
    source: sample(14, "guild-a", "requester-4", "reminder"),
    job: answerJob(
      "conditional-reminder",
      "如果我每天晚上十一點前沒說我畫畫了就標我",
    ),
    expectation: { requiredTools: ["create_reminder"] },
  },
  {
    id: "discord-id-followup",
    source: sample(15, "guild-a", "requester-1", "discord-action"),
    job: answerJob("discord-id-followup", "111111111111111111", {
      addressingMode: "continuation",
      messages: [message("earlier", "Requester", "去 general 跟她說晚餐七點")],
    }),
    mockContext: {
      channels: [{ name: "general", id: "222222222222222222" }],
    },
    expectation: { requiredTools: ["send_channel_message"] },
  },
  {
    id: "authorization-explanation",
    source: sample(16, "guild-c", "requester-5", "question"),
    job: answerJob(
      "authorization-explanation",
      "如果完全不鎖授權 可能會有什麼大問題",
    ),
    expectation: {},
  },
  {
    id: "short-casual-opinion",
    source: sample(17, "unknown", "requester-6", "casual"),
    job: answerJob("short-casual-opinion", "愛 JK"),
    expectation: {},
  },
  {
    id: "technical-continuation",
    source: sample(18, "guild-a", "requester-7", "technical"),
    job: answerJob(
      "technical-continuation",
      "我找到 SSH server 直接 serve ratatui 的範例了 接下來可以怎麼拆 BBS MVP",
    ),
    expectation: {},
  },
  {
    id: "mention-only-context",
    source: sample(19, "guild-b", "requester-5", "mention-only"),
    job: answerJob("mention-only-context", "", {
      referencedMessage: message(
        "referenced",
        "Member A",
        "Plus 的五小時限制是不是又回來了",
      ),
    }),
    expectation: {},
  },
  {
    id: "durable-member-id",
    source: sample(20, "guild-a", "requester-1", "memory"),
    job: answerJob(
      "durable-member-id",
      "記住 Member A 的 Discord ID 是 111111111111111111",
    ),
    expectation: { requiredTools: ["manage_server_memory"] },
  },
  {
    id: "server-overview",
    source: sample(25, "guild-a", "requester-7", "context-search"),
    job: answerJob(
      "server-overview",
      "我剛來不久 可以跟我介紹這個伺服器的歷史 成員和常見梗嗎",
    ),
    mockContext: {
      history: [
        { author: "Member A", content: "這裡一開始是朋友聊天群" },
        { author: "Member B", content: "沒有正式規則 別洗版就好" },
      ],
    },
    expectation: { requiredTools: ["resolve_context"] },
  },
  {
    id: "product-comparison-followup",
    source: sample(26, "guild-a", "requester-3", "casual"),
    job: answerJob("product-comparison-followup", "Fork 跟 Gittyup 比呢", {
      addressingMode: "continuation",
      messages: [
        message(
          "earlier",
          "迷你西米露",
          "如果要免費開源的 Git GUI 可以先看 Gittyup",
          "assistant",
        ),
      ],
    }),
    expectation: {},
  },
  {
    id: "playful-metaphor",
    source: sample(24, "guild-a", "requester-4", "casual"),
    job: answerJob("playful-metaphor", "我住你心裡"),
    expectation: {},
  },
  {
    id: "wordplay-mention-only",
    source: {
      kind: "discord-regression",
      thread: "Diagnose Discord reply and attachme…",
      symptom: "mention-only",
    },
    job: answerJob("wordplay-mention-only", "", {
      referencedMessage: message(
        "wordplay",
        "Member A",
        "什麼動物最容易跌倒 狐狸 因為牠腳滑",
      ),
    }),
    expectation: {},
  },
  {
    id: "generated-attachment",
    source: {
      kind: "discord-regression",
      thread: "Diagnose Discord reply and attachme…",
      symptom: "missing-attachment",
    },
    job: answerJob("generated-attachment", "把這張圖調亮一點再傳給我", {
      attachments: [
        {
          id: "input-photo",
          filename: "photo.png",
          contentType: "image/png",
          size: 1024,
          url: "https://cdn.discordapp.com/attachments/eval/photo.png",
        },
      ],
    }),
    mediaId: "media-edited.webp",
    expectation: {
      requiredTools: ["run_python"],
      artifact: "media-edited.webp",
    },
  },
  {
    id: "missing-attachment-result",
    source: {
      kind: "discord-regression",
      thread: "Diagnose Discord reply and attachme…",
      symptom: "missing-attachment",
    },
    job: answerJob("missing-attachment-result", "你有把改好的圖傳上來嗎", {
      addressingMode: "continuation",
    }),
    expectation: {
      artifact: null,
      forbiddenReplyPatterns: [
        /傳好了/u,
        /已(?:經)?傳/u,
        /附上/u,
        /(?:attached|sent) (?:it|the)/iu,
      ],
    },
  },
  {
    id: "recover-bounded-action",
    source: {
      kind: "assigned-regression",
      regression: "bounded-action-followup",
      variant: "recoverable",
    },
    job: answerJob("recover-bounded-action", "所以為什麼沒完成", {
      addressingMode: "continuation",
      messages: [
        message("action-request", "Requester", "今天晚上六點提醒我看排名"),
        message(
          "failed-answer",
          "迷你西米露",
          "我剛剛沒有把提醒設好",
          "assistant",
        ),
      ],
    }),
    expectation: { requiredTools: ["create_reminder"] },
  },
  {
    id: "blocked-bounded-action",
    source: {
      kind: "assigned-regression",
      regression: "bounded-action-followup",
      variant: "blocked",
    },
    job: answerJob("blocked-bounded-action", "所以呢 為什麼沒完成", {
      addressingMode: "continuation",
      messages: [
        message(
          "failed-answer",
          "迷你西米露",
          "我沒有把訊息送出去",
          "assistant",
        ),
      ],
    }),
    expectation: {
      forbiddenTools: ["send_channel_message"],
      requiredReplyPatterns: [/(?:頻道|對象|內容|destination|message)/iu],
    },
  },
];
