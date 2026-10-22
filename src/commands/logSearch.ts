import {
  InteractionContextType,
  MessageFlags,
  SlashCommandBuilder,
  type ChatInputCommandInteraction,
  type ModalSubmitInteraction,
} from 'discord.js';
import {
  CSV_LIMIT,
  LIST_LIMIT,
  LOG_SEARCH_TYPES,
  buildCsv,
  buildSearchEmbed,
  describeFilter,
  searchLogs,
  toSearchType,
  type LogSearchFilter,
} from '../logSearch.js';

export const MAX_DAYS = 365;
const DEFAULT_DAYS = 7;

export const data = new SlashCommandBuilder()
  .setName('log-search')
  .setNameLocalizations({ ja: 'ログ検索' })
  .setDescription('残しておいた行動ログ・発言・VCの出入りを探します（管理者用・自分にだけ表示）')
  .addStringOption((option) =>
    option
      .setName('type')
      .setNameLocalizations({ ja: '種類' })
      .setDescription('何を探すか（指定しないとすべて）')
      .addChoices(...LOG_SEARCH_TYPES.map((type) => ({ name: type.label, value: type.value }))),
  )
  .addUserOption((option) =>
    option.setName('user').setNameLocalizations({ ja: 'ユーザー' }).setDescription('この人が実行した・対象になったもの'),
  )
  .addIntegerOption((option) =>
    option
      .setName('days')
      .setNameLocalizations({ ja: '日数' })
      .setDescription(`何日前まで遡るか（指定しないと${DEFAULT_DAYS}日）`)
      .setMinValue(1)
      .setMaxValue(MAX_DAYS),
  )
  .addStringOption((option) =>
    option.setName('keyword').setNameLocalizations({ ja: 'キーワード' }).setDescription('見出し・内容に含まれる言葉').setMaxLength(100),
  )
  .addBooleanOption((option) =>
    option.setName('csv').setNameLocalizations({ ja: 'csvで出す' }).setDescription(`CSVファイルで出す（${CSV_LIMIT.toLocaleString()}件まで）`),
  )
  .setContexts(InteractionContextType.Guild);

export const execute = async (interaction: ChatInputCommandInteraction<'cached'>): Promise<void> => {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  const filter: LogSearchFilter = {
    type: toSearchType(interaction.options.getString('type')),
    userId: interaction.options.getUser('user')?.id ?? null,
    days: interaction.options.getInteger('days') ?? DEFAULT_DAYS,
    keyword: interaction.options.getString('keyword')?.trim() || null,
  };
  await replyWithSearch(interaction, filter, interaction.options.getBoolean('csv') ?? false);
};

/** 探した結果を、本人にだけ見える返信で出す（先に deferReply しておくこと）。管理パネルのログ検索でも使う */
export const replyWithSearch = async (
  interaction: ChatInputCommandInteraction<'cached'> | ModalSubmitInteraction<'cached'>,
  filter: LogSearchFilter,
  asCsv: boolean,
): Promise<void> => {
  if (asCsv) {
    const { rows, total } = await searchLogs(interaction.guild.id, filter, CSV_LIMIT);
    await interaction.editReply({
      content: [
        `🔎 ${describeFilter(filter)}`,
        rows.length === 0
          ? '見つかりませんでした。'
          : `${rows.length}件をCSVにしました${total > rows.length ? `（全${total}件のうち新しい${rows.length}件）` : ''}。`,
      ].join('\n'),
      files: rows.length > 0 ? [buildCsv(interaction.guild, rows)] : [],
      allowedMentions: { parse: [] },
    });
    return;
  }
  const { rows, total } = await searchLogs(interaction.guild.id, filter, LIST_LIMIT);
  await interaction.editReply({ embeds: [buildSearchEmbed(filter, rows, total)], allowedMentions: { parse: [] } });
};
