const PREROLL_FRAMES = 15;
const START_VOICE_FRAMES = 10;
const MIN_VOICE_FRAMES = 15;
const END_SILENCE_FRAMES = 35;
const TRAILING_SILENCE_FRAMES = 10;

type BufferedFrame = {
  audio: Buffer;
  voice: boolean;
};

export class VoiceActivityGate {
  private preroll: BufferedFrame[] = [];
  private utterance: BufferedFrame[] | null = null;
  private consecutiveVoiceFrames = 0;
  private silentFrames = 0;
  private voicedFrames = 0;
  private utteranceBytes = 0;

  constructor(
    private readonly options: {
      maxUtteranceBytes: number;
      onSpeechStart: () => void;
      onUtterance: (audio: Buffer) => void;
    },
  ) {}

  push(audio: Buffer, voice: boolean) {
    if (this.utterance) {
      this.utterance.push({ audio, voice });
      this.utteranceBytes += audio.length;
      if (voice) {
        this.voicedFrames += 1;
        this.silentFrames = 0;
      } else {
        this.silentFrames += 1;
      }

      if (
        this.silentFrames >= END_SILENCE_FRAMES ||
        this.utteranceBytes >= this.options.maxUtteranceBytes
      ) {
        this.finish();
      }
      return;
    }

    this.preroll.push({ audio, voice });
    if (this.preroll.length > PREROLL_FRAMES) this.preroll.shift();
    this.consecutiveVoiceFrames = voice ? this.consecutiveVoiceFrames + 1 : 0;
    if (this.consecutiveVoiceFrames < START_VOICE_FRAMES) return;

    this.utterance = this.preroll;
    this.preroll = [];
    this.voicedFrames = this.utterance.filter((frame) => frame.voice).length;
    this.utteranceBytes = this.utterance.reduce(
      (bytes, frame) => bytes + frame.audio.length,
      0,
    );
    this.silentFrames = 0;
    this.options.onSpeechStart();
  }

  flush() {
    if (this.utterance) this.finish();
    this.reset();
  }

  private finish() {
    const utterance = this.utterance ?? [];
    const trimFrames = Math.max(0, this.silentFrames - TRAILING_SILENCE_FRAMES);
    const kept = trimFrames ? utterance.slice(0, -trimFrames) : utterance;
    const audio =
      this.voicedFrames >= MIN_VOICE_FRAMES
        ? Buffer.concat(kept.map((frame) => frame.audio))
        : null;
    this.reset();
    if (audio?.length) this.options.onUtterance(audio);
  }

  private reset() {
    this.preroll = [];
    this.utterance = null;
    this.consecutiveVoiceFrames = 0;
    this.silentFrames = 0;
    this.voicedFrames = 0;
    this.utteranceBytes = 0;
  }
}
