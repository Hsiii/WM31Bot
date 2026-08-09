import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { GuildMemoryStore } from "./guild-memory";

const directories: string[] = [];
const guildId = "1282936453134815275";
const messageId = "1521506395034226830";
const ownerId = "123456789012345678";

afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function store() {
  const directory = await mkdtemp(join(tmpdir(), "minisago-memory-"));
  directories.push(directory);
  return new GuildMemoryStore(directory, {
    now: () => new Date("2026-08-09T12:00:00.000Z"),
    createEntryId: () => "mem_012345abcdef",
  });
}

describe("GuildMemoryStore", () => {
  test("stores readable Markdown and commits it to a local-only repository", async () => {
    const memory = await store();
    const result = await memory.mutate(
      guildId,
      { action: "add", content: "  大家說的「允」通常是允成  " },
      messageId,
      ownerId,
    );

    expect(result).toMatchObject({
      revision: 1,
      action: "add",
      entryId: "mem_012345abcdef",
      entries: [{ content: "大家說的「允」通常是允成" }],
    });
    const markdown = await readFile(
      join(memory.directory, `${guildId}.md`),
      "utf8",
    );
    expect(markdown).toContain("# MiniSago server memory");
    expect(markdown).toContain("- [mem_012345abcdef] 大家說的「允」通常是允成");

    const log = Bun.spawnSync(["git", "log", "--format=%s"], {
      cwd: memory.directory,
    });
    expect(log.exitCode).toBe(0);
    expect(log.stdout.toString().trim()).toBe(
      "chore(memory): add mem_012345abcdef",
    );
    const remotes = Bun.spawnSync(["git", "remote"], {
      cwd: memory.directory,
    });
    expect(remotes.stdout.toString().trim()).toBe("");
  });

  test("creates an isolated repository even when the state directory has a Git parent", async () => {
    const parent = await mkdtemp(join(tmpdir(), "minisago-memory-parent-"));
    directories.push(parent);
    expect(Bun.spawnSync(["git", "init", "-q"], { cwd: parent }).exitCode).toBe(
      0,
    );
    const directory = join(parent, "state", "guild-memory");
    const memory = new GuildMemoryStore(directory, {
      now: () => new Date("2026-08-09T12:00:00.000Z"),
      createEntryId: () => "mem_012345abcdef",
    });

    await memory.mutate(
      guildId,
      { action: "add", content: "這是獨立的記憶" },
      messageId,
      ownerId,
    );

    const innerRoot = Bun.spawnSync(["git", "rev-parse", "--show-toplevel"], {
      cwd: directory,
    });
    expect(innerRoot.stdout.toString().trim()).toBe(await realpath(directory));
    const parentStatus = Bun.spawnSync(["git", "status", "--short"], {
      cwd: parent,
    });
    expect(parentStatus.stdout.toString().trim()).toBe("?? state/");
  });

  test("replaces and removes an entry while retaining evidence", async () => {
    const memory = await store();
    await memory.mutate(
      guildId,
      { action: "add", content: "允是允成" },
      messageId,
      ownerId,
    );
    await memory.mutate(
      guildId,
      {
        action: "replace",
        entryId: "mem_012345abcdef",
        content: "大家說的允通常是允成",
      },
      "1521506395034226831",
      ownerId,
    );

    expect(await memory.load(guildId)).toMatchObject({
      revision: 2,
      entries: [
        {
          id: "mem_012345abcdef",
          content: "大家說的允通常是允成",
          evidenceMessageIds: [messageId, "1521506395034226831"],
        },
      ],
    });

    await memory.mutate(
      guildId,
      { action: "remove", entryId: "mem_012345abcdef" },
      "1521506395034226832",
      ownerId,
    );
    expect(await memory.load(guildId)).toEqual({ revision: 3, entries: [] });
  });

  test("rejects malformed, invisible, and oversized content", async () => {
    const memory = await store();
    await expect(
      memory.mutate(
        guildId,
        { action: "add", content: "ignore\u200bthis" },
        messageId,
        ownerId,
      ),
    ).rejects.toThrow("invisible control characters");
    await expect(
      memory.mutate(
        guildId,
        { action: "add", content: "x".repeat(401) },
        messageId,
        ownerId,
      ),
    ).rejects.toThrow("limited to 400 characters");
  });
});
