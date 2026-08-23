import { describe, expect, test } from "bun:test";

import type { ChatbotJob } from "../../chatbot/protocol";
import type { DiscordRequest } from "./chatbot";
import {
  AmbientReactionController,
  DEFAULT_AMBIENT_REACTION_POLICY,
  getAmbientReactionPolicy,
} from "./social-reactions";

const ACCESS_CONFIG = {
  ownerUserId: "917446775873343600",
  guildIds: new Set(["guild-1"]),
  channelIds: new Set<string>(),
  roleIds: new Set<string>(),
};

const MESSAGE = {
  id: "message-1",
  channel_id: "channel-1",
  guild_id: "guild-1",
  content: "websocket 終於修好了",
  timestamp: "2026-07-23T04:00:00.000Z",
  author: {
    id: "member-1",
    username: "member",
  },
  attachments: [],
};

const SECOND_MESSAGE = {
  ...MESSAGE,
  id: "message-2",
  content: "我真的快哭了",
  timestamp: "2026-07-23T04:00:10.000Z",
};

const REACTION_PERMISSIONS = String((1n << 6n) | (1n << 10n) | (1n << 16n));

const TEST_POLICY = {
  ...DEFAULT_AMBIENT_REACTION_POLICY,
  attentionProbability: 1,
};

function discordFixture(requests: string[]) {
  return (async <T>(path: string, options?: { method?: string }) => {
    requests.push(`${options?.method ?? "GET"} ${path}`);
    if (path === "/channels/channel-1") {
      return {
        id: "channel-1",
        type: 0,
        permission_overwrites: [],
      } as T;
    }
    if (path === "/guilds/guild-1/members/bot-1") {
      return { roles: [] } as T;
    }
    if (path === "/guilds/guild-1/roles") {
      return [{ id: "guild-1", permissions: REACTION_PERMISSIONS }] as T;
    }
    if (path === "/guilds/guild-1/emojis") {
      return [
        { id: "emoji-1", name: "sago", animated: true, available: true },
      ] as T;
    }
    if (path.startsWith("/channels/channel-1/messages?")) {
      return [SECOND_MESSAGE, MESSAGE] as T;
    }
    if (path.includes("/reactions/")) return undefined as T;
    throw new Error(`Unexpected Discord request: ${path}`);
  }) satisfies DiscordRequest;
}

function harness(output: string, policy = TEST_POLICY) {
  let now = Date.parse(MESSAGE.timestamp) + 1_000;
  let scheduledTask: (() => void) | undefined;
  let scheduledDelay: number | undefined;
  const jobs: ChatbotJob[] = [];
  const logs: Array<Record<string, unknown>> = [];
  const ambient = new AmbientReactionController({
    now: () => now,
    random: () => 0,
    policy,
    schedule: (task, delay) => {
      scheduledTask = task;
      scheduledDelay = delay;
      return Symbol("timer");
    },
    cancel: () => undefined,
    dispatch: (job) => {
      jobs.push(job);
      return {
        status: "accepted",
        result: Promise.resolve({ ok: true, content: output }),
      };
    },
    log: (event) => logs.push(event),
  });
  return {
    ambient,
    jobs,
    logs,
    get scheduledDelay() {
      return scheduledDelay;
    },
    setNow(value: number) {
      now = value;
    },
    async runScheduled() {
      const task = scheduledTask;
      scheduledTask = undefined;
      task?.();
      await new Promise((resolve) => setTimeout(resolve, 0));
    },
  };
}

describe("ambient Discord attention", () => {
  test("buffers a conversation burst and spends no model call until attention fires", async () => {
    const requests: string[] = [];
    const test = harness(
      '{"action":"discord.add_reaction","messageId":"message-2","emoji":"🥹"}',
    );
    const discordRequest = discordFixture(requests);

    expect(
      test.ambient.observe({
        message: MESSAGE,
        botUserId: "bot-1",
        accessConfig: ACCESS_CONFIG,
        discordRequest,
      }),
    ).toBe(true);
    test.setNow(Date.parse(SECOND_MESSAGE.timestamp) + 1_000);
    expect(
      test.ambient.observe({
        message: SECOND_MESSAGE,
        botUserId: "bot-1",
        accessConfig: ACCESS_CONFIG,
        discordRequest,
      }),
    ).toBe(false);
    expect(test.scheduledDelay).toBe(20_000);
    expect(test.jobs).toHaveLength(0);
    expect(requests).toHaveLength(0);

    await test.runScheduled();

    expect(test.jobs).toHaveLength(1);
    expect(test.jobs[0]?.purpose).toBe("social_action");
    expect(test.jobs[0]?.socialActionCandidateMessageIds).toEqual([
      "message-1",
      "message-2",
    ]);
    expect(test.jobs[0]?.availableTools?.[0]?.metadata).toMatchObject({
      standardUnicodeEmoji: true,
      customEmojiStatus: "complete",
      customEmojis: [{ value: "sago:emoji-1", name: "sago", animated: true }],
    });
    expect(requests).toContain(
      "PUT /channels/channel-1/messages/message-2/reactions/%F0%9F%A5%B9/@me",
    );
  });

  test("usually ignores notifications without calling the model", () => {
    const requests: string[] = [];
    const test = harness('{"action":"ignore","messageId":null,"emoji":null}', {
      ...TEST_POLICY,
      attentionProbability: 0,
    });

    expect(
      test.ambient.observe({
        message: MESSAGE,
        botUserId: "bot-1",
        accessConfig: ACCESS_CONFIG,
        discordRequest: discordFixture(requests),
      }),
    ).toBe(false);
    expect(test.jobs).toHaveLength(0);
    expect(requests).toHaveLength(0);
  });

  test("enforces the model-call budget before scheduling attention", () => {
    const requests: string[] = [];
    const test = harness('{"action":"ignore","messageId":null,"emoji":null}', {
      ...TEST_POLICY,
      maximumEvaluationsPerHour: 0,
    });

    expect(
      test.ambient.observe({
        message: MESSAGE,
        botUserId: "bot-1",
        accessConfig: ACCESS_CONFIG,
        discordRequest: discordFixture(requests),
      }),
    ).toBe(false);
    expect(test.scheduledDelay).toBeUndefined();
    expect(test.jobs).toHaveLength(0);
  });

  test("accepts only a candidate message and an available emoji", async () => {
    const requests: string[] = [];
    const test = harness(
      '{"action":"discord.add_reaction","messageId":"older-message","emoji":"other:emoji-2"}',
    );

    test.ambient.observe({
      message: MESSAGE,
      botUserId: "bot-1",
      accessConfig: ACCESS_CONFIG,
      discordRequest: discordFixture(requests),
    });
    await test.runScheduled();

    expect(requests.some((request) => request.startsWith("PUT "))).toBe(false);
  });

  test("does not call the model without effective Discord permission", async () => {
    const requests: string[] = [];
    const request = discordFixture(requests);
    const deniedRequest = (async <T>(
      path: string,
      options?: { method?: string; body?: unknown },
    ) => {
      if (path === "/guilds/guild-1/roles") {
        return [{ id: "guild-1", permissions: "0" }] as T;
      }
      return request<T>(path, options);
    }) satisfies DiscordRequest;
    const test = harness(
      '{"action":"discord.add_reaction","messageId":"message-1","emoji":"🎉"}',
    );

    test.ambient.observe({
      message: MESSAGE,
      botUserId: "bot-1",
      accessConfig: ACCESS_CONFIG,
      discordRequest: deniedRequest,
    });
    await test.runScheduled();

    expect(test.jobs).toHaveLength(0);
  });

  test("skips messages outside configured community channels", () => {
    const requests: string[] = [];
    const test = harness('{"action":"ignore","messageId":null,"emoji":null}');

    expect(
      test.ambient.observe({
        message: { ...MESSAGE, guild_id: "other-guild" },
        botUserId: "bot-1",
        accessConfig: ACCESS_CONFIG,
        discordRequest: discordFixture(requests),
      }),
    ).toBe(false);
    expect(test.jobs).toHaveLength(0);
    expect(requests).toHaveLength(0);
  });

  test("validates the configurable attention and cost limits", () => {
    expect(DEFAULT_AMBIENT_REACTION_POLICY.maximumEvaluationsPerHour).toBe(4);
    expect(
      getAmbientReactionPolicy({
        MINISAGO_AMBIENT_ATTENTION_CHANCE: "0.4",
        MINISAGO_AMBIENT_MAX_CHECKS_PER_HOUR: "2",
      }),
    ).toMatchObject({
      attentionProbability: 0.4,
      maximumEvaluationsPerHour: 2,
    });
    expect(() =>
      getAmbientReactionPolicy({
        MINISAGO_AMBIENT_ATTENTION_CHANCE: "2",
      }),
    ).toThrow("MINISAGO_AMBIENT_ATTENTION_CHANCE");
  });
});
