import { EPHEMERAL_FLAG } from "@/lib/discord/constants";

export function buildRoleCommandResponse(message: string) {
  return {
    type: 4,
    data: {
      flags: EPHEMERAL_FLAG,
      content: message,
    },
  };
}
