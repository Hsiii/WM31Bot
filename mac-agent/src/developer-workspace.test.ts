import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { ChatbotJob } from "../../src/chatbot/protocol";
import { prepareDeveloperWorkspace } from "./developer-workspace";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

async function options() {
  const root = await mkdtemp(join(tmpdir(), "minisago-dev-workspace-"));
  roots.push(root);
  return {
    githubConfigDir: "/secrets/github",
    githubRepositories: ["sago-cream/mini-sago"],
    githubWorktreeRoot: join(root, "worktrees"),
  };
}

function job(mutationScope?: "code" | "issue"): ChatbotJob {
  return {
    id: "job-123",
    requesterUserId: "917446775873343600",
    purpose: "answer",
    executionMode: "dev",
    ...(mutationScope ? { mutationScope } : {}),
    repository: "sago-cream/mini-sago",
    channelId: "channel-1",
    requestMessageId: "message-1",
    request: "review the PR",
    messages: [],
  };
}

describe("developer workspace", () => {
  test("clones only the selected repo with the dedicated credential", async () => {
    const commands: Array<{
      command: string[];
      environment: Record<string, string>;
    }> = [];
    const workspace = await prepareDeveloperWorkspace(
      job(),
      await options(),
      async (command, environment) => {
        commands.push({ command, environment });
      },
    );

    expect(workspace.directory).toEndWith(
      "/worktrees/job-123/sago-cream/mini-sago",
    );
    expect(commands).toHaveLength(1);
    expect(commands[0]!.command.slice(0, 4)).toEqual([
      "gh",
      "repo",
      "clone",
      "sago-cream/mini-sago",
    ]);
    expect(commands[0]!.environment.GH_CONFIG_DIR).toBe("/secrets/github");
    expect(workspace.sandboxReadPaths[0]).toEndWith("/worktrees/job-123/bin");
    expect(workspace.sandboxReadPaths[1]).toBe("/secrets/github");
    expect(workspace.sandboxReadPaths).not.toContain(workspace.directory);
    expect(workspace.sandboxWritePaths).toEqual([
      join(workspace.directory, ".git"),
    ]);
    await workspace.cleanup();
  });

  test("uses the same credential for explicit write jobs", async () => {
    const commands: Array<{
      command: string[];
      environment: Record<string, string>;
    }> = [];
    await prepareDeveloperWorkspace(
      job("code"),
      await options(),
      async (command, environment) => {
        commands.push({ command, environment });
      },
    );

    expect(commands).toHaveLength(2);
    expect(
      commands.every(
        ({ environment }) => environment.GH_CONFIG_DIR === "/secrets/github",
      ),
    ).toBe(true);
    expect(commands[1]!.command.at(-1)).toBe("minisago/job-123");
  });

  test("preserves and reuses a coding task workspace", async () => {
    const workspaceOptions = await options();
    const commands: string[][] = [];
    const taskJob = {
      ...job("code"),
      developerTask: { id: "task-456" },
    };
    const first = await prepareDeveloperWorkspace(
      taskJob,
      workspaceOptions,
      async (command) => {
        commands.push(command);
        if (command.slice(0, 3).join(" ") === "gh repo clone") {
          await mkdir(command[4]!, { recursive: true });
        }
      },
    );
    await first.cleanup();

    const resumed = await prepareDeveloperWorkspace(
      {
        ...taskJob,
        id: "turn-2",
        developerTask: {
          id: "task-456",
          resumeSessionId: "019-session",
        },
      },
      workspaceOptions,
      async (command) => {
        commands.push(command);
      },
    );

    expect(resumed.directory).toBe(first.directory);
    expect(commands).toHaveLength(2);
    await resumed.cleanup();
  });

  test("blocks GitHub mutations outside the selected scope", async () => {
    const workspace = await prepareDeveloperWorkspace(
      job("issue"),
      await options(),
      async () => undefined,
    );
    const gh = join(workspace.environment.PATH!.split(":")[0]!, "gh");
    const environment = {
      ...process.env,
      ...workspace.environment,
      MINISAGO_REAL_GH: "/bin/echo",
    };
    const denied = Bun.spawn([gh, "pr", "create", "--draft"], {
      env: environment,
      stdout: "ignore",
      stderr: "ignore",
    });
    expect(await denied.exited).toBe(77);
    const allowed = Bun.spawn([gh, "issue", "comment", "12"], {
      env: environment,
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(await allowed.exited).toBe(0);
    expect(await new Response(allowed.stdout).text()).toContain(
      "issue comment 12",
    );
  });

  test("rejects a repository outside the worker advertisement", async () => {
    await expect(
      prepareDeveloperWorkspace(
        { ...job(), repository: "sago-cream/other" },
        await options(),
        async () => {
          throw new Error("command should not run");
        },
      ),
    ).rejects.toThrow("not available on this worker");
  });
});
