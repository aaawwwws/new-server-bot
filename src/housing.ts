import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  LabelBuilder,
  MessageFlags,
  ModalBuilder,
  PermissionFlagsBits,
  StringSelectMenuBuilder,
  TextInputBuilder,
  TextInputStyle,
  type ButtonInteraction,
  type Client,
  type Guild,
  type GuildMember,
  type ModalSubmitInteraction,
  type Role,
} from 'discord.js';
import { sendLog } from './activityLog.js';
import { NOTICE_CHANNEL_NAME } from './callNotice.js';
import { formatDuration } from './duration.js';
import { reportError } from './errorReporter.js';
import { canBotPost, fetchAllMembers, findTextChannel } from './guildUtils.js';
import { claimHousingNotice, findHousingEntry, listHousingEntries, loadHousingAnchor, saveHousingAnchor, saveHousingEntry } from './housingStore.js';
import { formatShortDateTime, parseJstDateTime } from './jst.js';
import { ensureAdmin } from './permissions.js';

// ハウジング抽選のお知らせ。抽選は「受付5日 → 結果発表4日」の9日ごとの繰り返しなので、
// 管理者が一度だけ今の期間の終わりを入れれば、あとはBotが日程を計算して「通知」チャンネルに流す（「ハウジング抽選」ロールにメンション）。
// 申し込みメモ（申し込んだ区画）を残した人には、結果発表のときにその区画を書いてDMでも知らせる。
// customId は「housing:<操作>」

export const CUSTOM_ID_PREFIX = 'housing:';
/** 設定パネルの「🏠 ハウジング抽選」 */
export const OPEN_BUTTON_ID = `${CUSTOM_ID_PREFIX}open`;
/** 管理パネルの「🏠 ハウジング抽選」 */
export const ADMIN_BUTTON_ID = `${CUSTOM_ID_PREFIX}admin`;
const ROLE_ON_ID = `${CUSTOM_ID_PREFIX}role-on`;
const ROLE_OFF_ID = `${CUSTOM_ID_PREFIX}role-off`;
const ENTRY_BUTTON_ID = `${CUSTOM_ID_PREFIX}entry`;
const ENTRY_MODAL_ID = `${CUSTOM_ID_PREFIX}entry-submit`;
const SCHEDULE_BUTTON_ID = `${CUSTOM_ID_PREFIX}schedule`;
const SCHEDULE_MODAL_ID = `${CUSTOM_ID_PREFIX}schedule-submit`;
const SCHEDULE_STOP_ID = `${CUSTOM_ID_PREFIX}schedule-stop`;
const PLOT_INPUT_ID = 'plot';
const PHASE_INPUT_ID = 'phase';
const END_INPUT_ID = 'end';
const MAX_PLOT_LENGTH = 100;

/**
 * お知らせを受け取る人が自分で付けるロール。
 * よく遊ぶコンテンツの「ハウジング」（ハウスを飾るのが好きな人）とは別にして、抽選に興味がある人だけに届くようにする
 */
export const HOUSING_ROLE_NAME = 'ハウジング抽選';

const DAY_MS = 24 * 60 * 60_000;
export const ENTRY_DAYS = 5;
export const RESULTS_DAYS = 4;
const CYCLE_MS = (ENTRY_DAYS + RESULTS_DAYS) * DAY_MS;
/** 締め切りの何時間前に知らせるか */
const DEADLINE_NOTICE_HOURS = 24;
const TICK_MS = 60_000;

export type HousingPhase = 'entry' | 'results';
export interface HousingPeriod {
  phase: HousingPhase;
  start: Date;
  end: Date;
  /** この回の受付の始まり・終わり（＝結果発表の始まり）・結果発表の終わり（＝次の受付の始まり） */
  entryStart: Date;
  entryEnd: Date;
  resultsEnd: Date;
}

const PHASE_LABELS: Record<HousingPhase, string> = { entry: '受付期間', results: '結果発表期間' };

/** 今の期間。anchor はある回の受付の終わり（そこから前後に9日ごとに繰り返す） */
export const housingPeriod = (anchor: Date, now: Date): HousingPeriod => {
  const firstEntryStart = anchor.getTime() - ENTRY_DAYS * DAY_MS;
  const cycle = Math.floor((now.getTime() - firstEntryStart) / CYCLE_MS);
  const entryStart = new Date(firstEntryStart + cycle * CYCLE_MS);
  const entryEnd = new Date(entryStart.getTime() + ENTRY_DAYS * DAY_MS);
  const resultsEnd = new Date(entryStart.getTime() + CYCLE_MS);
  return now < entryEnd
    ? { phase: 'entry', start: entryStart, end: entryEnd, entryStart, entryEnd, resultsEnd }
    : { phase: 'results', start: entryEnd, end: resultsEnd, entryStart, entryEnd, resultsEnd };
};

export type HousingNoticeKind = 'entry' | 'deadline' | 'results';
interface HousingEvent {
  kind: HousingNoticeKind;
  at: Date;
  /** これを過ぎたら、もう送らない（Botが長く止まっていたときなど） */
  until: Date;
}

/** この回のお知らせ（受付・締め切り前・結果発表） */
const housingEvents = (period: HousingPeriod): HousingEvent[] => {
  const deadline = new Date(period.entryEnd.getTime() - DEADLINE_NOTICE_HOURS * 60 * 60_000);
  return [
    { kind: 'entry', at: period.entryStart, until: deadline },
    { kind: 'deadline', at: deadline, until: period.entryEnd },
    { kind: 'results', at: period.entryEnd, until: period.resultsEnd },
  ];
};

const NOTICE_LABELS: Record<HousingNoticeKind, string> = { entry: '受付期間', deadline: '締め切り前', results: '結果発表' };

/** 「11/5 23:00 まで（あと 2日3時間）」 */
const untilText = (end: Date, now: Date): string => `${formatShortDateTime(end)} まで（あと ${formatDuration(end.getTime() - now.getTime())}）`;

// ---- 「ハウジング抽選」ロール

export const findHousingRole = (guild: Guild): Role | undefined => guild.roles.cache.find((role) => role.name === HOUSING_ROLE_NAME);

/**
 * 「ハウジング抽選」ロールがなければ作る。作ったときはそのロールを返す。
 * メンバー同士で鳴らし合わないよう、誰でもメンションできる設定にはしない（お知らせは Bot がメンションする）
 */
export const ensureHousingRole = async (guild: Guild): Promise<Role | null> => {
  if (findHousingRole(guild)) return null;
  const me = guild.members.me ?? (await guild.members.fetchMe());
  if (!me.permissions.has(PermissionFlagsBits.ManageRoles)) {
    console.warn(`「${guild.name}」: Botにロールの管理権限がないため、「${HOUSING_ROLE_NAME}」ロールを作れません`);
    return null;
  }
  const role = await guild.roles.create({ name: HOUSING_ROLE_NAME, permissions: [], mentionable: false, reason: 'ハウジング抽選のお知らせを受け取る人のロール' });
  console.log(`「${guild.name}」に「${HOUSING_ROLE_NAME}」ロールを作りました`);
  return role;
};

// ---- メンバーの画面（設定パネルの「🏠 ハウジング抽選」）

export const memberScreen = async (member: GuildMember, note?: string, now: Date = new Date()) => {
  const { guild } = member;
  const anchor = await loadHousingAnchor(guild.id);
  const period = anchor ? housingPeriod(anchor, now) : null;
  const entry = period ? await findHousingEntry(guild.id, member.id, period.entryEnd) : null;
  const role = findHousingRole(guild);
  const on = !!role && member.roles.cache.has(role.id);
  const toggle = (value: boolean): ButtonBuilder =>
    new ButtonBuilder()
      .setCustomId(value ? ROLE_ON_ID : ROLE_OFF_ID)
      .setLabel(value ? '受け取る' : '受け取らない')
      .setEmoji({ name: value ? '🔔' : '🔕' })
      .setStyle(on === value ? ButtonStyle.Primary : ButtonStyle.Secondary)
      .setDisabled(!role);
  return {
    content: [
      ...(note ? [note, ''] : []),
      '🏠 **ハウジング抽選のお知らせ**',
      period
        ? period.phase === 'entry'
          ? `今は **受付期間**: ${untilText(period.end, now)}`
          : `今は **結果発表期間**: ${untilText(period.end, now)}。次の受付は ${formatShortDateTime(period.resultsEnd)} から`
        : '⚠ 管理者がまだ日程を設定していません（設定されると、お知らせが流れるようになります）。',
      '',
      role
        ? `受け取ると「${HOUSING_ROLE_NAME}」ロールが付き、受付の始まり・締め切り${DEADLINE_NOTICE_HOURS}時間前・結果発表の始まりに「${NOTICE_CHANNEL_NAME}」チャンネルでメンションが届きます（青いボタンが今の設定）。`
        : `「${HOUSING_ROLE_NAME}」ロールがないため、今はお知らせの受け取りを切り替えられません（Botの再起動時に作られます）。`,
      '',
      `📝 **申し込みメモ**（今回）: ${entry ?? 'なし'}`,
      '申し込んだ区画を書いておくと、結果発表のときにDMで「結果を見に行きましょう」とお知らせします。',
    ].join('\n'),
    components: [
      new ActionRowBuilder<ButtonBuilder>().addComponents(
        toggle(true),
        toggle(false),
        new ButtonBuilder()
          .setCustomId(ENTRY_BUTTON_ID)
          .setLabel('申し込みメモ')
          .setEmoji({ name: '📝' })
          .setStyle(ButtonStyle.Secondary)
          .setDisabled(period?.phase !== 'entry'),
      ),
    ],
  };
};

const entryModal = (current: string | null): ModalBuilder => {
  const input = new TextInputBuilder()
    .setCustomId(PLOT_INPUT_ID)
    .setStyle(TextInputStyle.Paragraph)
    .setMaxLength(MAX_PLOT_LENGTH)
    .setRequired(false)
    .setPlaceholder('例: Tiamat ミスト・ヴィレッジ 3区 12番（個人）');
  if (current) input.setValue(current);
  return new ModalBuilder()
    .setCustomId(ENTRY_MODAL_ID)
    .setTitle('申し込みメモ')
    .addLabelComponents(new LabelBuilder().setLabel('申し込んだ区画').setDescription('空欄で送ると消します').setTextInputComponent(input));
};

// ---- 管理者の画面（管理パネルの「🏠 ハウジング抽選」）

export const adminScreen = async (guild: Guild, note?: string, now: Date = new Date()) => {
  const [anchor] = await Promise.all([loadHousingAnchor(guild.id), fetchAllMembers(guild)]);
  const period = anchor ? housingPeriod(anchor, now) : null;
  const role = findHousingRole(guild);
  const channel = findTextChannel(guild, NOTICE_CHANNEL_NAME);
  const upcoming = period
    ? [
        ...housingEvents(period).filter((event) => event.at > now),
        // 次の回の受付の始まり
        { kind: 'entry' as const, at: period.resultsEnd },
      ]
    : [];
  const eventLabels: Record<HousingNoticeKind, string> = { entry: '🏠 受付の始まり', deadline: '⏰ 締め切り前', results: '🎉 結果発表' };
  const problems = [
    ...(channel && canBotPost(channel) ? [] : [`⚠「${NOTICE_CHANNEL_NAME}」チャンネルがないか、Botが書き込めないため、お知らせを流せません。`]),
    ...(role ? [] : [`⚠「${HOUSING_ROLE_NAME}」ロールがありません（Botの再起動時に作られます）。`]),
  ];
  return {
    content: [
      ...(note ? [note, ''] : []),
      '🏠 **ハウジング抽選の日程**',
      ...(period
        ? [
            `今は **${PHASE_LABELS[period.phase]}**: ${untilText(period.end, now)}`,
            `次のお知らせ: ${upcoming.map((event) => `${eventLabels[event.kind]} ${formatShortDateTime(event.at)}`).join(' / ')}`,
          ]
        : ['まだ日程を設定していません。「日程を合わせる」で、今の期間と、それが終わる日時を入れてください（ゲーム内の区画の看板や公式サイトで確かめられます）。']),
      `お知らせは「${NOTICE_CHANNEL_NAME}」チャンネルに流し、「${HOUSING_ROLE_NAME}」ロールの人（${role ? role.members.size : 0}人）にメンションします。申し込みメモを残した人には、結果発表のときにDMでも知らせます。`,
      '',
      `抽選は「受付${ENTRY_DAYS}日 → 結果発表${RESULTS_DAYS}日」の9日ごとに繰り返すので、一度合わせればあとは自動で計算します。メンテなどでずれたときは、もう一度合わせてください。`,
      ...(problems.length > 0 ? ['', ...problems] : []),
    ].join('\n'),
    components: [
      new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder().setCustomId(SCHEDULE_BUTTON_ID).setLabel('日程を合わせる').setEmoji({ name: '📅' }).setStyle(ButtonStyle.Primary),
        ...(period
          ? [new ButtonBuilder().setCustomId(SCHEDULE_STOP_ID).setLabel('お知らせを止める').setEmoji({ name: '🛑' }).setStyle(ButtonStyle.Danger)]
          : []),
      ),
    ],
  };
};

const scheduleModal = (): ModalBuilder =>
  new ModalBuilder()
    .setCustomId(SCHEDULE_MODAL_ID)
    .setTitle('抽選の日程を合わせる')
    .addLabelComponents(
      new LabelBuilder()
        .setLabel('今の期間')
        .setStringSelectMenuComponent(
          new StringSelectMenuBuilder()
            .setCustomId(PHASE_INPUT_ID)
            .setRequired(true)
            .addOptions(
              { label: `受付期間（${ENTRY_DAYS}日）`, value: 'entry', default: true },
              { label: `結果発表期間（${RESULTS_DAYS}日）`, value: 'results' },
            ),
        ),
      new LabelBuilder()
        .setLabel('今の期間が終わる日時（日本時間）')
        .setDescription('例: 11/5 23:00')
        .setTextInputComponent(new TextInputBuilder().setCustomId(END_INPUT_ID).setStyle(TextInputStyle.Short).setMaxLength(20).setRequired(true).setPlaceholder('11/5 23:00')),
    );

/** 今の期間と終わる日時から、日程の基準（受付の終わり）を決める。おかしければ理由を返す */
export const anchorFrom = (phase: HousingPhase, endText: string, now: Date): Date | string => {
  const text = endText.normalize('NFKC').trim();
  const end = parseJstDateTime(text, now);
  if (end === 'format') return '日時は「11/5 23:00」の形で入力してください。';
  if (end === 'invalid') return `「${text}」という日時はありません。`;
  if (end <= now) return `${formatShortDateTime(end)} はもう過ぎています。今の期間が終わる日時を入れてください。`;
  const days = phase === 'entry' ? ENTRY_DAYS : RESULTS_DAYS;
  // 年を書かずに過ぎた日付を入れると来年になるので、そのときも気づけるようにする
  if (end.getTime() - now.getTime() > days * DAY_MS) {
    return `${PHASE_LABELS[phase]}は${days}日なので、${days}日より先の日時にはなりません（過ぎた日時を入れていませんか？）。`;
  }
  // 結果発表の終わりから、その回の受付の終わりへ戻す
  return phase === 'entry' ? end : new Date(end.getTime() - RESULTS_DAYS * DAY_MS);
};

// ---- 操作

export const handleButton = async (interaction: ButtonInteraction<'cached'>): Promise<void> => {
  const { guild, member } = interaction;
  switch (interaction.customId) {
    case OPEN_BUTTON_ID:
      await deferScreen(interaction);
      await interaction.editReply(await memberScreen(member));
      return;
    case ROLE_ON_ID:
    case ROLE_OFF_ID: {
      await interaction.deferUpdate();
      const role = findHousingRole(guild);
      const on = interaction.customId === ROLE_ON_ID;
      if (!role || member.roles.cache.has(role.id) === on) {
        await interaction.editReply(await memberScreen(member, '変更はありませんでした。'));
        return;
      }
      const updated = on ? await member.roles.add(role, 'ハウジング抽選のお知らせの設定') : await member.roles.remove(role, 'ハウジング抽選のお知らせの設定');
      void sendLog(guild, 'housing', `${member} が「${HOUSING_ROLE_NAME}」を${on ? '付けました' : '外しました'}`, member, {
        title: 'ハウジング抽選のお知らせの設定',
      });
      await interaction.editReply(await memberScreen(updated, on ? `🔔 「${HOUSING_ROLE_NAME}」ロールを付けました。` : `🔕 「${HOUSING_ROLE_NAME}」ロールを外しました。`));
      return;
    }
    case ENTRY_BUTTON_ID: {
      const anchor = await loadHousingAnchor(guild.id);
      const period = anchor ? housingPeriod(anchor, new Date()) : null;
      if (period?.phase !== 'entry') {
        await interaction.update(await memberScreen(member, '今は受付期間ではないので、申し込みメモは書けません。'));
        return;
      }
      await interaction.showModal(entryModal(await findHousingEntry(guild.id, member.id, period.entryEnd)));
      return;
    }
    case ADMIN_BUTTON_ID:
      if (!(await ensureAdmin(interaction))) return;
      await deferScreen(interaction);
      await interaction.editReply(await adminScreen(guild));
      return;
    case SCHEDULE_BUTTON_ID:
      if (!(await ensureAdmin(interaction))) return;
      await interaction.showModal(scheduleModal());
      return;
    case SCHEDULE_STOP_ID: {
      if (!(await ensureAdmin(interaction))) return;
      await interaction.deferUpdate();
      await saveHousingAnchor(guild.id, null);
      void sendLog(guild, 'housing', `${member} がハウジング抽選のお知らせを止めました（日程を消しました）`, member, { title: 'ハウジング抽選の日程' });
      await interaction.editReply(await adminScreen(guild, '🛑 日程を消して、お知らせを止めました。'));
      return;
    }
  }
};

/** 本人にだけ見える画面からなら切り替え、パネルからなら新しく出す */
const deferScreen = async (interaction: ButtonInteraction<'cached'>): Promise<void> => {
  if (interaction.message.flags.has(MessageFlags.Ephemeral)) {
    await interaction.deferUpdate();
  } else {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  }
};

export const handleModalSubmit = async (interaction: ModalSubmitInteraction<'cached'>): Promise<void> => {
  const { guild, member } = interaction;
  if (interaction.customId === ENTRY_MODAL_ID) {
    await deferModal(interaction);
    const anchor = await loadHousingAnchor(guild.id);
    const period = anchor ? housingPeriod(anchor, new Date()) : null;
    if (period?.phase !== 'entry') {
      await interaction.editReply(await memberScreen(member, '受付期間が終わったため、申し込みメモは残せませんでした。'));
      return;
    }
    const plot = interaction.fields.getTextInputValue(PLOT_INPUT_ID).trim().slice(0, MAX_PLOT_LENGTH);
    await saveHousingEntry(guild.id, member.id, period.entryEnd, plot);
    void sendLog(guild, 'housing', plot ? `${member} がハウジング抽選の申し込みメモを残しました` : `${member} がハウジング抽選の申し込みメモを消しました`, member, {
      title: 'ハウジング抽選の申し込みメモ',
      fields: plot ? [{ name: '📝 区画', value: plot }] : [],
    });
    const note = plot ? `📝 申し込みメモを残しました。結果発表（${formatShortDateTime(period.entryEnd)}）のときにDMでお知らせします。` : '🗑️ 申し込みメモを消しました。';
    await interaction.editReply(await memberScreen(member, note));
    return;
  }
  if (interaction.customId === SCHEDULE_MODAL_ID) {
    if (!(await ensureAdmin(interaction))) return;
    await deferModal(interaction);
    const now = new Date();
    const phase: HousingPhase = interaction.fields.getStringSelectValues(PHASE_INPUT_ID)[0] === 'results' ? 'results' : 'entry';
    const anchor = anchorFrom(phase, interaction.fields.getTextInputValue(END_INPUT_ID), now);
    if (typeof anchor === 'string') {
      await interaction.editReply(await adminScreen(guild, `⚠ ${anchor}`));
      return;
    }
    await saveHousingAnchor(guild.id, anchor);
    const period = housingPeriod(anchor, now);
    void sendLog(guild, 'housing', `${member} がハウジング抽選の日程を合わせました`, member, {
      title: 'ハウジング抽選の日程',
      fields: [
        { name: '📅 今の期間', value: `${PHASE_LABELS[period.phase]}（${formatShortDateTime(period.end)} まで）`, inline: true },
        { name: '🎉 結果発表', value: formatShortDateTime(period.entryEnd), inline: true },
      ],
    });
    await interaction.editReply(await adminScreen(guild, '✅ 日程を合わせました。'));
  }
};

const deferModal = async (interaction: ModalSubmitInteraction<'cached'>): Promise<void> => {
  if (interaction.isFromMessage()) {
    await interaction.deferUpdate();
  } else {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  }
};

// ---- お知らせ

/** 「通知」チャンネルに流す文 */
const channelText = (kind: HousingNoticeKind, period: HousingPeriod, now: Date): string => {
  switch (kind) {
    case 'entry':
      return [
        `🏠 **ハウジング抽選の受付期間です**（${formatShortDateTime(period.entryEnd)} まで）`,
        '申し込んだら、設定パネルの「🏠 ハウジング抽選」で区画をメモしておくと、結果発表のときにDMでお知らせします。',
      ].join('\n');
    case 'deadline':
      return `⏰ **ハウジング抽選の受付は、${formatShortDateTime(period.entryEnd)} で締め切り**です（あと ${formatDuration(period.entryEnd.getTime() - now.getTime())}）。まだの人はお早めに！`;
    case 'results':
      return [
        `🎉 **ハウジング抽選の結果発表が始まりました**（${formatShortDateTime(period.resultsEnd)} まで）`,
        '当選したら期間中に引き渡しの手続きを、外れたら預託金の返還を忘れずに。',
      ].join('\n');
  }
};

/** 結果発表のときに、申し込みメモを残した人へ送るDM */
const resultsDm = (guild: Guild, period: HousingPeriod, plot: string): string =>
  [
    `🎉 「${guild.name}」より: ハウジング抽選の結果発表が始まりました（${formatShortDateTime(period.resultsEnd)} まで）。`,
    `📝 あなたの申し込み: ${plot}`,
    '結果を見に行きましょう！当選したら期間中に引き渡しの手続きを、外れたら預託金の返還を忘れずに。',
  ].join('\n');

/** そのサーバーで、今出すお知らせがあれば出す（「通知」チャンネル。結果発表では、申し込みメモを残した人にDMも） */
export const sendHousingNotices = async (guild: Guild, now: Date = new Date()): Promise<void> => {
  const anchor = await loadHousingAnchor(guild.id);
  if (!anchor) return;
  const period = housingPeriod(anchor, now);
  for (const event of housingEvents(period)) {
    if (event.at > now || now >= event.until) continue;
    if (!(await claimHousingNotice(guild.id, event.kind, event.at))) continue;

    const role = findHousingRole(guild);
    const channel = findTextChannel(guild, NOTICE_CHANNEL_NAME);
    const posted =
      channel && canBotPost(channel)
        ? await channel
            .send({
              content: [...(role ? [`${role}`] : []), channelText(event.kind, period, now)].join('\n'),
              allowedMentions: { parse: [], roles: role ? [role.id] : [] },
            })
            .then(
              (message) => message,
              (error: unknown) => {
                console.error(`「${guild.name}」の「${NOTICE_CHANNEL_NAME}」にハウジング抽選のお知らせを流せませんでした:`, error);
                return null;
              },
            )
        : null;

    // 結果発表では、申し込みメモを残した人にだけDMでも知らせる
    let sent = 0;
    let failed = 0;
    const entries = event.kind === 'results' ? await listHousingEntries(guild.id, period.entryEnd) : new Map<string, string>();
    if (entries.size > 0) {
      const members = await fetchAllMembers(guild);
      for (const [userId, plot] of entries) {
        const member = members.get(userId);
        if (!member || member.user.bot) continue;
        const ok = await member.send(resultsDm(guild, period, plot)).then(
          () => true,
          () => false,
        );
        if (ok) sent++;
        else failed++;
      }
    }

    void sendLog(
      guild,
      'housing',
      posted
        ? `ハウジング抽選の「${NOTICE_LABELS[event.kind]}」のお知らせを「${NOTICE_CHANNEL_NAME}」に流しました`
        : `ハウジング抽選の「${NOTICE_LABELS[event.kind]}」のお知らせを「${NOTICE_CHANNEL_NAME}」に流せませんでした（チャンネルがないか、Botが書き込めない）`,
      undefined,
      {
        title: 'ハウジング抽選のお知らせ',
        fields: [
          { name: '🔔 メンション', value: role ? `「${HOUSING_ROLE_NAME}」ロール（${role.members.size}人）` : 'なし（ロールがない）', inline: true },
          ...(event.kind === 'results'
            ? [{ name: '✉️ 申し込みメモの人へのDM', value: `${sent}人${failed > 0 ? `（送れなかった ${failed}人）` : ''}`, inline: true }]
            : []),
        ],
        links: posted ? [{ label: 'お知らせへ移動', url: posted.url }] : [],
      },
    );
  }
};

/** 起動時と、そのあと1分ごとに、出すお知らせがないか見る（Botが止まっていた間の分も、期間中なら出す） */
export const startHousingNotices = (client: Client<true>): void => {
  const run = () => {
    for (const guild of client.guilds.cache.values()) {
      sendHousingNotices(guild).catch((error: unknown) => {
        reportError(`「${guild.name}」のハウジング抽選のお知らせに失敗しました`, error, guild);
      });
    }
  };
  run();
  setInterval(run, TICK_MS).unref();
};
