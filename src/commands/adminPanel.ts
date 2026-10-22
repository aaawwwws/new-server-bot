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
  type ChatInputCommandInteraction,
  type ModalSubmitInteraction,
} from 'discord.js';
import { sendLog } from '../activityLog.js';
import { fetchAllMembers } from '../guildUtils.js';
import { rememberPanel, type PanelPayload } from '../panels.js';
import { profileLogFields } from '../profile.js';
import { ADMIN_ROLE_NAME, ensureAdmin } from '../permissions.js';
import { MEMBER_ROLE_NAME, PROFILE_CHANNEL_NAME, findMemberRole } from '../profilePublish.js';
import { deleteProfile, findStoredProfile, listPendingApplications, listStoredProfiles } from '../profileStore.js';
import { CSV_LIMIT, LIST_LIMIT, LOG_SEARCH_TYPES, describeFilter, toSearchType, type LogSearchFilter } from '../logSearch.js';
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
const MEMBER_INPUT_ID = 'member';
const MEMBER_ROLE_INPUT_ID = 'memberRole';
const REASON_INPUT_ID = 'reason';
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
        `管理者用の操作です。「${ADMIN_ROLE_NAME}」ロールを持つ人だけが使えます。`,
        '',
        '**👤 ユーザーを登録**',
        `メンバーを選んで、本人の登録と同じ手順でプロフィールを入力します。審査なしで「${PROFILE_CHANNEL_NAME}」に投稿され、「${MEMBER_ROLE_NAME}」ロールが付きます。`,
        '**📋 審査中の申請**',
        'まだ許可・拒否していない申請の一覧です。',
        '**👥 未登録のメンバー**',
        '入ったまま、プロフィールを登録していない人の一覧です（参加が古い順）。',
        '**🗑️ プロフィールを削除**',
        `メンバーを選んで、プロフィールと「${PROFILE_CHANNEL_NAME}」の投稿を削除します。`,
        '**🔎 ログ検索**',
        '残しておいた行動ログ・発言・VCの出入りを、人・期間・キーワードで探します（一覧かCSV）。',
      ].join('\n'),
    )
    .setColor(0x99aab5);
  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    panelButton(REGISTER_BUTTON_ID, 'ユーザーを登録', '👤', ButtonStyle.Primary),
    panelButton(PENDING_BUTTON_ID, '審査中の申請', '📋', ButtonStyle.Secondary),
    panelButton(UNREGISTERED_BUTTON_ID, '未登録のメンバー', '👥', ButtonStyle.Secondary),
    panelButton(LOG_SEARCH_BUTTON_ID, 'ログ検索', '🔎', ButtonStyle.Secondary),
    panelButton(DELETE_BUTTON_ID, 'プロフィールを削除', '🗑️', ButtonStyle.Danger),
  );
  return { embeds: [embed], components: [row] };
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
  }
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
  }
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
    return `・<@${application.userId}> ${application.characterName}（${time(application.createdAt, 'R')}）${link}`;
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
      `・${member}（参加: ${member.joinedAt ? time(member.joinedAt, 'R') : '不明'}）${applying.has(member.id) ? ' 📝 申請中' : ''}`,
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
