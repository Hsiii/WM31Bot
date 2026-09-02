import type {
  ChatbotMcpTraceCall,
  ChatbotTaskProgress,
} from "../../contracts/worker-contract";

const SESSION_IDLE_TTL_MS = 3 * 24 * 60 * 60_000;

type JsonObject = Record<string, unknown>;

type RunOptions = {
  jobId: string;
  taskId: string;
  resumeThreadId?: string;
  title?: string;
  command: string[];
  cwd: string;
  environment: Record<string, string>;
  model: string;
  effort: string;
  developerInstructions: string;
  prompt: string;
  imagePaths: string[];
  onProgress?: (progress: ChatbotTaskProgress) => void;
  onMcpToolCall?: (call: ChatbotMcpTraceCall) => void;
  signal?: AbortSignal;
};

type ActiveTurn = {
  jobId: string;
  turnId?: string;
  finalAnswer: string;
  lastAgentMessage: string;
  onProgress?: RunOptions["onProgress"];
  onMcpToolCall?: RunOptions["onMcpToolCall"];
  resolve: (content: string) => void;
  reject: (error: Error) => void;
};

function record(value: unknown): JsonObject | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonObject)
    : undefined;
}

function text(value: unknown): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) {
    return value
      .map((entry) => {
        if (typeof entry === "string") return entry;
        const item = record(entry);
        return typeof item?.text === "string" ? item.text : "";
      })
      .filter(Boolean)
      .join("\n");
  }
  return "";
}

function errorMessage(value: unknown, fallback: string) {
  const error = record(value);
  return typeof error?.message === "string" ? error.message : fallback;
}

export function isSuccessfulPullRequestMerge(item: JsonObject) {
  if (item.type !== "commandExecution") return false;
  const command = text(item.command);
  return (
    item.status === "completed" &&
    item.exitCode === 0 &&
    /(?:^|[\s"'=\/])gh\s+pr\s+merge(?:\s|$)/u.test(command)
  );
}

class CodexTurnInterruptedError extends Error {}

class CodexAppServerSession {
  private active?: ActiveTurn;
  private buffer = "";
  private child: Bun.PipedSubprocess;
  private exited = false;
  private nextId = 1;
  private pending = new Map<
    number,
    { resolve: (value: JsonObject) => void; reject: (error: Error) => void }
  >();
  private ready: Promise<void>;
  private stderr = "";
  private threadId?: string;

  constructor(private readonly options: RunOptions) {
    this.child = Bun.spawn(options.command, {
      cwd: options.cwd,
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
      env: options.environment,
    });
    void this.readOutput();
    void this.readErrors();
    void this.watchExit();
    this.ready = this.initialize();
  }

  async run(options: RunOptions) {
    await this.ready;
    if (this.active)
      throw new Error("Codex thread already has an active turn.");
    const input: JsonObject[] = [{ type: "text", text: options.prompt }];
    input.push(
      ...options.imagePaths.map((path) => ({ type: "localImage", path })),
    );

    let resolveResult!: (content: string) => void;
    let rejectResult!: (error: Error) => void;
    const result = new Promise<string>((resolve, reject) => {
      resolveResult = resolve;
      rejectResult = reject;
    });
    this.active = {
      jobId: options.jobId,
      finalAnswer: "",
      lastAgentMessage: "",
      onProgress: options.onProgress,
      onMcpToolCall: options.onMcpToolCall,
      resolve: resolveResult,
      reject: rejectResult,
    };
    const interrupt = () => void this.interrupt(options.jobId);
    options.signal?.addEventListener("abort", interrupt, { once: true });

    try {
      const response = await this.request("turn/start", {
        threadId: this.threadId,
        input,
        cwd: options.cwd,
        approvalPolicy: "never",
        model: options.model,
        effort: options.effort,
        summary: "detailed",
      });
      const turn = record(response.turn);
      if (!turn || typeof turn.id !== "string") {
        throw new Error("Codex App Server did not return a turn ID.");
      }
      if (this.active?.jobId === options.jobId) this.active.turnId = turn.id;
      if (options.signal?.aborted) await this.interrupt(options.jobId);
      return await result;
    } catch (error) {
      if (this.active?.jobId === options.jobId) {
        this.active = undefined;
      }
      throw error;
    } finally {
      options.signal?.removeEventListener("abort", interrupt);
    }
  }

  async steer(jobId: string, input: string) {
    await this.ready;
    const active = this.active;
    if (active?.jobId !== jobId || !active.turnId) return false;
    const response = await this.request("turn/steer", {
      threadId: this.threadId,
      input: [{ type: "text", text: input }],
      expectedTurnId: active.turnId,
    });
    return response.turnId === active.turnId;
  }

  async interrupt(jobId: string) {
    await this.ready.catch(() => undefined);
    const active = this.active;
    if (active?.jobId !== jobId || !active.turnId) return false;
    await this.request("turn/interrupt", {
      threadId: this.threadId,
      turnId: active.turnId,
    });
    return true;
  }

  close() {
    this.child.kill();
  }

  isHealthy() {
    return !this.exited;
  }

  private async initialize() {
    await this.request("initialize", {
      clientInfo: { name: "minisago", title: "MiniSago", version: "1" },
    });
    this.notify("initialized", {});
    const response = await this.request(
      this.options.resumeThreadId ? "thread/resume" : "thread/start",
      this.options.resumeThreadId
        ? {
            threadId: this.options.resumeThreadId,
            developerInstructions: this.options.developerInstructions,
          }
        : {
            model: this.options.model,
            cwd: this.options.cwd,
            approvalPolicy: "never",
            developerInstructions: this.options.developerInstructions,
            serviceName: "minisago",
          },
    );
    const thread = record(response.thread);
    if (!thread || typeof thread.id !== "string") {
      throw new Error("Codex App Server did not return a thread ID.");
    }
    this.threadId = thread.id;
    this.options.onProgress?.({
      phase: "preparing",
      summary: "Codex thread started.",
      sessionId: thread.id,
    });
    if (this.options.title) {
      await this.request("thread/name/set", {
        threadId: thread.id,
        name: this.options.title,
      });
    }
  }

  private request(method: string, params: JsonObject) {
    const id = this.nextId++;
    const response = new Promise<JsonObject>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
    });
    this.write({ method, id, params });
    return response;
  }

  private notify(method: string, params: JsonObject) {
    this.write({ method, params });
  }

  private write(message: JsonObject) {
    this.child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  private async readOutput() {
    const reader = this.child.stdout.getReader();
    const decoder = new TextDecoder();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      this.buffer += decoder.decode(value, { stream: true });
      let newline = this.buffer.indexOf("\n");
      while (newline >= 0) {
        const line = this.buffer.slice(0, newline);
        this.buffer = this.buffer.slice(newline + 1);
        if (line.trim()) this.handleMessage(line);
        newline = this.buffer.indexOf("\n");
      }
    }
  }

  private async readErrors() {
    const stderr = await new Response(this.child.stderr).text();
    this.stderr = stderr.trim().slice(-2_000);
  }

  private async watchExit() {
    const exitCode = await this.child.exited;
    this.exited = true;
    const error = new Error(
      this.stderr || `Codex App Server exited with status ${exitCode}.`,
    );
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear();
    this.active?.reject(error);
    this.active = undefined;
  }

  private handleMessage(line: string) {
    let message: JsonObject;
    try {
      message = JSON.parse(line) as JsonObject;
    } catch {
      return;
    }
    if (typeof message.id === "number" && !message.method) {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      if (message.error) {
        pending.reject(
          new Error(errorMessage(message.error, "Codex App Server failed.")),
        );
      } else {
        pending.resolve(record(message.result) ?? {});
      }
      return;
    }
    if (typeof message.method === "string") {
      this.handleNotification(message.method, record(message.params) ?? {});
    }
  }

  private handleNotification(method: string, params: JsonObject) {
    const active = this.active;
    if (!active) return;
    const turnId =
      typeof params.turnId === "string"
        ? params.turnId
        : typeof record(params.turn)?.id === "string"
          ? (record(params.turn)!.id as string)
          : undefined;
    if (active.turnId && turnId && active.turnId !== turnId) return;

    if (method === "item/started") {
      const item = record(params.item);
      if (item?.type === "commandExecution") {
        const command = text(item.command);
        active.onProgress?.(
          /\b(?:test|check|build|lint|typecheck|pytest)\b/iu.test(command)
            ? { phase: "testing", summary: "Running repository checks." }
            : { phase: "exploring", summary: "Inspecting the repository." },
        );
      }
      return;
    }

    if (method === "item/completed") {
      this.handleCompletedItem(active, record(params.item));
      return;
    }
    if (method !== "turn/completed") return;

    const turn = record(params.turn);
    const status = turn?.status;
    this.active = undefined;
    if (status === "completed") {
      const answer = active.finalAnswer || active.lastAgentMessage;
      if (answer.trim()) active.resolve(answer.trim());
      else active.reject(new Error("Codex returned no final answer."));
    } else if (status === "interrupted") {
      active.reject(
        new CodexTurnInterruptedError(
          "Codex request was cancelled or timed out.",
        ),
      );
    } else {
      active.reject(new Error(errorMessage(turn?.error, "Codex turn failed.")));
    }
  }

  private handleCompletedItem(active: ActiveTurn, item?: JsonObject) {
    if (!item || typeof item.type !== "string") return;
    if (isSuccessfulPullRequestMerge(item)) {
      active.onProgress?.({
        phase: "reviewing",
        summary: "Pull request merged.",
        completion: "pull_request_merged",
      });
      return;
    }
    if (item.type === "reasoning") {
      const summary = text(item.summary).trim();
      if (summary) {
        active.onProgress?.({
          phase: "exploring",
          summary: summary.slice(0, 2_000),
          kind: "trace",
        });
      }
      return;
    }
    if (item.type === "agentMessage") {
      const message = text(item.text).trim();
      if (!message) return;
      active.lastAgentMessage = message;
      if (item.phase === "final_answer") {
        active.finalAnswer = message;
      } else {
        active.onProgress?.({
          phase: "reviewing",
          summary: message.slice(0, 2_000),
          kind: "trace",
        });
      }
      return;
    }
    if (item.type === "plan") {
      const plan = text(item.text).trim();
      if (plan) {
        active.onProgress?.({
          phase: "exploring",
          summary: plan.slice(0, 2_000),
          kind: "trace",
        });
      }
      return;
    }
    if (item.type === "fileChange") {
      active.onProgress?.({
        phase: "implementing",
        summary: "Updated the working tree.",
      });
      return;
    }
    if (item.type !== "mcpToolCall" || item.server !== "minisago") return;
    if (typeof item.tool !== "string") return;
    active.onMcpToolCall?.({
      name: item.tool.slice(0, 100),
      arguments: record(item.arguments) ?? {},
      ...(typeof item.status === "string"
        ? { status: item.status.slice(0, 30) }
        : {}),
    });
  }
}

export class CodexAppServerManager {
  private jobs = new Map<string, CodexAppServerSession>();
  private sessions = new Map<string, CodexAppServerSession>();
  private timers = new Map<string, ReturnType<typeof setTimeout>>();

  async run(options: RunOptions) {
    this.clearTimer(options.taskId);
    let session = this.sessions.get(options.taskId);
    if (!session) {
      session = new CodexAppServerSession(options);
      this.sessions.set(options.taskId, session);
    }
    this.jobs.set(options.jobId, session);
    try {
      return await session.run(options);
    } catch (error) {
      if (!(error instanceof CodexTurnInterruptedError)) {
        if (this.sessions.get(options.taskId) === session) {
          this.sessions.delete(options.taskId);
        }
        session.close();
      }
      throw error;
    } finally {
      this.jobs.delete(options.jobId);
      if (this.sessions.get(options.taskId) === session) {
        this.scheduleClose(options.taskId, session);
      }
    }
  }

  async steer(jobId: string, request: string) {
    return (await this.jobs.get(jobId)?.steer(jobId, request)) ?? false;
  }

  async interrupt(jobId: string) {
    return (await this.jobs.get(jobId)?.interrupt(jobId)) ?? false;
  }

  status() {
    const sessions = [...this.sessions.values()];
    return {
      ok: sessions.every((session) => session.isHealthy()),
      sessions: sessions.length,
      active: this.jobs.size,
    };
  }

  close() {
    for (const timer of this.timers.values()) clearTimeout(timer);
    for (const session of this.sessions.values()) session.close();
    this.timers.clear();
    this.jobs.clear();
    this.sessions.clear();
  }

  private clearTimer(taskId: string) {
    const timer = this.timers.get(taskId);
    if (timer) clearTimeout(timer);
    this.timers.delete(taskId);
  }

  private scheduleClose(taskId: string, session: CodexAppServerSession) {
    const timer = setTimeout(() => {
      if (this.sessions.get(taskId) === session) {
        this.sessions.delete(taskId);
        session.close();
      }
      this.timers.delete(taskId);
    }, SESSION_IDLE_TTL_MS);
    timer.unref?.();
    this.timers.set(taskId, timer);
  }
}
