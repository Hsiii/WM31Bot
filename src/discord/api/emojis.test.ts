import { describe, expect, test } from "bun:test";

import type { DiscordRequest } from "../../chatbot/chatbot";
import {
  addGuildEmojiFromMedia,
  addGuildStickerFromMedia,
  copyGuildEmoji,
  listGuildEmojis,
  listSharedEmojiGuilds,
  renameGuildEmoji,
} from "./emojis";

const CREATE_EXPRESSIONS = (1n << 43n).toString();
const MANAGE_EXPRESSIONS = (1n << 30n).toString();

describe("guild expression tools", () => {
  test("lists every shared guild and reports expression permissions", async () => {
    const guilds = await listSharedEmojiGuilds(
      async () =>
        [
          { id: "2", name: "Zulu", permissions: "0" },
          { id: "1", name: "Alpha", permissions: CREATE_EXPRESSIONS },
        ] as never,
    );

    expect(guilds).toEqual([
      {
        id: "1",
        name: "Alpha",
        canCreateExpressions: true,
        canManageExpressions: false,
      },
      {
        id: "2",
        name: "Zulu",
        canCreateExpressions: false,
        canManageExpressions: false,
      },
    ]);
  });

  test("lists emojis by an exact shared guild name", async () => {
    const result = await listGuildEmojis({
      guild: "Source",
      discordRequest: async (path) =>
        (path === "/users/@me/guilds"
          ? [{ id: "source", name: "Source", permissions: "0" }]
          : [
              {
                id: "123456789012345678",
                name: "wave",
                animated: false,
              },
            ]) as never,
    });

    expect(result).toEqual({
      guild: {
        id: "source",
        name: "Source",
        canCreateExpressions: false,
        canManageExpressions: false,
      },
      emojis: [
        {
          id: "123456789012345678",
          name: "wave",
          animated: false,
          available: true,
        },
      ],
    });
  });

  test("copies an emoji by name between any two exact shared guilds", async () => {
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
      sourceGuild: "Source",
      destinationGuild: "Target",
      emoji: "WAVE",
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
      sourceGuild: { id: "source", name: "Source" },
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
        sourceGuild: "Source",
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

  test("adds image media to a guild and derives its name", async () => {
    const requests: Array<{ path: string; body?: unknown }> = [];
    const result = await addGuildEmojiFromMedia({
      destinationGuild: "Target",
      media: {
        filename: "party-parrot.png",
        contentType: "image/png",
        bytes: new Uint8Array([1, 2, 3]),
      },
      discordRequest: async (path, options) => {
        requests.push({ path, body: options?.body });
        return (
          path === "/users/@me/guilds"
            ? [
                {
                  id: "target",
                  name: "Target",
                  permissions: CREATE_EXPRESSIONS,
                },
              ]
            : {
                id: "987654321098765432",
                name: "party_parrot",
                animated: false,
              }
        ) as never;
      },
    });

    expect(result).toMatchObject({
      kind: "emoji",
      name: "party_parrot",
      guild: { id: "target", name: "Target" },
    });
    expect(requests.at(-1)).toEqual({
      path: "/guilds/target/emojis",
      body: {
        name: "party_parrot",
        image: "data:image/png;base64,AQID",
      },
    });
  });

  test("adds sticker media with multipart metadata", async () => {
    let uploaded: FormData | undefined;
    const result = await addGuildStickerFromMedia({
      destinationGuild: "Target",
      media: {
        filename: "party-parrot.png",
        contentType: "image/png",
        bytes: new Uint8Array([1, 2, 3]),
      },
      description: "A parrot celebrates.",
      tags: "🎉",
      discordRequest: async (path, options) => {
        if (path === "/users/@me/guilds") {
          return [
            {
              id: "target",
              name: "Target",
              permissions: CREATE_EXPRESSIONS,
            },
          ] as never;
        }
        uploaded = options?.formData;
        return {
          id: "987654321098765432",
          name: "party_parrot",
          description: "A parrot celebrates.",
          tags: "🎉",
          format_type: 1,
        } as never;
      },
    });

    expect(result).toMatchObject({
      kind: "sticker",
      name: "party_parrot",
      description: "A parrot celebrates.",
      tags: "🎉",
      formatType: 1,
      guild: { id: "target", name: "Target" },
    });
    expect(uploaded?.get("name")).toBe("party_parrot");
    expect(uploaded?.get("description")).toBe("A parrot celebrates.");
    expect(uploaded?.get("tags")).toBe("🎉");
    const file = uploaded?.get("file") as File;
    expect(file.name).toBe("party-parrot.png");
    expect(file.type).toBe("image/png");
    expect([...new Uint8Array(await file.arrayBuffer())]).toEqual([1, 2, 3]);
  });

  test("renames an emoji by exact name", async () => {
    const requests: Array<{
      path: string;
      method?: string;
      body?: unknown;
    }> = [];
    const result = await renameGuildEmoji({
      guild: "Target",
      emoji: "fan_avatar",
      name: "FrierenSleep",
      discordRequest: async (path, options) => {
        requests.push({ path, method: options?.method, body: options?.body });
        if (path === "/users/@me/guilds") {
          return [
            {
              id: "target",
              name: "Target",
              permissions: MANAGE_EXPRESSIONS,
            },
          ] as never;
        }
        if (path === "/guilds/target/emojis") {
          return [
            {
              id: "123456789012345678",
              name: "fan_avatar",
              animated: false,
            },
          ] as never;
        }
        return {
          id: "123456789012345678",
          name: "FrierenSleep",
          animated: false,
        } as never;
      },
    });

    expect(result).toMatchObject({
      kind: "emoji",
      id: "123456789012345678",
      name: "FrierenSleep",
      guild: { id: "target", name: "Target" },
    });
    expect(requests.at(-1)).toEqual({
      path: "/guilds/target/emojis/123456789012345678",
      method: "PATCH",
      body: { name: "FrierenSleep" },
    });
  });

  test("rejects renaming without Manage Expressions", async () => {
    await expect(
      renameGuildEmoji({
        guild: "Target",
        emoji: "fan_avatar",
        name: "FrierenSleep",
        discordRequest: async () =>
          [
            {
              id: "target",
              name: "Target",
              permissions: CREATE_EXPRESSIONS,
            },
          ] as never,
      }),
    ).rejects.toThrow("Manage Expressions permission in Target");
  });
});
