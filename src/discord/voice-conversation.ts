export type VoiceChatTurn = {
  role: "user" | "assistant";
  author: string;
  content: string;
};

export type VoiceChatResponse = { transcript: string; reply: string };
export type VoiceAudioKind = "reply" | "feedback";
export type VoiceReplyInput = {
  userId: string;
  transcript: string;
  history: VoiceChatTurn[];
  isCurrent: () => boolean;
  onAudio: (audio: Buffer, kind?: VoiceAudioKind) => void | Promise<void>;
};

export function voiceInterruptionIntent(text: string, sameSpeaker: boolean) {
  const address =
    /^(?:(?:hey|hi|ねえ|ねぇ)[\s、,]*)?(?:(?:mini\s*)?sago\b|ミニサゴ|みにさご|サゴ|さご)[\s、,。:：]*/iu.exec(
      text.trim(),
    );
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
  write: (audio: Buffer, kind: VoiceAudioKind) => void;
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

export class VoiceConversation {
  private readonly speakers = new Set<string>();
  private readonly history: VoiceChatTurn[] = [];
  private active?: { userId: string };
  private transcribing = false;
  private readonly pending: PendingUtterance[] = [];
  private gapTimer?: ReturnType<typeof setTimeout>;
  private quiet = true;
  private closed = false;

  constructor(
    private readonly options: {
      transcribe: (audio: Buffer) => Promise<string>;
      respond: (input: VoiceReplyInput) => Promise<VoiceChatResponse | null>;
      output: VoiceOutput;
      gapMs?: number;
    },
  ) {}

  speechStarted(userId: string) {
    if (this.closed) return;
    clearTimeout(this.gapTimer);
    this.speakers.add(userId);
    this.quiet = false;
    this.options.output.pause();
  }

  speechEnded(userId: string) {
    this.speakers.delete(userId);
    if (this.closed || this.speakers.size) return;
    clearTimeout(this.gapTimer);
    this.gapTimer = setTimeout(() => {
      this.quiet = true;
      this.options.output.resume();
    }, this.options.gapMs ?? 700);
  }

  utterance(userId: string, audio: Buffer) {
    if (this.closed) return Promise.resolve();
    return new Promise<void>((done) => {
      if (this.pending.length >= MAX_PENDING_UTTERANCES)
        this.pending.shift()!.done();
      this.pending.push({
        userId,
        audio,
        interruptedUserId: this.active?.userId,
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
          console.warn("Could not transcribe Discord voice:", error);
        } finally {
          pending.done();
        }
      }
    } finally {
      this.transcribing = false;
    }
  }

  private async transcribe({
    userId,
    audio,
    interruptedUserId,
  }: PendingUtterance) {
    const transcript = (await this.options.transcribe(audio)).trim();
    if (!transcript || this.closed) return;
    if (interruptedUserId !== undefined || this.active) {
      const intent = voiceInterruptionIntent(
        transcript,
        (this.active?.userId ?? interruptedUserId) === userId,
      );
      if (intent === "keep") return;
      // Transcriptions are processed in capture order, including corrections.
      this.active = undefined;
      this.options.output.clear();
      if (intent === "stop") return;
    }
    const turn = { userId };
    this.active = turn;
    const history = [...this.history];
    this.history.push({
      role: "user",
      author: userId,
      content: transcript,
    });
    const isCurrent = () => !this.closed && this.active === turn;
    void (async () => {
      try {
        const response = await this.options.respond({
          userId,
          transcript,
          history,
          isCurrent,
          onAudio: (audio, kind = "reply") => {
            if (!isCurrent() || (kind === "feedback" && !this.quiet)) return;
            this.options.output.write(audio, kind);
            if (kind === "feedback") return this.options.output.drain();
          },
        });
        if (!isCurrent()) return;
        await this.options.output.drain();
        if (isCurrent() && response) {
          this.history.push({
            role: "assistant",
            author: "MiniSago",
            content: response.reply,
          });
        }
      } catch (error) {
        console.warn("Could not answer in Discord voice:", error);
      } finally {
        if (isCurrent()) this.active = undefined;
        this.history.splice(0, Math.max(0, this.history.length - 12));
      }
    })();
  }

  destroy() {
    this.closed = true;
    this.active = undefined;
    for (const pending of this.pending.splice(0)) pending.done();
    clearTimeout(this.gapTimer);
    this.speakers.clear();
    this.options.output.clear();
  }
}
