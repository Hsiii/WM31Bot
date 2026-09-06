import type { VoiceTrace } from "./voice-debug/state";
import { Readable } from "node:stream";
import {
  AudioPlayerStatus,
  createAudioResource,
  StreamType,
  type AudioPlayer,
} from "@discordjs/voice";
import type { VoiceAudioKind, VoicePlayback } from "./voice-conversation";

type Clip = {
  audio: Buffer;
  kind: VoiceAudioKind;
  playback?: VoicePlayback;
  started?: boolean;
  queuedAt?: number;
  startedAt?: number;
};

export class VoiceOutput {
  private queue: Clip[] = [];
  private current?: Clip;
  private paused = false;
  private waiters: (() => void)[] = [];

  constructor(
    private readonly player: AudioPlayer,
    private readonly trace?: VoiceTrace,
  ) {
    player.on(AudioPlayerStatus.Idle, () => {
      this.finish(false);
      this.playNext();
    });
    player.on(AudioPlayerStatus.Playing, () => {
      if (this.paused) player.pause(true);
      else if (this.current && !this.current.started) {
        this.current.started = true;
        this.current.startedAt = performance.now();
        (this.current.playback?.trace ?? this.trace)?.("audio.start", {
          kind: this.current.kind,
          durationMs:
            performance.now() - (this.current.queuedAt ?? performance.now()),
          audioMs: this.current.audio.length / 192,
        });
      }
    });
    player.on("error", (error) => {
      console.warn("Discord voice playback failed:", error);
      this.clear();
    });
  }

  write(audio: Buffer, kind: VoiceAudioKind, playback?: VoicePlayback) {
    if (
      kind === "feedback" &&
      (this.paused || this.current?.kind === "reply" || this.queue.length)
    )
      return;
    if (kind === "reply")
      this.queue = this.queue.filter((clip) => clip.kind !== "feedback");
    this.queue.push({ audio, kind, playback, queuedAt: performance.now() });
    (playback?.trace ?? this.trace)?.("audio.queued", {
      kind,
      audioMs: audio.length / 192,
    });
    if (kind === "reply" && this.current?.kind === "feedback")
      this.player.stop(true);
    this.playNext();
  }

  pause() {
    if (!this.paused)
      this.trace?.("audio.pause", { detail: "Speaker activity" });
    this.paused = true;
    this.queue = this.queue.filter((clip) => clip.kind !== "feedback");
    if (this.current?.kind === "feedback") this.player.stop(true);
    else this.player.pause(true);
  }

  resume() {
    if (this.paused)
      this.trace?.("audio.resume", {
        detail: this.current ? "playing" : "idle",
      });
    this.paused = false;
    this.player.unpause();
    this.playNext();
  }

  private finish(interrupted: boolean) {
    const clip = this.current;
    this.current = undefined;
    if (clip?.started) {
      (clip.playback?.trace ?? this.trace)?.("audio.finish", {
        kind: clip.kind,
        detail: interrupted ? "interrupted" : "played",
        durationMs: performance.now() - (clip.startedAt ?? performance.now()),
      });
      clip.playback?.finished(interrupted);
    }
  }

  clear() {
    this.trace?.("audio.clear");
    this.queue = [];
    this.finish(true);
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
    this.current = clip;
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
