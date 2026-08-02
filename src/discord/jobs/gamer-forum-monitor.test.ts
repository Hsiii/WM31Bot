import { describe, expect, test } from "bun:test";

import {
  buildForumPageUrl,
  buildForumReaderUrl,
  buildGamerForumPostMessagePayload,
  formatGamerForumPostMessage,
  getForumCurrentPageNumber,
  getForumLastPageNumber,
  millisecondsUntilNextForumCheck,
  parseGamerForumMarkdownPosts,
  parseGamerForumPosts,
  parseForumCheckTimes,
} from "./gamer-forum-monitor";

const watchUrl = "https://m.gamer.com.tw/forum/C.php?bsn=36476&snA=3047&to=112";

const sampleHtml = `
<link rel="canonical" href="https://forum.gamer.com.tw/C.php?bsn=36476&amp;snA=3047&amp;page=6">
<select onchange="changePage(this.value, 6);">
<option value="6" selected>6 頁 / 7 頁</option><option value="7">7 頁 / 7 頁</option>
</select>
<div class="cbox article-cont " id="post_15233">
<div class="cbox_man ">
<div class="cbox_man-author">
<a href="/home/home.php?owner=nerv911120">
<img src="https://avatar2.bahamut.com.tw/avataruserpic/n/e/nerv911120/nerv911120_s.png" id="avatar_fpath15233"/>
</a>
<span>Guistar (nerv911120)</span>
<span>2026-07-05 20:11:06</span>
<div class="c-user__honor" data-honors="16,222,269"></div>
</div>
<span class="cbox_man-floor">#116</span>
</div>
<article class="cbox_txt" id="cf15233"><div>比賽&nbsp;禮品碼: <font>Y4C7W9Z3T<br></font>不可奉納的紫色隨機禮物 喵趣券 寶玉各 X1<br><a class="photoswipe-image" href="https://truth.bahamut.com.tw/s01/202607/forum/36476/code.WEBP"><img class="lazyload" data-src="https://truth.bahamut.com.tw/s01/202607/forum/36476/code.WEBP?w=600"></a></div></article>
</div>
<div class="halac_form"></div>
`;

const sampleMarkdown = `
[![Avatar](https://avatar2.bahamut.com.tw/avatar.png)](https://m.gamer.com.tw/home/home.php?owner=nerv911120)Guistar (nerv911120)2026-07-05 20:11:06

[![Honor](https://p2.bahamut.com.tw/HOME/honor/16.gif)](javascript:;)

#116

比賽 禮品碼: Y4C7W9Z3T

不可奉納的紫色隨機禮物 喵趣券 寶玉各 X1

[![Image](https://truth.bahamut.com.tw/s01/202607/forum/36476/code.WEBP)](https://truth.bahamut.com.tw/s01/202607/forum/36476/code.WEBP)

[](javascript:;)69

[](javascript:;)0

[關閉圖片影片](javascript:MB_showAdvancedUseDownloadApp();)[收藏](javascript:otheraction(15233);)[回覆本篇](https://m.gamer.com.tw/forum/post1.php?sn=15233)

#117 此文章已由原作者刪除
`;

describe("Gamer forum page helpers", () => {
  test("reads current and last page numbers", () => {
    expect(getForumCurrentPageNumber(sampleHtml, watchUrl)).toBe(6);
    expect(getForumLastPageNumber(sampleHtml)).toBe(7);
  });

  test("builds a latest-page URL from the watched anchor URL", () => {
    expect(buildForumPageUrl(watchUrl, 7)).toBe(
      "https://m.gamer.com.tw/forum/C.php?bsn=36476&snA=3047&page=7",
    );
  });

  test("routes forum requests through the reader service", () => {
    expect(buildForumReaderUrl(watchUrl)).toBe(`https://r.jina.ai/${watchUrl}`);
    expect(buildForumReaderUrl(watchUrl, "https://reader.example.test")).toBe(
      `https://reader.example.test/${watchUrl}`,
    );
  });
});

describe("Gamer forum schedule", () => {
  const timezone = "Asia/Taipei";
  const checkTimes = parseForumCheckTimes("08:30,20:30");

  test("parses two unique daily wall-clock times", () => {
    expect(checkTimes).toEqual([510, 1230]);
    expect(() => parseForumCheckTimes("08:30,08:30")).toThrow();
  });

  test("finds the next Taipei check without startup drift", () => {
    expect(
      millisecondsUntilNextForumCheck(
        new Date("2026-07-18T00:00:00.000Z"),
        timezone,
        checkTimes,
      ),
    ).toBe(30 * 60_000);
    expect(
      millisecondsUntilNextForumCheck(
        new Date("2026-07-18T00:30:00.000Z"),
        timezone,
        checkTimes,
      ),
    ).toBe(12 * 60 * 60_000);
  });
});

describe("parseGamerForumPosts", () => {
  test("extracts post identity, text, author, date, and first image", () => {
    expect(parseGamerForumPosts(sampleHtml, watchUrl)).toEqual([
      {
        id: "15233",
        floor: 116,
        author: "Guistar (nerv911120)",
        postedAt: "2026-07-05 20:11:06",
        text: "比賽 禮品碼: Y4C7W9Z3T\n不可奉納的紫色隨機禮物 喵趣券 寶玉各 X1",
        imageUrl:
          "https://truth.bahamut.com.tw/s01/202607/forum/36476/code.WEBP",
        url: "https://forum.gamer.com.tw/Co.php?bsn=36476&sn=15233",
      },
    ]);
  });

  test("extracts the same fields from the reader's Markdown response", () => {
    expect(parseGamerForumMarkdownPosts(sampleMarkdown, watchUrl)).toEqual([
      {
        id: "15233",
        floor: 116,
        author: "Guistar (nerv911120)",
        postedAt: "2026-07-05 20:11:06",
        text: "比賽 禮品碼: Y4C7W9Z3T\n不可奉納的紫色隨機禮物 喵趣券 寶玉各 X1",
        imageUrl:
          "https://truth.bahamut.com.tw/s01/202607/forum/36476/code.WEBP",
        url: "https://forum.gamer.com.tw/Co.php?bsn=36476&sn=15233",
      },
    ]);
  });
});

describe("Gamer forum Discord message", () => {
  test("keeps text in content and image in an embed", () => {
    const post = parseGamerForumPosts(sampleHtml, watchUrl)[0];
    const payload = buildGamerForumPostMessagePayload(post);

    expect(formatGamerForumPostMessage(post)).toContain("Y4C7W9Z3T");
    expect(payload.content).toContain("New Gamer forum post (#116");
    expect(payload.embeds).toEqual([
      {
        title: "Gamer forum post #116",
        url: "https://forum.gamer.com.tw/Co.php?bsn=36476&sn=15233",
        image: {
          url: "https://truth.bahamut.com.tw/s01/202607/forum/36476/code.WEBP",
        },
      },
    ]);
    expect(payload.allowed_mentions.parse).toEqual([]);
  });
});
