import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import {
  getDefaultEnvironment,
  StdioClientTransport,
} from "@modelcontextprotocol/sdk/client/stdio.js";

const temporaryDirectories: string[] = [];
const clients: Client[] = [];

afterEach(async () => {
  await Promise.all(clients.splice(0).map((client) => client.close()));
  await Promise.all(
    temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true })),
  );
});

describe("MiniSago media MCP", () => {
  test("starts over stdio with only the curated request-local tools", async () => {
    const root = await mkdtemp(join(tmpdir(), "minisago-media-mcp-"));
    temporaryDirectories.push(root);
    const outputs = join(root, "outputs");
    await mkdir(outputs);
    const manifestPath = join(root, "media-manifest.json");
    await writeFile(
      manifestPath,
      JSON.stringify({
        version: 1,
        root,
        outputDirectory: outputs,
        attachments: [],
      }),
    );
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [new URL("./media-mcp.ts", import.meta.url).pathname],
      env: {
        ...getDefaultEnvironment(),
        MINISAGO_MEDIA_MANIFEST: manifestPath,
        MINISAGO_SANDBOX_URL: "http://sandbox:8080",
      },
      stderr: "pipe",
    });
    const client = new Client(
      { name: "minisago-media-test", version: "1.0.0" },
      { capabilities: {} },
    );
    clients.push(client);
    await client.connect(transport);

    const tools = await client.listTools();
    expect(tools.tools.map((tool) => tool.name)).toEqual([
      "inspect_media",
      "transform_image",
      "extract_video_frame",
      "transcode_media",
      "run_python",
    ]);
    expect(
      tools.tools.find((tool) => tool.name === "transcode_media")?.inputSchema,
    ).not.toHaveProperty("args");
    expect(
      tools.tools.find((tool) => tool.name === "run_python")?.inputSchema,
    ).not.toHaveProperty("command");
  });
});
