import { afterEach, describe, expect, test } from "bun:test";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

import { handleChatbotMcpRequest, registerChatbotMcpSession } from "./mcp";

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
    getRecentMessages: async (limit: number) => [
      {
        id: `recent-${limit}`,
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
    searchMessages: async () => [
      {
        id: "search-1",
        author: "Hsi",
        timestamp: "2026-07-20T10:00:00.000Z",
        content: "older result",
        attachments: [],
        channelName: "projects",
        jumpUrl: "https://discord.com/channels/guild-1/channel-1/search-1",
      },
    ],
    lookupMembers: async (queries: string[]) =>
      queries.map((query) => ({ query, names: [query, "Display Name"] })),
    getPreviousTrace: async () => ({
      status: "not_found" as const,
    }),
    resolveContext: async () => ({
      history: { status: "complete" as const, messages: [] },
      search: { status: "not_requested" as const, results: [] },
      members: { status: "not_requested" as const, results: [] },
      previousTrace: { status: "not_requested" as const },
    }),
    addReaction: async (emoji: string) => emoji === "👍",
    addReactionDescription:
      'React to the current request. Custom values: {"sago":"sago:1"}',
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
      "get_recent_messages",
      "search_messages",
      "lookup_members",
      "get_previous_trace",
      "resolve_context",
      "add_reaction",
    ]);
    expect(
      tools.tools.find((tool) => tool.name === "add_reaction")?.description,
    ).toContain("sago:1");

    const result = await client.callTool({
      name: "get_recent_messages",
      arguments: { limit: 40 },
    });
    expect(result.structuredContent).toMatchObject({
      status: "complete",
      messages: [{ id: "recent-40" }],
    });
    expect(JSON.stringify(result)).not.toContain("cdn.discordapp.com");

    await client.close();
    session.revoke();
  });

  test("validates tool arguments and records only successful reactions", async () => {
    const session = registerChatbotMcpSession(handlers());
    const client = await connect(session.token);

    const invalid = await client.callTool({
      name: "get_recent_messages",
      arguments: { limit: 101 },
    });
    expect(invalid.isError).toBe(true);

    await client.callTool({
      name: "add_reaction",
      arguments: { emoji: "👎" },
    });
    expect(session.snapshot().reacted).toBe(false);

    await client.callTool({
      name: "add_reaction",
      arguments: { emoji: "👍" },
    });
    expect(session.snapshot().reacted).toBe(true);

    await client.close();
    session.revoke();
  });

  test("hides guild tools when no guild-scoped handlers exist", async () => {
    const baseHandlers = handlers();
    const session = registerChatbotMcpSession({
      getRecentMessages: baseHandlers.getRecentMessages,
      getPreviousTrace: baseHandlers.getPreviousTrace,
      resolveContext: baseHandlers.resolveContext,
    });
    const client = await connect(session.token);
    const tools = await client.listTools();

    expect(tools.tools.map((tool) => tool.name)).toEqual([
      "get_recent_messages",
      "get_previous_trace",
      "resolve_context",
    ]);

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

  test("exposes owner-bound cross-guild emoji tools", async () => {
    const copies: unknown[] = [];
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
      copyGuildEmoji: async (input) => {
        copies.push(input);
        return {
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
    expect(tools.tools.map((tool) => tool.name)).toContain("copy_guild_emoji");

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
      name: "copy_guild_emoji",
      arguments: {
        emoji: "<:wave:123456789012345678>",
        sourceGuild: "Source",
        destinationGuild: "Target",
        name: "hello",
      },
    });
    expect(result.structuredContent).toMatchObject({
      status: "complete",
      emoji: { name: "hello", guild: { name: "Target" } },
    });
    expect(copies).toEqual([
      {
        emoji: "<:wave:123456789012345678>",
        sourceGuild: "Source",
        destinationGuild: "Target",
        name: "hello",
      },
    ]);

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

    const missingTimezone = await client.callTool({
      name: "create_reminder",
      arguments: {
        content: "stand up",
        cron: "0 9 * * *",
      },
    });
    expect(missingTimezone.structuredContent).toMatchObject({
      status: "invalid",
    });
    expect(created).toHaveLength(0);

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
