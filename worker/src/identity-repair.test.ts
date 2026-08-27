import { describe, expect, test } from "bun:test";

import { enforceFirstPersonAnswer } from "../../contracts/answer-contract";
import { identityRepairContext, mergeIdentityRepair } from "./identity-repair";

describe("identity repair", () => {
  test("isolates the candidate reply from the answer envelope", () => {
    expect(
      identityRepairContext(
        JSON.stringify({
          reply: "MiniSago handles reminders.",
          reaction: { emoji: "👀" },
          artifacts: ["media-1"],
        }),
      ),
    ).toContain(JSON.stringify({ reply: "MiniSago handles reminders." }));
  });

  test("merges only repaired text into the original answer", () => {
    expect(
      JSON.parse(
        mergeIdentityRepair(
          JSON.stringify({
            reply: "MiniSago handles reminders.",
            reaction: null,
            artifacts: ["media-1"],
          }),
          JSON.stringify({ reply: "I handle reminders." }),
        ),
      ),
    ).toEqual({
      reply: "I handle reminders.",
      reaction: null,
      artifacts: ["media-1"],
    });
  });

  test("keeps a self-introduction marked until the host strips it", () => {
    const content = JSON.stringify({
      reply:
        "<self-introduction>MiniSago</self-introduction> here, reporting in.",
      reaction: null,
    });
    const workerChecked = enforceFirstPersonAnswer(content, false);

    expect(workerChecked).toContain("<self-introduction>MiniSago");
    expect(JSON.parse(enforceFirstPersonAnswer(workerChecked!)!).reply).toBe(
      "MiniSago here, reporting in.",
    );
  });
});
