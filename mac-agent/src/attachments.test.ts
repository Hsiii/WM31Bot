import { access } from "node:fs/promises";

import { describe, expect, test } from "bun:test";

import type { ChatbotJob } from "../../src/chatbot/protocol";
import { attachmentLimits, prepareAttachments } from "./attachments";

describe("chatbot attachment limits", () => {
  test("caps downloads at ten files and twenty megabytes each", () => {
    expect(attachmentLimits).toEqual({
      count: 10,
      bytes: 20 * 1024 * 1024,
      totalBytes: 40 * 1024 * 1024,
      extractedCharacters: 100_000,
      totalExtractedCharacters: 200_000,
    });
  });

  test("explains oversized attachments with the selected Chinese copy", async () => {
    const prepared = await prepareAttachments({
      id: "job-large-file",
      requesterUserId: "test-user",
      channelId: "channel-1",
      requestMessageId: "message-1",
      request: "read this",
      messages: [
        {
          id: "message-1",
          author: "Hsi",
          timestamp: "2026-07-20T10:00:00.000Z",
          content: "notes",
          attachments: [
            {
              id: "attachment-large",
              filename: "huge.pdf",
              contentType: "application/pdf",
              size: 20 * 1024 * 1024 + 1,
              url: "https://cdn.discordapp.com/huge.pdf",
            },
          ],
        },
      ],
    });

    expect(prepared.ignored).toEqual([
      "附件 huge.pdf 超過 20 MB 我吃不下 換小一點的檔案吧",
    ]);
    await prepared.cleanup();
  });

  test.serial("skips attachments outside answer jobs", async () => {
    const originalFetch = globalThis.fetch;
    let fetched = false;
    globalThis.fetch = (async () => {
      fetched = true;
      return new Response("unused");
    }) as unknown as typeof fetch;

    try {
      const prepared = await prepareAttachments({
        id: "route-with-attachment",
        requesterUserId: "owner",
        purpose: "execution_route",
        channelId: "channel-1",
        requestMessageId: "message-1",
        request: "handle this",
        messages: [
          {
            id: "message-1",
            author: "Hsi",
            timestamp: "2026-07-20T10:00:00.000Z",
            content: "repository notes",
            attachments: [
              {
                id: "attachment-1",
                filename: "notes.txt",
                contentType: "text/plain",
                size: 5,
                url: "https://cdn.discordapp.com/notes.txt",
              },
            ],
          },
        ],
      });

      expect(fetched).toBe(false);
      expect(prepared.imagePaths).toEqual([]);
      expect(prepared.textBlocks).toEqual([]);
      await prepared.cleanup();
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test.serial("ignores unsupported Word documents", async () => {
    const originalFetch = globalThis.fetch;
    let fetched = false;
    globalThis.fetch = (async () => {
      fetched = true;
      return new Response("unused");
    }) as unknown as typeof fetch;

    try {
      const prepared = await prepareAttachments({
        id: "answer-with-docx",
        requesterUserId: "test-user",
        purpose: "answer",
        channelId: "channel-1",
        requestMessageId: "message-1",
        request: "read this",
        messages: [
          {
            id: "message-1",
            author: "Hsi",
            timestamp: "2026-07-20T10:00:00.000Z",
            content: "document",
            attachments: [
              {
                id: "attachment-1",
                filename: "notes.docx",
                contentType:
                  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
                size: 5,
                url: "https://cdn.discordapp.com/notes.docx",
              },
            ],
          },
        ],
      });

      expect(fetched).toBe(false);
      expect(prepared.textBlocks).toEqual([]);
      await prepared.cleanup();
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test.serial(
    "extracts text attachments and removes temporary files",
    async () => {
      const originalFetch = globalThis.fetch;
      const job: ChatbotJob = {
        id: "job-1",
        requesterUserId: "test-user",
        channelId: "channel-1",
        requestMessageId: "message-2",
        request: "What is in the notes?",
        messages: [
          {
            id: "message-1",
            author: "Hsi",
            timestamp: "2026-07-20T10:00:00.000Z",
            content: "Here are the notes",
            attachments: [
              {
                id: "attachment-1",
                filename: "notes.txt",
                contentType: "text/plain",
                size: 19,
                url: "https://cdn.discordapp.com/notes.txt",
              },
            ],
          },
        ],
      };

      globalThis.fetch = (async () =>
        new Response("Ship next Friday.", {
          headers: { "Content-Length": "17" },
        })) as unknown as typeof fetch;

      try {
        const prepared = await prepareAttachments(job);
        expect(prepared.textBlocks).toEqual([
          "Attachment: notes.txt\nShip next Friday.",
        ]);
        expect(prepared.imagePaths).toHaveLength(0);
        expect(prepared.ignored).toEqual([]);
        await prepared.cleanup();
        expect(access(prepared.directory)).rejects.toThrow();
      } finally {
        globalThis.fetch = originalFetch;
      }
    },
  );

  test.serial("includes attachments on the triggering mention", async () => {
    const originalFetch = globalThis.fetch;
    const job: ChatbotJob = {
      id: "job-2",
      requesterUserId: "test-user",
      channelId: "channel-1",
      requestMessageId: "message-2",
      request: "read this",
      requestMessage: {
        id: "message-2",
        author: "Hsi",
        timestamp: "2026-07-20T10:00:00.000Z",
        content: "@MiniSago read this",
        attachments: [
          {
            id: "attachment-2",
            filename: "request.txt",
            contentType: "text/plain",
            size: 15,
            url: "https://cdn.discordapp.com/request.txt",
          },
        ],
      },
      messages: [],
    };

    globalThis.fetch = (async () =>
      new Response("Mention context", {
        headers: { "Content-Length": "15" },
      })) as unknown as typeof fetch;

    try {
      const prepared = await prepareAttachments(job);
      expect(prepared.textBlocks).toEqual([
        "Attachment: request.txt\nMention context",
      ]);
      await prepared.cleanup();
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test.serial(
    "includes replied-to images with missing or modern MIME types",
    async () => {
      const originalFetch = globalThis.fetch;
      const job: ChatbotJob = {
        id: "job-images",
        requesterUserId: "test-user",
        channelId: "channel-1",
        requestMessageId: "message-2",
        request: "read the image above",
        requestMessage: {
          id: "message-2",
          author: "Hsi",
          timestamp: "2026-07-20T10:00:00.000Z",
          content: "read the image above",
          attachments: [],
          referencedMessage: {
            id: "message-1",
            author: "Hsi",
            timestamp: "2026-07-20T09:59:00.000Z",
            content: "screenshots",
            attachments: [
              {
                id: "attachment-webp",
                filename: "diagram.webp",
                contentType: "image/webp",
                size: 4,
                url: "https://cdn.discordapp.com/diagram.webp",
              },
              {
                id: "attachment-gif",
                filename: "capture.gif",
                size: 4,
                url: "https://cdn.discordapp.com/capture.gif",
              },
            ],
          },
        },
        messages: Array.from({ length: 10 }, (_, index) => ({
          id: `history-${index}`,
          author: "Someone",
          timestamp: `2026-07-19T10:00:${String(index).padStart(2, "0")}.000Z`,
          content: "older image",
          attachments: [
            {
              id: `history-image-${index}`,
              filename: `history-${index}.png`,
              contentType: "image/png",
              size: 4,
              url: `https://cdn.discordapp.com/history-${index}.png`,
            },
          ],
        })),
      };

      globalThis.fetch = (async () =>
        new Response("data", {
          headers: { "Content-Length": "4" },
        })) as unknown as typeof fetch;

      try {
        const prepared = await prepareAttachments(job);
        expect(
          prepared.imagePaths.map((path) => path.split("/").at(-1)),
        ).toEqual([
          "0-diagram.webp",
          "1-capture.gif",
          "2-history-9.png",
          "3-history-8.png",
          "4-history-7.png",
          "5-history-6.png",
          "6-history-5.png",
          "7-history-4.png",
          "8-history-3.png",
          "9-history-2.png",
        ]);
        expect(prepared.ignored).toEqual([]);
        await prepared.cleanup();
      } finally {
        globalThis.fetch = originalFetch;
      }
    },
  );

  test.serial(
    "stops before downloading when the request is cancelled",
    async () => {
      const originalFetch = globalThis.fetch;
      let fetched = false;
      globalThis.fetch = (async () => {
        fetched = true;
        return new Response("unused");
      }) as unknown as typeof fetch;
      const controller = new AbortController();
      controller.abort();

      try {
        await expect(
          prepareAttachments(
            {
              id: "job-cancelled",
              requesterUserId: "test-user",
              channelId: "channel-1",
              requestMessageId: "message-1",
              request: "read this",
              messages: [
                {
                  id: "message-1",
                  author: "Hsi",
                  timestamp: "2026-07-20T10:00:00.000Z",
                  content: "notes",
                  attachments: [
                    {
                      id: "attachment-1",
                      filename: "notes.txt",
                      contentType: "text/plain",
                      size: 5,
                      url: "https://cdn.discordapp.com/notes.txt",
                    },
                  ],
                },
              ],
            },
            controller.signal,
          ),
        ).rejects.toThrow();
        expect(fetched).toBe(false);
      } finally {
        globalThis.fetch = originalFetch;
      }
    },
  );
});
