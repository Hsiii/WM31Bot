export type RemoteMedia = {
  mediaId: string;
  filename: string;
  contentType?: string;
  bytes: Uint8Array;
};

export type MediaClient = {
  read: (mediaId: string) => Promise<RemoteMedia>;
  write: (media: RemoteMedia) => Promise<void>;
};

export function httpMediaClient(
  mcpUrl: string,
  token: string,
  fetcher: typeof fetch = fetch,
): MediaClient {
  const base = new URL("./media/", mcpUrl);
  const endpoint = (mediaId: string) =>
    new URL(encodeURIComponent(mediaId), base);
  const authorization = `Bearer ${token}`;

  return {
    async read(mediaId) {
      const response = await fetcher(endpoint(mediaId), {
        headers: { authorization },
        signal: AbortSignal.timeout(20_000),
      });
      if (!response.ok)
        throw new Error("Media is unavailable for this request.");
      return {
        mediaId,
        filename: decodeURIComponent(
          response.headers.get("x-minisago-filename") ?? mediaId,
        ),
        contentType: response.headers.get("content-type") ?? undefined,
        bytes: new Uint8Array(await response.arrayBuffer()),
      };
    },
    async write(media) {
      const response = await fetcher(endpoint(media.mediaId), {
        method: "POST",
        headers: {
          authorization,
          "content-type": media.contentType ?? "application/octet-stream",
          "x-minisago-filename": encodeURIComponent(media.filename),
        },
        body: media.bytes,
        signal: AbortSignal.timeout(20_000),
      });
      if (!response.ok) throw new Error("Could not publish generated media.");
    },
  };
}

export function mediaContentType(filename: string) {
  const extension = filename.split(".").at(-1)?.toLocaleLowerCase();
  return extension === "jpg" || extension === "jpeg"
    ? "image/jpeg"
    : extension === "png"
      ? "image/png"
      : extension === "webp"
        ? "image/webp"
        : extension === "gif"
          ? "image/gif"
          : extension === "mp3"
            ? "audio/mpeg"
            : extension === "mp4"
              ? "video/mp4"
              : undefined;
}
