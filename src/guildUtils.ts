import { ChannelType, PermissionFlagsBits, type Guild, type TextChannel } from 'discord.js';

/** 名前でテキストチャンネルを探す */
export const findTextChannel = (guild: Guild, name: string): TextChannel | undefined =>
  guild.channels.cache.find(
    (channel): channel is TextChannel => channel.type === ChannelType.GuildText && channel.name === name,
  );

/** Bot がそのチャンネルに埋め込み付きで書き込めるか */
export const canBotPost = (channel: TextChannel): boolean => {
  const me = channel.guild.members.me;
  return (
    !!me &&
    channel
      .permissionsFor(me)
      .has([PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.EmbedLinks])
  );
};
