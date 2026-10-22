import {
  EmbedBuilder,
  InteractionContextType,
  MessageFlags,
  SlashCommandBuilder,
  type ChatInputCommandInteraction,
  type GuildMember,
} from 'discord.js';
import { formatDuration } from '../duration.js';
import { MESSAGE_XP_COOLDOWN_MS, formatNumber, levelFromXp, rankMembers } from '../levels.js';
import type { LevelStats } from '../levelStore.js';

const PROGRESS_BAR_LENGTH = 10;
/** 名前に色が付いていない人の色 */
const DEFAULT_COLOR = 0x5865f2;

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
  await interaction.editReply({ embeds: [await buildLevelEmbed(target)] });
};

/** レベルの表示（コマンドと、設定パネルの「レベル」で共通） */
export const buildLevelEmbed = async (member: GuildMember): Promise<EmbedBuilder> => {
  const ranked = await rankMembers(member.guild);
  const index = ranked.findIndex((entry) => entry.member.id === member.id);
  const stats = ranked[index]?.stats ?? { userId: member.id, xp: 0, messageCount: 0, voiceMinutes: 0 };
  return levelEmbed(member, stats, index === -1 ? null : index + 1, ranked.length);
};

const levelEmbed = (member: GuildMember, stats: LevelStats, rank: number | null, total: number): EmbedBuilder => {
  const { level, current, needed } = levelFromXp(stats.xp);
  const ratio = current / needed;
  const filled = Math.floor(ratio * PROGRESS_BAR_LENGTH);
  return new EmbedBuilder()
    .setColor(member.displayColor || DEFAULT_COLOR)
    .setAuthor({ name: member.displayName, iconURL: member.displayAvatarURL() })
    .setTitle(`Lv.${level}`)
    .setThumbnail(member.displayAvatarURL({ size: 256 }))
    .setDescription(
      [
        `${'▰'.repeat(filled)}${'▱'.repeat(PROGRESS_BAR_LENGTH - filled)} ${Math.floor(ratio * 100)}%`,
        `次のレベルまで あと **${formatNumber(needed - current)} XP**`,
      ].join('\n'),
    )
    .addFields(
      { name: '🏆 順位', value: rank ? `${rank}位 / ${total}人` : 'まだありません', inline: true },
      { name: '✨ 累計XP', value: `${formatNumber(stats.xp)} XP`, inline: true },
      { name: '​', value: '​', inline: true },
      { name: '💬 発言', value: `${formatNumber(stats.messageCount)}回`, inline: true },
      { name: '🎧 VC', value: stats.voiceMinutes > 0 ? formatDuration(stats.voiceMinutes * 60_000) : '0分', inline: true },
      { name: '​', value: '​', inline: true },
    )
    .setFooter({
      text: `XPは発言（${MESSAGE_XP_COOLDOWN_MS / 60_000}分に1回）と、2人以上いるVC（ミュート中は除く）で貯まります`,
    });
};
