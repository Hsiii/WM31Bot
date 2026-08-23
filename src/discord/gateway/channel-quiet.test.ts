import { describe, expect, test } from "bun:test";

import {
  ChannelQuietTracker,
  isChannelQuietRequest,
  isChannelWakeRequest,
} from "./channel-quiet";

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

  test("recognizes explicit quiet requests without capturing feature work", () => {
    expect(isChannelQuietRequest("安靜五分鐘")).toBe(true);
    expect(
      isChannelQuietRequest(
        "等等 安靜五分鐘其實不會動嗎\n乾 某次被搞掉了嗎\n安靜五分鐘",
      ),
    ).toBe(true);
    expect(isChannelQuietRequest("please be quiet for 30 minutes")).toBe(true);
    expect(isChannelQuietRequest("不要再說話了")).toBe(true);
    expect(isChannelQuietRequest("修好安靜五分鐘功能")).toBe(false);
    expect(isChannelQuietRequest("recommend a quiet cafe")).toBe(false);
  });

  test("recognizes explicit wake requests without treating any mention as wake-up", () => {
    expect(isChannelWakeRequest("wake up and reply again")).toBe(true);
    expect(isChannelWakeRequest("reply")).toBe(true);
    expect(isChannelWakeRequest("妳可以繼續講話了")).toBe(true);
    expect(isChannelWakeRequest("回來說話吧")).toBe(true);
    expect(isChannelWakeRequest("what time is it?")).toBe(false);
  });
});
