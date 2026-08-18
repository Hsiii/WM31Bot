import { describe, expect, test } from "bun:test";

import {
  DISCORD_GUILD_INSTALL,
  buildDiscordApplicationUpdate,
} from "./install-settings";

describe("Discord install settings", () => {
  test("keeps interactions on the Gateway while preserving unrelated settings", () => {
    const update = buildDiscordApplicationUpdate({
      application: {
        integration_types_config: {
          [DISCORD_GUILD_INSTALL]: { preserved: true },
          "1": { user_install: true },
        },
      },
      scopes: ["bot"],
      permissions: "9123048549440",
    });

    expect(update).toEqual({
      install_params: {
        scopes: ["bot"],
        permissions: "9123048549440",
      },
      integration_types_config: {
        [DISCORD_GUILD_INSTALL]: {
          preserved: true,
          oauth2_install_params: {
            scopes: ["bot"],
            permissions: "9123048549440",
          },
        },
        "1": { user_install: true },
      },
      interactions_endpoint_url: null,
    });
  });
});
