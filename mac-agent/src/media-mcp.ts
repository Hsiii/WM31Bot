import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

import { MediaProcessor } from "./media";
import { PythonProcessor, pythonArtifactExtensions } from "./python";

function toolResult(value: Record<string, unknown>) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(value) }],
    structuredContent: value,
  };
}

function message(error: unknown) {
  return error instanceof Error ? error.message : "Media processing failed.";
}

async function main() {
  const manifestPath = process.env.MINISAGO_MEDIA_MANIFEST;
  if (!manifestPath) throw new Error("MINISAGO_MEDIA_MANIFEST is required.");
  const sandboxUrl = process.env.MINISAGO_SANDBOX_URL;
  if (!sandboxUrl) throw new Error("MINISAGO_SANDBOX_URL is required.");
  const processor = await MediaProcessor.fromFile(manifestPath);
  const python = await PythonProcessor.fromFile(manifestPath, sandboxUrl);
  const server = new McpServer(
    { name: "minisago-media", version: "1.0.0" },
    {
      instructions:
        "Use these request-local tools only when the requester explicitly asks to inspect, compute with, or transform an attachment. Inputs are limited to this request's attachments; outputs are temporary artifacts. Never invent attachment IDs or artifact IDs. Return at most one useful artifact in the final answer. Prefer a specific media tool when it fits. Otherwise use run_python for general request-local computation. Python has no network, cannot install packages, receives no credentials, and is limited by time, memory, processes, and output size.",
    },
  );
  const readAnnotations = {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  } as const;
  const transformAnnotations = {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: false,
    openWorldHint: false,
  } as const;

  server.registerTool(
    "inspect_media",
    {
      description:
        "Inspect one audio, image, or video attachment from the active request. Returns bounded format, stream, dimension, and duration metadata. Use the exact Discord attachment ID from context.",
      inputSchema: {
        attachmentId: z.string().trim().min(1).max(100),
      },
      annotations: readAnnotations,
    },
    async ({ attachmentId }) => {
      try {
        return toolResult({
          status: "complete",
          ...(await processor.inspect(attachmentId)),
        });
      } catch (error) {
        return toolResult({ status: "invalid", error: message(error) });
      }
    },
  );

  server.registerTool(
    "transform_image",
    {
      description:
        "Convert, resize, fit, or rotate one image attached to the active request. Produces one temporary artifact and strips metadata. Call only when the requester explicitly asks for the transformation.",
      inputSchema: {
        attachmentId: z.string().trim().min(1).max(100),
        format: z.enum(["jpeg", "png", "webp"]).default("webp"),
        width: z.number().int().min(16).max(4096).optional(),
        height: z.number().int().min(16).max(4096).optional(),
        fit: z.enum(["contain", "cover", "stretch"]).default("contain"),
        rotate: z
          .union([z.literal(0), z.literal(90), z.literal(180), z.literal(270)])
          .default(0),
        quality: z.number().int().min(20).max(100).default(82),
      },
      annotations: transformAnnotations,
    },
    async (input) => {
      try {
        return toolResult({
          status: "complete",
          ...(await processor.transformImage(input)),
        });
      } catch (error) {
        return toolResult({ status: "invalid", error: message(error) });
      }
    },
  );

  server.registerTool(
    "extract_video_frame",
    {
      description:
        "Extract one still frame from a video attached to the active request. Produces one temporary image artifact. Call only when the requester explicitly asks for a frame or thumbnail.",
      inputSchema: {
        attachmentId: z.string().trim().min(1).max(100),
        timeSeconds: z.number().min(0).max(600).default(0),
        format: z.enum(["jpeg", "png", "webp"]).default("jpeg"),
        width: z.number().int().min(16).max(4096).optional(),
      },
      annotations: transformAnnotations,
    },
    async (input) => {
      try {
        return toolResult({
          status: "complete",
          ...(await processor.extractFrame(input)),
        });
      } catch (error) {
        return toolResult({ status: "invalid", error: message(error) });
      }
    },
  );

  server.registerTool(
    "transcode_media",
    {
      description:
        "Create a short MP4, MP3, or GIF from an audio or video attachment in the active request. Uses fixed codecs and bounded presets; arbitrary FFmpeg arguments are not accepted.",
      inputSchema: {
        attachmentId: z.string().trim().min(1).max(100),
        preset: z.enum(["audio_mp3", "gif", "video_mp4"]),
        startSeconds: z.number().min(0).max(600).default(0),
        durationSeconds: z.number().min(0.1).max(120),
        maxWidth: z.number().int().min(64).max(1280).default(1280),
      },
      annotations: transformAnnotations,
    },
    async (input) => {
      try {
        return toolResult({
          status: "complete",
          ...(await processor.transcode(input)),
        });
      } catch (error) {
        return toolResult({ status: "invalid", error: message(error) });
      }
    },
  );

  server.registerTool(
    "run_python",
    {
      description:
        "Run bounded Python for a computation or attachment transformation not covered by another tool. Read MINISAGO_INPUTS_JSON for selected request-local input paths. If outputExtension is set, write exactly one result to MINISAGO_OUTPUT_PATH and return its artifact ID. The runtime has no network or package installation.",
      inputSchema: {
        code: z.string().min(1).max(20_000),
        attachmentIds: z.array(z.string().trim().min(1).max(100)).max(10),
        outputExtension: z.enum(pythonArtifactExtensions).optional(),
      },
      annotations: transformAnnotations,
    },
    async (input) => {
      try {
        return toolResult({
          status: "complete",
          ...(await python.run(input)),
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
