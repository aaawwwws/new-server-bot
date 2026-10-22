import { ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder, MessageFlags, type GuildTextBasedChannel } from 'discord.js';
import { forgetPanel, listPanels, rememberPanel, type PanelPayload } from './panels.js';
import { RECRUIT_PREFIX, withRecruitLock } from './recruitMessage.js';

// 募集パネル（「募集を作成」ボタン）の中身と、募集が増えてもパネルが埋もれないよう一番下に置き直す処理

/** パネルのボタン。募集の投稿のボタン（recruit:p:join:… など）と見分けられるよう、これで始まるものだけをパネルとする */
export const CREATE_BUTTON_ID = `${RECRUIT_PREFIX}create`;

/** パネルの中身（設置するときと、起動時に作り直すときで共通） */
export const buildRecruitPanel = (): PanelPayload => {
  const embed = new EmbedBuilder()
    .setTitle('📣 パーティ募集')
    .setDescription(
      [
        'いっしょに遊ぶ人を募集できます。「募集を作成」から、ボタンで順番に選んでいくだけです。',
        '',
        '**作るとき**',
        '・タイトル → 形（フル / ライト / 人数だけ・ジョブ重複の有無）→ DC → 開始日時 → 主催の参加 → 枠の設定 → メンション',
        '・枠ごとに **ジョブ指定**、決まっている人での **事前埋まり**、ゲーム内募集で埋まった **〆** を設定できます',
        '・よく使う募集は **テンプレート** に保存して、次から呼び出せます',
        '',
        '**参加するとき**',
        '・「参加する」から、入ってよい枠とジョブを選びます。枠を2つ以上選ぶと **FLEX** になり、空いている方に自動で入ります',
        '・一言コメントも付けられます。変更・取り消しは「参加メニュー」から',
        '',
        '投稿すると連絡用のスレッドができ、開始10分前にお知らせが届きます。',
      ].join('\n'),
    )
    .setColor(0x57f287);
  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId(CREATE_BUTTON_ID).setLabel('募集を作成').setEmoji({ name: '📣' }).setStyle(ButtonStyle.Success),
  );
  return { embeds: [embed], components: [row] };
};

/** 募集が増えてもパネルが埋もれないよう、そのチャンネルの募集パネルを一番下に置き直す */
export const bumpRecruitPanel = async (channel: GuildTextBasedChannel): Promise<void> => {
  await withRecruitLock(`panel:${channel.id}`, async () => {
    const panels = (await listPanels(channel.guildId)).filter((panel) => panel.kind === 'recruit' && panel.channelId === channel.id);
    if (panels.length === 0) return;
    for (const panel of panels) {
      await channel.messages.delete(panel.messageId).catch(() => undefined);
      await forgetPanel(panel.messageId);
    }
    const payload = buildRecruitPanel();
    const message = await channel.send({ ...payload, flags: MessageFlags.SuppressNotifications });
    await rememberPanel(message, 'recruit', payload);
  });
};
