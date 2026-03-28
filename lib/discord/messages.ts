import {
  CLEAR_ROLES_CUSTOM_ID,
  COMMAND_NAME,
  EPHEMERAL_FLAG,
  ROLE_SELECT_CUSTOM_ID,
} from "@/lib/discord/constants";
import type { ManagedRole } from "@/lib/discord/env";

function toSelectOption(role: ManagedRole, selectedRoleIds: Set<string>) {
  return {
    label: role.label,
    value: role.id,
    description: role.description,
    emoji: role.emoji ? { name: role.emoji } : undefined,
    default: selectedRoleIds.has(role.id),
  };
}

function buildComponents(managedRoles: ManagedRole[], currentRoleIds: string[]) {
  const selectedRoleIds = new Set(currentRoleIds);

  return [
    {
      type: 1,
      components: [
        {
          type: 3,
          custom_id: ROLE_SELECT_CUSTOM_ID,
          placeholder: "Choose your roles",
          min_values: 0,
          max_values: managedRoles.length,
          options: managedRoles.map((role) => toSelectOption(role, selectedRoleIds)),
        },
      ],
    },
    {
      type: 1,
      components: [
        {
          type: 2,
          style: 2,
          custom_id: CLEAR_ROLES_CUSTOM_ID,
          label: "Clear managed roles",
        },
      ],
    },
  ];
}

function defaultContent(managedRoles: ManagedRole[]) {
  return [
    `Use the menu below to manage your self-assignable roles.`,
    `The bot will sync only the ${managedRoles.length} managed roles exposed by /${COMMAND_NAME}.`,
  ].join(" ");
}

export function buildRolePickerResponse(managedRoles: ManagedRole[], currentRoleIds: string[]) {
  if (managedRoles.length === 0) {
    return {
      type: 4,
      data: {
        flags: EPHEMERAL_FLAG,
        content: "No self-assignable roles are configured yet.",
      },
    };
  }

  return {
    type: 4,
    data: {
      flags: EPHEMERAL_FLAG,
      content: defaultContent(managedRoles),
      components: buildComponents(managedRoles, currentRoleIds),
    },
  };
}

export function buildRoleUpdateResponse({
  managedRoles,
  currentRoleIds,
  message,
}: {
  managedRoles: ManagedRole[];
  currentRoleIds: string[];
  message: string;
}) {
  return {
    type: 7,
    data: {
      content: message,
      components: buildComponents(managedRoles, currentRoleIds),
    },
  };
}