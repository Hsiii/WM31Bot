export type DiscordVoiceState = {
  guild_id?: string;
  user_id: string;
  channel_id: string | null;
};

export function buildVoiceStateUpdate(
  guildId: string,
  channelId: string | null,
) {
  return {
    op: 4,
    d: {
      guild_id: guildId,
      channel_id: channelId,
      self_mute: true,
      self_deaf: true,
    },
  };
}

export class VoiceStateTracker {
  private channelIdsByMember = new Map<string, string>();

  replaceGuild(guildId: string, voiceStates: DiscordVoiceState[]) {
    const prefix = `${guildId}:`;

    for (const key of this.channelIdsByMember.keys()) {
      if (key.startsWith(prefix)) {
        this.channelIdsByMember.delete(key);
      }
    }

    for (const voiceState of voiceStates) {
      this.observe({ ...voiceState, guild_id: guildId });
    }
  }

  observe(voiceState: DiscordVoiceState) {
    if (!voiceState.guild_id) {
      return;
    }

    const key = this.key(voiceState.guild_id, voiceState.user_id);

    if (voiceState.channel_id) {
      this.channelIdsByMember.set(key, voiceState.channel_id);
    } else {
      this.channelIdsByMember.delete(key);
    }
  }

  getChannelId(guildId: string, userId: string) {
    return this.channelIdsByMember.get(this.key(guildId, userId)) ?? null;
  }

  private key(guildId: string, userId: string) {
    return `${guildId}:${userId}`;
  }
}

export type VoiceChannelActionResult =
  | { status: "joined"; channelId: string }
  | { status: "left" }
  | { status: "member_not_in_voice" }
  | { status: "gateway_unavailable" };

export interface VoiceGateway {
  joinMemberVoiceChannel(
    guildId: string,
    userId: string,
  ): VoiceChannelActionResult;
  leaveVoiceChannel(guildId: string): VoiceChannelActionResult;
}

let activeVoiceGateway: VoiceGateway | null = null;

export function registerVoiceGateway(gateway: VoiceGateway | null) {
  activeVoiceGateway = gateway;
}

export function joinMemberVoiceChannel(guildId: string, userId: string) {
  return (
    activeVoiceGateway?.joinMemberVoiceChannel(guildId, userId) ?? {
      status: "gateway_unavailable" as const,
    }
  );
}

export function leaveVoiceChannel(guildId: string) {
  return (
    activeVoiceGateway?.leaveVoiceChannel(guildId) ?? {
      status: "gateway_unavailable" as const,
    }
  );
}
