import { expect, test } from "bun:test";

import {
  SpeechCache,
  VOICEVOX_SPEAKER_ID,
  voicevoxAudioQueryUrl,
  whisperInferenceUrl,
} from "./local-speech";

test("caches reusable voice feedback", async () => {
  let calls = 0;
  const cache = new SpeechCache(async (text) => {
    calls += 1;
    return Buffer.from(text);
  });

  const first = await cache.get("うん");
  const second = await cache.get("うん");

  expect(first.toString()).toBe("うん");
  expect(second).toBe(first);
  expect(calls).toBe(1);
});

test("prewarms voice feedback in order", async () => {
  const calls: string[] = [];
  const cache = new SpeechCache(async (text) => {
    calls.push(text);
    return Buffer.from(text);
  });

  await cache.prewarm(["聞いてるよ", "待ってね"]);

  expect(calls).toEqual(["聞いてるよ", "待ってね"]);
});

test("requests Nekotsuka Bi's normal VOICEVOX style", () => {
  expect(VOICEVOX_SPEAKER_ID).toBe(58);
  expect(
    voicevoxAudioQueryUrl("一緒に話そう", "http://voicevox:50021").href,
  ).toBe(
    "http://voicevox:50021/audio_query?text=%E4%B8%80%E7%B7%92%E3%81%AB%E8%A9%B1%E3%81%9D%E3%81%86&speaker=58",
  );
});

test("uses the persistent Whisper inference endpoint", () => {
  expect(whisperInferenceUrl("http://whisper:8080/").href).toBe(
    "http://whisper:8080/inference",
  );
});

test("cancels an in-flight synthesis request", async () => {
  const { spyOn } = await import("bun:test");
  const { synthesizeSpeech } = await import("./local-speech");
  const controller = new AbortController();
  let requestSignal: AbortSignal | undefined;
  const request = spyOn(globalThis, "fetch").mockImplementation(
    Object.assign(
      (_url: RequestInfo | URL, options?: RequestInit) => {
        requestSignal = options?.signal as AbortSignal;
        return new Promise<Response>((_resolve, reject) => {
          requestSignal!.addEventListener(
            "abort",
            () => reject(requestSignal!.reason),
            { once: true },
          );
        });
      },
      { preconnect: fetch.preconnect },
    ),
  );
  try {
    const speech = synthesizeSpeech("こんにちは", {
      signal: controller.signal,
    });
    controller.abort();
    await expect(speech).rejects.toThrow();
    expect(requestSignal?.aborted).toBe(true);
    expect(request).toHaveBeenCalledTimes(1);
  } finally {
    request.mockRestore();
  }
});
