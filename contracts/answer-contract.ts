export const CHATBOT_REPLY_MAX_CHARACTERS = 1_900;
export const CHATBOT_REACTION_MAX_CHARACTERS = 100;

export type ChatbotAnswerDecision = {
  reply: string | null;
  reactionEmoji?: string;
};

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
      (!reply && !reaction)
    ) {
      return { reply: null };
    }
    return {
      reply: reply || null,
      ...(reaction ? { reactionEmoji: reaction } : {}),
    };
  } catch {
    return { reply: null };
  }
}
