import { describe, expect, test } from "bun:test";

import { canAddDiscordReactions, channelPermissions } from "./permissions";

const ADD_REACTION_PERMISSIONS = String((1n << 6n) | (1n << 10n) | (1n << 16n));

describe("Discord channel permissions", () => {
  test("combines member roles and applies channel overwrites", () => {
    const permissions = channelPermissions({
      guildId: "guild",
      botUserId: "bot",
      memberRoleIds: ["reactor"],
      roles: [
        { id: "guild", permissions: String(1n << 10n) },
        {
          id: "reactor",
          permissions: String((1n << 6n) | (1n << 16n)),
        },
      ],
      overwrites: [
        {
          id: "guild",
          type: 0,
          allow: "0",
          deny: String(1n << 6n),
        },
        {
          id: "reactor",
          type: 0,
          allow: String(1n << 6n),
          deny: "0",
        },
      ],
    });

    expect(canAddDiscordReactions(permissions)).toBe(true);
  });

  test("lets a member-specific deny override role permissions", () => {
    const permissions = channelPermissions({
      guildId: "guild",
      botUserId: "bot",
      memberRoleIds: [],
      roles: [{ id: "guild", permissions: ADD_REACTION_PERMISSIONS }],
      overwrites: [
        {
          id: "bot",
          type: 1,
          allow: "0",
          deny: String(1n << 16n),
        },
      ],
    });

    expect(canAddDiscordReactions(permissions)).toBe(false);
  });

  test("treats administrator as having reaction permissions", () => {
    const permissions = channelPermissions({
      guildId: "guild",
      botUserId: "bot",
      memberRoleIds: [],
      roles: [{ id: "guild", permissions: String(1n << 3n) }],
      overwrites: [],
    });

    expect(canAddDiscordReactions(permissions)).toBe(true);
  });
});
