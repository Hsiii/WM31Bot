import { describe, expect, test } from "bun:test";

import { QuickReplyNudgeTracker } from "./quick-reply-nudge";

const TARGET_ID = "target";

function message(
  authorId: string,
  seconds: number,
  options: { channelId?: string; bot?: boolean } = {},
) {
  return {
    channel_id: options.channelId ?? "channel-1",
    timestamp: new Date(Date.UTC(2026, 7, 1, 0, 0, seconds)).toISOString(),
    author: { id: authorId, bot: options.bot },
  };
}

describe("quick reply nudge", () => {
  test("nudges once when the fourth reply arrives within 30 seconds", () => {
    const tracker = new QuickReplyNudgeTracker(TARGET_ID, () => "2026-08-01");

    for (const seconds of [0, 20, 40, 60]) {
      expect(tracker.observe(message("friend", seconds))).toBe(false);
      expect(tracker.observe(message(TARGET_ID, seconds + 10))).toBe(
        seconds === 60,
      );
    }

    expect(tracker.observe(message("friend", 80))).toBe(false);
    expect(tracker.observe(message(TARGET_ID, 81))).toBe(false);
  });

  test("does not count late replies or consecutive target messages", () => {
    const tracker = new QuickReplyNudgeTracker(TARGET_ID, () => "2026-08-01");

    expect(tracker.observe(message("friend", 0))).toBe(false);
    expect(tracker.observe(message(TARGET_ID, 31))).toBe(false);
    expect(tracker.observe(message(TARGET_ID, 32))).toBe(false);
  });

  test("requires the immediately previous message to be from another human", () => {
    const tracker = new QuickReplyNudgeTracker(TARGET_ID, () => "2026-08-01");

    expect(tracker.observe(message("friend", 0))).toBe(false);
    expect(tracker.observe(message("bot", 5, { bot: true }))).toBe(false);
    expect(tracker.observe(message(TARGET_ID, 10))).toBe(false);
  });

  test("keeps channel context separate and resets the daily threshold", () => {
    let day = "2026-08-01";
    const tracker = new QuickReplyNudgeTracker(TARGET_ID, () => day);

    expect(tracker.observe(message("friend", 0, { channelId: "one" }))).toBe(
      false,
    );
    expect(tracker.observe(message(TARGET_ID, 1, { channelId: "two" }))).toBe(
      false,
    );

    for (let index = 0; index < 4; index += 1) {
      expect(tracker.observe(message("friend", index * 10))).toBe(false);
      expect(tracker.observe(message(TARGET_ID, index * 10 + 1))).toBe(
        index === 3,
      );
    }

    day = "2026-08-02";
    expect(tracker.observe(message("friend", 50))).toBe(false);
    expect(tracker.observe(message(TARGET_ID, 51))).toBe(false);
  });
});
