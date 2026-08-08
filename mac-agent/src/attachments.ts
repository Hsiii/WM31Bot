import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, extname, join } from "node:path";

import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";

import type { ChatbotAttachment, ChatbotJob } from "../../src/chatbot/protocol";

const MAX_ATTACHMENTS = 10;
const MAX_ATTACHMENT_BYTES = 20 * 1024 * 1024;
const MAX_EXTRACTED_CHARACTERS = 100_000;
const MAX_TOTAL_ATTACHMENT_BYTES = 40 * 1024 * 1024;
const MAX_TOTAL_EXTRACTED_CHARACTERS = 200_000;
const DOWNLOAD_TIMEOUT_MS = 20_000;
const ALLOWED_ATTACHMENT_HOSTS = new Set([
  "cdn.discordapp.com",
  "media.discordapp.net",
]);

const textContentTypes = new Set([
  "application/json",
  "application/ld+json",
  "application/javascript",
  "application/xml",
  "application/yaml",
  "application/x-yaml",
]);

const textExtensions = new Set([
  ".csv",
  ".json",
  ".md",
  ".rtf",
  ".tsv",
  ".txt",
  ".xml",
  ".yaml",
  ".yml",
]);

const imageContentTypes = new Set([
  "image/gif",
  "image/jpeg",
  "image/png",
  "image/webp",
]);
const imageExtensions = new Set([".gif", ".jpeg", ".jpg", ".png", ".webp"]);
const mediaContentTypes = new Set([
  ...imageContentTypes,
  "audio/mpeg",
  "audio/wav",
  "audio/webm",
  "video/mp4",
  "video/quicktime",
  "video/webm",
]);
const mediaExtensions = new Set([
  ...imageExtensions,
  ".mp3",
  ".mp4",
  ".mov",
  ".wav",
  ".webm",
]);

type AttachmentCandidate = {
  attachment: ChatbotAttachment;
  direct: boolean;
  surroundingText: string;
  order: number;
};

export type PreparedAttachments = {
  directory: string;
  imagePaths: string[];
  mediaManifestPath: string;
  outputsDirectory: string;
  textBlocks: string[];
  ignored: string[];
  cleanup: () => Promise<void>;
};

function queryTokens(query: string) {
  return query
    .toLocaleLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((token) => token.length >= 2);
}

function isSupported(attachment: ChatbotAttachment) {
  const contentType = attachment.contentType?.toLocaleLowerCase() ?? "";
  const extension = extname(attachment.filename).toLocaleLowerCase();

  return (
    imageContentTypes.has(contentType) ||
    mediaContentTypes.has(contentType) ||
    mediaExtensions.has(extension) ||
    contentType === "application/pdf" ||
    contentType.startsWith("text/") ||
    textContentTypes.has(contentType) ||
    textExtensions.has(extension) ||
    extension === ".pdf"
  );
}

function rankCandidates(job: ChatbotJob) {
  const tokens = queryTokens(job.request);
  const candidates: AttachmentCandidate[] = [];
  const contextMessages = [
    ...(job.requestMessage ? [job.requestMessage] : []),
    ...job.messages,
  ];

  const seen = new Set<string>();
  for (const [messageIndex, message] of contextMessages.entries()) {
    const direct = message === job.requestMessage;
    for (const contextMessage of [
      message,
      ...(message.referencedMessage ? [message.referencedMessage] : []),
    ]) {
      for (const item of contextMessage.attachments) {
        if (seen.has(item.id)) continue;
        seen.add(item.id);
        candidates.push({
          attachment: item,
          direct,
          surroundingText:
            `${contextMessage.content} ${item.filename}`.toLocaleLowerCase(),
          order: messageIndex,
        });
      }
    }
  }

  return candidates
    .filter(({ attachment }) => isSupported(attachment))
    .sort((left, right) => {
      if (left.direct !== right.direct) {
        return Number(right.direct) - Number(left.direct);
      }
      const score = (candidate: AttachmentCandidate) =>
        tokens.reduce(
          (total, token) =>
            total + (candidate.surroundingText.includes(token) ? 1 : 0),
          0,
        );

      return score(right) - score(left) || right.order - left.order;
    })
    .slice(0, MAX_ATTACHMENTS);
}

function validateAttachmentUrl(value: string) {
  const url = new URL(value);
  if (
    url.protocol !== "https:" ||
    !ALLOWED_ATTACHMENT_HOSTS.has(url.hostname)
  ) {
    throw new Error("attachment URL is not an allowed Discord CDN URL");
  }
}

async function download(url: string, signal?: AbortSignal) {
  validateAttachmentUrl(url);
  const response = await fetch(url, {
    signal: signal
      ? AbortSignal.any([signal, AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS)])
      : AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS),
  });

  if (response.url) validateAttachmentUrl(response.url);

  if (!response.ok) {
    throw new Error(`download returned ${response.status}`);
  }

  const declaredSize = Number(response.headers.get("content-length") ?? 0);
  if (declaredSize > MAX_ATTACHMENT_BYTES) {
    throw new Error("attachment exceeds 20 MB");
  }

  const reader = response.body?.getReader();
  if (!reader) {
    return new Uint8Array();
  }

  const chunks: Uint8Array[] = [];
  let size = 0;

  for (;;) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }

    size += value.byteLength;
    if (size > MAX_ATTACHMENT_BYTES) {
      await reader.cancel();
      throw new Error("attachment exceeds 20 MB");
    }

    chunks.push(value);
  }

  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }

  return bytes;
}

function truncate(value: string, maximum = MAX_EXTRACTED_CHARACTERS) {
  return value.slice(0, maximum);
}

async function extractPdf(bytes: Uint8Array, maximum: number) {
  const document = await getDocument({
    data: bytes,
    useWorkerFetch: false,
  }).promise;
  const pages: string[] = [];
  let characterCount = 0;

  for (let pageNumber = 1; pageNumber <= document.numPages; pageNumber += 1) {
    const page = await document.getPage(pageNumber);
    const content = await page.getTextContent();
    const text = content.items
      .map((item) => ("str" in item ? item.str : ""))
      .join(" ");

    pages.push(`[Page ${pageNumber}] ${text}`);
    characterCount += text.length;
    if (characterCount >= maximum) {
      break;
    }
  }

  return truncate(pages.join("\n"), maximum);
}

async function extractText(
  attachment: ChatbotAttachment,
  bytes: Uint8Array,
  maximum: number,
) {
  const contentType = attachment.contentType?.toLocaleLowerCase() ?? "";
  const extension = extname(attachment.filename).toLocaleLowerCase();

  if (contentType === "application/pdf" || extension === ".pdf") {
    if (!new TextDecoder().decode(bytes.slice(0, 5)).startsWith("%PDF-")) {
      throw new Error("file does not contain PDF data");
    }
    return extractPdf(bytes, maximum);
  }

  return truncate(new TextDecoder().decode(bytes), maximum);
}

function safeFilename(index: number, filename: string) {
  const name = basename(filename).replace(/[^a-zA-Z0-9._-]/g, "_");
  return `${index}-${name || "attachment"}`;
}

export async function prepareAttachments(
  job: ChatbotJob,
  signal?: AbortSignal,
): Promise<PreparedAttachments> {
  const directory = await mkdtemp(join(tmpdir(), "minisago-chatbot-"));
  const outputsDirectory = join(directory, "outputs");
  await mkdir(outputsDirectory);
  const mediaManifestPath = join(directory, "media-manifest.json");
  const imagePaths: string[] = [];
  const mediaAttachments: Array<{
    id: string;
    filename: string;
    contentType?: string;
    size: number;
    storedFilename: string;
  }> = [];
  const textBlocks: string[] = [];
  const ignored: string[] = [];
  const candidates =
    job.purpose === undefined || job.purpose === "answer"
      ? rankCandidates(job)
      : [];
  let downloadedBytes = 0;
  let extractedCharacters = 0;

  try {
    for (const [index, candidate] of candidates.entries()) {
      signal?.throwIfAborted();
      const { attachment } = candidate;

      if (attachment.size > MAX_ATTACHMENT_BYTES) {
        ignored.push(
          `附件 ${attachment.filename} 超過 20 MB 我吃不下 換小一點的檔案吧`,
        );
        continue;
      }
      if (downloadedBytes + attachment.size > MAX_TOTAL_ATTACHMENT_BYTES) {
        ignored.push("這次的附件太多了 總共縮到 40 MB 以下再給我");
        continue;
      }

      try {
        const bytes = await download(attachment.url, signal);
        if (downloadedBytes + bytes.byteLength > MAX_TOTAL_ATTACHMENT_BYTES) {
          ignored.push("這次的附件太多了 總共縮到 40 MB 以下再給我");
          continue;
        }
        downloadedBytes += bytes.byteLength;
        const contentType = attachment.contentType?.toLocaleLowerCase() ?? "";
        const extension = extname(attachment.filename).toLocaleLowerCase();
        const path = join(directory, safeFilename(index, attachment.filename));
        await Bun.write(path, bytes);
        mediaAttachments.push({
          id: attachment.id,
          filename: attachment.filename,
          ...(attachment.contentType
            ? { contentType: attachment.contentType }
            : {}),
          size: bytes.byteLength,
          storedFilename: basename(path),
        });
        if (
          mediaContentTypes.has(contentType) ||
          mediaExtensions.has(extension)
        ) {
          if (
            imageContentTypes.has(contentType) ||
            imageExtensions.has(extension)
          ) {
            imagePaths.push(path);
          }
          continue;
        }

        const remaining = Math.min(
          MAX_EXTRACTED_CHARACTERS,
          MAX_TOTAL_EXTRACTED_CHARACTERS - extractedCharacters,
        );
        if (remaining <= 0) {
          ignored.push("我讀不完這麼多文字 拆成幾個檔案再給我");
          continue;
        }
        const text = await extractText(attachment, bytes, remaining);
        extractedCharacters += text.length;
        textBlocks.push(`Attachment: ${attachment.filename}\n${text}`);
      } catch (error) {
        if (signal?.aborted) throw error;
        console.warn(
          `Failed to analyze attachment ${attachment.filename}:`,
          error,
        );
        ignored.push(`附件 ${attachment.filename} 我打不開 換一個檔案給我試試`);
      }
    }
  } catch (error) {
    await rm(directory, { recursive: true, force: true });
    throw error;
  }

  await Bun.write(
    mediaManifestPath,
    JSON.stringify({
      version: 1,
      root: directory,
      outputDirectory: outputsDirectory,
      attachments: mediaAttachments,
    }),
  );

  return {
    directory,
    imagePaths,
    mediaManifestPath,
    outputsDirectory,
    textBlocks,
    ignored,
    cleanup: () => rm(directory, { recursive: true, force: true }),
  };
}

export const attachmentLimits = {
  count: MAX_ATTACHMENTS,
  bytes: MAX_ATTACHMENT_BYTES,
  totalBytes: MAX_TOTAL_ATTACHMENT_BYTES,
  extractedCharacters: MAX_EXTRACTED_CHARACTERS,
  totalExtractedCharacters: MAX_TOTAL_EXTRACTED_CHARACTERS,
};
