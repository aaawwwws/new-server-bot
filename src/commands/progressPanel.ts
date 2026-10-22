import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ComponentType,
  EmbedBuilder,
  InteractionContextType,
  MessageFlags,
  SlashCommandBuilder,
  type ButtonInteraction,
  type ChatInputCommandInteraction,
  type Guild,
  type Message,
  type Role,
} from 'discord.js';
import { sendLog } from '../activityLog.js';
import { EXPANSIONS } from '../expansions.js';
import { rememberPanel, type PanelPayload } from '../panels.js';
import { adminRoleWarnings } from '../permissions.js';
import { refreshPostedProfile } from '../profilePublish.js';
import { findProgressRoles, findRoleByName, setProgressRole } from '../progressRoles.js';

export const BUTTON_PREFIX = 'progress:';
// ボタンの customId にロールIDを埋め込むので、DBなしでどのロールか判別できる
const ROLE_BUTTON_PREFIX = `${BUTTON_PREFIX}role:`;
const BUTTONS_PER_ROW = 3;

export const data = new SlashCommandBuilder()
  .setName('progress-panel')
  .setNameLocalizations({ ja: '進行度パネル' })
  .setDescription('拡張ごとの進行度ロールを選べるパネルをこのチャンネルに設置します（管理者用）')
  .setContexts(InteractionContextType.Guild);

export const execute = async (interaction: ChatInputCommandInteraction<'cached'>): Promise<void> => {
  const channel = interaction.channel;
  if (!channel?.isSendable()) {
    await interaction.reply({ content: 'このチャンネルにはパネルを設置できません。', flags: MessageFlags.Ephemeral });
    return;
  }

  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  // 同名のロールがあればそれを使い、なければ作成する
  const roles: Role[] = [];
  for (const expansion of EXPANSIONS) {
    roles.push(
      findRoleByName(interaction.guild, expansion.name) ??
        (await interaction.guild.roles.create({
          name: expansion.name,
          colors: { primaryColor: expansion.color },
          reason: '進行度パネルの設置',
        })),
    );
  }

  // パネルの設置で通知が飛ばないよう、サイレントメッセージで送る。場所を覚えておき、起動時に最新の内容へ作り直す
  const payload = buildProgressPanel(roles);
  const message = await channel.send({ ...payload, flags: MessageFlags.SuppressNotifications });
  await rememberPanel(message, 'progress', payload);
  void sendLog(interaction.guild, 'panel', `${interaction.member} が進行度パネルを設置しました`, interaction.member, {
    channel,
    links: [{ label: 'パネルへ移動', url: message.url }],
  });

  // Botのロールより上にあるロールは、管理者権限があっても付与できない
  const unassignableRoleNames = roles.filter((role) => !role.editable).map((role) => role.name);
  const warnings = [
    ...(unassignableRoleNames.length > 0
      ? [
          `⚠ Botのロールが「${unassignableRoleNames.join('」「')}」より下にあるため、このままではロールを付けられません。`,
          'サーバー設定 > ロール で、Botのロールを進行度ロールより上にドラッグしてください。',
        ]
      : []),
    ...adminRoleWarnings(interaction.guild),
  ];
  await interaction.editReply(['進行度パネルを設置しました。', ...warnings].join('\n'));
};

/** 今あるロールで作ったパネルの中身（起動時の作り直し用。足りないロールは作らない） */
export const buildPanel = (guild: Guild): PanelPayload => buildProgressPanel(findProgressRoles(guild));

const buildProgressPanel = (roles: Role[]): PanelPayload => {
  const roleButtons = roles.map((role) =>
    new ButtonBuilder().setCustomId(`${ROLE_BUTTON_PREFIX}${role.id}`).setLabel(role.name).setStyle(ButtonStyle.Primary),
  );

  const rows: ActionRowBuilder<ButtonBuilder>[] = [];
  for (let i = 0; i < roleButtons.length; i += BUTTONS_PER_ROW) {
    rows.push(new ActionRowBuilder<ButtonBuilder>().addComponents(roleButtons.slice(i, i + BUTTONS_PER_ROW)));
  }

  const embed = new EmbedBuilder()
    .setTitle('📖 メインクエスト進行度')
    .setDescription(
      [
        '今進めている拡張のボタンを押すと、進行度ロールが付きます。',
        '',
        '・ロールは1人1つだけ。拡張が進んだら押し直すと付け替わります',
        '・ネタバレ防止のため、自分の進行度に合ったものを選んでください',
      ].join('\n'),
    )
    .setColor(0xd4a72c);

  return { embeds: [embed], components: rows };
};

export const handleButton = async (interaction: ButtonInteraction<'cached'>): Promise<void> => {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  const roleId = interaction.customId.slice(ROLE_BUTTON_PREFIX.length);
  const role = interaction.guild.roles.cache.get(roleId);
  if (!role) {
    await interaction.editReply('ロールが見つかりません。管理者にパネルの設置し直しを依頼してください。');
    return;
  }
  if (interaction.member.roles.cache.has(roleId)) {
    await interaction.editReply(`すでに「${role.name}」が付いています。`);
    return;
  }

  const updated = await setProgressRole(interaction.member, role, getPanelRoleIds(interaction.message));
  // 登録済みの人は、プロフの投稿の進行度も変える
  await refreshPostedProfile(updated);
  await interaction.editReply(`「${role.name}」ロールを付けました。`);
};

/** パネルのボタンから、進行度ロールのID一覧を取り出す */
const getPanelRoleIds = (message: Message): string[] => {
  return message.components
    .flatMap((row) => (row.type === ComponentType.ActionRow ? row.components : []))
    .flatMap((component) =>
      component.type === ComponentType.Button && component.customId?.startsWith(ROLE_BUTTON_PREFIX)
        ? [component.customId.slice(ROLE_BUTTON_PREFIX.length)]
        : [],
    );
};
