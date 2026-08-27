import { appendFileSync } from "node:fs";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const server = new McpServer({
  name: "minisago-prompt-eval",
  version: "1.0.0",
});
const callLog = process.env.MINISAGO_PROMPT_EVAL_CALL_LOG;
const mockContext = JSON.parse(
  process.env.MINISAGO_PROMPT_EVAL_CONTEXT ?? "{}",
) as Record<string, unknown>;
const mediaId = process.env.MINISAGO_PROMPT_EVAL_MEDIA_ID;

if (!callLog) throw new Error("MINISAGO_PROMPT_EVAL_CALL_LOG is required");
const callLogPath = callLog;

function record(tool: string, input: unknown) {
  appendFileSync(callLogPath, `${JSON.stringify({ tool, input })}\n`);
}

function result(value: Record<string, unknown>) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(value) }],
    structuredContent: value,
  };
}

server.registerTool(
  "resolve_context",
  {
    description:
      "Read more current-channel history, search older accessible messages, and resolve member aliases when supplied Discord context is insufficient.",
    inputSchema: {
      historyCount: z.number().int().min(0).max(100).optional(),
      memberQueries: z.array(z.string()).optional(),
      queries: z.array(z.object({ query: z.string() })).optional(),
    },
  },
  async (input) => {
    record("resolve_context", input);
    return result({ status: "complete", ...mockContext });
  },
);

server.registerTool(
  "manage_server_memory",
  {
    description:
      "Save a stable correction or durable fact about the current Discord server.",
    inputSchema: {
      action: z.enum(["add", "replace", "remove"]),
      entryId: z.string().optional(),
      content: z.string().optional(),
    },
  },
  async (input) => {
    record("manage_server_memory", input);
    return result({ status: "complete", revision: 2, entryId: "memory-eval" });
  },
);

server.registerTool(
  "create_reminder",
  {
    description:
      "Create a one-time or recurring reminder in the current Discord channel.",
    inputSchema: {
      content: z.string(),
      runAt: z.string().optional(),
      cron: z.string().optional(),
      timezone: z.string().optional(),
      condition: z.string().optional(),
    },
  },
  async (input) => {
    record("create_reminder", input);
    return result({ status: "complete", reminder: input });
  },
);

server.registerTool(
  "send_channel_message",
  {
    description:
      "Send a message to a Discord channel only when the requester explicitly asks you to send or post it.",
    inputSchema: {
      content: z.string(),
      channel: z.string().optional(),
      server: z.string().optional(),
    },
  },
  async (input) => {
    record("send_channel_message", input);
    return result({
      status: "complete",
      message: {
        channelName: input.channel ?? "general",
        jumpUrl: "https://discord.com/channels/eval/general/message",
      },
    });
  },
);

server.registerTool(
  "describe_capabilities",
  {
    description:
      "Describe request-scoped MiniSago capabilities when someone asks what you can do.",
    inputSchema: {},
  },
  async (input) => {
    record("describe_capabilities", input);
    return result({ status: "complete", capabilities: [] });
  },
);

server.registerTool(
  "run_python",
  {
    description:
      "Run bounded Python for a media transformation not covered by another tool. Use mediaIds from the current request and return the generated media ID.",
    inputSchema: {
      code: z.string(),
      mediaIds: z.array(z.string()),
      outputExtension: z.string().optional(),
    },
  },
  async (input) => {
    record("run_python", input);
    return mediaId
      ? result({ status: "complete", mediaId })
      : result({
          status: "unavailable",
          reason: "No media result was produced.",
        });
  },
);

await server.connect(new StdioServerTransport());
