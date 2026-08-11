import { describe, expect, test } from "bun:test";

import { ChannelQuietTracker, isChannelWakeRequest } from "./channel-quiet";

describe("channel quiet mode", () => {
  test("uses a bounded default pause and expires it", () => {
    let now = Date.parse("2026-08-11T04:00:00.000Z");
    const tracker = new ChannelQuietTracker(() => now);

    expect(tracker.pause("channel-1")).toEqual({
      pausedUntil: "2026-08-11T04:10:00.000Z",
      durationMinutes: 10,
    });
    expect(tracker.isPaused("channel-1")).toBe(true);

    now += 10 * 60_000;
    expect(tracker.isPaused("channel-1")).toBe(false);
  });

  test("can be woken early without affecting other channels", () => {
    const tracker = new ChannelQuietTracker(() => 1_000);
    tracker.pause("channel-1", 30);
    tracker.pause("channel-2", 30);

    expect(tracker.wake("channel-1")).toBe(true);
    expect(tracker.isPaused("channel-1")).toBe(false);
    expect(tracker.isPaused("channel-2")).toBe(true);
  });

  test("recognizes explicit wake requests without treating any mention as wake-up", () => {
    expect(isChannelWakeRequest("wake up and reply again")).toBe(true);
    expect(isChannelWakeRequest("reply")).toBe(true);
    expect(isChannelWakeRequest("妳可以繼續講話了")).toBe(true);
    expect(isChannelWakeRequest("回來說話吧")).toBe(true);
    expect(isChannelWakeRequest("what time is it?")).toBe(false);
  });
});
