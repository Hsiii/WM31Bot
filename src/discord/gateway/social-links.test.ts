import { describe, expect, test } from "bun:test";

import { getInstagramReplyUrls, getTwitterReplyUrls } from "./social-links";

describe("getInstagramReplyUrls", () => {
  test("returns only the transformed URL from a message", () => {
    expect(
      getInstagramReplyUrls(
        "look at this https://instagram.com/reel/abc/ please!",
      ),
    ).toEqual(["https://kkinstagram.com/reel/abc/"]);
  });

  test("returns each transformed URL without trailing punctuation", () => {
    expect(
      getInstagramReplyUrls(
        "(https://www.instagram.com/reel/a/), https://m.instagram.com/p/b/.",
      ),
    ).toEqual([
      "https://www.kkinstagram.com/reel/a/",
      "https://m.kkinstagram.com/p/b/",
    ]);
  });

  test("ignores links that are already transformed", () => {
    expect(
      getInstagramReplyUrls("https://www.kkinstagram.com/reel/abc/"),
    ).toEqual([]);
  });
});

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
