import { describe, expect, test } from "bun:test";

import { PROMPT_CASES, type PromptCase, type PromptCaseSource } from "./cases";
import { evaluatePromptCase, type PromptCaseOutput } from "./evaluate";

const validOutput: PromptCaseOutput = {
  reply: "完成了",
  reaction: null,
  artifacts: [],
  referenceResolution: [],
};

describe("prompt evaluation cases", () => {
  test("cover the stratified production sample without identifying members", () => {
    const sampled = PROMPT_CASES.filter(
      (
        testCase,
      ): testCase is PromptCase & {
        source: Extract<PromptCaseSource, { kind: "stratified-v42-sample" }>;
      } => testCase.source.kind === "stratified-v42-sample",
    );
    expect(new Set(PROMPT_CASES.map(({ id }) => id)).size).toBe(
      PROMPT_CASES.length,
    );
    expect(
      new Set(sampled.map(({ source }) => source.guild)).size,
    ).toBeGreaterThanOrEqual(3);
    expect(
      new Set(sampled.map(({ source }) => source.requester)).size,
    ).toBeGreaterThanOrEqual(6);
    expect(
      new Set(sampled.map(({ source }) => source.task)).size,
    ).toBeGreaterThanOrEqual(8);
    expect(
      sampled.every(
        ({ source, job }) =>
          /^requester-\d+$/u.test(source.requester) &&
          job.requesterUserId === "prompt-eval-requester",
      ),
    ).toBe(true);
  });

  test("reports missing tools, inline emoji, and attachment contract failures", () => {
    const testCase = PROMPT_CASES.find(
      ({ id }) => id === "generated-attachment",
    )!;
    const failures = evaluatePromptCase(testCase, {
      output: { ...validOutput, reply: "傳好了 🙂" },
      tools: [],
      exitCode: 0,
    });

    expect(failures).toContain("Missing tool call: run_python");
    expect(failures).toContain("Reply contains inline emoji");
    expect(failures).toContain("Missing artifact: media-edited.webp");
  });

  test("accepts a complete media result", () => {
    const testCase = PROMPT_CASES.find(
      ({ id }) => id === "generated-attachment",
    )!;
    expect(
      evaluatePromptCase(testCase, {
        output: {
          ...validOutput,
          reply: "調亮後的版本在這裡",
          artifacts: ["media-edited.webp"],
        },
        tools: ["run_python"],
        exitCode: 0,
      }),
    ).toEqual([]);
  });

  test("requires recoverable actions and concrete blockers", () => {
    const recoverable = PROMPT_CASES.find(
      ({ id }) => id === "recover-bounded-action",
    )!;
    const blocked = PROMPT_CASES.find(
      ({ id }) => id === "blocked-bounded-action",
    )!;

    expect(
      evaluatePromptCase(recoverable, {
        output: validOutput,
        tools: [],
        exitCode: 0,
      }),
    ).toContain("Missing tool call: create_reminder");
    expect(
      evaluatePromptCase(blocked, {
        output: { ...validOutput, reply: "抱歉 我剛剛沒做到" },
        tools: [],
        exitCode: 0,
      }).some((failure) =>
        failure.startsWith("Reply did not name required detail"),
      ),
    ).toBe(true);
  });

  test("requires a retry to recover lost intent before transforming media", () => {
    const retry = PROMPT_CASES.find(({ id }) => id === "recover-retry-intent")!;

    const failures = evaluatePromptCase(retry, {
      output: { ...validOutput, reply: "你要我怎麼處理這張圖" },
      tools: [],
      exitCode: 0,
    });

    expect(failures).toContain("Missing tool call: resolve_context");
    expect(failures).toContain("Missing tool call: run_python");
    expect(failures).toContain(
      "Missing artifact: media-background-removed.png",
    );
    expect(
      failures.some((failure) =>
        failure.startsWith("Reply matched forbidden claim"),
      ),
    ).toBe(true);
  });
});
