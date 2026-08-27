import { describe, expect, test } from "bun:test";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  codexUsageEnvironment,
  parseCodexUsageResponse,
  readCodexUsage,
} from "./codex-usage";

describe("Codex usage reader", () => {
  test("uses the shared Codex runtime path with the Bun Node shim", () => {
    const environment = codexUsageEnvironment(
      "/tmp/codex-home",
      "/usr/local/bin/codex",
    );

    expect(environment.PATH.split(":")).toContain(
      "/usr/local/bun-node-fallback-bin",
    );
  });

  test("parses, clamps, labels, and sorts usage windows", () => {
    expect(
      parseCodexUsageResponse(
        {
          result: {
            rateLimits: {
              primary: {
                usedPercent: 120,
                windowDurationMins: 10_080,
                resetsAt: 1_800_604_800,
              },
              secondary: {
                usedPercent: 25,
                windowDurationMins: 300,
                resetsAt: 1_800_000_000,
              },
            },
          },
        },
        new Date("2026-08-02T00:00:00.000Z"),
      ),
    ).toEqual({
      windows: [
        {
          label: "5-hour",
          windowMinutes: 300,
          usedPercent: 25,
          remainingPercent: 75,
          resetsAt: "2027-01-15T08:00:00.000Z",
        },
        {
          label: "weekly",
          windowMinutes: 10_080,
          usedPercent: 100,
          remainingPercent: 0,
          resetsAt: "2027-01-22T08:00:00.000Z",
        },
      ],
      updatedAt: "2026-08-02T00:00:00.000Z",
    });
  });

  test("completes the Codex app-server handshake", async () => {
    const directory = await mkdtemp(join(tmpdir(), "minisago-usage-"));
    const executable = join(directory, "codex");
    try {
      await writeFile(
        executable,
        `#!/bin/sh
IFS= read -r initialize
printf '{"id":1,"result":{}}\\n'
IFS= read -r initialized
IFS= read -r request
printf '{"id":2,"result":{"rateLimits":{"primary":{"usedPercent":12,"windowDurationMins":10080,"resetsAt":1800000000},"secondary":null}}}\\n'
`,
      );
      await chmod(executable, 0o755);

      const usage = await readCodexUsage(
        { codexHome: directory, codexPath: executable },
        1_000,
      );
      expect(usage?.windows).toEqual([
        {
          label: "weekly",
          windowMinutes: 10_080,
          usedPercent: 12,
          remainingPercent: 88,
          resetsAt: "2027-01-15T08:00:00.000Z",
        },
      ]);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
