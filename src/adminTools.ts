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
import {
  loadAutoApprove,
  loadWelcomeSettings,
  loadXpExcludedChannels,
  saveAutoApprove,
  saveWelcomeSettings,
  saveXpExcludedChannels,
} from './guildSettings.js';
import { addDays, dayStart, formatDay, jstDay } from './jst.js';
import { formatNumber, levelFromXp } from './levels.js';
import { adjustXp, findFirstRecordedDay, findLevelStats, findStreak, listLastActiveDays } from './levelStore.js';
import { findJoinInvite, listRecentLogsFor } from './logStore.js';
import { loadJoinAnnounce, loadRankingHidden } from './memberSettings.js';
import { nameById, nameWithUsername, replaceMentions } from './names.js';
import { describeWorld } from './profile.js';
import { MEMBER_ROLE_NAME, PROFILE_CHANNEL_NAME, REVIEW_CHANNEL_NAME } from './profilePublish.js';
import { findStoredProfile, listPendingApplications } from './profileStore.js';
import { computeRanking, isRankingExempt, summarizeInvites } from './rankings.js';
import { listFinishedRecruits } from './recruitStore.js';
import { findInviteMeRole } from './inviteMeRole.js';
import { findVcRole } from './vcRole.js';
import { buildWelcomeEmbed } from './welcome.js';

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
  const inviteMeRole = findInviteMeRole(guild);
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
          `いつでも誘って: ${inviteMeRole && member.roles.cache.has(inviteMeRole.id) ? '付けている' : '付けていない'}`,
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

// ---- 入った人への案内

export const WELCOME_BUTTON_ID = `${PREFIX}welcome`;
export const WELCOME_ON_ID = `${PREFIX}welcome-on`;
export const WELCOME_OFF_ID = `${PREFIX}welcome-off`;
export const WELCOME_EDIT_ID = `${PREFIX}welcome-edit`;
export const WELCOME_TEST_ID = `${PREFIX}welcome-test`;
export const WELCOME_MODAL_ID = `${PREFIX}welcome-submit`;
const WELCOME_MESSAGE_INPUT_ID = 'welcomeMessage';
const MAX_WELCOME_MESSAGE = 1000;

/** 今の設定と、入った人に届く案内のプレビュー。note は操作の結果 */
export const welcomeScreen = async (guild: Guild, note?: string) => {
  const settings = await loadWelcomeSettings(guild.id);
  const preview = await buildWelcomeEmbed(guild, settings);
  const toggle = (on: boolean): ButtonBuilder =>
    new ButtonBuilder()
      .setCustomId(on ? WELCOME_ON_ID : WELCOME_OFF_ID)
      .setLabel(on ? '送る' : '送らない')
      .setStyle(settings.enabled === on ? ButtonStyle.Primary : ButtonStyle.Secondary);
  return {
    content: [
      ...(note ? [note, ''] : []),
      `👋 **入った人への案内**（今は **${settings.enabled ? '送る' : '送らない'}**。青いボタンが今の設定です）`,
      '入った人に、DMで下の案内を送ります。DMを受け付けていない人には届きません（届いたかは参加のログに出ます）。',
      'リンクは、設置してあるプロフィール・設定・PT募集のパネルにつながります。',
    ].join('\n'),
    embeds: [preview],
    components: [
      new ActionRowBuilder<ButtonBuilder>().addComponents(toggle(true), toggle(false)),
      new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder().setCustomId(WELCOME_EDIT_ID).setLabel('一言を変える').setEmoji({ name: '✏️' }).setStyle(ButtonStyle.Secondary),
        new ButtonBuilder().setCustomId(WELCOME_TEST_ID).setLabel('自分に送ってみる').setEmoji({ name: '📩' }).setStyle(ButtonStyle.Secondary),
      ),
    ],
    allowedMentions: { parse: [] },
  };
};

export const welcomeModal = (current: string): ModalBuilder => {
  const input = new TextInputBuilder()
    .setCustomId(WELCOME_MESSAGE_INPUT_ID)
    .setStyle(TextInputStyle.Paragraph)
    .setMaxLength(MAX_WELCOME_MESSAGE)
    .setRequired(false)
    .setPlaceholder('例: ゆるく遊んでいるサーバーです。気軽に話しかけてください！');
  // 今の一言を入れた状態で開く（空のときは入れない）
  if (current) input.setValue(current);
  return new ModalBuilder()
    .setCustomId(WELCOME_MODAL_ID)
    .setTitle('入った人への案内')
    .addLabelComponents(
      new LabelBuilder().setLabel('一言（任意）').setDescription('案内の一番上に出ます。空にすると決まった文だけになります').setTextInputComponent(input),
    );
};

export const welcomeMessageFrom = (fields: { getTextInputValue: (id: string) => string }): string =>
  fields.getTextInputValue(WELCOME_MESSAGE_INPUT_ID).trim();

/** 送る・送らないを変えて、ログに残す。結果の一言を返す */
export const setWelcomeEnabled = async (admin: GuildMember, enabled: boolean): Promise<string> => {
  const settings = await loadWelcomeSettings(admin.guild.id);
  if (settings.enabled === enabled) return '変更はありませんでした。';
  await saveWelcomeSettings(admin.guild.id, { ...settings, enabled });
  void sendLog(admin.guild, 'welcome', `${admin} が入った人への案内を${enabled ? '送るようにしました' : '止めました'}`, admin);
  return enabled ? '✅ 入った人に案内を送るようにしました。' : '🛑 入った人への案内を止めました。';
};

/** 一言を変えて、ログに残す。結果の一言を返す */
export const setWelcomeMessage = async (admin: GuildMember, message: string): Promise<string> => {
  const settings = await loadWelcomeSettings(admin.guild.id);
  if (settings.message === message) return '変更はありませんでした。';
  await saveWelcomeSettings(admin.guild.id, { ...settings, message });
  void sendLog(admin.guild, 'welcome', `${admin} が入った人への案内の一言を変えました`, admin, {
    fields: [
      { name: '変更前', value: settings.message || '（なし）' },
      { name: '変更後', value: message || '（なし）' },
    ],
  });
  return '✅ 一言を変えました。';
};

/** 押した管理者に、入った人と同じ案内をDMで送る */
export const sendWelcomeTest = async (admin: GuildMember): Promise<string> => {
  const settings = await loadWelcomeSettings(admin.guild.id);
  const embed = await buildWelcomeEmbed(admin.guild, settings);
  return admin.send({ content: '（テスト）入った人には、こう届きます。', embeds: [embed] }).then(
    () => '📩 DMに送りました。',
    () => '⚠ DMを送れませんでした。Discordの「プライバシー設定」で、このサーバーのメンバーからのDMを許可しているか確認してください。',
  );
};

// ---- 申請の自動許可

export const AUTO_APPROVE_BUTTON_ID = `${PREFIX}auto-approve`;
export const AUTO_APPROVE_ON_ID = `${PREFIX}auto-approve-on`;
export const AUTO_APPROVE_OFF_ID = `${PREFIX}auto-approve-off`;

/** 自動許可のオン・オフの画面（今の設定を青く出す）。note は操作の結果 */
export const autoApproveScreen = async (guild: Guild, note?: string) => {
  const [on, pending] = await Promise.all([loadAutoApprove(guild.id), listPendingApplications(guild.id)]);
  const toggle = (value: boolean): ButtonBuilder =>
    new ButtonBuilder()
      .setCustomId(value ? AUTO_APPROVE_ON_ID : AUTO_APPROVE_OFF_ID)
      .setLabel(value ? '自動で許可する' : '管理者が確認する')
      .setStyle(on === value ? ButtonStyle.Primary : ButtonStyle.Secondary);
  return {
    content: [
      ...(note ? [note, ''] : []),
      `✅ **申請の自動許可**（今は **${on ? '自動で許可する' : '管理者が確認する'}**。青いボタンが今の設定です）`,
      '',
      `**自動で許可する**: プロフィールの入力が終わると、管理者の確認なしで、すぐ「${PROFILE_CHANNEL_NAME}」に投稿して「${MEMBER_ROLE_NAME}」ロールを付けます。`,
      `「${REVIEW_CHANNEL_NAME}」チャンネルには、自動で許可したお知らせだけが届きます（あとから気になる人がいたら、管理パネルの「プロフィールを削除」で外せます）。`,
      `**管理者が確認する**: これまでどおり、「${REVIEW_CHANNEL_NAME}」チャンネルの「許可する」を押すまで登録されません。`,
      ...(on && pending.length > 0
        ? ['', `※ 自動許可にする前に届いた審査中の申請（${pending.length}件）は、「${REVIEW_CHANNEL_NAME}」チャンネルで手で許可・拒否してください。`]
        : []),
    ].join('\n'),
    components: [new ActionRowBuilder<ButtonBuilder>().addComponents(toggle(true), toggle(false))],
  };
};

/** 自動許可を切り替えて、ログに残す。結果の一言を返す */
export const setAutoApprove = async (admin: GuildMember, on: boolean): Promise<string> => {
  if ((await loadAutoApprove(admin.guild.id)) === on) return '変更はありませんでした。';
  await saveAutoApprove(admin.guild.id, on);
  void sendLog(admin.guild, 'autoApprove', `${admin} が申請を${on ? '自動で許可するようにしました' : '管理者が確認するように戻しました'}`, admin);
  return on ? '✅ 申請を自動で許可するようにしました。' : '✅ 申請を管理者が確認するように戻しました。';
};

// ---- 小物

/** 「今日」「昨日」「12日前」 */
const daysAgo = (today: string, day: string): string => {
  const days = Math.round((dayStart(today).getTime() - dayStart(day).getTime()) / DAY_MS);
  return days <= 0 ? '今日' : days === 1 ? '昨日' : `${days}日前`;
};

const shorten = (text: string, max: number): string => (text.length > max ? `${text.slice(0, max)}…` : text);
