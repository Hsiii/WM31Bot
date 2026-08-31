import { createDiscordRequest } from "../api/request";
import {
  deliverToServiceDestinations,
  getServiceSubscriptionStore,
  type ServiceDestination,
} from "../service-subscriptions";
import { readJsonFile, writeJsonFile } from "./job-utils";

const DEFAULT_QUERIES = ["清大", "NTHU", "學生會"];
const DEFAULT_READER_BASE_URL = "https://r.jina.ai/";
const DEFAULT_STATE_FILE = ".data/threads-search-state.json";
const DEFAULT_CHECK_INTERVAL_MS = 900_000;
const MIN_CHECK_INTERVAL_MS = 60_000;
const MAX_SEEN_POSTS = 500;
const MESSAGE_LIMIT = 2_000;

export const THREADS_SEARCH_READER_HEADERS = {
  "User-Agent": "MiniSago/0.1",
  "X-Cache-Tolerance": "300",
  "X-Respond-With": "markdown",
} as const;

export type ThreadsSearchPost = {
  id: string;
  username: string;
  postedAt: string;
  text: string;
  url: string;
};

type ThreadsSearchMonitorConfig = {
  botToken: string;
  queries: string[];
  readerBaseUrl: string;
  stateFile: string;
  checkIntervalMs: number;
};

type ThreadsSearchState = {
  version: 1;
  initializedQueries: string[];
  seenPostUrls: string[];
  lastCheckedAt?: string;
};

type DiscordChannel = {
  guild_id?: string;
};

function parseCheckIntervalMs(value: string | undefined) {
  if (!value) return DEFAULT_CHECK_INTERVAL_MS;

  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < MIN_CHECK_INTERVAL_MS) {
    throw new Error(
      `THREADS_SEARCH_CHECK_INTERVAL_MS must be at least ${MIN_CHECK_INTERVAL_MS}: ${value}`,
    );
  }
  return parsed;
}

export function parseThreadsSearchQueries(value: string | undefined) {
  const queries = (value ? value.split(",") : DEFAULT_QUERIES)
    .map((query) => query.trim())
    .filter(Boolean);

  const uniqueQueries = [...new Set(queries)];
  if (uniqueQueries.length === 0) {
    throw new Error("THREADS_SEARCH_QUERIES must contain at least one query.");
  }
  return uniqueQueries;
}

export function getThreadsSearchMonitorConfig(
  env: NodeJS.ProcessEnv = process.env,
): ThreadsSearchMonitorConfig | null {
  if (env.THREADS_SEARCH_MONITOR_DISABLED === "true") return null;

  const botToken = env.DISCORD_BOT_TOKEN?.trim();
  if (!botToken) {
    console.warn(
      "Threads search monitor disabled: DISCORD_BOT_TOKEN is missing.",
    );
    return null;
  }

  return {
    botToken,
    queries: parseThreadsSearchQueries(env.THREADS_SEARCH_QUERIES),
    readerBaseUrl:
      env.THREADS_SEARCH_READER_BASE_URL?.trim() || DEFAULT_READER_BASE_URL,
    stateFile: env.THREADS_SEARCH_STATE_FILE?.trim() || DEFAULT_STATE_FILE,
    checkIntervalMs: parseCheckIntervalMs(env.THREADS_SEARCH_CHECK_INTERVAL_MS),
  };
}

export function buildThreadsSearchUrl(query: string) {
  const url = new URL("https://www.threads.com/search");
  url.searchParams.set("q", query);
  url.searchParams.set("serp_type", "default");
  url.searchParams.set("filter", "recent");
  return url.toString();
}

export function buildThreadsReaderUrl(
  query: string,
  readerBaseUrl = DEFAULT_READER_BASE_URL,
) {
  return `${readerBaseUrl.replace(/\/*$/, "/")}${buildThreadsSearchUrl(query)}`;
}

function cleanPostText(value: string) {
  return value
    .split("\n")
    .map((line) => line.trim())
    .filter(
      (line) =>
        line &&
        !line.startsWith("![Image") &&
        !line.startsWith("[![Image") &&
        line !== "Translate" &&
        line !== "Sorry, we're having trouble playing this video." &&
        !/^\[Learn more\]\(/u.test(line) &&
        !/^\d[\d,.]*[KMB]?$/iu.test(line),
    )
    .join("\n")
    .trim();
}

export function parseThreadsSearchPosts(markdown: string) {
  const linkPattern =
    /\[([^\]\n]+)\]\((https:\/\/(?:www\.)?threads\.com\/@([^/)\s]+)\/post\/([^)?\s]+)(?:\?[^)]*)?)\)/giu;
  const matches = [...markdown.matchAll(linkPattern)];
  const posts: ThreadsSearchPost[] = [];
  const seen = new Set<string>();

  for (const [index, match] of matches.entries()) {
    const url = match[2];
    if (!url || seen.has(url)) continue;

    const nextMatchIndex = matches[index + 1]?.index ?? markdown.length;
    const bodyStart = (match.index ?? 0) + match[0].length;
    let body = markdown.slice(bodyStart, nextMatchIndex);
    const nextProfile = body.search(/\n\[!\[Image[^\n]*profile picture/iu);
    if (nextProfile >= 0) body = body.slice(0, nextProfile);

    seen.add(url);
    posts.push({
      id: match[4]!,
      username: match[3]!,
      postedAt: match[1]!,
      text: cleanPostText(body),
      url,
    });
  }

  return posts;
}

function truncate(value: string, limit: number) {
  return value.length <= limit ? value : `${value.slice(0, limit - 1)}…`;
}

export function buildThreadsSearchMessage(
  post: ThreadsSearchPost,
  matchedQueries: readonly string[],
) {
  const heading = `脆海巡命中：${matchedQueries.join("、")}\n@${post.username} · ${post.postedAt}`;
  const suffix = `\n${post.url}`;
  const availableTextLength =
    MESSAGE_LIMIT - heading.length - suffix.length - 2;
  const text = post.text
    ? `\n\n${truncate(post.text, Math.max(0, availableTextLength))}`
    : "";

  return {
    content: `${heading}${text}${suffix}`,
    allowed_mentions: { parse: [] as [] },
  };
}

function normalizeState(
  value: Partial<ThreadsSearchState>,
): ThreadsSearchState {
  return {
    version: 1,
    initializedQueries: Array.isArray(value.initializedQueries)
      ? value.initializedQueries.filter((item) => typeof item === "string")
      : [],
    seenPostUrls: Array.isArray(value.seenPostUrls)
      ? value.seenPostUrls.filter((item) => typeof item === "string")
      : [],
    ...(typeof value.lastCheckedAt === "string"
      ? { lastCheckedAt: value.lastCheckedAt }
      : {}),
  };
}

async function fetchThreadsSearchPosts(query: string, readerBaseUrl: string) {
  const response = await fetch(buildThreadsReaderUrl(query, readerBaseUrl), {
    headers: THREADS_SEARCH_READER_HEADERS,
  });
  if (!response.ok) {
    throw new Error(`Threads reader returned ${response.status}.`);
  }

  const markdown = await response.text();
  const posts = parseThreadsSearchPosts(markdown);
  if (posts.length === 0) {
    const reason = markdown.includes("requiring CAPTCHA")
      ? "Threads required a CAPTCHA"
      : "the search returned no readable posts";
    throw new Error(reason);
  }
  return posts;
}

async function sendThreadsSearchPost(
  config: ThreadsSearchMonitorConfig,
  destination: ServiceDestination,
  post: ThreadsSearchPost,
  matchedQueries: readonly string[],
) {
  const discordRequest = createDiscordRequest(config.botToken);
  const channel = await discordRequest<DiscordChannel>(
    `/channels/${destination.channelId}`,
  );
  if (channel?.guild_id !== destination.guildId) {
    throw new Error(
      `Threads search channel ${destination.channelId} belongs to guild ${channel?.guild_id ?? "unknown"}, not configured guild ${destination.guildId}.`,
    );
  }

  await discordRequest(`/channels/${destination.channelId}/messages`, {
    method: "POST",
    body: buildThreadsSearchMessage(post, matchedQueries),
  });
}

async function checkThreadsSearches(
  config: ThreadsSearchMonitorConfig,
  now = new Date(),
) {
  const destinations =
    getServiceSubscriptionStore().destinations("threads_search");
  if (destinations.length === 0) return;

  const outcomes = await Promise.allSettled(
    config.queries.map(async (query) => ({
      query,
      posts: await fetchThreadsSearchPosts(query, config.readerBaseUrl),
    })),
  );
  const successful = outcomes.flatMap((outcome, index) => {
    if (outcome.status === "fulfilled") return [outcome.value];
    console.warn(
      `Failed to read Threads search for ${config.queries[index]}:`,
      outcome.reason,
    );
    return [];
  });
  if (successful.length === 0) {
    throw new AggregateError(
      outcomes.flatMap((outcome) =>
        outcome.status === "rejected" ? [outcome.reason] : [],
      ),
      "Every Threads search failed.",
    );
  }

  const state = normalizeState(
    await readJsonFile<Partial<ThreadsSearchState>>(
      config.stateFile,
      () => ({}),
    ),
  );
  const initializedQueries = new Set(state.initializedQueries);
  const seenPostUrls = new Set(state.seenPostUrls);
  const seededPostUrls = new Set<string>();
  const candidates = new Map<
    string,
    { post: ThreadsSearchPost; queries: string[]; order: number }
  >();

  for (const { query, posts } of successful) {
    if (!initializedQueries.has(query)) {
      initializedQueries.add(query);
      for (const post of posts) seededPostUrls.add(post.url);
      continue;
    }

    posts.forEach((post, order) => {
      if (seenPostUrls.has(post.url)) return;
      const candidate = candidates.get(post.url);
      if (candidate) {
        candidate.queries.push(query);
        candidate.order = Math.max(candidate.order, order);
      } else {
        candidates.set(post.url, { post, queries: [query], order });
      }
    });
  }

  for (const url of seededPostUrls) {
    if (!candidates.has(url)) seenPostUrls.add(url);
  }

  const persist = () =>
    writeJsonFile(config.stateFile, {
      version: 1,
      initializedQueries: [...initializedQueries],
      seenPostUrls: [...seenPostUrls].slice(-MAX_SEEN_POSTS),
      lastCheckedAt: now.toISOString(),
    } satisfies ThreadsSearchState);

  await persist();
  const newPosts = [...candidates.values()].sort(
    (left, right) => right.order - left.order,
  );
  for (const { post, queries } of newPosts) {
    const delivery = await deliverToServiceDestinations(
      destinations,
      (destination) =>
        sendThreadsSearchPost(config, destination, post, queries),
    );
    if (delivery.failedChannelIds.length) {
      console.warn(
        `Threads post ${post.id} failed for channels ${delivery.failedChannelIds.join(", ")}.`,
      );
    }
    seenPostUrls.add(post.url);
    await persist();
    console.log(
      `Sent Threads post ${post.id} to ${delivery.delivered} Discord channel(s).`,
    );
  }
}

export function startThreadsSearchMonitor() {
  const config = getThreadsSearchMonitorConfig();
  if (!config) return null;

  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      await checkThreadsSearches(config);
    } catch (error) {
      console.error("Failed to check Threads searches:", error);
    } finally {
      running = false;
    }
  };

  void tick();
  const timer = setInterval(() => void tick(), config.checkIntervalMs);
  console.log(
    `Threads search monitor enabled for ${config.queries.join(", ")} every ${config.checkIntervalMs}ms.`,
  );
  return timer;
}
