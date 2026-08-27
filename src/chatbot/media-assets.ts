import { randomUUID } from "node:crypto";

import type {
  ChatbotMediaRef,
  ChatbotMessage,
} from "../../contracts/worker-contract";

const MAX_INPUT_BYTES = 20 * 1024 * 1024;
const MAX_OUTPUT_BYTES = 8 * 1024 * 1024;
const ALLOWED_HOSTS = new Set(["cdn.discordapp.com", "media.discordapp.net"]);
const MEDIA_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/u;

type MediaAsset = ChatbotMediaRef &
  ({ url: string; bytes?: never } | { bytes: Uint8Array; url?: never });
type MediaFetch = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

function validateUrl(value: string) {
  const url = new URL(value);
  if (url.protocol !== "https:" || !ALLOWED_HOSTS.has(url.hostname)) {
    throw new Error("Media is not hosted on an allowed Discord CDN.");
  }
  return url.toString();
}

function validatedId(mediaId: string) {
  if (!MEDIA_ID.test(mediaId)) throw new Error("Invalid media ID.");
  return mediaId;
}

export async function readBoundedMediaBytes(
  response: Response,
  maximum: number,
) {
  const declared = Number(response.headers.get("content-length") ?? 0);
  if (declared > maximum) throw new Error("Media exceeds the size limit.");
  const reader = response.body?.getReader();
  if (!reader) return new Uint8Array();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > maximum) {
      await reader.cancel();
      throw new Error("Media exceeds the size limit.");
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

export class ChatbotMediaRegistry {
  private readonly assets = new Map<string, MediaAsset>();

  constructor(private readonly fetcher: MediaFetch = fetch) {}

  registerUrl(input: {
    mediaId?: string;
    filename: string;
    contentType?: string;
    size?: number;
    url: string;
  }): ChatbotMediaRef {
    const mediaId = validatedId(input.mediaId ?? `media-${randomUUID()}`);
    const asset: MediaAsset = {
      mediaId,
      filename: input.filename,
      ...(input.contentType ? { contentType: input.contentType } : {}),
      ...(input.size !== undefined ? { size: input.size } : {}),
      url: validateUrl(input.url),
    };
    this.assets.set(mediaId, asset);
    return this.reference(asset);
  }

  registerMessages(messages: ChatbotMessage[]) {
    const visit = (message: ChatbotMessage) => {
      for (const attachment of message.attachments) {
        this.registerUrl({
          mediaId: attachment.id,
          filename: attachment.filename,
          contentType: attachment.contentType,
          size: attachment.size,
          url: attachment.url,
        });
      }
      if (message.referencedMessage) visit(message.referencedMessage);
    };
    messages.forEach(visit);
  }

  put(input: {
    mediaId: string;
    filename: string;
    contentType?: string;
    bytes: Uint8Array;
  }): ChatbotMediaRef {
    const mediaId = validatedId(input.mediaId);
    if (this.assets.has(mediaId)) throw new Error("Media ID already exists.");
    if (!input.bytes.byteLength || input.bytes.byteLength > MAX_OUTPUT_BYTES) {
      throw new Error("Generated media exceeds the size limit.");
    }
    const asset: MediaAsset = {
      mediaId,
      filename: input.filename,
      ...(input.contentType ? { contentType: input.contentType } : {}),
      size: input.bytes.byteLength,
      bytes: input.bytes,
    };
    this.assets.set(mediaId, asset);
    return this.reference(asset);
  }

  get(mediaId: string) {
    const asset = this.assets.get(validatedId(mediaId));
    return asset ? this.reference(asset) : undefined;
  }

  async read(mediaId: string, fetcher: MediaFetch = this.fetcher) {
    const asset = this.assets.get(validatedId(mediaId));
    if (!asset) throw new Error("Media is unavailable for this request.");
    if (asset.bytes) return { ...this.reference(asset), bytes: asset.bytes };

    const response = await fetcher(asset.url, {
      signal: AbortSignal.timeout(20_000),
    });
    if (response.url) validateUrl(response.url);
    if (!response.ok) throw new Error("Discord could not download the media.");
    return {
      ...this.reference(asset),
      contentType:
        asset.contentType ?? response.headers.get("content-type") ?? undefined,
      bytes: await readBoundedMediaBytes(response, MAX_INPUT_BYTES),
    };
  }

  private reference(asset: MediaAsset): ChatbotMediaRef {
    return {
      mediaId: asset.mediaId,
      filename: asset.filename,
      ...(asset.contentType ? { contentType: asset.contentType } : {}),
      ...(asset.size !== undefined ? { size: asset.size } : {}),
    };
  }
}

export const chatbotMediaLimits = {
  inputBytes: MAX_INPUT_BYTES,
  outputBytes: MAX_OUTPUT_BYTES,
};
