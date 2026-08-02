import { describe, expect, test } from "bun:test";

import { getTwitterReplyUrls } from "./twitter-links";

describe("getTwitterReplyUrls", () => {
  test("transforms Twitter and X links to FxTwitter", () => {
    expect(
      getTwitterReplyUrls(
        "https://twitter.com/minisago/status/1 https://x.com/minisago/status/2",
      ),
    ).toEqual([
      "https://fxtwitter.com/minisago/status/1",
      "https://fxtwitter.com/minisago/status/2",
    ]);
  });

  test("normalizes mobile and www hosts and preserves query parameters", () => {
    expect(
      getTwitterReplyUrls(
        "(https://mobile.twitter.com/minisago/status/1?s=20), https://www.x.com/minisago/status/2.",
      ),
    ).toEqual([
      "https://fxtwitter.com/minisago/status/1?s=20",
      "https://fxtwitter.com/minisago/status/2",
    ]);
  });

  test("ignores links that are already transformed", () => {
    expect(
      getTwitterReplyUrls("https://fxtwitter.com/minisago/status/1"),
    ).toEqual([]);
  });
});
