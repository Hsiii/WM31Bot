import { expect, test } from "bun:test";

import { VOICEVOX_SPEAKER_ID, voicevoxAudioQueryUrl } from "./local-speech";

test("requests Nekotsuka Bi's normal VOICEVOX style", () => {
  expect(VOICEVOX_SPEAKER_ID).toBe(58);
  expect(
    voicevoxAudioQueryUrl("一緒に話そう", "http://voicevox:50021").href,
  ).toBe(
    "http://voicevox:50021/audio_query?text=%E4%B8%80%E7%B7%92%E3%81%AB%E8%A9%B1%E3%81%9D%E3%81%86&speaker=58",
  );
});
