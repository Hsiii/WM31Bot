import type { ChatbotMessage } from "./protocol";

export const CHATBOT_CONTEXT_BUDGETS = {
  currentRequestCharacters: 12_000,
  messageCharacters: 4_000,
  initialMessagesCharacters: 32_000,
  extractedAttachmentsCharacters: 24_000,
  availableToolsCharacters: 8_000,
  ignoredAttachmentsCharacters: 2_000,
  initialContextCharacters: 64_000,
  resolvedContextCharacters: 48_000,
} as const;

export type ContextOmission = {
  section: string;
  omittedItems: number;
  omittedCharacters: number;
  reason: "item_limit" | "section_budget" | "total_budget";
};

export function truncateContextText(value: string, maximum: number) {
  if (value.length <= maximum) return value;
  return `${value.slice(0, Math.max(0, maximum - 1))}\u2026`;
}

function boundedMessage(message: ChatbotMessage): ChatbotMessage {
  return {
    ...message,
    content: truncateContextText(
      message.content,
      CHATBOT_CONTEXT_BUDGETS.messageCharacters,
    ),
    referencedMessage: message.referencedMessage
      ? boundedMessage(message.referencedMessage)
      : undefined,
  };
}

export function budgetMessages(
  messages: ChatbotMessage[],
  maximum: number = CHATBOT_CONTEXT_BUDGETS.initialMessagesCharacters,
) {
  const kept: ChatbotMessage[] = [];
  let used = 2;
  let omittedCharacters = 0;

  for (const message of [...messages].reverse()) {
    const bounded = boundedMessage(message);
    const size = JSON.stringify(bounded).length + (kept.length ? 1 : 0);
    if (used + size <= maximum) {
      kept.unshift(bounded);
      used += size;
    } else {
      omittedCharacters += JSON.stringify(message).length;
    }
  }

  return {
    messages: kept,
    omission:
      kept.length === messages.length
        ? undefined
        : {
            section: "discord_messages",
            omittedItems: messages.length - kept.length,
            omittedCharacters,
            reason: "section_budget" as const,
          },
  };
}

export function budgetTextItems(
  section: string,
  items: string[],
  maximum: number,
) {
  const kept: string[] = [];
  let used = 0;
  let omittedCharacters = 0;

  for (const item of items) {
    const remaining = maximum - used;
    if (remaining <= 0) {
      omittedCharacters += item.length;
      continue;
    }
    const bounded = truncateContextText(item, remaining);
    kept.push(bounded);
    used += bounded.length;
    if (bounded.length < item.length)
      omittedCharacters += item.length - bounded.length;
  }

  return {
    items: kept,
    omission:
      omittedCharacters === 0
        ? undefined
        : {
            section,
            omittedItems: items.length - kept.length,
            omittedCharacters,
            reason: "section_budget" as const,
          },
  };
}

export function budgetJsonItems<T>(
  section: string,
  items: T[],
  maximum: number,
) {
  const kept: T[] = [];
  let used = 2;
  let omittedCharacters = 0;

  for (const item of items) {
    const size = JSON.stringify(item).length + (kept.length ? 1 : 0);
    if (used + size <= maximum) {
      kept.push(item);
      used += size;
    } else {
      omittedCharacters += JSON.stringify(item).length;
    }
  }

  return {
    items: kept,
    omission:
      kept.length === items.length
        ? undefined
        : {
            section,
            omittedItems: items.length - kept.length,
            omittedCharacters,
            reason: "section_budget" as const,
          },
  };
}
