import { randomBytes, timingSafeEqual } from "node:crypto";
import { join } from "node:path";
import { z } from "zod";
import { voiceDebug, type VoiceDebugState } from "./state";

const TTL = 12 * 60 * 60_000;
const cookieName = "minisago_voice_debug";
const publicFiles: Record<string, [string, string]> = {
  "/voice-debug": ["index.html", "text/html; charset=utf-8"],
  "/voice-debug/": ["index.html", "text/html; charset=utf-8"],
  "/voice-debug/app.js": ["app.js", "text/javascript; charset=utf-8"],
  "/voice-debug/style.css": ["style.css", "text/css; charset=utf-8"],
};
export function createVoiceDebugHandler(
  state: VoiceDebugState = voiceDebug,
  token: () => string | undefined = () =>
    process.env.MINISAGO_VOICE_DEBUG_TOKEN?.trim(),
) {
  const sessions = new Map<string, number>();
  const failures = new Map<string, { count: number; until: number }>();
  return async (request: Request): Promise<Response> => {
    const url = new URL(request.url);
    const headers = {
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "no-referrer",
      "Content-Security-Policy":
        "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
    };
    const json = (
      value: unknown,
      status = 200,
      extra: Record<string, string> = {},
    ) => Response.json(value, { status, headers: { ...headers, ...extra } });
    const asset = publicFiles[url.pathname];
    if (asset && request.method === "GET")
      return new Response(Bun.file(join(import.meta.dir, asset[0])), {
        headers: { ...headers, "Content-Type": asset[1] },
      });
    const secret = token();
    if (!secret || secret.length < 32)
      return json(
        {
          error:
            "Voice diagnostics are disabled. Configure a dedicated debug token.",
        },
        503,
      );
    if (request.method !== "GET") {
      // Cookie-authenticated mutations must originate from this dashboard.
      const origin = request.headers.get("origin");
      const host = request.headers.get("host") ?? url.host;
      let originHost: string | undefined;
      try {
        originHost = origin ? new URL(origin).host : undefined;
      } catch {}
      if (
        originHost !== host ||
        request.headers.get("sec-fetch-site") === "cross-site"
      )
        return json({ error: "Invalid origin" }, 403);
    }
    const now = Date.now();
    for (const [id, expiry] of sessions) if (expiry <= now) sessions.delete(id);
    for (const [id, value] of failures)
      if (value.until <= now) failures.delete(id);
    const input = async () => {
      const reader = request.body?.getReader();
      if (!reader) throw new Error("Missing body");
      let bytes = 0;
      const chunks: Uint8Array[] = [];
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        bytes += value.length;
        if (bytes > 8192) {
          await reader.cancel();
          throw new Error("Request too large");
        }
        chunks.push(value);
      }
      return JSON.parse(Buffer.concat(chunks).toString());
    };
    try {
      if (
        url.pathname === "/api/voice-debug/login" &&
        request.method === "POST"
      ) {
        // Global bound is intentional: callers cannot bypass it with forged proxy headers.
        const attempts = failures.get("login");
        if (attempts && attempts.count >= 10)
          return json(
            { error: "Too many attempts. Try again in a minute." },
            429,
          );
        const value = z
          .object({ token: z.string().max(256) })
          .strict()
          .parse(await input());
        const supplied = Buffer.from(value.token);
        const expected = Buffer.from(secret);
        if (
          supplied.length !== expected.length ||
          !timingSafeEqual(supplied, expected)
        ) {
          failures.set("login", {
            count: (attempts?.count ?? 0) + 1,
            until: attempts?.until ?? now + 60_000,
          });
          return json({ error: "Incorrect access token" }, 401);
        }
        failures.delete("login");
        if (sessions.size >= 16) sessions.delete(sessions.keys().next().value!);
        const id = randomBytes(32).toString("hex");
        sessions.set(id, now + TTL);
        return json({ ok: true }, 200, {
          "Set-Cookie": `${cookieName}=${id}; HttpOnly; SameSite=Strict; Path=/api/voice-debug; Max-Age=${TTL / 1000}${process.env.NODE_ENV === "production" ? "; Secure" : ""}`,
        });
      }
      const cookie = request.headers
        .get("cookie")
        ?.split(";")
        .map((part) => part.trim())
        .find((part) => part.startsWith(`${cookieName}=`))
        ?.slice(cookieName.length + 1);
      if (!cookie || !sessions.has(cookie))
        return json({ error: "Sign in to view live voice diagnostics" }, 401);
      if (
        url.pathname === "/api/voice-debug/snapshot" &&
        request.method === "GET"
      )
        return json(state.snapshot());
      if (
        url.pathname === "/api/voice-debug/settings" &&
        request.method === "PATCH"
      ) {
        const value = z
          .object({
            revision: z.number().int().nonnegative(),
            settings: z.unknown(),
          })
          .strict()
          .parse(await input());
        if (value.revision !== state.snapshot().revision)
          return json(
            {
              error: "Settings changed in another tab. Reload before applying.",
            },
            409,
          );
        return json(state.updateSettings(value.settings, value.revision));
      }
      if (
        url.pathname === "/api/voice-debug/stop" &&
        request.method === "POST"
      ) {
        const value = z
          .object({ sessionId: z.string().uuid() })
          .strict()
          .parse(await input());
        return json({ ok: state.stop(value.sessionId) });
      }
      if (
        url.pathname === "/api/voice-debug/clear" &&
        request.method === "POST"
      ) {
        state.clear();
        return json({ ok: true });
      }
      if (
        url.pathname === "/api/voice-debug/logout" &&
        request.method === "POST"
      ) {
        sessions.delete(cookie);
        return json({ ok: true }, 200, {
          "Set-Cookie": `${cookieName}=; HttpOnly; SameSite=Strict; Path=/api/voice-debug; Max-Age=0`,
        });
      }
      return json({ error: "Not found" }, 404);
    } catch (error) {
      return json(
        {
          error:
            error instanceof z.ZodError
              ? "Invalid settings or request values"
              : "Invalid request",
        },
        400,
      );
    }
  };
}
export const handleVoiceDebugRequest = createVoiceDebugHandler();
