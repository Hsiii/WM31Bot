import { describe, expect, test } from "bun:test";

import type { ChatbotAccessConfig } from "../../src/chatbot/access";
import {
  ChatbotConversationTracker,
  canMemberSearchChannel,
  extractChatbotRequest,
  extractMentionRequest,
  executeChatbotAnswerDecision,
  formatDiscordAnswer,
  formatDiscordAnswers,
  getNearbyHumanMessages,
  getRecentHumanMessages,
  handleChatbotMention,
  isConversationContextMessage,
  isChatbotAuthorized,
  isHumanContextMessage,
  lookupGuildMembers,
  missingDeveloperRepositoryResponse,
  parseChatbotAnswerDecision,
  parseExecutionRoute,
  parsePreviousTraceLookup,
  postChatbotResponse,
  searchGuildMessages,
  toChatbotMessage,
} from "./chatbot";

const BOT_ID = "123456789012345678";
const ACCESS_CONFIG: ChatbotAccessConfig = {
  ownerUserId: "917446775873343600",
  guildIds: new Set([
    "917436845187563610",
    "1282936453134815275",
    "1439286996869713992",
    "1521168712579682567",
  ]),
  channelIds: new Set(["1517766866964316201"]),
};

describe("Discord chatbot", () => {
  test("continues the original requester's next message after an answer", () => {
    let now = 1_000;
    const conversations = new ChatbotConversationTracker(90_000, () => now);
    const followUp = {
      id: "follow-up-1",
      channel_id: "channel-1",
      guild_id: "917436845187563610",
      content: "那明天呢",
      timestamp: "2026-07-25T11:00:00.000Z",
      author: { id: "member-1", username: "Member" },
    };

    conversations.activate("channel-1", "member-1");

    expect(conversations.take(followUp)).toBe(true);
    expect(conversations.take({ ...followUp, id: "follow-up-2" })).toBe(false);

    conversations.activate("channel-1", "member-1");
    expect(
      conversations.take({
        ...followUp,
        id: "interruption-1",
        author: { id: "member-2", username: "Other member" },
      }),
    ).toBe(false);
    expect(conversations.take({ ...followUp, id: "follow-up-3" })).toBe(false);

    conversations.activate("channel-1", "member-1");
    now += 90_000;
    expect(conversations.take({ ...followUp, id: "follow-up-4" })).toBe(false);
  });

  test("accepts reply-only, reaction-only, and combined mention decisions", () => {
    expect(
      parseChatbotAnswerDecision(
        '{"reply":"看得到兩個","reaction":{"emoji":"sago:emoji-1"}}',
      ),
    ).toEqual({
      reply: "看得到兩個",
      reactionEmoji: "sago:emoji-1",
    });
    expect(
      parseChatbotAnswerDecision('{"reply":null,"reaction":{"emoji":"👀"}}'),
    ).toEqual({ reply: null, reactionEmoji: "👀" });
    expect(
      parseChatbotAnswerDecision('{"reply":"可以啊","reaction":null}'),
    ).toEqual({ reply: "可以啊" });
    expect(parseChatbotAnswerDecision("舊版純文字回答")).toEqual({
      reply: "舊版純文字回答",
    });
  });

  test("binds a proposed mention reaction to the current message", async () => {
    const calls: unknown[] = [];
    const capabilities = {
      expiresAt: Date.now() + 60_000,
      tools: [
        {
          name: "discord.add_reaction",
          risk: "ambient" as const,
          description: "react",
          inputSchema: {},
        },
      ],
      customEmojiValues: new Set(["sago:emoji-1"]),
    };

    const result = await executeChatbotAnswerDecision({
      content: '{"reply":"這顆可以用","reaction":{"emoji":"sago:emoji-1"}}',
      message: { id: "mention-1", channel_id: "channel-1" },
      reactionCapabilities: capabilities,
      reactionBroker: {
        addReaction: async (options) => {
          calls.push(options);
          return true;
        },
      },
      discordRequest: async () => undefined as never,
    });

    expect(result).toEqual({ reply: "這顆可以用", reacted: true });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      channelId: "channel-1",
      messageId: "mention-1",
      emoji: "sago:emoji-1",
    });
  });

  test("extracts a natural request from either Discord mention form", () => {
    expect(extractMentionRequest(`<@${BOT_ID}> summarize this`, BOT_ID)).toBe(
      "summarize this",
    );
    expect(extractMentionRequest(`hello <@!${BOT_ID}>`, BOT_ID)).toBe("hello");
    expect(extractMentionRequest("summarize this", BOT_ID)).toBeNull();
  });

  test("treats replies that ping MiniSago as chatbot requests", () => {
    const message = {
      id: "reply-1",
      channel_id: "channel-1",
      content: "再找一次",
      timestamp: "2026-07-20T11:00:00.000Z",
      author: { id: "user-1", username: "Hsi" },
      mentions: [{ id: BOT_ID }],
      referenced_message: {
        id: "bot-message-1",
        channel_id: "channel-1",
        content: "我剛剛沒找到",
        timestamp: "2026-07-20T10:59:00.000Z",
        author: { id: BOT_ID, username: "MiniSago", bot: true },
      },
    };

    expect(extractChatbotRequest(message, BOT_ID, ACCESS_CONFIG)).toBe(
      "再找一次",
    );
    expect(
      extractChatbotRequest(
        { ...message, content: undefined },
        BOT_ID,
        ACCESS_CONFIG,
      ),
    ).toBe("");
    expect(
      extractChatbotRequest(
        {
          ...message,
          referenced_message: {
            ...message.referenced_message,
            author: { id: "other-user", username: "Other" },
          },
        },
        BOT_ID,
        ACCESS_CONFIG,
      ),
    ).toBeNull();
    expect(
      extractChatbotRequest(
        { ...message, mentions: [] },
        BOT_ID,
        ACCESS_CONFIG,
      ),
    ).toBeNull();
  });

  test("treats only the owner's unmentioned DMs as chatbot requests", () => {
    const directMessage = {
      id: "dm-1",
      channel_id: "dm-channel-1",
      content: "幫我找一下",
      timestamp: "2026-07-22T11:00:00.000Z",
      author: { id: "917446775873343600", username: "Hsi" },
    };

    expect(extractChatbotRequest(directMessage, BOT_ID, ACCESS_CONFIG)).toBe(
      "幫我找一下",
    );
    expect(
      extractChatbotRequest(
        {
          ...directMessage,
          author: { id: "other-user", username: "Other" },
        },
        BOT_ID,
        ACCESS_CONFIG,
      ),
    ).toBeNull();
    expect(
      extractChatbotRequest(
        { ...directMessage, guild_id: "917436845187563610" },
        BOT_ID,
        ACCESS_CONFIG,
      ),
    ).toBeNull();
  });

  test("keeps the replied-to MiniSago message in request context", () => {
    const requestMessage = toChatbotMessage(
      {
        id: "reply-1",
        channel_id: "channel-1",
        content: "再找一次",
        timestamp: "2026-07-20T11:00:00.000Z",
        author: { id: "user-1", username: "Hsi" },
        referenced_message: {
          id: "bot-message-1",
          channel_id: "channel-1",
          content: "我剛剛沒找到",
          timestamp: "2026-07-20T10:59:00.000Z",
          author: { id: BOT_ID, username: "MiniSago", bot: true },
        },
      },
      BOT_ID,
    );

    expect(requestMessage.referencedMessage).toMatchObject({
      id: "bot-message-1",
      role: "assistant",
      author: "MiniSago",
      content: "我剛剛沒找到",
    });
  });

  test("authorizes configured guilds, channels, and the owner", () => {
    expect(
      isChatbotAuthorized("member-1", ACCESS_CONFIG, "917436845187563610"),
    ).toBe(true);
    expect(
      isChatbotAuthorized("member-2", ACCESS_CONFIG, "1282936453134815275"),
    ).toBe(true);
    expect(
      isChatbotAuthorized("member-3", ACCESS_CONFIG, "1439286996869713992"),
    ).toBe(true);
    expect(
      isChatbotAuthorized("member-4", ACCESS_CONFIG, "1521168712579682567"),
    ).toBe(true);
    expect(
      isChatbotAuthorized(
        "member-5",
        ACCESS_CONFIG,
        "other-guild",
        "1517766866964316201",
      ),
    ).toBe(true);
    expect(
      isChatbotAuthorized(
        "member-5",
        ACCESS_CONFIG,
        "other-guild",
        "other-channel",
      ),
    ).toBe(false);
    expect(isChatbotAuthorized("member-5", ACCESS_CONFIG, "other-guild")).toBe(
      false,
    );
    expect(isChatbotAuthorized("member-5", ACCESS_CONFIG)).toBe(false);
    expect(
      isChatbotAuthorized("917446775873343600", ACCESS_CONFIG, "other-guild"),
    ).toBe(true);
    expect(isChatbotAuthorized("917446775873343600", ACCESS_CONFIG)).toBe(true);
  });

  test("allows community code questions into the read-only chat path", async () => {
    const requests: Array<{ path: string; body: unknown }> = [];
    const handled = await handleChatbotMention({
      message: {
        id: "message-community-pr",
        channel_id: "channel-1",
        guild_id: "917436845187563610",
        content: `<@${BOT_ID}> review https://github.com/Hsiii/health-check-system/pull/42`,
        timestamp: "2026-07-20T11:00:00.000Z",
        author: { id: "member-1", username: "Member" },
      },
      botUserId: BOT_ID,
      accessConfig: ACCESS_CONFIG,
      discordRequest: async (path, options) => {
        requests.push({ path, body: options?.body });
        if (path.endsWith("?limit=1")) {
          return [{ id: "message-community-pr" }] as never;
        }
        return undefined as never;
      },
    });

    expect(handled).toBe(true);
    expect(requests.at(-1)).toEqual({
      path: "/channels/channel-1/messages",
      body: {
        content: "我現在沒接上工作機 晚點再叫我一次 💤",
        allowed_mentions: { parse: [] },
      },
    });
  });

  test("gives unauthorized guild members a safe Chinese reply", async () => {
    const requests: Array<{ path: string; body: unknown }> = [];
    const handled = await handleChatbotMention({
      message: {
        id: "message-unauthorized",
        channel_id: "channel-1",
        guild_id: "other-guild",
        content: `<@${BOT_ID}> help`,
        timestamp: "2026-07-20T11:00:00.000Z",
        author: { id: "other-user", username: "Other" },
      },
      botUserId: BOT_ID,
      accessConfig: ACCESS_CONFIG,
      discordRequest: async (path, options) => {
        requests.push({ path, body: options?.body });
        if (path.endsWith("?limit=1")) {
          return [{ id: "message-unauthorized" }] as never;
        }
        return undefined as never;
      },
    });

    expect(handled).toBe(true);
    expect(requests).toEqual([
      {
        path: "/channels/channel-1/messages?limit=1",
        body: undefined,
      },
      {
        path: "/channels/channel-1/messages",
        body: {
          content: "在這個伺服器裡我暫時只聽 <@917446775873343600> 的 抱歉啦",
          allowed_mentions: { parse: [] },
        },
      },
    ]);
  });

  test("responds to a MiniSago reply without requiring another mention", async () => {
    const requests: Array<{ path: string; body: unknown }> = [];
    const handled = await handleChatbotMention({
      message: {
        id: "reply-1",
        channel_id: "channel-1",
        guild_id: "917436845187563610",
        content: "再找一次",
        timestamp: "2026-07-20T11:00:00.000Z",
        author: { id: "member-1", username: "Member" },
        mentions: [{ id: BOT_ID }],
        referenced_message: {
          id: "bot-message-1",
          channel_id: "channel-1",
          content: "我剛剛沒找到",
          timestamp: "2026-07-20T10:59:00.000Z",
          author: { id: BOT_ID, username: "MiniSago", bot: true },
        },
      },
      botUserId: BOT_ID,
      accessConfig: ACCESS_CONFIG,
      discordRequest: async (path, options) => {
        requests.push({ path, body: options?.body });
        if (path.endsWith("?limit=1")) {
          return [{ id: "reply-1" }] as never;
        }
        return undefined as never;
      },
    });

    expect(handled).toBe(true);
    expect(requests.at(-1)).toEqual({
      path: "/channels/channel-1/messages",
      body: {
        content: "我現在沒接上工作機 晚點再叫我一次 💤",
        allowed_mentions: { parse: [] },
      },
    });
  });

  test("responds to the owner's DM without requiring a mention", async () => {
    const requests: Array<{ path: string; body: unknown }> = [];
    const handled = await handleChatbotMention({
      message: {
        id: "dm-1",
        channel_id: "dm-channel-1",
        content: "幫我找一下",
        timestamp: "2026-07-22T11:00:00.000Z",
        author: { id: "917446775873343600", username: "Hsi" },
      },
      botUserId: BOT_ID,
      accessConfig: ACCESS_CONFIG,
      discordRequest: async (path, options) => {
        requests.push({ path, body: options?.body });
        if (path.endsWith("?limit=1")) {
          return [{ id: "dm-1" }] as never;
        }
        return undefined as never;
      },
    });

    expect(handled).toBe(true);
    expect(requests.at(-1)).toEqual({
      path: "/channels/dm-channel-1/messages",
      body: {
        content: "我現在沒接上工作機 晚點再叫我一次 💤",
        allowed_mentions: { parse: [] },
      },
    });
  });

  test("uses a reply when newer channel messages make the relationship unclear", async () => {
    const requests: Array<{ path: string; body: unknown }> = [];
    await handleChatbotMention({
      message: {
        id: "message-unauthorized",
        channel_id: "channel-1",
        guild_id: "other-guild",
        content: `<@${BOT_ID}> help`,
        timestamp: "2026-07-20T11:00:00.000Z",
        author: { id: "other-user", username: "Other" },
      },
      botUserId: BOT_ID,
      accessConfig: ACCESS_CONFIG,
      discordRequest: async (path, options) => {
        requests.push({ path, body: options?.body });
        if (path.endsWith("?limit=1")) {
          return [{ id: "newer-message" }] as never;
        }
        return undefined as never;
      },
    });

    expect(requests.at(-1)).toMatchObject({
      path: "/channels/channel-1/messages",
      body: {
        message_reference: {
          message_id: "message-unauthorized",
          fail_if_not_exists: false,
        },
      },
    });
  });

  test("posts blank-line-separated answers sequentially", async () => {
    const requests: Array<{ path: string; body: unknown }> = [];
    const message = {
      id: "request-1",
      channel_id: "channel-1",
      content: `<@${BOT_ID}> help`,
      timestamp: "2026-07-20T11:00:00.000Z",
      author: { id: "user-1", username: "User" },
    };
    const contents = formatDiscordAnswers(
      "第一段\n還在第一段\n\n第二段\n\n\n第三段",
    );
    await postChatbotResponse(message, contents, async (path, options) => {
      requests.push({ path, body: options?.body });
      if (path.endsWith("?limit=1")) {
        return [{ id: "newer-message" }] as never;
      }
      return undefined as never;
    });

    expect(contents).toEqual(["第一段\n還在第一段", "第二段", "第三段"]);
    expect(requests.slice(1).map(({ body }) => body)).toEqual([
      {
        content: "第一段\n還在第一段",
        message_reference: {
          message_id: "request-1",
          fail_if_not_exists: false,
        },
        allowed_mentions: { parse: [], replied_user: true },
      },
      {
        content: "第二段",
        allowed_mentions: { parse: [] },
      },
      {
        content: "第三段",
        allowed_mentions: { parse: [] },
      },
    ]);
  });

  test("uploads a Mac file with the first Discord response", async () => {
    let uploaded: FormData | undefined;
    const message = {
      id: "request-file",
      channel_id: "channel-1",
      content: `<@${BOT_ID}> send the notes file`,
      timestamp: "2026-07-20T11:00:00.000Z",
      author: { id: ACCESS_CONFIG.ownerUserId, username: "Hsi" },
    };

    await postChatbotResponse(
      message,
      "found it",
      async (path, options) => {
        if (path.endsWith("?limit=1")) return [message] as never;
        uploaded = options?.formData;
        return undefined as never;
      },
      [
        {
          filename: "notes.txt",
          contentType: "text/plain",
          size: 5,
          data: Buffer.from("hello").toString("base64"),
        },
      ],
    );

    expect(uploaded).toBeDefined();
    expect(JSON.parse(String(uploaded!.get("payload_json")))).toEqual({
      content: "found it",
      allowed_mentions: { parse: [] },
    });
    const file = uploaded!.get("files[0]") as File;
    expect(file.name).toBe("notes.txt");
    expect(file.type).toStartWith("text/plain");
    expect(await file.text()).toBe("hello");
  });

  test("accepts only human context messages other than the request", () => {
    const base = {
      id: "message-1",
      channel_id: "channel-1",
      content: "hello",
      timestamp: "2026-07-20T11:00:00.000Z",
      author: { id: "user-1", username: "Hsi" },
    };

    expect(isHumanContextMessage(base, "request")).toBe(true);
    expect(isHumanContextMessage(base, "message-1")).toBe(false);
    expect(
      isHumanContextMessage(
        { ...base, author: { ...base.author, bot: true } },
        "request",
      ),
    ).toBe(false);
  });

  test("backfills beyond seven days until it has 100 human messages", async () => {
    const recentPage = Array.from({ length: 100 }, (_, index) => ({
      id: `recent-${index}`,
      channel_id: "channel-1",
      content: `recent ${index}`,
      timestamp: "2026-07-19T12:00:00.000Z",
      author: {
        id: `user-${index}`,
        username: `Recent ${index}`,
        bot: index % 2 === 1,
      },
    }));
    const olderPage = Array.from({ length: 50 }, (_, index) => ({
      id: `older-${index}`,
      channel_id: "channel-1",
      content: `older ${index}`,
      timestamp: "2026-07-01T12:00:00.000Z",
      author: { id: `older-user-${index}`, username: `Older ${index}` },
    }));
    const requestedPaths: string[] = [];

    const messages = await getRecentHumanMessages({
      channelId: "channel-1",
      requestMessageId: "request",
      botUserId: BOT_ID,
      now: new Date("2026-07-20T12:00:00.000Z"),
      discordRequest: async (path) => {
        requestedPaths.push(path);
        return (requestedPaths.length === 1 ? recentPage : olderPage) as never;
      },
    });

    expect(requestedPaths).toHaveLength(2);
    expect(messages).toHaveLength(100);
    expect(messages[0]?.id).toBe("older-49");
    expect(messages.at(-1)?.id).toBe("recent-0");
  });

  test("loads a small human context window around the request", async () => {
    const requestedPaths: string[] = [];
    const nearby = Array.from({ length: 25 }, (_, index) => ({
      id: index === 4 ? "request" : `message-${index}`,
      channel_id: "channel-1",
      content: `message ${index}`,
      timestamp: `2026-07-20T11:${String(59 - index).padStart(2, "0")}:00.000Z`,
      author: {
        id: `user-${index}`,
        username: `User ${index}`,
        bot: index === 3,
      },
    }));

    const messages = await getNearbyHumanMessages({
      channelId: "channel-1",
      requestMessageId: "request",
      botUserId: BOT_ID,
      discordRequest: async (path) => {
        requestedPaths.push(path);
        return nearby as never;
      },
    });

    expect(requestedPaths).toEqual([
      "/channels/channel-1/messages?around=request&limit=25",
    ]);
    expect(messages).toHaveLength(20);
    expect(messages[0]?.id).toBe("message-21");
    expect(messages.at(-1)?.id).toBe("message-0");
    expect(messages.some((message) => message.id === "request")).toBe(false);
    expect(messages.some((message) => message.id === "message-3")).toBe(false);
  });

  test("keeps MiniSago replies as assistant context but excludes other bots", () => {
    const base = {
      id: "message-1",
      channel_id: "channel-1",
      content: "earlier answer",
      timestamp: "2026-07-20T11:00:00.000Z",
      author: { id: BOT_ID, username: "MiniSago", bot: true },
    };

    expect(isConversationContextMessage(base, "request", BOT_ID)).toBe(true);
    expect(
      isConversationContextMessage(
        { ...base, author: { ...base.author, id: "other-bot" } },
        "request",
        BOT_ID,
      ),
    ).toBe(false);
    expect(toChatbotMessage(base, BOT_ID).role).toBe("assistant");
  });

  test("includes Discord server and global display names as author aliases", () => {
    const message = toChatbotMessage({
      id: "message-1",
      channel_id: "channel-1",
      content: "hello",
      timestamp: "2026-07-20T11:00:00.000Z",
      author: {
        id: "user-1",
        username: "daniel_account",
        global_name: "Daniel",
      },
      member: { nick: "午前" },
    });

    expect(message.author).toBe("午前");
    expect(message.authorAliases).toEqual(["午前", "Daniel", "daniel_account"]);
    expect(
      toChatbotMessage({
        id: "message-2",
        channel_id: "channel-1",
        content: "hello again",
        timestamp: "2026-07-20T11:01:00.000Z",
        author: { id: "user-1", username: "Daniel", global_name: "daniel" },
      }).authorAliases,
    ).toBeUndefined();
  });

  test("accepts only structured previous-trace lookup results", () => {
    const trace = {
      contextMessageCount: 20,
      searchQueries: [],
      searchResultCount: 0,
      memberQueries: [],
      elapsedMs: 1_200,
      model: "test-model",
      promptVersion: 20,
    };
    expect(
      parsePreviousTraceLookup(JSON.stringify({ status: "complete", trace })),
    ).toEqual({ status: "complete", trace });
    expect(parsePreviousTraceLookup('{"status":"not_found"}')).toEqual({
      status: "not_found",
    });
    expect(parsePreviousTraceLookup("not json")).toEqual({
      status: "unavailable",
    });
  });

  test("validates the router's proposed mode, target, repository, and mutation", () => {
    const repositories = ["Hsiii/mini-sago", "Kiwi/backend"];
    expect(
      parseExecutionRoute(
        '{"mode":"dev","target":"default","repository":"Hsiii/mini-sago","mutationScope":null,"reason":"PR review"}',
        repositories,
      ),
    ).toEqual({
      mode: "dev",
      target: "default",
      repository: "Hsiii/mini-sago",
    });
    expect(
      parseExecutionRoute(
        '{"mode":"chat","target":"default","repository":"Hsiii/mini-sago","mutationScope":"code","reason":"code change"}',
        repositories,
      ),
    ).toEqual({
      mode: "dev",
      target: "default",
      mutationScope: "code",
      repository: "Hsiii/mini-sago",
    });
    expect(
      parseExecutionRoute(
        '{"mode":"dev","target":"default","repository":"Kiwi/backend","mutationScope":"issue","reason":"issue update"}',
        repositories,
      ),
    ).toEqual({
      mode: "dev",
      target: "default",
      mutationScope: "issue",
      repository: "Kiwi/backend",
    });
    expect(
      parseExecutionRoute(
        '{"mode":"dev","target":"mac","repository":"invented/private","mutationScope":null,"reason":"repo work"}',
        repositories,
      ),
    ).toEqual({
      mode: "dev",
      target: "mac",
    });
    expect(parseExecutionRoute("not json", repositories)).toEqual({
      mode: "chat",
      target: "default",
    });
  });

  test("asks for a repository instead of dispatching an invalid dev job", () => {
    expect(missingDeveloperRepositoryResponse("dev")).toBe(
      "這題要碰程式碼 但我還不知道是哪個 GitHub repo\n告訴我是哪個 我就能繼續",
    );
    expect(
      missingDeveloperRepositoryResponse("dev", undefined, [
        "Hsiii/mini-sago",
        "Kiwi/backend",
      ]),
    ).toBe(
      "這題要碰程式碼 但我還不知道是哪個 GitHub repo\n目前可用的有 `Hsiii/mini-sago` `Kiwi/backend`\n告訴我是哪個 我就能繼續",
    );
    expect(
      missingDeveloperRepositoryResponse("dev", "Hsiii/mini-sago"),
    ).toBeUndefined();
    expect(missingDeveloperRepositoryResponse("chat")).toBeUndefined();
  });

  test("looks up Discord member aliases without classifying the request", async () => {
    const paths: string[] = [];
    const results = await lookupGuildMembers({
      guildId: "guild-1",
      queries: ["kiseki", "<@123456789012345678>"],
      discordRequest: async (path) => {
        paths.push(path);
        const member = {
          nick: "Kiseki",
          user: {
            id: "123456789012345678",
            username: "kiseki_account",
            global_name: "Daniel",
          },
        };
        return (path.includes("/members/search?") ? [member] : member) as never;
      },
    });

    expect(paths[0]).toContain("/members/search?query=kiseki");
    expect(paths[1]).toBe("/guilds/guild-1/members/123456789012345678");
    expect(results).toEqual([
      {
        query: "kiseki",
        names: ["Kiseki", "Daniel", "kiseki_account"],
      },
      {
        query: "<@123456789012345678>",
        names: ["Kiseki", "Daniel", "kiseki_account"],
      },
    ]);
  });

  test("preserves the model's punctuation and line breaks", () => {
    const answer =
      "重新查完整一點，6uc 應該是午前。\n最直接：有人說「6uc是午前」。";

    expect(formatDiscordAnswer(answer)).toBe(answer);
  });

  test("searches the guild and returns channel names and safe jump links", async () => {
    const requestedPaths: string[] = [];
    const results = await searchGuildMessages({
      guildId: "guild-1",
      requesterUserId: "owner-1",
      requesterRoleIds: ["role-1"],
      currentChannelId: "channel-1",
      requestMessageId: "request-1",
      queries: [
        {
          author: "Daniel",
          mentions: "Daniel",
          has: ["image"],
        },
      ],
      discordRequest: async (path) => {
        requestedPaths.push(path);
        if (path.includes("/members/search?")) {
          return [
            {
              nick: "Daniel",
              user: { id: "user-1", username: "daniel" },
            },
          ] as never;
        }
        if (path === "/guilds/guild-1/roles") {
          return [
            { id: "guild-1", permissions: "0" },
            { id: "role-1", permissions: "66560" },
          ] as never;
        }
        if (path === "/guilds/guild-1/channels") {
          return [
            { id: "channel-1", name: "memes", type: 0 },
            {
              id: "hidden-1",
              name: "staff",
              type: 0,
              permission_overwrites: [
                { id: "guild-1", type: 0, allow: "0", deny: "1024" },
              ],
            },
          ] as never;
        }

        return {
          total_results: 1,
          messages: [
            [
              {
                id: "message-1",
                channel_id: "channel-1",
                content: "",
                timestamp: "2026-07-01T12:00:00.000Z",
                author: { id: "user-1", global_name: "Daniel" },
                attachments: [
                  {
                    id: "attachment-1",
                    filename: "meme.png",
                    content_type: "image/png",
                    size: 1234,
                    url: "https://cdn.discordapp.com/meme.png",
                  },
                ],
              },
            ],
          ],
        } as never;
      },
    });

    expect(requestedPaths).toHaveLength(4);
    expect(requestedPaths[3]).toContain("channel_id=channel-1");
    expect(requestedPaths[3]).not.toContain("hidden-1");
    expect(requestedPaths[3]).toContain("author_id=user-1");
    expect(requestedPaths[3]).toContain("mentions=user-1");
    expect(requestedPaths[3]).toContain("has=image");
    expect(results).toHaveLength(1);
    expect(results[0]?.channelName).toBe("memes");
    expect(results[0]?.jumpUrl).toBe(
      "https://discord.com/channels/guild-1/channel-1/message-1",
    );
  });

  test("uses the requester directly for Chinese self-reference", async () => {
    const requestedPaths: string[] = [];
    let searchRequestCount = 0;

    const results = await searchGuildMessages({
      guildId: "guild-1",
      requesterUserId: "owner-1",
      requesterRoleIds: ["role-1"],
      currentChannelId: "channel-2",
      requestMessageId: "request-1",
      queries: [
        { author: "self", content: "新 app" },
        { author: "self", content: "app", has: ["link"] },
      ],
      discordRequest: async (path) => {
        requestedPaths.push(path);
        if (path === "/guilds/guild-1/roles") {
          return [
            { id: "guild-1", permissions: "0" },
            { id: "role-1", permissions: "66560" },
          ] as never;
        }
        if (path === "/guilds/guild-1/channels") {
          return [{ id: "channel-2", name: "projects", type: 0 }] as never;
        }

        searchRequestCount += 1;
        const id = searchRequestCount === 1 ? "request-1" : "target-1";
        return {
          total_results: 1,
          messages: [
            [
              {
                id,
                channel_id: "channel-2",
                content: searchRequestCount === 1 ? "新 app" : "app launch",
                timestamp: "2026-07-01T12:00:00.000Z",
                author: { id: "owner-1", username: "Hsi" },
              },
            ],
          ],
        } as never;
      },
    });

    expect(requestedPaths).toHaveLength(4);
    expect(requestedPaths[2]).not.toContain("/members/search");
    expect(requestedPaths[2]).toContain("author_id=owner-1");
    expect(requestedPaths[2]).toContain("content=%E6%96%B0+app");
    expect(requestedPaths[3]).toContain("content=app");
    expect(requestedPaths[3]).toContain("has=link");
    expect(results.map((result) => result.id)).toEqual(["target-1"]);
    expect(results[0]?.channelName).toBe("projects");
  });

  test("preserves attachments and an older referenced human message", () => {
    expect(
      toChatbotMessage({
        id: "message-2",
        channel_id: "channel-1",
        content: "see this",
        timestamp: "2026-07-20T11:00:00.000Z",
        author: { id: "user-1", global_name: "Hsi" },
        attachments: [
          {
            id: "attachment-1",
            filename: "notes.pdf",
            content_type: "application/pdf",
            size: 1234,
            url: "https://cdn.discordapp.com/notes.pdf",
          },
        ],
        reactions: [
          {
            count: 3,
            emoji: { id: null, name: "😂" },
          },
          {
            count: 2,
            me: true,
            emoji: { id: "emoji-1", name: "sago", animated: true },
          },
        ],
        referenced_message: {
          id: "message-1",
          channel_id: "channel-1",
          content: "older context",
          timestamp: "2026-07-18T11:00:00.000Z",
          author: { id: "user-2", username: "Daniel" },
        },
      }),
    ).toEqual({
      id: "message-2",
      role: "user",
      author: "Hsi",
      timestamp: "2026-07-20T11:00:00.000Z",
      content: "see this",
      attachments: [
        {
          id: "attachment-1",
          filename: "notes.pdf",
          contentType: "application/pdf",
          size: 1234,
          url: "https://cdn.discordapp.com/notes.pdf",
        },
      ],
      reactions: [
        { emoji: "😂", count: 3 },
        { emoji: "<a:sago:emoji-1>", count: 2, me: true },
      ],
      referencedMessage: {
        id: "message-1",
        role: "user",
        author: "Daniel",
        timestamp: "2026-07-18T11:00:00.000Z",
        content: "older context",
        attachments: [],
      },
    });
  });

  test("applies role and member channel overwrites before guild search", () => {
    const roles = [
      { id: "guild-1", permissions: "66560" },
      { id: "role-1", permissions: "0" },
    ];
    const channel = {
      id: "private-1",
      type: 0,
      permission_overwrites: [
        { id: "guild-1", type: 0, allow: "0", deny: "1024" },
        { id: "owner-1", type: 1, allow: "1024", deny: "0" },
      ],
    };

    expect(
      canMemberSearchChannel({
        guildId: "guild-1",
        userId: "owner-1",
        roleIds: ["role-1"],
        roles,
        channel,
      }),
    ).toBe(true);
    expect(
      canMemberSearchChannel({
        guildId: "guild-1",
        userId: "other-1",
        roleIds: ["role-1"],
        roles,
        channel,
      }),
    ).toBe(false);
  });

  test("shortens answers to one Discord message", () => {
    expect(formatDiscordAnswer(" short answer ")).toBe("short answer");
    expect(formatDiscordAnswer("   ")).toBe("我剛剛腦袋一片空白 再問我一次");
    const longAnswer = "a".repeat(2_100);
    expect(formatDiscordAnswer(longAnswer)).toHaveLength(2_000);
    expect(formatDiscordAnswer(longAnswer).endsWith("…")).toBe(true);
  });
});
