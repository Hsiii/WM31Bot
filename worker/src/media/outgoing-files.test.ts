import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  outgoingFileLimits,
  prepareGeneratedArtifacts,
  prepareOutgoingFiles,
  requestedArtifactIds,
  requestedFilePaths,
} from "./outgoing-files";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true })),
  );
});

describe("Mac outgoing files", () => {
  test("extracts and removes the model-only files field", () => {
    expect(
      requestedFilePaths(
        JSON.stringify({
          reply: "found it",
          reaction: null,
          files: ["/tmp/a"],
        }),
      ),
    ).toEqual({
      content: JSON.stringify({ reply: "found it", reaction: null }),
      files: ["/tmp/a"],
    });
  });

  test("reads one regular file contained by an allowed root", async () => {
    const root = await mkdtemp(join(tmpdir(), "minisago-files-"));
    temporaryDirectories.push(root);
    const path = join(root, "notes.txt");
    await writeFile(path, "ship friday");

    const result = await prepareOutgoingFiles(
      JSON.stringify({ reply: "here", reaction: null, files: [path] }),
      [root],
    );

    expect(result.files).toEqual([
      {
        filename: "notes.txt",
        contentType: "text/plain",
        size: 11,
        data: Buffer.from("ship friday").toString("base64"),
      },
    ]);
  });

  test("rejects files and symlinks that escape the allowed roots", async () => {
    const parent = await mkdtemp(join(tmpdir(), "minisago-files-"));
    temporaryDirectories.push(parent);
    const root = join(parent, "allowed");
    await mkdir(root);
    const secret = join(parent, "secret.txt");
    await writeFile(secret, "nope");
    const link = join(root, "shortcut.txt");
    await symlink(secret, link);

    await expect(
      prepareOutgoingFiles(
        JSON.stringify({ reply: "", reaction: null, files: [link] }),
        [root],
      ),
    ).rejects.toThrow("outside the configured Mac file folders");
  });

  test("keeps the websocket upload bounded", () => {
    expect(outgoingFileLimits).toEqual({ count: 1, bytes: 8 * 1024 * 1024 });
  });
});

describe("generated artifacts", () => {
  test("extracts one generated artifact ID and removes the model-only field", () => {
    expect(
      requestedArtifactIds(
        JSON.stringify({
          reply: "done",
          reaction: null,
          artifacts: [
            "media-result.webp",
            "python-ignored.png",
            "../secret.txt",
          ],
        }),
      ),
    ).toEqual({
      content: JSON.stringify({ reply: "done", reaction: null }),
      artifacts: ["media-result.webp"],
    });
  });

  test("ignores reminder IDs and unsupported artifact names", () => {
    expect(
      requestedArtifactIds(
        JSON.stringify({
          reply: "reminder created",
          reaction: null,
          artifacts: [
            "e7452ed6-a4db-426a-9e71-a81d8f7640c0",
            "result.webp",
            "media-result.exe",
          ],
        }),
      ),
    ).toEqual({
      content: JSON.stringify({
        reply: "reminder created",
        reaction: null,
      }),
      artifacts: [],
    });
  });

  test("reads one generated artifact from the request output folder", async () => {
    const root = await mkdtemp(join(tmpdir(), "minisago-artifacts-"));
    temporaryDirectories.push(root);
    await writeFile(join(root, "media-result.webp"), "image");

    const result = await prepareGeneratedArtifacts(
      JSON.stringify({
        reply: "done",
        reaction: null,
        artifacts: ["media-result.webp"],
      }),
      root,
    );

    expect(result.content).toBe(
      JSON.stringify({ reply: "done", reaction: null }),
    );
    expect(result.files).toEqual([
      {
        filename: "media-result.webp",
        contentType: "image/webp",
        size: 5,
        data: Buffer.from("image").toString("base64"),
      },
    ]);
  });

  test("rejects generated artifact symlinks that escape the output folder", async () => {
    const parent = await mkdtemp(join(tmpdir(), "minisago-artifacts-"));
    temporaryDirectories.push(parent);
    const root = join(parent, "outputs");
    await mkdir(root);
    const secret = join(parent, "secret.txt");
    await writeFile(secret, "nope");
    await symlink(secret, join(root, "media-result.txt"));

    await expect(
      prepareGeneratedArtifacts(
        JSON.stringify({
          reply: "",
          reaction: null,
          artifacts: ["media-result.txt"],
        }),
        root,
      ),
    ).rejects.toThrow("outside the request output folder");
  });

  test("ignores generated artifacts outside the output allowlist", async () => {
    const root = await mkdtemp(join(tmpdir(), "minisago-artifacts-"));
    temporaryDirectories.push(root);
    const result = await prepareGeneratedArtifacts(
      JSON.stringify({
        reply: "done",
        reaction: null,
        artifacts: ["media-result.exe"],
      }),
      root,
    );

    expect(result).toEqual({
      content: JSON.stringify({ reply: "done", reaction: null }),
      files: [],
    });
  });
});
