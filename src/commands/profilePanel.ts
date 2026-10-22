import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  InteractionContextType,
  LabelBuilder,
  MessageFlags,
  ModalBuilder,
  SlashCommandBuilder,
  UserSelectMenuBuilder,
  type ButtonInteraction,
  type ChatInputCommandInteraction,
  type Guild,
  type GuildMember,
  type ModalSubmitInteraction,
  type StringSelectMenuInteraction,
} from 'discord.js';
import { NOTICE_CHANNEL_NAME } from '../callNotice.js';
import { checkCharacterName } from '../characterName.js';
import { DATA_CENTERS } from '../dataCenters.js';
import { sendLog } from '../activityLog.js';
import { canBotPost } from '../guildUtils.js';
import { createLock } from '../locks.js';
import { rememberPanel, type PanelPayload } from '../panels.js';
import { adminRoleWarnings, ensureAdmin } from '../permissions.js';
import { buildProfileEmbed, parseProfile, profileLogFields, type Profile } from '../profile.js';
import {
  COMMENT_INPUT_ID,
  END_HOURS,
  contentRows,
  FIRST_NAME_INPUT_ID,
  LAST_NAME_INPUT_ID,
  START_HOURS,
  dataCenterRows,
  hourSelect,
  jobRows,
  nameAndCommentLabels,
  parseHour,
  progressRows,
  toRow,
  vcNoticeButtons,
  worldRows,
  type NameAndCommentInput,
  type Row,
} from '../profileInputs.js';
import {
  MEMBER_ROLE_NAME,
  PROFILE_CHANNEL_NAME,
  REVIEW_CHANNEL_NAME,
  findMemberRole,
  findProfileChannel,
  findReviewChannel,
  loadCurrentProfile,
  publishProfile,
  type MemberRoleResult,
} from '../profilePublish.js';
import { submitApplication } from '../profileReview.js';
import { findContentRoles, toggleContentRole } from '../contentRoles.js';
import { findProgressRoles, setProgressRole } from '../progressRoles.js';
import { VC_ROLE_NAME, findVcRole, setVcNotice } from '../vcRole.js';

// customId は「profile:<操作>:<値>」の形。
// 管理者が代わりに登録している画面では「profile:<操作>:<値>:<登録するメンバーのID>」にして、
// Botを再起動しても誰のプロフィールか取り違えないようにする
export const CUSTOM_ID_PREFIX = 'profile:';
const OPEN_BUTTON_ID = `${CUSTOM_ID_PREFIX}open`;
const RETRY_BUTTON_ID = `${CUSTOM_ID_PREFIX}retry`;
const MODAL_ID = `${CUSTOM_ID_PREFIX}submit`;
const ADMIN_RETRY_BUTTON_ID = `${CUSTOM_ID_PREFIX}admin-retry`;
const ADMIN_MODAL_ID = `${CUSTOM_ID_PREFIX}admin-submit`;
const MEMBER_INPUT_ID = 'member';
/** 入力の手順。進行度・コンテンツ・「VC」のロールがないサーバーでは、その手順を飛ばす */
const STEPS = ['progress', 'dataCenter', 'world', 'time', 'job', 'content', 'vc'] as const;
type StepName = (typeof STEPS)[number];

type ComponentInteraction = ButtonInteraction<'cached'> | StringSelectMenuInteraction<'cached'>;
interface WizardStep {
  content: string;
  components: Row[];
}
interface WizardContext {
  /** プロフィールを登録するメンバー（本人の登録なら押した人、管理者の登録なら選ばれた人） */
  target: GuildMember;
  /** 管理者が代わりに登録しているか。最後が「申請する」ではなく、審査なしの「登録する」になる */
  byAdmin: boolean;
}
interface ModalInput extends NameAndCommentInput {
  /** 管理者の登録で選ばれたメンバー */
  targetId?: string;
}

// 入力途中のプロフィール（「操作した人:登録するメンバー」ごと）。
// ボタンを連打しても古い状態で上書きしないよう、最新の状態をここに持つ（再起動で消えても、入力画面のプレビューから復元する）
const drafts = new Map<string, Profile>();
/** 同じ入力画面の操作を1つずつ順番に処理する */
const withLock = createLock();
// 入力内容がルールに合わなかったときの入力。「入力し直す」でモーダルに戻す
const rejectedInputs = new Map<string, ModalInput>();
const ADMIN_COMMENT_NOTE = '空欄なら、登録済みの人は今のひとことのまま';

export const data = new SlashCommandBuilder()
  .setName('profile-panel')
  .setNameLocalizations({ ja: 'プロフィールパネル' })
  .setDescription('プロフィール作成ボタンをこのチャンネルに設置します（管理者用）')
  .setContexts(InteractionContextType.Guild);

export const execute = async (interaction: ChatInputCommandInteraction<'cached'>): Promise<void> => {
  const channel = interaction.channel;
  if (!channel?.isSendable()) {
    await interaction.reply({ content: 'このチャンネルにはパネルを設置できません。', flags: MessageFlags.Ephemeral });
    return;
  }

  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  // パネルの設置で通知が飛ばないよう、サイレントメッセージで送る。場所を覚えておき、起動時に最新の内容へ作り直す
  const payload = buildPanel(interaction.guild);
  const message = await channel.send({ ...payload, flags: MessageFlags.SuppressNotifications });
  await rememberPanel(message, 'profile', payload);
  void sendLog(interaction.guild, 'panel', `${interaction.member} がプロフィールパネルを設置しました`, interaction.member, {
    channel,
    links: [{ label: 'パネルへ移動', url: message.url }],
  });

  await interaction.editReply(['プロフィールパネルを設置しました。', ...setupWarnings(interaction.guild)].join('\n'));
};

/** パネルの中身。登録する内容の一覧は、サーバーにあるロール（進行度・コンテンツ）に合わせる */
export const buildPanel = (guild: Guild): PanelPayload => {
  const profileChannel = findProfileChannel(guild);
  const items = [
    'キャラクター名・ひとこと',
    ...(findProgressRoles(guild).length > 0 ? ['進行度'] : []),
    'ワールド',
    '活動時間',
    '使用ジョブ',
    ...(findContentRoles(guild).length > 0 ? ['よく遊ぶコンテンツ（任意）'] : []),
    ...(findVcRole(guild) ? ['VC通知を受け取るか'] : []),
  ];
  const embed = new EmbedBuilder()
    .setTitle('🪪 プロフィール登録')
    .setDescription(
      [
        '下のボタンから、あなたのプロフィールを登録できます。',
        '',
        '**登録する内容**',
        ...items.map((item, i) => `${i + 1}. ${item}`),
        '',
        '入力が終わったら「申請する」を押してください。管理者が確認して許可すると、',
        `${profileChannel ?? `「${PROFILE_CHANNEL_NAME}」`} に投稿され「${MEMBER_ROLE_NAME}」ロールが付きます。結果は DM でお知らせします。`,
        '登録済みの人がもう一度押すと、内容を変更して申請し直せます。',
      ].join('\n'),
    )
    .setColor(0x5865f2);
  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(OPEN_BUTTON_ID)
      .setLabel('プロフィールを作成')
      .setEmoji({ name: '📝' })
      .setStyle(ButtonStyle.Success),
  );
  return { embeds: [embed], components: [row] };
};

/** 管理パネルの「ユーザーを登録」。メンバーを選ぶ欄があるほかは、本人の登録と同じ入力画面 */
export const openAdminRegisterModal = async (interaction: ComponentInteraction): Promise<void> => {
  if (!(await ensureAdmin(interaction))) return;
  if (!findProfileChannel(interaction.guild)) {
    await interaction.reply({
      content: `「${PROFILE_CHANNEL_NAME}」チャンネルが見つかりません。作成してから、もう一度押してください。`,
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  // 「入力し直す」のときは、ルールに合わなかった入力（選んだメンバーも）を戻す
  const input =
    interaction.customId === ADMIN_RETRY_BUTTON_ID ? rejectedInputs.get(rejectKey(interaction.user.id, true)) : undefined;
  const memberSelect = new UserSelectMenuBuilder()
    .setCustomId(MEMBER_INPUT_ID)
    .setPlaceholder('登録するメンバーを選ぶ')
    .setRequired(true);
  if (input?.targetId) memberSelect.setDefaultUsers(input.targetId);

  const modal = new ModalBuilder()
    .setCustomId(ADMIN_MODAL_ID)
    .setTitle('ユーザーを登録')
    .addLabelComponents(
      new LabelBuilder()
        .setLabel('メンバー')
        .setDescription('名前で検索して選べます（IDの入力は不要）')
        .setUserSelectMenuComponent(memberSelect),
      ...nameAndCommentLabels(input ?? { firstName: '', lastName: '', comment: '' }, ADMIN_COMMENT_NOTE),
    );
  await interaction.showModal(modal);
};

export const handleComponent = async (interaction: ComponentInteraction): Promise<void> => {
  if (interaction.customId === OPEN_BUTTON_ID || interaction.customId === RETRY_BUTTON_ID) {
    await openModal(interaction);
    return;
  }
  if (interaction.customId === ADMIN_RETRY_BUTTON_ID) {
    await openAdminRegisterModal(interaction);
    return;
  }

  const [, action, value, targetId] = interaction.customId.split(':');
  // 管理者が代わりに登録している画面は、管理者しか操作できない
  if (targetId && !(await ensureAdmin(interaction))) return;
  await interaction.deferUpdate();

  const target = targetId ? await interaction.guild.members.fetch(targetId).catch(() => null) : interaction.member;
  if (!target) {
    await interaction.editReply({ content: '登録しようとしているメンバーが、もうサーバーにいません。', embeds: [], components: [] });
    return;
  }
  const ctx: WizardContext = { target, byAdmin: Boolean(targetId) };
  const key = draftKey(interaction.user.id, target.id);

  await withLock(key, async () => {
    const profile = drafts.get(key) ?? parseProfile(interaction.message.embeds[0]);
    let step: WizardStep;

    switch (action) {
      case 'progress': {
        const progressRoles = findProgressRoles(interaction.guild);
        const role = progressRoles.find((r) => r.id === value);
        if (!role) {
          step = progressStep(ctx);
          break;
        }
        // 変更後のロールでプレビューを作る
        ctx.target = await setProgressRole(ctx.target, role, progressRoles.map((r) => r.id), interaction.member);
        step = dataCenterStep(ctx, profile);
        break;
      }
      case 'dcs':
        step = dataCenterStep(ctx, profile);
        break;
      case 'dc':
        step = worldStep(ctx, profile, value);
        break;
      case 'world': {
        const dataCenter = DATA_CENTERS.find((dc) => value !== undefined && dc.worlds.includes(value));
        if (dataCenter && value) {
          profile.dataCenter = dataCenter.name;
          profile.world = value;
        }
        step = timeStep(ctx, profile);
        break;
      }
      case 'start':
      case 'end': {
        const hour = parseHour(interaction.isStringSelectMenu() ? interaction.values[0] : undefined);
        if (action === 'start') profile.startHour = hour;
        else profile.endHour = hour;
        step = timeStep(ctx, profile);
        break;
      }
      case 'time-next':
        step = jobStep(ctx, profile);
        break;
      case 'job':
        if (value) {
          profile.jobs = profile.jobs.includes(value)
            ? profile.jobs.filter((job) => job !== value)
            : [...profile.jobs, value];
        }
        step = jobStep(ctx, profile);
        break;
      case 'job-next':
        // ジョブは必須なので、未選択ならジョブ選択のまま（古い入力画面から押された場合の保険）
        step = profile.jobs.length > 0 ? stepAfter(ctx, 'job', profile) : jobStep(ctx, profile);
        break;
      case 'content': {
        // 進行度と同じく、押したらすぐロールを付け外しする。変更後のロールでプレビューを作る
        const role = findContentRoles(interaction.guild).find((r) => r.id === value);
        if (role) ctx.target = (await toggleContentRole(ctx.target, role, interaction.member)).member;
        step = contentStep(ctx);
        break;
      }
      case 'content-next':
        step = stepAfter(ctx, 'content', profile);
        break;
      case 'vc': {
        // これも押したらすぐ「VC」ロールを付け外しする。ロールが消されていたら、VC通知の手順を飛ばす
        const role = findVcRole(interaction.guild);
        if (!role || (value !== 'on' && value !== 'off')) {
          step = stepAfter(ctx, 'job', profile);
          break;
        }
        ctx.target = await setVcNotice(ctx.target, role, value === 'on', interaction.member);
        step = vcStep(ctx, value === 'on');
        break;
      }
      // post は「登録する」だった頃の入力画面から押された場合
      case 'apply':
      case 'post':
        // ジョブは必須なので、未選択ならジョブ選択に戻す（古い入力画面から押された場合の保険）
        if (profile.jobs.length === 0) {
          step = jobStep(ctx, profile);
          break;
        }
        if (ctx.byAdmin) {
          await register(interaction, ctx.target, profile);
        } else {
          await apply(interaction, ctx.target, profile);
        }
        return;
      default:
        return;
    }

    drafts.set(key, profile);
    await interaction.editReply({
      content: withHeader(ctx, step.content),
      components: step.components,
      embeds: [buildProfileEmbed(ctx.target, profile)],
    });
  });
};

export const handleModalSubmit = async (interaction: ModalSubmitInteraction<'cached'>): Promise<void> => {
  const byAdmin = interaction.customId === ADMIN_MODAL_ID;
  if (byAdmin && !(await ensureAdmin(interaction))) return;
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  const target = byAdmin ? (interaction.fields.getSelectedMembers(MEMBER_INPUT_ID)?.first() ?? null) : interaction.member;
  const input: ModalInput = {
    firstName: interaction.fields.getTextInputValue(FIRST_NAME_INPUT_ID),
    lastName: interaction.fields.getTextInputValue(LAST_NAME_INPUT_ID),
    comment: interaction.fields.getTextInputValue(COMMENT_INPUT_ID).trim(),
    targetId: target?.id,
  };
  // 文字数はモーダル側で制限できるが、使える文字と合計文字数はここで確認する
  const characterName = checkCharacterName(input.firstName, input.lastName);
  const problems = [
    ...(target ? [] : ['メンバーを選んでください（サーバーにいるメンバーだけ登録できます）。']),
    ...(target?.user.bot ? ['Botは登録できません。'] : []),
    ...(characterName.ok ? [] : characterName.errors),
  ];
  if (!target || !characterName.ok || problems.length > 0) {
    rejectedInputs.set(rejectKey(interaction.user.id, byAdmin), input);
    const retry = new ButtonBuilder()
      .setCustomId(byAdmin ? ADMIN_RETRY_BUTTON_ID : RETRY_BUTTON_ID)
      .setLabel('入力し直す')
      .setStyle(ButtonStyle.Primary);
    await interaction.editReply({
      content: [byAdmin ? '入力内容を確認してください。' : 'キャラクター名を確認してください。', ...problems.map((p) => `・${p}`)].join('\n'),
      components: [toRow(retry)],
    });
    return;
  }
  rejectedInputs.delete(rejectKey(interaction.user.id, byAdmin));

  const channel = findProfileChannel(interaction.guild);
  // 一度抜けて戻ってきた人は、前のプロフィールの内容から始める
  const current = channel ? await loadCurrentProfile(channel, target.id, { includeLeft: true }) : null;
  // ワールド・活動時間・ジョブは登録済みの内容を引き継ぐ
  const profile: Profile = {
    ...(current ?? parseProfile(undefined)),
    name: characterName.name,
    // 管理者の登録は今の内容が入っていない状態から入力するので、空欄なら今のひとことを残す
    comment: input.comment || (byAdmin ? (current?.comment ?? '') : ''),
  };
  const ctx: WizardContext = { target, byAdmin };
  drafts.set(draftKey(interaction.user.id, target.id), profile);

  const step = firstStep(ctx, profile);
  const intro = byAdmin
    ? `最後まで進んで「登録する」を押すと、審査なしで「${PROFILE_CHANNEL_NAME}」チャンネルに投稿されます。`
    : `最後まで進んで申請すると、管理者が確認したあと、下のプレビューが「${PROFILE_CHANNEL_NAME}」チャンネルに投稿されます。`;
  await interaction.editReply({
    content: withHeader(ctx, `${intro}\n${step.content}`),
    embeds: [buildProfileEmbed(target, profile)],
    components: step.components,
  });
};

/** パネル設置時に、管理者へ知らせておくこと（チャンネルやロールがない・Botが使えない） */
const setupWarnings = (guild: Guild): string[] => {
  const warnings: string[] = [];

  const profileChannel = findProfileChannel(guild);
  if (!profileChannel) {
    warnings.push(`⚠「${PROFILE_CHANNEL_NAME}」チャンネルが見つかりません。プロフィールの投稿先として作成してください。`);
  } else if (!canBotPost(profileChannel)) {
    warnings.push(`⚠ Botが「${PROFILE_CHANNEL_NAME}」チャンネルに書き込めません。チャンネルの権限でBotを許可してください。`);
  }

  const reviewChannel = findReviewChannel(guild);
  if (!reviewChannel) {
    warnings.push(`⚠「${REVIEW_CHANNEL_NAME}」チャンネルが見つかりません。申請が届く管理者用のチャンネルとして作成してください。`);
  } else if (!canBotPost(reviewChannel)) {
    warnings.push(`⚠ Botが「${REVIEW_CHANNEL_NAME}」チャンネルに書き込めません。チャンネルの権限でBotを許可してください。`);
  }

  const memberRole = findMemberRole(guild);
  if (!memberRole) {
    warnings.push(`⚠「${MEMBER_ROLE_NAME}」ロールが見つかりません。申請を許可したときに付けるロールとして作成してください。`);
  } else if (!memberRole.editable) {
    // Botのロールより上にあるロールは、管理者権限があっても付与できない
    warnings.push(
      `⚠ Botのロールが「${MEMBER_ROLE_NAME}」より下にあるため、許可したときにロールを付けられません。サーバー設定 > ロール で、Botのロールを上にドラッグしてください。`,
    );
  }
  warnings.push(...adminRoleWarnings(guild));
  return warnings;
};

const openModal = async (interaction: ComponentInteraction): Promise<void> => {
  // 最後まで入力してから申請できないと分かるのを避けるため、先にチャンネルを確認する
  const channel = findProfileChannel(interaction.guild);
  const missing = [
    ...(channel ? [] : [PROFILE_CHANNEL_NAME]),
    ...(findReviewChannel(interaction.guild) ? [] : [REVIEW_CHANNEL_NAME]),
  ];
  if (!channel || missing.length > 0) {
    await interaction.reply({
      content: `「${missing.join('」「')}」チャンネルが見つかりません。管理者に作成を依頼してください。`,
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  // モーダルは3秒以内に表示する必要があるので、ここでは登録済みプロフィールの読み込みだけ行う
  const current = await loadCurrentProfile(channel, interaction.user.id, { includeLeft: true });
  const [currentFirstName = '', currentLastName = ''] = current?.name.split(' ') ?? [];
  // 「入力し直す」のときはルールに合わなかった入力を、それ以外は登録済みの内容を入れておく
  const input = (interaction.customId === RETRY_BUTTON_ID ? rejectedInputs.get(rejectKey(interaction.user.id, false)) : undefined) ?? {
    firstName: currentFirstName,
    lastName: currentLastName,
    comment: current?.comment ?? '',
  };

  const modal = new ModalBuilder()
    .setCustomId(MODAL_ID)
    .setTitle(current ? 'プロフィールを編集' : 'プロフィールを作成')
    .addLabelComponents(...nameAndCommentLabels(input));
  await interaction.showModal(modal);
};

/** 本人の登録の最後。確認チャンネルに申請を送る */
const apply = async (interaction: ComponentInteraction, member: GuildMember, profile: Profile): Promise<void> => {
  if (!(await submitApplication(member, profile))) {
    // 入力画面は残して、チャンネル作成後にもう一度押せるようにする
    await interaction.editReply({
      content: `「${REVIEW_CHANNEL_NAME}」チャンネルが見つからないため申請できません。管理者に作成してもらってから、もう一度「申請する」を押してください。`,
    });
    return;
  }

  drafts.delete(draftKey(interaction.user.id, member.id));
  await interaction.editReply({
    content: ['📨 申請しました！管理者が確認するまでお待ちください。', '結果は Bot からの DM でお知らせします。'].join('\n'),
    embeds: [buildProfileEmbed(member, profile)],
    components: [],
  });
};

/** 管理者の登録の最後。審査なしでプロフチャンネルに投稿し、正規メンバーロールを付ける */
const register = async (interaction: ComponentInteraction, target: GuildMember, profile: Profile): Promise<void> => {
  const channel = findProfileChannel(interaction.guild);
  if (!channel) {
    // 入力画面は残して、チャンネル作成後にもう一度押せるようにする
    await interaction.editReply({
      content: `「${PROFILE_CHANNEL_NAME}」チャンネルが見つかりません。作成してから、もう一度「登録する」を押してください。`,
    });
    return;
  }

  const result = await publishProfile(channel, target, profile);
  drafts.delete(draftKey(interaction.user.id, target.id));

  const verb = result.updated ? '更新' : '登録';
  const roleNote = memberRoleNote(result.memberRole);
  await interaction.editReply({
    content: [`✅ ${target} のプロフィールを${verb}しました: ${result.message.url}`, ...(roleNote ? [roleNote] : [])].join('\n'),
    embeds: [buildProfileEmbed(target, profile)],
    components: [],
    allowedMentions: { parse: [] },
  });
  void sendLog(
    interaction.guild,
    'register',
    `${interaction.member} が ${target} のプロフィールを${verb}しました（管理パネル・審査なし）`,
    interaction.member,
    {
      target,
      fields: [
        ...profileLogFields(profile),
        ...(result.memberRole === 'added' ? [{ name: `🏷️ 「${MEMBER_ROLE_NAME}」ロール`, value: '付けました', inline: true }] : []),
      ],
      links: [{ label: 'プロフィールを見る', url: result.message.url }],
    },
  );
};

const memberRoleNote = (result: MemberRoleResult): string | null => {
  switch (result) {
    case 'added':
      return `「${MEMBER_ROLE_NAME}」ロールを付けました。`;
    case 'failed':
      return `※「${MEMBER_ROLE_NAME}」ロールを付けられませんでした。Botのロールが「${MEMBER_ROLE_NAME}」より上にあるか確認してください。`;
    case 'missing':
      return `※「${MEMBER_ROLE_NAME}」ロールがサーバーにないため、ロールは付けていません。`;
    case 'already':
    case 'skipped':
      return null;
  }
};

/** 管理者の登録中は、誰のプロフィールを入力しているかを画面の一番上に出す */
const withHeader = (ctx: WizardContext, content: string): string =>
  ctx.byAdmin ? `👤 ${ctx.target} のプロフィールを登録しています（管理者）\n${content}` : content;

const firstStep = (ctx: WizardContext, profile: Profile): WizardStep =>
  findProgressRoles(ctx.target.guild).length > 0 ? progressStep(ctx) : dataCenterStep(ctx, profile);

/** 押すとすぐロールが付いて次へ進む。付いているロールは青く表示する */
const progressStep = (ctx: WizardContext): WizardStep => {
  const { target } = ctx;
  const hasProgress = findProgressRoles(target.guild).some((role) => target.roles.cache.has(role.id));
  return {
    content: [
      `${stepLabel(target.guild, 'progress')} 今進めている拡張（メインクエストの進行度）を選んでください。押すと${ctx.byAdmin ? 'このメンバーに' : ''}ロールが付きます。`,
      ...(hasProgress ? ['今のままでよければ、青いボタンを押すとそのまま次へ進みます。'] : []),
    ].join('\n'),
    components: progressRows(target, (roleId) => customId(ctx, 'progress', roleId)),
  };
};

const dataCenterStep = (ctx: WizardContext, profile: Profile): WizardStep => ({
  content: `${stepLabel(ctx.target.guild, 'dataCenter')} データセンターを選んでください。`,
  components: dataCenterRows(profile.dataCenter, (dc) => customId(ctx, 'dc', dc)),
});

const worldStep = (ctx: WizardContext, profile: Profile, dataCenterName: string | undefined): WizardStep => {
  const dataCenter = DATA_CENTERS.find((dc) => dc.name === dataCenterName);
  if (!dataCenter) return dataCenterStep(ctx, profile);

  const back = new ButtonBuilder()
    .setCustomId(customId(ctx, 'dcs'))
    .setLabel('データセンターを選び直す')
    .setStyle(ButtonStyle.Secondary);
  return {
    content: `${stepLabel(ctx.target.guild, 'world')} ${dataCenter.name} のワールドを選んでください。`,
    components: [...worldRows(dataCenter, profile.world, (world) => customId(ctx, 'world', world)), toRow(back)],
  };
};

const timeStep = (ctx: WizardContext, profile: Profile): WizardStep => ({
  content: `${stepLabel(ctx.target.guild, 'time')} よく遊ぶ時間帯を選んでください（だいたいでOK）。選んだら「次へ」を押してください。`,
  components: [
    toRow(hourSelect(customId(ctx, 'start'), '開始時刻', START_HOURS, profile.startHour)),
    toRow(hourSelect(customId(ctx, 'end'), '終了時刻', END_HOURS, profile.endHour)),
    toRow(new ButtonBuilder().setCustomId(customId(ctx, 'time-next')).setLabel('次へ').setStyle(ButtonStyle.Success)),
  ],
});

/** この後の手順（コンテンツ・VC通知）がなければ、ここが最後（「申請する」「登録する」） */
const jobStep = (ctx: WizardContext, profile: Profile): WizardStep => {
  const isLast = nextStep(ctx.target.guild, 'job') === undefined;
  const next = isLast ? finishLabel(ctx) : '次へ';
  const rows = jobRows(profile.jobs, (jobKey) => customId(ctx, 'job', jobKey));
  // 緑のヒーラーと見分けがつくよう、このボタンはグレーにする。ジョブは必須なので未選択の間は押せない
  const nextButton = new ButtonBuilder()
    .setCustomId(customId(ctx, isLast ? 'apply' : 'job-next'))
    .setLabel(next)
    .setStyle(ButtonStyle.Secondary)
    .setDisabled(profile.jobs.length === 0);
  rows.at(-1)?.addComponents(isLast ? nextButton.setEmoji({ name: '📨' }) : nextButton);
  return {
    content: [
      `${stepLabel(ctx.target.guild, 'job')} 使用するジョブを選んでください（**1つ以上必須**・複数選択可）。`,
      `選んだジョブには ✅ が付き、もう一度押すと解除できます。選び終わったら「${next}」を押してください。`,
    ].join('\n'),
    components: rows,
  };
};

/** 押すとすぐロールが付く（任意）。VC通知の手順がなければ、ここが最後 */
const contentStep = (ctx: WizardContext): WizardStep => {
  const isLast = nextStep(ctx.target.guild, 'content') === undefined;
  const next = isLast ? finishLabel(ctx) : '次へ';
  const nextButton = isLast
    ? finishButton(ctx)
    : new ButtonBuilder().setCustomId(customId(ctx, 'content-next')).setLabel(next).setStyle(ButtonStyle.Success);
  return {
    content: [
      `${stepLabel(ctx.target.guild, 'content')} よく遊ぶコンテンツを選んでください（任意・いくつでも）。押すと${ctx.byAdmin ? 'このメンバーに' : ''}ロールが付き、もう一度押すと外れます。`,
      `選び終わったら「${next}」を押してください。`,
    ].join('\n'),
    components: [...contentRows(ctx.target, (roleId) => customId(ctx, 'content', roleId)), toRow(nextButton)],
  };
};

/**
 * 最後の手順。VC通知を受け取るか（押すとすぐ「VC」ロールを付け外しする）。
 * 必ず答えてもらうため、どちらかを選ぶまで「申請する」は押せない（すでに受け取る設定の人は、そのままでも押せる）
 */
const vcStep = (ctx: WizardContext, chosen?: boolean): WizardStep => {
  const { target } = ctx;
  const role = findVcRole(target.guild);
  const selected = chosen ?? (role && target.roles.cache.has(role.id) ? true : undefined);
  return {
    content: [
      `${stepLabel(target.guild, 'vc')} ${ctx.byAdmin ? 'このメンバーが' : ''}VC通知を受け取りますか？`,
      `受け取ると「${VC_ROLE_NAME}」ロールが付き、誰かが通話を始めたときに「${NOTICE_CHANNEL_NAME}」チャンネルでメンションが届きます。`,
      `あとから設定パネルでいつでも変えられます。選んだら「${finishLabel(ctx)}」を押してください。`,
    ].join('\n'),
    components: [
      toRow(
        ...vcNoticeButtons(selected, (choice) => customId(ctx, 'vc', choice)),
        finishButton(ctx).setDisabled(selected === undefined),
      ),
    ],
  };
};

/** ジョブ・コンテンツの「次へ」の行き先。次の手順がなくなっていたら（ロールが消されたなど）、同じ手順を出し直す（「申請する」が出る） */
const stepAfter = (ctx: WizardContext, from: 'job' | 'content', profile: Profile): WizardStep => {
  switch (nextStep(ctx.target.guild, from)) {
    case 'content':
      return contentStep(ctx);
    case 'vc':
      return vcStep(ctx);
    default:
      return from === 'job' ? jobStep(ctx, profile) : contentStep(ctx);
  }
};

/** 本人は「申請する」で審査へ、管理者は「登録する」でそのまま投稿 */
const finishButton = (ctx: WizardContext): ButtonBuilder =>
  new ButtonBuilder().setCustomId(customId(ctx, 'apply')).setLabel(finishLabel(ctx)).setEmoji({ name: '📨' }).setStyle(ButtonStyle.Success);

const finishLabel = (ctx: WizardContext): string => (ctx.byAdmin ? '登録する' : '申請する');

/** このサーバーで使う手順。進行度・コンテンツ・「VC」のロールがなければ、その手順を飛ばす */
const availableSteps = (guild: Guild): StepName[] =>
  STEPS.filter((step) => {
    switch (step) {
      case 'progress':
        return findProgressRoles(guild).length > 0;
      case 'content':
        return findContentRoles(guild).length > 0;
      case 'vc':
        return findVcRole(guild) !== undefined;
      default:
        return true;
    }
  });

/** その次の手順。最後の手順（または使わない手順）なら undefined */
const nextStep = (guild: Guild, step: StepName): StepName | undefined => {
  const steps = availableSteps(guild);
  const index = steps.indexOf(step);
  return index === -1 ? undefined : steps[index + 1];
};

/** 「1/7」のような番号。使わない手順は数えない */
const stepLabel = (guild: Guild, step: StepName): string => {
  const steps = availableSteps(guild);
  return `**${steps.indexOf(step) + 1}/${steps.length}**`;
};

const customId = (ctx: WizardContext, action: string, value?: string): string => {
  if (ctx.byAdmin) return `${CUSTOM_ID_PREFIX}${action}:${value ?? ''}:${ctx.target.id}`;
  return value === undefined ? `${CUSTOM_ID_PREFIX}${action}` : `${CUSTOM_ID_PREFIX}${action}:${value}`;
};

const draftKey = (operatorId: string, targetId: string): string => `${operatorId}:${targetId}`;

const rejectKey = (operatorId: string, byAdmin: boolean): string => (byAdmin ? `${operatorId}:admin` : operatorId);
