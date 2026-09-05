import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const WHISPER_URL =
  process.env.MINISAGO_WHISPER_URL?.trim() || "http://whisper:8080";
const VOICEVOX_URL =
  process.env.MINISAGO_VOICEVOX_URL?.trim() || "http://voicevox:50021";
const SPEECH_COMMAND_TIMEOUT_MS = 30_000;
const TRANSCRIPTION_TIMEOUT_MS = 120_000;
const SYNTHESIS_TIMEOUT_MS = 120_000;
export const VOICEVOX_SPEAKER_ID = 58;

export class SpeechCache {
  private readonly audio = new Map<string, Promise<Buffer>>();

  constructor(private readonly synthesize: (text: string) => Promise<Buffer>) {}

  get(text: string) {
    const cached = this.audio.get(text);
    if (cached) return cached;

    const synthesis = this.synthesize(text).catch((error) => {
      if (this.audio.get(text) === synthesis) this.audio.delete(text);
      throw error;
    });
    this.audio.set(text, synthesis);
    return synthesis;
  }

  async prewarm(texts: readonly string[]) {
    for (const text of texts) await this.get(text);
  }
}

async function run(
  command: string,
  args: string[],
  input?: Buffer,
  timeoutMs = SPEECH_COMMAND_TIMEOUT_MS,
  signal?: AbortSignal,
) {
  signal?.throwIfAborted();
  const child = Bun.spawn([command, ...args], {
    stdin: input ? "pipe" : "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  if (input) {
    const stdin = child.stdin;
    if (!stdin) throw new Error(`${command} did not open stdin`);
    stdin.write(input);
    stdin.end();
  }

  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      child.kill();
      reject(new Error(`${command} timed out`));
    }, timeoutMs);
  });
  const abort = () => child.kill();
  signal?.addEventListener("abort", abort, { once: true });
  const [stdout, stderr, exitCode] = await Promise.race([
    Promise.all([
      new Response(child.stdout).arrayBuffer(),
      new Response(child.stderr).text(),
      child.exited,
    ]),
    timeout,
  ]).finally(() => {
    clearTimeout(timer);
    signal?.removeEventListener("abort", abort);
  });
  signal?.throwIfAborted();
  if (exitCode !== 0) {
    throw new Error(
      stderr.trim().split("\n").at(-1) || `${command} exited with ${exitCode}`,
    );
  }
  return Buffer.from(stdout);
}

export function voicevoxAudioQueryUrl(text: string, baseUrl = VOICEVOX_URL) {
  const url = new URL("audio_query", `${baseUrl.replace(/\/$/u, "")}/`);
  url.searchParams.set("text", text);
  url.searchParams.set("speaker", String(VOICEVOX_SPEAKER_ID));
  return url;
}

export function whisperInferenceUrl(baseUrl = WHISPER_URL) {
  return new URL("inference", `${baseUrl.replace(/\/$/u, "")}/`);
}

function voicevoxSynthesisUrl() {
  const url = new URL("synthesis", `${VOICEVOX_URL.replace(/\/$/u, "")}/`);
  url.searchParams.set("speaker", String(VOICEVOX_SPEAKER_ID));
  return url;
}

async function voicevoxRequest(
  url: URL,
  options: RequestInit,
  signal?: AbortSignal,
) {
  const response = await fetch(url, {
    ...options,
    signal: AbortSignal.any([
      AbortSignal.timeout(SYNTHESIS_TIMEOUT_MS),
      ...(signal ? [signal] : []),
    ]),
  });
  if (!response.ok) {
    throw new Error(
      `VOICEVOX ${response.status}: ${(await response.text()).trim()}`,
    );
  }
  return response;
}

export async function transcribeSpeech(audio: Buffer, signal?: AbortSignal) {
  const directory = await mkdtemp(join(tmpdir(), "minisago-voice-"));
  const wavPath = join(directory, "utterance.wav");

  try {
    await run(
      "ffmpeg",
      [
        "-loglevel",
        "error",
        "-f",
        "s16le",
        "-ar",
        "24000",
        "-ac",
        "1",
        "-i",
        "pipe:0",
        "-ar",
        "16000",
        wavPath,
      ],
      audio,
      SPEECH_COMMAND_TIMEOUT_MS,
      signal,
    );
    const form = new FormData();
    form.append("file", Bun.file(wavPath), "utterance.wav");
    form.append("language", "auto");
    form.append("response_format", "json");
    const response = await fetch(whisperInferenceUrl(), {
      method: "POST",
      body: form,
      signal: AbortSignal.any([
        AbortSignal.timeout(TRANSCRIPTION_TIMEOUT_MS),
        ...(signal ? [signal] : []),
      ]),
    });
    if (!response.ok) {
      throw new Error(
        `Whisper ${response.status}: ${(await response.text()).trim()}`,
      );
    }
    const result = (await response.json()) as { text?: unknown };
    if (typeof result.text !== "string") {
      throw new Error("Whisper returned no transcript.");
    }
    return result.text.trim();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

export async function synthesizeSpeech(
  text: string,
  options: { speedScale?: number; signal?: AbortSignal } = {},
) {
  const query = (await voicevoxRequest(
    voicevoxAudioQueryUrl(text),
    {
      method: "POST",
    },
    options.signal,
  ).then((response) => response.json())) as Record<string, unknown>;
  if (options.speedScale !== undefined) query.speedScale = options.speedScale;
  const wavResponse = await voicevoxRequest(
    voicevoxSynthesisUrl(),
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(query),
    },
    options.signal,
  );
  const wav = Buffer.from(new Uint8Array(await wavResponse.arrayBuffer()));
  return run(
    "ffmpeg",
    [
      "-loglevel",
      "error",
      "-i",
      "pipe:0",
      "-af",
      "highpass=f=80,loudnorm=I=-16:TP=-1.5:LRA=7",
      "-f",
      "s16le",
      "-ar",
      "48000",
      "-ac",
      "2",
      "pipe:1",
    ],
    wav,
    SPEECH_COMMAND_TIMEOUT_MS,
    options.signal,
  );
}
