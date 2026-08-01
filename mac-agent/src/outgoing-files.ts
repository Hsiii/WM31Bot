import { readFile, realpath, stat } from "node:fs/promises";
import { basename, extname, isAbsolute, relative, resolve } from "node:path";

import type { ChatbotOutgoingFile } from "../../lib/chatbot/protocol";

const MAX_OUTGOING_FILE_BYTES = 8 * 1024 * 1024;

const contentTypes = new Map([
  [".csv", "text/csv"],
  [
    ".docx",
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ],
  [".gif", "image/gif"],
  [".jpeg", "image/jpeg"],
  [".jpg", "image/jpeg"],
  [".json", "application/json"],
  [".md", "text/markdown"],
  [".mov", "video/quicktime"],
  [".mp3", "audio/mpeg"],
  [".mp4", "video/mp4"],
  [".pdf", "application/pdf"],
  [".png", "image/png"],
  [".txt", "text/plain"],
  [".webp", "image/webp"],
  [
    ".xlsx",
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ],
  [".zip", "application/zip"],
]);

function inside(root: string, candidate: string) {
  const pathFromRoot = relative(root, candidate);
  return (
    pathFromRoot === "" ||
    (!pathFromRoot.startsWith("..") && !isAbsolute(pathFromRoot))
  );
}

export function requestedFilePaths(content: string) {
  try {
    const value = JSON.parse(content) as Record<string, unknown>;
    const files = Array.isArray(value.files)
      ? value.files.filter((path): path is string => typeof path === "string")
      : [];
    delete value.files;
    return { content: JSON.stringify(value), files: files.slice(0, 1) };
  } catch {
    return { content, files: [] };
  }
}

export async function prepareOutgoingFiles(
  content: string,
  allowedRoots: string[],
): Promise<{ content: string; files: ChatbotOutgoingFile[] }> {
  const requested = requestedFilePaths(content);
  const roots = await Promise.all(
    allowedRoots.map((root) => realpath(root).catch(() => resolve(root))),
  );
  const files: ChatbotOutgoingFile[] = [];

  for (const requestedPath of requested.files) {
    if (!isAbsolute(requestedPath)) {
      throw new Error("Outgoing file path must be absolute.");
    }
    const path = await realpath(requestedPath);
    if (!roots.some((root) => inside(root, path))) {
      throw new Error(
        "Outgoing file is outside the configured Mac file folders.",
      );
    }
    const info = await stat(path);
    if (!info.isFile()) throw new Error("Outgoing path is not a regular file.");
    if (info.size > MAX_OUTGOING_FILE_BYTES) {
      throw new Error("Outgoing file exceeds Discord's 8 MB upload limit.");
    }
    const bytes = await readFile(path);
    files.push({
      filename: basename(path).slice(0, 255),
      contentType:
        contentTypes.get(extname(path).toLocaleLowerCase()) ||
        "application/octet-stream",
      size: bytes.byteLength,
      data: bytes.toString("base64"),
    });
  }

  return { content: requested.content, files };
}

export const outgoingFileLimits = {
  count: 1,
  bytes: MAX_OUTGOING_FILE_BYTES,
};
