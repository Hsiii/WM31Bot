import { expect, test } from "bun:test";

import { VoiceActivityGate } from "./voice-activity";

function frame(value: number) {
  return Buffer.alloc(960, value);
}

test("ignores noise without interrupting or creating an utterance", () => {
  let starts = 0;
  const utterances: Buffer[] = [];
  const gate = new VoiceActivityGate({
    maxUtteranceBytes: 100_000,
    onSpeechStart: () => {
      starts += 1;
    },
    onUtterance: (audio) => utterances.push(audio),
  });

  for (let index = 0; index < 100; index += 1) {
    gate.push(frame(index), false);
  }
  gate.flush();

  expect(starts).toBe(0);
  expect(utterances).toEqual([]);
});

test("confirms sustained speech and ends on detected silence", () => {
  let starts = 0;
  const utterances: Buffer[] = [];
  const gate = new VoiceActivityGate({
    maxUtteranceBytes: 100_000,
    onSpeechStart: () => {
      starts += 1;
    },
    onUtterance: (audio) => utterances.push(audio),
  });

  for (let index = 0; index < 5; index += 1) gate.push(frame(1), false);
  for (let index = 0; index < 20; index += 1) gate.push(frame(2), true);
  for (let index = 0; index < 35; index += 1) gate.push(frame(3), false);

  expect(starts).toBe(1);
  expect(utterances).toHaveLength(1);
  expect(utterances[0]?.length).toBe((5 + 20 + 10) * 960);
});

test("drops a segment without enough voiced audio", () => {
  let ends = 0;
  const utterances: Buffer[] = [];
  const gate = new VoiceActivityGate({
    maxUtteranceBytes: 100_000,
    onSpeechStart: () => undefined,
    onSpeechEnd: () => {
      ends++;
    },
    onUtterance: (audio) => utterances.push(audio),
  });

  for (let index = 0; index < 4; index += 1) gate.push(frame(1), true);
  for (let index = 0; index < 35; index += 1) gate.push(frame(0), false);

  expect(utterances).toEqual([]);
  expect(ends).toBe(0);
  gate.flush();
  expect(ends).toBe(0);
});

test("preserves a 240 ms command for recognition", () => {
  let starts = 0;
  const utterances: Buffer[] = [];
  const gate = new VoiceActivityGate({
    maxUtteranceBytes: 100_000,
    onSpeechStart: () => {
      starts++;
    },
    onUtterance: (audio) => utterances.push(audio),
  });
  for (let i = 0; i < 12; i++) gate.push(frame(1), true);
  gate.flush();
  expect(starts).toBe(1);
  expect(utterances).toHaveLength(1);
});
