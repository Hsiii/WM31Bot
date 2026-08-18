export const DISCORD_GUILD_INSTALL = "0";

type DiscordApplication = {
  integration_types_config?: Record<string, Record<string, unknown>>;
};

type DiscordApplicationUpdate = {
  install_params: { scopes: string[]; permissions: string };
  integration_types_config: Record<string, Record<string, unknown>>;
  interactions_endpoint_url: null;
};

export function buildDiscordApplicationUpdate({
  application,
  scopes,
  permissions,
}: {
  application: DiscordApplication;
  scopes: string[];
  permissions: string;
}): DiscordApplicationUpdate {
  return {
    install_params: { scopes, permissions },
    integration_types_config: {
      ...application.integration_types_config,
      [DISCORD_GUILD_INSTALL]: {
        ...application.integration_types_config?.[DISCORD_GUILD_INSTALL],
        oauth2_install_params: { scopes, permissions },
      },
    },
    interactions_endpoint_url: null,
  };
}
