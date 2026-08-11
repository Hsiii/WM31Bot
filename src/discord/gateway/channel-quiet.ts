const DEFAULT_QUIET_MINUTES = 10;
const MAX_QUIET_MINUTES = 24 * 60;

type QuietChannel = {
  until: number;
};

export type ChannelQuietStatus = {
  pausedUntil: string;
  durationMinutes: number;
};

export class ChannelQuietTracker {
  private channels = new Map<string, QuietChannel>();

  constructor(private readonly now = () => Date.now()) {}

  pause(
    channelId: string,
    durationMinutes = DEFAULT_QUIET_MINUTES,
  ): ChannelQuietStatus {
    const boundedDuration = Math.min(
      MAX_QUIET_MINUTES,
      Math.max(1, Math.ceil(durationMinutes)),
    );
    const until = this.now() + boundedDuration * 60_000;
    this.channels.set(channelId, { until });
    return {
      pausedUntil: new Date(until).toISOString(),
      durationMinutes: boundedDuration,
    };
  }

  isPaused(channelId: string) {
    const quiet = this.channels.get(channelId);
    if (!quiet) return false;
    if (quiet.until <= this.now()) {
      this.channels.delete(channelId);
      return false;
    }
    return true;
  }

  wake(channelId: string) {
    return this.channels.delete(channelId);
  }
}

export function isChannelWakeRequest(content: string) {
  const normalized = content.trim().toLocaleLowerCase("en-US");
  if (!normalized) return false;

  return [
    /\bwake(?:\s+up)?\b/u,
    /\b(?:start|keep)\s+(?:talking|speaking|replying)\b/u,
    /\byou\s+can\s+(?:talk|speak|reply|respond)\b/u,
    /\b(?:talk|speak|reply|respond)\s+(?:again|now)\b/u,
    /^(?:please\s+)?(?:talk|speak|reply|respond)\b/u,
    /\bcome\s+back\b/u,
    /醒醒|醒來|起床/u,
    /(?:可以|繼續|開始)(?:回覆|回話|說話|講話)/u,
    /(?:回覆|回話|說話|講話)(?:吧|啊|了|囉|喔|哦|呀)/u,
    /(?:出來|回來)(?:回覆|回話|說話|講話)?/u,
  ].some((pattern) => pattern.test(normalized));
}
