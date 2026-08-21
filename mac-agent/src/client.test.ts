import { describe, expect, test } from "bun:test";

import type { ChatbotJob } from "../../src/chatbot/protocol";
import { formatJobFailure } from "./client";

const job: ChatbotJob = {
  id: "job-123",
  requesterUserId: "owner",
  purpose: "answer",
  executionRoute: "oracle",
  repository: "sago-cream/mini-sago",
  channelId: "thread-1",
  requestMessageId: "message-1",
  request: "fix it",
  messages: [],
  developerTask: { id: "task-456" },
};

describe("worker failure reporting", () => {
  test("reports enough context to diagnose and retry a coding failure", () => {
    expect(formatJobFailure(job, "testing", "Network timeout")).toBe(
      "Phase: testing\nCause: Network timeout\nRepository: sago-cream/mini-sago\nBranch: minisago/task-456\nRetry: safe\nLogs: worker job job-123",
    );
  });
});
