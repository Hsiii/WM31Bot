import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { DiscordRequest } from "../api/request";
import { sendDeploymentNotificationIfNeeded } from "./deployment-notifications";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

test("reports one terminal deployment result after restart", async () => {
  const root = await mkdtemp(join(tmpdir(), "minisago-deploy-notification-"));
  roots.push(root);
  const statusFile = join(root, "status.json");
  const stateFile = join(root, "notification.json");
  const requests: Array<{ path: string; body?: unknown }> = [];
  const discordRequest = (async (
    path: string,
    options?: Parameters<DiscordRequest>[1],
  ) => {
    requests.push({ path, body: options?.body });
  }) as DiscordRequest;
  await writeFile(
    statusFile,
    JSON.stringify({
      commit: "0123456789abcdef0123456789abcdef01234567",
      channelId: "1282936453134815275",
      status: "complete",
      exitCode: 0,
      updatedAt: "2026-08-31T12:00:00Z",
    }),
  );

  const options = { statusFile, stateFile, discordRequest };
  await expect(sendDeploymentNotificationIfNeeded(options)).resolves.toBe(true);
  await expect(sendDeploymentNotificationIfNeeded(options)).resolves.toBe(
    false,
  );
  expect(requests).toEqual([
    {
      path: "/channels/1282936453134815275/messages",
      body: {
        content: "MiniSago deployed 0123456 successfully.",
        allowed_mentions: { parse: [] },
      },
    },
  ]);
});

test("ignores a running deployment", async () => {
  const root = await mkdtemp(join(tmpdir(), "minisago-deploy-notification-"));
  roots.push(root);
  const statusFile = join(root, "status.json");
  await writeFile(
    statusFile,
    JSON.stringify({
      commit: "0123456789abcdef0123456789abcdef01234567",
      channelId: "1282936453134815275",
      status: "running",
      exitCode: null,
      updatedAt: "2026-08-31T12:00:00Z",
    }),
  );

  await expect(
    sendDeploymentNotificationIfNeeded({
      statusFile,
      stateFile: join(root, "notification.json"),
      discordRequest: async () => {
        throw new Error("Discord should not be called");
      },
    }),
  ).resolves.toBe(false);
});
