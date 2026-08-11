import { afterEach, describe, expect, test } from "bun:test";

import {
  createTripPlannerClient,
  KYUSHU_TRIP_GUILD_ID,
  tripPlannerAvailableForGuild,
} from "./trip-planner";

const servers: Array<ReturnType<typeof Bun.serve>> = [];

afterEach(() => {
  for (const server of servers.splice(0)) server.stop(true);
});

function workspace() {
  return {
    version: 3,
    updatedAt: "2026-08-11T00:00:00.000Z",
    data: {
      customRules: [],
      priorityOverrides: {},
      variants: [
        {
          id: "balanced",
          name: "Balanced",
          description: "Main plan",
          stats: {},
          days: [
            {
              date: "2026-11-01",
              shortDate: "11/1",
              weekday: "Sun",
              city: "Fukuoka",
              summary: "Arrival",
              items: [
                {
                  id: "ramen",
                  time: "18:00",
                  title: "Ramen",
                  subtitle: "Dinner",
                  kind: "food",
                },
              ],
            },
          ],
        },
      ],
    },
  };
}

describe("trip planner client", () => {
  test("is available only in the bound Kyushu guild", () => {
    expect(tripPlannerAvailableForGuild(KYUSHU_TRIP_GUILD_ID)).toBe(true);
    expect(tripPlannerAvailableForGuild("another-guild")).toBe(false);
  });

  test("reads details and edits with the dedicated bearer token", async () => {
    let savedBody: Record<string, unknown> | undefined;
    const server = Bun.serve({
      port: 0,
      async fetch(request) {
        expect(request.headers.get("authorization")).toBe("Bearer secret");
        if (request.method === "PUT") {
          savedBody = (await request.json()) as Record<string, unknown>;
          return Response.json({
            ...workspace(),
            version: 4,
          });
        }
        return Response.json(workspace());
      },
    });
    servers.push(server);
    const client = createTripPlannerClient(
      {
        MINISAGO_TRIP_WORKSPACE_URL: `http://${server.hostname}:${server.port}`,
        MINISAGO_TRIP_WORKSPACE_TOKEN: "secret",
      },
      "discord-message-1",
    );

    const details = await client.read({
      planId: "balanced",
      date: "2026-11-01",
    });
    expect(details).toMatchObject({
      mode: "day",
      plans: [{ day: { city: "Fukuoka" } }],
    });

    const result = await client.edit!({
      action: "update_item",
      planId: "balanced",
      date: "2026-11-01",
      itemId: "ramen",
      time: "18:30",
    });
    expect(result).toMatchObject({ status: "complete", workspaceVersion: 4 });
    expect(savedBody).toMatchObject({
      editLabel: "MiniSago · Discord",
      editSessionId: "discord-message-1",
      version: 3,
      data: {
        variants: [{ days: [{ items: [{ id: "ramen", time: "18:30" }] }] }],
      },
    });
  });

  test("does not expose edits without a service token", () => {
    const client = createTripPlannerClient({
      MINISAGO_TRIP_WORKSPACE_URL: "https://example.invalid",
    });
    expect(client.edit).toBeUndefined();
  });
});
