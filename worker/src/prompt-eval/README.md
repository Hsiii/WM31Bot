# Prompt case evaluation

This is an opt-in live-model suite for prompt changes. It compiles the same prompt plan and output schema as the worker, runs Codex with mock MiniSago MCP tools, and checks observable behavior such as tool selection, inline emoji, non-empty replies, and artifact delivery.

The suite never contacts Discord or mutates production state. Web search is disabled. It is not part of normal unit tests because model runs are slow, paid, and nondeterministic.

## Case sources

Most cases reference the stratified prompt-v42 sample collected on 2026-08-27. That analysis selected 50 of 145 eligible sessions across three guilds, every requester in the population, and 11 task classes. `sampleIndex` points to the numbered session in that sample.

Fixtures preserve the interaction and failure pattern, but replace names, IDs, channels, and identifying details. Cases sourced from later Discord regressions name the diagnostic task or regression instead.

## Run it

From the repository root:

```bash
bun run eval:prompts
bun run eval:prompts -- --case recover-bounded-action
bun run eval:prompts -- --model gpt-5.6-luna --output /tmp/prompt-results.json
```

The command exits with status 1 when any expectation fails. A failed case is evidence to inspect, not proof from one sample. Rerun relevant cases after changing a prompt, and use more than one attempt before judging style frequency.

Normal tests validate the fixture catalog and evaluator itself:

```bash
bun test worker/src/prompt-eval/cases.test.ts
```
