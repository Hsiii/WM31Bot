import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  defaultFeatureAvailability,
  FeatureAvailabilityStore,
} from "./feature-availability";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true })),
  );
});

async function store(environment: NodeJS.ProcessEnv = {}) {
  const directory = await mkdtemp(join(tmpdir(), "minisago-features-"));
  directories.push(directory);
  return {
    directory,
    store: new FeatureAvailabilityStore(
      join(directory, "features.json"),
      environment,
    ),
  };
}

describe("feature availability", () => {
  test("preserves the old environment coverage as initial policy", () => {
    const snapshot = defaultFeatureAvailability({
      MINISAGO_CHATBOT_GUILD_IDS: "917436845187563610",
      MINISAGO_CHATBOT_CHANNEL_IDS: "1517766866964316201",
      MINISAGO_AMBIENT_REACTIONS_ENABLED: "true",
    });

    expect(snapshot.features.chatbot.rules).toEqual([
      { scope: "guild", targetId: "917436845187563610", enabled: true },
      { scope: "channel", targetId: "1517766866964316201", enabled: true },
    ]);
    expect(snapshot.features.ambient_reactions.rules).toEqual(
      snapshot.features.chatbot.rules,
    );
    expect(snapshot.features.trip_planner.defaultEnabled).toBe(false);
    expect(Object.keys(snapshot.features)).toEqual([
      "chatbot",
      "ambient_reactions",
      "trip_planner",
    ]);
  });

  test("uses channel rules before guild rules and persists changes", async () => {
    const { directory, store: availability } = await store();
    const guildId = "917436845187563610";
    const channelId = "1517766866964316201";

    await availability.configure({
      feature: "chatbot",
      scope: "guild",
      targetId: guildId,
      action: "enable",
    });
    await availability.configure({
      feature: "chatbot",
      scope: "channel",
      targetId: channelId,
      action: "disable",
    });

    expect(availability.isEnabled("chatbot", { guildId })).toBe(true);
    expect(availability.isEnabled("chatbot", { guildId, channelId })).toBe(
      false,
    );
    const reloaded = new FeatureAvailabilityStore(
      join(directory, "features.json"),
    );
    expect(reloaded.isEnabled("chatbot", { guildId, channelId })).toBe(false);

    await reloaded.configure({
      feature: "chatbot",
      scope: "channel",
      targetId: channelId,
      action: "inherit",
    });
    expect(reloaded.isEnabled("chatbot", { guildId, channelId })).toBe(true);
  });
});
