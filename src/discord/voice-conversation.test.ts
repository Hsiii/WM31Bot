import { expect, test, spyOn } from "bun:test";
import {
  VoiceConversation,
  voiceInterruptionIntent,
  type VoiceReplyInput,
  type VoiceChatResponse,
  type VoicePlayback,
} from "./voice-conversation";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function setup(
  options: {
    transcribe?: (audio: Buffer, signal?: AbortSignal) => Promise<string>;
    timeout?: number;
    acknowledgeCancel?: boolean;
  } = {},
) {
  const requests: {
    input: VoiceReplyInput;
    result: ReturnType<typeof deferred<VoiceChatResponse | null>>;
  }[] = [];
  const audio: string[] = [];
  const clips: VoicePlayback[] = [];
  let paused = false,
    clears = 0;
  const conversation = new VoiceConversation({
    gapMs: 0,
    transcriptionTimeoutMs: options.timeout,
    transcribe: options.transcribe ?? (async (buffer) => buffer.toString()),
    respond: (input) => {
      const result = deferred<VoiceChatResponse | null>();
      requests.push({ input, result });
      if (options.acknowledgeCancel !== false)
        input.signal.addEventListener("abort", () => result.resolve(null), {
          once: true,
        });
      return result.promise;
    },
    output: {
      pause: () => {
        paused = true;
      },
      resume: () => {
        paused = false;
      },
      clear: () => {
        clears++;
        for (const clip of clips.splice(0)) clip.finished(true);
      },
      write: (buffer, _kind, playback) => {
        audio.push(buffer.toString());
        if (playback) clips.push(playback);
      },
      drain: async () => {},
    },
  });
  return {
    conversation,
    requests,
    audio,
    clips,
    get paused() {
      return paused;
    },
    get clears() {
      return clears;
    },
  };
}
const tick = () => Bun.sleep(5);
async function say(
  state: ReturnType<typeof setup>,
  user: string,
  text: string,
) {
  await state.conversation.utterance(user, Buffer.from(text));
  await tick();
}

test("answers idle speech without requiring a recognized name", async () => {
  const s = setup();
  await say(s, "alice", "你聽得到嗎？");
  expect(s.requests.map((r) => r.input.transcript)).toEqual(["你聽得到嗎？"]);
  s.requests[0]!.result.resolve(null);
  await tick();
  await say(s, "bob", "Hello, can you hear us?");
  expect(s.requests).toHaveLength(2);
  s.conversation.destroy();
});

test("idle listening does not expire after an earlier answer", async () => {
  const clock = spyOn(Date, "now").mockReturnValue(0);
  const s = setup();
  try {
    await say(s, "alice", "hello");
    s.requests[0]!.result.resolve(null);
    await tick();
    clock.mockReturnValue(60_000);
    await say(s, "alice", "another question");
    expect(s.requests).toHaveLength(2);
  } finally {
    clock.mockRestore();
    s.conversation.destroy();
  }
});

test("correction cancels immediately but waits for worker acknowledgement before replacement", async () => {
  const s = setup({ acknowledgeCancel: false });
  await say(s, "alice", "Sago, cats");
  await say(s, "alice", "Actually, dogs");
  expect(s.requests[0]!.input.signal.aborted).toBe(true);
  expect(s.requests[0]!.input.isCurrent()).toBe(false);
  expect(s.requests).toHaveLength(1);
  await say(s, "alice", "Actually, birds");
  s.requests[0]!.result.resolve(null);
  await tick();
  expect(s.requests.map((r) => r.input.transcript)).toEqual([
    "Sago, cats",
    "Actually, birds",
  ]);
  s.requests[0]!.input.onAudio(Buffer.from("stale"));
  expect(s.audio).toEqual([]);
  s.conversation.destroy();
  s.requests[1]!.result.resolve(null);
});

test("playback stays paused until delayed stop transcription is resolved", async () => {
  const stop = deferred<string>();
  const s = setup({
    transcribe: async (audio) =>
      audio.toString() === "stop" ? stop.promise : audio.toString(),
  });
  await say(s, "alice", "Sago, story");
  s.conversation.speechStarted("alice");
  const pending = s.conversation.utterance("alice", Buffer.from("stop"));
  s.conversation.speechEnded("alice");
  await tick();
  expect(s.paused).toBe(true);
  expect(s.clears).toBe(0);
  stop.resolve("stop");
  await pending;
  await tick();
  expect(s.clears).toBe(1);
  expect(s.requests[0]!.input.signal.aborted).toBe(true);
  expect(s.requests).toHaveLength(1);
  s.conversation.destroy();
});

test("recognition timeout resumes playback and ignores a late result", async () => {
  const late = deferred<string>();
  const s = setup({
    timeout: 5,
    transcribe: async (audio) =>
      audio.toString() === "late" ? late.promise : audio.toString(),
  });
  await say(s, "alice", "Sago, story");
  s.conversation.speechStarted("alice");
  const pending = s.conversation.utterance("alice", Buffer.from("late"));
  s.conversation.speechEnded("alice");
  await pending;
  await tick();
  expect(s.paused).toBe(false);
  late.resolve("stop");
  await tick();
  expect(s.requests[0]!.input.signal.aborted).toBe(false);
  s.conversation.destroy();
});

test("side chatter preserves the answer and waits for all speakers", async () => {
  const s = setup();
  await say(s, "alice", "Sago, story");
  s.conversation.speechStarted("bob");
  s.conversation.speechStarted("carol");
  await say(s, "bob", "Did you see that?");
  s.requests[0]!.input.onAudio(Buffer.from("filler"), "feedback");
  expect(s.audio).toEqual([]);
  s.conversation.speechEnded("bob");
  await tick();
  expect(s.paused).toBe(true);
  s.conversation.speechEnded("carol");
  await tick();
  expect(s.paused).toBe(false);
  expect(s.requests).toHaveLength(1);
  expect(s.clears).toBe(0);
  s.conversation.destroy();
});

test("chatter captured during an answer stays chatter after that answer finishes", async () => {
  const late = deferred<string>();
  const s = setup({
    transcribe: async (audio) =>
      audio.toString() === "late" ? late.promise : audio.toString(),
  });
  await say(s, "alice", "Sago, hello");
  const pending = s.conversation.utterance("bob", Buffer.from("late"));
  s.requests[0]!.result.resolve(null);
  await tick();
  late.resolve("some unrelated chat");
  await pending;
  expect(s.requests).toHaveLength(1);
  s.conversation.destroy();
});

test("history contains played sentences and marks interrupted audio, not unheard generated replies", async () => {
  const s = setup();
  await say(s, "alice", "Sago, cats");
  s.requests[0]!.input.onAudio(Buffer.from("one"), "reply", "First sentence.");
  s.clips.shift()!.finished(false);
  s.requests[0]!.input.onAudio(Buffer.from("two"), "reply", "Second sentence.");
  await say(s, "alice", "Actually, dogs");
  const history = s.requests[1]!.input.history;
  expect(history[1]?.content).toBe("First sentence.");
  expect(history[2]?.content).toContain("Playback interrupted");
  expect(history[2]?.content).toContain("Second sentence.");
  s.conversation.destroy();
});

test("closing cancels transcription and cannot start a late answer", async () => {
  const late = deferred<string>();
  let signal: AbortSignal | undefined;
  const s = setup({
    transcribe: async (_audio, value) => {
      signal = value;
      return late.promise;
    },
  });
  const pending = s.conversation.utterance("alice", Buffer.from("question"));
  s.conversation.destroy();
  await pending;
  expect(signal?.aborted).toBe(true);
  late.resolve("Sago, hello");
  await tick();
  expect(s.requests).toHaveLength(0);
});

test("bounds queued audio and drops expired pending utterances", async () => {
  const first = deferred<string>();
  const transcribed: string[] = [];
  const clock = spyOn(Date, "now").mockReturnValue(0);
  const s = setup({
    transcribe: async (audio) => {
      transcribed.push(audio.toString());
      return transcribed.length === 1 ? first.promise : "";
    },
  });
  try {
    const running = s.conversation.utterance("alice", Buffer.from("running"));
    const dropped = s.conversation.utterance("bob", Buffer.from("oldest"));
    const expired = s.conversation.utterance("bob", Buffer.from("expired"));
    clock.mockReturnValue(16_000);
    const recent = s.conversation.utterance("bob", Buffer.from("recent"));
    const newest = s.conversation.utterance("alice", Buffer.from("newest"));
    await dropped;
    first.resolve("");
    await Promise.all([running, expired, recent, newest]);
    expect(transcribed).toEqual(["running", "recent", "newest"]);
  } finally {
    s.conversation.destroy();
    clock.mockRestore();
  }
});

test("only addressing or the current speaker's correction replaces a turn", () => {
  expect(voiceInterruptionIntent("Sago, what about tomorrow?", false)).toBe(
    "replace",
  );
  expect(voiceInterruptionIntent("さご、明日は？", false)).toBe("replace");
  expect(voiceInterruptionIntent("待って、明日だった", true)).toBe("replace");
  expect(voiceInterruptionIntent("待って、明日だった", false)).toBe("keep");
  expect(voiceInterruptionIntent("stop", true)).toBe("stop");
  expect(voiceInterruptionIntent("stop", false)).toBe("keep");
  expect(voiceInterruptionIntent("Hey Sago, stop", false)).toBe("stop");
  expect(voiceInterruptionIntent("I was talking about Sago", false)).toBe(
    "keep",
  );
});

test("a generated answer remains current until playback finishes and can still be stopped", async () => {
  const playback = deferred<void>();
  let current: VoiceReplyInput | undefined;
  const conversation = new VoiceConversation({
    transcribe: async (audio) => audio.toString(),
    respond: async (input) => {
      current = input;
      input.onAudio(Buffer.from("answer"), "reply", "Answer.");
      return { transcript: input.transcript, reply: "Answer." };
    },
    output: {
      pause() {},
      resume() {},
      write() {},
      clear() {
        playback.resolve();
      },
      drain: () => playback.promise,
    },
  });
  await conversation.utterance("alice", Buffer.from("Sago, question"));
  await tick();
  expect(current?.isCurrent()).toBe(true);
  await conversation.utterance("alice", Buffer.from("stop"));
  await tick();
  expect(current?.signal.aborted).toBe(true);
  expect(current?.isCurrent()).toBe(false);
  conversation.destroy();
});
