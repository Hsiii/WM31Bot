import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const WHISPER_PATH = process.env.MINISAGO_WHISPER_PATH?.trim() || "whisper-cli";
const WHISPER_MODEL =
  process.env.MINISAGO_WHISPER_MODEL?.trim() ||
  "/opt/minisago-models/ggml-base.bin";
const SPEECH_COMMAND_TIMEOUT_MS = 30_000;
const TRANSCRIPTION_TIMEOUT_MS = 120_000;

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

export function ttsVoiceFor(text: string) {
  return /\p{Script=Han}/u.test(text) ? "cmn+f3" : "en-us+f3";
}

export async function transcribeSpeech(audio: Buffer) {
  const directory = await mkdtemp(join(tmpdir(), "minisago-voice-"));
  const wavPath = join(directory, "utterance.wav");
  const outputPath = join(directory, "transcript");

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
    await run(
      WHISPER_PATH,
      [
        "-m",
        WHISPER_MODEL,
        "-f",
        wavPath,
        "--output-txt",
        "--output-file",
        outputPath,
        "--no-timestamps",
        "--no-prints",
      ],
      undefined,
      TRANSCRIPTION_TIMEOUT_MS,
    );
    return (await readFile(`${outputPath}.txt`, "utf8")).trim();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

export async function synthesizeSpeech(text: string) {
  const wav = await run("espeak-ng", [
    "--stdout",
    "-v",
    ttsVoiceFor(text),
    "-s",
    "180",
    "-p",
    "65",
    text,
  ]);
  return run(
    "ffmpeg",
    [
      "-loglevel",
      "error",
      "-i",
      "pipe:0",
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
