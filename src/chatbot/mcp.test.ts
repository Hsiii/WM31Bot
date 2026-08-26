import { afterEach, describe, expect, test } from "bun:test";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

import {
  budgetResolvedContext,
  handleChatbotMcpRequest,
  registerChatbotMcpSession,
} from "./mcp";

const servers: Array<ReturnType<typeof Bun.serve>> = [];

afterEach(() => {
  for (const server of servers.splice(0)) server.stop(true);
});

function startServer() {
  const server = Bun.serve({
    port: 0,
    fetch: handleChatbotMcpRequest,
  });
  servers.push(server);
  return `http://${server.hostname}:${server.port}`;
}

function handlers() {
  return {
    getPreviousTrace: async () => ({
      status: "not_found" as const,
    }),
    resolveContext: async ({ historyCount }: { historyCount: number }) => ({
      history: {
        status: "complete" as const,
        messages: [
          {
            id: `recent-${historyCount}`,
            author: "Daniel",
            timestamp: "2026-07-24T10:00:00.000Z",
            content: "recent context",
            attachments: [
              {
                id: "attachment-1",
                filename: "notes.txt",
                contentType: "text/plain",
                size: 42,
                url: "https://cdn.discordapp.com/private/notes.txt",
              },
            ],
          },
        ],
      },
      search: { status: "not_requested" as const, results: [] },
      members: { status: "not_requested" as const, results: [] },
      previousTrace: { status: "not_requested" as const },
    }),
  };
}

async function connect(token: string) {
  const client = new Client({
    name: "minisago-test",
    version: "1.0.0",
  });
  const transport = new StreamableHTTPClientTransport(
    new URL(`${startServer()}/api/chatbot/mcp`),
    {
      requestInit: {
        headers: { Authorization: `Bearer ${token}` },
      },
    },
  );
  await client.connect(transport);
  return client;
}

describe("MiniSago MCP server", () => {
  test("budgets resolved history and search with explicit omissions", () => {
    const messages = Array.from({ length: 30 }, (_, index) => ({
      id: String(index),
      author: "Member",
      timestamp: "2026-08-02T00:00:00.000Z",
      content: `${index}:${"x".repeat(4_000)}`,
      attachments: [],
    }));
    const result = budgetResolvedContext({
      history: { status: "complete", messages },
      search: { status: "complete", results: messages },
      members: { status: "not_requested", results: [] },
      previousTrace: { status: "not_requested" },
    });

    expect(JSON.stringify(result).length).toBeLessThan(50_000);
    expect(result.contextOmissions).toMatchObject([
      { section: "resolved_history", reason: "section_budget" },
      { section: "resolved_search", reason: "section_budget" },
    ]);
    expect(result.history.messages.at(-1)?.id).toBe("29");
  });

  test("requires an active bearer-bound chatbot session", async () => {
    const response = await fetch(`${startServer()}/api/chatbot/mcp`, {
      method: "POST",
      headers: {
        Authorization: "Bearer invalid",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2025-11-25",
          capabilities: {},
          clientInfo: { name: "test", version: "1" },
        },
      }),
    });

    expect(response.status).toBe(401);
    expect(response.headers.get("cache-control")).toBe("no-store");
  });

  test("exposes bounded tools and strips Discord CDN URLs", async () => {
    const session = registerChatbotMcpSession(handlers());
    const client = await connect(session.token);
    const tools = await client.listTools();

    expect(tools.tools.map((tool) => tool.name)).toEqual([
      "describe_capabilities",
      "get_previous_trace",
      "resolve_context",
    ]);

    const result = await client.callTool({
      name: "resolve_context",
      arguments: { historyCount: 40 },
    });
    expect(result.structuredContent).toMatchObject({
      history: { status: "complete", messages: [{ id: "recent-40" }] },
    });
    expect(JSON.stringify(result)).not.toContain("cdn.discordapp.com");

    await client.close();
    session.revoke();
  });

  test("returns member avatar URLs through context lookup", async () => {
    const session = registerChatbotMcpSession({
      ...handlers(),
      resolveContext: async () => ({
        history: { status: "complete" as const, messages: [] },
        search: { status: "not_requested" as const, results: [] },
        members: {
          status: "complete" as const,
          results: [
            {
              query: "Daniel",
              names: ["Daniel"],
              avatarUrl:
                "https://cdn.discordapp.com/avatars/user-1/avatar.png?size=4096",
            },
          ],
        },
        previousTrace: { status: "not_requested" as const },
      }),
    });
    const client = await connect(session.token);

    const result = await client.callTool({
      name: "resolve_context",
      arguments: { memberQueries: ["Daniel"] },
    });

    expect(result.structuredContent).toMatchObject({
      members: {
        status: "complete",
        results: [
          {
            query: "Daniel",
            avatarUrl:
              "https://cdn.discordapp.com/avatars/user-1/avatar.png?size=4096",
          },
        ],
      },
    });

    await client.close();
    session.revoke();
  });

  test("validates context tool arguments", async () => {
    const session = registerChatbotMcpSession(handlers());
    const client = await connect(session.token);

    const invalid = await client.callTool({
      name: "resolve_context",
      arguments: { historyCount: 101 },
    });
    expect(invalid.isError).toBe(true);

    await client.close();
    session.revoke();
  });

  test("exposes a request-bound channel quiet action", async () => {
    const pauses: Array<number | undefined> = [];
    const session = registerChatbotMcpSession({
      ...handlers(),
      pauseChannelActivity: (durationMinutes?: number) => {
        pauses.push(durationMinutes);
        return {
          pausedUntil: "2026-08-11T04:30:00.000Z",
          durationMinutes: durationMinutes ?? 10,
        };
      },
    });
    const client = await connect(session.token);

    const result = await client.callTool({
      name: "pause_channel_activity",
      arguments: { durationMinutes: 30 },
    });

    expect(pauses).toEqual([30]);
    expect(result.structuredContent).toEqual({
      status: "complete",
      pausedUntil: "2026-08-11T04:30:00.000Z",
      durationMinutes: 30,
      currentReply: "suppressed",
    });

    await client.close();
    session.revoke();
  });

  test("hides guild tools when no guild-scoped handlers exist", async () => {
    const baseHandlers = handlers();
    const session = registerChatbotMcpSession({
      getPreviousTrace: baseHandlers.getPreviousTrace,
      resolveContext: baseHandlers.resolveContext,
    });
    const client = await connect(session.token);
    const tools = await client.listTools();

    expect(tools.tools.map((tool) => tool.name)).toEqual([
      "describe_capabilities",
      "get_previous_trace",
      "resolve_context",
    ]);

    await client.close();
    session.revoke();
  });

  test("exposes host-bound trip read and edit tools", async () => {
    const edits: unknown[] = [];
    const session = registerChatbotMcpSession({
      ...handlers(),
      readTripPlan: async (input) => ({ status: "complete", input }),
      editTripPlan: async (input) => {
        edits.push(input);
        return { status: "complete", action: input.action };
      },
    });
    const client = await connect(session.token);
    const tools = await client.listTools();

    expect(tools.tools.map((tool) => tool.name)).toContain("read_trip_plan");
    expect(tools.tools.map((tool) => tool.name)).toContain("edit_trip_plan");
    expect(
      tools.tools.find((tool) => tool.name === "edit_trip_plan")?.inputSchema,
    ).toMatchObject({
      properties: {
        kind: {
          enum: [
            "arrival",
            "departure",
            "stay",
            "place",
            "food",
            "transit",
            "concert",
            "friend",
            "open",
          ],
        },
      },
    });
    expect(
      tools.tools.find((tool) => tool.name === "read_trip_plan")?.description,
    ).toContain("Required source of truth");
    const read = await client.callTool({
      name: "read_trip_plan",
      arguments: { date: "2026-11-01" },
    });
    expect(read.structuredContent).toMatchObject({
      status: "complete",
      input: { date: "2026-11-01" },
    });
    await client.callTool({
      name: "edit_trip_plan",
      arguments: {
        action: "update_day",
        planId: "balanced",
        date: "2026-11-01",
        summary: "Updated",
      },
    });
    expect(edits).toEqual([
      {
        action: "update_day",
        planId: "balanced",
        date: "2026-11-01",
        summary: "Updated",
      },
    ]);

    await client.close();
    session.revoke();
  });

  test("describes only request-scoped and conditional capabilities", async () => {
    const session = registerChatbotMcpSession({
      ...handlers(),
      describeCapabilities: () => [
        {
          id: "repository_work",
          category: "development",
          availability: "conditional",
          description: "Work in a configured repository for the owner.",
          condition: "The owner must make an explicit repository request.",
        },
      ],
      sendChannelMessage: async () => ({
        id: "message-1",
        channelId: "channel-1",
        guildId: "guild-1",
        jumpUrl: "https://discord.com/channels/guild-1/channel-1/message-1",
      }),
    });
    const client = await connect(session.token);
    const tool = (await client.listTools()).tools.find(
      ({ name }) => name === "describe_capabilities",
    );

    expect(tool?.annotations).toMatchObject({
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
    });
    const result = await client.callTool({
      name: "describe_capabilities",
      arguments: {},
    });
    expect(result.structuredContent).toMatchObject({
      status: "complete",
      scope: "current_request",
      capabilities: [
        {
          id: "repository_work",
          availability: "conditional",
        },
        {
          id: "capability_discovery",
          tools: ["describe_capabilities"],
        },
        {
          id: "discord_context",
          tools: ["resolve_context", "get_previous_trace"],
        },
        {
          id: "channel_messaging",
          tools: ["send_channel_message"],
        },
      ],
    });
    expect(JSON.stringify(result.structuredContent)).not.toContain(
      "custom_expressions",
    );

    await client.close();
    session.revoke();
  });

  test("exposes read-only worker Codex usage when its handler is available", async () => {
    const session = registerChatbotMcpSession({
      ...handlers(),
      getCodexUsage: async () => ({
        windows: [
          {
            label: "weekly",
            windowMinutes: 10_080,
            usedPercent: 30,
            remainingPercent: 70,
            resetsAt: "2026-08-09T00:00:00.000Z",
          },
        ],
        updatedAt: "2026-08-02T00:00:00.000Z",
      }),
    });
    const client = await connect(session.token);

    const tools = await client.listTools();
    const usageTool = tools.tools.find(
      (tool) => tool.name === "get_codex_usage",
    );
    expect(usageTool?.description).toContain("token 還有多少");
    expect(usageTool?.annotations).toMatchObject({
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
    });
    const result = await client.callTool({
      name: "get_codex_usage",
      arguments: {},
    });
    expect(result.structuredContent).toMatchObject({
      status: "complete",
      windows: [{ remainingPercent: 70 }],
    });

    await client.close();
    session.revoke();
  });

  test("exposes proactive server memory without a caller-controlled guild", async () => {
    const mutations: unknown[] = [];
    const session = registerChatbotMcpSession({
      ...handlers(),
      manageServerMemory: async (input) => {
        mutations.push(input);
        return {
          revision: 1,
          action: input.action,
          entryId: "entryId" in input ? input.entryId : "mem_012345abcdef",
        };
      },
    });
    const client = await connect(session.token);
    const tool = (await client.listTools()).tools.find(
      ({ name }) => name === "manage_server_memory",
    );

    expect(tool?.inputSchema).not.toHaveProperty("properties.guildId");
    expect(tool?.description).toContain("Save proactively");
    expect(tool?.description).toContain(
      "member explicitly teaches or corrects",
    );
    expect(tool?.annotations).toMatchObject({
      readOnlyHint: false,
      destructiveHint: true,
      openWorldHint: false,
    });
    const invalid = await client.callTool({
      name: "manage_server_memory",
      arguments: { action: "remove" },
    });
    expect(invalid.structuredContent).toMatchObject({ status: "invalid" });

    const result = await client.callTool({
      name: "manage_server_memory",
      arguments: { action: "add", content: "允通常是允成" },
    });
    expect(result.structuredContent).toEqual({
      status: "complete",
      revision: 1,
      action: "add",
      entryId: "mem_012345abcdef",
    });
    expect(mutations).toEqual([{ action: "add", content: "允通常是允成" }]);

    const capabilities = await client.callTool({
      name: "describe_capabilities",
      arguments: {},
    });
    expect(capabilities.structuredContent).toMatchObject({
      capabilities: expect.arrayContaining([
        expect.objectContaining({
          id: "server_memory",
          description: expect.stringContaining("when a member teaches Sago"),
        }),
      ]),
    });

    await client.close();
    session.revoke();
  });

  test("exposes the owner-bound guild expression tool", async () => {
    const additions: unknown[] = [];
    const session = registerChatbotMcpSession({
      ...handlers(),
      listSharedGuilds: async () => [
        {
          id: "987654321098765432",
          name: "Target",
          canCreateExpressions: true,
          current: true,
        },
      ],
      listGuildEmojis: async (guild) => ({
        guild: {
          id: "123456789012345678",
          name: guild,
          canCreateExpressions: false,
        },
        emojis: [
          {
            id: "234567890123456789",
            name: "wave",
            animated: false,
            available: true,
          },
        ],
      }),
      addGuildExpression: async (input) => {
        additions.push(input);
        return {
          kind: input.kind ?? "emoji",
          id: "876543210987654321",
          name: input.name ?? "wave",
          animated: false,
          sourceGuild: {
            id: "123456789012345678",
            name: "Source",
            canCreateExpressions: false,
          },
          guild: {
            id: "987654321098765432",
            name: "Target",
            canCreateExpressions: true,
          },
        };
      },
    });
    const client = await connect(session.token);
    const tools = await client.listTools();

    expect(tools.tools.map((tool) => tool.name)).toContain(
      "list_shared_guilds",
    );
    expect(tools.tools.map((tool) => tool.name)).toContain("list_guild_emojis");
    expect(tools.tools.map((tool) => tool.name)).toContain(
      "add_guild_expression",
    );

    const inventory = await client.callTool({
      name: "list_guild_emojis",
      arguments: { guild: "Source" },
    });
    expect(inventory.structuredContent).toMatchObject({
      status: "complete",
      guild: { name: "Source" },
      emojis: [{ name: "wave" }],
    });

    const result = await client.callTool({
      name: "add_guild_expression",
      arguments: {
        emoji: "<:wave:123456789012345678>",
        sourceGuild: "Source",
        destinationGuild: "Target",
        name: "hello",
      },
    });
    expect(result.structuredContent).toMatchObject({
      status: "complete",
      expression: { name: "hello", guild: { name: "Target" } },
    });
    expect(additions).toEqual([
      {
        kind: "emoji",
        emoji: "<:wave:123456789012345678>",
        sourceGuild: "Source",
        destinationGuild: "Target",
        name: "hello",
      },
    ]);

    await client.callTool({
      name: "add_guild_expression",
      arguments: { name: "from_image" },
    });
    expect(additions.at(-1)).toEqual({ kind: "emoji", name: "from_image" });

    await client.callTool({
      name: "add_guild_expression",
      arguments: { kind: "sticker", name: "from_sticker", tags: "🎉" },
    });
    expect(additions.at(-1)).toEqual({
      kind: "sticker",
      name: "from_sticker",
      tags: "🎉",
    });

    await client.close();
    session.revoke();
  });

  test("exposes host-bound voice channel actions", async () => {
    let joined = 0;
    let left = 0;
    const session = registerChatbotMcpSession({
      ...handlers(),
      joinVoiceChannel: () => {
        joined += 1;
        return { status: "joined" as const, channelId: "voice-1" };
      },
      leaveVoiceChannel: () => {
        left += 1;
        return { status: "left" as const };
      },
    });
    const client = await connect(session.token);
    const tools = await client.listTools();

    expect(tools.tools.map((tool) => tool.name)).toContain(
      "join_voice_channel",
    );
    expect(tools.tools.map((tool) => tool.name)).toContain(
      "leave_voice_channel",
    );

    const joinResult = await client.callTool({
      name: "join_voice_channel",
      arguments: {},
    });
    expect(joinResult.structuredContent).toEqual({
      status: "complete",
      action: "joined",
      channelId: "voice-1",
    });

    const leaveResult = await client.callTool({
      name: "leave_voice_channel",
      arguments: {},
    });
    expect(leaveResult.structuredContent).toEqual({
      status: "complete",
      action: "left",
    });
    expect({ joined, left }).toEqual({ joined: 1, left: 1 });

    await client.close();
    session.revoke();
  });

  test("exposes the owner-bound channel messaging action", async () => {
    const sent: unknown[] = [];
    const session = registerChatbotMcpSession({
      ...handlers(),
      sendChannelMessage: async (input) => {
        sent.push(input);
        return {
          id: "234567890123456789",
          channelId: "123456789012345678",
          channelName: "general",
          guildId: "987654321098765432",
          guildName: "Sago Club",
          jumpUrl:
            "https://discord.com/channels/987654321098765432/123456789012345678/234567890123456789",
        };
      },
    });
    const client = await connect(session.token);

    const result = await client.callTool({
      name: "send_channel_message",
      arguments: {
        server: "Sago Club",
        channel: "general",
        content: "hello club",
      },
    });

    expect(sent).toEqual([
      {
        server: "Sago Club",
        channel: "general",
        content: "hello club",
      },
    ]);
    expect(result.structuredContent).toMatchObject({
      status: "complete",
      message: {
        id: "234567890123456789",
        channelName: "general",
      },
    });

    await client.close();
    session.revoke();
  });

  test("creates, lists, and cancels bearer-bound reminders", async () => {
    const created: unknown[] = [];
    const cancelled: string[] = [];
    const session = registerChatbotMcpSession({
      ...handlers(),
      createReminder: async (input) => {
        created.push(input);
        return {
          id: "123e4567-e89b-12d3-a456-426614174000",
          content: input.content,
          nextRunAt: "2026-07-26T01:00:00.000Z",
          ...(input.cron ? { cron: input.cron } : {}),
          ...(input.timezone ? { timezone: input.timezone } : {}),
        };
      },
      listReminders: async () => [
        {
          id: "123e4567-e89b-12d3-a456-426614174000",
          content: "stand up",
          nextRunAt: "2026-07-26T01:00:00.000Z",
        },
      ],
      cancelReminder: async (reminderId) => {
        cancelled.push(reminderId);
        return true;
      },
    });
    const client = await connect(session.token);
    const tools = await client.listTools();

    expect(tools.tools.map((tool) => tool.name)).toContain("create_reminder");
    const invalid = await client.callTool({
      name: "create_reminder",
      arguments: {
        content: "stand up",
        runAt: "2026-07-26T01:00:00Z",
        cron: "0 9 * * *",
      },
    });
    expect(invalid.structuredContent).toMatchObject({ status: "invalid" });
    expect(created).toHaveLength(0);

    const defaultTimezone = await client.callTool({
      name: "create_reminder",
      arguments: {
        content: "stand up",
        cron: "0 9 * * *",
      },
    });
    expect(defaultTimezone.structuredContent).toMatchObject({
      status: "complete",
      reminder: {
        timezone: "Asia/Taipei",
      },
    });
    expect(created).toHaveLength(1);

    const createResult = await client.callTool({
      name: "create_reminder",
      arguments: {
        content: "stand up",
        cron: "0 9 * * *",
        timezone: "Asia/Taipei",
      },
    });
    expect(createResult.structuredContent).toMatchObject({
      status: "complete",
      reminder: {
        id: "123e4567-e89b-12d3-a456-426614174000",
        cron: "0 9 * * *",
      },
    });
    expect(created).toHaveLength(2);

    const listResult = await client.callTool({
      name: "list_reminders",
      arguments: {},
    });
    expect(listResult.structuredContent).toMatchObject({
      status: "complete",
      reminders: [{ content: "stand up" }],
    });

    await client.callTool({
      name: "cancel_reminder",
      arguments: { reminderId: "123e4567-e89b-12d3-a456-426614174000" },
    });
    expect(cancelled).toEqual(["123e4567-e89b-12d3-a456-426614174000"]);

    await client.close();
    session.revoke();
  });
});
