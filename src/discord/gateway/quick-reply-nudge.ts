const QUICK_REPLY_WINDOW_MS = 30_000;
const TARGET_IDLE_WINDOW_MS = 60_000;
const QUICK_REPLY_LIMIT = 3;

type ObservedMessage = {
  channel_id: string;
  timestamp: string;
  webhook_id?: string;
  author?: {
    id?: string;
    bot?: boolean;
  };
};

type RecentMessage = {
  authorId: string | null;
  isHuman: boolean;
  timestampMs: number;
};

export const QUICK_REPLY_TARGET_USER_ID = "468711293264855052";

const taipeiDate = new Intl.DateTimeFormat("en-CA", {
  timeZone: "Asia/Taipei",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

export class QuickReplyNudgeTracker {
  private readonly recentByChannel = new Map<string, RecentMessage>();
  private dailyCount = 0;
  private dailyCountDate = "";
  private nudgedToday = false;
  private lastTargetMessageAt: number | null = null;

  constructor(
    private readonly targetUserId = QUICK_REPLY_TARGET_USER_ID,
    private readonly dateKey = (timestampMs: number) =>
      taipeiDate.format(timestampMs),
  ) {}

  observe(message: ObservedMessage) {
    const authorId = message.author?.id ?? null;
    const timestampMs = Date.parse(message.timestamp);
    if (!Number.isFinite(timestampMs)) return false;

    const isHuman = Boolean(
      authorId && !message.author?.bot && !message.webhook_id,
    );
    const previous = this.recentByChannel.get(message.channel_id);
    this.recentByChannel.set(message.channel_id, {
      authorId,
      isHuman,
      timestampMs,
    });

    const previousTargetMessageAt = this.lastTargetMessageAt;
    if (authorId === this.targetUserId) {
      this.lastTargetMessageAt = Math.max(
        previousTargetMessageAt ?? timestampMs,
        timestampMs,
      );
    }

    if (
      !isHuman ||
      authorId !== this.targetUserId ||
      !previous?.isHuman ||
      previous.authorId === authorId
    ) {
      return false;
    }

    const elapsedMs = timestampMs - previous.timestampMs;
    if (elapsedMs < 0 || elapsedMs > QUICK_REPLY_WINDOW_MS) return false;

    if (
      previousTargetMessageAt !== null &&
      timestampMs - previousTargetMessageAt < TARGET_IDLE_WINDOW_MS
    ) {
      return false;
    }

    const day = this.dateKey(timestampMs);
    if (day !== this.dailyCountDate) {
      this.dailyCountDate = day;
      this.dailyCount = 0;
      this.nudgedToday = false;
    }
    this.dailyCount += 1;

    if (this.dailyCount <= QUICK_REPLY_LIMIT || this.nudgedToday) return false;

    this.nudgedToday = true;
    return true;
  }
}
