import type { PromptCase } from "./cases";

export type PromptCaseOutput = {
  reply: string | null;
  reaction: { emoji: string } | null;
  artifacts: string[];
  referenceResolution: unknown[];
};

export type PromptCaseResult = {
  id: string;
  source: PromptCase["source"];
  pass: boolean;
  failures: string[];
  tools: string[];
  output: PromptCaseOutput | null;
  exitCode: number;
  developerCharacters: number;
  elapsedMs: number;
  stderr?: string;
};

const inlineEmoji = /\p{Extended_Pictographic}/u;

export function evaluatePromptCase(
  testCase: PromptCase,
  result: {
    output: PromptCaseOutput | null;
    tools: string[];
    exitCode: number;
  },
) {
  const failures: string[] = [];
  const { output, tools, exitCode } = result;
  if (exitCode !== 0) failures.push(`Codex exited with ${exitCode}`);
  if (!output) failures.push("No structured answer was returned");

  for (const tool of testCase.expectation.requiredTools ?? []) {
    if (!tools.includes(tool)) failures.push(`Missing tool call: ${tool}`);
  }
  for (const tool of testCase.expectation.forbiddenTools ?? []) {
    if (tools.includes(tool)) failures.push(`Unexpected tool call: ${tool}`);
  }

  if (output) {
    if (!output.reply && !output.reaction) {
      failures.push("Both reply and reaction are empty");
    }
    if (output.reply && inlineEmoji.test(output.reply)) {
      failures.push("Reply contains inline emoji");
    }
    if (testCase.expectation.artifact === null && output.artifacts.length) {
      failures.push(
        `Expected no artifact, received ${output.artifacts.join(", ")}`,
      );
    } else if (
      typeof testCase.expectation.artifact === "string" &&
      !output.artifacts.includes(testCase.expectation.artifact)
    ) {
      failures.push(`Missing artifact: ${testCase.expectation.artifact}`);
    }
    for (const pattern of testCase.expectation.requiredReplyPatterns ?? []) {
      if (!output.reply || !pattern.test(output.reply)) {
        failures.push(`Reply did not name required detail: ${pattern.source}`);
      }
    }
    for (const pattern of testCase.expectation.forbiddenReplyPatterns ?? []) {
      if (output.reply && pattern.test(output.reply)) {
        failures.push(`Reply matched forbidden claim: ${pattern.source}`);
      }
    }
  }

  return failures;
}
