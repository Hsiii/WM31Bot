import { describe, expect, test } from "bun:test";

import {
  EPHEMERAL_MESSAGE_FLAG,
  createEphemeralInteractionResponder,
  deferEphemeralInteraction,
  getAskPrompt,
  toInteractionMessage,
  type DiscordApplicationCommandInteraction,
} from "./interactions";

const interaction: DiscordApplicationCommandInteraction = {
  id: "1530000000000000000",
  application_id: "123456789012345678",
  token: "interaction-token",
  type: 2,
  channel_id: "channel-1",
  guild_id: "guild-1",
  data: {
    type: 1,
    name: "ask",
    options: [{ type: 3, name: "prompt", value: "  hello  " }],
  },
  member: {
    nick: "Sago",
    roles: ["role-1"],
    user: { id: "user-1", username: "sago" },
  },
};

describe("Discord /ask interactions", () => {
  test("extracts the prompt and creates a private chatbot invocation message", () => {
    expect(getAskPrompt(interaction)).toBe("hello");
    expect(toInteractionMessage(interaction, "hello")).toMatchObject({
      id: interaction.id,
      channel_id: "channel-1",
      guild_id: "guild-1",
      content: "hello",
      author: { id: "user-1", username: "sago" },
      member: { nick: "Sago", roles: ["role-1"] },
    });
    expect(
      getAskPrompt({
        ...interaction,
        data: { ...interaction.data, name: "other" },
      }),
    ).toBeNull();
  });

  test("defers with the ephemeral flag before work starts", async () => {
    const calls: Array<{ path: string; options: unknown }> = [];
    await deferEphemeralInteraction(interaction, async (path, options) => {
      calls.push({ path, options });
      return undefined as never;
    });

    expect(calls).toEqual([
      {
        path: `/interactions/${interaction.id}/${interaction.token}/callback`,
        options: {
          method: "POST",
          authenticated: false,
          body: {
            type: 5,
            data: { flags: EPHEMERAL_MESSAGE_FLAG },
          },
        },
      },
    ]);
  });

  test("edits the private original and keeps split followups ephemeral", async () => {
    const calls: Array<{ path: string; options: unknown }> = [];
    const respond = createEphemeralInteractionResponder(
      interaction,
      async (path, options) => {
        calls.push({ path, options });
        return undefined as never;
      },
    );

    await respond(["first", "second"]);

    expect(calls).toEqual([
      {
        path: `/webhooks/${interaction.application_id}/${interaction.token}/messages/@original`,
        options: {
          method: "PATCH",
          authenticated: false,
          body: {
            content: "first",
            allowed_mentions: { parse: [] },
          },
        },
      },
      {
        path: `/webhooks/${interaction.application_id}/${interaction.token}`,
        options: {
          method: "POST",
          authenticated: false,
          body: {
            content: "second",
            flags: EPHEMERAL_MESSAGE_FLAG,
            allowed_mentions: { parse: [] },
          },
        },
      },
    ]);
  });
});
