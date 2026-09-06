import { randomUUID } from "node:crypto";
import type { VoiceTrace, VoiceSettings } from "./voice-debug/state";
export type VoiceChatTurn = {
  role: "user" | "assistant";
  author: string;
  content: string;
};

export type VoiceChatResponse = { transcript: string; reply: string };
export type VoiceAudioKind = "reply" | "feedback";
export type VoicePlayback = {
  finished: (interrupted: boolean) => void;
  trace?: VoiceTrace;
};
export type VoiceReplyInput = {
  userId: string;
  transcript: string;
  history: VoiceChatTurn[];
  signal: AbortSignal;
  trace?: VoiceTrace;
  settings?: VoiceSettings;
  isCurrent: () => boolean;
  onAudio: (
    audio: Buffer,
    kind?: VoiceAudioKind,
    text?: string,
  ) => void | Promise<void>;
};

const ADDRESS =
  /^(?:(?:hey|hi|ねえ|ねぇ)[\s、,]*)?(?:(?:mini\s*)?sago\b|ミニサゴ|みにさご|サゴ|さご)[\s、,。:：]*/iu;
export function voiceInterruptionIntent(text: string, sameSpeaker: boolean) {
  const address = ADDRESS.exec(text.trim());
  const addressed = Boolean(address);
  const request = address ? text.trim().slice(address[0].length) : text.trim();
  const stop =
    /^(?:stop|cancel|never mind|ストップ|やめて|キャンセル|もういい)(?:[\s、。！!,.]|$)/iu.test(
      request,
    );
  const correction =
    /^(?:actually|wait|i meant|no[, ]|待って|まって|違う|ちがう|訂正|やっぱり)/iu.test(
      request,
    );
  if ((sameSpeaker || addressed) && stop) return "stop";
  return addressed || (sameSpeaker && correction) ? "replace" : "keep";
}

type VoiceOutput = {
  pause: () => void;
  resume: () => void;
  clear: () => void;
  write: (
    audio: Buffer,
    kind: VoiceAudioKind,
    playback?: VoicePlayback,
  ) => void;
  drain: () => Promise<void>;
};

const MAX_PENDING_UTTERANCES = 3;
const MAX_PENDING_AGE_MS = 15_000;
type PendingUtterance = {
  turnId: string;
  userId: string;
  audio: Buffer;
  interruptedUserId?: string;
  queuedAt: number;
  done: () => void;
};
type Turn = { id: string; userId: string; controller: AbortController };

export class VoiceConversation {
  private readonly captureIds = new Map<string, string>();
  private readonly speakers = new Map<string, string | undefined>();
  private readonly history: VoiceChatTurn[] = [];
  private readonly lifetime = new AbortController();
  private active?: Turn;
  // Replacement work waits for cancellation acknowledgement, without blocking STT.
  private answering: Promise<void> = Promise.resolve();
  private transcribing = false;
  private readonly pending: PendingUtterance[] = [];
  private gapTimer?: ReturnType<typeof setTimeout>;
  private quiet = true;
  private closed = false;

  constructor(
    private readonly options: {
      transcribe: (audio: Buffer, signal?: AbortSignal) => Promise<string>;
      respond: (input: VoiceReplyInput) => Promise<VoiceChatResponse | null>;
      output: VoiceOutput;
      gapMs?: number;
      transcriptionTimeoutMs?: number;
      trace?: VoiceTrace;
      getSettings?: () => VoiceSettings;
    },
  ) {}

  speechStarted(userId: string) {
    if (this.closed) return;
    clearTimeout(this.gapTimer);
    const turnId = randomUUID();
    this.captureIds.set(userId, turnId);
    this.options.trace?.("capture.start", { turnId, userId });
    this.speakers.set(userId, this.active?.userId);
    this.quiet = false;
    this.options.output.pause();
  }

  speechEnded(userId: string) {
    this.options.trace?.("capture.end", {
      turnId: this.captureIds.get(userId),
      userId,
    });
    this.captureIds.delete(userId);
    this.speakers.delete(userId);
    if (this.closed || this.speakers.size) return;
    clearTimeout(this.gapTimer);
    this.gapTimer = setTimeout(() => {
      this.quiet = true;
      this.resumeIfResolved();
    }, this.options.gapMs ?? 700);
  }

  private resumeIfResolved() {
    if (
      !this.closed &&
      this.quiet &&
      !this.transcribing &&
      !this.pending.length
    )
      this.options.output.resume();
  }

  utterance(userId: string, audio: Buffer) {
    if (this.closed) return Promise.resolve();
    return new Promise<void>((done) => {
      if (this.pending.length >= MAX_PENDING_UTTERANCES) {
        const dropped = this.pending.shift()!;
        this.options.trace?.("utterance.dropped", {
          turnId: dropped.turnId,
          userId: dropped.userId,
          detail: "Transcription queue full",
        });
        dropped.done();
      }
      const turnId = this.captureIds.get(userId) ?? randomUUID();
      this.options.trace?.("utterance.queued", {
        turnId,
        userId,
        audioMs: audio.length / 48,
        queueDepth: this.pending.length + 1,
      });
      this.pending.push({
        turnId,
        userId,
        audio,
        interruptedUserId: this.speakers.has(userId)
          ? this.speakers.get(userId)
          : this.active?.userId,
        queuedAt: Date.now(),
        done,
      });
      void this.processPending();
    });
  }

  private async processPending() {
    if (this.transcribing) return;
    this.transcribing = true;
    try {
      while (!this.closed && this.pending.length) {
        const pending = this.pending.shift()!;
        const recognitionStartedAt = performance.now();
        try {
          if (Date.now() - pending.queuedAt <= MAX_PENDING_AGE_MS)
            await this.transcribe(pending);
          else
            this.options.trace?.("utterance.dropped", {
              turnId: pending.turnId,
              userId: pending.userId,
              detail: "Audio expired",
              queueDepth: this.pending.length,
            });
        } catch (error) {
          this.options.trace?.("whisper.error", {
            durationMs: performance.now() - recognitionStartedAt,
            turnId: pending.turnId,
            userId: pending.userId,
            detail:
              error instanceof Error ? error.message : "Recognition failed",
          });
          if (!this.closed)
            console.warn(
              "Could not transcribe Discord voice:",
              error instanceof Error ? error.message : error,
            );
        } finally {
          pending.done();
        }
      }
    } finally {
      this.transcribing = false;
      this.resumeIfResolved();
    }
  }

  private async transcribe({
    turnId,
    userId,
    audio,
    interruptedUserId,
    queuedAt,
  }: PendingUtterance) {
    const trace: VoiceTrace = (type, details) =>
      this.options.trace?.(type, { ...details, turnId, userId });
    const startedAt = performance.now();
    trace("whisper.start", {
      durationMs: Date.now() - queuedAt,
      queueDepth: this.pending.length,
    });
    const settings = this.options.getSettings?.();
    const signal = AbortSignal.any([
      this.lifetime.signal,
      AbortSignal.timeout(
        Math.max(
          1,
          Math.min(
            settings?.transcriptionTimeoutMs ??
              this.options.transcriptionTimeoutMs ??
              8_000,
            MAX_PENDING_AGE_MS - (Date.now() - queuedAt),
          ),
        ),
      ),
    ]);
    let abort!: () => void;
    const aborted = new Promise<never>((_, reject) => {
      abort = () => reject(signal.reason);
      signal.addEventListener("abort", abort, { once: true });
      if (signal.aborted) abort();
    });
    const transcript = (
      await Promise.race([
        this.options.transcribe(audio, signal),
        aborted,
      ]).finally(() => signal.removeEventListener("abort", abort))
    ).trim();
    trace("whisper.finish", {
      text: transcript,
      durationMs: performance.now() - startedAt,
    });
    if (!transcript || this.closed) {
      trace("decision", {
        detail: this.closed
          ? "ignore: session closed"
          : "ignore: empty transcript",
      });
      return;
    }
    if (interruptedUserId !== undefined || this.active) {
      const intent = voiceInterruptionIntent(
        transcript,
        (interruptedUserId ?? this.active?.userId) === userId,
      );
      trace("decision", {
        detail:
          intent === "keep"
            ? "ignore: side conversation while answering"
            : `${intent}: addressed request or current speaker control`,
      });
      if (intent === "keep") return;
      this.cancelTurn();
      if (intent === "stop") return;
    } else if (voiceInterruptionIntent(transcript, true) === "stop") {
      trace("decision", { detail: "stop: no active answer" });
      return;
    } else trace("decision", { detail: "answer: idle conversation" });
    const turn: Turn = {
      id: turnId,
      userId,
      controller: new AbortController(),
    };
    trace("turn.wait", { detail: "Waiting for prior answer to settle" });
    const waitingAt = performance.now();
    this.active = turn;
    const isCurrent = () => !this.closed && this.active === turn;
    const previous = this.answering;
    this.answering = (async () => {
      try {
        await previous;
        if (!isCurrent()) return;
        trace("turn.start", { durationMs: performance.now() - waitingAt });
        const history = [...this.history];
        this.history.push({
          role: "user",
          author: userId,
          content: transcript,
        });
        await this.options.respond({
          userId,
          transcript,
          history,
          signal: turn.controller.signal,
          trace,
          settings,
          isCurrent,
          onAudio: (audio, kind = "reply", text) => {
            if (
              !isCurrent() ||
              (kind === "feedback" && (!this.quiet || this.transcribing))
            )
              return;
            this.options.output.write(
              audio,
              kind,
              text
                ? {
                    trace,
                    finished: (interrupted) => {
                      this.history.push({
                        role: "assistant",
                        author: "MiniSago",
                        content: interrupted
                          ? `[Playback interrupted during this sentence; only part may have been heard] ${text}`
                          : text,
                      });
                      this.trimHistory();
                    },
                  }
                : undefined,
            );
            if (kind === "feedback") return this.options.output.drain();
          },
        });
        if (!isCurrent()) return;
        await this.options.output.drain();
        if (isCurrent())
          trace("turn.finish", { durationMs: Date.now() - queuedAt });
      } catch (error) {
        if (!turn.controller.signal.aborted)
          trace("turn.error", {
            detail: error instanceof Error ? error.message : "Answer failed",
          });
        if (!turn.controller.signal.aborted)
          console.warn("Could not answer in Discord voice:", error);
      } finally {
        if (isCurrent()) this.active = undefined;
        this.trimHistory();
      }
    })();
  }

  private trimHistory() {
    this.history.splice(0, Math.max(0, this.history.length - 12));
  }

  private cancelTurn() {
    const turn = this.active;
    this.active = undefined;
    if (turn)
      this.options.trace?.("turn.cancel", {
        turnId: turn.id,
        userId: turn.userId,
        detail: "Answer superseded or stopped",
      });
    turn?.controller.abort();
    this.options.output.clear();
  }

  stop() {
    this.cancelTurn();
  }

  destroy() {
    this.closed = true;
    this.lifetime.abort();
    this.cancelTurn();
    for (const pending of this.pending.splice(0)) pending.done();
    clearTimeout(this.gapTimer);
    this.speakers.clear();
  }
}
