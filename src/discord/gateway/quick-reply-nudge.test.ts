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

  test("ignores replies that do not satisfy the timing and context rules", () => {
    const cases = [
      [message("friend", 0), message(TARGET_ID, 31), message(TARGET_ID, 32)],
      [
        message("friend", 0),
        message("bot", 5, { bot: true }),
        message(TARGET_ID, 10),
      ],
      [message(TARGET_ID, 0), message("friend", 10), message(TARGET_ID, 20)],
      [
        message(TARGET_ID, 0, { channelId: "one" }),
        message("friend", 50, { channelId: "two" }),
        message(TARGET_ID, 55, { channelId: "two" }),
      ],
    ];

    for (const messages of cases) {
      const tracker = new QuickReplyNudgeTracker(TARGET_ID, () => "2026-08-01");
      expect(messages.map((item) => tracker.observe(item))).toEqual([
        false,
        false,
        false,
      ]);
    }
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
