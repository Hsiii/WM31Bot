import { expect, test } from "bun:test";

import { createDiscordRequest } from "./request";

test("serializes JSON and retries Discord rate limits", async () => {
  const originalFetch = globalThis.fetch;
  const requests: Array<{ url: string; init?: RequestInit }> = [];
  globalThis.fetch = (async (input, init) => {
    requests.push({ url: String(input), init });
    return requests.length === 1
      ? new Response(JSON.stringify({ retry_after: 0 }), { status: 429 })
      : Response.json({ id: "message-1" });
  }) as typeof fetch;

  try {
    const request = createDiscordRequest("secret");
    const result = await request<{ id: string }>("/channels/1/messages", {
      method: "POST",
      body: { content: "hello" },
    });

    expect(result).toEqual({ id: "message-1" });
    expect(requests).toHaveLength(2);
    expect(requests[0]).toEqual({
      url: "https://discord.com/api/v10/channels/1/messages",
      init: {
        method: "POST",
        headers: {
          Authorization: "Bot secret",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ content: "hello" }),
      },
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
});
