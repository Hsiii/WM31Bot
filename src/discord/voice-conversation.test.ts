import { expect, test, spyOn } from "bun:test";
import {
  VoiceConversation,
  voiceInterruptionIntent,
  type VoiceReplyInput,
  type VoiceChatResponse,
} from "./voice-conversation";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function setup() {
  const requests: {
    input: VoiceReplyInput;
    result: ReturnType<typeof deferred<VoiceChatResponse | null>>;
  }[] = [];
  const audio: string[] = [];
  let paused = false;
  let clears = 0;
  const conversation = new VoiceConversation({
    gapMs: 5,
    transcribe: async (buffer) => buffer.toString(),
    respond: (input) => {
      const result = deferred<VoiceChatResponse | null>();
      requests.push({ input, result });
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
      },
      write: (buffer) => {
        audio.push(buffer.toString());
      },
      drain: async () => {},
    },
  });
  return {
    conversation,
    requests,
    audio,
    get paused() {
      return paused;
    },
    get clears() {
      return clears;
    },
  };
}

test("accepts successive corrections in capture order", async () => {
  const { conversation, requests } = setup();
  await conversation.utterance("alice", Buffer.from("Tell me about cats"));
  await Promise.all([
    conversation.utterance("alice", Buffer.from("Actually, dogs")),
    conversation.utterance("alice", Buffer.from("Actually, birds")),
  ]);
  expect(requests.map(({ input }) => input.transcript)).toEqual([
    "Tell me about cats",
    "Actually, dogs",
    "Actually, birds",
  ]);
  expect(requests.map(({ input }) => input.isCurrent())).toEqual([
    false,
    false,
    true,
  ]);
  conversation.destroy();
  for (const request of requests) request.result.resolve(null);
});

test("bounds queued audio and drops expired pending utterances", async () => {
  const first = deferred<string>();
  const transcribed: string[] = [];
  const clock = spyOn(Date, "now").mockReturnValue(0);
  const conversation = new VoiceConversation({
    transcribe: async (audio) => {
      transcribed.push(audio.toString());
      return transcribed.length === 1 ? first.promise : "";
    },
    respond: async () => null,
    output: {
      pause() {},
      resume() {},
      clear() {},
      write() {},
      drain: async () => {},
    },
  });
  try {
    const running = conversation.utterance("alice", Buffer.from("running"));
    const dropped = conversation.utterance("bob", Buffer.from("oldest"));
    const expired = conversation.utterance("bob", Buffer.from("expired"));
    clock.mockReturnValue(16_000);
    const recent = conversation.utterance("bob", Buffer.from("recent"));
    const newest = conversation.utterance("alice", Buffer.from("newest"));
    await dropped;
    expect(transcribed).toEqual(["running"]);
    first.resolve("");
    await Promise.all([running, expired, recent, newest]);
    expect(transcribed).toEqual(["running", "recent", "newest"]);
  } finally {
    conversation.destroy();
    clock.mockRestore();
  }
});

test("chatter pauses output without restarting work; all speakers must finish", async () => {
  const state = setup();
  const { conversation, requests, audio } = state;
  await conversation.utterance("alice", Buffer.from("Tell me a story"));
  conversation.speechStarted("bob");
  conversation.speechStarted("carol");
  await conversation.utterance("bob", Buffer.from("Did you see that?"));
  requests[0]!.input.onAudio(Buffer.from("filler"), "feedback");
  requests[0]!.input.onAudio(Buffer.from("answer"));
  expect(audio).toEqual(["answer"]);
  expect(requests).toHaveLength(1);
  expect(requests[0]!.input.isCurrent()).toBe(true);
  expect(state.clears).toBe(0);
  conversation.speechEnded("bob");
  await Bun.sleep(10);
  expect(state.paused).toBe(true);
  conversation.speechEnded("carol");
  await Bun.sleep(10);
  expect(state.paused).toBe(false);
  conversation.destroy();
  requests[0]!.result.resolve(null);
});

test("an explicit correction replaces output and excludes stale replies from history", async () => {
  const state = setup();
  const { conversation, requests } = state;
  await conversation.utterance("alice", Buffer.from("Tell me about cats"));
  await conversation.utterance("alice", Buffer.from("Actually, I meant dogs"));
  expect(requests).toHaveLength(2);
  expect(state.clears).toBe(1);
  expect(requests[0]!.input.isCurrent()).toBe(false);
  requests[0]!.input.onAudio(Buffer.from("stale answer"));
  requests[0]!.result.resolve({ transcript: "cats", reply: "stale" });
  requests[1]!.result.resolve({ transcript: "dogs", reply: "dogs answer" });
  await Bun.sleep(0);
  await conversation.utterance("alice", Buffer.from("Thank you"));
  expect(requests[2]!.input.history.map((turn) => turn.content)).toEqual([
    "Tell me about cats",
    "Actually, I meant dogs",
    "dogs answer",
  ]);
  expect(state.audio).toEqual([]);
  conversation.destroy();
  requests[2]!.result.resolve(null);
});

test("chatter captured during playback stays chatter even if transcription is delayed", async () => {
  const transcript = deferred<string>();
  const answer = deferred<VoiceChatResponse | null>();
  let calls = 0;
  let transcriptions = 0;
  const conversation = new VoiceConversation({
    transcribe: async () =>
      ++transcriptions === 1 ? "question" : transcript.promise,
    respond: async () => {
      calls++;
      return answer.promise;
    },
    output: {
      pause() {},
      resume() {},
      clear() {},
      write() {},
      drain: async () => {},
    },
  });
  await conversation.utterance("alice", Buffer.from("first"));
  const pending = conversation.utterance("bob", Buffer.from("second"));
  answer.resolve({ transcript: "question", reply: "answer" });
  await Bun.sleep(0);
  transcript.resolve("some unrelated chat");
  await pending;
  expect(calls).toBe(1);
  conversation.destroy();
});

test("only explicit addressing or the current speaker's correction replaces a turn", () => {
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
  expect(voiceInterruptionIntent("that's funny", true)).toBe("keep");
});

test("closing while transcription is pending cannot start another answer", async () => {
  const transcript = deferred<string>();
  let calls = 0;
  const conversation = new VoiceConversation({
    transcribe: () => transcript.promise,
    respond: async () => {
      calls++;
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
  const pending = conversation.utterance("alice", Buffer.from("question"));
  await Bun.sleep(0);
  conversation.destroy();
  transcript.resolve("hello");
  await pending;
  expect(calls).toBe(0);
});

test("a finished answer stays current while waiting to be heard", async () => {
  const playback = deferred<void>();
  let calls = 0;
  let current: (() => boolean) | undefined;
  const conversation = new VoiceConversation({
    transcribe: async (audio) => audio.toString(),
    respond: async (input) => {
      calls++;
      current = input.isCurrent;
      input.onAudio(Buffer.from("ready answer"));
      return { transcript: input.transcript, reply: "ready answer" };
    },
    output: {
      pause() {},
      resume() {},
      clear() {},
      write() {},
      drain: () => playback.promise,
    },
  });
  await conversation.utterance("alice", Buffer.from("question"));
  conversation.speechStarted("bob");
  await conversation.utterance("bob", Buffer.from("unrelated chat"));
  expect(current?.()).toBe(true);
  expect(calls).toBe(1);
  await conversation.utterance("alice", Buffer.from("stop"));
  expect(current?.()).toBe(false);
  expect(calls).toBe(1);
  playback.resolve();
  conversation.destroy();
});
