import vocabData from "./toefl-vocab.json";
import { TARGET_GUILD_ID } from "../config";
import { discordRequest, readJsonFile, writeJsonFile } from "./job-utils";

const DEFAULT_DAILY_TIME = "08:00";
const DEFAULT_TIMEZONE = "Asia/Taipei";
const DEFAULT_STATE_FILE = ".data/toefl-vocab-state.json";
const MESSAGE_LIMIT = 2_000;
const DAILY_CHECK_INTERVAL_MS = 60_000;
const IS_COMPONENTS_V2_FLAG = 1 << 15;
const SUPPRESS_EMBEDS_FLAG = 1 << 2;

type ToeflVocabAttribution = {
  sourceName: string;
  sourceUrl: string;
  license: string;
  licenseUrl: string;
};

type ToeflVocabWordBank = {
  sourceName: string;
  sourceUrl: string;
  note?: string;
};

export type ToeflVocabEntry = {
  word: string;
  partOfSpeech: string;
  definition: string;
  zhTw?: string;
  example?: string;
  synonyms?: string[];
  sourceUrl: string;
};

type ToeflVocabDataset = {
  attribution: ToeflVocabAttribution;
  wordBank?: ToeflVocabWordBank;
  entries: ToeflVocabEntry[];
};

type ToeflVocabSchedulerConfig = {
  botToken: string;
  channelId: string;
  guildId: string;
  dailyTime: string;
  timezone: string;
  stateFile: string;
};

type ToeflVocabState = {
  lastSentDate?: string;
  lastSentWord?: string;
};

type DiscordTextDisplay = {
  type: 10;
  content: string;
};

type ToeflVocabMessagePayload = {
  flags: number;
  components: DiscordTextDisplay[];
  allowed_mentions: {
    parse: [];
  };
};

type DiscordChannel = {
  id: string;
  guild_id?: string;
};

type TimeParts = {
  dateKey: string;
  minutesSinceMidnight: number;
};

function getToeflVocabConfig(): ToeflVocabSchedulerConfig | null {
  const botToken = process.env.DISCORD_BOT_TOKEN?.trim();
  const channelId = process.env.TOEFL_VOCAB_CHANNEL_ID?.trim();

  if (!channelId) {
    return null;
  }

  if (!botToken) {
    console.warn(
      "TOEFL vocab scheduler disabled: DISCORD_BOT_TOKEN is missing.",
    );
    return null;
  }

  return {
    botToken,
    channelId,
    guildId: process.env.DISCORD_GUILD_ID?.trim() || TARGET_GUILD_ID,
    dailyTime: process.env.TOEFL_VOCAB_TIME?.trim() || DEFAULT_DAILY_TIME,
    timezone: process.env.TOEFL_VOCAB_TIMEZONE?.trim() || DEFAULT_TIMEZONE,
    stateFile: process.env.TOEFL_VOCAB_STATE_FILE?.trim() || DEFAULT_STATE_FILE,
  };
}

function assertDataset(dataset: ToeflVocabDataset) {
  if (!dataset.entries.length) {
    throw new Error("TOEFL vocab dataset has no entries.");
  }
}

function getDataset() {
  const dataset = vocabData as ToeflVocabDataset;
  assertDataset(dataset);

  return dataset;
}

function parseDailyTime(value: string) {
  const match = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(value);

  if (!match) {
    throw new Error(`TOEFL_VOCAB_TIME must use HH:MM format: ${value}`);
  }

  return Number(match[1]) * 60 + Number(match[2]);
}

function getTimeParts(date: Date, timezone: string): TimeParts {
  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  });
  const parts = Object.fromEntries(
    formatter.formatToParts(date).map((part) => [part.type, part.value]),
  );

  return {
    dateKey: `${parts.year}-${parts.month}-${parts.day}`,
    minutesSinceMidnight: Number(parts.hour) * 60 + Number(parts.minute),
  };
}

function daysSinceEpochDate(dateKey: string) {
  return Math.floor(Date.parse(`${dateKey}T00:00:00.000Z`) / 86_400_000);
}

function formatQuoteBlock(value: string) {
  return value
    .split("\n")
    .map((line) => `> ${line}`)
    .join("\n");
}

function formatSuppressedMarkdownLink(label: string, url: string) {
  return `[${label}](<${url}>)`;
}

export function selectDailyToeflVocabEntry(
  entries: ToeflVocabEntry[],
  dateKey: string,
) {
  if (!entries.length) {
    throw new Error("Cannot select a TOEFL vocab entry from an empty list.");
  }

  return entries[daysSinceEpochDate(dateKey) % entries.length];
}

export function formatToeflVocabMessage({
  entry,
  attribution,
  wordBank,
}: {
  entry: ToeflVocabEntry;
  attribution: ToeflVocabAttribution;
  wordBank?: ToeflVocabWordBank;
}) {
  const lines = [
    "TOEFL Word of the Day",
    `## ${formatSuppressedMarkdownLink(entry.word, entry.sourceUrl)}`,
    `*${entry.partOfSpeech}*${entry.zhTw ? ` · ${entry.zhTw}` : ""}`,
  ];

  if (entry.example) {
    lines.push(formatQuoteBlock(entry.example));
  }

  const attributionLinks = [
    wordBank
      ? formatSuppressedMarkdownLink(wordBank.sourceName, wordBank.sourceUrl)
      : null,
    formatSuppressedMarkdownLink(attribution.sourceName, attribution.sourceUrl),
    formatSuppressedMarkdownLink(attribution.license, attribution.licenseUrl),
  ].filter((link): link is string => Boolean(link));

  lines.push("", attributionLinks.join(" · "));

  return lines.join("\n").slice(0, MESSAGE_LIMIT);
}

export function buildToeflVocabMessagePayload({
  entry,
  attribution,
  wordBank,
}: {
  entry: ToeflVocabEntry;
  attribution: ToeflVocabAttribution;
  wordBank?: ToeflVocabWordBank;
}): ToeflVocabMessagePayload {
  return {
    flags: IS_COMPONENTS_V2_FLAG | SUPPRESS_EMBEDS_FLAG,
    components: [
      {
        type: 10,
        content: formatToeflVocabMessage({ entry, attribution, wordBank }),
      },
    ],
    allowed_mentions: {
      parse: [],
    },
  };
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
  payload: ToeflVocabMessagePayload;
}) {
  const channel = await discordRequest<DiscordChannel>(
    botToken,
    `/channels/${channelId}`,
  );

  if (channel.guild_id !== guildId) {
    throw new Error(
      `TOEFL vocab channel ${channelId} belongs to guild ${channel.guild_id ?? "unknown"}, not configured guild ${guildId}.`,
    );
  }

  await discordRequest(botToken, `/channels/${channelId}/messages`, {
    method: "POST",
    body: JSON.stringify(payload),
  });
}

async function sendDailyToeflVocabIfDue(
  config: ToeflVocabSchedulerConfig,
  now = new Date(),
) {
  const scheduledMinutes = parseDailyTime(config.dailyTime);
  const timeParts = getTimeParts(now, config.timezone);

  if (timeParts.minutesSinceMidnight < scheduledMinutes) {
    return;
  }

  const state = await readJsonFile<ToeflVocabState>(
    config.stateFile,
    () => ({}),
  );

  if (state.lastSentDate === timeParts.dateKey) {
    return;
  }

  const dataset = getDataset();
  const entry = selectDailyToeflVocabEntry(dataset.entries, timeParts.dateKey);
  const payload = buildToeflVocabMessagePayload({
    entry,
    attribution: dataset.attribution,
    wordBank: dataset.wordBank,
  });

  await sendDiscordChannelMessage({
    botToken: config.botToken,
    channelId: config.channelId,
    guildId: config.guildId,
    payload,
  });
  await writeJsonFile(config.stateFile, {
    lastSentDate: timeParts.dateKey,
    lastSentWord: entry.word,
  });

  console.log(`Sent TOEFL vocab word for ${timeParts.dateKey}: ${entry.word}.`);
}

export function startToeflVocabScheduler() {
  const config = getToeflVocabConfig();

  if (!config) {
    return null;
  }

  const tick = async () => {
    try {
      await sendDailyToeflVocabIfDue(config);
    } catch (error) {
      console.error("Failed to send daily TOEFL vocab word:", error);
    }
  };

  void tick();

  const timer = setInterval(() => {
    void tick();
  }, DAILY_CHECK_INTERVAL_MS);

  console.log(
    `TOEFL vocab scheduler enabled for ${config.dailyTime} ${config.timezone}.`,
  );

  return timer;
}
