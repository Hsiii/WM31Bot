import { dirname } from "node:path";

import type {
  CodexUsageSnapshot,
  CodexUsageWindow,
} from "../../lib/chatbot/protocol";

const USAGE_READ_TIMEOUT_MS = 5_000;

function usageEnvironment(codexHome: string, codexPath: string) {
  const environment: Record<string, string> = {
    CODEX_HOME: codexHome,
    PATH: `${dirname(codexPath)}:/usr/bin:/bin:/usr/sbin:/sbin`,
    TERM: "dumb",
    NO_COLOR: "1",
  };
  for (const name of [
    "HOME",
    "LANG",
    "LC_ALL",
    "LOGNAME",
    "NO_PROXY",
    "HTTPS_PROXY",
    "HTTP_PROXY",
    "SSL_CERT_FILE",
    "TMPDIR",
    "USER",
  ]) {
    const value = process.env[name];
    if (value) environment[name] = value;
  }
  return environment;
}

function percentage(value: unknown) {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.min(100, Math.max(0, value))
    : 0;
}

function windowLabel(windowMinutes: number) {
  if (windowMinutes === 7 * 24 * 60) return "weekly";
  if (windowMinutes % (24 * 60) === 0) {
    return `${windowMinutes / (24 * 60)}-day`;
  }
  if (windowMinutes % 60 === 0) return `${windowMinutes / 60}-hour`;
  return `${windowMinutes}-minute`;
}

function usageWindow(value: unknown): CodexUsageWindow | null {
  if (!value || typeof value !== "object") return null;
  const raw = value as Record<string, unknown>;
  const windowMinutes = raw.windowDurationMins;
  if (
    typeof windowMinutes !== "number" ||
    !Number.isInteger(windowMinutes) ||
    windowMinutes <= 0
  ) {
    return null;
  }

  const usedPercent = percentage(raw.usedPercent);
  const resetSeconds = raw.resetsAt;
  const resetsAt =
    typeof resetSeconds === "number" &&
    Number.isFinite(resetSeconds) &&
    resetSeconds > 0
      ? new Date(resetSeconds * 1_000).toISOString()
      : null;

  return {
    label: windowLabel(windowMinutes),
    windowMinutes,
    usedPercent,
    remainingPercent: 100 - usedPercent,
    resetsAt,
  };
}

export function parseCodexUsageResponse(
  value: unknown,
  now = new Date(),
): CodexUsageSnapshot | null {
  if (!value || typeof value !== "object") return null;
  const result = (value as Record<string, unknown>).result;
  if (!result || typeof result !== "object") return null;
  const rateLimits = (result as Record<string, unknown>).rateLimits;
  if (!rateLimits || typeof rateLimits !== "object") return null;
  const limits = rateLimits as Record<string, unknown>;
  const windows = [usageWindow(limits.primary), usageWindow(limits.secondary)]
    .filter((window): window is CodexUsageWindow => window !== null)
    .sort((left, right) => left.windowMinutes - right.windowMinutes);
  if (windows.length === 0) return null;

  return { windows, updatedAt: now.toISOString() };
}

export async function readCodexUsage(
  options: { codexHome: string; codexPath: string },
  timeoutMs = USAGE_READ_TIMEOUT_MS,
): Promise<CodexUsageSnapshot | null> {
  const child = Bun.spawn([options.codexPath, "app-server"], {
    stdin: "pipe",
    stdout: "pipe",
    stderr: "ignore",
    env: usageEnvironment(options.codexHome, options.codexPath),
  });
  const reader = child.stdout.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let requested = false;
  const timeout = AbortSignal.timeout(Math.max(0, timeoutMs));
  const timedOut = new Promise<never>((_, reject) => {
    timeout.addEventListener(
      "abort",
      () => reject(new Error("Codex usage read timed out.")),
      { once: true },
    );
  });

  const send = (value: Record<string, unknown>) => {
    child.stdin.write(`${JSON.stringify(value)}\n`);
  };

  try {
    send({
      method: "initialize",
      id: 1,
      params: {
        clientInfo: { name: "minisago", title: "MiniSago", version: "1" },
      },
    });

    while (!timeout.aborted) {
      const read = reader.read();
      const result = await Promise.race([read, timedOut]);
      if (result.done) return null;
      buffer += decoder.decode(result.value, { stream: true });

      let newline = buffer.indexOf("\n");
      while (newline >= 0) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        newline = buffer.indexOf("\n");
        if (!line.trim()) continue;

        let message: Record<string, unknown>;
        try {
          message = JSON.parse(line) as Record<string, unknown>;
        } catch {
          continue;
        }

        if (message.id === 1 && !requested) {
          requested = true;
          send({ method: "initialized", params: {} });
          send({ method: "account/rateLimits/read", id: 2 });
        } else if (message.id === 2) {
          return parseCodexUsageResponse(message);
        }
      }
    }
  } catch {
    return null;
  } finally {
    void reader.cancel();
    child.stdin.end();
    child.kill();
    await child.exited;
  }

  return null;
}
