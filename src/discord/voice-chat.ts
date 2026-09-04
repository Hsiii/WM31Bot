import { PassThrough } from "node:stream";

import {
  createAudioPlayer,
  createAudioResource,
  EndBehaviorType,
  joinVoiceChannel,
  NoSubscriberBehavior,
  StreamType,
  type DiscordGatewayAdapterCreator,
  type VoiceConnection,
} from "@discordjs/voice";
import buildVAD, { VADEvent, VADMode, type VAD } from "@ozymandiasthegreat/vad";
import prism from "prism-media";

import { VoiceActivityGate } from "./voice-activity";

const DISCORD_SAMPLE_RATE = 48_000;
const OPUS_FRAME_SIZE = 960;
const OPUS_FRAME_BYTES = OPUS_FRAME_SIZE * 2 * 2;
const MAX_UTTERANCE_BYTES = 60 * 24_000 * 2;
const MAX_HISTORY_TURNS = 12;
const vadClass = buildVAD();

export type VoiceChatTurn = {
  role: "user" | "assistant";
  author: string;
  content: string;
};

export type VoiceChatResponse = {
  transcript: string;
  reply: string;
};

type VoiceChatSessionOptions = {
  guildId: string;
  channelId: string;
  adapterCreator: DiscordGatewayAdapterCreator;
  getBotUserId: () => string | null;
  respond: (input: {
    guildId: string;
    channelId: string;
    userId: string;
    audio: Buffer;
    history: VoiceChatTurn[];
    onAudio: (audio: Buffer) => void;
  }) => Promise<VoiceChatResponse | null>;
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
  private readonly history: VoiceChatTurn[] = [];
  private cancelActiveAudio?: () => void;
  private responseQueue = Promise.resolve();
  private closed = false;

  constructor(private readonly options: VoiceChatSessionOptions) {
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
    this.cancelActiveAudio?.();
    this.player.stop(true);
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
      onSpeechStart: () => {
        this.cancelActiveAudio?.();
        this.player.stop(true);
      },
      onUtterance: (audio) => this.enqueueResponse(userId, audio),
    });
    let decoded = Buffer.alloc(0);
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
      gate.flush();
      vad.destroy();
    };
    opus.once("close", finish);
    opus.once("end", finish);
  }

  private enqueueResponse(userId: string, audio: Buffer) {
    this.responseQueue = this.responseQueue
      .then(() => this.respond(userId, audio))
      .catch((error) => {
        console.warn(
          `Could not answer in Discord voice: ${error instanceof Error ? error.message : "unknown error"}`,
        );
      });
  }

  private async respond(userId: string, audio: Buffer) {
    if (this.closed) return;
    let output: PassThrough | undefined;
    let cancelled = false;
    const cancelAudio = () => {
      cancelled = true;
      output?.end();
    };
    this.cancelActiveAudio = cancelAudio;
    const response = await this.options
      .respond({
        guildId: this.options.guildId,
        channelId: this.options.channelId,
        userId,
        audio,
        history: [...this.history],
        onAudio: (chunk) => {
          if (cancelled || this.closed) return;
          if (!output) {
            output = new PassThrough();
            this.player.play(
              createAudioResource(output, { inputType: StreamType.Raw }),
            );
          }
          output.write(chunk);
        },
      })
      .finally(() => {
        output?.end();
        if (this.cancelActiveAudio === cancelAudio) {
          this.cancelActiveAudio = undefined;
        }
      });
    if (!response || this.closed) return;

    this.history.push(
      { role: "user", author: userId, content: response.transcript },
      { role: "assistant", author: "MiniSago", content: response.reply },
    );
    this.history.splice(
      0,
      Math.max(0, this.history.length - MAX_HISTORY_TURNS),
    );
  }
}

export type DiscordVoiceChatOptions = {
  adapterCreator: (guildId: string) => DiscordGatewayAdapterCreator;
  getBotUserId: () => string | null;
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
