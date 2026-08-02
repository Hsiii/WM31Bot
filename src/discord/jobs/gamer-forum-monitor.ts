import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

import { TARGET_GUILD_ID } from "../config";

const DISCORD_API_BASE_URL = "https://discord.com/api/v10";
const DEFAULT_FORUM_URL =
  "https://m.gamer.com.tw/forum/C.php?bsn=36476&snA=3047&to=112";
const DEFAULT_READER_BASE_URL = "https://r.jina.ai/";
const DEFAULT_CHANNEL_ID = "1518127531968958558";
const DEFAULT_STATE_FILE = ".data/gamer-forum-state.json";
const DEFAULT_CHECK_TIMES = "08:30,20:30";
const DEFAULT_TIMEZONE = "Asia/Taipei";
const MESSAGE_LIMIT = 2_000;
const USER_AGENT =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1 MiniSago/0.1";

export type GamerForumPost = {
  id: string;
  floor?: number;
  author?: string;
  postedAt?: string;
  text: string;
  imageUrl?: string;
  url: string;
};

type GamerForumMonitorConfig = {
  botToken: string;
  channelId: string;
  guildId: string;
  watchUrl: string;
  readerBaseUrl: string;
  stateFile: string;
  checkTimes: number[];
  timezone: string;
};

type GamerForumState = {
  lastPostId?: string;
  lastPostFloor?: number;
  lastPostUrl?: string;
  lastCheckedAt?: string;
};

type DiscordChannel = {
  id: string;
  guild_id?: string;
};

type DiscordEmbed = {
  title: string;
  url: string;
  image?: {
    url: string;
  };
};

type DiscordMessagePayload = {
  content: string;
  embeds?: DiscordEmbed[];
  allowed_mentions: {
    parse: [];
  };
};

function getGamerForumMonitorConfig(): GamerForumMonitorConfig | null {
  if (process.env.GAMER_FORUM_MONITOR_DISABLED === "true") {
    return null;
  }

  const botToken = process.env.DISCORD_BOT_TOKEN?.trim();

  if (!botToken) {
    console.warn("Gamer forum monitor disabled: DISCORD_BOT_TOKEN is missing.");
    return null;
  }

  return {
    botToken,
    channelId: process.env.GAMER_FORUM_CHANNEL_ID?.trim() || DEFAULT_CHANNEL_ID,
    guildId: process.env.DISCORD_GUILD_ID?.trim() || TARGET_GUILD_ID,
    watchUrl: process.env.GAMER_FORUM_URL?.trim() || DEFAULT_FORUM_URL,
    readerBaseUrl:
      process.env.GAMER_FORUM_READER_BASE_URL?.trim() ||
      DEFAULT_READER_BASE_URL,
    stateFile: process.env.GAMER_FORUM_STATE_FILE?.trim() || DEFAULT_STATE_FILE,
    checkTimes: parseForumCheckTimes(
      process.env.GAMER_FORUM_CHECK_TIMES?.trim() || DEFAULT_CHECK_TIMES,
    ),
    timezone: process.env.GAMER_FORUM_TIMEZONE?.trim() || DEFAULT_TIMEZONE,
  };
}

export function parseForumCheckTimes(value: string) {
  const times = value.split(",").map((time) => time.trim());
  const minutes = times.map((time) => {
    const match = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(time);

    if (!match) {
      throw new Error(
        `GAMER_FORUM_CHECK_TIMES must be comma-separated HH:MM times: ${value}`,
      );
    }

    return Number(match[1]) * 60 + Number(match[2]);
  });

  if (minutes.length === 0 || new Set(minutes).size !== minutes.length) {
    throw new Error(
      `GAMER_FORUM_CHECK_TIMES must contain unique HH:MM times: ${value}`,
    );
  }

  return minutes.sort((a, b) => a - b);
}

function getZonedMinutes(date: Date, timezone: string) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", {
      timeZone: timezone,
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    })
      .formatToParts(date)
      .map((part) => [part.type, part.value]),
  );

  return Number(parts.hour) * 60 + Number(parts.minute);
}

export function millisecondsUntilNextForumCheck(
  now: Date,
  timezone: string,
  checkTimes: number[],
) {
  const scheduledMinutes = new Set(checkTimes);
  const firstCandidate = Math.floor(now.getTime() / 60_000) * 60_000 + 60_000;

  for (let offset = 0; offset <= 48 * 60; offset += 1) {
    const candidate = new Date(firstCandidate + offset * 60_000);

    if (scheduledMinutes.has(getZonedMinutes(candidate, timezone))) {
      return candidate.getTime() - now.getTime();
    }
  }

  throw new Error("Could not find the next Gamer forum check time.");
}

function comparePostIds(a: string, b: string) {
  const numericA = Number(a);
  const numericB = Number(b);

  if (Number.isFinite(numericA) && Number.isFinite(numericB)) {
    return numericA - numericB;
  }

  return a.localeCompare(b);
}

function decodeHtmlEntities(value: string) {
  return value.replace(
    /&(#x[\da-f]+|#\d+|amp|lt|gt|quot|apos|nbsp);/gi,
    (entity, rawEntity: string) => {
      const normalized = rawEntity.toLowerCase();

      if (normalized.startsWith("#x")) {
        return String.fromCodePoint(Number.parseInt(normalized.slice(2), 16));
      }

      if (normalized.startsWith("#")) {
        return String.fromCodePoint(Number.parseInt(normalized.slice(1), 10));
      }

      const namedEntities: Record<string, string> = {
        amp: "&",
        lt: "<",
        gt: ">",
        quot: '"',
        apos: "'",
        nbsp: " ",
      };

      return namedEntities[normalized] ?? entity;
    },
  );
}

function normalizeUrl(value: string) {
  return decodeHtmlEntities(value.trim());
}

function htmlToText(html: string) {
  return decodeHtmlEntities(
    html
      .replace(/<script\b[\s\S]*?<\/script>/gi, "")
      .replace(/<style\b[\s\S]*?<\/style>/gi, "")
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(/<\/(?:div|p|li|h[1-6]|article)>/gi, "\n")
      .replace(/<[^>]+>/g, "")
      .replace(/\u00a0/g, " "),
  )
    .split("\n")
    .map((line) => line.replace(/[ \t]+/g, " ").trim())
    .filter(Boolean)
    .join("\n");
}

function extractBsn(sourceUrl: string) {
  try {
    return new URL(sourceUrl).searchParams.get("bsn") ?? "";
  } catch {
    return "";
  }
}

function buildPostUrl(sourceUrl: string, postId: string) {
  const bsn = extractBsn(sourceUrl);
  const url = new URL("https://forum.gamer.com.tw/Co.php");

  if (bsn) {
    url.searchParams.set("bsn", bsn);
  }

  url.searchParams.set("sn", postId);

  return url.toString();
}

function extractFirstImageUrl(articleHtml: string) {
  const photoswipeHref =
    /<a\b[^>]*class="[^"]*\bphotoswipe-image\b[^"]*"[^>]*href="([^"]+)"/i.exec(
      articleHtml,
    )?.[1];

  if (photoswipeHref) {
    return normalizeUrl(photoswipeHref);
  }

  const imageSource =
    /<img\b[^>]*(?:data-src|src)="([^"]+)"/i.exec(articleHtml)?.[1] ??
    /\bhttps:\/\/(?:truth|im)\.bahamut\.com\.tw\/[^\s<>"']+/i.exec(
      articleHtml,
    )?.[0];

  return imageSource ? normalizeUrl(imageSource) : undefined;
}

function extractAuthorFields(postHtml: string) {
  const authorHtml =
    /<div class="cbox_man-author">([\s\S]*?)<\/div>/i.exec(postHtml)?.[1] ?? "";
  const spans = [...authorHtml.matchAll(/<span[^>]*>([\s\S]*?)<\/span>/gi)]
    .map((match) => htmlToText(match[1]))
    .filter(Boolean);

  return {
    author: spans[0],
    postedAt: spans[1],
  };
}

export function parseGamerForumPosts(
  html: string,
  sourceUrl = DEFAULT_FORUM_URL,
) {
  const postPattern =
    /<div class="[^"]*\barticle-cont\b[^"]*" id="post_(\d+)"[^>]*>([\s\S]*?)(?=<div class="[^"]*\barticle-cont\b|<div class="halac_form\b|$)/gi;
  const posts: GamerForumPost[] = [];

  for (const match of html.matchAll(postPattern)) {
    const [, id, postHtml] = match;
    const articleHtml =
      new RegExp(
        `<article class="cbox_txt" id="cf${id}">([\\s\\S]*?)<\\/article>`,
        "i",
      ).exec(postHtml)?.[1] ?? "";
    const floorMatch = /<span class="cbox_man-floor">#(\d+)<\/span>/i.exec(
      postHtml,
    );
    const { author, postedAt } = extractAuthorFields(postHtml);

    posts.push({
      id,
      floor: floorMatch ? Number(floorMatch[1]) : undefined,
      author,
      postedAt,
      text: htmlToText(articleHtml),
      imageUrl: extractFirstImageUrl(articleHtml),
      url: buildPostUrl(sourceUrl, id),
    });
  }

  return posts;
}

function markdownToText(markdown: string) {
  return decodeHtmlEntities(
    markdown
      .replace(/\[!\[[^\]]*\]\([^)]*\)\]\([^)]*\)/g, "")
      .replace(/!\[[^\]]*\]\([^)]*\)/g, "")
      .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
      .replace(/<[^>]+>/g, ""),
  )
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .join("\n");
}

function extractMarkdownAuthor(markdown: string) {
  const matches = [
    ...markdown.matchAll(
      /\)([^\[\]\n]+?\([a-zA-Z\d_-]+\))(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2})/g,
    ),
  ];
  const match = matches.at(-1);

  return {
    author: match?.[1].trim(),
    postedAt: match?.[2],
  };
}

export function parseGamerForumMarkdownPosts(
  markdown: string,
  sourceUrl = DEFAULT_FORUM_URL,
) {
  const headings = [...markdown.matchAll(/^#(\d+)\s*$/gm)];
  const posts: GamerForumPost[] = [];

  for (const [index, heading] of headings.entries()) {
    const floor = Number(heading[1]);
    const blockStart = (heading.index ?? 0) + heading[0].length;
    const blockEnd = headings[index + 1]?.index ?? markdown.length;
    const block = markdown.slice(blockStart, blockEnd);
    const id = /otheraction\((\d+)\)/.exec(block)?.[1];

    if (!id) {
      continue;
    }

    const content = block.split(/\n\n\[\]\(javascript:;\)/, 1)[0].trim();
    const imageUrl =
      /!\[[^\]]*\]\((https:\/\/(?:truth|im)\.bahamut\.com\.tw\/[^)]+)\)/i.exec(
        content,
      )?.[1];
    const previousHeadingEnd =
      index === 0
        ? 0
        : (headings[index - 1].index ?? 0) + headings[index - 1][0].length;
    const { author, postedAt } = extractMarkdownAuthor(
      markdown.slice(previousHeadingEnd, heading.index),
    );

    posts.push({
      id,
      floor,
      author,
      postedAt,
      text: markdownToText(content),
      imageUrl: imageUrl ? normalizeUrl(imageUrl) : undefined,
      url: buildPostUrl(sourceUrl, id),
    });
  }

  return posts;
}

export function getForumLastPageNumber(html: string) {
  const optionPattern =
    /<option\b[^>]*value="(\d+)"[^>]*>\s*\d+\s*頁\s*\/\s*(\d+)\s*頁/gi;
  let lastPage: number | undefined;

  for (const match of html.matchAll(optionPattern)) {
    const optionValue = Number(match[1]);
    const totalPages = Number(match[2]);
    const candidate = Math.max(optionValue, totalPages);

    if (!lastPage || candidate > lastPage) {
      lastPage = candidate;
    }
  }

  return lastPage;
}

export function getForumCurrentPageNumber(
  html: string,
  fallbackUrl = DEFAULT_FORUM_URL,
) {
  const canonicalHref = /<link\b[^>]*rel="canonical"[^>]*href="([^"]+)"/i.exec(
    html,
  )?.[1];
  const selectedOption = /<option\b[^>]*value="(\d+)"[^>]*selected[^>]*>/i.exec(
    html,
  )?.[1];

  for (const value of [canonicalHref, fallbackUrl]) {
    if (!value) {
      continue;
    }

    try {
      const page = new URL(normalizeUrl(value)).searchParams.get("page");

      if (page) {
        return Number(page);
      }
    } catch {
      // Ignore malformed fallback values and keep trying other page hints.
    }
  }

  return selectedOption ? Number(selectedOption) : undefined;
}

export function buildForumPageUrl(sourceUrl: string, page: number) {
  const url = new URL(sourceUrl);

  url.searchParams.delete("to");
  url.searchParams.set("page", String(page));

  return url.toString();
}

function truncate(value: string, limit: number) {
  if (limit <= 0) {
    return "";
  }

  if (value.length <= limit) {
    return value;
  }

  return `${value.slice(0, limit - 1)}…`;
}

export function formatGamerForumPostMessage(post: GamerForumPost) {
  const metadata = [
    post.floor ? `#${post.floor}` : null,
    post.author,
    post.postedAt,
  ].filter((part): part is string => Boolean(part));
  const header = `New Gamer forum post${metadata.length ? ` (${metadata.join(" | ")})` : ""}`;
  const bodyBudget = Math.max(
    0,
    MESSAGE_LIMIT - header.length - post.url.length - 4,
  );
  const body = truncate(post.text || "(no text)", bodyBudget);
  const lines = [header, "", body, "", post.url];

  return lines.join("\n");
}

export function buildGamerForumPostMessagePayload(
  post: GamerForumPost,
): DiscordMessagePayload {
  const payload: DiscordMessagePayload = {
    content: formatGamerForumPostMessage(post),
    allowed_mentions: {
      parse: [],
    },
  };

  if (post.imageUrl) {
    payload.embeds = [
      {
        title: post.floor
          ? `Gamer forum post #${post.floor}`
          : "Gamer forum post",
        url: post.url,
        image: {
          url: post.imageUrl,
        },
      },
    ];
  }

  return payload;
}

export function buildForumReaderUrl(
  sourceUrl: string,
  readerBaseUrl = DEFAULT_READER_BASE_URL,
) {
  return `${readerBaseUrl.replace(/\/*$/, "/")}${sourceUrl}`;
}

async function fetchForumHtml(url: string, readerBaseUrl: string) {
  const response = await fetch(buildForumReaderUrl(url, readerBaseUrl), {
    headers: {
      "User-Agent": USER_AGENT,
      "X-Cache-Tolerance": "300",
      "X-Respond-With": "markdown",
    },
  });

  if (!response.ok) {
    throw new Error(`Failed to fetch Gamer forum page: ${response.status}`);
  }

  return response.text();
}

function parseForumReaderResponse(response: string, sourceUrl: string) {
  const htmlPosts = parseGamerForumPosts(response, sourceUrl);
  return htmlPosts.length > 0
    ? htmlPosts
    : parseGamerForumMarkdownPosts(response, sourceUrl);
}

async function fetchLatestGamerForumPosts(
  watchUrl: string,
  readerBaseUrl: string,
) {
  const html = await fetchForumHtml(watchUrl, readerBaseUrl);
  const currentPage = getForumCurrentPageNumber(html, watchUrl);
  const lastPage = getForumLastPageNumber(html);

  if (currentPage && lastPage && lastPage > currentPage) {
    const lastPageUrl = buildForumPageUrl(watchUrl, lastPage);

    return parseForumReaderResponse(
      await fetchForumHtml(lastPageUrl, readerBaseUrl),
      lastPageUrl,
    );
  }

  return parseForumReaderResponse(html, watchUrl);
}

async function readState(stateFile: string): Promise<GamerForumState> {
  try {
    return JSON.parse(await readFile(stateFile, "utf8")) as GamerForumState;
  } catch (error) {
    if (error && typeof error === "object" && "code" in error) {
      const code = (error as { code?: string }).code;

      if (code === "ENOENT") {
        return {};
      }
    }

    throw error;
  }
}

async function writeState(stateFile: string, state: GamerForumState) {
  await mkdir(dirname(stateFile), { recursive: true });
  await writeFile(`${stateFile}.tmp`, `${JSON.stringify(state, null, 2)}\n`);
  await rename(`${stateFile}.tmp`, stateFile);
}

function toState(post: GamerForumPost, now: Date): GamerForumState {
  return {
    lastPostId: post.id,
    lastPostFloor: post.floor,
    lastPostUrl: post.url,
    lastCheckedAt: now.toISOString(),
  };
}

async function fetchDiscordJson<T>({
  botToken,
  path,
  init,
}: {
  botToken: string;
  path: string;
  init?: RequestInit;
}) {
  const response = await fetch(`${DISCORD_API_BASE_URL}${path}`, {
    ...init,
    headers: {
      ...init?.headers,
      Authorization: `Bot ${botToken}`,
      "Content-Type": "application/json",
    },
  });

  if (!response.ok) {
    throw new Error(`${response.status} ${await response.text()}`);
  }

  if (response.status === 204) {
    return undefined as T;
  }

  return (await response.json()) as T;
}

async function sendDiscordChannelMessage({
  botToken,
  channelId,
  guildId,
  payload,
}: {
  botToken: string;
  channelId: string;
  guildId: string;
  payload: DiscordMessagePayload;
}) {
  const channel = await fetchDiscordJson<DiscordChannel>({
    botToken,
    path: `/channels/${channelId}`,
  });

  if (channel.guild_id !== guildId) {
    throw new Error(
      `Gamer forum channel ${channelId} belongs to guild ${channel.guild_id ?? "unknown"}, not configured guild ${guildId}.`,
    );
  }

  await fetchDiscordJson({
    botToken,
    path: `/channels/${channelId}/messages`,
    init: {
      method: "POST",
      body: JSON.stringify(payload),
    },
  });
}

async function sendGamerForumAlertsIfNeeded(
  config: GamerForumMonitorConfig,
  now = new Date(),
) {
  const posts = await fetchLatestGamerForumPosts(
    config.watchUrl,
    config.readerBaseUrl,
  );
  const latestPost = posts.at(-1);

  if (!latestPost) {
    throw new Error("Gamer forum page did not contain any posts.");
  }

  const state = await readState(config.stateFile);

  if (!state.lastPostId) {
    await writeState(config.stateFile, toState(latestPost, now));
    console.log(
      `Initialized Gamer forum monitor at post ${latestPost.id}; future posts will be sent.`,
    );
    return;
  }

  const newPosts = posts
    .filter((post) => comparePostIds(post.id, state.lastPostId ?? "") > 0)
    .sort((a, b) => comparePostIds(a.id, b.id));

  for (const post of newPosts) {
    await sendDiscordChannelMessage({
      botToken: config.botToken,
      channelId: config.channelId,
      guildId: config.guildId,
      payload: buildGamerForumPostMessagePayload(post),
    });
    await writeState(config.stateFile, toState(post, now));
    console.log(`Sent Gamer forum post ${post.id} to Discord.`);
  }

  if (newPosts.length === 0) {
    await writeState(config.stateFile, {
      ...state,
      lastCheckedAt: now.toISOString(),
    });
  }
}

export function startGamerForumMonitor() {
  const config = getGamerForumMonitorConfig();

  if (!config) {
    return null;
  }

  let running = false;
  const tick = async () => {
    if (running) {
      return;
    }

    running = true;

    try {
      await sendGamerForumAlertsIfNeeded(config);
    } catch (error) {
      console.error("Failed to check Gamer forum posts:", error);
    } finally {
      running = false;
    }
  };

  void tick();

  const scheduleNext = () => {
    const delay = millisecondsUntilNextForumCheck(
      new Date(),
      config.timezone,
      config.checkTimes,
    );

    return setTimeout(async () => {
      await tick();
      scheduleNext();
    }, delay);
  };
  const timer = scheduleNext();
  const formattedTimes = config.checkTimes
    .map(
      (minutes) =>
        `${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`,
    )
    .join(", ");

  console.log(
    `Gamer forum monitor enabled for ${config.watchUrl} at ${formattedTimes} ${config.timezone}.`,
  );

  return timer;
}
