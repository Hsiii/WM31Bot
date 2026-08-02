import { describe, expect, test } from "bun:test";

import {
  buildXPostMessage,
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
