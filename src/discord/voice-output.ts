import { Readable } from "node:stream";
import {
  AudioPlayerStatus,
  createAudioResource,
  StreamType,
  type AudioPlayer,
} from "@discordjs/voice";
import type { VoiceAudioKind } from "./voice-conversation";

export class VoiceOutput {
  private queue: { audio: Buffer; kind: VoiceAudioKind }[] = [];
  private current?: VoiceAudioKind;
  private paused = false;
  private waiters: (() => void)[] = [];

  constructor(private readonly player: AudioPlayer) {
    player.on(AudioPlayerStatus.Idle, () => {
      this.current = undefined;
      this.playNext();
    });
    player.on(AudioPlayerStatus.Playing, () => {
      if (this.paused) player.pause(true);
    });
    player.on("error", (error) => {
      console.warn("Discord voice playback failed:", error);
      this.clear();
    });
  }

  write(audio: Buffer, kind: VoiceAudioKind) {
    if (
      kind === "feedback" &&
      (this.paused || this.current === "reply" || this.queue.length)
    )
      return;
    if (kind === "reply")
      this.queue = this.queue.filter((clip) => clip.kind !== "feedback");
    this.queue.push({ audio, kind });
    this.playNext();
  }

  pause() {
    this.paused = true;
    this.queue = this.queue.filter((clip) => clip.kind !== "feedback");
    if (this.current === "feedback") this.player.stop(true);
    else this.player.pause(true);
  }

  resume() {
    this.paused = false;
    this.player.unpause();
    this.playNext();
  }

  clear() {
    this.queue = [];
    this.current = undefined;
    this.player.stop(true);
    this.settle();
  }

  drain() {
    if (!this.current && !this.queue.length) return Promise.resolve();
    return new Promise<void>((resolve) => this.waiters.push(resolve));
  }

  private playNext() {
    if (this.current) return;
    if (!this.queue.length) {
      this.settle();
      return;
    }
    if (this.paused) return;
    const clip = this.queue.shift()!;
    this.current = clip.kind;
    this.player.play(
      createAudioResource(Readable.from([clip.audio]), {
        inputType: StreamType.Raw,
      }),
    );
  }

  private settle() {
    for (const resolve of this.waiters.splice(0)) resolve();
  }
}
