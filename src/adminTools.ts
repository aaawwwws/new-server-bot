import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelSelectMenuBuilder,
  ChannelType,
  EmbedBuilder,
  LabelBuilder,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  UserSelectMenuBuilder,
  messageLink,
  time,
  type Guild,
  type GuildMember,
} from 'discord.js';
import { sendLog } from './activityLog.js';
import { formatDuration } from './duration.js';
import { fetchAllMembers } from './guildUtils.js';
import { loadXpExcludedChannels, saveXpExcludedChannels } from './guildSettings.js';
import { addDays, dayStart, formatDay, jstDay } from './jst.js';
import { formatNumber, levelFromXp } from './levels.js';
import { adjustXp, findFirstRecordedDay, findLevelStats, findStreak, listLastActiveDays } from './levelStore.js';
import { findJoinInvite, listRecentLogsFor } from './logStore.js';
import { loadJoinAnnounce, loadRankingHidden } from './memberSettings.js';
import { nameById, nameWithUsername, replaceMentions } from './names.js';
import { describeWorld } from './profile.js';
import { findStoredProfile, listPendingApplications } from './profileStore.js';
import { computeRanking, isRankingExempt, summarizeInvites } from './rankings.js';
import { listFinishedRecruits } from './recruitStore.js';
import { findVcRole } from './vcRole.js';

// 管理パネルの「メンバーの詳細」「来ていない人」「XPの調整」「XPなしチャンネル」の中身。
// customId は管理パネルと同じ「admin:」で始まり、管理パネルが受け取ってここを呼ぶ

const PREFIX = 'admin:';
export const KARTE_BUTTON_ID = `${PREFIX}karte`;
export const KARTE_MODAL_ID = `${PREFIX}karte-submit`;
/** 「この人のログ」ボタン（後ろにメンバーのID） */
export const KARTE_LOGS_PREFIX = `${PREFIX}karte-logs:`;
/** 「来ていない人」ボタン。「admin:inactive:30」のように日数が付く */
export const INACTIVE_PREFIX = `${PREFIX}inactive`;
export const XP_ADJUST_BUTTON_ID = `${PREFIX}xp-adjust`;
/** メンバーを選んだ状態で「XPの調整」を開くボタン（後ろにメンバーのID） */
export const XP_ADJUST_FOR_PREFIX = `${PREFIX}xp-adjust-for:`;
export const XP_ADJUST_MODAL_ID = `${PREFIX}xp-adjust-submit`;
export const XP_CHANNELS_BUTTON_ID = `${PREFIX}xp-channels`;
export const XP_CHANNELS_SELECT_ID = `${PREFIX}xp-channels-select`;
export const MEMBER_INPUT_ID = 'member';
const AMOUNT_INPUT_ID = 'amount';
const REASON_INPUT_ID = 'reason';

/** 「来ていない人」で選べる日数 */
export const INACTIVE_DAYS = [7, 14, 30, 60];
export const DEFAULT_INACTIVE_DAYS = 30;
/** 一覧に一度に出す人数 */
const MAX_LISTED = 30;
const RECENT_LOG_COUNT = 6;
const LOG_TEXT_LENGTH = 70;
/** 一度に足し引きできるXP */
const MAX_ADJUST = 1_000_000;
const DAY_MS = 24 * 60 * 60 * 1000;
const COLOR = 0x99aab5;

// ---- メンバーの詳細

export const karteModal = (): ModalBuilder =>
  new ModalBuilder()
    .setCustomId(KARTE_MODAL_ID)
    .setTitle('メンバーの詳細')
    .addLabelComponents(
      new LabelBuilder()
        .setLabel('メンバー')
        .setDescription('名前で検索して選べます')
        .setUserSelectMenuComponent(new UserSelectMenuBuilder().setCustomId(MEMBER_INPUT_ID).setRequired(true)),
    );

/** 1人のことをまとめて出す（参加・招待リンク・プロフィール・レベル・最後に来た日・設定・ロール・最近のログ） */
export const buildMemberKarte = async (member: GuildMember, now: Date = new Date()) => {
  const { guild } = member;
  const today = jstDay(now);
  const [stored, pending, stats, streak, lastActiveDays, hidden, announce, invite, logs, recruits, total, week, invites] = await Promise.all([
    findStoredProfile(guild.id, member.id),
    listPendingApplications(guild.id),
    findLevelStats(guild.id, member.id),
    findStreak(guild.id, member.id, today),
    listLastActiveDays(guild.id),
    loadRankingHidden(guild.id, member.id),
    loadJoinAnnounce(guild.id, member.id),
    findJoinInvite(guild.id, member.id),
    listRecentLogsFor(guild.id, member.id, RECENT_LOG_COUNT),
    listFinishedRecruits(guild.id, null, null),
    computeRanking(guild, 'xp', 'all', now, { changes: false }),
    computeRanking(guild, 'xp', 'week', now, { changes: false, alsoInclude: member.id }),
    summarizeInvites(guild, member.id),
  ]);

  const application = pending.find((a) => a.userId === member.id);
  const profileLink = stored?.channelId && stored.messageId ? ` [プロフを見る](${messageLink(stored.channelId, stored.messageId, guild.id)})` : '';
  const profile = stored
    ? `${stored.profile.name}・${describeWorld(stored.profile)}${profileLink}`
    : application
      ? `未登録（📝 審査中の申請あり・${time(application.createdAt, 'R')}）`
      : '未登録';

  const rankIndex = total.entries.findIndex((entry) => entry.member.id === member.id);
  const rank = isRankingExempt(member)
    ? '順位: 対象外（管理者）'
    : hidden
      ? '順位: 非表示'
      : rankIndex >= 0
        ? `順位: ${rankIndex + 1}位 / ${total.entries.length}人`
        : '順位: まだなし';
  const weekXp = week.entries.find((entry) => entry.member.id === member.id)?.value ?? 0;
  const lastActive = lastActiveDays.get(member.id);
  const hosted = recruits.filter((recruit) => recruit.hostId === member.id).length;
  const joined = recruits.filter((recruit) => recruit.participants.some((p) => p.slot && p.userId === member.id)).length;
  const vcRole = findVcRole(guild);
  const roles = member.roles.cache
    .filter((role) => role.id !== guild.id)
    .sort((a, b) => b.position - a.position)
    .map((role) => `${role}`);

  const embed = new EmbedBuilder()
    .setColor(member.displayColor || COLOR)
    .setAuthor({ name: `${member.displayName}（${member.user.username}）`, iconURL: member.displayAvatarURL() })
    .setTitle('🗂️ メンバーの詳細')
    .setThumbnail(member.displayAvatarURL({ size: 256 }))
    .setDescription(`${nameWithUsername(member)}\nID: \`${member.id}\``)
    .addFields(
      { name: '📥 参加', value: member.joinedAt ? `${time(member.joinedAt, 'D')}（${time(member.joinedAt, 'R')}）` : '不明', inline: true },
      { name: '🕒 アカウント作成', value: `${time(member.user.createdAt, 'D')}（${time(member.user.createdAt, 'R')}）`, inline: true },
      { name: '🔗 招待リンク', value: invite ?? '記録なし', inline: true },
      { name: '🪪 プロフィール', value: profile },
      { name: '📊 レベル', value: `Lv.${levelFromXp(stats.xp).level}（${formatNumber(stats.xp)} XP）\n${rank}`, inline: true },
      { name: '🗓️ 今週', value: `${formatNumber(weekXp)} XP`, inline: true },
      { name: '🕘 最後に来た日', value: lastActive ? `${formatDay(lastActive)}（${daysAgo(today, lastActive)}）` : '記録なし', inline: true },
      {
        name: '💬 発言・🎧 VC',
        value: `${formatNumber(stats.messageCount)}回・${stats.voiceMinutes > 0 ? formatDuration(stats.voiceMinutes * 60_000) : '0分'}`,
        inline: true,
      },
      { name: '👍 リアクション', value: `した ${formatNumber(stats.reactionsGiven)}・もらった ${formatNumber(stats.reactionsReceived)}`, inline: true },
      { name: '🔥 連続日数', value: `${streak.current}日（最長${streak.best}日）`, inline: true },
      { name: '📣 PT募集', value: `主催 ${hosted}回・参加 ${joined}回`, inline: true },
      {
        name: '📨 招待',
        value: [
          `招待して定着: ${invites.counted}人（リンクで入った ${invites.total}人）`,
          `招待してくれた人: ${invites.inviterId ? nameById(guild, invites.inviterId) : '記録なし'}`,
        ].join('\n'),
        inline: true,
      },
      {
        name: '⚙️ 設定',
        value: [
          `VC通知: ${vcRole && member.roles.cache.has(vcRole.id) ? '受け取る' : '受け取らない'}`,
          `通話開始のお知らせ: ${announce.callStart ? 'する' : 'しない'}`,
          `VC入室のプロフ: ${announce.vcJoin ? '出す' : '出さない'}`,
          `ランキング: ${hidden ? '出さない' : '出す'}`,
        ].join('\n'),
        inline: true,
      },
      { name: `🎭 ロール（${roles.length}）`, value: shorten(roles.join(' '), 1000) || 'なし' },
      {
        name: '📜 最近のログ',
        value:
          logs.map((log) => `${time(log.createdAt, 'R')} **${log.title}** ${shorten(replaceMentions(guild, log.text.replace(/\n/g, ' ')), LOG_TEXT_LENGTH)}`).join('\n') ||
          'なし',
      },
    );
  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId(`${KARTE_LOGS_PREFIX}${member.id}`).setLabel('この人のログ（30日）').setEmoji({ name: '🔎' }).setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId(`${XP_ADJUST_FOR_PREFIX}${member.id}`).setLabel('XPを調整').setEmoji({ name: '✏️' }).setStyle(ButtonStyle.Secondary),
  );
  return { embeds: [embed], components: [row], allowedMentions: { parse: [] } };
};

// ---- 来ていない人

/** 最後に来た日（発言・VC・リアクションをした日）が days 日より前の人。入ってまだ日が浅い人は入れない */
export const inactiveScreen = async (guild: Guild, days: number, now: Date = new Date()) => {
  const today = jstDay(now);
  const since = addDays(today, -days);
  const sinceDate = dayStart(since);
  const [members, lastActiveDays, firstDay] = await Promise.all([
    fetchAllMembers(guild),
    listLastActiveDays(guild.id),
    findFirstRecordedDay(guild.id),
  ]);
  const inactive = [...members.values()]
    .filter((member) => !member.user.bot)
    .flatMap((member) => {
      const last = lastActiveDays.get(member.id) ?? null;
      if (last && last >= since) return [];
      if (!last && member.joinedAt && member.joinedAt >= sinceDate) return [];
      return [{ member, last }];
    })
    // 記録がない人を先に、そのあとは最後に来た日が古い順
    .sort((a, b) => (a.last ?? '').localeCompare(b.last ?? '') || (a.member.joinedTimestamp ?? 0) - (b.member.joinedTimestamp ?? 0));

  const lines = inactive.map(({ member, last }) =>
    last
      ? `・${nameWithUsername(member)} 最後: ${formatDay(last)}（${daysAgo(today, last)}）`
      : `・${nameWithUsername(member)} 記録なし（参加: ${member.joinedAt ? time(member.joinedAt, 'D') : '不明'}）`,
  );
  const rest = lines.length - MAX_LISTED;
  const embed = new EmbedBuilder()
    .setColor(COLOR)
    .setTitle(`💤 ${days}日以上来ていない人（${inactive.length}人）`)
    .setDescription(
      lines.length === 0 ? 'いません。' : [...lines.slice(0, MAX_LISTED), ...(rest > 0 ? [`ほか ${rest}人`] : [])].join('\n'),
    )
    .setFooter({
      text: `「来た日」は発言・VC・リアクションをした日です。${firstDay ? `記録は ${formatDay(firstDay)} から（それより前のことは分かりません）` : 'まだ記録がありません'}`,
    });
  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    INACTIVE_DAYS.map((d) =>
      new ButtonBuilder()
        .setCustomId(`${INACTIVE_PREFIX}:${d}`)
        .setLabel(`${d}日`)
        .setStyle(d === days ? ButtonStyle.Primary : ButtonStyle.Secondary),
    ),
  );
  return { embeds: [embed], components: [row], allowedMentions: { parse: [] } };
};

// ---- XPの調整

/** userId を渡すと、そのメンバーを選んだ状態で開く */
export const xpAdjustModal = (userId?: string): ModalBuilder => {
  const select = new UserSelectMenuBuilder().setCustomId(MEMBER_INPUT_ID).setRequired(true);
  if (userId) select.setDefaultUsers(userId);
  return new ModalBuilder()
    .setCustomId(XP_ADJUST_MODAL_ID)
    .setTitle('XPの調整')
    .addLabelComponents(
      new LabelBuilder().setLabel('メンバー').setUserSelectMenuComponent(select),
      new LabelBuilder()
        .setLabel('XP')
        .setDescription('足すなら「500」か「+500」、引くなら「-500」')
        .setTextInputComponent(
          new TextInputBuilder().setCustomId(AMOUNT_INPUT_ID).setStyle(TextInputStyle.Short).setMaxLength(12).setRequired(true).setPlaceholder('+500'),
        ),
      new LabelBuilder()
        .setLabel('理由')
        .setDescription('ログに残ります（例: イベントの景品・間違いの修正）')
        .setTextInputComponent(new TextInputBuilder().setCustomId(REASON_INPUT_ID).setStyle(TextInputStyle.Short).setMaxLength(100).setRequired(true)),
    );
};

/** 「+500」「-200」「1,000」を読む（全角も可）。読めない・0・大きすぎるときは null */
export const parseXpAmount = (input: string): number | null => {
  const text = input.normalize('NFKC').replace(/[,\s]/g, '').replace(/^[−ー]/, '-');
  if (!/^[+-]?\d+$/.test(text)) return null;
  const value = Number(text);
  return value === 0 || Math.abs(value) > MAX_ADJUST ? null : value;
};

export interface XpAdjustInput {
  target: GuildMember | null;
  amount: string;
  reason: string;
}

/** 調整して、結果の文を返す。読めない入力なら、直し方を返す */
export const applyXpAdjustment = async (admin: GuildMember, { target, amount, reason }: XpAdjustInput): Promise<string> => {
  if (!target) return 'そのメンバーはサーバーにいません。';
  if (target.user.bot) return 'Botにはレベルがありません。';
  const delta = parseXpAmount(amount);
  if (delta === null) return `XPは「500」「+500」「-500」のように、0以外の数で入力してください（${formatNumber(MAX_ADJUST)}まで）。`;

  const { before, after } = await adjustXp(admin.guild.id, target.id, delta);
  const change = delta > 0 ? `${formatNumber(delta)} 足しました` : `${formatNumber(-delta)} 引きました`;
  const levels = `Lv.${levelFromXp(before).level} → Lv.${levelFromXp(after).level}`;
  void sendLog(admin.guild, 'level', `${admin} が ${target} のXPを${change}`, admin, {
    target,
    title: 'XPの調整',
    fields: [
      { name: '✏️ XP', value: `${formatNumber(before)} → ${formatNumber(after)}`, inline: true },
      { name: '📊 レベル', value: levels, inline: true },
      { name: '📝 理由', value: reason },
    ],
  });
  return [
    `✅ ${target} のXPを${change}。`,
    `XP: ${formatNumber(before)} → ${formatNumber(after)}（${levels}）`,
    `理由: ${reason}`,
    ...(delta < 0 && after === 0 && before < -delta ? ['※ 0より下にはしないので、0にしました。'] : []),
    '-# 合計のXPだけを変えます（レベルと累計のランキングに効き、今日・今週・今月のランキングには入りません）',
  ].join('\n');
};

// ---- XPを入れないチャンネル

export const xpChannelsScreen = async (guild: Guild, note?: string) => {
  const ids = await loadXpExcludedChannels(guild.id);
  // 消されたチャンネルは、選択肢の初期値に入れられないので外す
  const existing = ids.filter((id) => guild.channels.cache.has(id));
  const embed = new EmbedBuilder()
    .setColor(COLOR)
    .setTitle('🚫 XPを入れないチャンネル')
    .setDescription(
      [
        ...(note ? [note, ''] : []),
        '選んだチャンネルでの発言・リアクション・VCは、XPにも回数にも数えません。',
        'カテゴリーを選ぶと、その中のチャンネルとスレッドも同じ扱いになります。',
        '',
        '**今の設定**',
        ids.length === 0
          ? 'なし（すべてのチャンネルでXPが入ります）'
          : ids.map((id) => (guild.channels.cache.has(id) ? `・<#${id}>` : `・（削除されたチャンネル ${id}）`)).join('\n'),
      ].join('\n'),
    );
  const select = new ChannelSelectMenuBuilder()
    .setCustomId(XP_CHANNELS_SELECT_ID)
    .setPlaceholder('XPを入れないチャンネルを選ぶ（外すときは選択を外す）')
    .setChannelTypes(
      ChannelType.GuildText,
      ChannelType.GuildAnnouncement,
      ChannelType.GuildForum,
      ChannelType.GuildVoice,
      ChannelType.GuildStageVoice,
      ChannelType.GuildCategory,
    )
    .setMinValues(0)
    .setMaxValues(25);
  if (existing.length > 0) select.setDefaultChannels(existing.slice(0, 25));
  return { embeds: [embed], components: [new ActionRowBuilder<ChannelSelectMenuBuilder>().addComponents(select)] };
};

/** 選び直したチャンネルを保存し、変わったところをログに残す。結果の一言を返す */
export const saveXpChannels = async (admin: GuildMember, channelIds: string[]): Promise<string> => {
  const before = await loadXpExcludedChannels(admin.guild.id);
  const added = channelIds.filter((id) => !before.includes(id));
  const removed = before.filter((id) => !channelIds.includes(id));
  if (added.length === 0 && removed.length === 0) return '変更はありませんでした。';
  await saveXpExcludedChannels(admin.guild.id, channelIds);
  void sendLog(admin.guild, 'level', `${admin} がXPを入れないチャンネルを変えました`, admin, {
    title: 'XPなしチャンネルの変更',
    fields: [
      ...(added.length > 0 ? [{ name: '🚫 追加', value: added.map((id) => `<#${id}>`).join(' ') }] : []),
      ...(removed.length > 0 ? [{ name: '✅ 外した', value: removed.map((id) => `<#${id}>`).join(' ') }] : []),
    ],
  });
  return `✅ 保存しました（追加 ${added.length}・外した ${removed.length}）。`;
};

// ---- 小物

/** 「今日」「昨日」「12日前」 */
const daysAgo = (today: string, day: string): string => {
  const days = Math.round((dayStart(today).getTime() - dayStart(day).getTime()) / DAY_MS);
  return days <= 0 ? '今日' : days === 1 ? '昨日' : `${days}日前`;
};

const shorten = (text: string, max: number): string => (text.length > max ? `${text.slice(0, max)}…` : text);
