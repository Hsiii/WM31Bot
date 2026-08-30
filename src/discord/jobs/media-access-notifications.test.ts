import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { handleMediaAccessNotificationRequest } from "./media-access-notifications";

const originalFetch = globalThis.fetch;
const originalEnvironment = {
  DISCORD_BOT_TOKEN: process.env.DISCORD_BOT_TOKEN,
  MEDIA_ACCESS_NOTIFICATION_SECRET:
    process.env.MEDIA_ACCESS_NOTIFICATION_SECRET,
  MINISAGO_CHATBOT_OWNER_USER_ID: process.env.MINISAGO_CHATBOT_OWNER_USER_ID,
};

function request(secret = "notification-secret", body: unknown = {}) {
  return new Request(
    "https://minisago.example/api/internal/media-access-request",
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${secret}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    },
  );
}

describe("media access notifications", () => {
  beforeEach(() => {
    process.env.DISCORD_BOT_TOKEN = "test-bot-token";
    process.env.MEDIA_ACCESS_NOTIFICATION_SECRET = "notification-secret";
    process.env.MINISAGO_CHATBOT_OWNER_USER_ID = "917446775873343600";
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    for (const [name, value] of Object.entries(originalEnvironment)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  });

  test("rejects callers without the shared secret", async () => {
    let called = false;
    globalThis.fetch = (async () => {
      called = true;
      return Response.json({});
    }) as unknown as typeof fetch;

    const response = await handleMediaAccessNotificationRequest(
      request("wrong-secret"),
    );

    expect(response.status).toBe(401);
    expect(called).toBe(false);
  });

  test("opens an owner DM and sends the review link", async () => {
    const calls: Array<{ url: string; body: unknown }> = [];
    globalThis.fetch = (async (input, init) => {
      calls.push({
        url: String(input),
        body: typeof init?.body === "string" ? JSON.parse(init.body) : null,
      });

      if (String(input).endsWith("/users/@me/channels")) {
        return Response.json({ id: "owner-dm" });
      }
      return Response.json({ id: "message-id" });
    }) as typeof fetch;

    const response = await handleMediaAccessNotificationRequest(
      request("notification-secret", {
        githubLogin: "new-user",
        deviceName: "New User's Mac",
        reviewUrl: "https://media.hsichen.dev/admin",
      }),
    );

    expect(response.status).toBe(200);
    expect(calls).toEqual([
      {
        url: "https://discord.com/api/v10/users/@me/channels",
        body: { recipient_id: "917446775873343600" },
      },
      {
        url: "https://discord.com/api/v10/channels/owner-dm/messages",
        body: {
          content: [
            "New Sago Media access request",
            "GitHub: @new-user",
            "Device: New User's Mac",
            "Review: <https://media.hsichen.dev/admin>",
          ].join("\n"),
          allowed_mentions: { parse: [] },
        },
      },
    ]);
  });
});
