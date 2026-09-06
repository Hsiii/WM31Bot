import { randomUUID } from "node:crypto";
import { z } from "zod";

export const voiceSettingsSchema = z
  .object({
    speechStartMs: z.number().int().min(40).max(500).multipleOf(20),
    silenceMs: z.number().int().min(200).max(2000).multipleOf(20),
    transcriptionTimeoutMs: z.number().int().min(1000).max(30000),
    feedbackDelayMs: z.number().int().min(500).max(10000),
    feedbackEnabled: z.boolean(),
    speechSpeed: z.number().min(0.7).max(1.4),
  })
  .strict();
export type VoiceSettings = z.infer<typeof voiceSettingsSchema>;
export const DEFAULT_VOICE_SETTINGS: VoiceSettings = {
  speechStartMs: 100,
  silenceMs: 700,
  transcriptionTimeoutMs: 8000,
  feedbackDelayMs: 2000,
  feedbackEnabled: true,
  speechSpeed: 1,
};
export type VoiceEventType =
  | "session.open"
  | "session.close"
  | "connection.state"
  | "capture.start"
  | "capture.end"
  | "utterance.queued"
  | "utterance.dropped"
  | "whisper.start"
  | "whisper.finish"
  | "whisper.error"
  | "decision"
  | "turn.wait"
  | "turn.start"
  | "turn.cancel"
  | "turn.finish"
  | "turn.error"
  | "codex.start"
  | "codex.first_delta"
  | "codex.finish"
  | "codex.error"
  | "tts.start"
  | "tts.finish"
  | "tts.error"
  | "audio.queued"
  | "audio.start"
  | "audio.finish"
  | "audio.pause"
  | "audio.resume"
  | "audio.clear"
  | "settings.updated";
export type VoiceEventDetails = {
  turnId?: string;
  userId?: string;
  text?: string;
  detail?: string;
  durationMs?: number;
  audioMs?: number;
  queueDepth?: number;
  kind?: string;
};
export type VoiceTrace = (
  type: VoiceEventType,
  details?: VoiceEventDetails,
) => void;
export type VoiceDebugEvent = VoiceEventDetails & {
  id: number;
  at: number;
  sessionId: string;
  type: VoiceEventType;
};
type Session = {
  id: string;
  guildId: string;
  channelId: string;
  openedAt: number;
  closedAt?: number;
  speakers: string[];
  connection: string;
  playback: string;
  queueDepth: number;
  transcribing?: string;
  activeTurn?: string;
};
const RETENTION_MS = 30 * 60_000;
const MAX_EVENTS = 800;

export class VoiceDebugState {
  private settings = { ...DEFAULT_VOICE_SETTINGS };
  private revision = 0;
  private sequence = 0;
  private events: VoiceDebugEvent[] = [];
  private sessions = new Map<string, Session>();
  private stops = new Map<string, () => void>();
  constructor(
    private readonly enabled: () => boolean = () =>
      Boolean(process.env.MINISAGO_VOICE_DEBUG_TOKEN?.trim()),
  ) {}
  getSettings() {
    return { ...this.settings };
  }
  updateSettings(value: unknown, expectedRevision: number) {
    if (expectedRevision !== this.revision)
      throw new Error(
        "Settings changed in another tab. Reload settings and try again.",
      );
    this.settings = voiceSettingsSchema.parse(value);
    this.revision++;
    this.emit("system", "settings.updated", {
      detail: `Settings revision ${this.revision}`,
    });
    return { settings: this.getSettings(), revision: this.revision };
  }
  session(guildId: string, channelId: string) {
    const id = randomUUID();
    this.sessions.set(id, {
      id,
      guildId,
      channelId,
      openedAt: Date.now(),
      speakers: [],
      connection: "connecting",
      playback: "idle",
      queueDepth: 0,
    });
    while (this.sessions.size > 32) {
      const oldest = this.sessions.keys().next().value!;
      this.sessions.delete(oldest);
      this.stops.delete(oldest);
    }
    const trace: VoiceTrace = (type, details) => this.emit(id, type, details);
    trace("session.open");
    return {
      id,
      trace,
      setStop: (stop: () => void) => this.stops.set(id, stop),
    };
  }
  stop(id: string) {
    const stop = this.stops.get(id);
    if (!stop) return false;
    stop();
    return true;
  }
  private emit(
    sessionId: string,
    type: VoiceEventType,
    details: VoiceEventDetails = {},
  ) {
    const session = this.sessions.get(sessionId);
    if (session) {
      if (
        type === "capture.start" &&
        details.userId &&
        !session.speakers.includes(details.userId)
      )
        session.speakers.push(details.userId);
      if (type === "capture.end")
        session.speakers = session.speakers.filter(
          (id) => id !== details.userId,
        );
      if (type === "connection.state")
        session.connection = details.detail ?? "unknown";
      if (type === "whisper.start") session.transcribing = details.turnId;
      if (type === "whisper.finish" || type === "whisper.error")
        session.transcribing = undefined;
      if (type === "turn.wait" || type === "turn.start")
        session.activeTurn = details.turnId;
      if (
        (type === "turn.finish" ||
          type === "turn.cancel" ||
          type === "turn.error") &&
        session.activeTurn === details.turnId
      )
        session.activeTurn = undefined;
      if (type === "audio.start") session.playback = "playing";
      if (type === "audio.pause") session.playback = "paused";
      if (type === "audio.resume") session.playback = details.detail ?? "idle";
      if (type === "audio.finish" || type === "audio.clear")
        session.playback = "idle";
      if (details.queueDepth !== undefined)
        session.queueDepth = details.queueDepth;
      if (type === "session.close") {
        session.closedAt = Date.now();
        session.connection = "closed";
        session.speakers = [];
        session.activeTurn = undefined;
        session.transcribing = undefined;
        this.stops.delete(sessionId);
      }
    }
    if (!this.enabled()) return;
    this.events.push({
      ...details,
      text: details.text?.slice(0, 4000),
      detail: details.detail?.slice(0, 500),
      id: ++this.sequence,
      at: Date.now(),
      sessionId,
      type,
    });
    this.prune();
  }
  private prune() {
    const cutoff = Date.now() - RETENTION_MS;
    this.events = this.events
      .filter((event) => event.at >= cutoff)
      .slice(-MAX_EVENTS);
    for (const [id, session] of this.sessions)
      if (session.closedAt && session.closedAt < cutoff)
        this.sessions.delete(id);
  }
  snapshot() {
    this.prune();
    return {
      now: Date.now(),
      revision: this.revision,
      settings: this.getSettings(),
      defaults: DEFAULT_VOICE_SETTINGS,
      retentionMs: RETENTION_MS,
      sessions: [...this.sessions.values()],
      events: this.events,
    };
  }
  clear() {
    this.events = [];
  }
}
export const voiceDebug = new VoiceDebugState();
