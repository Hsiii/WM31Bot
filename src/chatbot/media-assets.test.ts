import { describe, expect, test } from "bun:test";

import { ChatbotMediaRegistry } from "./media-assets";
import { handleChatbotMediaRequest, registerChatbotMcpSession } from "./mcp";

function handlers() {
  return {
    getPreviousTrace: async () => ({ status: "not_found" as const }),
    resolveContext: async () => ({
      history: { status: "complete" as const, messages: [] },
      search: { status: "not_requested" as const, results: [] },
      members: { status: "not_requested" as const, results: [] },
      previousTrace: { status: "not_requested" as const },
    }),
  };
}

describe("request-scoped media registry", () => {
  test("serves source media and accepts generated media with the same token", async () => {
    const registry = new ChatbotMediaRegistry(
      async () =>
        new Response(new Uint8Array([1, 2, 3]), {
          headers: { "content-type": "image/png" },
        }),
    );
    registry.registerUrl({
      mediaId: "avatar-1",
      filename: "avatar.png",
      contentType: "image/png",
      url: "https://cdn.discordapp.com/avatars/user/avatar.png",
    });
    const session = registerChatbotMcpSession(
      { ...handlers(), mediaRegistry: registry },
      { ttlMs: 1_000 },
    );
    const authorization = { authorization: `Bearer ${session.token}` };

    try {
      const source = await handleChatbotMediaRequest(
        new Request("https://sago.test/api/chatbot/media/avatar-1", {
          headers: authorization,
        }),
      );
      expect([...new Uint8Array(await source.arrayBuffer())]).toEqual([
        1, 2, 3,
      ]);

      const upload = await handleChatbotMediaRequest(
        new Request("https://sago.test/api/chatbot/media/media-result.webp", {
          method: "POST",
          headers: {
            ...authorization,
            "content-type": "image/webp",
            "x-minisago-filename": "result.webp",
          },
          body: new Uint8Array([4, 5, 6]),
        }),
      );
      expect(upload.status).toBe(201);
      expect(registry.get("media-result.webp")).toEqual({
        mediaId: "media-result.webp",
        filename: "result.webp",
        contentType: "image/webp",
        size: 3,
      });
    } finally {
      session.revoke();
    }
  });

  test("rejects arbitrary URLs and unknown media IDs", async () => {
    const registry = new ChatbotMediaRegistry();
    expect(() =>
      registry.registerUrl({
        mediaId: "bad",
        filename: "bad.png",
        url: "https://example.com/bad.png",
      }),
    ).toThrow("allowed Discord CDN");
    await expect(registry.read("missing")).rejects.toThrow("unavailable");
  });
});
