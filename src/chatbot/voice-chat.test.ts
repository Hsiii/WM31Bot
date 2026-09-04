import { expect, test } from "bun:test";

import { VoiceSentenceBuffer } from "./voice-chat";

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
