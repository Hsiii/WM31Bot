import { describe, expect, test } from "bun:test";

import { discordPcmToSpeechPcm } from "./voice-chat";

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
