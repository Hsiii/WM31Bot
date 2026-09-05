import { describe, expect, test } from "bun:test";

import {
  discordPcmToSpeechPcm,
  discordPcmToVadPcm,
  pcmToVadSamples,
} from "./voice-chat";

describe("voice PCM conversion", () => {
  test("downsamples Discord stereo PCM for speech recognition", () => {
    const input = Buffer.alloc(16);
    input.writeInt16LE(1_000, 0);
    input.writeInt16LE(3_000, 2);
    input.writeInt16LE(5_000, 4);
    input.writeInt16LE(7_000, 6);
    input.writeInt16LE(-4_000, 8);
    input.writeInt16LE(2_000, 10);
    input.writeInt16LE(8_000, 12);
    input.writeInt16LE(10_000, 14);

    const output = discordPcmToSpeechPcm(input);

    expect([...new Int16Array(output.buffer, output.byteOffset, 2)]).toEqual([
      2_000, -1_000,
    ]);
  });
});

test("preserves the Discord sample rate for voice detection", () => {
  const input = Buffer.alloc(8);
  input.writeInt16LE(1_000, 0);
  input.writeInt16LE(3_000, 2);
  input.writeInt16LE(-4_000, 4);
  input.writeInt16LE(2_000, 6);

  const output = discordPcmToVadPcm(input);

  expect([...new Int16Array(output.buffer, output.byteOffset, 2)]).toEqual([
    2_000, -1_000,
  ]);
});

test("copies VAD samples into an exact frame buffer", () => {
  const pooled = Buffer.allocUnsafe(1_920);
  pooled.fill(0);

  const samples = pcmToVadSamples(pooled);

  expect(samples).toHaveLength(960);
  expect(samples.buffer.byteLength).toBe(1_920);
});
