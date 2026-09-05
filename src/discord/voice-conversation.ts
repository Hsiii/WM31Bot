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

export class VoiceConversation {
  private readonly speakers = new Set<string>();
  private readonly history: VoiceChatTurn[] = [];
  private active?: { userId: string };
  private transcription = Promise.resolve();
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
    const interrupted = this.active;
    this.transcription = this.transcription
      .then(async () => {
        if (this.closed) return;
        const transcript = (await this.options.transcribe(audio)).trim();
        if (!transcript || this.closed) return;
        if (interrupted || this.active) {
          const intent = voiceInterruptionIntent(
            transcript,
            (interrupted ?? this.active)?.userId === userId,
          );
          if (intent === "keep") return;
          // A delayed transcript must not replace a newer accepted request.
          if (interrupted && this.active && interrupted !== this.active) return;
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
                if (!isCurrent() || (kind === "feedback" && !this.quiet))
                  return;
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
      })
      .catch((error) =>
        console.warn("Could not transcribe Discord voice:", error),
      );
    return this.transcription;
  }

  destroy() {
    this.closed = true;
    this.active = undefined;
    clearTimeout(this.gapTimer);
    this.speakers.clear();
    this.options.output.clear();
  }
}
