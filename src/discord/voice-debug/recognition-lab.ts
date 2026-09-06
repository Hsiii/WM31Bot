import {
  mkdir,
  readdir,
  readFile,
  writeFile,
  rename,
  unlink,
} from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { recognizeSpeech, DEFAULT_RECOGNITION } from "../local-speech";
export const profileSchema = z
  .object({
    language: z.enum(["auto", "zh", "ja", "en"]),
    beamSize: z.number().int().min(1).max(5),
    temperature: z.number().min(0).max(1),
    prompt: z.string().max(500),
    vad: z.boolean(),
    vadThreshold: z.number().min(0.1).max(0.9),
    minSpeechMs: z.number().int().min(50).max(1000),
    silenceMs: z.number().int().min(100).max(2000),
    paddingMs: z.number().int().min(0).max(1000),
  })
  .strict();
export const profilesSchema = z.array(profileSchema).min(1).max(4);
type Run = {
  id: string;
  settings: z.infer<typeof profileSchema>;
  status: string;
  result?: Awaited<ReturnType<typeof recognizeSpeech>>;
  error?: string;
};
type Recording = {
  id: string;
  at: number;
  audioMs: number;
  expected: string;
  runs: Run[];
};
export class RecognitionLab {
  private busy = false;
  constructor(
    private directory = process.env.MINISAGO_VOICE_TEST_DIR ??
      "/app/state/voice-tests",
    private recognize = recognizeSpeech,
  ) {}
  private file(id: string, ext: string) {
    return join(this.directory, z.string().uuid().parse(id) + ext);
  }
  async get(id: string): Promise<Recording> {
    return JSON.parse(await readFile(this.file(id, ".json"), "utf8"));
  }
  private async save(record: Recording) {
    const path = this.file(record.id, ".json");
    await writeFile(path + ".tmp", JSON.stringify(record), { mode: 0o600 });
    await rename(path + ".tmp", path);
  }
  async list() {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const records = await Promise.all(
      (await readdir(this.directory))
        .filter((name) => name.endsWith(".json"))
        .map((name) => this.get(name.slice(0, -5))),
    );
    return records
      .sort((a, b) => b.at - a.at)
      .map((record) => ({
        ...record,
        runs: record.runs.map((run) =>
          !this.busy && ["running", "queued"].includes(run.status)
            ? {
                ...run,
                status: "interrupted",
                error: "Server restarted; rerun this profile",
              }
            : run,
        ),
      }));
  }
  async store(audio: Buffer) {
    const records = await this.list();
    if (records.length >= 100)
      throw new Error(
        "Recording limit reached (100). Delete a recording first.",
      );
    const record: Recording = {
      id: randomUUID(),
      at: Date.now(),
      audioMs: audio.length / 48,
      expected: "",
      runs: [],
    };
    await writeFile(this.file(record.id, ".pcm"), audio, { mode: 0o600 });
    await this.save(record);
    return record;
  }
  async audio(id: string) {
    return readFile(this.file(id, ".pcm"));
  }
  async remove(id: string) {
    if (this.busy) throw new Error("Wait for the current comparison to finish");
    await unlink(this.file(id, ".json"));
    await unlink(this.file(id, ".pcm"));
  }
  async run(id: string, profiles: unknown, expected: string) {
    const parsed = profilesSchema.parse(profiles);
    if (this.busy)
      throw new Error(
        "A comparison is already running. Wait for it to finish.",
      );
    this.busy = true;
    try {
      const record = await this.get(id);
      const audio = await this.audio(id);
      record.expected = expected.slice(0, 4000);
      const runs: Run[] = parsed.map((settings) => ({
        id: randomUUID(),
        settings,
        status: "queued",
      }));
      record.runs = [...record.runs, ...runs].slice(-20);
      await this.save(record);
      void (async () => {
        try {
          for (const run of runs) {
            run.status = "running";
            await this.save(record);
            try {
              run.result = await this.recognize(
                audio,
                run.settings,
                AbortSignal.timeout(120000),
              );
              run.status = "complete";
            } catch (error) {
              run.status = "error";
              run.error =
                error instanceof Error ? error.message : "Recognition failed";
            }
            await this.save(record);
          }
        } catch (error) {
          console.warn("Could not save recognition comparison", error);
        } finally {
          this.busy = false;
        }
      })();
      return record;
    } catch (error) {
      this.busy = false;
      throw error;
    }
  }
}
export const recognitionLab = new RecognitionLab();
export const defaultProfiles = [
  DEFAULT_RECOGNITION,
  { ...DEFAULT_RECOGNITION, beamSize: 3 },
];
