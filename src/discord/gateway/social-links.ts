const URL_PATTERN = /\bhttps?:\/\/[^\s<>"']+/gi;
const TRAILING_URL_PUNCTUATION = /[),.!?:;]+$/;

function urlWithoutTrailingPunctuation(candidate: string) {
  return candidate.replace(TRAILING_URL_PUNCTUATION, "");
}

function isInstagramHost(hostname: string) {
  const normalized = hostname.toLowerCase();

  return (
    normalized === "instagram.com" || normalized.endsWith(".instagram.com")
  );
}

function isTwitterHost(hostname: string) {
  const normalized = hostname.toLowerCase();

  return (
    normalized === "twitter.com" ||
    normalized.endsWith(".twitter.com") ||
    normalized === "x.com" ||
    normalized.endsWith(".x.com")
  );
}

function transformedUrl(
  rawUrl: string,
  matchesHost: (hostname: string) => boolean,
  transformHostname: (hostname: string) => string,
) {
  let parsed: URL;

  try {
    parsed = new URL(rawUrl);
  } catch {
    return null;
  }

  if (!["http:", "https:"].includes(parsed.protocol)) {
    return null;
  }

  if (!matchesHost(parsed.hostname)) {
    return null;
  }

  parsed.hostname = transformHostname(parsed.hostname);

  return parsed.toString();
}

function replyUrls(
  content: string,
  transform: (candidate: string) => string | null,
) {
  const urls: string[] = [];

  content.replace(URL_PATTERN, (candidate) => {
    const nextUrl = transform(urlWithoutTrailingPunctuation(candidate));

    if (nextUrl) {
      urls.push(nextUrl);
    }

    return candidate;
  });

  return urls;
}

export function getInstagramReplyUrls(content: string) {
  return replyUrls(content, (candidate) =>
    transformedUrl(candidate, isInstagramHost, (hostname) =>
      hostname.replace(/instagram\.com$/i, "kkinstagram.com"),
    ),
  );
}

export function getTwitterReplyUrls(content: string) {
  return replyUrls(content, (candidate) =>
    transformedUrl(candidate, isTwitterHost, () => "fxtwitter.com"),
  );
}
