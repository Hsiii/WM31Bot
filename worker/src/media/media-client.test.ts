import { describe, expect, test } from "bun:test";

import { httpMediaClient } from "./media-client";

describe("host media client", () => {
  test("uses only bearer-scoped media endpoints for reads and writes", async () => {
    const requests: Request[] = [];
    const client = httpMediaClient(
      "https://sago.test/api/chatbot/mcp",
      "request-token",
      (async (input, init) => {
        const request = new Request(input, init);
        requests.push(request);
        return request.method === "POST"
          ? Response.json({ mediaId: "media-1.png" }, { status: 201 })
          : new Response(new Uint8Array([1, 2]), {
              headers: {
                "content-type": "image/png",
                "x-minisago-filename": "avatar.png",
              },
            });
      }) as typeof fetch,
    );

    await expect(client.read("avatar-1")).resolves.toMatchObject({
      mediaId: "avatar-1",
      filename: "avatar.png",
      bytes: new Uint8Array([1, 2]),
    });
    await client.write({
      mediaId: "media-1.png",
      filename: "result.png",
      contentType: "image/png",
      bytes: new Uint8Array([3, 4]),
    });

    expect(requests.map((request) => request.url)).toEqual([
      "https://sago.test/api/chatbot/media/avatar-1",
      "https://sago.test/api/chatbot/media/media-1.png",
    ]);
    expect(
      requests.every(
        (request) =>
          request.headers.get("authorization") === "Bearer request-token",
      ),
    ).toBe(true);
  });
});
