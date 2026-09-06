export type VoiceChatTurn = {
  role: "user" | "assistant";
  author: string;
  content: string;
};

export type VoiceChatResponse = { transcript: string; reply: string };
export type VoiceAudioKind = "reply" | "feedback";
export type VoicePlayback = { finished: (interrupted: boolean) => void };
export type VoiceReplyInput = {
  userId: string;
  transcript: string;
  history: VoiceChatTurn[];
  signal: AbortSignal;
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
  userId: string;
  audio: Buffer;
  interruptedUserId?: string;
  queuedAt: number;
  done: () => void;
};
type Turn = { userId: string; controller: AbortController };

export class VoiceConversation {
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
    },
  ) {}

  speechStarted(userId: string) {
    if (this.closed) return;
    clearTimeout(this.gapTimer);
    this.speakers.set(userId, this.active?.userId);
    this.quiet = false;
    this.options.output.pause();
  }

  speechEnded(userId: string) {
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
      if (this.pending.length >= MAX_PENDING_UTTERANCES)
        this.pending.shift()!.done();
      this.pending.push({
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
        try {
          if (Date.now() - pending.queuedAt <= MAX_PENDING_AGE_MS)
            await this.transcribe(pending);
        } catch (error) {
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
    userId,
    audio,
    interruptedUserId,
    queuedAt,
  }: PendingUtterance) {
    const signal = AbortSignal.any([
      this.lifetime.signal,
      AbortSignal.timeout(
        Math.max(
          1,
          Math.min(
            this.options.transcriptionTimeoutMs ?? 8_000,
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
    if (!transcript || this.closed) return;
    if (interruptedUserId !== undefined || this.active) {
      const intent = voiceInterruptionIntent(
        transcript,
        (interruptedUserId ?? this.active?.userId) === userId,
      );
      if (intent === "keep") return;
      this.cancelTurn();
      if (intent === "stop") return;
    } else if (voiceInterruptionIntent(transcript, true) === "stop") {
      return;
    }
    const turn: Turn = { userId, controller: new AbortController() };
    this.active = turn;
    const isCurrent = () => !this.closed && this.active === turn;
    const previous = this.answering;
    this.answering = (async () => {
      try {
        await previous;
        if (!isCurrent()) return;
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
      } catch (error) {
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
    turn?.controller.abort();
    this.options.output.clear();
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
