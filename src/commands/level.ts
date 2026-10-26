import {
  AttachmentBuilder,
  EmbedBuilder,
  InteractionContextType,
  MessageFlags,
  SlashCommandBuilder,
  type ChatInputCommandInteraction,
  type GuildMember,
} from 'discord.js';
import { formatDuration } from '../duration.js';
import { jstDay } from '../jst.js';
import { MESSAGE_XP_COOLDOWN_MS, formatNumber, levelFromXp } from '../levels.js';
import { findLevelStats, findStreak } from '../levelStore.js';
import { loadRankingHidden } from '../memberSettings.js';
import { renderRankCard } from '../rankCard.js';
import { computeRanking } from '../rankings.js';
import { describeBoost } from '../xpBoost.js';

const PROGRESS_BAR_LENGTH = 10;
/** 名前に色が付いていない人の色 */
const DEFAULT_COLOR = 0x5865f2;
const CARD_FILE_NAME = 'rank-card.png';

export const data = new SlashCommandBuilder()
  .setName('level')
  .setNameLocalizations({ ja: 'レベル' })
  .setDescription('レベルと経験値（XP）を表示します（自分にだけ表示）')
  .addUserOption((option) =>
    option.setName('member').setNameLocalizations({ ja: 'メンバー' }).setDescription('ほかの人のレベルを見るときに選ぶ'),
  )
  .setContexts(InteractionContextType.Guild);

export const execute = async (interaction: ChatInputCommandInteraction<'cached'>): Promise<void> => {
  // メンバーを選んでいなければ自分。選んだ人がもうサーバーにいなければ null
  const picked = interaction.options.getUser('member');
  const target = picked ? interaction.options.getMember('member') : interaction.member;
  if (!target || target.user.bot) {
    await interaction.reply({
      content: target ? 'Botにはレベルがありません。' : 'そのメンバーはサーバーにいません。',
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  await interaction.editReply(await buildLevelView(target));
};

export interface LevelView {
  embeds: EmbedBuilder[];
  /** 画像カード（作れなかったときは空で、埋め込みに文字のゲージを出す） */
  files: AttachmentBuilder[];
}

/** レベルの表示（コマンドと、設定パネルの「レベル」で共通）。画像カードと、数字の一覧 */
export const buildLevelView = async (member: GuildMember, now: Date = new Date()): Promise<LevelView> => {
  const { guild } = member;
  const [stats, streak, hidden, total, week] = await Promise.all([
    findLevelStats(guild.id, member.id),
    findStreak(guild.id, member.id, jstDay(now)),
    loadRankingHidden(guild.id, member.id),
    computeRanking(guild, 'xp', 'all', now, { changes: false }),
    // ランキングに出ない設定でも、今週のXPは出す（順位は出さない）
    computeRanking(guild, 'xp', 'week', now, { changes: false, alsoInclude: member.id }),
  ]);
  const { level, current, needed } = levelFromXp(stats.xp);
  const rankIndex = total.entries.findIndex((entry) => entry.member.id === member.id);
  const weekIndex = week.entries.findIndex((entry) => entry.member.id === member.id);
  const weekXp = week.entries[weekIndex]?.value ?? 0;
  // ランキングに出ない設定の人は、ほかの人が見ても順位を出さない
  const rank = hidden ? '非表示' : rankIndex >= 0 ? `${rankIndex + 1}位` : '—';
  const voice = stats.voiceMinutes > 0 ? formatDuration(stats.voiceMinutes * 60_000) : '0分';

  const card = await renderRankCard({
    name: member.displayName,
    avatarUrl: member.displayAvatarURL({ extension: 'png', size: 256, forceStatic: true }),
    color: member.displayColor,
    level,
    current,
    needed,
    totalXp: stats.xp,
    rank,
    stats: [`連続 ${streak.current}日`, `今週 ${formatNumber(weekXp)} XP`, `発言 ${formatNumber(stats.messageCount)}回`, `VC ${voice}`],
  });

  const ratio = current / needed;
  const filled = Math.floor(ratio * PROGRESS_BAR_LENGTH);
  const boost = describeBoost(guild.id, now);
  const embed = new EmbedBuilder()
    .setColor(member.displayColor || DEFAULT_COLOR)
    .setAuthor({ name: member.displayName, iconURL: member.displayAvatarURL() })
    .setTitle(`Lv.${level}`)
    .setDescription(
      [
        // 画像カードがあればゲージはカードに描いてあるので、文字のゲージは出さない
        ...(card ? [] : [`${'▰'.repeat(filled)}${'▱'.repeat(PROGRESS_BAR_LENGTH - filled)} ${Math.floor(ratio * 100)}%`]),
        `次のレベルまで あと **${formatNumber(needed - current)} XP**`,
        ...(boost ? ['', boost] : []),
      ].join('\n'),
    )
    .addFields(
      {
        name: '🏆 順位',
        value: hidden ? '非表示（ランキングに出ない設定）' : rankIndex >= 0 ? `${rankIndex + 1}位 / ${total.entries.length}人` : 'まだありません',
        inline: true,
      },
      { name: '✨ 累計XP', value: `${formatNumber(stats.xp)} XP`, inline: true },
      { name: '🔥 連続日数', value: `${streak.current}日（最長${streak.best}日）`, inline: true },
      { name: '💬 発言', value: `${formatNumber(stats.messageCount)}回`, inline: true },
      { name: '🎧 VC', value: voice, inline: true },
      {
        name: '🗓️ 今週',
        value: `${formatNumber(weekXp)} XP${!hidden && weekIndex >= 0 ? `（${weekIndex + 1}位）` : ''}`,
        inline: true,
      },
    )
    .setFooter({
      text: `XPは発言（${MESSAGE_XP_COOLDOWN_MS / 60_000}分に1回）と、2人以上いるVC（ミュート中は除く）で貯まります`,
    });
  if (card) embed.setImage(`attachment://${CARD_FILE_NAME}`);
  return { embeds: [embed], files: card ? [new AttachmentBuilder(card, { name: CARD_FILE_NAME })] : [] };
};
