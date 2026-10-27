import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  LabelBuilder,
  MessageFlags,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  time,
  userMention,
  type ButtonInteraction,
  type Client,
  type Embed,
  type Guild,
  type GuildMember,
  type ModalMessageModalSubmitInteraction,
  type ModalSubmitInteraction,
} from 'discord.js';
import { sendLog, type LogDetails } from './activityLog.js';
import { rewardInviter } from './inviteRewards.js';
import { boldName } from './names.js';
import { ensureAdmin } from './permissions.js';
import { buildProfileEmbed, profileLogFields, type Profile } from './profile.js';
import {
  MEMBER_ROLE_NAME,
  PROFILE_CHANNEL_NAME,
  findProfileChannel,
  findReviewChannel,
  publishProfile,
  type MemberRoleResult,
  type PublishResult,
} from './profilePublish.js';
import {
  createApplication,
  decideApplication,
  findStoredProfile,
  reopenApplication,
  setReviewMessage,
  type Application,
  type ReviewMessageRef,
} from './profileStore.js';

// customId は「review:<操作>:<申請ID>」の形
export const CUSTOM_ID_PREFIX = 'review:';
const REASON_INPUT_ID = 'reason';
const DM_FAILED_NOTE = '※ 申請者にDMを送れませんでした（DMを受け付けていない可能性があります）。';
const RESULT_FIELD = '審査結果';
/** 処理済みの審査メッセージは、結果が一目で分かるよう埋め込みの色を変える */
const RESULT_COLORS = {
  approve: 0x57f287,
  reject: 0xed4245,
  kick: 0xe67e22,
  ban: 0x992d22,
  superseded: 0x95a5a6,
} as const;

/** 理由を入力してから実行する操作 */
type ReasonAction = 'reject' | 'kick' | 'ban';
const REASON_ACTIONS: Record<ReasonAction, { label: string; title: string; description: string }> = {
  reject: { label: '拒否', title: '申請を拒否', description: '申請者へのDMに書かれます' },
  kick: { label: 'キック', title: 'メンバーをキック', description: '申請者へのDMと監査ログに書かれます' },
  ban: { label: 'BAN', title: 'メンバーをBAN', description: '申請者へのDMと監査ログに書かれます' },
};
const isReasonAction = (action: string | undefined): action is ReasonAction =>
  action === 'reject' || action === 'kick' || action === 'ban';

/** 申請を受け付けて、確認チャンネルに審査メッセージを送る。確認チャンネルがなければ false */
export const submitApplication = async (member: GuildMember, profile: Profile): Promise<boolean> => {
  const reviewChannel = findReviewChannel(member.guild);
  if (!reviewChannel) return false;

  const kind = (await findStoredProfile(member.guild.id, member.id)) ? '登録内容の変更' : '新規';
  const { id, superseded } = await createApplication(member.guild.id, member.id, profile);
  // 管理者が気づけるよう、パネルと違ってサイレントにはしない。本文はメンションだけにする
  const message = await reviewChannel.send({
    content: `${member}`,
    embeds: [buildProfileEmbed(member, profile).setAuthor({ name: `📝 プロフィールの申請（${kind}）` })],
    components: reviewButtons(id, member.id),
    allowedMentions: { parse: [] },
  });
  await setReviewMessage(id, { channelId: message.channelId, messageId: message.id });
  void sendLog(member.guild, 'apply', `${member} がプロフィールを申請しました（${kind}）`, member, {
    fields: [
      { name: '📝 種類', value: kind, inline: true },
      ...(superseded.length > 0 ? [{ name: '♻️ 前の申請', value: `新しい申請が届いたため無効にしました（${superseded.length}件）`, inline: true }] : []),
      ...profileLogFields(profile),
    ],
    links: [{ label: '申請を見る', url: message.url }],
  });

  for (const old of superseded) {
    await closeSupersededReview(member.guild, old);
  }
  return true;
};

export const handleButton = async (interaction: ButtonInteraction<'cached'>): Promise<void> => {
  const [, action, id] = interaction.customId.split(':');
  if (!id || !/^\d+$/.test(id)) return;

  if (action === 'approve') {
    await approve(interaction, id);
  } else if (isReasonAction(action)) {
    // キック・BANはやり直しがきかないので、「管理者」ロールの人に限る
    if (action !== 'reject' && !(await ensureAdmin(interaction))) return;
    // 理由の入力画面を出す。送信するまで実行しないので、押し間違いの確認も兼ねる
    await interaction.showModal(reasonModal(action, id));
  }
};

/** 拒否・キック・BAN の理由を入力するモーダルの送信 */
export const handleModalSubmit = async (interaction: ModalSubmitInteraction<'cached'>): Promise<void> => {
  const [, action, id] = interaction.customId.split(':');
  // 審査メッセージのボタンから開いたモーダルなので、そのメッセージを書き換えられる
  if (!isReasonAction(action) || !id || !/^\d+$/.test(id) || !interaction.isFromMessage()) return;
  if (action !== 'reject' && !(await ensureAdmin(interaction))) return;

  await interaction.deferUpdate();
  await withErrorNotice(interaction, async () => {
    const reason = interaction.fields.getTextInputValue(REASON_INPUT_ID).trim() || null;
    if (action === 'reject') {
      await reject(interaction, id, reason);
    } else {
      await removeMember(interaction, id, action, reason);
    }
  });
};

const approve = async (interaction: ButtonInteraction<'cached'>, id: string): Promise<void> => {
  await interaction.deferUpdate();
  await withErrorNotice(interaction, async () => {
    const profileChannel = findProfileChannel(interaction.guild);
    if (!profileChannel) {
      await notice(interaction, `「${PROFILE_CHANNEL_NAME}」チャンネルが見つかりません。作成してから、もう一度「許可する」を押してください。`);
      return;
    }

    const application = await decideApplication(id, 'approved', interaction.user.id, null);
    if (!application) {
      await notice(interaction, 'この申請はすでに処理されています。');
      return;
    }

    let result: PublishResult;
    let member: GuildMember;
    try {
      // 進行度ロールや表示名は、申請時ではなく許可した時点のものを使う
      member = await interaction.guild.members.fetch(application.userId);
      result = await publishProfile(profileChannel, member, application.profile);
    } catch (error) {
      await reopenApplication(id);
      console.error('申請の許可に失敗しました:', error);
      await notice(
        interaction,
        'プロフィールを投稿できませんでした。申請者がまだサーバーにいるか、Botの権限を確認してから、もう一度「許可する」を押してください。',
      );
      return;
    }

    // 招待で入った人なら、連れてきた人にお礼のXPを渡す（失敗しても許可は止めない）
    const reward = await rewardInviter(member).catch((error: unknown) => {
      console.error('招待のご褒美を渡せませんでした:', error);
      return null;
    });
    const dmSent = await notifyApplicant(
      interaction.client,
      application.userId,
      [
        `✅ 「${interaction.guild.name}」でのプロフィールの申請が許可されました！`,
        result.message.url,
        ...(result.memberRole === 'added' ? [`「${MEMBER_ROLE_NAME}」ロールが付きました。`] : []),
      ].join('\n'),
    );

    await closeReview(interaction, [
      `✅ ${boldName(interaction.member)} が許可しました（${time(new Date(), 'f')}）→ ${result.message.url}`,
      ...(result.memberRole === 'failed'
        ? [`※「${MEMBER_ROLE_NAME}」ロールを付けられませんでした。Botのロールが「${MEMBER_ROLE_NAME}」より上にあるか確認してください。`]
        : []),
      ...(result.memberRole === 'missing' ? [`※「${MEMBER_ROLE_NAME}」ロールがサーバーにないため、ロールは付けていません。`] : []),
      ...(dmSent ? [] : [DM_FAILED_NOTE]),
    ], RESULT_COLORS.approve);
    void sendLog(interaction.guild, 'approve', `${interaction.member} が ${member} の申請を許可しました`, interaction.member, {
      target: member,
      fields: [
        ...profileLogFields(application.profile),
        { name: `🏷️ 「${MEMBER_ROLE_NAME}」ロール`, value: MEMBER_ROLE_RESULTS[result.memberRole], inline: true },
        { name: '✉️ 申請者へのDM', value: dmSent ? '送りました' : '送れませんでした', inline: true },
        ...(reward ? [{ name: '📨 招待のご褒美', value: `${reward.inviter} に ${reward.xp} XP`, inline: true }] : []),
      ],
      links: [
        { label: 'プロフィールを見る', url: result.message.url },
        { label: '申請を見る', url: interaction.message.url },
      ],
    });
  });
};

const reject = async (interaction: ModalMessageModalSubmitInteraction<'cached'>, id: string, reason: string | null) => {
  const application = await decideApplication(id, 'rejected', interaction.user.id, reason);
  if (!application) {
    await notice(interaction, 'この申請はすでに処理されています。');
    return;
  }

  const dmSent = await notifyApplicant(
    interaction.client,
    application.userId,
    [
      `❌ 「${interaction.guild.name}」でのプロフィールの申請は許可されませんでした。`,
      ...(reason ? [`理由: ${reason}`] : []),
      '内容を見直して、もう一度申請してください。',
    ].join('\n'),
  );

  await closeReview(interaction, [
    `❌ ${boldName(interaction.member)} が拒否しました（${time(new Date(), 'f')}）`,
    ...(reason ? [`理由: ${reason}`] : []),
    ...(dmSent ? [] : [DM_FAILED_NOTE]),
  ], RESULT_COLORS.reject);
  void sendLog(
    interaction.guild,
    'reject',
    `${interaction.member} が ${userMention(application.userId)} の申請を拒否しました`,
    interaction.member,
    reviewLogDetails(interaction, application, reason, dmSent),
  );
};

/** 申請者をキック・BANする */
const removeMember = async (
  interaction: ModalMessageModalSubmitInteraction<'cached'>,
  id: string,
  action: 'kick' | 'ban',
  reason: string | null,
): Promise<void> => {
  const { label } = REASON_ACTIONS[action];
  const icon = action === 'kick' ? '👢' : '🔨';
  const application = await decideApplication(id, action === 'kick' ? 'kicked' : 'banned', interaction.user.id, reason);
  if (!application) {
    await notice(interaction, 'この申請はすでに処理されています。');
    return;
  }

  // キックはサーバーにいる人にしかできない。BANはいなくてもできる（戻ってこられなくなる）
  const member = await interaction.guild.members.fetch(application.userId).catch(() => null);
  const problem =
    action === 'kick' && !member
      ? '申請者はもうサーバーにいません。'
      : member && !(action === 'kick' ? member.kickable : member.bannable)
        ? `申請者がBotより上のロールを持っているか、Botに${label}の権限がないため、${label}できません。`
        : null;
  if (problem) {
    await reopenApplication(id);
    await notice(interaction, problem);
    return;
  }

  // キック・BANしたあとはDMを送れなくなるので、先に送る
  const dmSent = await notifyApplicant(
    interaction.client,
    application.userId,
    [
      `${icon} プロフィールの申請を確認した結果、「${interaction.guild.name}」から${label}されました。`,
      ...(reason ? [`理由: ${reason}`] : []),
    ].join('\n'),
  );

  const auditReason = `プロフィール申請の審査で${label}（${interaction.user.tag}）${reason ? `: ${reason}` : ''}`;
  try {
    if (action === 'kick') {
      await interaction.guild.members.kick(application.userId, auditReason);
    } else {
      await interaction.guild.bans.create(application.userId, { reason: auditReason });
    }
  } catch (error) {
    await reopenApplication(id);
    console.error(`申請者の${label}に失敗しました:`, error);
    await notice(interaction, `${label}できませんでした。Botの権限を確認してから、もう一度押してください。`);
    return;
  }

  await closeReview(interaction, [
    `${icon} ${boldName(interaction.member)} が${label}しました（${time(new Date(), 'f')}）`,
    ...(reason ? [`理由: ${reason}`] : []),
    ...(dmSent ? [] : [DM_FAILED_NOTE]),
  ], RESULT_COLORS[action]);
  void sendLog(
    interaction.guild,
    action,
    `${interaction.member} が ${userMention(application.userId)} を${label}しました（プロフィールの審査）`,
    interaction.member,
    reviewLogDetails(interaction, application, reason, dmSent, member),
  );
};

/** 拒否・キック・BANのログに載せる内容。申請者がもういないこともあるので、そのときはIDだけ載せる */
const reviewLogDetails = (
  interaction: ModalMessageModalSubmitInteraction<'cached'>,
  application: Application,
  reason: string | null,
  dmSent: boolean,
  member: GuildMember | null = interaction.guild.members.cache.get(application.userId) ?? null,
): LogDetails => ({
  target: member ?? application.userId,
  fields: [
    { name: '🪪 キャラクター名', value: application.profile.name, inline: true },
    { name: '✉️ 申請者へのDM', value: dmSent ? '送りました' : '送れませんでした', inline: true },
    { name: '📝 理由', value: reason ?? '（なし）' },
  ],
  links: [{ label: '申請を見る', url: interaction.message.url }],
});

/** 許可したときの「正規メンバー」ロールの結果 */
const MEMBER_ROLE_RESULTS: Record<MemberRoleResult, string> = {
  added: '付けました',
  already: 'すでに付いていました',
  skipped: '変更していません',
  failed: '⚠ 付けられませんでした（Botのロールの位置を確認）',
  missing: '⚠ サーバーにないため付けていません',
};

/** 審査メッセージの埋め込みに結果を書き足し、ボタンをすべて消す（処理済みだと一目で分かるように） */
const closeReview = async (
  interaction: ButtonInteraction<'cached'> | ModalMessageModalSubmitInteraction<'cached'>,
  notes: string[],
  color: number,
): Promise<void> => {
  await interaction.editReply({
    embeds: [withResult(interaction.message.embeds[0], notes, color)],
    components: [],
    allowedMentions: { parse: [] },
  });
};

const withResult = (embed: Embed | undefined, notes: string[], color: number): EmbedBuilder =>
  (embed ? EmbedBuilder.from(embed) : new EmbedBuilder()).setColor(color).addFields({ name: RESULT_FIELD, value: notes.join('\n') });

/** 押した管理者にだけ知らせる */
const notice = async (interaction: ButtonInteraction<'cached'> | ModalSubmitInteraction<'cached'>, content: string) => {
  await interaction.followUp({ content, flags: MessageFlags.Ephemeral });
};

const reviewButtons = (id: string, userId: string): ActionRowBuilder<ButtonBuilder>[] => [
  new ActionRowBuilder<ButtonBuilder>().addComponents(
    reviewButton('approve', id, '許可する', '✅', ButtonStyle.Success),
    reviewButton('reject', id, '拒否する', '❌', ButtonStyle.Danger),
    new ButtonBuilder()
      .setLabel('メンバーを見る')
      .setEmoji({ name: '👤' })
      .setStyle(ButtonStyle.Link)
      .setURL(`https://discord.com/users/${userId}`),
  ),
  // やり直しのきかない操作は、許可・拒否と行を分けて押し間違いにくくする
  new ActionRowBuilder<ButtonBuilder>().addComponents(
    reviewButton('kick', id, 'キック', '👢', ButtonStyle.Secondary),
    reviewButton('ban', id, 'BAN', '🔨', ButtonStyle.Danger),
  ),
];

const reviewButton = (action: string, id: string, label: string, emoji: string, style: ButtonStyle): ButtonBuilder =>
  new ButtonBuilder().setCustomId(`${CUSTOM_ID_PREFIX}${action}:${id}`).setLabel(label).setEmoji({ name: emoji }).setStyle(style);

const reasonModal = (action: ReasonAction, id: string): ModalBuilder => {
  const { label, title, description } = REASON_ACTIONS[action];
  return new ModalBuilder()
    .setCustomId(`${CUSTOM_ID_PREFIX}${action}:${id}`)
    .setTitle(title)
    .addLabelComponents(
      new LabelBuilder()
        .setLabel(`${label}の理由（任意）`)
        .setDescription(description)
        .setTextInputComponent(
          new TextInputBuilder()
            .setCustomId(REASON_INPUT_ID)
            .setStyle(TextInputStyle.Paragraph)
            .setPlaceholder(action === 'reject' ? '例: キャラクター名を確認できませんでした' : '例: 荒らし目的のため')
            .setMaxLength(400)
            .setRequired(false),
        ),
    );
};

/** 新しい申請が届いて無効になった審査メッセージに、その旨を書いてボタンを消す */
const closeSupersededReview = (guild: Guild, ref: ReviewMessageRef): Promise<void> =>
  closeInvalidReview(guild, ref, '⚠ 新しい申請が届いたため、この申請は無効になりました。');

/**
 * 無効になった申請（新しい申請が届いた・申請者が抜けたなど）の審査メッセージに、理由を書いてボタンを消す。
 * 審査メッセージが消されているなどで更新できなくても、止めずにコンソールに出すだけにする
 */
export const closeInvalidReview = async (
  guild: Guild,
  { channelId, messageId }: ReviewMessageRef,
  note: string,
): Promise<void> => {
  try {
    const channel = guild.channels.cache.get(channelId);
    if (!channel?.isTextBased()) return;
    const message = await channel.messages.fetch(messageId);
    await message.edit({
      embeds: [withResult(message.embeds[0], [note], RESULT_COLORS.superseded)],
      components: [],
      allowedMentions: { parse: [] },
    });
  } catch (error) {
    console.error('無効になった申請の表示を更新できませんでした:', error);
  }
};

/** 申請者にDMで結果を送る。DMを受け付けていない人もいるので、送れたかどうかを返す */
const notifyApplicant = async (client: Client, userId: string, content: string): Promise<boolean> => {
  try {
    await client.users.send(userId, content);
    return true;
  } catch {
    return false;
  }
};

/**
 * 審査メッセージは管理者みんなが見るものなので、エラーで内容を書き換えず、押した人にだけ知らせる
 * （共通のエラー処理は、deferUpdate したメッセージ本体を書き換えてしまうため）
 */
const withErrorNotice = async (
  interaction: ButtonInteraction<'cached'> | ModalSubmitInteraction<'cached'>,
  task: () => Promise<void>,
): Promise<void> => {
  try {
    await task();
  } catch (error) {
    console.error('申請の処理に失敗しました:', error);
    await notice(interaction, '処理に失敗しました。時間をおいてもう一度押してください。').catch(() => undefined);
  }
};
