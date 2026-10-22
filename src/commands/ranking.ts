import {
  EmbedBuilder,
  InteractionContextType,
  MessageFlags,
  SlashCommandBuilder,
  type ChatInputCommandInteraction,
  type Guild,
} from 'discord.js';
import { formatDuration } from '../duration.js';
import { formatNumber, levelFromXp, rankMembers, type RankedMember, type RankingKey } from '../levels.js';

/** ランキングに出す人数 */
const TOP_COUNT = 10;
const MEDALS = ['🥇', '🥈', '🥉'];

/** ランキングの種類ごとの名前と、数字の見せ方 */
export const RANKINGS: Record<RankingKey, { label: string; describe: (entry: RankedMember) => string }> = {
  xp: {
    label: 'レベル',
    describe: ({ stats }) => `Lv.${levelFromXp(stats.xp).level}（${formatNumber(stats.xp)} XP）`,
  },
  messageCount: { label: '発言数', describe: ({ stats }) => `${formatNumber(stats.messageCount)}回` },
  voiceMinutes: { label: 'VCの時間', describe: ({ stats }) => formatDuration(stats.voiceMinutes * 60_000) },
};

export const data = new SlashCommandBuilder()
  .setName('ranking')
  .setNameLocalizations({ ja: 'ランキング' })
  .setDescription('レベルのランキングを表示します（自分にだけ表示）')
  .addStringOption((option) =>
    option
      .setName('type')
      .setNameLocalizations({ ja: '種類' })
      .setDescription('何のランキングか（指定しないとレベル）')
      .addChoices(
        { name: 'レベル（XP）', value: 'xp' },
        { name: '発言数', value: 'messageCount' },
        { name: 'VCの時間', value: 'voiceMinutes' },
      ),
  )
  .setContexts(InteractionContextType.Guild);

export const execute = async (interaction: ChatInputCommandInteraction<'cached'>): Promise<void> => {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  const key = toRankingKey(interaction.options.getString('type'));
  await interaction.editReply({ embeds: [await buildRankingEmbed(interaction.guild, interaction.user.id, key)] });
};

/** 選ばれた種類。知らない値なら「レベル」 */
export const toRankingKey = (value: string | null | undefined): RankingKey =>
  value === 'messageCount' || value === 'voiceMinutes' ? value : 'xp';

/** ランキングの表示（コマンドと、設定パネルの「レベル」で共通）。viewerId の人の順位は、上位に入っていなくても一番下に出す */
export const buildRankingEmbed = async (guild: Guild, viewerId: string, key: RankingKey): Promise<EmbedBuilder> => {
  const { label, describe } = RANKINGS[key];
  const ranked = await rankMembers(guild, key);
  const lines = ranked
    .slice(0, TOP_COUNT)
    .map((entry, i) => `${MEDALS[i] ?? `**${i + 1}.**`} ${entry.member} ${describe(entry)}`);

  const myIndex = ranked.findIndex((entry) => entry.member.id === viewerId);
  const mine = ranked[myIndex];
  const myLine = mine ? `あなた: **${myIndex + 1}位** ${describe(mine)}` : 'あなたはまだランキングに入っていません。';

  return new EmbedBuilder()
    .setColor(0xf1c40f)
    .setTitle(`🏆 ランキング（${label}）`)
    .setDescription(ranked.length === 0 ? 'まだ誰も記録がありません。' : [...lines, '', myLine].join('\n'))
    .setFooter({ text: `記録がある ${ranked.length}人のうち上位${Math.min(TOP_COUNT, ranked.length)}人` });
};
