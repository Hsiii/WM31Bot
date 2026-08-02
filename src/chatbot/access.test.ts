import { describe, expect, test } from "bun:test";

import {
  chatbotAccessTier,
  canUseChatbotCapability,
  getChatbotAccessConfig,
} from "./access";

const ACCESS_CONFIG = getChatbotAccessConfig({
  MINISAGO_CHATBOT_OWNER_USER_ID: "917446775873343600",
  MINISAGO_CHATBOT_GUILD_IDS: "917436845187563610,1282936453134815275",
  MINISAGO_CHATBOT_CHANNEL_IDS: "1517766866964316201",
});

describe("chatbot access policy", () => {
  test("validates deployment-specific Discord IDs", () => {
    expect(ACCESS_CONFIG.ownerUserId).toBe("917446775873343600");
    expect([...ACCESS_CONFIG.guildIds]).toEqual([
      "917436845187563610",
      "1282936453134815275",
    ]);
    expect([...ACCESS_CONFIG.channelIds]).toEqual(["1517766866964316201"]);
    expect(() => getChatbotAccessConfig({})).toThrow(
      "MINISAGO_CHATBOT_OWNER_USER_ID",
    );
    expect(() =>
      getChatbotAccessConfig({
        MINISAGO_CHATBOT_OWNER_USER_ID: "917446775873343600",
        MINISAGO_CHATBOT_GUILD_IDS: "not-an-id",
      }),
    ).toThrow("MINISAGO_CHATBOT_GUILD_IDS");
  });

  test("separates the owner from community users", () => {
    expect(chatbotAccessTier(ACCESS_CONFIG.ownerUserId, ACCESS_CONFIG)).toBe(
      "owner",
    );
    expect(chatbotAccessTier("community-member", ACCESS_CONFIG)).toBe(
      "community",
    );
  });

  test("grants capabilities by requester instead of request wording", () => {
    expect(
      canUseChatbotCapability("community-member", "chat", ACCESS_CONFIG),
    ).toBe(true);
    expect(
      canUseChatbotCapability("community-member", "dev", ACCESS_CONFIG),
    ).toBe(false);
    expect(
      canUseChatbotCapability("community-member", "mac", ACCESS_CONFIG),
    ).toBe(false);
    expect(
      canUseChatbotCapability(
        "community-member",
        "execution_route",
        ACCESS_CONFIG,
      ),
    ).toBe(false);
    expect(
      canUseChatbotCapability(ACCESS_CONFIG.ownerUserId, "dev", ACCESS_CONFIG),
    ).toBe(true);
    expect(
      canUseChatbotCapability(ACCESS_CONFIG.ownerUserId, "mac", ACCESS_CONFIG),
    ).toBe(true);
    expect(
      canUseChatbotCapability(
        ACCESS_CONFIG.ownerUserId,
        "execution_route",
        ACCESS_CONFIG,
      ),
    ).toBe(true);
  });
});
