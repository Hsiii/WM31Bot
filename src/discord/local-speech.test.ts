import { expect, test } from "bun:test";

import { ttsVoiceFor } from "./local-speech";

test("chooses a local voice from the reply language", () => {
  expect(ttsVoiceFor("來聊天吧")).toBe("cmn+f3");
  expect(ttsVoiceFor("Come chat with us")).toBe("en-us+f3");
});
