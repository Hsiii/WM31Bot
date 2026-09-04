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

async function run(
  command: string,
  args: string[],
  input?: Buffer,
  timeoutMs = SPEECH_COMMAND_TIMEOUT_MS,
) {
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
  const [stdout, stderr, exitCode] = await Promise.race([
    Promise.all([
      new Response(child.stdout).arrayBuffer(),
      new Response(child.stderr).text(),
      child.exited,
    ]),
    timeout,
  ]).finally(() => clearTimeout(timer));
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

async function voicevoxRequest(url: URL, options: RequestInit) {
  const response = await fetch(url, {
    ...options,
    signal: AbortSignal.timeout(SYNTHESIS_TIMEOUT_MS),
  });
  if (!response.ok) {
    throw new Error(
      `VOICEVOX ${response.status}: ${(await response.text()).trim()}`,
    );
  }
  return response;
}

export async function transcribeSpeech(audio: Buffer) {
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
    );
    const form = new FormData();
    form.append("file", Bun.file(wavPath), "utterance.wav");
    form.append("language", "auto");
    form.append("response_format", "json");
    const response = await fetch(whisperInferenceUrl(), {
      method: "POST",
      body: form,
      signal: AbortSignal.timeout(TRANSCRIPTION_TIMEOUT_MS),
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

export async function synthesizeSpeech(text: string) {
  const query = await voicevoxRequest(voicevoxAudioQueryUrl(text), {
    method: "POST",
  }).then((response) => response.text());
  const wavResponse = await voicevoxRequest(voicevoxSynthesisUrl(), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: query,
  });
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
  );
}
