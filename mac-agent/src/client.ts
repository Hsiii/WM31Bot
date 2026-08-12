import {
  CHATBOT_PROTOCOL_VERSION,
  type ChatbotJob,
  type ChatbotMcpTraceCall,
  type MacAgentClientMessage,
  type MacAgentServerMessage,
} from "../../src/chatbot/protocol";
import type { MacAgentConfig } from "./config";
import {
  checkCodexAuthentication,
  codexProfileForJob,
  PROMPT_VERSION,
  runCodexJob,
} from "./codex";
import { SessionMonitor } from "./session-monitor";
import { ChatbotTraceStore } from "./trace-store";
import { readCodexUsage } from "./codex-usage";
import { CodexAppServerManager } from "./codex-app-server";

const HEARTBEAT_INTERVAL_MS = 20_000;
const AUTH_RETRY_MS = 30_000;
const MAX_RECONNECT_DELAY_MS = 30_000;

function parseServerMessage(value: unknown) {
  try {
    return JSON.parse(String(value)) as MacAgentServerMessage;
  } catch {
    return null;
  }
}

export class MacAgentClient {
  private appServer = new CodexAppServerManager();
  private authenticated = false;
  private authRetryTimer: ReturnType<typeof setTimeout> | undefined;
  private currentJobs = new Map<string, AbortController>();
  private heartbeatTimer: ReturnType<typeof setInterval> | undefined;
  private reconnectAttempts = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  private sessionMonitor: SessionMonitor | null;
  private socket: WebSocket | null = null;
  private stopped = false;
  private traceStore: ChatbotTraceStore;
  private unlocked = false;

  constructor(private readonly config: MacAgentConfig) {
    this.traceStore = new ChatbotTraceStore(config.traceDatabasePath, {
      promptVersion: PROMPT_VERSION,
    });
    this.sessionMonitor = config.headless
      ? null
      : new SessionMonitor(
          config.sessionMonitorPath,
          (state) => void this.handleSessionState(state),
        );
  }

  start() {
    if (this.config.headless) {
      this.unlocked = true;
      void this.connectWhenReady();
      console.log("MiniSago headless worker started.");
      return;
    }

    this.sessionMonitor?.start();
    console.log("MiniSago Mac worker started.");
  }

  stop() {
    this.stopped = true;
    this.unlocked = false;
    this.clearTimers();
    this.abortAllJobs();
    this.appServer.close();
    this.socket?.close(1000, "Helper stopped");
    this.socket = null;
    this.sessionMonitor?.stop();
    this.traceStore.close();
  }

  private async handleSessionState(state: "locked" | "unlocked") {
    if (state === "locked") {
      this.unlocked = false;
      this.authenticated = false;
      this.clearTimers();
      this.abortAllJobs();
      this.appServer.close();
      this.socket?.close(1000, "Mac locked or sleeping");
      this.socket = null;
      console.log("Mac locked; worker unavailable.");
      return;
    }

    if (this.unlocked || this.stopped) {
      return;
    }

    this.unlocked = true;
    await this.connectWhenReady();
  }

  private async connectWhenReady() {
    if (!this.unlocked || this.stopped || this.socket) {
      return;
    }

    const authenticated = await checkCodexAuthentication(this.config);
    if (!authenticated) {
      console.warn("Local Codex authentication unavailable; chatbot offline.");
      this.authRetryTimer = setTimeout(
        () => void this.connectWhenReady(),
        AUTH_RETRY_MS,
      );
      return;
    }

    this.openSocket();
  }

  private openSocket() {
    if (!this.unlocked || this.stopped || this.socket) {
      return;
    }

    const socket = new WebSocket(this.config.bridgeUrl);
    this.socket = socket;
    socket.addEventListener("open", () => {
      this.send({
        type: "authenticate",
        protocolVersion: CHATBOT_PROTOCOL_VERSION,
        secret: this.config.bridgeSecret,
        workerId: this.config.workerId,
        repositories: this.config.githubRepositories,
        ...(this.config.chatbotRepository
          ? { chatbotRepository: this.config.chatbotRepository }
          : {}),
      });
    });
    socket.addEventListener("message", (event) => {
      void this.handleServerMessage(event.data);
    });
    socket.addEventListener("close", () => {
      if (socket !== this.socket) {
        return;
      }

      this.socket = null;
      this.authenticated = false;
      this.stopHeartbeat();
      this.abortAllJobs();
      this.appServer.close();
      this.scheduleReconnect();
    });
    socket.addEventListener("error", () => {
      socket.close();
    });
  }

  private async handleServerMessage(rawMessage: unknown) {
    const message = parseServerMessage(rawMessage);
    if (!message) {
      this.socket?.close(4002, "Invalid server message");
      return;
    }

    if (message.type === "authenticated") {
      if (message.protocolVersion !== CHATBOT_PROTOCOL_VERSION) {
        this.socket?.close(4002, "Protocol mismatch");
        return;
      }

      this.authenticated = true;
      this.reconnectAttempts = 0;
      this.startHeartbeat();
      this.send({
        type: "availability",
        available: true,
        capacity: this.config.maxConcurrentJobs,
      });
      console.log("MiniSago worker available.");
      return;
    }

    if (!this.authenticated) {
      this.socket?.close(4001, "Server message before authentication");
      return;
    }

    if (message.type === "cancel") {
      this.currentJobs.get(message.jobId)?.abort();
      return;
    }

    if (message.type === "steer") {
      let accepted = false;
      try {
        accepted = await this.appServer.steer(message.jobId, message.request);
      } catch (error) {
        console.warn(
          `Job ${message.jobId} steering failed: ${
            error instanceof Error ? error.message : "unknown error"
          }`,
        );
      }
      this.send({
        type: "steer_result",
        jobId: message.jobId,
        requestId: message.requestId,
        accepted,
      });
      if (!accepted) {
        console.warn(`Job ${message.jobId} could not be steered.`);
      }
      return;
    }

    if (message.type === "codex_usage_request") {
      const usage = await readCodexUsage(this.config);
      if (this.authenticated) {
        this.send({
          type: "codex_usage_result",
          requestId: message.requestId,
          usage,
        });
      }
      return;
    }

    if (message.type === "job") {
      void this.handleJob(message.job);
    }
  }

  private async handleJob(job: ChatbotJob) {
    if (this.currentJobs.size >= this.config.maxConcurrentJobs) {
      this.send({
        type: "result",
        jobId: job.id,
        ok: false,
        error: "Codex worker is busy.",
      });
      return;
    }

    const controller = new AbortController();
    this.currentJobs.set(job.id, controller);
    const startedAt = Date.now();
    console.log(`Job ${job.id} started.`);

    try {
      const rawContent =
        job.purpose === "trace_lookup"
          ? (() => {
              const trace = this.traceStore.previousTrace(
                job.channelId,
                job.requestMessageId,
              );
              return JSON.stringify(
                trace ? { status: "complete", trace } : { status: "not_found" },
              );
            })()
          : await (async () => {
              const toolCalls: ChatbotMcpTraceCall[] = [];
              this.traceStore.start(job, startedAt, {
                model: codexProfileForJob(job, this.config.chatbotAccess).model,
              });
              const answer = await runCodexJob(job, {
                ...this.config,
                appServer: this.appServer,
                onMcpToolCall: (call) => toolCalls.push(call),
                onPromptCompiled: (prompt) =>
                  this.traceStore.recordPrompt(job.id, prompt),
                onProgress: (progress) =>
                  this.send({ type: "progress", jobId: job.id, progress }),
                signal: controller.signal,
              });
              this.traceStore.finish(
                job.id,
                answer.content,
                Date.now(),
                toolCalls,
              );
              return answer;
            })();

      const outgoing =
        typeof rawContent === "string"
          ? { content: rawContent, files: [] }
          : rawContent;

      if (!controller.signal.aborted && this.authenticated) {
        this.currentJobs.delete(job.id);
        this.send({
          type: "result",
          jobId: job.id,
          ok: true,
          content: outgoing.content,
          ...(outgoing.files.length ? { files: outgoing.files } : {}),
        });
      }
      console.log(`Job ${job.id} finished in ${Date.now() - startedAt} ms.`);
    } catch (error) {
      if (job.purpose !== "trace_lookup") {
        this.traceStore.fail(
          job.id,
          error instanceof Error ? error.message : "Codex failed.",
        );
      }
      if (this.authenticated) {
        this.currentJobs.delete(job.id);
        this.send({
          type: "result",
          jobId: job.id,
          ok: false,
          error: controller.signal.aborted
            ? "Task stopped."
            : error instanceof Error
              ? error.message
              : "Codex failed.",
          ...(controller.signal.aborted ? { stopped: true } : {}),
        });
      }
      console.error(`Job ${job.id} failed after ${Date.now() - startedAt} ms.`);
    } finally {
      this.currentJobs.delete(job.id);
    }
  }

  private send(message: MacAgentClientMessage) {
    if (this.socket?.readyState === WebSocket.OPEN) {
      this.socket.send(JSON.stringify(message));
    }
  }

  private startHeartbeat() {
    this.stopHeartbeat();
    this.heartbeatTimer = setInterval(() => {
      this.send({ type: "heartbeat" });
    }, HEARTBEAT_INTERVAL_MS);
  }

  private stopHeartbeat() {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = undefined;
    }
  }

  private scheduleReconnect() {
    if (!this.unlocked || this.stopped) {
      return;
    }

    const delay = Math.min(
      1_000 * 2 ** this.reconnectAttempts,
      MAX_RECONNECT_DELAY_MS,
    );
    this.reconnectAttempts += 1;
    this.reconnectTimer = setTimeout(() => void this.connectWhenReady(), delay);
  }

  private clearTimers() {
    this.stopHeartbeat();

    if (this.authRetryTimer) {
      clearTimeout(this.authRetryTimer);
      this.authRetryTimer = undefined;
    }

    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = undefined;
    }
  }

  private abortAllJobs() {
    for (const controller of this.currentJobs.values()) controller.abort();
    this.currentJobs.clear();
  }
}
