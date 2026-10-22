import { InteractionContextType, MessageFlags, SlashCommandBuilder, type ChatInputCommandInteraction } from 'discord.js';
import { sendLog } from '../activityLog.js';
import { buildRecruitListEmbed } from '../recruitMessage.js';
import { findRecruitList, listActiveRecruits, saveRecruitList } from '../recruitStore.js';

export const data = new SlashCommandBuilder()
  .setName('recruit-list')
  .setNameLocalizations({ ja: '募集一覧' })
  .setDescription('募集中のパーティの一覧をこのチャンネルに設置します（自動で更新・管理者用）')
  .setContexts(InteractionContextType.Guild);

export const execute = async (interaction: ChatInputCommandInteraction<'cached'>): Promise<void> => {
  const channel = interaction.channel;
  if (!channel?.isSendable()) {
    await interaction.reply({ content: 'このチャンネルには一覧を設置できません。', flags: MessageFlags.Ephemeral });
    return;
  }
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  // 1サーバーに1つ。前の一覧があれば消す
  const old = await findRecruitList(interaction.guild.id);
  if (old) {
    const oldChannel = interaction.guild.channels.cache.get(old.channelId);
    if (oldChannel?.isTextBased()) await oldChannel.messages.delete(old.messageId).catch(() => undefined);
  }
  const recruits = await listActiveRecruits(interaction.guild.id);
  const message = await channel.send({
    embeds: [buildRecruitListEmbed(interaction.guild, recruits)],
    flags: MessageFlags.SuppressNotifications,
    allowedMentions: { parse: [] },
  });
  await saveRecruitList({ guildId: interaction.guild.id, channelId: channel.id, messageId: message.id });
  void sendLog(interaction.guild, 'panel', `${interaction.member} が募集一覧を設置しました`, interaction.member, {
    channel,
    links: [{ label: '一覧へ移動', url: message.url }],
  });
  await interaction.editReply(
    ['募集一覧を設置しました。募集が作られたり変わったりすると、自動で書き換わります。', ...(old ? ['前の一覧は削除しました（1サーバーに1つです）。'] : [])].join('\n'),
  );
};
