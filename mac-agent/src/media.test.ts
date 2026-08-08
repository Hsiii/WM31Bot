import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { MediaProcessor, mediaLimits, type MediaCommandRunner } from "./media";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true })),
  );
});

async function fixture(
  probe: Record<string, unknown> = {
    format: { duration: "4.5", size: "5", format_name: "png_pipe" },
    streams: [
      { codec_type: "video", codec_name: "png", width: 800, height: 600 },
    ],
  },
) {
  const root = await mkdtemp(join(tmpdir(), "minisago-media-"));
  temporaryDirectories.push(root);
  const outputs = join(root, "outputs");
  await mkdir(outputs);
  await writeFile(join(root, "0-source.png"), "image");
  const commands: Array<{ command: string; args: string[] }> = [];
  const runner: MediaCommandRunner = async (command, args) => {
    commands.push({ command, args });
    if (command.endsWith("ffprobe")) {
      return { stdout: JSON.stringify(probe), stderr: "" };
    }
    await writeFile(args.at(-1)!, "converted");
    return { stdout: "", stderr: "" };
  };
  const processor = await MediaProcessor.create(
    {
      version: 1,
      root,
      outputDirectory: outputs,
      attachments: [
        {
          id: "attachment-1",
          filename: "source.png",
          contentType: "image/png",
          size: 5,
          storedFilename: "0-source.png",
        },
      ],
    },
    { runner, idFactory: () => "fixed" },
  );
  return { commands, processor, root };
}

describe("request-local media processor", () => {
  test("returns bounded probe metadata without tags or arbitrary fields", async () => {
    const { processor } = await fixture({
      format: {
        duration: "4.5",
        size: "5",
        format_name: "png_pipe",
        tags: { secret: "discard me" },
      },
      streams: [
        {
          codec_type: "video",
          codec_name: "png",
          width: 800,
          height: 600,
          tags: { comment: "discard me" },
        },
      ],
    });

    expect(await processor.inspect("attachment-1")).toEqual({
      attachmentId: "attachment-1",
      filename: "source.png",
      contentType: "image/png",
      format: "png_pipe",
      durationSeconds: 4.5,
      size: 5,
      streams: [
        {
          type: "video",
          codec: "png",
          width: 800,
          height: 600,
          frameRate: undefined,
          channels: undefined,
          sampleRate: undefined,
        },
      ],
    });
  });

  test("builds a fixed image transform and returns only its artifact ID", async () => {
    const { commands, processor } = await fixture();

    const result = await processor.transformImage({
      attachmentId: "attachment-1",
      format: "webp",
      width: 320,
      height: 240,
      fit: "cover",
      rotate: 90,
      quality: 82,
    });

    expect(result).toEqual({ artifactId: "media-fixed.webp", size: 9 });
    expect(commands[1]?.command).toBe("/usr/bin/ffmpeg");
    expect(commands[1]?.args).toContain("-nostdin");
    expect(commands[1]?.args).toContain("-map_metadata");
    expect(commands[1]?.args).toContain(
      "scale=320:240:force_original_aspect_ratio=increase,crop=320:240,transpose=1",
    );
    expect(commands[1]?.args.at(-1)).toEndWith("/outputs/media-fixed.webp");
  });

  test("enforces preset-specific duration limits", async () => {
    const { processor } = await fixture({
      format: { duration: "60", size: "5", format_name: "mov" },
      streams: [
        { codec_type: "video", codec_name: "h264", width: 1280, height: 720 },
        { codec_type: "audio", codec_name: "aac", channels: 2 },
      ],
    });

    await expect(
      processor.transcode({
        attachmentId: "attachment-1",
        preset: "gif",
        startSeconds: 0,
        durationSeconds: 16,
        maxWidth: 640,
      }),
    ).rejects.toThrow("preset duration is too long");
  });

  test("rejects oversized decoded dimensions before invoking FFmpeg", async () => {
    const { commands, processor } = await fixture({
      format: { size: "5", format_name: "png_pipe" },
      streams: [
        {
          codec_type: "video",
          codec_name: "png",
          width: 10_000,
          height: 10_000,
        },
      ],
    });

    await expect(
      processor.transformImage({
        attachmentId: "attachment-1",
        format: "png",
        fit: "contain",
        rotate: 0,
        quality: 82,
      }),
    ).rejects.toThrow("dimensions exceed");
    expect(commands).toHaveLength(1);
  });

  test("publishes conservative processing limits", () => {
    expect(mediaLimits).toEqual({
      inputBytes: 20 * 1024 * 1024,
      outputBytes: 8 * 1024 * 1024,
      dimension: 8_192,
      pixels: 40_000_000,
      durationSeconds: 600,
    });
  });
});
