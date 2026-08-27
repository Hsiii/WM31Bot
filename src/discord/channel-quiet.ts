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

export function isChannelQuietRequest(content: string) {
  return content
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter(Boolean)
    .some((line) =>
      [
        /^(?:please\s+)?(?:(?:be|stay|keep)\s+quiet|shut\s+up|(?:stop|quit)\s+(?:talking|speaking|replying)|(?:don't|do\s+not)\s+(?:talk|speak|reply|respond))(?:\s+(?:for\s+)?(?:a\s+(?:bit|while)|(?:\d+(?:\.\d+)?|one|two|three|four|five|six|seven|eight|nine|ten)\s+(?:seconds?|minutes?|hours?|days?)))?(?:\s+please)?[.!]?$/iu,
        /^(?:請|麻煩)?(?:你|妳)?(?:先)?(?:安靜|閉嘴)(?:(?:一下|一會兒?|[零〇一二兩三四五六七八九十百\d.]+\s*(?:秒鐘?|分鐘?|小時|鐘頭|天)))?(?:吧|啦|喔|哦|呀|。|！|!)?$/u,
        /^(?:請|麻煩)?(?:你|妳)?(?:先)?(?:不要|別|停止)(?:再)?(?:說話|講話|回覆|回話)(?:了|吧|啦|喔|哦|呀|。|！|!)?$/u,
      ].some((pattern) => pattern.test(line)),
    );
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
