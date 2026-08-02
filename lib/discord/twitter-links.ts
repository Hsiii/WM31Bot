const URL_PATTERN = /\bhttps?:\/\/[^\s<>"']+/gi;
const TRAILING_URL_PUNCTUATION = /[),.!?:;]+$/;

function isTwitterHost(hostname: string) {
  const normalized = hostname.toLowerCase();

  return (
    normalized === "twitter.com" ||
    normalized.endsWith(".twitter.com") ||
    normalized === "x.com" ||
    normalized.endsWith(".x.com")
  );
}

function toFxTwitterUrl(rawUrl: string) {
  let parsed: URL;

  try {
    parsed = new URL(rawUrl);
  } catch {
    return null;
  }

  if (!["http:", "https:"].includes(parsed.protocol)) {
    return null;
  }

  if (!isTwitterHost(parsed.hostname)) {
    return null;
  }

  parsed.hostname = "fxtwitter.com";

  return parsed.toString();
}

export function getTwitterReplyUrls(content: string) {
  const urls: string[] = [];

  content.replace(URL_PATTERN, (candidate) => {
    const urlText = candidate.replace(TRAILING_URL_PUNCTUATION, "");
    const nextUrl = toFxTwitterUrl(urlText);

    if (nextUrl) {
      urls.push(nextUrl);
    }

    return candidate;
  });

  return urls;
}
