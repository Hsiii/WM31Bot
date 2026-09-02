import {
  access,
  cp,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { basename, join } from "node:path";

import type { WorkerSkillbookStatus } from "../../contracts/worker-contract";

const MANIFEST_NAME = ".minisago-skillbook.json";
const DEFAULT_SYNC_INTERVAL_MS = 15 * 60_000;

export type SkillbookSkill = {
  name: string;
  repository: string;
  ref: string;
  path: string;
};

type SkillbookManifest = {
  version: 1;
  skillbookRevision: string;
  fingerprint: string;
  skills: string[];
};

type CommandRunner = (
  command: string[],
  environment: Record<string, string>,
) => Promise<string>;

type SkillbookSyncOptions = {
  codexHome: string;
  githubConfigDir: string;
  repository: string;
  intervalMs?: number;
};

function safeRepository(value: string) {
  if (!/^[a-z0-9_.-]+\/[a-z0-9_.-]+$/iu.test(value)) {
    throw new Error("Skillbook repository must use the owner/repository form.");
  }
  return value;
}

function safeSkillName(value: string) {
  if (!/^[a-z0-9][a-z0-9._-]{0,63}$/iu.test(value)) {
    throw new Error(`Skillbook contains an unsafe skill name: ${value}`);
  }
  return value;
}

function safeRef(value: string) {
  if (!/^[a-z0-9][a-z0-9._-]{0,127}$/iu.test(value)) {
    throw new Error(`Skillbook contains an unsafe Git ref: ${value}`);
  }
  return value;
}

export function parseSkillbook(markdown: string): SkillbookSkill[] {
  const skills = new Map<string, SkillbookSkill>();
  const links = markdown.matchAll(
    /\[\$([^\]]+)\]\((https:\/\/github\.com\/[^\s)]+)\)/giu,
  );

  for (const match of links) {
    const name = safeSkillName(match[1]!.trim());
    const url = new URL(match[2]!);
    const parts = url.pathname
      .split("/")
      .filter(Boolean)
      .map((part) => decodeURIComponent(part));
    if (parts.length < 5 || parts[2] !== "tree") continue;
    const repository = safeRepository(`${parts[0]}/${parts[1]}`);
    const ref = safeRef(parts[3]!);
    const path = parts.slice(4).join("/");
    if (
      !ref ||
      !path ||
      path.split("/").some((part) => !part || part === "." || part === "..")
    ) {
      throw new Error(`Skillbook contains an unsafe source for ${name}.`);
    }
    if (skills.has(name)) {
      throw new Error(`Skillbook lists ${name} more than once.`);
    }
    skills.set(name, { name, repository, ref, path });
  }

  if (skills.size === 0) {
    throw new Error("Skillbook does not contain any linked skills.");
  }
  return [...skills.values()].sort((left, right) =>
    left.name.localeCompare(right.name, "en-US"),
  );
}

async function runCommand(
  command: string[],
  environment: Record<string, string>,
) {
  const child = Bun.spawn(command, {
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, ...environment },
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (exitCode !== 0) {
    throw new Error(
      stderr.trim().split("\n").at(-1) ||
        `${basename(command[0]!)} exited with status ${exitCode}.`,
    );
  }
  return stdout;
}

async function readManifest(path: string): Promise<SkillbookManifest | null> {
  try {
    const value = JSON.parse(await readFile(path, "utf8")) as SkillbookManifest;
    return value.version === 1 &&
      typeof value.skillbookRevision === "string" &&
      /^[a-f0-9]{40}$/u.test(value.skillbookRevision) &&
      typeof value.fingerprint === "string" &&
      Array.isArray(value.skills) &&
      value.skills.every(
        (name) =>
          typeof name === "string" &&
          /^[a-z0-9][a-z0-9._-]{0,63}$/iu.test(name),
      )
      ? value
      : null;
  } catch {
    return null;
  }
}

async function assertNoSymlinks(path: string) {
  const entries = await readdir(path, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.name === ".git") continue;
    const child = join(path, entry.name);
    if (entry.isSymbolicLink()) {
      throw new Error("Skill sources cannot contain symbolic links.");
    }
    if (entry.isDirectory()) await assertNoSymlinks(child);
  }
}

async function hasInstalledSkills(
  skillsDirectory: string,
  manifest: SkillbookManifest,
) {
  try {
    await Promise.all(
      manifest.skills.map((name) =>
        access(join(skillsDirectory, name, "SKILL.md")),
      ),
    );
    return true;
  } catch {
    return false;
  }
}

export async function installManagedSkills({
  skillsDirectory,
  stagedDirectory,
  fingerprint,
  skillbookRevision,
  skills,
}: {
  skillsDirectory: string;
  stagedDirectory: string;
  fingerprint: string;
  skillbookRevision: string;
  skills: SkillbookSkill[];
}) {
  await mkdir(skillsDirectory, { recursive: true, mode: 0o700 });
  const manifestPath = join(skillsDirectory, MANIFEST_NAME);
  const previous = await readManifest(manifestPath);
  const names = skills.map((skill) => skill.name);
  const removed = (previous?.skills ?? []).filter(
    (name) => !names.includes(name),
  );
  const backupDirectory = join(
    skillsDirectory,
    `.minisago-skillbook-backup-${randomUUID()}`,
  );
  const backedUp: string[] = [];
  const installed: string[] = [];
  await mkdir(backupDirectory, { mode: 0o700 });

  try {
    for (const name of [...names, ...removed]) {
      const target = join(skillsDirectory, name);
      try {
        await lstat(target);
        await rename(target, join(backupDirectory, name));
        backedUp.push(name);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    }
    for (const name of names) {
      await rename(join(stagedDirectory, name), join(skillsDirectory, name));
      installed.push(name);
    }
    const temporaryManifest = join(
      skillsDirectory,
      `${MANIFEST_NAME}.${randomUUID()}`,
    );
    await writeFile(
      temporaryManifest,
      `${JSON.stringify(
        { version: 1, skillbookRevision, fingerprint, skills: names },
        null,
        2,
      )}\n`,
      { mode: 0o600 },
    );
    await rename(temporaryManifest, manifestPath);
    await rm(backupDirectory, { recursive: true, force: true });
  } catch (error) {
    for (const name of installed) {
      await rm(join(skillsDirectory, name), { recursive: true, force: true });
    }
    for (const name of backedUp) {
      await rename(join(backupDirectory, name), join(skillsDirectory, name));
    }
    await rm(backupDirectory, { recursive: true, force: true });
    throw error;
  }
}

export class SkillbookSync {
  private state: WorkerSkillbookStatus = {
    ok: true,
    syncing: false,
    skills: 0,
  };
  private timer?: ReturnType<typeof setInterval>;
  private syncing?: Promise<boolean>;

  constructor(
    private readonly options: SkillbookSyncOptions,
    private readonly command: CommandRunner = runCommand,
  ) {}

  status() {
    return { ...this.state };
  }

  async start(onChange: () => void, onStatus: () => void) {
    const changed = await this.sync().catch((error) => {
      console.warn(`Skillbook sync failed: ${this.message(error)}`);
      return false;
    });
    if (changed) onChange();
    onStatus();
    const interval = Math.max(
      60_000,
      this.options.intervalMs ?? DEFAULT_SYNC_INTERVAL_MS,
    );
    this.timer = setInterval(() => {
      void this.sync()
        .then((updated) => {
          if (updated) onChange();
          onStatus();
        })
        .catch((error) => {
          console.warn(`Skillbook sync failed: ${this.message(error)}`);
          onStatus();
        });
    }, interval);
    this.timer.unref?.();
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  sync() {
    if (this.syncing) return this.syncing;
    this.state = { ...this.state, syncing: true };
    this.syncing = this.performSync()
      .then((changed) => {
        this.state = {
          ok: true,
          syncing: false,
          skills: this.state.skills,
          revision: this.state.revision,
          lastSyncedAt: new Date().toISOString(),
        };
        return changed;
      })
      .catch((error) => {
        this.state = {
          ...this.state,
          ok: false,
          syncing: false,
          error: this.message(error),
        };
        throw error;
      })
      .finally(() => {
        this.syncing = undefined;
      });
    return this.syncing;
  }

  private async performSync() {
    const environment = {
      GH_CONFIG_DIR: this.options.githubConfigDir,
      GH_HOST: "github.com",
      GH_PROMPT_DISABLED: "1",
      GIT_TERMINAL_PROMPT: "0",
    };
    const repository = safeRepository(this.options.repository);
    const skillbookRevision = (
      await this.retryCommand(
        ["gh", "api", `repos/${repository}/commits/main`, "--jq", ".sha"],
        environment,
      )
    ).trim();
    if (!/^[a-f0-9]{40}$/u.test(skillbookRevision)) {
      throw new Error("GitHub returned an invalid Skillbook revision.");
    }
    const manifestPath = join(this.options.codexHome, "skills", MANIFEST_NAME);
    const currentManifest = await readManifest(manifestPath);
    if (
      currentManifest?.skillbookRevision === skillbookRevision &&
      (await hasInstalledSkills(
        join(this.options.codexHome, "skills"),
        currentManifest,
      ))
    ) {
      this.state.skills = currentManifest.skills.length;
      this.state.revision = skillbookRevision;
      return false;
    }
    const markdown = await this.retryCommand(
      [
        "gh",
        "api",
        `repos/${repository}/contents/README.md?ref=${skillbookRevision}`,
        "-H",
        "Accept: application/vnd.github.raw+json",
      ],
      environment,
    );
    const skills = parseSkillbook(markdown);
    const groups = new Map<string, SkillbookSkill[]>();
    for (const skill of skills) {
      const key = `${skill.repository}@${skill.ref}`;
      groups.set(key, [...(groups.get(key) ?? []), skill]);
    }
    const revisions = new Map<string, string>();
    for (const [key, sources] of groups.entries()) {
      const source = sources[0]!;
      const revision = (
        await this.retryCommand(
          [
            "gh",
            "api",
            `repos/${source.repository}/commits/${encodeURIComponent(source.ref)}`,
            "--jq",
            ".sha",
          ],
          environment,
        )
      ).trim();
      if (!/^[a-f0-9]{40}$/u.test(revision)) {
        throw new Error(`GitHub returned an invalid revision for ${key}.`);
      }
      revisions.set(key, revision);
    }
    const fingerprint = JSON.stringify(
      skills.map((skill) => ({
        ...skill,
        revision: revisions.get(`${skill.repository}@${skill.ref}`),
      })),
    );
    await mkdir(join(this.options.codexHome, "tmp"), {
      recursive: true,
      mode: 0o700,
    });
    const temporaryRoot = await mkdtemp(
      join(this.options.codexHome, "tmp", "skillbook-"),
    );
    const stagedDirectory = join(temporaryRoot, "staged");
    await mkdir(stagedDirectory, { mode: 0o700 });
    try {
      let groupIndex = 0;
      for (const sources of groups.values()) {
        const source = sources[0]!;
        const revision = revisions.get(`${source.repository}@${source.ref}`)!;
        const checkout = join(temporaryRoot, `source-${groupIndex++}`);
        await this.retryCommand(
          [
            "gh",
            "repo",
            "clone",
            source.repository,
            checkout,
            "--",
            "--depth=1",
            "--filter=blob:none",
            "--no-checkout",
          ],
          environment,
          async () => rm(checkout, { recursive: true, force: true }),
        );
        await this.retryCommand(
          ["git", "-C", checkout, "fetch", "--depth=1", "origin", revision],
          environment,
        );
        await this.retryCommand(
          [
            "git",
            "-C",
            checkout,
            "sparse-checkout",
            "set",
            "--no-cone",
            ...sources.map((skill) => skill.path),
          ],
          environment,
        );
        await this.retryCommand(
          ["git", "-C", checkout, "checkout", "--detach", revision],
          environment,
        );
        for (const skill of sources) {
          const sourceDirectory = join(checkout, skill.path);
          await access(join(sourceDirectory, "SKILL.md"));
          await assertNoSymlinks(sourceDirectory);
          await cp(sourceDirectory, join(stagedDirectory, skill.name), {
            recursive: true,
            errorOnExist: true,
            filter: (source) => basename(source) !== ".git",
          });
        }
      }
      await installManagedSkills({
        skillsDirectory: join(this.options.codexHome, "skills"),
        stagedDirectory,
        fingerprint,
        skillbookRevision,
        skills,
      });
      this.state.skills = skills.length;
      this.state.revision = skillbookRevision;
      console.log(`Skillbook synced ${skills.length} skills.`);
      return true;
    } finally {
      await rm(temporaryRoot, { recursive: true, force: true });
    }
  }

  private message(error: unknown) {
    return (error instanceof Error ? error.message : "Unknown error.").slice(
      0,
      500,
    );
  }

  private async retryCommand(
    command: string[],
    environment: Record<string, string>,
    beforeAttempt?: () => Promise<void>,
  ) {
    let lastError: unknown;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      await beforeAttempt?.();
      try {
        return await this.command(command, environment);
      } catch (error) {
        lastError = error;
        if (attempt < 2) await Bun.sleep(250 * 2 ** attempt);
      }
    }
    throw lastError;
  }
}
