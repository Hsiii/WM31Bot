import { readFile, realpath, stat } from "node:fs/promises";
import { basename, extname, isAbsolute, relative, resolve } from "node:path";

import type { ChatbotOutgoingFile } from "../../src/chatbot/protocol";

const MAX_OUTGOING_FILE_BYTES = 8 * 1024 * 1024;
const artifactIdPattern = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,254}$/u;
const generatedArtifactIdPattern = /^(?:media|python)-/u;
const generatedArtifactExtensions = new Set([
  ".csv",
  ".docx",
  ".gif",
  ".jpeg",
  ".jpg",
  ".mov",
  ".mp3",
  ".mp4",
  ".png",
  ".pdf",
  ".txt",
  ".webp",
  ".xlsx",
  ".zip",
]);

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

export function requestedArtifactIds(content: string) {
  try {
    const value = JSON.parse(content) as Record<string, unknown>;
    const artifacts = Array.isArray(value.artifacts)
      ? value.artifacts.filter(
          (id): id is string =>
            typeof id === "string" &&
            id !== "." &&
            id !== ".." &&
            artifactIdPattern.test(id) &&
            generatedArtifactIdPattern.test(id) &&
            generatedArtifactExtensions.has(extname(id).toLocaleLowerCase()),
        )
      : [];
    delete value.artifacts;
    return { content: JSON.stringify(value), artifacts: artifacts.slice(0, 1) };
  } catch {
    return { content, artifacts: [] };
  }
}

async function readOutgoingFile(path: string): Promise<ChatbotOutgoingFile> {
  const info = await stat(path);
  if (!info.isFile()) throw new Error("Outgoing path is not a regular file.");
  if (info.size > MAX_OUTGOING_FILE_BYTES) {
    throw new Error("Outgoing file exceeds Discord's 8 MB upload limit.");
  }
  const bytes = await readFile(path);
  return {
    filename: basename(path).slice(0, 255),
    contentType:
      contentTypes.get(extname(path).toLocaleLowerCase()) ||
      "application/octet-stream",
    size: bytes.byteLength,
    data: bytes.toString("base64"),
  };
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
    files.push(await readOutgoingFile(path));
  }

  return { content: requested.content, files };
}

export async function prepareGeneratedArtifacts(
  content: string,
  outputRoot: string,
): Promise<{ content: string; files: ChatbotOutgoingFile[] }> {
  const requested = requestedArtifactIds(content);
  const root = await realpath(outputRoot);
  const files: ChatbotOutgoingFile[] = [];

  for (const artifact of requested.artifacts) {
    const path = await realpath(resolve(root, artifact));
    if (!inside(root, path)) {
      throw new Error(
        "Generated artifact is outside the request output folder.",
      );
    }
    if (!generatedArtifactExtensions.has(extname(path).toLocaleLowerCase())) {
      throw new Error("Generated artifact has an unsupported output type.");
    }
    files.push(await readOutgoingFile(path));
  }

  return { content: requested.content, files };
}

export const outgoingFileLimits = {
  count: 1,
  bytes: MAX_OUTGOING_FILE_BYTES,
};
