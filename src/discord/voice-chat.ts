import {
  createAudioPlayer,
  EndBehaviorType,
  joinVoiceChannel,
  NoSubscriberBehavior,
  type DiscordGatewayAdapterCreator,
  type VoiceConnection,
} from "@discordjs/voice";
import buildVAD, { VADEvent, VADMode, type VAD } from "@ozymandiasthegreat/vad";
import prism from "prism-media";

import { VoiceActivityGate } from "./voice-activity";
import {
  VoiceConversation,
  type VoiceReplyInput,
  type VoiceChatResponse,
} from "./voice-conversation";
import { VoiceOutput } from "./voice-output";
export type { VoiceChatTurn, VoiceChatResponse } from "./voice-conversation";

const DISCORD_SAMPLE_RATE = 48_000;
const OPUS_FRAME_SIZE = 960;
const OPUS_FRAME_BYTES = OPUS_FRAME_SIZE * 2 * 2;
const MAX_UTTERANCE_BYTES = 60 * 24_000 * 2;
const vadClass = buildVAD();

type VoiceChatSessionOptions = {
  guildId: string;
  channelId: string;
  adapterCreator: DiscordGatewayAdapterCreator;
  getBotUserId: () => string | null;
  transcribe: (audio: Buffer, signal?: AbortSignal) => Promise<string>;
  respond: (
    input: VoiceReplyInput & { guildId: string; channelId: string },
  ) => Promise<VoiceChatResponse | null>;
};

export function discordPcmToSpeechPcm(input: Buffer) {
  const output = Buffer.allocUnsafe(Math.floor(input.length / 8) * 2);
  let outputOffset = 0;

  for (let inputOffset = 0; inputOffset + 7 < input.length; inputOffset += 8) {
    const left = input.readInt16LE(inputOffset);
    const right = input.readInt16LE(inputOffset + 2);
    output.writeInt16LE(Math.round((left + right) / 2), outputOffset);
    outputOffset += 2;
  }

  return output.subarray(0, outputOffset);
}

export function discordPcmToVadPcm(input: Buffer) {
  const output = Buffer.allocUnsafe(Math.floor(input.length / 4) * 2);
  let outputOffset = 0;

  for (let inputOffset = 0; inputOffset + 3 < input.length; inputOffset += 4) {
    const left = input.readInt16LE(inputOffset);
    const right = input.readInt16LE(inputOffset + 2);
    output.writeInt16LE(Math.round((left + right) / 2), outputOffset);
    outputOffset += 2;
  }

  return output.subarray(0, outputOffset);
}

export function pcmToVadSamples(input: Buffer) {
  const samples = new Int16Array(Math.floor(input.length / 2));
  new Uint8Array(samples.buffer).set(input.subarray(0, samples.byteLength));
  return samples;
}

class VoiceChatSession {
  private readonly connection: VoiceConnection;
  private readonly player = createAudioPlayer({
    behaviors: { noSubscriber: NoSubscriberBehavior.Pause },
  });
  private readonly listeningTo = new Set<string>();
  private readonly conversation: VoiceConversation;
  private readonly stopListeners = new Set<() => void>();
  private closed = false;

  constructor(private readonly options: VoiceChatSessionOptions) {
    this.conversation = new VoiceConversation({
      transcribe: options.transcribe,
      respond: (input) =>
        options.respond({
          ...input,
          guildId: options.guildId,
          channelId: options.channelId,
        }),
      output: new VoiceOutput(this.player),
      // The VAD gate and packet inactivity timer already wait for 700 ms of silence.
      gapMs: 0,
    });
    this.connection = joinVoiceChannel({
      guildId: options.guildId,
      channelId: options.channelId,
      adapterCreator: options.adapterCreator,
      selfDeaf: false,
      selfMute: false,
    });
    this.connection.subscribe(this.player);

    this.connection.receiver.speaking.on("start", (userId) => {
      if (userId !== this.options.getBotUserId()) {
        void this.listen(userId);
      }
    });
    this.connection.on("error", (error) => {
      console.warn(`Discord voice connection failed: ${error.message}`);
    });
  }

  destroy() {
    if (this.closed) return;
    this.closed = true;
    this.conversation.destroy();
    for (const stop of this.stopListeners) stop();
    this.connection.destroy();
  }

  private async listen(userId: string) {
    if (this.closed || this.listeningTo.has(userId)) return;
    this.listeningTo.add(userId);

    let VAD: Awaited<typeof vadClass>;
    try {
      VAD = await vadClass;
    } catch (error) {
      this.listeningTo.delete(userId);
      console.warn(
        `Could not load voice activity detector: ${error instanceof Error ? error.message : "unknown error"}`,
      );
      return;
    }
    if (this.closed) {
      this.listeningTo.delete(userId);
      return;
    }

    const vad: VAD = new VAD(VADMode.VERY_AGGRESSIVE, DISCORD_SAMPLE_RATE);
    const gate = new VoiceActivityGate({
      maxUtteranceBytes: MAX_UTTERANCE_BYTES,
      onSpeechStart: () => this.conversation.speechStarted(userId),
      onSpeechEnd: () => this.conversation.speechEnded(userId),
      onUtterance: (audio) => {
        void this.conversation.utterance(userId, audio);
      },
    });
    let decoded = Buffer.alloc(0);
    let inactivityTimer: ReturnType<typeof setTimeout> | undefined;
    const opus = this.connection.receiver.subscribe(userId, {
      end: {
        behavior: EndBehaviorType.AfterInactivity,
        duration: 10_000,
      },
    });
    const decoder = new prism.opus.Decoder({
      frameSize: OPUS_FRAME_SIZE,
      channels: 2,
      rate: DISCORD_SAMPLE_RATE,
    });

    opus.pipe(decoder);
    decoder.on("data", (chunk: Buffer) => {
      clearTimeout(inactivityTimer);
      inactivityTimer = setTimeout(() => gate.flush(), 700);
      decoded = Buffer.concat([decoded, chunk]);
      while (decoded.length >= OPUS_FRAME_BYTES) {
        const frame = decoded.subarray(0, OPUS_FRAME_BYTES);
        decoded = decoded.subarray(OPUS_FRAME_BYTES);
        const vadAudio = discordPcmToVadPcm(frame);
        const samples = pcmToVadSamples(vadAudio);
        const voice = vad.processFrame(samples) === VADEvent.VOICE;
        gate.push(discordPcmToSpeechPcm(frame), voice);
      }
    });
    decoder.on("error", (error) => {
      console.warn(`Could not decode Discord voice audio: ${error.message}`);
    });

    const finish = () => {
      if (!this.listeningTo.delete(userId)) return;
      clearTimeout(inactivityTimer);
      gate.flush();
      vad.destroy();
      this.stopListeners.delete(stop);
    };
    const stop = () => {
      finish();
      opus.destroy();
      decoder.destroy();
    };
    this.stopListeners.add(stop);
    opus.once("close", finish);
    opus.once("end", finish);
  }
}

export type DiscordVoiceChatOptions = {
  adapterCreator: (guildId: string) => DiscordGatewayAdapterCreator;
  getBotUserId: () => string | null;
  transcribe: VoiceChatSessionOptions["transcribe"];
  respond: VoiceChatSessionOptions["respond"];
};

export class DiscordVoiceChat {
  private readonly sessions = new Map<string, VoiceChatSession>();

  constructor(private readonly options: DiscordVoiceChatOptions) {}

  join(guildId: string, channelId: string) {
    this.leave(guildId);
    this.sessions.set(
      guildId,
      new VoiceChatSession({
        guildId,
        channelId,
        adapterCreator: this.options.adapterCreator(guildId),
        getBotUserId: this.options.getBotUserId,
        transcribe: this.options.transcribe,
        respond: this.options.respond,
      }),
    );
    return { status: "joined" as const, channelId };
  }

  leave(guildId: string) {
    const session = this.sessions.get(guildId);
    if (!session) return false;
    this.sessions.delete(guildId);
    session.destroy();
    return true;
  }

  destroy() {
    for (const session of this.sessions.values()) session.destroy();
    this.sessions.clear();
  }
}
