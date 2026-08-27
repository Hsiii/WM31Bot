import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { MacFileSearch } from "./mac-files";

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((root) => rm(root, { recursive: true })),
  );
});

describe("Mac file search", () => {
  test("matches all filename terms and returns metadata", async () => {
    const root = await mkdtemp(join(tmpdir(), "minisago-file-search-"));
    temporaryRoots.push(root);
    await mkdir(join(root, "Trips"));
    await writeFile(join(root, "Trips", "Kyushu plan.pdf"), "plan");
    await writeFile(join(root, "Trips", "Kyushu notes.txt"), "notes");
    const search = await MacFileSearch.create([root]);

    const matches = await search.search({
      query: "kyushu plan",
      extension: "pdf",
    });

    expect(matches).toHaveLength(1);
    expect(matches[0]).toMatchObject({
      filename: "Kyushu plan.pdf",
      size: 4,
    });
    expect(matches[0]!.path).toEndWith("/Trips/Kyushu plan.pdf");
  });

  test("skips hidden entries and symlinks", async () => {
    const root = await mkdtemp(join(tmpdir(), "minisago-file-search-"));
    temporaryRoots.push(root);
    await mkdir(join(root, ".secret"));
    await writeFile(join(root, ".secret", "budget.pdf"), "secret");
    await writeFile(join(root, "target.pdf"), "target");
    await symlink(join(root, "target.pdf"), join(root, "budget.pdf"));
    const search = await MacFileSearch.create([root]);

    expect(await search.search({ query: "budget" })).toEqual([]);
  });

  test("rejects roots outside the allowlist", async () => {
    const root = await mkdtemp(join(tmpdir(), "minisago-file-search-"));
    temporaryRoots.push(root);
    const search = await MacFileSearch.create([root]);

    await expect(
      search.search({ query: "notes", root: tmpdir() }),
    ).rejects.toThrow("not allowed");
  });
});
