import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import {
  buildPromptPlan,
  outputSchemaForJob,
  PROMPT_VERSION,
} from "../prompts";
import { PROMPT_CASES } from "./cases";
import type { PromptCase, PromptCaseSource } from "./cases";
import {
  evaluatePromptCase,
  type PromptCaseOutput,
  type PromptCaseResult,
} from "./evaluate";

type Options = {
  model: string;
  codexPath: string;
  caseIds: Set<string>;
  outputPath?: string;
};

const defaultCodexPath = "/Applications/ChatGPT.app/Contents/Resources/codex";

function options(argv: string[]): Options {
  const value = (name: string) => {
    const index = argv.indexOf(name);
    return index >= 0 ? argv[index + 1] : undefined;
  };
  return {
    model: value("--model") ?? "gpt-5.6-luna",
    codexPath:
      value("--codex") ?? process.env.MINISAGO_CODEX_PATH ?? defaultCodexPath,
    caseIds: new Set(
      argv.flatMap((argument, index) =>
        argument === "--case" && argv[index + 1] ? [argv[index + 1]!] : [],
      ),
    ),
    outputPath: value("--output"),
  };
}

function sourceLabel(source: PromptCaseSource) {
  if (source.kind === "stratified-v42-sample") {
    return `v42 sample #${source.sampleIndex}`;
  }
  if (source.kind === "discord-regression") {
    return `${source.thread} ${source.symptom}`;
  }
  return `${source.regression} ${source.variant}`;
}

async function calls(path: string) {
  const content = await readFile(path, "utf8");
  return content
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as { tool: string })
    .map(({ tool }) => tool);
}

async function runCase(
  testCase: PromptCase,
  runRoot: string,
  config: Options,
): Promise<PromptCaseResult> {
  const caseRoot = join(runRoot, testCase.id);
  await mkdir(caseRoot, { recursive: true });
  const plan = buildPromptPlan(testCase.job, testCase.attachmentText ?? [], []);
  const schema = outputSchemaForJob(testCase.job);
  if (!schema) throw new Error(`${testCase.id} has no output schema`);
  const schemaPath = join(caseRoot, "schema.json");
  const finalPath = join(caseRoot, "final.json");
  const callLog = join(caseRoot, "calls.jsonl");
  await Promise.all([
    writeFile(schemaPath, JSON.stringify(schema)),
    writeFile(callLog, ""),
  ]);

  const startedAt = Date.now();
  const child = Bun.spawn(
    [
      config.codexPath,
      "exec",
      "--json",
      "--ephemeral",
      "--skip-git-repo-check",
      "--ignore-user-config",
      "--strict-config",
      "--model",
      config.model,
      "--sandbox",
      "read-only",
      "--cd",
      caseRoot,
      "--output-schema",
      schemaPath,
      "--output-last-message",
      finalPath,
      "--config",
      'model_reasoning_effort="high"',
      "--config",
      'model_verbosity="medium"',
      "--config",
      'approval_policy="never"',
      "--config",
      'web_search="disabled"',
      "--config",
      "features.hooks=false",
      "--config",
      "features.memories=false",
      "--config",
      "features.shell_tool=false",
      "--config",
      "project_doc_max_bytes=0",
      "--config",
      `developer_instructions=${JSON.stringify(plan.developerInstructions)}`,
      "--config",
      `mcp_servers.minisago.command=${JSON.stringify(process.execPath)}`,
      "--config",
      `mcp_servers.minisago.args=[${JSON.stringify(join(import.meta.dir, "mock-mcp.ts"))}]`,
      "--config",
      'mcp_servers.minisago.env_vars=["MINISAGO_PROMPT_EVAL_CALL_LOG","MINISAGO_PROMPT_EVAL_CONTEXT","MINISAGO_PROMPT_EVAL_MEDIA_ID"]',
      "--config",
      "mcp_servers.minisago.required=true",
      "--config",
      'mcp_servers.minisago.default_tools_approval_mode="approve"',
      "--config",
      "mcp_servers.minisago.startup_timeout_sec=10",
      plan.taskInstruction,
    ],
    {
      cwd: caseRoot,
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
      env: {
        ...process.env,
        MINISAGO_PROMPT_EVAL_CALL_LOG: callLog,
        MINISAGO_PROMPT_EVAL_CONTEXT: JSON.stringify(
          testCase.mockContext ?? {},
        ),
        MINISAGO_PROMPT_EVAL_MEDIA_ID: testCase.mediaId ?? "",
        NO_COLOR: "1",
      },
    },
  );
  child.stdin.write(plan.context);
  child.stdin.end();
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  await writeFile(join(caseRoot, "events.jsonl"), stdout);

  let output: PromptCaseOutput | null = null;
  if (exitCode === 0 && existsSync(finalPath)) {
    output = JSON.parse(await readFile(finalPath, "utf8")) as PromptCaseOutput;
  }
  const toolCalls = await calls(callLog);
  const failures = evaluatePromptCase(testCase, {
    output,
    tools: toolCalls,
    exitCode,
  });
  return {
    id: testCase.id,
    source: testCase.source,
    pass: failures.length === 0,
    failures,
    tools: toolCalls,
    output,
    exitCode,
    developerCharacters: plan.developerInstructions.length,
    elapsedMs: Date.now() - startedAt,
    ...(stderr.trim() ? { stderr: stderr.trim() } : {}),
  };
}

const config = options(Bun.argv.slice(2));
if (!existsSync(config.codexPath)) {
  throw new Error(`Codex executable not found: ${config.codexPath}`);
}
const selected = config.caseIds.size
  ? PROMPT_CASES.filter(({ id }) => config.caseIds.has(id))
  : PROMPT_CASES;
const unknown = [...config.caseIds].filter(
  (id) => !PROMPT_CASES.some((testCase) => testCase.id === id),
);
if (unknown.length) throw new Error(`Unknown cases: ${unknown.join(", ")}`);

const runRoot = await mkdtemp(join(tmpdir(), "minisago-prompt-eval-"));
const results: PromptCaseResult[] = [];
for (const testCase of selected) {
  const result = await runCase(testCase, runRoot, config);
  results.push(result);
  console.log(
    `${result.pass ? "PASS" : "FAIL"} ${result.id} (${sourceLabel(result.source)})${
      result.failures.length ? `: ${result.failures.join("; ")}` : ""
    }`,
  );
}

const report = {
  model: config.model,
  promptVersion: PROMPT_VERSION,
  passed: results.filter(({ pass }) => pass).length,
  total: results.length,
  results,
};
if (config.outputPath) {
  await mkdir(dirname(config.outputPath), { recursive: true });
  await writeFile(config.outputPath, JSON.stringify(report, null, 2));
  console.log(`Report: ${config.outputPath}`);
}
console.log(`${report.passed}/${report.total} cases passed`);
if (report.passed !== report.total) process.exitCode = 1;
