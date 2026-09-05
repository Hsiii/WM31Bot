import { EventEmitter } from "node:events";
import { expect, test } from "bun:test";
import { AudioPlayerStatus, type AudioPlayer } from "@discordjs/voice";
import { VoiceOutput } from "./voice-output";

function setup() {
  const player = Object.assign(new EventEmitter(), {
    plays: 0,
    pauses: 0,
    resumes: 0,
    play() {
      this.plays++;
    },
    pause() {
      this.pauses++;
    },
    unpause() {
      this.resumes++;
    },
    stop() {
      player.emit(AudioPlayerStatus.Idle);
    },
  });
  return { player, output: new VoiceOutput(player as unknown as AudioPlayer) };
}

test("holds ready replies through speech and drains only after playback", async () => {
  const { player, output } = setup();
  output.pause();
  output.write(Buffer.alloc(3840), "reply");
  output.write(Buffer.alloc(3840), "reply");
  let drained = false;
  const pending = output.drain().then(() => {
    drained = true;
  });
  expect(player.plays).toBe(0);
  output.resume();
  expect(player.plays).toBe(1);
  output.pause();
  output.resume();
  expect(player.plays).toBe(1);
  player.emit(AudioPlayerStatus.Idle);
  expect(player.plays).toBe(2);
  expect(drained).toBe(false);
  player.emit(AudioPlayerStatus.Idle);
  await pending;
  expect(drained).toBe(true);
});

test("drops interrupted fillers instead of replaying them after a gap", async () => {
  const { player, output } = setup();
  output.write(Buffer.alloc(3840), "feedback");
  output.write(Buffer.alloc(3840), "feedback");
  output.pause();
  output.write(Buffer.alloc(3840), "feedback");
  output.resume();
  expect(player.plays).toBe(1);
  await output.drain();
});

test("clear releases a paused answer and its drain waiter", async () => {
  const { player, output } = setup();
  output.pause();
  output.write(Buffer.alloc(3840), "reply");
  const pending = output.drain();
  output.clear();
  await pending;
  output.resume();
  expect(player.plays).toBe(0);
});

test("a ready answer cuts off thinking feedback immediately", () => {
  const { player, output } = setup();
  output.write(Buffer.alloc(3840), "feedback");
  expect(player.plays).toBe(1);
  output.write(Buffer.alloc(3840), "reply");
  expect(player.plays).toBe(2);
  output.clear();
});

test("records only started clips, distinguishing interrupted from finished playback", () => {
  const { player, output } = setup();
  const heard: string[] = [];
  output.write(Buffer.alloc(3840), "reply", {
    finished: (interrupted) => heard.push(`first:${interrupted}`),
  });
  player.emit(AudioPlayerStatus.Playing);
  player.emit(AudioPlayerStatus.Idle);
  output.write(Buffer.alloc(3840), "reply", {
    finished: (interrupted) => heard.push(`second:${interrupted}`),
  });
  player.emit(AudioPlayerStatus.Playing);
  output.write(Buffer.alloc(3840), "reply", {
    finished: (interrupted) => heard.push(`unheard:${interrupted}`),
  });
  output.clear();
  expect(heard).toEqual(["first:false", "second:true"]);
});

test("clearing a buffering clip does not claim it was heard", () => {
  const { output } = setup();
  let heard = false;
  output.write(Buffer.alloc(3840), "reply", {
    finished: () => {
      heard = true;
    },
  });
  output.clear();
  expect(heard).toBe(false);
});
