import { expect, test } from "bun:test";

import {
  startThinkingFeedback,
  THINKING_GAP_MS,
  VoiceSentenceBuffer,
} from "./voice-chat";

test("thinking feedback is delayed and plays only once", async () => {
  expect(THINKING_GAP_MS).toBe(2_000);
  let plays = 0;
  const stop = startThinkingFeedback({
    getAudio: async () => Buffer.alloc(1),
    play: () => {
      plays++;
    },
    isCurrent: () => true,
    gapMs: 20,
  });
  expect(plays).toBe(0);
  await Bun.sleep(30);
  expect(plays).toBe(1);
  await Bun.sleep(30);
  expect(plays).toBe(1);
  stop();
});

test("a fast answer suppresses thinking feedback entirely", async () => {
  let calls = 0;
  const stop = startThinkingFeedback({
    getAudio: async () => {
      calls++;
      return Buffer.alloc(1);
    },
    play: () => {
      calls++;
    },
    isCurrent: () => true,
    gapMs: 10,
  });
  stop();
  await Bun.sleep(20);
  expect(calls).toBe(0);
});

test("answer readiness suppresses feedback still being synthesized", async () => {
  let resolve!: (audio: Buffer) => void;
  let plays = 0;
  const stop = startThinkingFeedback({
    getAudio: () =>
      new Promise<Buffer>((done) => {
        resolve = done;
      }),
    play: () => {
      plays++;
    },
    isCurrent: () => true,
    gapMs: 0,
  });
  await Bun.sleep(5);
  stop();
  resolve(Buffer.alloc(1));
  await Bun.sleep(0);
  expect(plays).toBe(0);
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

test("voice cancellation reaches the dispatched worker and waits for acknowledgement", async () => {
  const { spyOn } = await import("bun:test");
  const { macAgentBridge } = await import("./bridge");
  const { respondToVoiceChat } = await import("./voice-chat");
  let resolve!: (value: {
    ok: false;
    error: string;
    failureKind: "internal";
    stopped: true;
  }) => void;
  let cancels = 0,
    settled = false;
  const dispatch = spyOn(macAgentBridge, "dispatch").mockImplementation(() => ({
    status: "accepted",
    cancel: () => {
      cancels++;
      return true;
    },
    result: new Promise((done) => {
      resolve = done;
    }),
  }));
  const controller = new AbortController();
  try {
    const response = respondToVoiceChat({
      guildId: "guild",
      channelId: "voice",
      userId: "alice",
      transcript: "Sago, hello",
      history: [],
      signal: controller.signal,
      isCurrent: () => !controller.signal.aborted,
      onAudio: () => {
        throw new Error("Cancelled turn must not speak");
      },
    }).then((result) => {
      settled = true;
      return result;
    });
    controller.abort();
    await Bun.sleep(0);
    expect(cancels).toBe(1);
    expect(settled).toBe(false);
    resolve({
      ok: false,
      error: "cancelled",
      failureKind: "internal",
      stopped: true,
    });
    expect(await response).toBeNull();
  } finally {
    dispatch.mockRestore();
  }
});
