import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  installManagedSkills,
  parseSkillbook,
  SkillbookSync,
} from "./skillbook";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

async function temporaryRoot() {
  const root = await mkdtemp(join(tmpdir(), "minisago-skillbook-test-"));
  roots.push(root);
  return root;
}

describe("Skillbook sync", () => {
  test("reads only named GitHub skill directory links", () => {
    expect(
      parseSkillbook(`
- [$unslop](https://github.com/cursor/plugins/tree/main/pstack/skills/unslop)
- [Ponytail](https://github.com/DietrichGebert/ponytail)
- [$pr](https://github.com/sago-cream/human-out-of-loop/tree/main/skills/pr)
`),
    ).toEqual([
      {
        name: "pr",
        repository: "sago-cream/human-out-of-loop",
        ref: "main",
        path: "skills/pr",
      },
      {
        name: "unslop",
        repository: "cursor/plugins",
        ref: "main",
        path: "pstack/skills/unslop",
      },
    ]);
  });

  test("replaces managed skills and preserves local ones", async () => {
    const root = await temporaryRoot();
    const skillsDirectory = join(root, "skills");
    const firstStage = join(root, "first-stage");
    await mkdir(join(firstStage, "bro"), { recursive: true });
    await mkdir(join(skillsDirectory, "local-only"), { recursive: true });
    await writeFile(join(firstStage, "bro", "SKILL.md"), "first");
    await writeFile(join(skillsDirectory, "local-only", "SKILL.md"), "local");
    await installManagedSkills({
      skillsDirectory,
      stagedDirectory: firstStage,
      fingerprint: "first",
      skillbookRevision: "a".repeat(40),
      skills: [
        {
          name: "bro",
          repository: "owner/skills",
          ref: "main",
          path: "bro",
        },
      ],
    });

    const secondStage = join(root, "second-stage");
    await mkdir(join(secondStage, "unslop"), { recursive: true });
    await writeFile(join(secondStage, "unslop", "SKILL.md"), "second");
    await installManagedSkills({
      skillsDirectory,
      stagedDirectory: secondStage,
      fingerprint: "second",
      skillbookRevision: "b".repeat(40),
      skills: [
        {
          name: "unslop",
          repository: "owner/skills",
          ref: "main",
          path: "unslop",
        },
      ],
    });

    expect(
      await readFile(join(skillsDirectory, "unslop", "SKILL.md"), "utf8"),
    ).toBe("second");
    expect(
      await readFile(join(skillsDirectory, "local-only", "SKILL.md"), "utf8"),
    ).toBe("local");
    await expect(
      readFile(join(skillsDirectory, "bro", "SKILL.md"), "utf8"),
    ).rejects.toThrow();
  });

  test("installs a linked source and refreshes it when its revision changes", async () => {
    const root = await temporaryRoot();
    const codexHome = join(root, "codex-home");
    let revision = "a".repeat(40);
    let contents = "version one";
    const commands: string[][] = [];
    const command = async (arguments_: string[]) => {
      commands.push(arguments_);
      if (arguments_[1] === "api" && arguments_.includes("--jq")) {
        return `${revision}\n`;
      }
      if (arguments_[1] === "api") {
        return "- [$bro](https://github.com/owner/skills/tree/main/bro)\n";
      }
      if (arguments_[1] === "repo") {
        const checkout = arguments_[4]!;
        await mkdir(join(checkout, "bro"), { recursive: true });
        await mkdir(join(checkout, "bro", ".git"), { recursive: true });
        await writeFile(join(checkout, "bro", "SKILL.md"), contents);
        await writeFile(join(checkout, "bro", ".git", "config"), "metadata");
      }
      return "";
    };
    const sync = new SkillbookSync(
      {
        codexHome,
        githubConfigDir: join(root, "github"),
        repository: "owner/skillbook",
      },
      command,
    );

    expect(await sync.sync()).toBe(true);
    expect(
      await readFile(join(codexHome, "skills", "bro", "SKILL.md"), "utf8"),
    ).toBe("version one");
    expect(await sync.sync()).toBe(false);
    await expect(
      readFile(join(codexHome, "skills", "bro", ".git", "config"), "utf8"),
    ).rejects.toThrow();

    await rm(join(codexHome, "skills", "bro"), {
      recursive: true,
      force: true,
    });
    expect(await sync.sync()).toBe(true);

    revision = "b".repeat(40);
    contents = "version two";
    expect(await sync.sync()).toBe(true);
    expect(
      await readFile(join(codexHome, "skills", "bro", "SKILL.md"), "utf8"),
    ).toBe("version two");
    expect(commands.some((entry) => entry[1] === "repo")).toBe(true);
    expect(
      commands.some(
        (entry) =>
          entry[0] === "git" &&
          entry.includes("--detach") &&
          entry.includes("b".repeat(40)),
      ),
    ).toBe(true);
    expect(sync.status()).toMatchObject({ ok: true, skills: 1 });
  });
});
