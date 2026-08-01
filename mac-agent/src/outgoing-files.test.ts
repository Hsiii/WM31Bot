import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  outgoingFileLimits,
  prepareOutgoingFiles,
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
