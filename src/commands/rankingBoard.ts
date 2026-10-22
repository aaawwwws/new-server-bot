import {
  InteractionContextType,
  MessageFlags,
  PermissionFlagsBits,
  SlashCommandBuilder,
  type ChatInputCommandInteraction,
} from 'discord.js';
import { sendLog } from '../activityLog.js';
import { WEEKLY_ROLE_COUNT, WEEKLY_TOP_ROLE_NAME, placeBoard } from '../rankingBoard.js';

export const data = new SlashCommandBuilder()
  .setName('ranking-board')
  .setNameLocalizations({ ja: 'ランキング掲示板' })
  .setDescription('経験値ランキングの掲示板をこのチャンネルに設置します（管理者用）')
  .setContexts(InteractionContextType.Guild);

export const execute = async (interaction: ChatInputCommandInteraction<'cached'>): Promise<void> => {
  const channel = interaction.channel;
  if (!channel?.isSendable()) {
    await interaction.reply({ content: 'このチャンネルには掲示板を設置できません。', flags: MessageFlags.Ephemeral });
    return;
  }

  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  const { replaced } = await placeBoard(interaction.guild, channel);
  void sendLog(interaction.guild, 'panel', `${interaction.member} がランキング掲示板を設置しました`, interaction.member, { channel });

  const canManageRoles = interaction.guild.members.me?.permissions.has(PermissionFlagsBits.ManageRoles) ?? false;
  await interaction.editReply(
    [
      'ランキング掲示板を設置しました。今日・今週の経験値ランキングを5分ごとに更新します。',
      `毎週月曜0時（日本時間）に先週の結果をこのチャンネルに投稿し、1〜${WEEKLY_ROLE_COUNT}位に「${WEEKLY_TOP_ROLE_NAME}」ロールを付けます（なければ作ります）。`,
      ...(replaced ? ['前の掲示板は削除しました（1サーバーに1つです）。'] : []),
      ...(canManageRoles ? [] : ['⚠ Botにロールの管理権限がないため、このままではロールを付けられません。']),
    ].join('\n'),
  );
};
