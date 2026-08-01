import { describe, expect, test } from "bun:test";

import type { DiscordRequest } from "./chatbot";
import { copyGuildEmoji, listSharedEmojiGuilds } from "./emojis";

const CREATE_EXPRESSIONS = (1n << 43n).toString();

describe("cross-guild emoji tools", () => {
  test("lists every shared guild and reports create permission", async () => {
    const guilds = await listSharedEmojiGuilds(
      async () =>
        [
          { id: "2", name: "Zulu", permissions: "0" },
          { id: "1", name: "Alpha", permissions: CREATE_EXPRESSIONS },
        ] as never,
    );

    expect(guilds).toEqual([
      { id: "1", name: "Alpha", canCreateExpressions: true },
      { id: "2", name: "Zulu", canCreateExpressions: false },
    ]);
  });

  test("copies an emoji from the current guild into an exact shared guild", async () => {
    const requests: Array<{ path: string; body?: unknown }> = [];
    const discordRequest: DiscordRequest = async (path, options) => {
      requests.push({ path, body: options?.body });
      if (path === "/users/@me/guilds") {
        return [
          { id: "source", name: "Source", permissions: "0" },
          { id: "target", name: "Target", permissions: CREATE_EXPRESSIONS },
        ] as never;
      }
      if (path === "/guilds/source/emojis") {
        return [
          { id: "123456789012345678", name: "wave", animated: false },
        ] as never;
      }
      return {
        id: "987654321098765432",
        name: "hello",
        animated: false,
      } as never;
    };

    const result = await copyGuildEmoji({
      sourceGuildId: "source",
      destinationGuild: "Target",
      emoji: "<:wave:123456789012345678>",
      name: "hello",
      discordRequest,
      fetchEmoji: async (url) => {
        expect(String(url)).toBe(
          "https://cdn.discordapp.com/emojis/123456789012345678.webp?size=128",
        );
        return new Response(new Uint8Array([1, 2, 3]));
      },
    });

    expect(result).toMatchObject({
      id: "987654321098765432",
      name: "hello",
      guild: { id: "target", name: "Target" },
    });
    expect(requests.at(-1)).toEqual({
      path: "/guilds/target/emojis",
      body: {
        name: "hello",
        image: "data:image/webp;base64,AQID",
      },
    });
  });

  test("rejects a destination where Sago cannot create expressions", async () => {
    await expect(
      copyGuildEmoji({
        sourceGuildId: "source",
        destinationGuild: "Target",
        emoji: "<:wave:123456789012345678>",
        discordRequest: async () =>
          [
            { id: "source", name: "Source", permissions: "0" },
            { id: "target", name: "Target", permissions: "0" },
          ] as never,
      }),
    ).rejects.toThrow("Create Expressions permission in Target");
  });
});
