import { TARGET_GUILD_ID } from "../config";
import {
  decodeEntities,
  discordRequest,
  readJsonFile,
  writeJsonFile,
} from "./job-utils";

const DEFAULT_HANDLE = "thsottiaux";
const DEFAULT_CHANNEL_ID = "1527893157168283668";
const DEFAULT_STATE_FILE = ".data/x-post-state.json";
const DEFAULT_ADDITIONAL_PIPES = [
  {
    handle: "thsottiaux",
    channelId: "1515569479541854218",
    stateFileName: "x-post-thsottiaux-additional-state.json",
  },
  {
    handle: "hololive_dreams",
    channelId: "1290252977621176361",
    stateFileName: "x-post-hololive-dreams-state.json",
  },
] as const;
const DEFAULT_CHECK_INTERVAL_MS = 300_000;
const STATE_CHECKPOINT_INTERVAL_MS = 3_600_000;
const USER_AGENT = "MiniSago/0.1";

export type XPost = {
  id: string;
  text: string;
  url: string;
  publishedAt?: string;
  imageUrl?: string;
};

type XPostMonitorConfig = {
  botToken: string;
  channelId: string;
  guildId: string;
  handle: string;
  feedUrl: string;
  stateFile: string;
  checkIntervalMs: number;
};

type XPostState = {
  lastPostId?: string;
  lastPostUrl?: string;
  lastCheckedAt?: string;
};

type DiscordChannel = {
  guild_id?: string;
};

function readElement(xml: string, name: string) {
  const match = new RegExp(
    `<${name}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${name}>`,
    "i",
  ).exec(xml);

  if (!match) {
    return undefined;
  }

  const value = match[1].replace(/^<!\[CDATA\[([\s\S]*)\]\]>$/, "$1");
  return decodeEntities(value.trim());
}

function htmlToText(value: string) {
  return decodeEntities(
    value
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(/<\/p>/gi, "\n\n")
      .replace(/<blockquote[\s\S]*?<\/blockquote>/gi, "")
      .replace(/<[^>]+>/g, ""),
  )
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function extractPostId(url: string) {
  return /\/status\/(\d+)/.exec(url)?.[1];
}

function extractEnclosureUrl(itemXml: string) {
  const tag = /<enclosure\b[^>]*>/i.exec(itemXml)?.[0];
  const url = tag ? /\burl=(?:"([^"]+)"|'([^']+)')/i.exec(tag) : undefined;
  return url ? decodeEntities(url[1] ?? url[2]) : undefined;
}

export function parseXPosts(feedXml: string) {
  const posts: XPost[] = [];

  for (const match of feedXml.matchAll(/<item\b[^>]*>([\s\S]*?)<\/item>/gi)) {
    const itemXml = match[1];
    const url = readElement(itemXml, "link");
    const id = url ? extractPostId(url) : undefined;

    if (!url || !id) {
      continue;
    }

    const description = readElement(itemXml, "description");
    const title = readElement(itemXml, "title") ?? "";

    posts.push({
      id,
      text: description ? htmlToText(description) : title,
      url,
      publishedAt: readElement(itemXml, "pubDate"),
      imageUrl: extractEnclosureUrl(itemXml),
    });
  }

  return posts;
}

function comparePostIds(a: string, b: string) {
  return BigInt(a) < BigInt(b) ? -1 : BigInt(a) > BigInt(b) ? 1 : 0;
}

export function shouldCheckpointXPostState(
  lastCheckedAt: string | undefined,
  now: Date,
) {
  if (!lastCheckedAt) {
    return true;
  }

  const lastCheckedTime = Date.parse(lastCheckedAt);

  return (
    !Number.isFinite(lastCheckedTime) ||
    now.getTime() - lastCheckedTime >= STATE_CHECKPOINT_INTERVAL_MS
  );
}

export function buildXPostMessage(post: XPost, handle = DEFAULT_HANDLE) {
  return {
    content: `https://fxtwitter.com/${handle}/status/${post.id}`,
    allowed_mentions: { parse: [] as [] },
  };
}

function parseCheckIntervalMs(value: string | undefined) {
  if (!value) {
    return DEFAULT_CHECK_INTERVAL_MS;
  }

  const parsed = Number(value);

  if (!Number.isFinite(parsed) || parsed < 10_000) {
    throw new Error(
      `X_POST_CHECK_INTERVAL_MS must be at least 10000: ${value}`,
    );
  }

  return parsed;
}

function stateFileBeside(stateFile: string, fileName: string) {
  const separatorIndex = Math.max(
    stateFile.lastIndexOf("/"),
    stateFile.lastIndexOf("\\"),
  );

  return separatorIndex >= 0
    ? `${stateFile.slice(0, separatorIndex + 1)}${fileName}`
    : fileName;
}

export function getXPostMonitorConfigs(
  env: NodeJS.ProcessEnv = process.env,
): XPostMonitorConfig[] {
  if (env.X_POST_MONITOR_DISABLED === "true") {
    return [];
  }

  const botToken = env.DISCORD_BOT_TOKEN?.trim();

  if (!botToken) {
    console.warn("X post monitor disabled: DISCORD_BOT_TOKEN is missing.");
    return [];
  }

  const handle = env.X_POST_HANDLE?.trim() || DEFAULT_HANDLE;
  const stateFile = env.X_POST_STATE_FILE?.trim() || DEFAULT_STATE_FILE;
  const sharedConfig = {
    botToken,
    guildId: env.DISCORD_GUILD_ID?.trim() || TARGET_GUILD_ID,
    checkIntervalMs: parseCheckIntervalMs(env.X_POST_CHECK_INTERVAL_MS),
  };
  const primaryConfig: XPostMonitorConfig = {
    ...sharedConfig,
    channelId: env.X_POST_CHANNEL_ID?.trim() || DEFAULT_CHANNEL_ID,
    handle,
    feedUrl:
      env.X_POST_FEED_URL?.trim() ||
      `https://fxtwitter.com/${handle}/feed.xml?count=20`,
    stateFile,
  };

  return [
    primaryConfig,
    ...DEFAULT_ADDITIONAL_PIPES.map(
      ({ handle, channelId, stateFileName }): XPostMonitorConfig => ({
        ...sharedConfig,
        handle,
        channelId,
        feedUrl: `https://fxtwitter.com/${handle}/feed.xml?count=20`,
        stateFile: stateFileBeside(stateFile, stateFileName),
      }),
    ),
  ];
}

async function fetchLatestXPosts(feedUrl: string) {
  const response = await fetch(feedUrl, {
    headers: { "User-Agent": USER_AGENT },
  });

  if (!response.ok) {
    throw new Error(
      `X feed returned ${response.status}: ${await response.text()}`,
    );
  }

  return parseXPosts(await response.text());
}

async function sendXPost(config: XPostMonitorConfig, post: XPost) {
  const channel = await discordRequest<DiscordChannel>(
    config.botToken,
    `/channels/${config.channelId}`,
  );

  if (channel?.guild_id !== config.guildId) {
    throw new Error(
      `X post channel ${config.channelId} belongs to guild ${channel?.guild_id ?? "unknown"}, not configured guild ${config.guildId}.`,
    );
  }

  await discordRequest(
    config.botToken,
    `/channels/${config.channelId}/messages`,
    {
      method: "POST",
      body: JSON.stringify(buildXPostMessage(post, config.handle)),
    },
  );
}

async function sendXPostAlertsIfNeeded(
  config: XPostMonitorConfig,
  now = new Date(),
) {
  const posts = await fetchLatestXPosts(config.feedUrl);
  const latestPost = posts.sort((a, b) => comparePostIds(a.id, b.id)).at(-1);

  if (!latestPost) {
    throw new Error("X feed did not contain any posts.");
  }

  const state = await readJsonFile<XPostState>(config.stateFile, () => ({}));

  if (!state.lastPostId) {
    await writeJsonFile(config.stateFile, {
      lastPostId: latestPost.id,
      lastPostUrl: latestPost.url,
      lastCheckedAt: now.toISOString(),
    });
    console.log(
      `Initialized @${config.handle} X post monitor at ${latestPost.id}; future posts will be sent.`,
    );
    return;
  }

  const newPosts = posts
    .filter((post) => comparePostIds(post.id, state.lastPostId ?? "0") > 0)
    .sort((a, b) => comparePostIds(a.id, b.id));

  for (const post of newPosts) {
    await sendXPost(config, post);
    await writeJsonFile(config.stateFile, {
      lastPostId: post.id,
      lastPostUrl: post.url,
      lastCheckedAt: now.toISOString(),
    });
    console.log(`Sent @${config.handle} X post ${post.id} to Discord.`);
  }

  if (
    newPosts.length === 0 &&
    shouldCheckpointXPostState(state.lastCheckedAt, now)
  ) {
    await writeJsonFile(config.stateFile, {
      ...state,
      lastCheckedAt: now.toISOString(),
    });
  }
}

export function startXPostMonitor() {
  const configs = getXPostMonitorConfigs();

  if (configs.length === 0) {
    return null;
  }

  return configs.map((config) => {
    let running = false;
    const tick = async () => {
      if (running) {
        return;
      }

      running = true;

      try {
        await sendXPostAlertsIfNeeded(config);
      } catch (error) {
        console.error(`Failed to check @${config.handle} X posts:`, error);
      } finally {
        running = false;
      }
    };

    void tick();
    const timer = setInterval(() => void tick(), config.checkIntervalMs);
    console.log(
      `X post monitor enabled for @${config.handle} to channel ${config.channelId} every ${config.checkIntervalMs}ms.`,
    );
    return timer;
  });
}
