import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { ReminderScheduler, type Reminder } from "./reminders";

const schedulers: ReminderScheduler[] = [];
const directories: string[] = [];

async function setup(now: Date, post = async (_reminder: Reminder) => {}) {
  const directory = await mkdtemp(join(tmpdir(), "minisago-reminders-"));
  directories.push(directory);
  let currentTime = now;
  const scheduler = new ReminderScheduler({
    stateFile: join(directory, "reminders.json"),
    post,
    now: () => currentTime,
  });
  schedulers.push(scheduler);
  await scheduler.start();
  return {
    scheduler,
    setNow(value: Date) {
      currentTime = value;
    },
    stateFile: join(directory, "reminders.json"),
  };
}

afterEach(async () => {
  for (const scheduler of schedulers.splice(0)) scheduler.stop();
  for (const directory of directories.splice(0)) {
    await rm(directory, { recursive: true, force: true });
  }
});

describe("Reminder scheduler", () => {
  test("creates, persists, scopes, and cancels one-time reminders", async () => {
    const test = await setup(new Date("2026-07-25T10:00:00.000Z"));
    const reminder = await test.scheduler.create({
      requesterUserId: "user-1",
      channelId: "channel-1",
      content: "  drink water  ",
      runAt: "2026-07-25T18:30:00+08:00",
    });

    expect(reminder).toMatchObject({
      requesterUserId: "user-1",
      channelId: "channel-1",
      content: "drink water",
      nextRunAt: "2026-07-25T10:30:00.000Z",
    });
    expect(await test.scheduler.list("user-2", "channel-1")).toEqual([]);
    expect(await test.scheduler.list("user-1", "channel-2")).toEqual([]);
    expect(
      await test.scheduler.cancel("user-2", "channel-1", reminder.id),
    ).toBe(false);
    expect(
      await test.scheduler.cancel("user-1", "channel-1", reminder.id),
    ).toBe(true);
    expect(
      JSON.parse(await readFile(test.stateFile, "utf8")).reminders,
    ).toEqual([]);
  });

  test("posts a due timer once and removes it", async () => {
    const posted: Reminder[] = [];
    const test = await setup(
      new Date("2026-07-25T10:00:00.000Z"),
      async (reminder) => {
        posted.push(reminder);
      },
    );
    await test.scheduler.create({
      requesterUserId: "user-1",
      channelId: "channel-1",
      content: "stand up",
      runAt: "2026-07-25T10:01:00Z",
    });

    test.setNow(new Date("2026-07-25T10:01:01.000Z"));
    await test.scheduler.tick();
    await test.scheduler.tick();

    expect(posted).toHaveLength(1);
    expect(await test.scheduler.list("user-1", "channel-1")).toEqual([]);
  });

  test("advances recurring cron reminders in their timezone", async () => {
    const posted: Reminder[] = [];
    const test = await setup(
      new Date("2026-07-25T00:00:00.000Z"),
      async (reminder) => {
        posted.push({ ...reminder });
      },
    );
    const reminder = await test.scheduler.create({
      requesterUserId: "user-1",
      channelId: "channel-1",
      content: "daily check-in",
      cron: "0 9 * * *",
      timezone: "Asia/Taipei",
    });
    expect(reminder.nextRunAt).toBe("2026-07-25T01:00:00.000Z");

    test.setNow(new Date("2026-07-25T01:00:01.000Z"));
    await test.scheduler.tick();

    expect(posted).toHaveLength(1);
    expect(
      (await test.scheduler.list("user-1", "channel-1"))[0]?.nextRunAt,
    ).toBe("2026-07-26T01:00:00.000Z");
  });

  test("rejects ambiguous, past, offset-less, and invalid cron schedules", async () => {
    const test = await setup(new Date("2026-07-25T10:00:00.000Z"));
    const base = {
      requesterUserId: "user-1",
      channelId: "channel-1",
      content: "test",
    };

    await expect(test.scheduler.create(base)).rejects.toThrow(
      "Provide exactly one",
    );
    await expect(
      test.scheduler.create({
        ...base,
        runAt: "2026-07-25T11:00:00",
      }),
    ).rejects.toThrow("UTC offset");
    await expect(
      test.scheduler.create({
        ...base,
        runAt: "2026-07-25T09:00:00Z",
      }),
    ).rejects.toThrow("future");
    await expect(
      test.scheduler.create({
        ...base,
        cron: "not a cron",
        timezone: "Asia/Taipei",
      }),
    ).rejects.toThrow();
    await expect(
      test.scheduler.create({
        ...base,
        cron: "0 9 * * *",
      }),
    ).rejects.toThrow("IANA timezone");
  });
});
