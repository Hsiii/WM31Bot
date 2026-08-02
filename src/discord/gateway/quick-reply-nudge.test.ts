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

    for (const seconds of [0, 70, 140, 210]) {
      expect(tracker.observe(message("friend", seconds))).toBe(false);
      expect(tracker.observe(message(TARGET_ID, seconds + 10))).toBe(
        seconds === 210,
      );
    }

    expect(tracker.observe(message("friend", 280))).toBe(false);
    expect(tracker.observe(message(TARGET_ID, 281))).toBe(false);
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

  test("does not count when the target spoke during the previous minute", () => {
    const tracker = new QuickReplyNudgeTracker(TARGET_ID, () => "2026-08-01");

    expect(tracker.observe(message(TARGET_ID, 0))).toBe(false);
    expect(tracker.observe(message("friend", 10))).toBe(false);
    expect(tracker.observe(message(TARGET_ID, 20))).toBe(false);
  });

  test("tracks target activity across channels", () => {
    const tracker = new QuickReplyNudgeTracker(TARGET_ID, () => "2026-08-01");

    expect(tracker.observe(message(TARGET_ID, 0, { channelId: "one" }))).toBe(
      false,
    );
    expect(tracker.observe(message("friend", 50, { channelId: "two" }))).toBe(
      false,
    );
    expect(tracker.observe(message(TARGET_ID, 55, { channelId: "two" }))).toBe(
      false,
    );
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
      expect(tracker.observe(message("friend", index * 70 + 70))).toBe(false);
      expect(tracker.observe(message(TARGET_ID, index * 70 + 71))).toBe(
        index === 3,
      );
    }

    day = "2026-08-02";
    expect(tracker.observe(message("friend", 350))).toBe(false);
    expect(tracker.observe(message(TARGET_ID, 351))).toBe(false);
  });
});
