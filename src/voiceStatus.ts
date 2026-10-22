import { setTimeout as sleep } from 'node:timers/promises';
import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  LabelBuilder,
  MessageFlags,
  ModalBuilder,
  PermissionFlagsBits,
  Routes,
  TextInputBuilder,
  TextInputStyle,
  type ButtonInteraction,
  type GatewayVoiceChannelStatusUpdateDispatchData,
  type GuildMember,
  type ModalSubmitInteraction,
  type VoiceBasedChannel,
  type VoiceState,
} from 'discord.js';
import { sendLog } from './activityLog.js';
import { isAdmin } from './permissions.js';

// VCステータス（VCの名前の下に出る「何をしているか」）。
// 通話が始まったら、そのVCのチャットに設定ボタンを出す。Botが代わりに設定するので、Botには「チャンネルの管理」権限が要る

export const CUSTOM_ID_PREFIX = 'vcstatus:';
const STATUS_INPUT_ID = 'status';
/** 入ってすぐ移動・退出した場合を除くため、少し待ってから出す（通話の開始のお知らせと同じ） */
const SETTLE_MS = 5_000;
/** ステータスの長さ（Discordは500文字まで受け付けるが、VC一覧で読める長さにする） */
const MAX_STATUS_LENGTH = 100;

/** 今のステータス（VCのID → ステータス）。Botが設定したものと、Discordから届いた変更を覚える */
const currentStatus = new Map<string, string>();
/** VCのチャットに出したお知らせ（VCのID → メッセージID）。次の通話では前のものを消す */
const promptMessages = new Map<string, string>();
/** お知らせを出す準備中のVC（続けて入ったときに二重に出さないため） */
const pending = new Set<string>();

/** 誰もいないVCに最初の1人が入ったら、そのVCのチャットにステータスの設定ボタンを出す */
export const handleVoiceStatusPrompt = async (oldState: VoiceState, newState: VoiceState): Promise<void> => {
  const channel = newState.channel;
  const member = newState.member;
  if (!channel || oldState.channelId === newState.channelId || !member || member.user.bot) return;
  if (channel.id === channel.guild.afkChannelId || humansIn(channel) !== 1 || pending.has(channel.id)) return;

  pending.add(channel.id);
  try {
    await sleep(SETTLE_MS);
    const me = channel.guild.members.me;
    const canSend =
      me && channel.permissionsFor(me).has([PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.EmbedLinks]);
    if (humansIn(channel) === 0 || !canSend || !channel.isSendable()) return;

    // Discordは誰もいなくなるとステータスを消すので、新しい通話は「未設定」から始まる
    currentStatus.delete(channel.id);
    const previous = promptMessages.get(channel.id);
    if (previous) await channel.messages.delete(previous).catch(() => undefined);
    const message = await channel.send({ ...buildPrompt(channel), flags: MessageFlags.SuppressNotifications });
    promptMessages.set(channel.id, message.id);
  } finally {
    pending.delete(channel.id);
  }
};

/** Discord側でステータスが変わったとき（VCの画面から変えたときなど）も覚えておく（discord.js はこのイベントをまだ扱わないので、届いたままの形で受け取る） */
export const trackVoiceStatus = (data: GatewayVoiceChannelStatusUpdateDispatchData): void => {
  if (data.status) {
    currentStatus.set(data.id, data.status);
  } else {
    currentStatus.delete(data.id);
  }
};

const buildPrompt = (channel: VoiceBasedChannel, changedBy?: GuildMember) => {
  const status = currentStatus.get(channel.id);
  const embed = new EmbedBuilder()
    .setColor(0x3498db)
    .setTitle('📝 VCステータス')
    .setDescription(
      [
        '何をしているか書いておくと、VCの名前の下に表示されます。',
        '例: 零式4層 練習 / 雑談 / 地図 / 作業中',
      ].join('\n'),
    )
    .addFields({ name: '今のステータス', value: status ? `**${status}**` : '未設定' });
  if (changedBy) embed.setFooter({ text: `${changedBy.displayName} さんが変更しました`, iconURL: changedBy.displayAvatarURL() });
  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId(`${CUSTOM_ID_PREFIX}set:${channel.id}`).setLabel('ステータスを設定').setEmoji({ name: '✏️' }).setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId(`${CUSTOM_ID_PREFIX}clear:${channel.id}`).setLabel('消す').setEmoji({ name: '🧹' }).setStyle(ButtonStyle.Secondary),
  );
  return { embeds: [embed], components: [row] };
};

export const handleButton = async (interaction: ButtonInteraction<'cached'>): Promise<void> => {
  const [, action, channelId = ''] = interaction.customId.split(':');
  const channel = interaction.guild.channels.cache.get(channelId);
  const problem = channel?.isVoiceBased() ? statusProblem(interaction.member, channel) : 'このVCが見つかりません。';
  if (problem || !channel?.isVoiceBased()) {
    await interaction.reply({ content: problem ?? 'このVCが見つかりません。', flags: MessageFlags.Ephemeral });
    return;
  }

  if (action === 'set') {
    const input = new TextInputBuilder()
      .setCustomId(STATUS_INPUT_ID)
      .setStyle(TextInputStyle.Short)
      .setPlaceholder('例: 零式4層 練習 / 雑談 / 地図')
      .setMaxLength(MAX_STATUS_LENGTH)
      .setRequired(true);
    const status = currentStatus.get(channel.id);
    if (status) input.setValue(status.slice(0, MAX_STATUS_LENGTH));
    await interaction.showModal(
      new ModalBuilder()
        .setCustomId(`${CUSTOM_ID_PREFIX}submit:${channel.id}`)
        .setTitle('VCステータスを設定')
        .addLabelComponents(new LabelBuilder().setLabel('ステータス').setTextInputComponent(input)),
    );
    return;
  }
  if (action === 'clear') {
    await interaction.deferUpdate();
    await changeStatus(interaction, channel, null);
  }
};

export const handleModalSubmit = async (interaction: ModalSubmitInteraction<'cached'>): Promise<void> => {
  const [, action, channelId = ''] = interaction.customId.split(':');
  const channel = interaction.guild.channels.cache.get(channelId);
  if (action !== 'submit' || !channel?.isVoiceBased() || !interaction.isFromMessage()) return;
  const problem = statusProblem(interaction.member, channel);
  if (problem) {
    await interaction.reply({ content: problem, flags: MessageFlags.Ephemeral });
    return;
  }
  // お知らせのメッセージから開いたモーダルなので、そのメッセージを書き換える
  await interaction.deferUpdate();
  await changeStatus(interaction, channel, interaction.fields.getTextInputValue(STATUS_INPUT_ID).trim() || null);
};

/** Botがステータスを書き換え、お知らせのメッセージにも反映して、ログに残す */
const changeStatus = async (
  interaction: ButtonInteraction<'cached'> | ModalSubmitInteraction<'cached'>,
  channel: VoiceBasedChannel,
  status: string | null,
): Promise<void> => {
  try {
    await interaction.client.rest.put(Routes.channelVoiceStatus(channel.id), { body: { status } });
  } catch (error) {
    console.error(`「${channel.name}」のVCステータスを変えられませんでした:`, error);
    await interaction.followUp({
      content: 'ステータスを変えられませんでした。Botの「チャンネルの管理」権限を確認してください。',
      flags: MessageFlags.Ephemeral,
    });
    return;
  }
  if (status) {
    currentStatus.set(channel.id, status);
  } else {
    currentStatus.delete(channel.id);
  }
  await interaction.editReply(buildPrompt(channel, interaction.member));
  void sendLog(
    channel.guild,
    'voice',
    status ? `${interaction.member} が ${channel} のステータスを「${status}」にしました` : `${interaction.member} が ${channel} のステータスを消しました`,
    interaction.member,
    { title: 'VCステータス', channel, fields: [{ name: '📝 ステータス', value: status ?? '（消しました）', inline: true }] },
  );
};

/** ステータスを変えられないときの理由（変えられるなら null）。そのVCに入っている人と管理者だけが変えられる */
const statusProblem = (member: GuildMember, channel: VoiceBasedChannel): string | null => {
  const admin = isAdmin(member);
  if (!admin && !channel.members.has(member.id)) return 'このVCに入っている人だけが、ステータスを変えられます。';
  if (!admin && !channel.permissionsFor(member).has(PermissionFlagsBits.SetVoiceChannelStatus)) {
    return 'このVCのステータスを変える権限がありません。';
  }
  const me = channel.guild.members.me;
  if (!me || !channel.permissionsFor(me).has(PermissionFlagsBits.ManageChannels)) {
    return 'Botに「チャンネルの管理」権限がないため、ステータスを変えられません。管理者に伝えてください。';
  }
  return null;
};

const humansIn = (channel: VoiceBasedChannel): number => channel.members.filter((m) => !m.user.bot).size;
