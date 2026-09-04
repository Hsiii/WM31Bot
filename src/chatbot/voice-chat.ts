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

function spokenText(text: string) {
  return text
    .replace(/<\/?self-introduction>/gu, "")
    .replace(/\s+/gu, " ")
    .trim();
}

export class VoiceSentenceBuffer {
  private pending = "";

  constructor(private readonly emit: (sentence: string) => void) {}

  push(delta: string) {
    this.pending += delta;
    while (true) {
      const match = /[。！？!?\n]+/u.exec(this.pending);
      if (!match) return;
      const end = match.index + match[0].length;
      const sentence = spokenText(this.pending.slice(0, end));
      this.pending = this.pending.slice(end);
      if (sentence) this.emit(sentence);
    }
  }

  flush() {
    const sentence = spokenText(this.pending);
    this.pending = "";
    if (sentence) this.emit(sentence);
  }
}

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
  onAudio: (audio: Buffer) => void;
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
    streamReply: true,
  };

  try {
    let streamedReply = "";
    let speech = Promise.resolve();
    const sentences = new VoiceSentenceBuffer((sentence) => {
      speech = speech.then(async () => {
        input.onAudio(await synthesizeSpeech(sentence));
      });
    });
    const dispatch = macAgentBridge.dispatch(job, ["chat"], (delta) => {
      streamedReply += delta;
      sentences.push(delta);
    });
    if (dispatch.status !== "accepted") return null;
    const result = await dispatch.result;
    if (!result.ok) {
      await speech.catch(() => undefined);
      return null;
    }

    const reply = parseChatbotAnswerDecision(result.content).reply;
    if (!reply) {
      await speech.catch(() => undefined);
      return null;
    }
    if (!streamedReply) {
      sentences.push(reply);
    } else if (reply.startsWith(streamedReply)) {
      sentences.push(reply.slice(streamedReply.length));
    }
    sentences.flush();
    await speech;
    return {
      transcript,
      reply,
    };
  } finally {
    mcpSession.revoke();
  }
}
