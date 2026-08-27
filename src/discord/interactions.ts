import type { ChatbotOutgoingFile } from "../../contracts/worker-contract";
import type { DiscordRequest } from "../chatbot/chatbot-context";

export const ASK_COMMAND_NAME = "ask";
export const EPHEMERAL_MESSAGE_FLAG = 1 << 6;

export type DiscordApplicationCommandInteraction = {
  id: string;
  application_id: string;
  token: string;
  type: number;
  channel_id?: string;
  guild_id?: string;
  data?: {
    type?: number;
    name?: string;
    options?: Array<{
      type?: number;
      name?: string;
      value?: unknown;
    }>;
  };
  member?: {
    roles?: string[];
    nick?: string | null;
    user?: DiscordInteractionUser;
  };
  user?: DiscordInteractionUser;
};

type DiscordInteractionUser = {
  id?: string;
  username?: string;
  global_name?: string | null;
  bot?: boolean;
};

export function getAskPrompt(
  interaction: DiscordApplicationCommandInteraction,
) {
  if (
    interaction.type !== 2 ||
    interaction.data?.type !== 1 ||
    interaction.data.name !== ASK_COMMAND_NAME ||
    !interaction.channel_id
  ) {
    return null;
  }

  const prompt = interaction.data.options?.find(
    (option) => option.type === 3 && option.name === "prompt",
  )?.value;
  return typeof prompt === "string" && prompt.trim() ? prompt.trim() : null;
}

export function toInteractionMessage(
  interaction: DiscordApplicationCommandInteraction,
  prompt: string,
) {
  const user = interaction.member?.user ?? interaction.user;
  return {
    id: interaction.id,
    channel_id: interaction.channel_id!,
    ...(interaction.guild_id ? { guild_id: interaction.guild_id } : {}),
    content: prompt,
    timestamp: new Date().toISOString(),
    author: user,
    member: {
      nick: interaction.member?.nick,
      roles: interaction.member?.roles,
    },
  };
}

export async function deferEphemeralInteraction(
  interaction: DiscordApplicationCommandInteraction,
  discordRequest: DiscordRequest,
) {
  await discordRequest(
    `/interactions/${interaction.id}/${interaction.token}/callback`,
    {
      method: "POST",
      authenticated: false,
      body: {
        type: 5,
        data: { flags: EPHEMERAL_MESSAGE_FLAG },
      },
    },
  );
}

function responseBody(content: string | null, ephemeral: boolean) {
  return {
    ...(content ? { content } : {}),
    ...(ephemeral ? { flags: EPHEMERAL_MESSAGE_FLAG } : {}),
    allowed_mentions: { parse: [] },
  };
}

function responseForm(content: string | null, files: ChatbotOutgoingFile[]) {
  const form = new FormData();
  form.append("payload_json", JSON.stringify(responseBody(content, false)));
  for (const [index, file] of files.entries()) {
    form.append(
      `files[${index}]`,
      new Blob([Buffer.from(file.data, "base64")], {
        type: file.contentType,
      }),
      file.filename,
    );
  }
  return form;
}

export function createEphemeralInteractionResponder(
  interaction: DiscordApplicationCommandInteraction,
  discordRequest: DiscordRequest,
) {
  return async (
    content: string | string[] | null,
    files: ChatbotOutgoingFile[] = [],
  ) => {
    const contents = Array.isArray(content) ? content : [content];
    const firstContent = contents[0] ?? null;
    await discordRequest(
      `/webhooks/${interaction.application_id}/${interaction.token}/messages/@original`,
      {
        method: "PATCH",
        authenticated: false,
        ...(files.length
          ? { formData: responseForm(firstContent, files) }
          : { body: responseBody(firstContent, false) }),
      },
    );

    for (const followup of contents.slice(1)) {
      await discordRequest(
        `/webhooks/${interaction.application_id}/${interaction.token}`,
        {
          method: "POST",
          authenticated: false,
          body: responseBody(followup, true),
        },
      );
    }
  };
}
