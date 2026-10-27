import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  InteractionContextType,
  LabelBuilder,
  MessageFlags,
  ModalBuilder,
  PermissionFlagsBits,
  SlashCommandBuilder,
  StringSelectMenuBuilder,
  TextInputBuilder,
  TextInputStyle,
  UserSelectMenuBuilder,
  messageLink,
  time,
  type ButtonInteraction,
  type ChannelSelectMenuInteraction,
  type ChatInputCommandInteraction,
  type ModalSubmitInteraction,
} from 'discord.js';
import { sendLog } from '../activityLog.js';
import { buildAdminReport } from '../adminReport.js';
import {
  AUTO_APPROVE_BUTTON_ID,
  AUTO_APPROVE_OFF_ID,
  AUTO_APPROVE_ON_ID,
  DEFAULT_INACTIVE_DAYS,
  INACTIVE_DAYS,
  INACTIVE_PREFIX,
  KARTE_BUTTON_ID,
  KARTE_LOGS_PREFIX,
  KARTE_MODAL_ID,
  WELCOME_BUTTON_ID,
  WELCOME_EDIT_ID,
  WELCOME_MODAL_ID,
  WELCOME_OFF_ID,
  WELCOME_ON_ID,
  WELCOME_TEST_ID,
  XP_ADJUST_BUTTON_ID,
  XP_ADJUST_FOR_PREFIX,
  XP_ADJUST_MODAL_ID,
  XP_CHANNELS_BUTTON_ID,
  XP_CHANNELS_SELECT_ID,
  applyXpAdjustment,
  autoApproveScreen,
  buildMemberKarte,
  inactiveScreen,
  karteModal,
  saveXpChannels,
  sendWelcomeTest,
  setAutoApprove,
  setWelcomeEnabled,
  setWelcomeMessage,
  welcomeMessageFrom,
  welcomeModal,
  welcomeScreen,
  xpAdjustModal,
  xpChannelsScreen,
} from '../adminTools.js';
import { loadWelcomeSettings } from '../guildSettings.js';
import { fetchAllMembers } from '../guildUtils.js';
import { addDays, formatShortDateTime, jstDay } from '../jst.js';
import { nameById, nameWithUsername } from '../names.js';
import { rememberPanel, type PanelPayload } from '../panels.js';
import { profileLogFields } from '../profile.js';
import { ADMIN_ROLE_NAME, ensureAdmin } from '../permissions.js';
import { MEMBER_ROLE_NAME, PROFILE_CHANNEL_NAME, findMemberRole } from '../profilePublish.js';
import { deleteProfile, findStoredProfile, listPendingApplications, listStoredProfiles } from '../profileStore.js';
import { CSV_LIMIT, LIST_LIMIT, LOG_SEARCH_TYPES, describeFilter, toSearchType, type LogSearchFilter } from '../logSearch.js';
import {
  BOOST_HOURS,
  BOOST_PERCENTS,
  activeBoost,
  createBoost,
  describeBoostPeriod,
  formatHours,
  formatPercent,
  listBoosts,
  parseBoostStart,
  stopBoost,
  type XpBoost,
} from '../xpBoost.js';
import { replyWithSearch } from './logSearch.js';
import { openAdminRegisterModal } from './profilePanel.js';

// customId は「admin:<操作>」の形
export const CUSTOM_ID_PREFIX = 'admin:';
const REGISTER_BUTTON_ID = `${CUSTOM_ID_PREFIX}register`;
const PENDING_BUTTON_ID = `${CUSTOM_ID_PREFIX}pending`;
const UNREGISTERED_BUTTON_ID = `${CUSTOM_ID_PREFIX}unregistered`;
const DELETE_BUTTON_ID = `${CUSTOM_ID_PREFIX}delete`;
const DELETE_MODAL_ID = `${CUSTOM_ID_PREFIX}delete-submit`;
const LOG_SEARCH_BUTTON_ID = `${CUSTOM_ID_PREFIX}log-search`;
const LOG_SEARCH_MODAL_ID = `${CUSTOM_ID_PREFIX}log-search-submit`;
const REPORT_BUTTON_ID = `${CUSTOM_ID_PREFIX}report`;
const BOOST_BUTTON_ID = `${CUSTOM_ID_PREFIX}boost`;
const BOOST_NEW_BUTTON_ID = `${CUSTOM_ID_PREFIX}boost-new`;
/** 「止める」ボタン（後ろにXPアップのIDが付く） */
const BOOST_STOP_PREFIX = `${CUSTOM_ID_PREFIX}boost-stop:`;
const BOOST_MODAL_ID = `${CUSTOM_ID_PREFIX}boost-submit`;
const BOOST_PERCENT_INPUT_ID = 'boostPercent';
const BOOST_START_INPUT_ID = 'boostStart';
const BOOST_HOURS_INPUT_ID = 'boostHours';
const BOOST_LABEL_INPUT_ID = 'boostLabel';
/** XPアップの画面に並べる「止める」ボタンの数（1行に収まる数） */
const MAX_BOOST_BUTTONS = 5;
const MEMBER_INPUT_ID = 'member';
const MEMBER_ROLE_INPUT_ID = 'memberRole';
const REASON_INPUT_ID = 'reason';
const AMOUNT_INPUT_ID = 'amount';
const TYPE_INPUT_ID = 'type';
const DAYS_INPUT_ID = 'days';
const KEYWORD_INPUT_ID = 'keyword';
const OUTPUT_INPUT_ID = 'output';
/** ログ検索で選べる期間（日） */
const SEARCH_DAYS = [1, 3, 7, 30, 90, 365];
/** 一覧に一度に出す件数 */
const MAX_LISTED = 30;

export const data = new SlashCommandBuilder()
  .setName('admin-panel')
  .setNameLocalizations({ ja: '管理パネル' })
  .setDescription('管理者用の操作パネルをこのチャンネルに設置します（管理者用）')
  .setContexts(InteractionContextType.Guild);

export const execute = async (interaction: ChatInputCommandInteraction<'cached'>): Promise<void> => {
  const channel = interaction.channel;
  if (!channel?.isSendable()) {
    await interaction.reply({ content: 'このチャンネルにはパネルを設置できません。', flags: MessageFlags.Ephemeral });
    return;
  }

  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  // パネルの設置で通知が飛ばないよう、サイレントメッセージで送る。場所を覚えておき、起動時に最新の内容へ作り直す
  const payload = buildPanel();
  const message = await channel.send({ ...payload, flags: MessageFlags.SuppressNotifications });
  await rememberPanel(message, 'admin', payload);
  void sendLog(interaction.guild, 'panel', `${interaction.member} が管理パネルを設置しました`, interaction.member, {
    channel,
    links: [{ label: 'パネルへ移動', url: message.url }],
  });

  // ボタンは管理者しか使えないが、パネル自体は見えてしまうので、誰でも見られるチャンネルなら知らせる
  const isPublic =
    'permissionsFor' in channel && channel.permissionsFor(interaction.guild.roles.everyone).has(PermissionFlagsBits.ViewChannel);
  await interaction.editReply(
    [
      '管理パネルを設置しました。',
      ...(isPublic ? ['⚠ このチャンネルは誰でも見られます。ボタンは管理者しか使えませんが、管理者用のチャンネルに置くのがおすすめです。'] : []),
    ].join('\n'),
  );
};

/** パネルの中身（設置するときと、起動時に作り直すときで共通） */
export const buildPanel = (): PanelPayload => {
  const embed = new EmbedBuilder()
    .setTitle('🛠️ 管理パネル')
    .setDescription(
      [
        `管理者用の操作です。「${ADMIN_ROLE_NAME}」ロールを持つ人だけが使えます。結果は押した人にだけ表示します。`,
        '',
        '__**👤 メンバー**__',
        `**ユーザーを登録**: メンバーを選んで、本人の登録と同じ手順でプロフィールを入力します（審査なしで「${PROFILE_CHANNEL_NAME}」に投稿し、「${MEMBER_ROLE_NAME}」ロールを付けます）`,
        '**審査中の申請**: まだ許可・拒否していない申請の一覧',
        '**未登録のメンバー**: 入ったまま、プロフィールを登録していない人の一覧',
        `**プロフィールを削除**: プロフィールと「${PROFILE_CHANNEL_NAME}」の投稿を削除します`,
        '',
        '__**⚙️ 設定**__',
        '**申請の自動許可**: プロフィールの申請を、管理者の確認なしですぐ許可するかどうか',
        '**入った人への案内**: 入った人にDMで送る案内（プロフ登録・設定・PT募集への行き方）。送る・送らないと、一言を変えられます',
        '',
        '__**🔎 調べる**__',
        '**メンバーの詳細**: 1人の参加日・招待リンク・プロフィール・レベル・最後に来た日・設定・ロール・最近のログをまとめて見ます',
        '**来ていない人**: 最後に発言・VC・リアクションをした日が古い人の一覧（7〜60日）',
        '**ログ検索**: 行動ログ・発言・VCの出入りを、人・期間・キーワードで探します（一覧かCSV）',
        '**管理レポート**: 直近7日の参加・退出・申請・来た人・来なくなった人など（毎週月曜9時に「ログ」にも出ます）',
        '',
        '__**📊 レベル**__',
        '**XPアップ**: 期間を決めて、発言とVCでもらえるXPを1.5〜3倍にします（予約もできます）',
        '**XPの調整**: メンバーのXPを足す・引く（理由はログに残ります）',
        '**XPなしチャンネル**: 発言・リアクション・VCをXPにしないチャンネルを選びます',
      ].join('\n'),
    )
    .setColor(0x99aab5);
  const memberRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
    panelButton(REGISTER_BUTTON_ID, 'ユーザーを登録', '👤', ButtonStyle.Primary),
    panelButton(PENDING_BUTTON_ID, '審査中の申請', '📋', ButtonStyle.Secondary),
    panelButton(UNREGISTERED_BUTTON_ID, '未登録のメンバー', '👥', ButtonStyle.Secondary),
    panelButton(DELETE_BUTTON_ID, 'プロフィールを削除', '🗑️', ButtonStyle.Danger),
  );
  const settingsRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
    panelButton(AUTO_APPROVE_BUTTON_ID, '申請の自動許可', '✅', ButtonStyle.Secondary),
    panelButton(WELCOME_BUTTON_ID, '入った人への案内', '👋', ButtonStyle.Secondary),
  );
  const lookupRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
    panelButton(KARTE_BUTTON_ID, 'メンバーの詳細', '🗂️', ButtonStyle.Secondary),
    panelButton(INACTIVE_PREFIX, '来ていない人', '💤', ButtonStyle.Secondary),
    panelButton(LOG_SEARCH_BUTTON_ID, 'ログ検索', '🔎', ButtonStyle.Secondary),
    panelButton(REPORT_BUTTON_ID, '管理レポート', '📊', ButtonStyle.Secondary),
  );
  const levelRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
    panelButton(BOOST_BUTTON_ID, 'XPアップ', '⚡', ButtonStyle.Secondary),
    panelButton(XP_ADJUST_BUTTON_ID, 'XPの調整', '✏️', ButtonStyle.Secondary),
    panelButton(XP_CHANNELS_BUTTON_ID, 'XPなしチャンネル', '🚫', ButtonStyle.Secondary),
  );
  return { embeds: [embed], components: [memberRow, settingsRow, lookupRow, levelRow] };
};

export const handleButton = async (interaction: ButtonInteraction<'cached'>): Promise<void> => {
  if (interaction.customId === REGISTER_BUTTON_ID) {
    // 入力の手順は本人の登録と同じものを使う（管理者かどうかの確認も中で行う）
    await openAdminRegisterModal(interaction);
    return;
  }
  if (!(await ensureAdmin(interaction))) return;

  switch (interaction.customId) {
    case PENDING_BUTTON_ID:
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      await interaction.editReply({ embeds: [await pendingListEmbed(interaction)] });
      return;
    case UNREGISTERED_BUTTON_ID:
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      await interaction.editReply({ embeds: [await unregisteredListEmbed(interaction)] });
      return;
    case DELETE_BUTTON_ID:
      await interaction.showModal(deleteModal());
      return;
    case LOG_SEARCH_BUTTON_ID:
      await interaction.showModal(logSearchModal());
      return;
    case BOOST_BUTTON_ID:
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      await interaction.editReply(await boostScreen(interaction.guild.id));
      return;
    case BOOST_NEW_BUTTON_ID:
      await interaction.showModal(boostModal());
      return;
    case KARTE_BUTTON_ID:
      await interaction.showModal(karteModal());
      return;
    case XP_ADJUST_BUTTON_ID:
      await interaction.showModal(xpAdjustModal());
      return;
    case XP_CHANNELS_BUTTON_ID:
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      await interaction.editReply(await xpChannelsScreen(interaction.guild));
      return;
    case REPORT_BUTTON_ID: {
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      const today = jstDay();
      const embed = await buildAdminReport(interaction.guild, addDays(today, -6), addDays(today, 1), '📊 管理レポート（直近7日）');
      await interaction.editReply({ embeds: [embed], allowedMentions: { parse: [] } });
      return;
    }
    case WELCOME_BUTTON_ID:
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      await interaction.editReply(await welcomeScreen(interaction.guild));
      return;
    case WELCOME_ON_ID:
    case WELCOME_OFF_ID: {
      await interaction.deferUpdate();
      const note = await setWelcomeEnabled(interaction.member, interaction.customId === WELCOME_ON_ID);
      await interaction.editReply(await welcomeScreen(interaction.guild, note));
      return;
    }
    case WELCOME_EDIT_ID:
      await interaction.showModal(welcomeModal((await loadWelcomeSettings(interaction.guild.id)).message));
      return;
    case WELCOME_TEST_ID: {
      await interaction.deferUpdate();
      const note = await sendWelcomeTest(interaction.member);
      await interaction.editReply(await welcomeScreen(interaction.guild, note));
      return;
    }
    case AUTO_APPROVE_BUTTON_ID:
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      await interaction.editReply(await autoApproveScreen(interaction.guild));
      return;
    case AUTO_APPROVE_ON_ID:
    case AUTO_APPROVE_OFF_ID: {
      await interaction.deferUpdate();
      const note = await setAutoApprove(interaction.member, interaction.customId === AUTO_APPROVE_ON_ID);
      await interaction.editReply(await autoApproveScreen(interaction.guild, note));
      return;
    }
  }
  if (interaction.customId.startsWith(BOOST_STOP_PREFIX)) {
    await stopBoostFromButton(interaction, interaction.customId.slice(BOOST_STOP_PREFIX.length));
    return;
  }
  if (interaction.customId.startsWith(INACTIVE_PREFIX)) {
    // パネルのボタンなら新しく出し、一覧の日数のボタンならその一覧を切り替える
    const days = Number(interaction.customId.slice(INACTIVE_PREFIX.length + 1));
    if (interaction.message.flags.has(MessageFlags.Ephemeral)) {
      await interaction.deferUpdate();
    } else {
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    }
    await interaction.editReply(await inactiveScreen(interaction.guild, INACTIVE_DAYS.includes(days) ? days : DEFAULT_INACTIVE_DAYS));
    return;
  }
  if (interaction.customId.startsWith(KARTE_LOGS_PREFIX)) {
    const userId = interaction.customId.slice(KARTE_LOGS_PREFIX.length);
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    await replyWithSearch(interaction, { type: 'all', userId, days: 30, keyword: null }, false);
    return;
  }
  if (interaction.customId.startsWith(XP_ADJUST_FOR_PREFIX)) {
    await interaction.showModal(xpAdjustModal(interaction.customId.slice(XP_ADJUST_FOR_PREFIX.length)));
  }
};

/** 「XPなしチャンネル」の選び直し */
export const handleChannelSelect = async (interaction: ChannelSelectMenuInteraction<'cached'>): Promise<void> => {
  if (interaction.customId !== XP_CHANNELS_SELECT_ID || !(await ensureAdmin(interaction))) return;
  await interaction.deferUpdate();
  const note = await saveXpChannels(interaction.member, interaction.values);
  await interaction.editReply(await xpChannelsScreen(interaction.guild, note));
};

export const handleModalSubmit = async (interaction: ModalSubmitInteraction<'cached'>): Promise<void> => {
  if (!(await ensureAdmin(interaction))) return;
  switch (interaction.customId) {
    case DELETE_MODAL_ID:
      await deleteProfileFromModal(interaction);
      return;
    case LOG_SEARCH_MODAL_ID:
      await searchFromModal(interaction);
      return;
    case BOOST_MODAL_ID:
      await createBoostFromModal(interaction);
      return;
    case KARTE_MODAL_ID: {
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      const user = interaction.fields.getSelectedUsers(MEMBER_INPUT_ID)?.first();
      const member = user ? await interaction.guild.members.fetch(user.id).catch(() => null) : null;
      await interaction.editReply(member ? await buildMemberKarte(member) : { content: 'そのメンバーはサーバーにいません。' });
      return;
    }
    case XP_ADJUST_MODAL_ID: {
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      const user = interaction.fields.getSelectedUsers(MEMBER_INPUT_ID)?.first();
      const target = user ? await interaction.guild.members.fetch(user.id).catch(() => null) : null;
      const content = await applyXpAdjustment(interaction.member, {
        target,
        amount: interaction.fields.getTextInputValue(AMOUNT_INPUT_ID),
        reason: interaction.fields.getTextInputValue(REASON_INPUT_ID).trim(),
      });
      await interaction.editReply({ content, allowedMentions: { parse: [] } });
      return;
    }
    case WELCOME_MODAL_ID: {
      // 案内の画面から開いたモーダルなので、その画面を書き換える
      if (interaction.isFromMessage()) {
        await interaction.deferUpdate();
      } else {
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      }
      const note = await setWelcomeMessage(interaction.member, welcomeMessageFrom(interaction.fields));
      await interaction.editReply(await welcomeScreen(interaction.guild, note));
      return;
    }
  }
};

// ---- XPアップ

/** 開催中・これからのXPアップの一覧と、新しく設定する・止めるボタン。note は操作の結果 */
const boostScreen = async (guildId: string, note?: string) => {
  const now = new Date();
  const boosts = await listBoosts(guildId, now);
  const active = activeBoost(guildId, now);
  const embed = new EmbedBuilder()
    .setTitle('⚡ XPアップ')
    .setColor(0xf1c40f)
    .setDescription(
      [
        ...(note ? [note, ''] : []),
        '期間中は、発言とVCでもらえるXPが増えます（重なっているときは倍率の大きい方）。',
        'ランキング掲示板・レベル・ランキングの画面にも出ます。',
        '',
        ...(boosts.length === 0
          ? ['今は設定されていません。']
          : boosts.map((boost) => `${isRunning(boost, now) ? '🟢 開催中' : '⏳ 予定'} ${describeBoostPeriod(boost)}`)),
        ...(active ? ['', `今の倍率: **${formatPercent(active.percent)}**`] : []),
      ].join('\n'),
    );
  const stopButtons = boosts.slice(0, MAX_BOOST_BUTTONS).map((boost) =>
    new ButtonBuilder()
      .setCustomId(`${BOOST_STOP_PREFIX}${boost.id}`)
      .setLabel(`止める: ${formatPercent(boost.percent)} ${boost.label || `${formatShortDateTime(boost.startsAt)}〜`}`.slice(0, 80))
      .setStyle(ButtonStyle.Danger),
  );
  return {
    embeds: [embed],
    components: [
      new ActionRowBuilder<ButtonBuilder>().addComponents(panelButton(BOOST_NEW_BUTTON_ID, '新しく設定', '➕', ButtonStyle.Primary)),
      ...(stopButtons.length > 0 ? [new ActionRowBuilder<ButtonBuilder>().addComponents(stopButtons)] : []),
    ],
  };
};

const isRunning = (boost: XpBoost, now: Date): boolean => boost.startsAt <= now && now < boost.endsAt;

/** 「新しく設定」のモーダルの送信。読めない開始時刻は、理由を画面に出す */
const createBoostFromModal = async (interaction: ModalSubmitInteraction<'cached'>): Promise<void> => {
  if (interaction.isFromMessage()) {
    await interaction.deferUpdate();
  } else {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  }
  const now = new Date();
  const percent = Number(interaction.fields.getStringSelectValues(BOOST_PERCENT_INPUT_ID)[0]);
  const hours = Number(interaction.fields.getStringSelectValues(BOOST_HOURS_INPUT_ID)[0]);
  const start = parseBoostStart(interaction.fields.getTextInputValue(BOOST_START_INPUT_ID), now);
  const label = interaction.fields.getTextInputValue(BOOST_LABEL_INPUT_ID).trim();
  if (!BOOST_PERCENTS.includes(percent) || !BOOST_HOURS.includes(hours)) {
    await interaction.editReply(await boostScreen(interaction.guild.id, '⚠ 倍率と長さを選び直してください。'));
    return;
  }
  if (typeof start === 'string') {
    await interaction.editReply(await boostScreen(interaction.guild.id, `⚠ ${start}`));
    return;
  }

  const boost = await createBoost({
    guildId: interaction.guild.id,
    label,
    percent,
    startsAt: start,
    endsAt: new Date(start.getTime() + hours * 60 * 60_000),
    createdBy: interaction.user.id,
  });
  await interaction.editReply(await boostScreen(interaction.guild.id, `✅ XPアップを設定しました: ${describeBoostPeriod(boost)}`));
  void sendLog(interaction.guild, 'level', `${interaction.member} がXPアップ（${formatPercent(percent)}）を設定しました`, interaction.member, {
    title: 'XPアップの設定',
    fields: [
      { name: '⚡ 倍率', value: formatPercent(percent), inline: true },
      { name: '🕘 期間', value: `${formatShortDateTime(boost.startsAt)}〜${formatShortDateTime(boost.endsAt)}（${formatHours(hours)}）`, inline: true },
      ...(label ? [{ name: '🏷️ 名前', value: label, inline: true }] : []),
    ],
  });
};

const stopBoostFromButton = async (interaction: ButtonInteraction<'cached'>, id: string): Promise<void> => {
  await interaction.deferUpdate();
  const stopped = /^\d+$/.test(id) ? await stopBoost(interaction.guild.id, id) : null;
  if (!stopped) {
    await interaction.editReply(await boostScreen(interaction.guild.id, 'そのXPアップはもう終わっています。'));
    return;
  }
  await interaction.editReply(await boostScreen(interaction.guild.id, `🛑 XPアップを止めました: ${describeBoostPeriod(stopped)}`));
  void sendLog(interaction.guild, 'level', `${interaction.member} がXPアップ（${formatPercent(stopped.percent)}）を止めました`, interaction.member, {
    title: 'XPアップの停止',
    fields: [{ name: '⚡ 止めたもの', value: describeBoostPeriod(stopped), inline: true }],
  });
};

const boostModal = (): ModalBuilder => {
  const select = (id: string, options: { label: string; value: string; default?: boolean }[]) =>
    new StringSelectMenuBuilder().setCustomId(id).setRequired(true).addOptions(options);
  return new ModalBuilder()
    .setCustomId(BOOST_MODAL_ID)
    .setTitle('XPアップを設定')
    .addLabelComponents(
      new LabelBuilder()
        .setLabel('倍率')
        .setStringSelectMenuComponent(
          select(BOOST_PERCENT_INPUT_ID, BOOST_PERCENTS.map((percent) => ({ label: formatPercent(percent), value: String(percent), default: percent === 200 }))),
        ),
      new LabelBuilder()
        .setLabel('開始（任意）')
        .setDescription('空欄なら今すぐ。例: 10/31 20:00（日本時間）')
        .setTextInputComponent(
          new TextInputBuilder().setCustomId(BOOST_START_INPUT_ID).setStyle(TextInputStyle.Short).setMaxLength(20).setRequired(false).setPlaceholder('10/31 20:00'),
        ),
      new LabelBuilder()
        .setLabel('長さ')
        .setStringSelectMenuComponent(
          select(BOOST_HOURS_INPUT_ID, BOOST_HOURS.map((hours) => ({ label: formatHours(hours), value: String(hours), default: hours === 24 }))),
        ),
      new LabelBuilder()
        .setLabel('名前（任意）')
        .setDescription('掲示板やレベルの表示に出ます')
        .setTextInputComponent(
          new TextInputBuilder().setCustomId(BOOST_LABEL_INPUT_ID).setStyle(TextInputStyle.Short).setMaxLength(30).setRequired(false).setPlaceholder('ハロウィン'),
        ),
    );
};

/** 「ログ検索」のモーダルの送信。管理者が何を探したかもログに残す */
const searchFromModal = async (interaction: ModalSubmitInteraction<'cached'>): Promise<void> => {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  const days = Number(interaction.fields.getStringSelectValues(DAYS_INPUT_ID)[0] ?? 7);
  const filter: LogSearchFilter = {
    type: toSearchType(interaction.fields.getStringSelectValues(TYPE_INPUT_ID)[0]),
    userId: interaction.fields.getSelectedUsers(MEMBER_INPUT_ID)?.first()?.id ?? null,
    days: SEARCH_DAYS.includes(days) ? days : 7,
    keyword: interaction.fields.getTextInputValue(KEYWORD_INPUT_ID).trim() || null,
  };
  const asCsv = interaction.fields.getStringSelectValues(OUTPUT_INPUT_ID)[0] === 'csv';
  await replyWithSearch(interaction, filter, asCsv);
  void sendLog(interaction.guild, 'command', `${interaction.member} がログを検索しました`, interaction.member, {
    title: 'ログ検索',
    fields: [
      { name: '🔎 条件', value: describeFilter(filter), inline: true },
      { name: '📄 出し方', value: asCsv ? 'CSV' : '一覧', inline: true },
    ],
  });
};

/** 「プロフィールを削除」のモーダルの送信 */
const deleteProfileFromModal = async (interaction: ModalSubmitInteraction<'cached'>): Promise<void> => {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  const user = interaction.fields.getSelectedUsers(MEMBER_INPUT_ID)?.first();
  const removeMemberRole = interaction.fields.getStringSelectValues(MEMBER_ROLE_INPUT_ID)[0] === 'remove';
  const reason = interaction.fields.getTextInputValue(REASON_INPUT_ID).trim() || null;
  const stored = user ? await findStoredProfile(interaction.guild.id, user.id) : null;
  if (!user || !stored) {
    await interaction.editReply('そのメンバーのプロフィールは登録されていません。');
    return;
  }

  const postChannel = stored.channelId ? interaction.guild.channels.cache.get(stored.channelId) : undefined;
  const postDeleted =
    postChannel?.isTextBased() && stored.messageId
      ? await postChannel.messages.delete(stored.messageId).then(
          () => true,
          () => false,
        )
      : false;
  await deleteProfile(interaction.guild.id, user.id);

  let roleNote: string | null = null;
  if (removeMemberRole) {
    const member = await interaction.guild.members.fetch(user.id).catch(() => null);
    const role = findMemberRole(interaction.guild);
    if (member && role && member.roles.cache.has(role.id)) {
      const removed = await member.roles.remove(role, reason ?? 'プロフィールの削除').then(
        () => true,
        () => false,
      );
      roleNote = removed ? `「${role.name}」ロールを外しました。` : `※「${role.name}」ロールを外せませんでした。`;
    }
  }

  const notes = [
    postDeleted ? `「${PROFILE_CHANNEL_NAME}」の投稿を削除しました。` : `「${PROFILE_CHANNEL_NAME}」の投稿は見つかりませんでした。`,
    ...(roleNote ? [roleNote] : []),
  ];
  await interaction.editReply({
    content: [`🗑️ ${user} のプロフィール（${stored.profile.name}）を削除しました。`, ...notes].join('\n'),
    allowedMentions: { parse: [] },
  });
  void sendLog(
    interaction.guild,
    'unregister',
    `${interaction.member} が ${user} のプロフィールを削除しました（管理パネル）`,
    interaction.member,
    {
      target: user,
      fields: [
        ...profileLogFields(stored.profile),
        { name: '📝 理由', value: reason ?? '（なし）' },
        { name: '🧹 後片付け', value: notes.join('\n') },
      ],
    },
  );
};

const pendingListEmbed = async (interaction: ButtonInteraction<'cached'>): Promise<EmbedBuilder> => {
  const pending = await listPendingApplications(interaction.guild.id);
  const lines = pending.map((application) => {
    const link = application.review
      ? ` [申請を見る](${messageLink(application.review.channelId, application.review.messageId, interaction.guild.id)})`
      : '';
    return `・${nameById(interaction.guild, application.userId)} ${application.characterName}（${time(application.createdAt, 'R')}）${link}`;
  });
  return listEmbed(`📋 審査中の申請（${pending.length}件）`, lines, '審査中の申請はありません。');
};

const unregisteredListEmbed = async (interaction: ButtonInteraction<'cached'>): Promise<EmbedBuilder> => {
  const [members, profiles, pending] = await Promise.all([
    fetchAllMembers(interaction.guild),
    listStoredProfiles(interaction.guild.id),
    listPendingApplications(interaction.guild.id),
  ]);
  const registered = new Set(profiles.map((profile) => profile.userId));
  const applying = new Set(pending.map((application) => application.userId));
  const unregistered = [...members.values()]
    .filter((member) => !member.user.bot && !registered.has(member.id))
    .sort((a, b) => (a.joinedTimestamp ?? 0) - (b.joinedTimestamp ?? 0));
  const lines = unregistered.map(
    (member) =>
      `・${nameWithUsername(member)}（参加: ${member.joinedAt ? time(member.joinedAt, 'R') : '不明'}）${applying.has(member.id) ? ' 📝 申請中' : ''}`,
  );
  return listEmbed(`👥 未登録のメンバー（${unregistered.length}人）`, lines, '未登録のメンバーはいません。');
};

/** 一覧の埋め込み。多すぎるときは途中まで出して、残りの件数を書く */
const listEmbed = (title: string, lines: string[], empty: string): EmbedBuilder => {
  const rest = lines.length - MAX_LISTED;
  return new EmbedBuilder()
    .setTitle(title)
    .setDescription(
      lines.length === 0 ? empty : [...lines.slice(0, MAX_LISTED), ...(rest > 0 ? [`ほか ${rest}件`] : [])].join('\n'),
    )
    .setColor(0x99aab5);
};

const deleteModal = (): ModalBuilder =>
  new ModalBuilder()
    .setCustomId(DELETE_MODAL_ID)
    .setTitle('プロフィールを削除')
    .addLabelComponents(
      new LabelBuilder()
        .setLabel('メンバー')
        .setDescription('名前で検索して選べます')
        .setUserSelectMenuComponent(
          new UserSelectMenuBuilder().setCustomId(MEMBER_INPUT_ID).setPlaceholder('削除するメンバーを選ぶ').setRequired(true),
        ),
      new LabelBuilder()
        .setLabel(`「${MEMBER_ROLE_NAME}」ロール`)
        .setStringSelectMenuComponent(
          new StringSelectMenuBuilder()
            .setCustomId(MEMBER_ROLE_INPUT_ID)
            .setRequired(true)
            .addOptions(
              { label: '付けたままにする', value: 'keep', default: true },
              { label: '外す', value: 'remove' },
            ),
        ),
      new LabelBuilder()
        .setLabel('理由（任意）')
        .setDescription('ログに残ります')
        .setTextInputComponent(
          new TextInputBuilder().setCustomId(REASON_INPUT_ID).setStyle(TextInputStyle.Paragraph).setMaxLength(300).setRequired(false),
        ),
    );

const logSearchModal = (): ModalBuilder => {
  const select = (id: string, options: { label: string; value: string; default?: boolean }[]) =>
    new StringSelectMenuBuilder().setCustomId(id).setRequired(true).addOptions(options);
  return new ModalBuilder()
    .setCustomId(LOG_SEARCH_MODAL_ID)
    .setTitle('ログ検索')
    .addLabelComponents(
      new LabelBuilder()
        .setLabel('メンバー（任意）')
        .setDescription('この人が実行した・対象になったもの。選ばなければ全員')
        .setUserSelectMenuComponent(new UserSelectMenuBuilder().setCustomId(MEMBER_INPUT_ID).setRequired(false)),
      new LabelBuilder()
        .setLabel('種類')
        .setStringSelectMenuComponent(
          select(TYPE_INPUT_ID, LOG_SEARCH_TYPES.map((type) => ({ label: type.label, value: type.value, default: type.value === 'all' }))),
        ),
      new LabelBuilder()
        .setLabel('期間')
        .setStringSelectMenuComponent(
          select(DAYS_INPUT_ID, SEARCH_DAYS.map((days) => ({ label: days === 1 ? '過去1日' : `過去${days}日`, value: String(days), default: days === 7 }))),
        ),
      new LabelBuilder()
        .setLabel('キーワード（任意）')
        .setDescription('見出し・内容に含まれる言葉')
        .setTextInputComponent(new TextInputBuilder().setCustomId(KEYWORD_INPUT_ID).setStyle(TextInputStyle.Short).setMaxLength(100).setRequired(false)),
      new LabelBuilder()
        .setLabel('出し方')
        .setStringSelectMenuComponent(
          select(OUTPUT_INPUT_ID, [
            { label: `一覧で見る（新しい${LIST_LIMIT}件）`, value: 'list', default: true },
            { label: `CSVファイルで出す（${CSV_LIMIT.toLocaleString()}件まで）`, value: 'csv' },
          ]),
        ),
    );
};

const panelButton = (id: string, label: string, emoji: string, style: ButtonStyle): ButtonBuilder =>
  new ButtonBuilder().setCustomId(id).setLabel(label).setEmoji({ name: emoji }).setStyle(style);
