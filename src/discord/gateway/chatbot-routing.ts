import type {
  ChatbotExecutionMode,
  ChatbotExecutionTarget,
  ChatbotMutationScope,
  ChatbotTraceContext,
} from "../../chatbot/protocol";

export function parsePreviousTraceLookup(content: string): {
  status: "complete" | "not_found" | "unavailable";
  trace?: ChatbotTraceContext;
} {
  try {
    const payload = JSON.parse(content) as {
      status?: unknown;
      trace?: unknown;
    };
    if (payload.status === "not_found") return { status: "not_found" };
    if (
      payload.status !== "complete" ||
      !payload.trace ||
      typeof payload.trace !== "object"
    ) {
      return { status: "unavailable" };
    }
    const trace = payload.trace as Partial<ChatbotTraceContext>;
    if (
      typeof trace.contextMessageCount !== "number" ||
      typeof trace.searchResultCount !== "number" ||
      typeof trace.elapsedMs !== "number" ||
      !Array.isArray(trace.searchQueries) ||
      !Array.isArray(trace.memberQueries)
    ) {
      return { status: "unavailable" };
    }
    return {
      status: "complete",
      trace: trace as ChatbotTraceContext,
    };
  } catch {
    return { status: "unavailable" };
  }
}

export function parseExecutionRoute(
  content: string,
  availableRepositories: string[] = [],
): {
  mode: ChatbotExecutionMode;
  target: ChatbotExecutionTarget;
  mutationScope?: ChatbotMutationScope;
  repository?: string;
} {
  const advertisedRepositories = new Map(
    availableRepositories.map((repository) => [
      repository.toLocaleLowerCase("en-US"),
      repository,
    ]),
  );

  try {
    const normalized = content
      .trim()
      .replace(/^```(?:json)?\s*/iu, "")
      .replace(/\s*```$/u, "");
    const payload = JSON.parse(normalized) as {
      mode?: unknown;
      target?: unknown;
      repository?: unknown;
      mutationScope?: unknown;
    };
    if (payload.mode === "dev" || payload.mode === "chat") {
      const mutationScope = ["code", "issue", "deploy"].includes(
        payload.mutationScope as string,
      )
        ? (payload.mutationScope as ChatbotMutationScope)
        : undefined;
      const mode = mutationScope ? "dev" : payload.mode;
      const target = payload.target === "mac" ? "mac" : "default";
      const repository =
        typeof payload.repository === "string"
          ? advertisedRepositories.get(
              payload.repository.toLocaleLowerCase("en-US"),
            )
          : undefined;
      return {
        mode,
        target,
        ...(mutationScope ? { mutationScope } : {}),
        ...(mode === "dev" && repository ? { repository } : {}),
      };
    }
  } catch {
    // Fall through to the deterministic safety net.
  }

  return {
    mode: "chat",
    target: "default",
  };
}

export function missingDeveloperRepositoryResponse(
  mode: ChatbotExecutionMode,
  repository?: string,
  availableRepositories: string[] = [],
) {
  if (mode !== "dev" || repository) return undefined;
  const choices =
    availableRepositories.length > 0
      ? `\n目前可用的有 ${availableRepositories.map((value) => `\`${value}\``).join(" ")}`
      : "";
  return `這題要碰程式碼 但我還不知道是哪個 GitHub repo${choices}\n告訴我是哪個 我就能繼續`;
}
