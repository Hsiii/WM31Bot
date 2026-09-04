import { randomUUID } from "node:crypto";

import type {
  AnswerJob,
  ChatbotMessage,
} from "../../contracts/worker-contract";
import { parseChatbotAnswerDecision } from "../../contracts/answer-contract";
import { synthesizeSpeech, transcribeSpeech } from "../discord/local-speech";
import type { VoiceChatResponse, VoiceChatTurn } from "../discord/voice-chat";
import { macAgentBridge } from "./bridge";
import { registerChatbotMcpSession } from "./mcp";

const MIN_UTTERANCE_BYTES = 12_000;

function contextMessages(
  history: VoiceChatTurn[],
  channelId: string,
): ChatbotMessage[] {
  const timestamp = new Date().toISOString();
  return history.map((turn) => ({
    id: randomUUID(),
    role: turn.role,
    author: turn.author,
    timestamp,
    content: turn.content,
    attachments: [],
    channelId,
    channelName: "voice chat",
  }));
}

export async function respondToVoiceChat(input: {
  guildId: string;
  channelId: string;
  userId: string;
  audio: Buffer;
  history: VoiceChatTurn[];
}): Promise<VoiceChatResponse | null> {
  if (input.audio.length < MIN_UTTERANCE_BYTES) return null;

  const transcript = await transcribeSpeech(input.audio);
  if (!transcript) return null;

  const requestMessageId = randomUUID();
  const requestMessage: ChatbotMessage = {
    id: requestMessageId,
    role: "user",
    author: input.userId,
    timestamp: new Date().toISOString(),
    content: transcript,
    attachments: [],
    channelId: input.channelId,
    channelName: "voice chat",
  };
  const messages = contextMessages(input.history, input.channelId);
  const mcpSession = registerChatbotMcpSession({
    resolveContext: async () => ({
      history: { status: "complete", messages },
      search: { status: "not_requested", results: [] },
      members: { status: "not_requested", results: [] },
      previousTrace: { status: "not_requested" },
    }),
  });
  const job: AnswerJob = {
    id: randomUUID(),
    requesterUserId: input.userId,
    purpose: "answer",
    channelId: input.channelId,
    requestMessageId,
    request: transcript,
    requestMessage,
    messages,
    mcpAccessToken: mcpSession.token,
    capabilities: [
      {
        id: "conversation",
        category: "conversation",
        availability: "available",
        description:
          "Reply naturally and briefly in Japanese to the current turn in a live Discord group voice chat. The local voice is Japanese-only, so do not include English words, emoji, Markdown, URLs, or other text that would sound unclear when spoken.",
      },
    ],
    executionRoute: "chat",
  };

  try {
    const dispatch = macAgentBridge.dispatch(job, ["chat"]);
    if (dispatch.status !== "accepted") return null;
    const result = await dispatch.result;
    if (!result.ok) return null;

    const reply = parseChatbotAnswerDecision(result.content).reply;
    if (!reply) return null;
    return {
      transcript,
      reply,
      audio: await synthesizeSpeech(reply),
    };
  } finally {
    mcpSession.revoke();
  }
}
