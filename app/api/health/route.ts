import { getPublicDiscordSummary } from "@/lib/discord/env";

export const runtime = "nodejs";

export async function GET() {
  try {
    const summary = getPublicDiscordSummary();

    return Response.json({
      ok: true,
      configured: {
        applicationId: summary.hasApplicationId,
        publicKey: summary.hasPublicKey,
        botToken: summary.hasBotToken,
        guildId: summary.hasGuildId,
      },
      roleCount: summary.roleCount,
    });
  } catch (error) {
    return Response.json(
      {
        ok: false,
        error: error instanceof Error ? error.message : "Unknown error",
      },
      { status: 500 },
    );
  }
}