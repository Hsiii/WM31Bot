import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";

import { Cron } from "croner";
import { writeJsonFile } from "./job-utils";

const DEFAULT_STATE_FILE = ".data/reminders.json";
const LEGACY_DEFAULT_TIMEZONE = "Asia/Taipei";
const CHECK_INTERVAL_MS = 15_000;
const FAILED_ATTEMPT_BACKOFF_MS = 60_000;
const MAX_REMINDERS_PER_USER = 50;

export type Reminder = {
  id: string;
  requesterUserId: string;
  channelId: string;
  content: string;
  createdAt: string;
  nextRunAt: string;
  cron?: string;
  timezone?: string;
};

type ReminderState = {
  version: 1;
  reminders: Reminder[];
};

type ReminderSchedulerOptions = {
  stateFile: string;
  post: (reminder: Reminder) => Promise<void>;
  now?: () => Date;
  schedule?: (
    task: () => void,
    delayMs: number,
  ) => ReturnType<typeof setTimeout>;
};

type CreateReminderInput = {
  requesterUserId: string;
  channelId: string;
  content: string;
  runAt?: string;
  cron?: string;
  timezone?: string;
};

function cronNextRun(pattern: string, timezone: string, from: Date) {
  const cron = new Cron(pattern, {
    mode: "5-part",
    paused: true,
    timezone,
  });
  const nextRun = cron.nextRun(from);
  cron.stop();

  if (!nextRun) {
    throw new Error("The cron expression has no future run.");
  }
  return nextRun;
}

function ensureTimezone(timezone: string) {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: timezone }).format();
  } catch {
    throw new Error(`Invalid IANA timezone: ${timezone}`);
  }
}

function parseState(value: unknown): ReminderState {
  if (!value || typeof value !== "object") {
    throw new Error("Reminder state must be an object.");
  }
  const state = value as Partial<ReminderState>;
  if (state.version !== 1 || !Array.isArray(state.reminders)) {
    throw new Error("Unsupported reminder state.");
  }

  const reminders = state.reminders.filter((item): item is Reminder => {
    if (!item || typeof item !== "object") return false;
    const reminder = item as Partial<Reminder>;
    return (
      typeof reminder.id === "string" &&
      typeof reminder.requesterUserId === "string" &&
      typeof reminder.channelId === "string" &&
      typeof reminder.content === "string" &&
      typeof reminder.createdAt === "string" &&
      typeof reminder.nextRunAt === "string" &&
      Number.isFinite(Date.parse(reminder.nextRunAt)) &&
      (reminder.cron === undefined || typeof reminder.cron === "string") &&
      (reminder.timezone === undefined || typeof reminder.timezone === "string")
    );
  });
  return { version: 1, reminders };
}

export class ReminderScheduler {
  private reminders: Reminder[] = [];
  private started?: Promise<void>;
  private timer?: ReturnType<typeof setTimeout>;
  private operation = Promise.resolve();
  private readonly failedAttempts = new Map<string, number>();
  private readonly now: () => Date;
  private readonly schedule: NonNullable<ReminderSchedulerOptions["schedule"]>;

  constructor(private readonly options: ReminderSchedulerOptions) {
    this.now = options.now ?? (() => new Date());
    this.schedule = options.schedule ?? setTimeout;
  }

  start() {
    this.started ??= this.load().then(() => this.scheduleNextTick());
    return this.started;
  }

  stop() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
  }

  async create(input: CreateReminderInput) {
    await this.start();
    return this.runExclusive(async () => {
      const content = input.content.trim();
      if (!content || content.length > 1_500) {
        throw new Error("Reminder content must be 1–1500 characters.");
      }
      if (Boolean(input.runAt) === Boolean(input.cron)) {
        throw new Error("Provide exactly one of runAt or cron.");
      }
      if (
        this.reminders.filter(
          (reminder) => reminder.requesterUserId === input.requesterUserId,
        ).length >= MAX_REMINDERS_PER_USER
      ) {
        throw new Error(
          `Each user may have at most ${MAX_REMINDERS_PER_USER} reminders.`,
        );
      }

      const now = this.now();
      const timezone = input.timezone?.trim();
      let nextRun: Date;
      if (input.cron) {
        if (!timezone) {
          throw new Error("Recurring reminders require an IANA timezone.");
        }
        ensureTimezone(timezone);
        nextRun = cronNextRun(input.cron.trim(), timezone, now);
      } else {
        if (timezone) ensureTimezone(timezone);
        nextRun = new Date(input.runAt!);
        if (!Number.isFinite(nextRun.getTime())) {
          throw new Error(
            "runAt must be an ISO 8601 timestamp with an offset.",
          );
        }
        if (!/(?:Z|[+-]\d{2}:\d{2})$/u.test(input.runAt!)) {
          throw new Error("runAt must include Z or a UTC offset.");
        }
        if (nextRun.getTime() <= now.getTime()) {
          throw new Error("runAt must be in the future.");
        }
      }

      const reminder: Reminder = {
        id: randomUUID(),
        requesterUserId: input.requesterUserId,
        channelId: input.channelId,
        content,
        createdAt: now.toISOString(),
        nextRunAt: nextRun.toISOString(),
        ...(input.cron ? { cron: input.cron.trim() } : {}),
        ...(timezone ? { timezone } : {}),
      };
      const reminders = [...this.reminders, reminder];
      await this.write(reminders);
      this.reminders = reminders;
      return reminder;
    });
  }

  async list(requesterUserId: string, channelId: string) {
    await this.start();
    return this.reminders
      .filter(
        (reminder) =>
          reminder.requesterUserId === requesterUserId &&
          reminder.channelId === channelId,
      )
      .sort((a, b) => Date.parse(a.nextRunAt) - Date.parse(b.nextRunAt))
      .map((reminder) => ({ ...reminder }));
  }

  async cancel(requesterUserId: string, channelId: string, reminderId: string) {
    await this.start();
    return this.runExclusive(async () => {
      const index = this.reminders.findIndex(
        (reminder) =>
          reminder.id === reminderId &&
          reminder.requesterUserId === requesterUserId &&
          reminder.channelId === channelId,
      );
      if (index < 0) return false;
      this.reminders.splice(index, 1);
      this.failedAttempts.delete(reminderId);
      await this.write();
      return true;
    });
  }

  async tick() {
    await this.start();
    await this.runExclusive(async () => {
      const now = this.now();
      const due = this.reminders.filter((reminder) => {
        const failedAt = this.failedAttempts.get(reminder.id);
        return (
          Date.parse(reminder.nextRunAt) <= now.getTime() &&
          (!failedAt || now.getTime() - failedAt >= FAILED_ATTEMPT_BACKOFF_MS)
        );
      });
      let changed = false;

      for (const reminder of due) {
        try {
          await this.options.post(reminder);
          this.failedAttempts.delete(reminder.id);
          if (reminder.cron) {
            reminder.nextRunAt = cronNextRun(
              reminder.cron,
              reminder.timezone ?? LEGACY_DEFAULT_TIMEZONE,
              now,
            ).toISOString();
          } else {
            this.reminders = this.reminders.filter(
              (candidate) => candidate.id !== reminder.id,
            );
          }
          changed = true;
        } catch (error) {
          this.failedAttempts.set(reminder.id, now.getTime());
          console.error(`Failed to post reminder ${reminder.id}:`, error);
        }
      }

      if (changed) await this.write();
    });
  }

  private async load() {
    try {
      this.reminders = parseState(
        JSON.parse(await readFile(this.options.stateFile, "utf8")),
      ).reminders;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        console.error(
          `Failed to read reminder state at ${this.options.stateFile}:`,
          error,
        );
      }
      this.reminders = [];
    }
  }

  private scheduleNextTick() {
    this.timer = this.schedule(() => {
      void this.tick().finally(() => this.scheduleNextTick());
    }, CHECK_INTERVAL_MS);
  }

  private runExclusive<T>(task: () => Promise<T>) {
    const result = this.operation.then(task, task);
    this.operation = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  private async write(reminders = this.reminders) {
    const state: ReminderState = {
      version: 1,
      reminders,
    };
    await writeJsonFile(this.options.stateFile, state);
  }
}

let chatbotReminderScheduler: ReminderScheduler | undefined;

export function configureChatbotReminderScheduler(
  post: (reminder: Reminder) => Promise<void>,
) {
  chatbotReminderScheduler = new ReminderScheduler({
    stateFile:
      process.env.MINISAGO_REMINDER_STATE_FILE?.trim() || DEFAULT_STATE_FILE,
    post,
  });
  void chatbotReminderScheduler.start();
  return chatbotReminderScheduler;
}

export function getChatbotReminderScheduler() {
  return chatbotReminderScheduler;
}
