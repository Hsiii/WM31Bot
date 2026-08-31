import { describe, expect, test } from "bun:test";

import {
  buildThreadsReaderUrl,
  buildThreadsSearchMessage,
  buildThreadsSearchUrl,
  getThreadsSearchMonitorConfig,
  parseThreadsSearchPosts,
  parseThreadsSearchQueries,
  THREADS_SEARCH_READER_HEADERS,
} from "./threads-search-monitor";

const sampleSearch = `Title: Search • Threads

URL Source: https://www.threads.com/search?q=NTHU&serp_type=default&filter=recent

Markdown Content:
[![Image 1: alice's profile picture](https://example.test/alice.jpg)](https://www.threads.com/@alice)

[alice](https://www.threads.com/@alice)

[08/31/26](https://www.threads.com/@alice/post/Dexample1)

清大今天開學，NTHU 的大家早安。

Translate

2.2K

3

[![Image 2: bob's profile picture](https://example.test/bob.jpg)](https://www.threads.com/@bob)

[bob](https://www.threads.com/@bob)

[08/30/26](https://www.threads.com/@bob/post/Dexample2)

學生會活動資訊

![Image 3](https://example.test/post.jpg)

9
`;

describe("Threads search monitor", () => {
  test("uses Jina Reader with the public recent-search URL", () => {
    expect(buildThreadsSearchUrl("清大")).toBe(
      "https://www.threads.com/search?q=%E6%B8%85%E5%A4%A7&serp_type=default&filter=recent",
    );
    expect(buildThreadsReaderUrl("NTHU")).toBe(
      "https://r.jina.ai/https://www.threads.com/search?q=NTHU&serp_type=default&filter=recent",
    );
    expect(THREADS_SEARCH_READER_HEADERS).toEqual({
      "User-Agent": "MiniSago/0.1",
      "X-Cache-Tolerance": "300",
      "X-Respond-With": "markdown",
    });
  });

  test("parses posts and removes reader presentation noise", () => {
    expect(parseThreadsSearchPosts(sampleSearch)).toEqual([
      {
        id: "Dexample1",
        username: "alice",
        postedAt: "08/31/26",
        text: "清大今天開學，NTHU 的大家早安。",
        url: "https://www.threads.com/@alice/post/Dexample1",
      },
      {
        id: "Dexample2",
        username: "bob",
        postedAt: "08/30/26",
        text: "學生會活動資訊",
        url: "https://www.threads.com/@bob/post/Dexample2",
      },
    ]);
  });

  test("builds a mention-safe Discord repost", () => {
    const [post] = parseThreadsSearchPosts(sampleSearch);
    expect(buildThreadsSearchMessage(post!, ["清大", "NTHU"])).toEqual({
      content:
        "脆海巡命中：清大、NTHU\n@alice · 08/31/26\n\n清大今天開學，NTHU 的大家早安。\nhttps://www.threads.com/@alice/post/Dexample1",
      allowed_mentions: { parse: [] },
    });
  });

  test("defaults and deduplicates search queries", () => {
    expect(parseThreadsSearchQueries(undefined)).toEqual([
      "清大",
      "NTHU",
      "學生會",
    ]);
    expect(parseThreadsSearchQueries(" 清大, NTHU,清大 ")).toEqual([
      "清大",
      "NTHU",
    ]);
  });

  test("keeps the service disabled without a bot token", () => {
    expect(getThreadsSearchMonitorConfig({})).toBeNull();
    expect(
      getThreadsSearchMonitorConfig({
        DISCORD_BOT_TOKEN: "test-token",
        THREADS_SEARCH_STATE_FILE: "/app/state/threads.json",
      }),
    ).toMatchObject({
      queries: ["清大", "NTHU", "學生會"],
      stateFile: "/app/state/threads.json",
      checkIntervalMs: 900_000,
    });
  });
});
