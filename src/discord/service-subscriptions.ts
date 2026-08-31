import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

import { TARGET_GUILD_ID } from "./config";

export const MANAGED_SERVICE_DEFINITIONS = {
  gamer_forum: "Gamer forum reposts",
  x_posts_primary: "Primary X account reposts",
  x_posts_thsottiaux: "@thsottiaux X reposts",
  x_posts_hololive_dreams: "@hololive_dreams X reposts",
  threads_search: "Threads keyword search reposts",
  toefl_vocab: "Daily TOEFL vocabulary",
} as const;

export type ManagedServiceId = keyof typeof MANAGED_SERVICE_DEFINITIONS;
export type ServiceDestination = {
  guildId: string;
  channelId: string;
};
export type ServiceSubscriptionSnapshot = {
  version: 1;
  services: Record<ManagedServiceId, ServiceDestination[]>;
};
export type ServiceSubscriptionMutation =
  | {
      service: ManagedServiceId;
      action: "subscribe";
      guildId: string;
      channelId: string;
    }
  | {
      service: ManagedServiceId;
      action: "unsubscribe";
      channelId: string;
    };
export type ManagedServiceListing = {
  services: Array<{
    id: ManagedServiceId;
    name: string;
    destinations: Array<
      ServiceDestination & {
        channelMention: string;
        jumpUrl: string;
      }
    >;
  }>;
};

const DISCORD_SNOWFLAKE = /^\d{17,20}$/u;
const DEFAULT_GAMER_FORUM_CHANNEL_ID = "1518127531968958558";
const DEFAULT_X_POST_CHANNEL_ID = "1527893157168283668";
const THSOTTIAUX_CHANNEL_ID = "1515569479541854218";
const THSOTTIAUX_GUILD_ID = "917436845187563610";
const HOLOLIVE_DREAMS_CHANNEL_ID = "1290252977621176361";
const THREADS_SEARCH_CHANNEL_ID = "1543897041350950982";
const THREADS_SEARCH_GUILD_ID = "1514899496797212683";

function configuredId(value: string | undefined, fallback: string) {
  const resolved = value?.trim() || fallback;
  return DISCORD_SNOWFLAKE.test(resolved) ? resolved : fallback;
}

export function defaultServiceSubscriptions(
  environment: NodeJS.ProcessEnv = process.env,
): ServiceSubscriptionSnapshot {
  const guildId = configuredId(environment.DISCORD_GUILD_ID, TARGET_GUILD_ID);
  const toeflChannelId = environment.TOEFL_VOCAB_CHANNEL_ID?.trim();

  return {
    version: 1,
    services: {
      gamer_forum: [
        {
          guildId,
          channelId: configuredId(
            environment.GAMER_FORUM_CHANNEL_ID,
            DEFAULT_GAMER_FORUM_CHANNEL_ID,
          ),
        },
      ],
      x_posts_primary: [
        {
          guildId,
          channelId: configuredId(
            environment.X_POST_CHANNEL_ID,
            DEFAULT_X_POST_CHANNEL_ID,
          ),
        },
      ],
      x_posts_thsottiaux: [
        {
          guildId: THSOTTIAUX_GUILD_ID,
          channelId: THSOTTIAUX_CHANNEL_ID,
        },
      ],
      x_posts_hololive_dreams: [
        { guildId: TARGET_GUILD_ID, channelId: HOLOLIVE_DREAMS_CHANNEL_ID },
      ],
      threads_search: [
        {
          guildId: THREADS_SEARCH_GUILD_ID,
          channelId: THREADS_SEARCH_CHANNEL_ID,
        },
      ],
      toefl_vocab:
        toeflChannelId && DISCORD_SNOWFLAKE.test(toeflChannelId)
          ? [{ guildId, channelId: toeflChannelId }]
          : [],
    },
  };
}

function assertSnapshot(
  value: unknown,
  environment: NodeJS.ProcessEnv,
): ServiceSubscriptionSnapshot {
  if (!value || typeof value !== "object") {
    throw new Error("Service subscriptions must be a JSON object.");
  }
  const snapshot = value as Partial<ServiceSubscriptionSnapshot>;
  if (snapshot.version !== 1 || !snapshot.services) {
    throw new Error("Unsupported service subscription format.");
  }
  const defaults = defaultServiceSubscriptions(environment);
  for (const service of Object.keys(
    MANAGED_SERVICE_DEFINITIONS,
  ) as ManagedServiceId[]) {
    const destinations =
      snapshot.services[service] ?? defaults.services[service];
    if (
      !Array.isArray(destinations) ||
      destinations.some(
        (destination) =>
          !DISCORD_SNOWFLAKE.test(destination.guildId) ||
          !DISCORD_SNOWFLAKE.test(destination.channelId),
      )
    ) {
      throw new Error(
        `Service subscriptions have invalid ${service} destinations.`,
      );
    }
    snapshot.services[service] = destinations;
  }
  return snapshot as ServiceSubscriptionSnapshot;
}

function copySnapshot(snapshot: ServiceSubscriptionSnapshot) {
  return structuredClone(snapshot);
}

export function formatManagedServices(
  snapshot: ServiceSubscriptionSnapshot,
  environment: NodeJS.ProcessEnv = process.env,
): ManagedServiceListing {
  return {
    services: (
      Object.entries(MANAGED_SERVICE_DEFINITIONS) as Array<
        [ManagedServiceId, string]
      >
    ).map(([id, name]) => ({
      id,
      name:
        id === "x_posts_primary"
          ? `@${environment.X_POST_HANDLE?.trim() || "thsottiaux"} X reposts (primary)`
          : name,
      destinations: snapshot.services[id].map((destination) => ({
        ...destination,
        channelMention: `<#${destination.channelId}>`,
        jumpUrl: `https://discord.com/channels/${destination.guildId}/${destination.channelId}`,
      })),
    })),
  };
}

export async function deliverToServiceDestinations(
  destinations: readonly ServiceDestination[],
  deliver: (destination: ServiceDestination) => Promise<unknown>,
) {
  const outcomes = await Promise.allSettled(destinations.map(deliver));
  const failures = outcomes.flatMap((outcome, index) =>
    outcome.status === "rejected"
      ? [{ destination: destinations[index]!, error: outcome.reason }]
      : [],
  );
  if (failures.length === destinations.length) {
    throw new AggregateError(
      failures.map((failure) => failure.error),
      "Every service destination failed.",
    );
  }
  return {
    delivered: destinations.length - failures.length,
    failedChannelIds: failures.map((failure) => failure.destination.channelId),
  };
}

export class ServiceSubscriptionStore {
  private snapshot: ServiceSubscriptionSnapshot;
  private mutationQueue: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly filePath: string,
    environment: NodeJS.ProcessEnv = process.env,
  ) {
    this.snapshot = existsSync(filePath)
      ? assertSnapshot(JSON.parse(readFileSync(filePath, "utf8")), environment)
      : defaultServiceSubscriptions(environment);
  }

  list() {
    return copySnapshot(this.snapshot);
  }

  destinations(service: ManagedServiceId) {
    return structuredClone(this.snapshot.services[service]);
  }

  configure(input: ServiceSubscriptionMutation): Promise<ServiceDestination[]> {
    if (!DISCORD_SNOWFLAKE.test(input.channelId)) {
      return Promise.reject(new Error("channelId must be a Discord ID."));
    }
    if (
      input.action === "subscribe" &&
      !DISCORD_SNOWFLAKE.test(input.guildId)
    ) {
      return Promise.reject(new Error("guildId must be a Discord ID."));
    }

    const mutation = this.mutationQueue.then(async () => {
      const next = copySnapshot(this.snapshot);
      const destinations = next.services[input.service].filter(
        (destination) => destination.channelId !== input.channelId,
      );
      if (input.action === "subscribe") {
        destinations.push({
          guildId: input.guildId,
          channelId: input.channelId,
        });
      }
      destinations.sort((left, right) =>
        left.channelId.localeCompare(right.channelId),
      );
      next.services[input.service] = destinations;
      await this.persist(next);
      this.snapshot = next;
      return structuredClone(destinations);
    });
    this.mutationQueue = mutation.catch(() => undefined);
    return mutation;
  }

  private async persist(snapshot: ServiceSubscriptionSnapshot) {
    await mkdir(dirname(this.filePath), { recursive: true });
    const temporaryPath = `${this.filePath}.${randomUUID()}.tmp`;
    await writeFile(temporaryPath, `${JSON.stringify(snapshot, null, 2)}\n`, {
      mode: 0o600,
    });
    await rename(temporaryPath, this.filePath);
  }
}

let sharedStore: ServiceSubscriptionStore | undefined;

export function getServiceSubscriptionStore() {
  sharedStore ??= new ServiceSubscriptionStore(
    process.env.MINISAGO_SERVICE_SUBSCRIPTIONS_FILE?.trim() ||
      ".data/service-subscriptions.json",
  );
  return sharedStore;
}
