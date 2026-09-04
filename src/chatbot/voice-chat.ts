import { randomUUID } from "node:crypto";

import type {
  AnswerJob,
  ChatbotMessage,
} from "../../contracts/worker-contract";
import { parseChatbotAnswerDecision } from "../../contracts/answer-contract";
import {
  SpeechCache,
  synthesizeSpeech,
  transcribeSpeech,
} from "../discord/local-speech";
import type { VoiceChatResponse, VoiceChatTurn } from "../discord/voice-chat";
import { macAgentBridge } from "./bridge";
import { registerChatbotMcpSession } from "./mcp";

const MIN_UTTERANCE_BYTES = 12_000;
const WAITING_FEEDBACK_DELAY_MS = 8_000;
const HEARD_FEEDBACK = "うん、聞いてるよ。";
const WAITING_FEEDBACK = "ちょっと待ってね。";
const FAILURE_FEEDBACK = "ごめん、うまくいかなかった。もう一度お願い。";
const feedbackSpeech = new SpeechCache(synthesizeSpeech);
const feedbackLines = [
  HEARD_FEEDBACK,
  WAITING_FEEDBACK,
  FAILURE_FEEDBACK,
] as const;

async function playFeedback(text: string, onAudio: (audio: Buffer) => void) {
  try {
    onAudio(await feedbackSpeech.get(text));
  } catch (error) {
    console.warn(
      `Could not play voice feedback: ${error instanceof Error ? error.message : "unknown error"}`,
    );
  }
}

export async function prewarmVoiceChatSpeech() {
  try {
    await feedbackSpeech.prewarm(feedbackLines);
  } catch (error) {
    console.warn(
      `Could not prewarm voice feedback: ${error instanceof Error ? error.message : "unknown error"}`,
    );
  }
}

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

  const heardFeedback = playFeedback(HEARD_FEEDBACK, input.onAudio);
  let replyAudioStarted = false;
  let waitingFeedback: Promise<void> | undefined;
  const waitingTimer = setTimeout(() => {
    if (!replyAudioStarted) {
      waitingFeedback = playFeedback(WAITING_FEEDBACK, input.onAudio);
    }
  }, WAITING_FEEDBACK_DELAY_MS);

  let transcript: string;
  try {
    transcript = await transcribeSpeech(input.audio);
    if (!transcript) {
      clearTimeout(waitingTimer);
      await heardFeedback;
      await playFeedback(FAILURE_FEEDBACK, input.onAudio);
      return null;
    }
  } catch (error) {
    clearTimeout(waitingTimer);
    await heardFeedback;
    await playFeedback(FAILURE_FEEDBACK, input.onAudio);
    console.warn(
      `Could not transcribe Discord voice: ${error instanceof Error ? error.message : "unknown error"}`,
    );
    return null;
  }

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
          "Reply naturally in Japanese using at most two short sentences for a live Discord group voice chat. The local voice is Japanese-only, so do not include English words, emoji, Markdown, URLs, or other text that would sound unclear when spoken.",
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
        const audio = await synthesizeSpeech(sentence);
        replyAudioStarted = true;
        clearTimeout(waitingTimer);
        input.onAudio(audio);
      });
    });
    const dispatch = macAgentBridge.dispatch(job, ["chat"], (delta) => {
      streamedReply += delta;
      sentences.push(delta);
    });
    if (dispatch.status !== "accepted") {
      clearTimeout(waitingTimer);
      await heardFeedback;
      await playFeedback(FAILURE_FEEDBACK, input.onAudio);
      return null;
    }
    const result = await dispatch.result;
    if (!result.ok) {
      clearTimeout(waitingTimer);
      await speech.catch(() => undefined);
      await heardFeedback;
      await waitingFeedback;
      await playFeedback(FAILURE_FEEDBACK, input.onAudio);
      return null;
    }

    const reply = parseChatbotAnswerDecision(result.content).reply;
    if (!reply) {
      clearTimeout(waitingTimer);
      await speech.catch(() => undefined);
      await heardFeedback;
      await waitingFeedback;
      await playFeedback(FAILURE_FEEDBACK, input.onAudio);
      return null;
    }
    if (!streamedReply) {
      sentences.push(reply);
    } else if (reply.startsWith(streamedReply)) {
      sentences.push(reply.slice(streamedReply.length));
    }
    sentences.flush();
    await speech;
    clearTimeout(waitingTimer);
    await heardFeedback;
    await waitingFeedback;
    return {
      transcript,
      reply,
    };
  } catch (error) {
    clearTimeout(waitingTimer);
    await heardFeedback;
    await waitingFeedback;
    await playFeedback(FAILURE_FEEDBACK, input.onAudio);
    console.warn(
      `Could not prepare Discord voice reply: ${error instanceof Error ? error.message : "unknown error"}`,
    );
    return null;
  } finally {
    clearTimeout(waitingTimer);
    mcpSession.revoke();
  }
}
