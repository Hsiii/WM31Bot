import { readFile } from "node:fs/promises";

import type { DiscordRequest } from "../api/request";
import { createDiscordRequest } from "../api/request";
import { readJsonFile, writeJsonFile } from "./job-utils";

const CHECK_INTERVAL_MS = 5_000;
const DISCORD_SNOWFLAKE = /^\d{17,20}$/u;
const COMMIT_SHA = /^[0-9a-f]{40}$/u;

type DeploymentStatus = {
  commit: string;
  channelId: string;
  status: "complete" | "failed";
  exitCode: number | null;
  updatedAt: string;
};

type NotificationState = {
  lastNotification?: string;
};

type DeploymentNotificationOptions = {
  statusFile: string;
  stateFile: string;
  discordRequest: DiscordRequest;
};

function parseDeploymentStatus(value: unknown): DeploymentStatus | null {
  if (!value || typeof value !== "object") return null;
  const status = value as Partial<DeploymentStatus>;
  if (
    !status.commit ||
    !COMMIT_SHA.test(status.commit) ||
    !status.channelId ||
    !DISCORD_SNOWFLAKE.test(status.channelId) ||
    !status.updatedAt ||
    !Number.isFinite(Date.parse(status.updatedAt)) ||
    !["complete", "failed"].includes(status.status ?? "") ||
    (status.exitCode !== null && typeof status.exitCode !== "number")
  ) {
    return null;
  }
  return status as DeploymentStatus;
}

async function readDeploymentStatus(path: string) {
  try {
    return parseDeploymentStatus(JSON.parse(await readFile(path, "utf8")));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

export async function sendDeploymentNotificationIfNeeded(
  options: DeploymentNotificationOptions,
) {
  const status = await readDeploymentStatus(options.statusFile);
  if (!status) return false;

  const notificationId = `${status.commit}:${status.status}:${status.updatedAt}`;
  const state = await readJsonFile<NotificationState>(
    options.stateFile,
    () => ({}),
  );
  if (state.lastNotification === notificationId) return false;

  const shortCommit = status.commit.slice(0, 7);
  const content =
    status.status === "complete"
      ? `MiniSago deployed ${shortCommit} successfully.`
      : `MiniSago deployment ${shortCommit} failed with exit code ${status.exitCode ?? "unknown"}.`;
  await options.discordRequest(`/channels/${status.channelId}/messages`, {
    method: "POST",
    body: { content, allowed_mentions: { parse: [] } },
  });
  await writeJsonFile(options.stateFile, { lastNotification: notificationId });
  return true;
}

export function startDeploymentNotificationMonitor() {
  const botToken = process.env.DISCORD_BOT_TOKEN?.trim();
  const statusFile = process.env.MINISAGO_DEPLOY_STATUS_FILE?.trim();
  const stateFile = process.env.MINISAGO_DEPLOY_NOTIFICATION_STATE_FILE?.trim();
  if (!botToken || !statusFile || !stateFile) return null;

  const options = {
    statusFile,
    stateFile,
    discordRequest: createDiscordRequest(botToken),
  };
  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      await sendDeploymentNotificationIfNeeded(options);
    } catch (error) {
      console.error("Failed to report MiniSago deployment status:", error);
    } finally {
      running = false;
    }
  };
  void tick();
  const timer = setInterval(() => void tick(), CHECK_INTERVAL_MS);
  timer.unref?.();
  return { stop: () => clearInterval(timer) };
}
