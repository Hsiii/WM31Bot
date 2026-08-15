import { describe, expect, test } from "bun:test";

import {
  canReplaceSocialMessage,
  getSocialProxyIdentity,
} from "./social-proxy";

describe("getSocialProxyIdentity", () => {
  test("uses the server nickname and server avatar", () => {
    expect(
      getSocialProxyIdentity({
        guild_id: "guild-1",
        author: {
          id: "4194304",
          username: "account",
          global_name: "Global Name",
          avatar: "user-avatar",
        },
        member: { nick: "Server Name", avatar: "a_server-avatar" },
      }),
    ).toEqual({
      username: "Server Name",
      avatarUrl:
        "https://cdn.discordapp.com/guilds/guild-1/users/4194304/avatars/a_server-avatar.gif?size=128",
    });
  });

  test("falls back to the global name and user avatar", () => {
    expect(
      getSocialProxyIdentity({
        guild_id: "guild-1",
        author: {
          id: "4194304",
          username: "account",
          global_name: "Global Name",
          avatar: "user-avatar",
          discriminator: "0",
        },
      }),
    ).toEqual({
      username: "Global Name",
      avatarUrl:
        "https://cdn.discordapp.com/avatars/4194304/user-avatar.png?size=128",
    });
  });

  test("uses Discord's default avatar when no custom avatar exists", () => {
    expect(
      getSocialProxyIdentity({
        author: {
          id: String(2n << 22n),
          username: "account",
          discriminator: "0",
        },
      }),
    ).toEqual({
      username: "account",
      avatarUrl: "https://cdn.discordapp.com/embed/avatars/2.png",
    });
  });
});

describe("canReplaceSocialMessage", () => {
  test("allows plain default messages", () => {
    expect(canReplaceSocialMessage({ type: 0, attachments: [] })).toBe(true);
  });

  test.each([
    ["reply", { type: 19 }],
    ["attachment", { attachments: [{}] }],
    ["sticker", { sticker_items: [{}] }],
    ["component", { components: [{}] }],
    ["forward", { message_snapshots: [{}] }],
    ["poll", { poll: {} }],
  ])("preserves a message with a %s", (_label, message) => {
    expect(canReplaceSocialMessage(message)).toBe(false);
  });
});
