import { InteractionContextType, SlashCommandBuilder, type ChatInputCommandInteraction } from 'discord.js';
import { KIND_INFO, PERIOD_LABELS, RANKING_KINDS, RANKING_PERIODS, toRankingKind, toRankingPeriod } from '../rankings.js';
import { replyRanking } from '../rankingView.js';

export const data = new SlashCommandBuilder()
  .setName('ranking')
  .setNameLocalizations({ ja: 'ランキング' })
  .setDescription('サーバーのランキングを表示します（自分にだけ表示）')
  .addStringOption((option) =>
    option
      .setName('type')
      .setNameLocalizations({ ja: '種類' })
      .setDescription('何のランキングか（指定しないとXP）')
      .addChoices(...RANKING_KINDS.map((kind) => ({ name: KIND_INFO[kind].label, value: kind }))),
  )
  .addStringOption((option) =>
    option
      .setName('period')
      .setNameLocalizations({ ja: '期間' })
      .setDescription('いつの分か（指定しないと今週）')
      .addChoices(...RANKING_PERIODS.map((period) => ({ name: PERIOD_LABELS[period], value: period }))),
  )
  .setContexts(InteractionContextType.Guild);

export const execute = async (interaction: ChatInputCommandInteraction<'cached'>): Promise<void> => {
  const kind = toRankingKind(interaction.options.getString('type'));
  const period = toRankingPeriod(interaction.options.getString('period'));
  await replyRanking(interaction, kind, period);
};
