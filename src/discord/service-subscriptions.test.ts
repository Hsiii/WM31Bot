import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";

import {
  deliverToServiceDestinations,
  defaultServiceSubscriptions,
  formatManagedServices,
  ServiceSubscriptionStore,
} from "./service-subscriptions";

describe("service subscriptions", () => {
  test("initializes existing service destinations", () => {
    const snapshot = defaultServiceSubscriptions({
      DISCORD_GUILD_ID: "123456789012345678",
      GAMER_FORUM_CHANNEL_ID: "223456789012345678",
      X_POST_CHANNEL_ID: "323456789012345678",
      TOEFL_VOCAB_CHANNEL_ID: "423456789012345678",
    });

    expect(snapshot.services.gamer_forum).toEqual([
      {
        guildId: "123456789012345678",
        channelId: "223456789012345678",
      },
    ]);
    expect(snapshot.services.toefl_vocab[0]?.channelId).toBe(
      "423456789012345678",
    );
    expect(snapshot.services.x_posts_thsottiaux).toHaveLength(1);
  });

  test("persists subscription changes", async () => {
    const directory = await mkdtemp(join(tmpdir(), "minisago-services-"));
    const filePath = join(directory, "subscriptions.json");
    const store = new ServiceSubscriptionStore(filePath, {});

    const destinations = await store.configure({
      service: "gamer_forum",
      action: "subscribe",
      guildId: "523456789012345678",
      channelId: "623456789012345678",
    });
    expect(
      destinations.some((item) => item.channelId === "623456789012345678"),
    ).toBe(true);

    const reloaded = new ServiceSubscriptionStore(filePath, {});
    expect(reloaded.destinations("gamer_forum")).toEqual(destinations);

    await reloaded.configure({
      service: "gamer_forum",
      action: "unsubscribe",
      channelId: "623456789012345678",
    });
    expect(
      JSON.parse(await readFile(filePath, "utf8")).services.gamer_forum,
    ).not.toContainEqual({
      guildId: "523456789012345678",
      channelId: "623456789012345678",
    });
  });

  test("formats destinations as clickable Discord channels", () => {
    const listing = formatManagedServices(
      defaultServiceSubscriptions({
        DISCORD_GUILD_ID: "123456789012345678",
        GAMER_FORUM_CHANNEL_ID: "223456789012345678",
      }),
      { X_POST_HANDLE: "example" },
    );
    expect(
      listing.services.find((service) => service.id === "gamer_forum")
        ?.destinations[0],
    ).toMatchObject({
      channelMention: "<#223456789012345678>",
      jumpUrl:
        "https://discord.com/channels/123456789012345678/223456789012345678",
    });
    expect(
      listing.services.find((service) => service.id === "x_posts_primary")
        ?.name,
    ).toBe("@example X reposts (primary)");
  });

  test("keeps healthy destinations running when one delivery fails", async () => {
    const destinations = [
      { guildId: "123456789012345678", channelId: "223456789012345678" },
      { guildId: "123456789012345678", channelId: "323456789012345678" },
    ];
    const result = await deliverToServiceDestinations(
      destinations,
      async ({ channelId }) => {
        if (channelId === "223456789012345678") throw new Error("forbidden");
      },
    );

    expect(result).toEqual({
      delivered: 1,
      failedChannelIds: ["223456789012345678"],
    });
  });
});
