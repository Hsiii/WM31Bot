import { expect, test } from "bun:test";

import {
  nextVoiceFillerDelay,
  selectVoiceFiller,
  VoiceSentenceBuffer,
  VOICE_FILLERS,
} from "./voice-chat";

test("spaces random voice fillers without immediate repeats", () => {
  expect(nextVoiceFillerDelay(() => 0)).toBe(2_500);
  expect(nextVoiceFillerDelay(() => 0.999_999)).toBe(4_000);

  const first = selectVoiceFiller(undefined, () => 0);
  const second = selectVoiceFiller(first, () => 0);

  expect(VOICE_FILLERS).toContain(first);
  expect(VOICE_FILLERS).toContain(second);
  expect(second).not.toBe(first);
});

test("emits complete spoken sentences as reply text arrives", () => {
  const sentences: string[] = [];
  const buffer = new VoiceSentenceBuffer((sentence) =>
    sentences.push(sentence),
  );

  buffer.push("最初の");
  buffer.push("文。次の文！残り");
  expect(sentences).toEqual(["最初の文。", "次の文！"]);

  buffer.push("だよ");
  buffer.flush();
  expect(sentences).toEqual(["最初の文。", "次の文！", "残りだよ"]);
});

test("removes response-only markers before speech", () => {
  const sentences: string[] = [];
  const buffer = new VoiceSentenceBuffer((sentence) =>
    sentences.push(sentence),
  );

  buffer.push("<self-introduction>MiniSago</self-introduction>だよ。\n");
  expect(sentences).toEqual(["MiniSagoだよ。"]);
});
