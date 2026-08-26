import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  PythonProcessor,
  remotePythonSandbox,
  type PythonSandboxRunner,
} from "./python";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true })),
  );
});

async function fixture(runner: PythonSandboxRunner) {
  const root = await mkdtemp(join(tmpdir(), "minisago-python-"));
  temporaryDirectories.push(root);
  const outputs = join(root, "outputs");
  await mkdir(outputs);
  await writeFile(join(root, "0-image.png"), "input");
  const processor = await PythonProcessor.create(
    {
      version: 1,
      root,
      outputDirectory: outputs,
      attachments: [
        {
          id: "attachment-1",
          filename: "image.png",
          contentType: "image/png",
          size: 5,
          storedFilename: "0-image.png",
        },
      ],
    },
    { runner, idFactory: () => "result" },
  );
  return processor;
}

describe("request-local Python", () => {
  test("sends only selected request-local attachment bytes", async () => {
    let received: Parameters<PythonSandboxRunner>[0] | undefined;
    const processor = await fixture(async (request) => {
      received = request;
      return {
        stdout: "done",
        stderr: "",
        artifact: { data: Buffer.from("result").toString("base64"), size: 6 },
      };
    });

    await expect(
      processor.run({
        code: "print('done')",
        mediaIds: ["attachment-1"],
        outputExtension: "png",
      }),
    ).resolves.toEqual({
      stdout: "done",
      stderr: "",
      mediaId: "python-result.png",
      size: 6,
    });
    expect(received).toEqual({
      code: "print('done')",
      attachments: [
        {
          id: "attachment-1",
          filename: "image.png",
          contentType: "image/png",
          data: Buffer.from("input").toString("base64"),
        },
      ],
      outputExtension: "png",
    });
  });

  test("rejects media IDs outside the active request", async () => {
    const processor = await fixture(async () => ({
      stdout: "",
      stderr: "",
    }));
    await expect(
      processor.run({ code: "pass", mediaIds: ["another-request"] }),
    ).rejects.toThrow("unavailable for this request");
  });

  test("rejects malformed artifacts from the sandbox", async () => {
    const processor = await fixture(async () => ({
      stdout: "",
      stderr: "",
      artifact: { data: Buffer.from("short").toString("base64"), size: 10 },
    }));
    await expect(
      processor.run({
        code: "pass",
        mediaIds: [],
        outputExtension: "txt",
      }),
    ).rejects.toThrow("invalid artifact");
  });

  test("uses only the configured internal sandbox endpoint", async () => {
    let url = "";
    const runner = remotePythonSandbox("http://sandbox:8080/base", (async (
      input,
    ) => {
      url = String(input);
      return new Response(JSON.stringify({ stdout: "ok", stderr: "" }));
    }) as typeof fetch);
    await expect(
      runner({ code: "print(1)", attachments: [] }),
    ).resolves.toEqual({ stdout: "ok", stderr: "" });
    expect(url).toBe("http://sandbox:8080/run");
  });
});
