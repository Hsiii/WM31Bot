import { randomUUID } from "node:crypto";
import { readFile, realpath, rm, stat } from "node:fs/promises";
import { basename, isAbsolute, join, relative } from "node:path";

import { z } from "zod";

const MAX_CODE_CHARACTERS = 20_000;
const MAX_INPUT_BYTES = 20 * 1024 * 1024;
const MAX_TOTAL_INPUT_BYTES = 40 * 1024 * 1024;
const MAX_OUTPUT_BYTES = 8 * 1024 * 1024;
const SANDBOX_TIMEOUT_MS = 130_000;

export const pythonArtifactExtensions = [
  "csv",
  "docx",
  "gif",
  "jpeg",
  "jpg",
  "json",
  "mov",
  "mp3",
  "mp4",
  "pdf",
  "png",
  "txt",
  "webp",
  "xlsx",
  "zip",
] as const;

export const pythonSandboxRequestSchema = z.object({
  code: z.string().min(1).max(MAX_CODE_CHARACTERS),
  attachments: z
    .array(
      z.object({
        id: z.string().min(1).max(100),
        filename: z.string().min(1).max(255),
        contentType: z.string().max(100).optional(),
        data: z.string().max(Math.ceil((MAX_INPUT_BYTES * 4) / 3) + 8),
      }),
    )
    .max(10),
  outputExtension: z.enum(pythonArtifactExtensions).optional(),
});

export const pythonSandboxResponseSchema = z.object({
  stdout: z.string().max(8_000),
  stderr: z.string().max(2_000),
  artifact: z
    .object({
      data: z.string().max(Math.ceil((MAX_OUTPUT_BYTES * 4) / 3) + 8),
      size: z.number().int().positive().max(MAX_OUTPUT_BYTES),
    })
    .optional(),
});

const manifestSchema = z.object({
  version: z.literal(1),
  root: z.string().min(1),
  outputDirectory: z.string().min(1),
  attachments: z
    .array(
      z.object({
        id: z.string().min(1).max(100),
        filename: z.string().min(1).max(255),
        contentType: z.string().max(100).optional(),
        size: z.number().int().nonnegative().max(MAX_INPUT_BYTES),
        storedFilename: z.string().min(1).max(255),
      }),
    )
    .max(10),
});

type PythonManifest = z.infer<typeof manifestSchema>;
type SandboxRequest = z.infer<typeof pythonSandboxRequestSchema>;
type SandboxResponse = z.infer<typeof pythonSandboxResponseSchema>;
export type PythonSandboxRunner = (
  request: SandboxRequest,
) => Promise<SandboxResponse>;

function inside(root: string, candidate: string) {
  const pathFromRoot = relative(root, candidate);
  return (
    pathFromRoot === "" ||
    (!pathFromRoot.startsWith("..") && !isAbsolute(pathFromRoot))
  );
}

export function remotePythonSandbox(
  sandboxUrl: string,
  fetcher: typeof fetch = fetch,
): PythonSandboxRunner {
  const endpoint = new URL("/run", sandboxUrl);
  return async (request) => {
    const response = await fetcher(endpoint, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(request),
      signal: AbortSignal.timeout(SANDBOX_TIMEOUT_MS),
    });
    const body = await response.text();
    if (!response.ok) {
      throw new Error(
        body.slice(0, 2_000) || "Python sandbox rejected the job.",
      );
    }
    return pythonSandboxResponseSchema.parse(JSON.parse(body));
  };
}

export class PythonProcessor {
  private constructor(
    private readonly manifest: PythonManifest,
    private readonly runner: PythonSandboxRunner,
    private readonly idFactory: () => string,
  ) {}

  static async create(
    value: unknown,
    options: {
      runner: PythonSandboxRunner;
      idFactory?: () => string;
    },
  ) {
    const manifest = manifestSchema.parse(value);
    const root = await realpath(manifest.root);
    const outputDirectory = await realpath(manifest.outputDirectory);
    if (!inside(root, outputDirectory)) {
      throw new Error("Python output folder is outside the request root.");
    }
    return new PythonProcessor(
      { ...manifest, root, outputDirectory },
      options.runner,
      options.idFactory ?? randomUUID,
    );
  }

  static async fromFile(path: string, sandboxUrl: string) {
    return PythonProcessor.create(JSON.parse(await readFile(path, "utf8")), {
      runner: remotePythonSandbox(sandboxUrl),
    });
  }

  private async attachments(ids: string[]) {
    const uniqueIds = [...new Set(ids)];
    let totalBytes = 0;
    return Promise.all(
      uniqueIds.map(async (id) => {
        const attachment = this.manifest.attachments.find(
          (item) => item.id === id,
        );
        if (!attachment) {
          throw new Error("Attachment is unavailable for this request.");
        }
        if (basename(attachment.storedFilename) !== attachment.storedFilename) {
          throw new Error("Attachment manifest contains an invalid filename.");
        }
        const path = await realpath(
          join(this.manifest.root, attachment.storedFilename),
        );
        if (!inside(this.manifest.root, path)) {
          throw new Error("Attachment is outside the request root.");
        }
        const info = await stat(path);
        totalBytes += info.size;
        if (
          !info.isFile() ||
          info.size > MAX_INPUT_BYTES ||
          totalBytes > MAX_TOTAL_INPUT_BYTES
        ) {
          throw new Error("Attachments exceed the processing limit.");
        }
        return {
          id,
          filename: attachment.filename,
          contentType: attachment.contentType,
          data: (await readFile(path)).toString("base64"),
        };
      }),
    );
  }

  async run(input: {
    code: string;
    attachmentIds: string[];
    outputExtension?: (typeof pythonArtifactExtensions)[number];
  }) {
    if (!input.code.trim() || input.code.length > MAX_CODE_CHARACTERS) {
      throw new Error("Python code must be between 1 and 20,000 characters.");
    }
    const result = await this.runner({
      code: input.code,
      attachments: await this.attachments(input.attachmentIds),
      outputExtension: input.outputExtension,
    });
    const response: Record<string, unknown> = {
      stdout: result.stdout,
      stderr: result.stderr,
    };
    if (!input.outputExtension) return response;
    if (!result.artifact) {
      throw new Error("Python did not produce the requested artifact.");
    }
    const bytes = Buffer.from(result.artifact.data, "base64");
    if (bytes.byteLength !== result.artifact.size) {
      throw new Error("Python sandbox returned an invalid artifact.");
    }
    const artifactId = `python-${this.idFactory()}.${input.outputExtension}`;
    const path = join(this.manifest.outputDirectory, artifactId);
    try {
      await Bun.write(path, bytes);
      const info = await stat(path);
      if (!info.isFile() || info.size === 0 || info.size > MAX_OUTPUT_BYTES) {
        throw new Error("Generated artifact exceeds Discord's 8 MB limit.");
      }
      return { ...response, artifactId, size: info.size };
    } catch (error) {
      await rm(path, { force: true });
      throw error;
    }
  }
}
