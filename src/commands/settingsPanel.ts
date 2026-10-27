import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ComponentType,
  EmbedBuilder,
  InteractionContextType,
  MessageFlags,
  ModalBuilder,
  SlashCommandBuilder,
  UserSelectMenuBuilder,
  codeBlock,
  type AttachmentBuilder,
  type ButtonInteraction,
  type ChatInputCommandInteraction,
  type GuildMember,
  type Message,
  type ModalSubmitInteraction,
  type StringSelectMenuInteraction,
  type UserSelectMenuInteraction,
} from 'discord.js';
import { sendLog } from '../activityLog.js';
import { NOTICE_CHANNEL_NAME } from '../callNotice.js';
import { checkCharacterName } from '../characterName.js';
import { findContentRoles, toggleContentRole } from '../contentRoles.js';
import { DATA_CENTERS, type DataCenter } from '../dataCenters.js';
import { ensurePersonalInvite } from '../inviteLinks.js';
import { INVITE_ME_ROLE_NAME, findInviteMeRole, setInviteMe } from '../inviteMeRole.js';
import { loadJoinAnnounce, loadRankingHidden, saveJoinAnnounce, type JoinAnnounceKey, type JoinAnnounceSettings } from '../memberSettings.js';
import { rememberPanel, type PanelPayload } from '../panels.js';
import { buildProfileEmbed, describeJobs, describeTime, describeWorld, type Profile } from '../profile.js';
import {
  COMMENT_INPUT_ID,
  END_HOURS,
  FIRST_NAME_INPUT_ID,
  LAST_NAME_INPUT_ID,
  START_HOURS,
  dataCenterRows,
  hourSelect,
  jobRows,
  nameAndCommentLabels,
  parseHour,
  progressRows,
  contentRows,
  toRow,
  toRows,
  toggleButton,
  vcNoticeButtons,
  worldRows,
  type Row,
} from '../profileInputs.js';
import {
  PROFILE_CHANNEL_NAME,
  findProfileChannel,
  loadCurrentProfile,
  publishProfile,
  refreshPostedProfile,
} from '../profilePublish.js';
import { findProgressRoles, setProgressRole } from '../progressRoles.js';
import { computeRanking, isRankingExempt, summarizeInvites, toRankingKind } from '../rankings.js';
import { levelScreenButtons, rankingId, rankingScreen, screenPayload, setRankingHidden } from '../rankingView.js';
import { VC_ROLE_NAME, findVcRole, setVcNotice } from '../vcRole.js';
import { buildLevelView } from './level.js';

// customId は「settings:<操作>:<値>」の形。
// 選んでいる途中の値（ジョブ・活動時間）はBotに持たず、画面のボタン・セレクトメニューから読むので、再起動しても続きから操作できる
export const CUSTOM_ID_PREFIX = 'settings:';
const NAME_MODAL_ID = `${CUSTOM_ID_PREFIX}name-submit`;
/** ログに載せるひとことの長さ */
const MAX_COMMENT_IN_LOG = 100;

/** 「プロフィール」の中に並べる、変更できる項目 */
const PROFILE_ITEMS = [
  { key: 'name', label: '名前・ひとこと', emoji: '🪪' },
  { key: 'progress', label: '進行度', emoji: '📖' },
  { key: 'world', label: 'ワールド', emoji: '🌍' },
  { key: 'time', label: '活動時間', emoji: '🕘' },
  { key: 'jobs', label: 'ジョブ', emoji: '⚔️' },
  { key: 'content', label: 'コンテンツ', emoji: '🎮' },
] as const;
const MENU_BUTTONS_PER_ROW = 3;
const PROFILE_MENU_ID = `${CUSTOM_ID_PREFIX}menu:profile`;
const VC_MENU_ID = `${CUSTOM_ID_PREFIX}menu:vc`;
const LEVEL_MENU_ID = `${CUSTOM_ID_PREFIX}menu:level`;
const INVITE_MENU_ID = `${CUSTOM_ID_PREFIX}menu:invite`;
const INVITE_ME_MENU_ID = `${CUSTOM_ID_PREFIX}menu:inviteme`;
const LEVEL_USER_SELECT_ID = `${CUSTOM_ID_PREFIX}level-user`;
interface JoinAnnounceItem {
  key: JoinAnnounceKey;
  /** customId の「settings:<action>:on|off」 */
  action: string;
  /** 画面での番号（① は「通知を受け取る」） */
  mark: string;
  title: string;
  description: string;
  logLabel: string;
  on: { label: string; emoji: string };
  off: { label: string; emoji: string };
}
/** 「VC通知」の中の、自分がVCに入ったときにBotがお知らせするかの設定 */
const JOIN_ANNOUNCE_ITEMS = [
  {
    key: 'callStart',
    action: 'callstart',
    mark: '②',
    title: '自分が通話を始めたとき',
    description: `「${NOTICE_CHANNEL_NAME}」チャンネルで @${VC_ROLE_NAME} に知らせます。知らせない場合も、お知らせ自体は通知なしで流れます。`,
    logLabel: '通話を始めたときのお知らせ',
    on: { label: '通話開始を知らせる', emoji: '📣' },
    off: { label: '知らせない', emoji: '🤫' },
  },
  {
    key: 'vcJoin',
    action: 'vcjoin',
    mark: '③',
    title: '自分がVCに入ったとき',
    description: 'そのVCのチャットに、自分のプロフィール（未登録なら入室したこと）を出します。',
    logLabel: 'VCに入ったときのプロフィール表示',
    on: { label: 'プロフィールを出す', emoji: '🪪' },
    off: { label: '出さない', emoji: '🙈' },
  },
] as const satisfies readonly JoinAnnounceItem[];

type ComponentInteraction =
  | ButtonInteraction<'cached'>
  | StringSelectMenuInteraction<'cached'>
  | UserSelectMenuInteraction<'cached'>;
type SaveInteraction = ComponentInteraction | ModalSubmitInteraction<'cached'>;

export const data = new SlashCommandBuilder()
  .setName('settings-panel')
  .setNameLocalizations({ ja: '設定パネル' })
  .setDescription('設定パネル（プロフィールの変更など）をこのチャンネルに設置します（管理者用）')
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
  await rememberPanel(message, 'settings', payload);
  void sendLog(interaction.guild, 'panel', `${interaction.member} が設定パネルを設置しました`, interaction.member, {
    channel,
    links: [{ label: 'パネルへ移動', url: message.url }],
  });
  await interaction.editReply('設定パネルを設置しました。');
};

/** パネルの中身（設置するときと、起動時に作り直すときで共通） */
export const buildPanel = (): PanelPayload => {
  const embed = new EmbedBuilder()
    .setTitle('⚙️ 設定')
    .setDescription(
      [
        '変更したい項目のボタンを押してください。',
        '',
        '**🪪 プロフィール**',
        `${PROFILE_ITEMS.map((item) => item.label).join('・')}を変更できます。`,
        `変更はすぐ「${PROFILE_CHANNEL_NAME}」チャンネルのプロフィールに反映されます（登録済みの人だけ）。`,
        '',
        '**🔔 VC通知**',
        `誰かが通話を始めたときに「${NOTICE_CHANNEL_NAME}」チャンネルでメンションを受け取るかと、`,
        '自分がVCに入ったときにBotがお知らせするかを切り替えられます。',
        '',
        '**📊 レベル**',
        '自分やほかの人のレベル、サーバーのランキング（今日・今週・今月・累計）、自分の順位と歴代記録を見られます。',
        'ランキングに名前を出さない設定もここでできます。',
        '',
        '**📨 招待**',
        'あなた専用の招待リンクを作れます。リンクで入った人がプロフィール登録まで進むと、招待ランキングに数えられます。',
        '',
        '**🙌 いつでも誘って**',
        `「${INVITE_ME_ROLE_NAME}」ロールを自分で付け外しできます。付けるとプロフィールに出て、PT募集でこのロールに声をかけてもらえます。`,
      ].join('\n'),
    )
    .setColor(0x5865f2);
  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId(PROFILE_MENU_ID).setLabel('プロフィール').setEmoji({ name: '🪪' }).setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId(VC_MENU_ID).setLabel('VC通知').setEmoji({ name: '🔔' }).setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId(LEVEL_MENU_ID).setLabel('レベル').setEmoji({ name: '📊' }).setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId(INVITE_MENU_ID).setLabel('招待').setEmoji({ name: '📨' }).setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId(INVITE_ME_MENU_ID).setLabel('いつでも誘って').setEmoji({ name: '🙌' }).setStyle(ButtonStyle.Primary),
  );
  return { embeds: [embed], components: [row] };
};

export const handleComponent = async (interaction: ComponentInteraction): Promise<void> => {
  const [, action, value] = interaction.customId.split(':');
  if (action === 'menu') {
    // VC通知とレベルはプロフィールと関係ないので、未登録の人も使える
    switch (value) {
      case 'vc':
        await show(interaction, vcScreen(interaction.member, await loadJoinAnnounce(interaction.guild.id, interaction.user.id)));
        return;
      case 'level':
        await showAfterDefer(interaction, () => levelScreen(interaction.member, interaction.member));
        return;
      case 'invite':
        await showAfterDefer(interaction, () => inviteScreen(interaction.member));
        return;
      case 'inviteme':
        await show(interaction, inviteMeScreen(interaction.member));
        return;
      default:
        await openProfileMenu(interaction);
        return;
    }
  }
  if (action === 'open') {
    await openItem(interaction, value);
    return;
  }

  // ここから下は、本人にだけ見える変更画面の操作
  await interaction.deferUpdate();
  switch (action) {
    case 'progress':
      await changeProgress(interaction, value);
      return;
    case 'content':
      await changeContent(interaction, value);
      return;
    case 'vc':
      if (value === 'on' || value === 'off') await changeVcNotice(interaction, value === 'on');
      return;
    case 'callstart':
    case 'vcjoin': {
      const item = JOIN_ANNOUNCE_ITEMS.find((i) => i.action === action);
      if (item && (value === 'on' || value === 'off')) await changeJoinAnnounce(interaction, item, value === 'on');
      return;
    }
    case 'level-user': {
      // 選んだ人がもうサーバーにいなければ null
      const userId = interaction.isUserSelectMenu() ? interaction.values[0] : undefined;
      const target = userId ? await interaction.guild.members.fetch(userId).catch(() => null) : null;
      await interaction.editReply(withFiles(await levelScreen(interaction.member, target)));
      return;
    }
    case 'inviteme': {
      const role = findInviteMeRole(interaction.guild);
      if (!role || (value !== 'on' && value !== 'off')) {
        await interaction.editReply(withFiles(inviteMeScreen(interaction.member)));
        return;
      }
      // 付け外しとログは setInviteMe が行う。プロフの投稿にも「いつでも誘って」を出す・消す
      const member = await setInviteMe(interaction.member, role, value === 'on');
      await refreshPostedProfile(member);
      await interaction.editReply(withFiles(inviteMeScreen(member, value === 'on' ? '🙌 付けました。' : '外しました。')));
      return;
    }
    case 'invite-renew':
      await interaction.editReply(withFiles(await inviteScreen(interaction.member, { renew: true })));
      return;
    case 'rank-hide': {
      const hidden = value === 'on';
      await setRankingHidden(interaction.member, hidden);
      const note = hidden ? '🙈 ランキングに出ないようにしました。' : '🙋 ランキングに出るようにしました。';
      await interaction.editReply(withFiles(await levelScreen(interaction.member, interaction.member, note)));
      return;
    }
    case 'ranking':
      // 前の形の画面（ランキングを設定パネルの中で出していた頃）に残っているボタン
      await interaction.editReply(screenPayload(await rankingScreen(interaction.member, toLegacyKind(value), 'all', 0)));
      return;
    case 'dcs':
      await interaction.editReply(dataCenterScreen(null));
      return;
    case 'dc': {
      const dataCenter = DATA_CENTERS.find((dc) => dc.name === value);
      await interaction.editReply(dataCenter ? worldScreen(dataCenter, null) : dataCenterScreen(null));
      return;
    }
    case 'world': {
      const dataCenter = DATA_CENTERS.find((dc) => value !== undefined && dc.worlds.includes(value));
      if (!dataCenter || !value) return;
      await saveChange(interaction, (profile) => {
        profile.dataCenter = dataCenter.name;
        profile.world = value;
      }, (before, after) => changeLine('ワールド', describeWorld(before), describeWorld(after)));
      return;
    }
    case 'start':
    case 'end': {
      // 選んだ方は今回の値、もう一方は画面に表示中の値
      const picked = parseHour(interaction.isStringSelectMenu() ? interaction.values[0] : undefined);
      const start = action === 'start' ? picked : selectedHour(interaction.message, 'start');
      const end = action === 'end' ? picked : selectedHour(interaction.message, 'end');
      await interaction.editReply(timeScreen(start, end));
      return;
    }
    case 'time-save': {
      const start = selectedHour(interaction.message, 'start');
      const end = selectedHour(interaction.message, 'end');
      await saveChange(interaction, (profile) => {
        profile.startHour = start;
        profile.endHour = end;
      }, (before, after) => changeLine('活動時間', describeTime(before), describeTime(after)));
      return;
    }
    case 'job': {
      const jobs = selectedJobs(interaction.message);
      const next = value ? (jobs.includes(value) ? jobs.filter((job) => job !== value) : [...jobs, value]) : jobs;
      await interaction.editReply(jobScreen(next));
      return;
    }
    case 'jobs-save': {
      const jobs = selectedJobs(interaction.message);
      // ジョブは必須（「保存」は押せないようにしてあるが、古い画面から押された場合の保険）
      if (jobs.length === 0) {
        await interaction.editReply(jobScreen(jobs));
        return;
      }
      await saveChange(interaction, (profile) => {
        profile.jobs = jobs;
      }, (before, after) => changeLine('ジョブ', describeJobs(before), describeJobs(after)));
      return;
    }
  }
};

/** 名前・ひとことのモーダルの送信 */
export const handleModalSubmit = async (interaction: ModalSubmitInteraction<'cached'>): Promise<void> => {
  if (interaction.customId !== NAME_MODAL_ID) return;
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  const characterName = checkCharacterName(
    interaction.fields.getTextInputValue(FIRST_NAME_INPUT_ID),
    interaction.fields.getTextInputValue(LAST_NAME_INPUT_ID),
  );
  if (!characterName.ok) {
    const retry = new ButtonBuilder().setCustomId(customId('open', 'name')).setLabel('入力し直す').setStyle(ButtonStyle.Primary);
    await interaction.editReply({
      content: ['キャラクター名を確認してください。', ...characterName.errors.map((error) => `・${error}`)].join('\n'),
      components: [toRow(retry)],
    });
    return;
  }

  const comment = interaction.fields.getTextInputValue(COMMENT_INPUT_ID).trim();
  await saveChange(
    interaction,
    (profile) => {
      profile.name = characterName.name;
      profile.comment = comment;
    },
    (before, after) => [
      ...changeLine('キャラクター名', before.name, after.name),
      ...changeLine('ひとこと', shortComment(before.comment), shortComment(after.comment)),
    ],
  );
};

/** 「プロフィール」ボタン。今のプロフィールと、変更できる項目のボタンを出す */
const openProfileMenu = async (interaction: ComponentInteraction): Promise<void> => {
  const current = await loadOwnProfile(interaction);
  if (!current) {
    await show(interaction, { content: notRegisteredMessage(), components: [] });
    return;
  }

  const buttons = PROFILE_ITEMS.map((item) =>
    new ButtonBuilder()
      .setCustomId(customId('open', item.key))
      .setLabel(item.label)
      .setEmoji({ name: item.emoji })
      .setStyle(ButtonStyle.Secondary),
  );
  await show(interaction, {
    content: '🪪 **プロフィールの設定**\n変更したい項目を選んでください。',
    embeds: [buildProfileEmbed(interaction.member, current)],
    components: toRows(buttons, MENU_BUTTONS_PER_ROW),
  });
};

/** 項目のボタン。登録済みの人だけ、その項目の変更画面を開く */
const openItem = async (interaction: ComponentInteraction, item: string | undefined): Promise<void> => {
  const current = await loadOwnProfile(interaction);
  if (!current) {
    await show(interaction, { content: notRegisteredMessage(), components: [] });
    return;
  }

  switch (item) {
    case 'name': {
      const [firstName = '', lastName = ''] = current.name.split(' ');
      const modal = new ModalBuilder()
        .setCustomId(NAME_MODAL_ID)
        .setTitle('名前・ひとことを変更')
        .addLabelComponents(...nameAndCommentLabels({ firstName, lastName, comment: current.comment }));
      await interaction.showModal(modal);
      return;
    }
    case 'progress':
      await show(
        interaction,
        findProgressRoles(interaction.guild).length > 0
          ? progressScreen(interaction.member)
          : { content: 'このサーバーには進行度ロールがありません。', components: [toRow(backButton())] },
      );
      return;
    case 'world':
      await show(interaction, dataCenterScreen(current.dataCenter));
      return;
    case 'time':
      await show(interaction, timeScreen(current.startHour, current.endHour));
      return;
    case 'jobs':
      await show(interaction, jobScreen(current.jobs));
      return;
    case 'content':
      await show(interaction, contentScreen(interaction.member));
      return;
  }
};

/**
 * 画面を出す。本人にだけ見える画面からの操作ならその画面を切り替え（画面が増えないように）、
 * パネルからの操作なら、新しく本人にだけ見える画面を出す（パネル自体は書き換えない）
 */
const show = async (interaction: ComponentInteraction, screen: Screen): Promise<void> => {
  const payload = { content: screen.content, embeds: screen.embeds ?? [], components: screen.components, files: screen.files ?? [] };
  if (interaction.message.flags.has(MessageFlags.Ephemeral)) {
    // 前の画面に付いていた画像（レベルのカード）は外す
    await interaction.update({ ...payload, attachments: [] });
  } else {
    await interaction.reply({ ...payload, flags: MessageFlags.Ephemeral });
  }
};

/**
 * DBを読むなど、作るのに時間がかかる画面。先に応答してから出す（Discordは3秒以内に応答しないと失敗になる）。
 * 出し方は show と同じ（本人にだけ見える画面からなら切り替え、パネルからなら新しく出す）
 */
const showAfterDefer = async (interaction: ComponentInteraction, build: () => Promise<Screen>): Promise<void> => {
  if (interaction.message.flags.has(MessageFlags.Ephemeral)) {
    await interaction.deferUpdate();
  } else {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  }
  await interaction.editReply(withFiles(await build()));
};

/** 画面の中身。前の画面に付いていた画像は外し、この画面の画像（あれば）を付ける */
const withFiles = (screen: Screen) => ({
  content: screen.content,
  embeds: screen.embeds ?? [],
  components: screen.components,
  files: screen.files ?? [],
  attachments: [],
});

/** 変更後や、変更できないときに出す「一覧に戻る」ボタン */
const backButton = (): ButtonBuilder =>
  new ButtonBuilder().setCustomId(PROFILE_MENU_ID).setLabel('ほかの項目も変更する').setEmoji({ name: '🪪' }).setStyle(ButtonStyle.Secondary);

/** 進行度はロールなので、押したらすぐ付け替えて、プロフの表示も更新する */
const changeProgress = async (interaction: ComponentInteraction, roleId: string | undefined): Promise<void> => {
  const progressRoles = findProgressRoles(interaction.guild);
  const role = progressRoles.find((r) => r.id === roleId);
  if (!role) return;

  // ロールの付け替えとログは setProgressRole が行う
  const updated = await setProgressRole(interaction.member, role, progressRoles.map((r) => r.id));
  await refreshPostedProfile(updated);
  await interaction.editReply({ content: `✅ 進行度を「${role.name}」にしました。`, components: [toRow(backButton())] });
};

/** コンテンツロールも、押したらすぐ付け外しする。続けて選べるよう、同じ画面のまま */
const changeContent = async (interaction: ComponentInteraction, roleId: string | undefined): Promise<void> => {
  const role = findContentRoles(interaction.guild).find((r) => r.id === roleId);
  if (!role) return;

  // 付け外しとログは toggleContentRole が行う
  const { member } = await toggleContentRole(interaction.member, role);
  await refreshPostedProfile(member);
  await interaction.editReply(contentScreen(member));
};

/** VC通知も、押したらすぐ「VC」ロールを付け外しする */
const changeVcNotice = async (interaction: ComponentInteraction, on: boolean): Promise<void> => {
  const settings = await loadJoinAnnounce(interaction.guild.id, interaction.user.id);
  const role = findVcRole(interaction.guild);
  if (!role) {
    await interaction.editReply(vcScreen(interaction.member, settings));
    return;
  }

  // 付け外しとログは setVcNotice が行う
  const member = await setVcNotice(interaction.member, role, on);
  await interaction.editReply(vcScreen(member, settings, `✅ VC通知を${on ? 'オン' : 'オフ'}にしました。`));
};

/** 自分が入ったときのお知らせ。DBに保存して、変えたときはログに残す */
const changeJoinAnnounce = async (
  interaction: ComponentInteraction,
  item: (typeof JOIN_ANNOUNCE_ITEMS)[number],
  on: boolean,
): Promise<void> => {
  const before = await loadJoinAnnounce(interaction.guild.id, interaction.user.id);
  if (before[item.key] !== on) {
    await saveJoinAnnounce(interaction.guild.id, interaction.user.id, item.key, on);
    void sendLog(
      interaction.guild,
      'vcNotice',
      `${interaction.member} が「${item.logLabel}」を${on ? 'オン' : 'オフ'}にしました`,
      interaction.member,
      { fields: [{ name: `⚙️ ${item.title}`, value: `${(on ? item.on : item.off).emoji} ${(on ? item.on : item.off).label}`, inline: true }] },
    );
  }
  const settings = { ...before, [item.key]: on };
  await interaction.editReply(vcScreen(interaction.member, settings, `✅「${item.logLabel}」を${on ? 'オン' : 'オフ'}にしました。`));
};

interface Change {
  label: string;
  before: string;
  after: string;
}

/**
 * 変更を保存して、プロフの投稿とDBを更新する。ログには変更前と変更後を残す。
 * describe は変わった項目（「ジョブ: ナイト → ナイト・白魔道士」など）。何も変わっていなければ空にする
 */
const saveChange = async (
  interaction: SaveInteraction,
  change: (profile: Profile) => void,
  describe: (before: Profile, after: Profile) => Change[],
): Promise<void> => {
  const channel = findProfileChannel(interaction.guild);
  const current = await loadOwnProfile(interaction);
  if (!channel || !current) {
    await interaction.editReply({ content: notRegisteredMessage(), components: [] });
    return;
  }

  const next: Profile = { ...current, jobs: [...current.jobs] };
  change(next);
  const changes = describe(current, next);
  if (changes.length === 0) {
    await interaction.editReply({ content: '変更はありませんでした。', components: [toRow(backButton())] });
    return;
  }

  // 登録済みの人の変更なので、管理者が外した正規メンバーロールを付け直さない
  const result = await publishProfile(channel, interaction.member, next, { grantMemberRole: false });
  await interaction.editReply({
    content: ['✅ プロフィールを変更しました。', ...changes.map(formatChange), `[プロフィールを見る](${result.message.url})`].join('\n'),
    components: [toRow(backButton())],
  });
  void sendLog(
    interaction.guild,
    'settings',
    `${interaction.member} がプロフィールを変更しました（${changes.map((c) => c.label).join('・')}）`,
    interaction.member,
    {
      fields: changes.map((c) => ({ name: `✏️ ${c.label}`, value: `変更前: ${c.before}\n変更後: ${c.after}` })),
      links: [{ label: 'プロフィールを見る', url: result.message.url }],
    },
  );
};

const loadOwnProfile = async (interaction: SaveInteraction): Promise<Profile | null> => {
  const channel = findProfileChannel(interaction.guild);
  return channel ? loadCurrentProfile(channel, interaction.user.id) : null;
};

const notRegisteredMessage = (): string =>
  'まだプロフィールが登録されていません。先にプロフィールパネルから申請してください。';

// ---- 変更画面（本人にだけ見えるメッセージ）

interface Screen {
  content: string;
  embeds?: EmbedBuilder[];
  components: Row[];
  /** レベルの画像カード */
  files?: AttachmentBuilder[];
}

const progressScreen = (member: GuildMember): Screen => ({
  content: '📖 今進めている拡張を選んでください。押すとすぐ変わります。',
  components: progressRows(member, (roleId) => customId('progress', roleId)),
});

/** 付いているコンテンツロールは青く表示する */
const contentScreen = (member: GuildMember): Screen => {
  const roles = findContentRoles(member.guild);
  if (roles.length === 0) {
    return {
      content: 'コンテンツロールがまだありません（管理者がコンテンツパネルを設置すると作られます）。',
      components: [toRow(backButton())],
    };
  }
  return {
    content: '🎮 よく遊ぶコンテンツを選んでください。押すたびに付け外しします（青が付いているもの・いくつでも）。',
    components: [...contentRows(member, (roleId) => customId('content', roleId)), toRow(backButton())],
  };
};

/**
 * VC通知の3つの設定を並べ、今の設定を青く表示する。note は変更したときに一番上に出す一言。
 * 受け取るかは「VC」ロール、自分が入ったときのお知らせはDBの設定
 */
const vcScreen = (member: GuildMember, settings: JoinAnnounceSettings, note?: string): Screen => {
  const role = findVcRole(member.guild);
  const receiving = role ? member.roles.cache.has(role.id) : false;
  return {
    content: [
      ...(note ? [note, ''] : []),
      '🔔 **VC通知の設定**（青いボタンが今の設定です）',
      '',
      '**① 通知を受け取る**',
      role
        ? `誰かが通話を始めたとき、「${NOTICE_CHANNEL_NAME}」チャンネルでメンションが届きます（「${VC_ROLE_NAME}」ロールが付きます）。`
        : `「${VC_ROLE_NAME}」ロールがないため、今は使えません（Botの再起動時に作られます）。`,
      ...JOIN_ANNOUNCE_ITEMS.flatMap((item) => ['', `**${item.mark} ${item.title}**`, item.description]),
    ].join('\n'),
    components: [
      ...(role ? [toRow(...vcNoticeButtons(receiving, (choice) => customId('vc', choice)))] : []),
      ...JOIN_ANNOUNCE_ITEMS.map((item) =>
        toRow(
          toggleButton(customId(item.action, 'on'), item.on.label, settings[item.key]).setEmoji({ name: item.on.emoji }),
          toggleButton(customId(item.action, 'off'), item.off.label, !settings[item.key]).setEmoji({ name: item.off.emoji }),
        ),
      ),
    ],
  };
};

/**
 * レベルの画面。下のメニューでほかの人を選ぶと、その人のレベルに切り替わる。target が null ならサーバーにいない人。
 * 自分の画面には、ランキングに名前を出すかの切り替えも出す
 */
const levelScreen = async (viewer: GuildMember, target: GuildMember | null, note?: string): Promise<Screen> => {
  const own = target?.id === viewer.id;
  const hidden = own && (await loadRankingHidden(viewer.guild.id, viewer.id));
  const components = [
    toRow(new UserSelectMenuBuilder().setCustomId(LEVEL_USER_SELECT_ID).setPlaceholder('ほかの人のレベルを見る')),
    toRow(
      ...levelScreenButtons(),
      own
        ? new ButtonBuilder()
            .setCustomId(customId('rank-hide', hidden ? 'off' : 'on'))
            .setLabel(hidden ? 'ランキングに出す' : 'ランキングに出さない')
            .setEmoji({ name: hidden ? '🙋' : '🙈' })
            .setStyle(ButtonStyle.Secondary)
        : myLevelButton(),
    ),
  ];
  if (!target || target.user.bot) {
    return { content: target ? 'Botにはレベルがありません。' : 'そのメンバーはサーバーにいません。', components };
  }
  const view = await buildLevelView(target);
  return {
    content: [...(note ? [note] : []), own ? '📊 **あなたのレベル**' : `📊 **${target.displayName} さんのレベル**`].join('\n'),
    embeds: view.embeds,
    files: view.files,
    components,
  };
};

/** 「いつでも誘って下さい」ロールの付け外しの画面（今の状態を青く表示する） */
const inviteMeScreen = (member: GuildMember, note?: string): Screen => {
  const role = findInviteMeRole(member.guild);
  if (!role) {
    return { content: `「${INVITE_ME_ROLE_NAME}」ロールがないため、今は使えません（Botの再起動時に作られます）。`, components: [] };
  }
  const on = member.roles.cache.has(role.id);
  return {
    content: [
      ...(note ? [note, ''] : []),
      `🙌 **「${INVITE_ME_ROLE_NAME}」ロール**（青いボタンが今の設定です）`,
      '',
      '付けると、プロフィールに「いつでも誘ってください！」と出ます。',
      'PT募集を作る人が、メンション先にこのロールを選んで声をかけられます。',
    ].join('\n'),
    components: [
      toRow(
        toggleButton(customId('inviteme', 'on'), '付ける', on).setEmoji({ name: '🙌' }),
        toggleButton(customId('inviteme', 'off'), '付けない', !on),
      ),
    ],
  };
};

/** 専用の招待リンクの画面。リンクと、連れてきた人数・招待ランキングの順位。renew ならリンクを作り直す */
const inviteScreen = async (member: GuildMember, { renew = false } = {}): Promise<Screen> => {
  const invite = await ensurePersonalInvite(member, { renew });
  if (typeof invite === 'string') return { content: `⚠ ${invite}`, components: [] };
  const [summary, ranking, hidden] = await Promise.all([
    summarizeInvites(member.guild, member.id),
    computeRanking(member.guild, 'invites', 'all', new Date(), { changes: false, alsoInclude: member.id }),
    loadRankingHidden(member.guild.id, member.id),
  ]);
  const index = ranking.entries.findIndex((entry) => entry.member.id === member.id);
  const rank = isRankingExempt(member)
    ? '対象外（管理者）'
    : hidden
      ? '非表示（ランキングに出ない設定）'
      : index >= 0
        ? `${index + 1}位`
        : 'まだなし';
  return {
    content: [
      ...(renew ? ['🔄 リンクを作り直しました（前のリンクはもう使えません）。', ''] : []),
      '📨 **あなた専用の招待リンク**',
      invite.url,
      '',
      'このリンクで入った人がプロフィール登録まで進むと、あなたの招待として招待ランキングに数えられます。',
      `・招待して定着した人: **${summary.counted}人**（リンクで入った人: ${summary.total}人）`,
      `・招待ランキング（累計）: ${rank}`,
      '',
      '紹介するときの例（長押しでコピーできます）:',
      codeBlock(`FF14のコミュニティ「${member.guild.name}」に遊びに来ませんか？ ${invite.url}`),
      '-# 期限・回数の制限はありません。リンクが広まりすぎたときは「作り直す」で前のリンクを止められます（前のリンクで入った人も、あなたの招待のまま）。',
    ].join('\n'),
    components: [
      toRow(
        new ButtonBuilder().setCustomId(rankingId('invites', 'all', 0, 'o')).setLabel('招待ランキング').setEmoji({ name: '🏆' }).setStyle(ButtonStyle.Primary),
        new ButtonBuilder().setCustomId(customId('invite-renew')).setLabel('リンクを作り直す').setEmoji({ name: '🔄' }).setStyle(ButtonStyle.Secondary),
      ),
    ],
  };
};

/** 前の形のランキングの種類（messageCount / voiceMinutes） */
const toLegacyKind = (value: string | undefined) =>
  value === 'messageCount' ? 'messages' : value === 'voiceMinutes' ? 'voice' : toRankingKind(value);

const myLevelButton = (): ButtonBuilder =>
  new ButtonBuilder().setCustomId(LEVEL_MENU_ID).setLabel('自分のレベル').setEmoji({ name: '📊' }).setStyle(ButtonStyle.Secondary);

const dataCenterScreen = (selected: string | null): Screen => ({
  content: '🌍 データセンターを選んでください。',
  components: dataCenterRows(selected, (dc) => customId('dc', dc)),
});

const worldScreen = (dataCenter: DataCenter, selected: string | null): Screen => {
  const back = new ButtonBuilder().setCustomId(customId('dcs')).setLabel('データセンターを選び直す').setStyle(ButtonStyle.Secondary);
  return {
    content: `🌍 ${dataCenter.name} のワールドを選んでください。押すとすぐ変わります。`,
    components: [...worldRows(dataCenter, selected, (world) => customId('world', world)), toRow(back)],
  };
};

const timeScreen = (start: number | null, end: number | null): Screen => ({
  content: '🕘 よく遊ぶ時間帯を選んで、「保存」を押してください。',
  components: [
    toRow(hourSelect(customId('start'), '開始時刻', START_HOURS, start)),
    toRow(hourSelect(customId('end'), '終了時刻', END_HOURS, end)),
    toRow(saveButton('time-save')),
  ],
});

const jobScreen = (selected: string[]): Screen => {
  const rows = jobRows(selected, (jobKey) => customId('job', jobKey));
  // ジョブは必須なので、1つも選んでいない間は保存できない
  rows.at(-1)?.addComponents(saveButton('jobs-save').setDisabled(selected.length === 0));
  return {
    content: '⚔️ 使用するジョブを選んで、「保存」を押してください（**1つ以上必須**・もう一度押すと解除）。',
    components: rows,
  };
};

const saveButton = (action: string): ButtonBuilder =>
  new ButtonBuilder().setCustomId(customId(action)).setLabel('保存').setEmoji({ name: '💾' }).setStyle(ButtonStyle.Secondary);

// ---- 画面に表示中の値を読む

/** ✅ が付いているジョブのボタン */
const selectedJobs = (message: Message): string[] =>
  screenComponents(message).flatMap((component) =>
    component.type === ComponentType.Button && component.customId?.startsWith(customId('job', '')) && component.emoji
      ? [component.customId.slice(customId('job', '').length)]
      : [],
  );

/** 活動時間のセレクトメニューで選ばれている時刻 */
const selectedHour = (message: Message, action: 'start' | 'end'): number | null => {
  const select = screenComponents(message).find(
    (component) => component.type === ComponentType.StringSelect && component.customId === customId(action),
  );
  const value = select?.type === ComponentType.StringSelect ? select.options.find((option) => option.default)?.value : undefined;
  return parseHour(value);
};

const screenComponents = (message: Message) =>
  message.components.flatMap((row) => (row.type === ComponentType.ActionRow ? row.components : []));

// ---- 小物

/** 変わった項目。変わっていなければ空 */
const changeLine = (label: string, before: string, after: string): Change[] =>
  before === after ? [] : [{ label, before, after }];

const formatChange = (change: Change): string => `${change.label}: ${change.before} → ${change.after}`;

const shortComment = (comment: string): string => {
  if (!comment) return '（なし）';
  const oneLine = comment.replace(/\n/g, ' ');
  return oneLine.length > MAX_COMMENT_IN_LOG ? `「${oneLine.slice(0, MAX_COMMENT_IN_LOG)}…」` : `「${oneLine}」`;
};

const customId = (action: string, value?: string): string =>
  value === undefined ? `${CUSTOM_ID_PREFIX}${action}` : `${CUSTOM_ID_PREFIX}${action}:${value}`;
