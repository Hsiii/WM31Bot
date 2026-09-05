import { randomUUID } from "node:crypto";

import type {
  AnswerJob,
  ChatbotMessage,
} from "../../contracts/worker-contract";
import { parseChatbotAnswerDecision } from "../../contracts/answer-contract";
import { SpeechCache, synthesizeSpeech } from "../discord/local-speech";
import type {
  VoiceChatResponse,
  VoiceChatTurn,
  VoiceReplyInput,
} from "../discord/voice-conversation";
import { macAgentBridge } from "./bridge";
import { registerChatbotMcpSession } from "./mcp";

const FILLER_FEEDBACK_DELAY_MS = 1_500;
const MIN_FOLLOWUP_FILLER_DELAY_MS = 2_500;
const MAX_FOLLOWUP_FILLER_DELAY_MS = 4_000;
const HEARD_FEEDBACK = "うん。";
const FAILURE_FEEDBACK = "ごめん、うまくいかなかった。もう一度お願い。";
export const VOICE_FILLERS = [
  "えっとね。",
  "んーと。",
  "うーん。",
  "そうだなあ。",
  "ちょっと待ってね。",
] as const;
const feedbackSpeech = new SpeechCache(synthesizeSpeech);
const feedbackLines = [
  HEARD_FEEDBACK,
  ...VOICE_FILLERS,
  FAILURE_FEEDBACK,
] as const;

export function nextVoiceFillerDelay(random = Math.random) {
  return (
    MIN_FOLLOWUP_FILLER_DELAY_MS +
    Math.floor(
      random() *
        (MAX_FOLLOWUP_FILLER_DELAY_MS - MIN_FOLLOWUP_FILLER_DELAY_MS + 1),
    )
  );
}

export function selectVoiceFiller(previous?: string, random = Math.random) {
  const choices = VOICE_FILLERS.filter((filler) => filler !== previous);
  return choices[Math.floor(random() * choices.length)] ?? VOICE_FILLERS[0];
}

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

export async function respondToVoiceChat(
  input: VoiceReplyInput & {
    guildId: string;
    channelId: string;
  },
): Promise<VoiceChatResponse | null> {
  if (!input.isCurrent()) return null;
  const { transcript } = input;
  const feedbackAudio = (audio: Buffer) => {
    if (input.isCurrent()) input.onAudio(audio, "feedback");
  };
  let feedbackPlayback = playFeedback(HEARD_FEEDBACK, feedbackAudio);
  let feedbackStopped = false;
  let previousFiller: string | undefined;
  let fillerTimer: ReturnType<typeof setTimeout>;
  const scheduleFiller = (delayMs: number) => {
    fillerTimer = setTimeout(() => {
      if (feedbackStopped || !input.isCurrent()) return;
      const filler = selectVoiceFiller(previousFiller);
      previousFiller = filler;
      feedbackPlayback = feedbackPlayback.then(() =>
        playFeedback(filler, feedbackAudio),
      );
      scheduleFiller(nextVoiceFillerDelay());
    }, delayMs);
  };
  scheduleFiller(FILLER_FEEDBACK_DELAY_MS);
  const stopFeedback = () => {
    feedbackStopped = true;
    clearTimeout(fillerTimer);
  };

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
        if (!input.isCurrent()) return;
        const audio = await synthesizeSpeech(sentence);
        stopFeedback();
        await feedbackPlayback;
        if (input.isCurrent()) input.onAudio(audio);
      });
    });
    const dispatch = macAgentBridge.dispatch(job, ["chat"], (delta) => {
      if (!input.isCurrent()) return;
      streamedReply += delta;
      sentences.push(delta);
    });
    if (dispatch.status !== "accepted") {
      stopFeedback();
      await feedbackPlayback;
      await playFeedback(FAILURE_FEEDBACK, input.onAudio);
      return null;
    }
    const result = await dispatch.result;
    if (!input.isCurrent()) {
      await speech.catch(() => undefined);
      return null;
    }
    if (!result.ok) {
      stopFeedback();
      await speech.catch(() => undefined);
      await feedbackPlayback;
      await playFeedback(FAILURE_FEEDBACK, input.onAudio);
      return null;
    }

    const reply = parseChatbotAnswerDecision(result.content).reply;
    if (!reply) {
      stopFeedback();
      await speech.catch(() => undefined);
      await feedbackPlayback;
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
    stopFeedback();
    await feedbackPlayback;
    return {
      transcript,
      reply,
    };
  } catch (error) {
    stopFeedback();
    await feedbackPlayback;
    await playFeedback(FAILURE_FEEDBACK, input.onAudio);
    console.warn(
      `Could not prepare Discord voice reply: ${error instanceof Error ? error.message : "unknown error"}`,
    );
    return null;
  } finally {
    stopFeedback();
    mcpSession.revoke();
  }
}
