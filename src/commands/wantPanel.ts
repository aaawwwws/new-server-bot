import { InteractionContextType, MessageFlags, SlashCommandBuilder, type ChatInputCommandInteraction } from 'discord.js';
import { sendLog } from '../activityLog.js';
import { adminRoleWarnings } from '../permissions.js';
import { DEFAULT_ITEMS, placeWantPanel } from '../wantList.js';

export const data = new SlashCommandBuilder()
  .setName('want-panel')
  .setNameLocalizations({ ja: 'やりたいコンテンツパネル' })
  .setDescription('みんなのやりたいコンテンツを人数順に並べるパネルを、このチャンネルに設置します（管理者用）')
  .setContexts(InteractionContextType.Guild);

export const execute = async (interaction: ChatInputCommandInteraction<'cached'>): Promise<void> => {
  const channel = interaction.channel;
  if (!channel?.isSendable()) {
    await interaction.reply({ content: 'このチャンネルにはパネルを設置できません。', flags: MessageFlags.Ephemeral });
    return;
  }
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  // パネルの設置で通知が飛ばないよう、サイレントメッセージで送る。場所を覚えておき、選ばれるたびに書き換える
  const { message, seeded } = await placeWantPanel(interaction.guild, channel.id, (payload) =>
    channel.send({ ...payload, flags: MessageFlags.SuppressNotifications }),
  );
  void sendLog(interaction.guild, 'panel', `${interaction.member} がやりたいコンテンツのパネルを設置しました`, interaction.member, {
    channel,
    links: [{ label: 'パネルへ移動', url: `https://discord.com/channels/${interaction.guild.id}/${channel.id}/${message.id}` }],
  });
  await interaction.editReply(
    [
      'やりたいコンテンツのパネルを設置しました。',
      'ゲームのコンテンツ（零式・絶・討滅戦・ダンジョンなど）は、そのまま選べます。',
      ...(seeded
        ? [`ゲームにないもの（「そのほか」）には、地図・ギャザクラなど${DEFAULT_ITEMS.length}個を入れました。管理パネルの「🎮 やりたいコンテンツ」で足し引きできます。`]
        : []),
      ...adminRoleWarnings(interaction.guild),
    ].join('\n'),
  );
};
