import { describe, expect, test } from "bun:test";

import {
  BOT_CUSTOM_STATUS,
  buildBotPresence,
  ChannelTaskQueue,
} from "./gateway";

test("uses the configured custom status for the initial presence", () => {
  expect(buildBotPresence()).toEqual({
    since: null,
    activities: [
      {
        name: "Custom Status",
        type: 4,
        state: BOT_CUSTOM_STATUS,
      },
    ],
    status: "online",
    afk: false,
  });
});

describe("Discord gateway channel scheduling", () => {
  test("runs messages from one channel in arrival order", async () => {
    const queue = new ChannelTaskQueue();
    const events: string[] = [];
    let releaseFirst: (() => void) | undefined;

    const first = queue.run("channel-1", async () => {
      events.push("first:start");
      await new Promise<void>((resolve) => {
        releaseFirst = resolve;
      });
      events.push("first:end");
    });
    const second = queue.run("channel-1", async () => {
      events.push("second");
    });

    while (!releaseFirst) {
      await Promise.resolve();
    }
    expect(events).toEqual(["first:start"]);
    releaseFirst?.();
    await Promise.all([first, second]);
    expect(events).toEqual(["first:start", "first:end", "second"]);
  });

  test("does not block messages from different channels", async () => {
    const queue = new ChannelTaskQueue();
    let releaseFirst: (() => void) | undefined;
    let secondRan = false;

    const first = queue.run(
      "channel-1",
      () =>
        new Promise<void>((resolve) => {
          releaseFirst = resolve;
        }),
    );
    const second = queue.run("channel-2", async () => {
      secondRan = true;
    });

    await second;
    expect(secondRan).toBe(true);
    releaseFirst?.();
    await first;
  });
});
