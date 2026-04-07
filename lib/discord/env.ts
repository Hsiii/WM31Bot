import { TARGET_GUILD_ID, WORDLE_ROLE_ID, WORDLE_ROLE_LABEL } from "@/lib/discord/constants";

export type ManagedRole = {
  id: string;
  label: string;
  description?: string;
  emoji?: string;
};

type DiscordConfig = {
  applicationId: string;
  publicKey: string;
  botToken: string;
  guildId?: string;
  managedRoles: ManagedRole[];
};

function requireEnv(name: string) {
  const value = process.env[name]?.trim();

  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }

  return value;
}

function ensureRoleShape(input: unknown, index: number): ManagedRole {
  if (!input || typeof input !== "object") {
    throw new Error(`Role at index ${index} must be an object`);
  }

  const maybeRole = input as Record<string, unknown>;
  const id = String(maybeRole.id ?? "").trim();
  const label = String(maybeRole.label ?? "").trim();
  const description = typeof maybeRole.description === "string" ? maybeRole.description.trim() : undefined;
  const emoji = typeof maybeRole.emoji === "string" ? maybeRole.emoji.trim() : undefined;

  if (!id || !/^\d{17,20}$/.test(id)) {
    throw new Error(`Role at index ${index} is missing a valid Discord role ID`);
  }

  if (!label) {
    throw new Error(`Role at index ${index} is missing a label`);
  }

  return { id, label, description, emoji };
}

function getDefaultManagedRoles(): ManagedRole[] {
  return [
    {
      id: WORDLE_ROLE_ID,
      label: WORDLE_ROLE_LABEL,
      description: "Access to the Wordle channel",
      emoji: "🟩",
    },
  ];
}

export function parseManagedRoles(rawValue: string | undefined) {
  if (!rawValue) {
    return getDefaultManagedRoles();
  }

  let parsed: unknown;

  try {
    parsed = JSON.parse(rawValue);
  } catch {
    throw new Error("SELF_ASSIGNABLE_ROLES must be valid JSON")
  }

  if (!Array.isArray(parsed)) {
    throw new Error("SELF_ASSIGNABLE_ROLES must be a JSON array")
  }

  if (parsed.length === 0) {
    return [];
  }

  if (parsed.length > 25) {
    throw new Error("Discord select menus support at most 25 role options")
  }

  const roles = parsed.map((role, index) => ensureRoleShape(role, index));
  const ids = new Set<string>();

  for (const role of roles) {
    if (ids.has(role.id)) {
      throw new Error(`Duplicate role ID found in SELF_ASSIGNABLE_ROLES: ${role.id}`)
    }

    ids.add(role.id);
  }

  return roles;
}

export function getWordleRole(managedRoles: ManagedRole[]) {
  return managedRoles.find((role) => role.id === WORDLE_ROLE_ID) ?? getDefaultManagedRoles()[0];
}

export function getDiscordConfig(): DiscordConfig {
  return {
    applicationId: requireEnv("DISCORD_APPLICATION_ID"),
    publicKey: requireEnv("DISCORD_PUBLIC_KEY"),
    botToken: requireEnv("DISCORD_BOT_TOKEN"),
    guildId: process.env.DISCORD_GUILD_ID?.trim() || TARGET_GUILD_ID,
    managedRoles: parseManagedRoles(process.env.SELF_ASSIGNABLE_ROLES),
  };
}

export function getPublicDiscordSummary() {
  const roles = parseManagedRoles(process.env.SELF_ASSIGNABLE_ROLES);

  return {
    hasApplicationId: Boolean(process.env.DISCORD_APPLICATION_ID?.trim()),
    hasPublicKey: Boolean(process.env.DISCORD_PUBLIC_KEY?.trim()),
    hasBotToken: Boolean(process.env.DISCORD_BOT_TOKEN?.trim()),
    hasGuildId: Boolean(process.env.DISCORD_GUILD_ID?.trim()),
    roleCount: roles.length,
    roles,
  };
}
