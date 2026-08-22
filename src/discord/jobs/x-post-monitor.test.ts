import { describe, expect, test } from "bun:test";

import {
  buildXPostMessage,
  getXPostMonitorConfigs,
  parseXPosts,
  shouldCheckpointXPostState,
} from "./x-post-monitor";

const sampleFeed = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0"><channel>
  <item>
    <title>Shortened post…</title>
    <link>https://x.com/thsottiaux/status/2078320950488297917</link>
    <guid>https://x.com/thsottiaux/status/2078320950488297917</guid>
    <pubDate>Sat, 18 Jul 2026 03:28:22 GMT</pubDate>
    <enclosure url="https://pbs.twimg.com/media/example.jpg?name=orig&amp;format=jpg" type="image/jpeg" />
    <description><![CDATA[<p>Full post &amp; details.<br />Second line.</p>
      <blockquote><a href="https://x.com/example/status/1">Quoted post</a></blockquote>]]></description>
  </item>
</channel></rss>`;

describe("X post monitor", () => {
  test("parses post identity, full text, date, and image from FxTwitter RSS", () => {
    expect(parseXPosts(sampleFeed)).toEqual([
      {
        id: "2078320950488297917",
        text: "Full post & details.\nSecond line.",
        url: "https://x.com/thsottiaux/status/2078320950488297917",
        publishedAt: "Sat, 18 Jul 2026 03:28:22 GMT",
        imageUrl:
          "https://pbs.twimg.com/media/example.jpg?name=orig&format=jpg",
      },
    ]);
  });

  test("builds a Discord-friendly FxTwitter link without mentions", () => {
    const [post] = parseXPosts(sampleFeed);

    expect(buildXPostMessage(post)).toEqual({
      content: "https://fxtwitter.com/thsottiaux/status/2078320950488297917",
      allowed_mentions: { parse: [] },
    });
  });

  test("includes additional Discord pipes with isolated state", () => {
    const configs = getXPostMonitorConfigs({
      DISCORD_BOT_TOKEN: "test-token",
      DISCORD_GUILD_ID: "guild-1",
      X_POST_STATE_FILE: "/app/state/x-post-state.json",
    });

    expect(
      configs.map(({ handle, channelId, feedUrl, stateFile }) => ({
        handle,
        channelId,
        feedUrl,
        stateFile,
      })),
    ).toEqual([
      {
        handle: "thsottiaux",
        channelId: "1527893157168283668",
        feedUrl: "https://fxtwitter.com/thsottiaux/feed.xml?count=20",
        stateFile: "/app/state/x-post-state.json",
      },
      {
        handle: "thsottiaux",
        channelId: "1515569479541854218",
        feedUrl: "https://fxtwitter.com/thsottiaux/feed.xml?count=20",
        stateFile: "/app/state/x-post-thsottiaux-additional-state.json",
      },
      {
        handle: "hololive_dreams",
        channelId: "1290252977621176361",
        feedUrl: "https://fxtwitter.com/hololive_dreams/feed.xml?count=20",
        stateFile: "/app/state/x-post-hololive-dreams-state.json",
      },
    ]);
  });

  test("checkpoints idle state no more than once per hour", () => {
    const now = new Date("2026-07-18T06:00:00.000Z");

    expect(shouldCheckpointXPostState(undefined, now)).toBe(true);
    expect(shouldCheckpointXPostState("2026-07-18T05:30:00.000Z", now)).toBe(
      false,
    );
    expect(shouldCheckpointXPostState("2026-07-18T05:00:00.000Z", now)).toBe(
      true,
    );
  });
});
