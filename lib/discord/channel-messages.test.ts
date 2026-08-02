import { describe, expect, test } from "bun:test";

import { sendChannelMessage } from "./channel-messages";
import type { DiscordRequest } from "./chatbot";

describe("sendChannelMessage", () => {
  test("resolves exact server and channel names before sending", async () => {
    const requests: Array<{ path: string; options?: unknown }> = [];
    const discordRequest: DiscordRequest = async (path, options) => {
      requests.push({ path, options });
      if (path === "/users/@me/guilds") {
        return [{ id: "guild-1", name: "Friends of Sago" }] as never;
      }
      if (path === "/guilds/guild-1/channels") {
        return [
          { id: "channel-1", name: "general", type: 0 },
          { id: "category-1", name: "General", type: 4 },
        ] as never;
      }
      if (path === "/channels/channel-1/messages") {
        return { id: "message-1" } as never;
      }
      throw new Error(`Unexpected request: ${path}`);
    };

    const result = await sendChannelMessage({
      server: "friends of sago",
      channel: "general",
      content: "hello friends",
      discordRequest,
    });

    expect(requests.at(-1)).toEqual({
      path: "/channels/channel-1/messages",
      options: { method: "POST", body: { content: "hello friends" } },
    });
    expect(result).toEqual({
      id: "message-1",
      channelId: "channel-1",
      channelName: "general",
      guildId: "guild-1",
      guildName: "Friends of Sago",
      jumpUrl: "https://discord.com/channels/guild-1/channel-1/message-1",
    });
  });

  test("sends to an exact channel ID", async () => {
    const discordRequest: DiscordRequest = async (path, options) => {
      if (path === "/channels/123456789012345678") {
        return {
          id: "123456789012345678",
          guild_id: "987654321098765432",
          name: "announcements",
          type: 5,
        } as never;
      }
      if (path === "/channels/123456789012345678/messages") {
        expect(options).toEqual({
          method: "POST",
          body: { content: "ship it" },
        });
        return { id: "234567890123456789" } as never;
      }
      throw new Error(`Unexpected request: ${path}`);
    };

    const result = await sendChannelMessage({
      channelId: "123456789012345678",
      content: "ship it",
      discordRequest,
    });

    expect(result).toMatchObject({
      id: "234567890123456789",
      channelId: "123456789012345678",
      guildId: "987654321098765432",
    });
  });

  test("rejects ambiguous names without sending", async () => {
    const discordRequest: DiscordRequest = async (path) => {
      if (path === "/users/@me/guilds") {
        return [
          { id: "guild-1", name: "Sago" },
          { id: "guild-2", name: "sago" },
        ] as never;
      }
      throw new Error(`Unexpected request: ${path}`);
    };

    expect(
      sendChannelMessage({
        server: "Sago",
        channel: "general",
        content: "hello",
        discordRequest,
      }),
    ).rejects.toThrow("More than one server is named Sago");
  });
});
