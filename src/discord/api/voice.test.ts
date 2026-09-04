import { afterEach, describe, expect, test } from "bun:test";

import {
  buildVoiceStateUpdate,
  joinMemberVoiceChannel,
  leaveVoiceChannel,
  registerVoiceGateway,
  VoiceStateTracker,
} from "./voice";

afterEach(() => registerVoiceGateway(null));

test("builds a conversational Discord voice-state update", () => {
  expect(buildVoiceStateUpdate("guild-1", "voice-1")).toEqual({
    op: 4,
    d: {
      guild_id: "guild-1",
      channel_id: "voice-1",
      self_mute: false,
      self_deaf: false,
    },
  });
  expect(buildVoiceStateUpdate("guild-1", null).d.channel_id).toBeNull();
});

describe("VoiceStateTracker", () => {
  test("tracks moves and disconnects within each guild", () => {
    const tracker = new VoiceStateTracker();

    tracker.observe({
      guild_id: "guild-1",
      user_id: "user-1",
      channel_id: "voice-1",
    });
    tracker.observe({
      guild_id: "guild-2",
      user_id: "user-1",
      channel_id: "voice-2",
    });
    expect(tracker.getChannelId("guild-1", "user-1")).toBe("voice-1");
    expect(tracker.getChannelId("guild-2", "user-1")).toBe("voice-2");

    tracker.observe({
      guild_id: "guild-1",
      user_id: "user-1",
      channel_id: null,
    });
    expect(tracker.getChannelId("guild-1", "user-1")).toBeNull();
    expect(tracker.getChannelId("guild-2", "user-1")).toBe("voice-2");
  });

  test("replaces stale voice states when a guild snapshot arrives", () => {
    const tracker = new VoiceStateTracker();
    tracker.observe({
      guild_id: "guild-1",
      user_id: "stale-user",
      channel_id: "voice-1",
    });

    tracker.replaceGuild("guild-1", [
      { user_id: "current-user", channel_id: "voice-2" },
    ]);

    expect(tracker.getChannelId("guild-1", "stale-user")).toBeNull();
    expect(tracker.getChannelId("guild-1", "current-user")).toBe("voice-2");
  });
});

test("voice actions fail closed until the Discord gateway is ready", () => {
  expect(joinMemberVoiceChannel("guild-1", "user-1")).toEqual({
    status: "gateway_unavailable",
  });
  expect(leaveVoiceChannel("guild-1")).toEqual({
    status: "gateway_unavailable",
  });
});
