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

export const THINKING_FEEDBACK = "うーん…。";
export const THINKING_GAP_MS = 2_000;
const FAILURE_FEEDBACK = "ごめん、うまくいかなかった。もう一度お願い。";
const feedbackSpeech = new SpeechCache((text) =>
  synthesizeSpeech(text, text === THINKING_FEEDBACK ? { speedScale: 0.8 } : {}),
);
const feedbackLines = [THINKING_FEEDBACK, FAILURE_FEEDBACK] as const;

export function startThinkingFeedback(options: {
  getAudio: () => Promise<Buffer>;
  play: (audio: Buffer) => void | Promise<void>;
  isCurrent: () => boolean;
  gapMs?: number;
}) {
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const active = () => !stopped && options.isCurrent();
  const play = async () => {
    if (!active()) return;
    try {
      const audio = await options.getAudio();
      if (active()) await options.play(audio);
    } catch (error) {
      console.warn("Could not play thinking feedback:", error);
    }
  };
  timer = setTimeout(() => {
    void play();
  }, options.gapMs ?? THINKING_GAP_MS);
  return () => {
    stopped = true;
    clearTimeout(timer);
  };
}

async function playFeedback(text: string, input: VoiceReplyInput) {
  if (!input.isCurrent()) return;
  let abort!: () => void;
  const cancelled = new Promise<undefined>((resolve) => {
    abort = () => resolve(undefined);
    input.signal.addEventListener("abort", abort, { once: true });
    if (input.signal.aborted) abort();
  });
  try {
    // Cached feedback is shared; stop waiting without aborting another turn's cache fill.
    const audio = await Promise.race([feedbackSpeech.get(text), cancelled]);
    if (audio && input.isCurrent()) input.onAudio(audio);
  } catch (error) {
    if (!input.signal.aborted)
      console.warn(
        `Could not play voice feedback: ${error instanceof Error ? error.message : "unknown error"}`,
      );
  } finally {
    input.signal.removeEventListener("abort", abort);
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
  const trace = input.trace;
  const stopFeedback =
    input.settings?.feedbackEnabled === false
      ? () => {}
      : startThinkingFeedback({
          gapMs: input.settings?.feedbackDelayMs,
          getAudio: () => feedbackSpeech.get(THINKING_FEEDBACK),
          play: (audio) => input.onAudio(audio, "feedback"),
          isCurrent: input.isCurrent,
        });

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

  let cancel: (() => boolean) | undefined;
  const abort = () => {
    stopFeedback();
    cancel?.();
  };
  input.signal.addEventListener("abort", abort, { once: true });
  let speech = Promise.resolve();
  try {
    if (!input.isCurrent()) return null;
    let streamedReply = "";
    const sentences = new VoiceSentenceBuffer((sentence) => {
      speech = speech.then(async () => {
        if (!input.isCurrent()) return;
        const startedAt = performance.now();
        trace?.("tts.start", { text: sentence });
        let audio: Buffer;
        try {
          audio = await synthesizeSpeech(sentence, {
            signal: input.signal,
            speedScale: input.settings?.speechSpeed,
          });
          trace?.("tts.finish", {
            text: sentence,
            durationMs: performance.now() - startedAt,
            audioMs: audio.length / 192,
          });
        } catch (error) {
          trace?.("tts.error", {
            durationMs: performance.now() - startedAt,
            detail: input.signal.aborted
              ? "cancelled"
              : error instanceof Error
                ? error.message
                : "Synthesis failed",
          });
          throw error;
        }
        stopFeedback();
        if (input.isCurrent()) input.onAudio(audio, "reply", sentence);
      });
      void speech.catch(() => undefined);
    });
    const codexStartedAt = performance.now();
    let firstDelta = true;
    trace?.("codex.start", {
      detail: "Chat worker · streamed Japanese reply · low reasoning",
    });
    const dispatch = macAgentBridge.dispatch(job, ["chat"], (delta) => {
      if (!input.isCurrent()) return;
      if (firstDelta) {
        trace?.("codex.first_delta", {
          durationMs: performance.now() - codexStartedAt,
        });
        firstDelta = false;
      }
      streamedReply += delta;
      sentences.push(delta);
    });
    if (dispatch.status !== "accepted") {
      trace?.("codex.error", { detail: dispatch.status });
      stopFeedback();
      await playFeedback(FAILURE_FEEDBACK, input);
      return null;
    }
    cancel = dispatch.cancel;
    if (input.signal.aborted) abort();
    const result = await dispatch.result;
    trace?.(result.ok ? "codex.finish" : "codex.error", {
      durationMs: performance.now() - codexStartedAt,
      text: result.ok
        ? (parseChatbotAnswerDecision(result.content).reply ?? undefined)
        : undefined,
      detail: result.ok
        ? "Structured reply received"
        : input.signal.aborted
          ? "cancelled"
          : result.failureKind,
    });
    if (!input.isCurrent()) {
      await speech.catch(() => undefined);
      return null;
    }
    if (!result.ok) {
      stopFeedback();
      await speech.catch(() => undefined);
      await playFeedback(FAILURE_FEEDBACK, input);
      return null;
    }

    const reply = parseChatbotAnswerDecision(result.content).reply;
    if (!reply) {
      stopFeedback();
      await speech.catch(() => undefined);
      await playFeedback(FAILURE_FEEDBACK, input);
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
    return {
      transcript,
      reply,
    };
  } catch (error) {
    stopFeedback();
    if (input.signal.aborted) return null;
    await playFeedback(FAILURE_FEEDBACK, input);
    console.warn(
      `Could not prepare Discord voice reply: ${error instanceof Error ? error.message : "unknown error"}`,
    );
    return null;
  } finally {
    stopFeedback();
    input.signal.removeEventListener("abort", abort);
    await speech.catch(() => undefined);
    mcpSession.revoke();
  }
}
