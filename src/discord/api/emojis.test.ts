import { describe, expect, test } from "bun:test";

import type { DiscordRequest } from "../gateway/chatbot";
import {
  addGuildEmojiFromAttachment,
  copyGuildEmoji,
  listGuildEmojis,
  listSharedEmojiGuilds,
  selectEmojiImageAttachment,
} from "./emojis";

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

  test("selects an image from the replied-to message", () => {
    const attachment = {
      id: "image-1",
      filename: "party-parrot.gif",
      contentType: "image/gif",
      url: "https://cdn.discordapp.com/attachments/1/2/party-parrot.gif",
    };

    expect(
      selectEmojiImageAttachment({
        attachments: [],
        referencedAttachments: [attachment],
      }),
    ).toBe(attachment);
  });

  test("requires a filename when multiple images are available", () => {
    const images = ["first.png", "second.webp"].map((filename, index) => ({
      id: `image-${index}`,
      filename,
      contentType: index === 0 ? "image/png" : "image/webp",
      url: `https://cdn.discordapp.com/attachments/1/2/${filename}`,
    }));

    expect(() => selectEmojiImageAttachment({ attachments: images })).toThrow(
      "specify the exact filename",
    );
    expect(
      selectEmojiImageAttachment({
        attachments: images,
        selector: "second.webp",
      }),
    ).toBe(images[1]);
  });

  test("adds an attached image to a guild and derives its name", async () => {
    const requests: Array<{ path: string; body?: unknown }> = [];
    const result = await addGuildEmojiFromAttachment({
      destinationGuild: "Target",
      attachment: {
        id: "image-1",
        filename: "party-parrot.png",
        contentType: "image/png",
        url: "https://cdn.discordapp.com/attachments/1/2/party-parrot.png",
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
      fetchEmoji: async (url) => {
        expect(String(url)).toBe(
          "https://cdn.discordapp.com/attachments/1/2/party-parrot.png",
        );
        return new Response(new Uint8Array([1, 2, 3]));
      },
    });

    expect(result).toMatchObject({
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

  test("rejects non-Discord attachment URLs", async () => {
    await expect(
      addGuildEmojiFromAttachment({
        destinationGuild: "Target",
        attachment: {
          id: "image-1",
          filename: "image.png",
          contentType: "image/png",
          url: "https://example.com/image.png",
        },
        discordRequest: async () =>
          [
            {
              id: "target",
              name: "Target",
              permissions: CREATE_EXPRESSIONS,
            },
          ] as never,
      }),
    ).rejects.toThrow("must be a Discord attachment");
  });
});
