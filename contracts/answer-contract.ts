export const CHATBOT_REPLY_MAX_CHARACTERS = 1_900;
export const CHATBOT_REACTION_MAX_CHARACTERS = 100;

export type ChatbotAnswerDecision = {
  reply: string | null;
  reactionEmoji?: string;
};

const SELF_NAME = /\b(?:MiniSago|Sago)\b|迷你西米露/u;
const FIRST_PERSON_NAMING =
  /\b(?:I am|I['’]m|my name(?: is|['’]s)|call me)\s+(?:MiniSago|Sago)\b|我(?:是|叫)\s*(?:MiniSago|Sago|迷你西米露)/giu;

export function enforceFirstPersonIdentity(reply: string) {
  const normalized = reply
    .replace(
      /\b(?:MiniSago|Sago)[\u2019']s\b/gu,
      (_match, offset: number, value: string) =>
        offset === 0 || /[.!?\n]\s*$/u.test(value.slice(0, offset))
          ? "My"
          : "my",
    )
    .replace(/迷你西米露的/gu, "我的");
  const unnestedSelfNames = normalized.replace(FIRST_PERSON_NAMING, "");
  return SELF_NAME.test(unnestedSelfNames) ? null : normalized;
}

export function parseChatbotAnswerDecision(
  content: string,
): ChatbotAnswerDecision {
  try {
    const value = JSON.parse(content) as {
      reply?: unknown;
      reaction?: unknown;
    };
    const reply =
      typeof value.reply === "string"
        ? value.reply.trim()
        : value.reply === null
          ? null
          : undefined;
    const safeReply = reply ? enforceFirstPersonIdentity(reply) : reply;
    const reaction =
      value.reaction &&
      typeof value.reaction === "object" &&
      "emoji" in value.reaction &&
      typeof value.reaction.emoji === "string"
        ? value.reaction.emoji.trim()
        : undefined;
    if (
      reply === undefined ||
      (reply !== null && reply.length > CHATBOT_REPLY_MAX_CHARACTERS) ||
      (value.reaction !== null &&
        (!reaction || reaction.length > CHATBOT_REACTION_MAX_CHARACTERS)) ||
      (!safeReply && !reaction)
    ) {
      return { reply: null };
    }
    return {
      reply: safeReply || null,
      ...(reaction ? { reactionEmoji: reaction } : {}),
    };
  } catch {
    return { reply: null };
  }
}
