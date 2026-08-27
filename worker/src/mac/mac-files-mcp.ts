import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

import { MacFileSearch } from "./mac-files";

function toolResult(value: Record<string, unknown>) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(value) }],
    structuredContent: value,
  };
}

function message(error: unknown) {
  return error instanceof Error ? error.message : "File search failed.";
}

async function main() {
  const rawRoots = process.env.MINISAGO_MAC_FILE_ROOTS;
  if (!rawRoots) throw new Error("MINISAGO_MAC_FILE_ROOTS is required.");
  const parsed = JSON.parse(rawRoots);
  if (
    !Array.isArray(parsed) ||
    !parsed.every((root) => typeof root === "string")
  ) {
    throw new Error("MINISAGO_MAC_FILE_ROOTS must be a string array.");
  }
  const files = await MacFileSearch.create(parsed);
  const server = new McpServer(
    { name: "minisago-mac-files", version: "1.0.0" },
    {
      instructions:
        "Search only for a file explicitly requested by the owner. The tool searches names and returns metadata, never file contents. Use an exact returned path in the final files field only when one result clearly matches.",
    },
  );

  server.registerTool(
    "search_files",
    {
      description:
        "Search allowlisted Mac folders by filename. Every whitespace-separated query term must appear in the filename. Returns at most 20 paths with size and modification time. Hidden entries and symlinks are excluded.",
      inputSchema: {
        query: z.string().trim().min(1).max(200),
        root: z.string().trim().max(1_024).optional(),
        extension: z
          .string()
          .trim()
          .regex(/^\.?[a-zA-Z0-9]{1,20}$/u)
          .optional(),
        limit: z.number().int().min(1).max(20).default(10),
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async (input) => {
      try {
        return toolResult({
          status: "complete",
          allowedRoots: files.allowedRoots(),
          matches: await files.search(input),
        });
      } catch (error) {
        return toolResult({ status: "invalid", error: message(error) });
      }
    },
  );

  await server.connect(new StdioServerTransport());
}

await main().catch((error) => {
  console.error(message(error));
  process.exit(1);
});
