import { handleVoiceDebugRequest } from "./discord/voice-debug/http";
import type { Server } from "bun";

import { getChatbotAccessConfig } from "./chatbot/access";
import { getPublicDiscordSummary } from "./discord/config";
import {
  macAgentBridge,
  macAgentWebSocketHandler,
  type MacAgentSocketData,
} from "./chatbot/bridge";
import {
  handleChatbotMcpRequest,
  handleChatbotMediaRequest,
} from "./chatbot/mcp";
import { startGamerForumMonitor } from "./discord/jobs/gamer-forum-monitor";
import { startDeploymentNotificationMonitor } from "./discord/jobs/deployment-notifications";
import { startInstagramGateway } from "./discord/gateway";
import {
  handleGithubWebhookRequest,
  isGithubWebhookConfigured,
} from "./discord/jobs/github-pr-webhook";
import { handleMediaAccessNotificationRequest } from "./discord/jobs/media-access-notifications";
import { startToeflVocabScheduler } from "./discord/jobs/toefl-vocab";
import { startXPostMonitor } from "./discord/jobs/x-post-monitor";
import { startThreadsSearchMonitor } from "./discord/jobs/threads-search-monitor";
import {
  configureChatbotReminderScheduler,
  type Reminder,
} from "./discord/jobs/reminders";
import { createDiscordRequest } from "./discord/api/request";

function jsonResponse(body: unknown, status = 200) {
  return Response.json(body, { status });
}

function buildHealthResponse() {
  try {
    const summary = getPublicDiscordSummary();

    return jsonResponse({
      ok: true,
      configured: {
        applicationId: summary.hasApplicationId,
        botToken: summary.hasBotToken,
        guildId: summary.hasGuildId,
        githubWebhook: isGithubWebhookConfigured(),
        macBridge: macAgentBridge.isConfigured(),
      },
      workers: macAgentBridge.getWorkerSummary(),
    });
  } catch (error) {
    console.error("Invalid health check configuration:", error);
    return jsonResponse(
      {
        ok: false,
        error: "服務設定無效",
      },
      500,
    );
  }
}

function handleRequest(request: Request, server: Server<MacAgentSocketData>) {
  const { pathname } = new URL(request.url);

  if (
    pathname === "/voice-debug" ||
    pathname.startsWith("/voice-debug/") ||
    pathname.startsWith("/api/voice-debug/")
  )
    return handleVoiceDebugRequest(request);

  if (request.method === "GET" && pathname === "/api/mac-agent/ws") {
    return macAgentBridge.handleUpgrade(request, server);
  }

  if (request.method === "GET" && pathname === "/api/health") {
    return buildHealthResponse();
  }

  if (pathname === "/api/chatbot/mcp") {
    return handleChatbotMcpRequest(request);
  }

  if (pathname.startsWith("/api/chatbot/media/")) {
    return handleChatbotMediaRequest(request);
  }

  if (request.method === "POST" && pathname === "/api/github/webhook") {
    return handleGithubWebhookRequest(request);
  }

  if (
    request.method === "POST" &&
    pathname === "/api/internal/media-access-request"
  ) {
    return handleMediaAccessNotificationRequest(request);
  }

  return new Response("找不到此頁面", { status: 404 });
}

const port = Number(process.env.PORT ?? 3000);
const hostname = process.env.HOSTNAME || "0.0.0.0";
getChatbotAccessConfig();
const server = Bun.serve({
  port,
  hostname,
  fetch: handleRequest,
  websocket: macAgentWebSocketHandler,
});

const reminderBotToken = process.env.DISCORD_BOT_TOKEN?.trim();
if (reminderBotToken) {
  const discordRequest = createDiscordRequest(reminderBotToken);
  configureChatbotReminderScheduler(async (reminder: Reminder) => {
    await discordRequest(`/channels/${reminder.channelId}/messages`, {
      method: "POST",
      body: {
        content: `<@${reminder.requesterUserId}> ⏰ ${reminder.content}`,
        allowed_mentions: {
          parse: [],
          users: [reminder.requesterUserId],
        },
      },
    });
  });
} else {
  console.warn("Reminder scheduler disabled: DISCORD_BOT_TOKEN is missing.");
}

if (process.env.DISCORD_GATEWAY_DISABLED !== "true") {
  startInstagramGateway();
}

startToeflVocabScheduler();
startGamerForumMonitor();
startXPostMonitor();
startThreadsSearchMonitor();
startDeploymentNotificationMonitor();

console.log(`MiniSago listening on http://${server.hostname}:${server.port}`);
