export type ChatbotAccessTier = "community" | "owner";
export type ChatbotAccessCapability =
  | "chat"
  | "dev"
  | "mac"
  | "execution_route";

const CAPABILITIES_BY_TIER: Record<
  ChatbotAccessTier,
  ReadonlySet<ChatbotAccessCapability>
> = {
  community: new Set(["chat"]),
  owner: new Set(["chat", "dev", "mac", "execution_route"]),
};

export type ChatbotAccessConfig = {
  ownerUserId: string;
  guildIds: ReadonlySet<string>;
  channelIds: ReadonlySet<string>;
};

const DISCORD_SNOWFLAKE = /^\d{17,20}$/u;

function parseSnowflakeList(value: string | undefined, name: string) {
  const values = (value ?? "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
  if (values.some((item) => !DISCORD_SNOWFLAKE.test(item))) {
    throw new Error(`${name} must contain comma-separated Discord IDs.`);
  }
  return new Set(values);
}

export function getChatbotAccessConfig(
  environment: NodeJS.ProcessEnv = process.env,
): ChatbotAccessConfig {
  const ownerUserId = environment.MINISAGO_CHATBOT_OWNER_USER_ID?.trim();
  if (!ownerUserId || !DISCORD_SNOWFLAKE.test(ownerUserId)) {
    throw new Error(
      "MINISAGO_CHATBOT_OWNER_USER_ID must contain one Discord user ID.",
    );
  }
  return {
    ownerUserId,
    guildIds: parseSnowflakeList(
      environment.MINISAGO_CHATBOT_GUILD_IDS,
      "MINISAGO_CHATBOT_GUILD_IDS",
    ),
    channelIds: parseSnowflakeList(
      environment.MINISAGO_CHATBOT_CHANNEL_IDS,
      "MINISAGO_CHATBOT_CHANNEL_IDS",
    ),
  };
}

export function chatbotAccessTier(
  userId: string,
  config: ChatbotAccessConfig,
): ChatbotAccessTier {
  return userId === config.ownerUserId ? "owner" : "community";
}

export function canUseChatbotCapability(
  userId: string,
  capability: ChatbotAccessCapability,
  config: ChatbotAccessConfig,
) {
  return CAPABILITIES_BY_TIER[chatbotAccessTier(userId, config)].has(
    capability,
  );
}
