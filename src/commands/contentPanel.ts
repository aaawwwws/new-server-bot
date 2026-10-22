import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  InteractionContextType,
  MessageFlags,
  SlashCommandBuilder,
  type ButtonInteraction,
  type ChatInputCommandInteraction,
  type Guild,
  type Role,
} from 'discord.js';
import { sendLog } from '../activityLog.js';
import { CONTENT_ROLES, contentEmoji, findContentRoles, memberContentNames, toggleContentRole } from '../contentRoles.js';
import { rememberPanel, type PanelPayload } from '../panels.js';
import { adminRoleWarnings } from '../permissions.js';
import { refreshPostedProfile } from '../profilePublish.js';
import { findRoleByName } from '../progressRoles.js';

export const BUTTON_PREFIX = 'content:';
// ボタンの customId にロールIDを埋め込むので、DBなしでどのロールか判別できる
const ROLE_BUTTON_PREFIX = `${BUTTON_PREFIX}role:`;
const BUTTONS_PER_ROW = 4;

export const data = new SlashCommandBuilder()
  .setName('content-panel')
  .setNameLocalizations({ ja: 'コンテンツパネル' })
  .setDescription('よく遊ぶコンテンツのロールを選べるパネルをこのチャンネルに設置します（管理者用）')
  .setContexts(InteractionContextType.Guild);

export const execute = async (interaction: ChatInputCommandInteraction<'cached'>): Promise<void> => {
  const channel = interaction.channel;
  if (!channel?.isSendable()) {
    await interaction.reply({ content: 'このチャンネルにはパネルを設置できません。', flags: MessageFlags.Ephemeral });
    return;
  }

  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  // 同名のロールがあればそれを使い、なければ作成する。名前の色が変わらないよう、色は付けない
  const roles: Role[] = [];
  for (const content of CONTENT_ROLES) {
    roles.push(
      findRoleByName(interaction.guild, content.name) ??
        (await interaction.guild.roles.create({ name: content.name, permissions: [], reason: 'コンテンツパネルの設置' })),
    );
  }

  // パネルの設置で通知が飛ばないよう、サイレントメッセージで送る。場所を覚えておき、起動時に最新の内容へ作り直す
  const payload = buildContentPanel(roles);
  const message = await channel.send({ ...payload, flags: MessageFlags.SuppressNotifications });
  await rememberPanel(message, 'content', payload);
  void sendLog(interaction.guild, 'panel', `${interaction.member} がコンテンツパネルを設置しました`, interaction.member, {
    channel,
    links: [{ label: 'パネルへ移動', url: message.url }],
  });

  // Botのロールより上にあるロールは、管理者権限があっても付与できない
  const unassignableRoleNames = roles.filter((role) => !role.editable).map((role) => role.name);
  const warnings = [
    ...(unassignableRoleNames.length > 0
      ? [
          `⚠ Botのロールが「${unassignableRoleNames.join('」「')}」より下にあるため、このままではロールを付けられません。`,
          'サーバー設定 > ロール で、Botのロールをコンテンツロールより上にドラッグしてください。',
        ]
      : []),
    ...adminRoleWarnings(interaction.guild),
  ];
  await interaction.editReply(['コンテンツパネルを設置しました。', ...warnings].join('\n'));
};

/** 今あるロールで作ったパネルの中身（起動時の作り直し用。足りないロールは作らない） */
export const buildPanel = (guild: Guild): PanelPayload => buildContentPanel(findContentRoles(guild));

const buildContentPanel = (roles: Role[]): PanelPayload => {
  const buttons = roles.map((role) => {
    const button = new ButtonBuilder()
      .setCustomId(`${ROLE_BUTTON_PREFIX}${role.id}`)
      .setLabel(role.name)
      .setStyle(ButtonStyle.Secondary);
    const emoji = contentEmoji(role.name);
    return emoji ? button.setEmoji({ name: emoji }) : button;
  });
  const rows: ActionRowBuilder<ButtonBuilder>[] = [];
  for (let i = 0; i < buttons.length; i += BUTTONS_PER_ROW) {
    rows.push(new ActionRowBuilder<ButtonBuilder>().addComponents(buttons.slice(i, i + BUTTONS_PER_ROW)));
  }
  const embed = new EmbedBuilder()
    .setTitle('🎮 コンテンツロール')
    .setDescription(
      [
        'よく遊ぶコンテンツのボタンを押すとロールが付きます。',
        'もう一度押すと外れます（いくつでも選べます）。',
      ].join('\n'),
    )
    .setColor(0x9b59b6);
  return { embeds: [embed], components: rows };
};

/** 押すたびに付け外しする（いくつでも付けられる） */
export const handleButton = async (interaction: ButtonInteraction<'cached'>): Promise<void> => {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  const role = interaction.guild.roles.cache.get(interaction.customId.slice(ROLE_BUTTON_PREFIX.length));
  if (!role) {
    await interaction.editReply('ロールが見つかりません。管理者にパネルの設置し直しを依頼してください。');
    return;
  }

  // 付け外しとログは toggleContentRole が行う
  const { member, added } = await toggleContentRole(interaction.member, role);
  // 登録済みの人は、プロフの投稿の「よく遊ぶ」も変える
  await refreshPostedProfile(member);
  await interaction.editReply(
    [
      added ? `✅「${role.name}」ロールを付けました。` : `「${role.name}」ロールを外しました。`,
      `今のコンテンツロール: ${memberContentNames(member).join('・') || 'なし'}`,
    ].join('\n'),
  );
};
