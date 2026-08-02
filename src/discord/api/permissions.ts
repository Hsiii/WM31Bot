const ADMINISTRATOR = 1n << 3n;
const ADD_REACTIONS = 1n << 6n;
const VIEW_CHANNEL = 1n << 10n;
const READ_MESSAGE_HISTORY = 1n << 16n;

export type DiscordPermissionOverwrite = {
  id: string;
  type: 0 | 1;
  allow: string;
  deny: string;
};

export type DiscordPermissionRole = {
  id: string;
  permissions: string;
};

function permissionBits(value: string) {
  try {
    return BigInt(value);
  } catch {
    return 0n;
  }
}

function applyOverwrite(
  permissions: bigint,
  overwrite?: DiscordPermissionOverwrite,
) {
  if (!overwrite) return permissions;
  return (
    (permissions & ~permissionBits(overwrite.deny)) |
    permissionBits(overwrite.allow)
  );
}

export function channelPermissions({
  guildId,
  botUserId,
  memberRoleIds,
  roles,
  overwrites,
}: {
  guildId: string;
  botUserId: string;
  memberRoleIds: string[];
  roles: DiscordPermissionRole[];
  overwrites: DiscordPermissionOverwrite[];
}) {
  const roleIds = new Set(memberRoleIds);
  let permissions = permissionBits(
    roles.find((role) => role.id === guildId)?.permissions ?? "0",
  );

  for (const role of roles) {
    if (roleIds.has(role.id)) {
      permissions |= permissionBits(role.permissions);
    }
  }

  if ((permissions & ADMINISTRATOR) !== 0n) {
    return ~0n;
  }

  permissions = applyOverwrite(
    permissions,
    overwrites.find(
      (overwrite) => overwrite.type === 0 && overwrite.id === guildId,
    ),
  );

  let deniedByRoles = 0n;
  let allowedByRoles = 0n;
  for (const overwrite of overwrites) {
    if (overwrite.type !== 0 || !roleIds.has(overwrite.id)) continue;
    deniedByRoles |= permissionBits(overwrite.deny);
    allowedByRoles |= permissionBits(overwrite.allow);
  }
  permissions = (permissions & ~deniedByRoles) | allowedByRoles;

  return applyOverwrite(
    permissions,
    overwrites.find(
      (overwrite) => overwrite.type === 1 && overwrite.id === botUserId,
    ),
  );
}

export function canAddDiscordReactions(permissions: bigint) {
  const required = VIEW_CHANNEL | READ_MESSAGE_HISTORY | ADD_REACTIONS;
  return (permissions & required) === required;
}
