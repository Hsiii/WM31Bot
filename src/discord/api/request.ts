const DISCORD_API_BASE_URL = "https://discord.com/api/v10";

export type DiscordRequest = <T>(
  path: string,
  options?: {
    method?: string;
    body?: unknown;
    formData?: FormData;
    authenticated?: boolean;
  },
) => Promise<T>;

export function createDiscordRequest(botToken: string): DiscordRequest {
  async function discordRequest<T>(
    path: string,
    options: Parameters<DiscordRequest>[1] = {},
    retries = 3,
  ): Promise<T> {
    const headers: Record<string, string> = {};
    if (options.authenticated !== false) {
      headers.Authorization = `Bot ${botToken}`;
    }
    if (options.body !== undefined) {
      headers["Content-Type"] = "application/json";
    }

    const response = await fetch(`${DISCORD_API_BASE_URL}${path}`, {
      method: options.method ?? "GET",
      headers,
      body:
        options.formData ??
        (options.body === undefined ? undefined : JSON.stringify(options.body)),
    });

    if (response.status === 429 && retries > 0) {
      const payload = (await response.json()) as { retry_after?: number };
      await Bun.sleep(Math.ceil((payload.retry_after ?? 1) * 1_000));
      return discordRequest<T>(path, options, retries - 1);
    }
    if (!response.ok) {
      throw new Error(`${response.status} ${await response.text()}`);
    }
    if (response.status === 204) {
      return undefined as T;
    }
    return (await response.json()) as T;
  }

  return discordRequest;
}
