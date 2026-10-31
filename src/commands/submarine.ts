import { InteractionContextType, MessageFlags, SlashCommandBuilder, type ChatInputCommandInteraction } from 'discord.js';
import { submarineScreen } from '../submarines.js';

// /潜水艦: 潜水艦の帰ってくる時間を登録する画面を開く（設定パネルの「🚢 潜水艦」と同じ）

export const data = new SlashCommandBuilder()
  .setName('submarine')
  .setNameLocalizations({ ja: '潜水艦' })
  .setDescription('潜水艦の帰ってくる時間を登録して、DMで知らせてもらいます（自分にだけ表示）')
  .setContexts(InteractionContextType.Guild);

export const execute = async (interaction: ChatInputCommandInteraction<'cached'>): Promise<void> => {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  await interaction.editReply(await submarineScreen(interaction.guild.id, interaction.user.id));
};
