import {
  InteractionContextType,
  MessageFlags,
  SlashCommandBuilder,
  type ChatInputCommandInteraction,
  type ModalSubmitInteraction,
} from 'discord.js';
import { sendLog } from '../activityLog.js';
import { rememberPanel } from '../panels.js';
import { openHost, handleHost, handleHostModal, handleHostSlot, handleHostTime } from '../recruitHost.js';
import { handleJoin, handleJoinModal, handleMenu, openJoin, openMenu } from '../recruitJoin.js';
import { RECRUIT_PREFIX } from '../recruitMessage.js';
import { CREATE_BUTTON_ID, buildRecruitPanel } from '../recruitPanelPost.js';
import { DRAFT_TARGET, respond, type RecruitComponentInteraction } from '../recruitUi.js';
import {
  handleWizard,
  handleWizardModal,
  handleWizardSlot,
  handleWizardSlotModal,
  handleWizardTime,
  openCreate,
} from '../recruitWizard.js';

export const CUSTOM_ID_PREFIX = RECRUIT_PREFIX;
export { CREATE_BUTTON_ID };
export const buildPanel = buildRecruitPanel;

export const data = new SlashCommandBuilder()
  .setName('recruit-panel')
  .setNameLocalizations({ ja: '募集パネル' })
  .setDescription('パーティ募集のパネルをこのチャンネルに設置します（管理者用）')
  .setContexts(InteractionContextType.Guild);

export const execute = async (interaction: ChatInputCommandInteraction<'cached'>): Promise<void> => {
  const channel = interaction.channel;
  if (!channel?.isSendable()) {
    await interaction.reply({ content: 'このチャンネルにはパネルを設置できません。', flags: MessageFlags.Ephemeral });
    return;
  }

  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  // パネルの設置で通知が飛ばないよう、サイレントメッセージで送る。場所を覚えておき、起動時に最新の内容へ作り直す
  const payload = buildRecruitPanel();
  const message = await channel.send({ ...payload, flags: MessageFlags.SuppressNotifications });
  await rememberPanel(message, 'recruit', payload);
  void sendLog(interaction.guild, 'panel', `${interaction.member} が募集パネルを設置しました`, interaction.member, {
    channel,
    links: [{ label: 'パネルへ移動', url: message.url }],
  });
  await interaction.editReply(
    [
      '募集パネルを設置しました。',
      '募集はこのチャンネルに投稿され、パネルはいつも一番下に移ります（募集専用のチャンネルに置くのがおすすめです）。',
      '募集中の一覧を別のチャンネルに出したいときは、そのチャンネルで `/募集一覧` を実行してください。',
    ].join('\n'),
  );
};

/**
 * 募集のボタン・メニュー。customId は「recruit:<場面>:<操作>:…」で、場面ごとに振り分ける。
 * create（パネル）/ w（作成の手順）/ p（募集の投稿）/ j（参加）/ m（参加メニュー）/ h（主催メニュー）/
 * t（開始日時。下書きなら w、募集なら募集ID）/ s（枠の設定。同じ）
 */
export const handleComponent = async (interaction: RecruitComponentInteraction): Promise<void> => {
  const [, scope = '', action = '', ...args] = interaction.customId.split(':');
  switch (scope) {
    case 'create':
      await openCreate(interaction);
      return;
    case 'w':
      await handleWizard(interaction, action, args);
      return;
    case 't':
      await (args[0] === DRAFT_TARGET ? handleWizardTime(interaction, action, args) : handleHostTime(interaction, action, args));
      return;
    case 's':
      await (args[0] === DRAFT_TARGET ? handleWizardSlot(interaction, action, args) : handleHostSlot(interaction, action, args));
      return;
    case 'p': {
      const id = args[0] ?? '';
      if (action === 'join') await openJoin(interaction, id);
      else if (action === 'menu') await openMenu(interaction, id);
      else if (action === 'host') await openHost(interaction, id);
      return;
    }
    case 'j':
      await handleJoin(interaction, action, args[0] ?? '');
      return;
    case 'm':
      await handleMenu(interaction, action, args[0] ?? '');
      return;
    case 'h':
      await handleHost(interaction, action, args);
      return;
  }
  // 前の形の募集の投稿のボタン（recruit:join:<ID> など。投稿は起動時に新しい形へ書き換わる）
  const legacyId = action;
  if (scope === 'join') await openJoin(interaction, legacyId);
  else if (scope === 'leave') await openMenu(interaction, legacyId);
  else if (scope === 'host') await openHost(interaction, legacyId);
  else await respond(interaction, { content: 'この画面は古くなりました。募集の投稿からやり直してください。', components: [] });
};

export const handleModalSubmit = async (interaction: ModalSubmitInteraction<'cached'>): Promise<void> => {
  const [, scope = '', action = '', ...args] = interaction.customId.split(':');
  switch (scope) {
    case 'w':
      await handleWizardModal(interaction, action);
      return;
    case 's':
      await (args[0] === DRAFT_TARGET ? handleWizardSlotModal(interaction, action, args[1] ?? '') : handleHostModal(interaction, scope, action, args));
      return;
    case 'h':
      await handleHostModal(interaction, scope, action, args);
      return;
    case 'j':
    case 'm':
      await handleJoinModal(interaction, scope, args);
      return;
  }
};
