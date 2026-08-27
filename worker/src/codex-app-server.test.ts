import { describe, expect, test } from "bun:test";
import { join } from "node:path";

import type { ChatbotTaskProgress } from "../../contracts/worker-contract";
import { CodexAppServerManager } from "./codex-app-server";

const fakeServer = join(
  import.meta.dir,
  "test-fixtures/fake-codex-app-server.ts",
);

function runOptions(
  onProgress: (progress: ChatbotTaskProgress) => void,
  jobId = "job-1",
) {
  return {
    jobId,
    taskId: "task-1",
    title: "Codex generated title",
    command: [process.execPath, fakeServer],
    cwd: import.meta.dir,
    environment: { ...process.env } as Record<string, string>,
    model: "gpt-5.6-sol",
    effort: "medium",
    developerInstructions: "Follow the coding policy.",
    prompt: "Implement the task.",
    imagePaths: [],
    onProgress,
  };
}

describe("Codex App Server manager", () => {
  test("keeps steering in the active turn and returns only its final answer", async () => {
    const manager = new CodexAppServerManager();
    expect(manager.status()).toEqual({ ok: true, sessions: 0, active: 0 });
    const progress: ChatbotTaskProgress[] = [];
    const result = manager.run(runOptions((item) => progress.push(item)));

    for (let attempt = 0; attempt < 100; attempt += 1) {
      if (progress.some((item) => item.summary === "Inspecting the task.")) {
        break;
      }
      await Bun.sleep(2);
    }

    expect(manager.status()).toEqual({ ok: true, sessions: 1, active: 1 });
    expect(await manager.steer("job-1", "Focus on the setup guide.")).toBe(
      true,
    );
    expect(await result).toBe("Finished after steering.");
    expect(manager.status()).toEqual({ ok: true, sessions: 1, active: 0 });
    expect(progress).toContainEqual({
      phase: "exploring",
      summary: "Inspecting the task.",
      kind: "trace",
    });
    expect(progress).toContainEqual({
      phase: "reviewing",
      summary: "Applying the new direction.",
      kind: "trace",
    });
    expect(
      progress.some((item) => item.summary === "Finished after steering."),
    ).toBe(false);
    manager.close();
  });

  test("interrupts without discarding the persistent Codex thread", async () => {
    const manager = new CodexAppServerManager();
    const firstProgress: ChatbotTaskProgress[] = [];
    const first = manager.run(
      runOptions((item) => firstProgress.push(item), "job-stop"),
    );

    for (let attempt = 0; attempt < 100; attempt += 1) {
      if (firstProgress.some((item) => item.summary === "Inspecting the task."))
        break;
      await Bun.sleep(2);
    }
    expect(await manager.interrupt("job-stop")).toBe(true);
    await expect(first).rejects.toThrow("cancelled or timed out");

    const secondProgress: ChatbotTaskProgress[] = [];
    const second = manager.run(
      runOptions((item) => secondProgress.push(item), "job-continue"),
    );
    for (let attempt = 0; attempt < 100; attempt += 1) {
      if (
        secondProgress.some((item) => item.summary === "Inspecting the task.")
      )
        break;
      await Bun.sleep(2);
    }
    expect(await manager.steer("job-continue", "Continue.")).toBe(true);
    expect(await second).toBe("Finished after steering.");
    manager.close();
  });
});
