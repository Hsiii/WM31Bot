import { expect, test, spyOn } from "bun:test";
import { VoiceDebugState, DEFAULT_VOICE_SETTINGS } from "./state";
import { createVoiceDebugHandler } from "./http";
import { VoiceConversation } from "../voice-conversation";
import { VoiceActivityGate } from "../voice-activity";
const secret = "voice-diagnostics-test-token-long-enough";
function setup() {
  const state = new VoiceDebugState(() => true);
  return { state, handle: createVoiceDebugHandler(state, () => secret) };
}
function request(
  path: string,
  method = "GET",
  body?: unknown,
  cookie?: string,
  origin = "http://localhost",
) {
  return new Request("http://localhost/api/voice-debug/" + path, {
    method,
    headers: {
      ...(method !== "GET" ? { origin } : {}),
      ...(cookie ? { cookie } : {}),
      "Content-Type": "application/json",
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
}
async function login(handle: ReturnType<typeof createVoiceDebugHandler>) {
  const response = await handle(request("login", "POST", { token: secret }));
  expect(response.status).toBe(200);
  return response.headers.get("set-cookie")!.split(";")[0]!;
}

test("live transcripts and settings require authentication; origin checks protect mutations", async () => {
  const { state, handle } = setup();
  const session = state.session("guild", "voice");
  session.trace("whisper.finish", {
    turnId: "turn",
    text: "private transcript",
  });
  expect((await handle(request("snapshot"))).status).toBe(401);
  expect(
    (
      await handle(
        request("settings", "PATCH", {
          revision: 0,
          settings: DEFAULT_VOICE_SETTINGS,
        }),
      )
    ).status,
  ).toBe(401);
  const cookie = await login(handle);
  const snapshot = await (
    await handle(request("snapshot", "GET", undefined, cookie))
  ).json();
  expect(snapshot.events.at(-1).text).toBe("private transcript");
  expect(
    (
      await handle(
        request("clear", "POST", undefined, cookie, "https://evil.example"),
      )
    ).status,
  ).toBe(403);
  expect(
    (await handle(request("login", "POST", { token: "wrong" }))).status,
  ).toBe(401);
  expect(
    (await handle(request("logout", "POST", undefined, cookie))).status,
  ).toBe(200);
  expect(
    (await handle(request("snapshot", "GET", undefined, cookie))).status,
  ).toBe(401);
});

test("settings are validated, versioned and applied to the live state", async () => {
  const { state, handle } = setup();
  const cookie = await login(handle);
  const update = {
    ...DEFAULT_VOICE_SETTINGS,
    silenceMs: 400,
    feedbackEnabled: false,
  };
  expect(
    (
      await handle(
        request("settings", "PATCH", { revision: 0, settings: update }, cookie),
      )
    ).status,
  ).toBe(200);
  expect(state.getSettings()).toEqual(update);
  expect(
    (
      await handle(
        request("settings", "PATCH", { revision: 0, settings: update }, cookie),
      )
    ).status,
  ).toBe(409);
  expect(
    (
      await handle(
        request(
          "settings",
          "PATCH",
          { revision: 1, settings: { ...update, silenceMs: 10 } },
          cookie,
        ),
      )
    ).status,
  ).toBe(400);
  expect(state.getSettings()).toEqual(update);
});

test("authenticated stop targets only an active session", async () => {
  const { state, handle } = setup();
  const cookie = await login(handle);
  const session = state.session("guild", "voice");
  let stops = 0;
  session.setStop(() => {
    stops++;
  });
  expect(
    (
      await (
        await handle(request("stop", "POST", { sessionId: session.id }, cookie))
      ).json()
    ).ok,
  ).toBe(true);
  expect(stops).toBe(1);
  session.trace("session.close");
  expect(
    (
      await (
        await handle(request("stop", "POST", { sessionId: session.id }, cookie))
      ).json()
    ).ok,
  ).toBe(false);
});

test("events have a bounded lifetime and capacity; disabled capture stores no transcript", () => {
  const clock = spyOn(Date, "now").mockReturnValue(0);
  try {
    const state = new VoiceDebugState(() => true);
    const session = state.session("g", "c");
    for (let i = 0; i < 900; i++)
      session.trace("whisper.finish", { text: "hello", turnId: String(i) });
    expect(state.snapshot().events).toHaveLength(800);
    clock.mockReturnValue(31 * 60_000);
    expect(state.snapshot().events).toHaveLength(0);
    const disabled = new VoiceDebugState(() => false);
    disabled.session("g", "c").trace("whisper.finish", { text: "private" });
    expect(disabled.snapshot().events).toEqual([]);
  } finally {
    clock.mockRestore();
  }
});

test("real conversation emits a linked transcript, decision and generated turn", async () => {
  const state = new VoiceDebugState(() => true);
  const session = state.session("g", "c");
  const conversation = new VoiceConversation({
    trace: session.trace,
    getSettings: () => state.getSettings(),
    transcribe: async () => "你聽得到嗎？",
    respond: async (input) => {
      input.trace?.("codex.finish", {
        text: "聞こえてるよ。",
        durationMs: 500,
      });
      return null;
    },
    output: {
      pause() {},
      resume() {},
      clear() {},
      write() {},
      drain: async () => {},
    },
  });
  conversation.speechStarted("alice");
  await conversation.utterance("alice", Buffer.alloc(48000));
  conversation.speechEnded("alice");
  await Bun.sleep(5);
  const events = state.snapshot().events;
  const transcript = events.find((e) => e.type === "whisper.finish")!;
  expect(transcript.text).toBe("你聽得到嗎？");
  expect(events.find((e) => e.type === "decision")?.detail).toBe(
    "answer: idle conversation",
  );
  expect(events.find((e) => e.type === "codex.finish")?.turnId).toBe(
    transcript.turnId,
  );
  expect(events.some((e) => e.type === "turn.finish")).toBe(true);
  conversation.destroy();
});

test("tuned capture timing applies to the next utterance, not in-flight speech", () => {
  let settings = { speechStartMs: 100, silenceMs: 400 },
    utterances = 0;
  const gate = new VoiceActivityGate({
    maxUtteranceBytes: 100000,
    getTiming: () => settings,
    onSpeechStart() {},
    onUtterance() {
      utterances++;
    },
  });
  for (let i = 0; i < 6; i++) gate.push(Buffer.alloc(960), true);
  settings = { speechStartMs: 200, silenceMs: 1000 };
  for (let i = 0; i < 20; i++) gate.push(Buffer.alloc(960), false);
  expect(utterances).toBe(1);
  for (let i = 0; i < 10; i++) gate.push(Buffer.alloc(960), true);
  for (let i = 0; i < 20; i++) gate.push(Buffer.alloc(960), false);
  expect(utterances).toBe(1);
  for (let i = 0; i < 30; i++) gate.push(Buffer.alloc(960), false);
  expect(utterances).toBe(2);
});

test("streaming output survives cancellation without flooding the event buffer", () => {
  const state = new VoiceDebugState(() => true);
  const { trace } = state.session("guild", "voice");
  trace("utterance.queued", { turnId: "turn" });
  for (let i = 1; i <= 1000; i++)
    trace("codex.output", { turnId: "turn", text: `partial ${i}` });
  trace("turn.cancel", { turnId: "turn", detail: "interrupted" });
  const events = state.snapshot().events;
  expect(events.filter((event) => event.type === "codex.output")).toHaveLength(
    1,
  );
  expect(events.find((event) => event.type === "codex.output")?.text).toBe(
    "partial 1000",
  );
  expect(events.some((event) => event.type === "utterance.queued")).toBe(true);
  expect(events.at(-1)?.type).toBe("turn.cancel");
});

test("captured audio requires auth, has a WAV header, and is removed on clear", async () => {
  const { state, handle } = setup();
  const session = state.session("guild", "voice");
  session.trace("utterance.queued", { turnId: "turn", pcm: Buffer.alloc(480) });
  expect(state.snapshot().events.some((event) => "pcm" in event)).toBe(false);
  const path = `audio?session=${session.id}&turn=turn`;
  expect((await handle(request(path))).status).toBe(401);
  const cookie = await login(handle);
  const response = await handle(request(path, "GET", undefined, cookie));
  const wav = Buffer.from(await response.arrayBuffer());
  expect(wav.toString("ascii", 0, 4)).toBe("RIFF");
  expect(wav.readUInt32LE(24)).toBe(24000);
  expect(wav.length).toBe(524);
  state.clear();
  expect((await handle(request(path, "GET", undefined, cookie))).status).toBe(
    404,
  );
});

test("browser conversation keeps settings isolated and waits for actual playback", async () => {
  const { createBrowserSession } = await import("./browser-session");
  const browser = createBrowserSession({
    transcribe: async () => "hello",
    respond: async (input) => {
      input.onAudio(Buffer.alloc(1920), "reply", "こんにちは。");
      return { transcript: "hello", reply: "こんにちは。" };
    },
  });
  const discord = new VoiceDebugState(() => true);
  browser.state.updateSettings(
    { ...DEFAULT_VOICE_SETTINGS, speechSpeed: 1.2 },
    0,
  );
  expect(discord.getSettings().speechSpeed).toBe(1);
  browser.capture(Buffer.alloc(480));
  for (let i = 0; i < 20 && !browser.clip(); i++)
    await new Promise((resolve) => setTimeout(resolve, 1));
  const clip = browser.clip()!;
  expect(clip).toBeTruthy();
  expect(
    browser.state
      .snapshot()
      .events.some((event) => event.type === "audio.start"),
  ).toBe(false);
  browser.acknowledge(clip.id, "start");
  browser.acknowledge(clip.id, "end");
  expect(browser.clip()).toBeNull();
  expect(
    browser.state
      .snapshot()
      .events.find((event) => event.type === "audio.finish")?.detail,
  ).toBe("played");
  expect(discord.snapshot().sessions).toHaveLength(0);
  browser.close();
});
