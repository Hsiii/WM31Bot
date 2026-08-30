import { timingSafeEqual } from "node:crypto";

import { getChatbotAccessConfig } from "../../chatbot/access";
import { createDiscordRequest } from "../api/request";

type AccessRequestNotification = {
  githubLogin: string;
  deviceName: string;
  reviewUrl: string;
};

type DirectMessageChannel = {
  id: string;
};

function safeEqual(left: string, right: string) {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);

  return (
    leftBuffer.length === rightBuffer.length &&
    timingSafeEqual(leftBuffer, rightBuffer)
  );
}

function notificationConfig() {
  const secret = process.env.MEDIA_ACCESS_NOTIFICATION_SECRET?.trim();
  const botToken = process.env.DISCORD_BOT_TOKEN?.trim();

  if (!secret || !botToken) return null;

  return {
    secret,
    botToken,
    ownerUserId: getChatbotAccessConfig().ownerUserId,
  };
}

function parseNotification(value: unknown): AccessRequestNotification | null {
  if (!value || typeof value !== "object") return null;

  const body = value as Record<string, unknown>;
  const githubLogin =
    typeof body.githubLogin === "string" ? body.githubLogin.trim() : "";
  const deviceName =
    typeof body.deviceName === "string"
      ? body.deviceName.trim().replaceAll(/\s+/gu, " ")
      : "";
  const reviewUrl =
    typeof body.reviewUrl === "string" ? body.reviewUrl.trim() : "";

  if (!/^[A-Za-z0-9-]{1,39}$/u.test(githubLogin)) return null;
  if (!deviceName || deviceName.length > 80) return null;

  try {
    if (new URL(reviewUrl).protocol !== "https:") return null;
  } catch {
    return null;
  }

  return { githubLogin, deviceName, reviewUrl };
}

export async function handleMediaAccessNotificationRequest(request: Request) {
  const config = notificationConfig();
  if (!config) return new Response("Not configured.\n", { status: 503 });

  const token = /^Bearer (.+)$/u.exec(
    request.headers.get("authorization") ?? "",
  )?.[1];
  if (!token || !safeEqual(token, config.secret)) {
    return new Response("Unauthorized.\n", { status: 401 });
  }

  let notification: AccessRequestNotification | null = null;
  try {
    notification = parseNotification(await request.json());
  } catch {
    // Invalid JSON is handled like any other invalid notification body.
  }
  if (!notification) {
    return new Response("Invalid notification.\n", { status: 400 });
  }

  const discordRequest = createDiscordRequest(config.botToken);
  const channel = await discordRequest<DirectMessageChannel>(
    "/users/@me/channels",
    {
      method: "POST",
      body: { recipient_id: config.ownerUserId },
    },
  );
  await discordRequest(`/channels/${channel.id}/messages`, {
    method: "POST",
    body: {
      content: [
        "New Sago Media access request",
        `GitHub: @${notification.githubLogin}`,
        `Device: ${notification.deviceName}`,
        `Review: <${notification.reviewUrl}>`,
      ].join("\n"),
      allowed_mentions: { parse: [] },
    },
  });

  return Response.json({ ok: true });
}
