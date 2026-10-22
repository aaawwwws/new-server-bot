import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  LabelBuilder,
  StringSelectMenuBuilder,
  TextInputBuilder,
  TextInputStyle,
  type GuildMember,
  type MessageActionRowComponentBuilder,
} from 'discord.js';
import { MAX_NAME_PART_LENGTH, MAX_NAME_TOTAL_LENGTH, MIN_NAME_PART_LENGTH } from './characterName.js';
import { contentEmoji, findContentRoles } from './contentRoles.js';
import { findProgressRoles } from './progressRoles.js';
import { DATA_CENTERS, type DataCenter } from './dataCenters.js';
import { JOB_ROWS, type Job, type JobRole } from './jobs.js';

// プロフィールの入力画面の部品。登録の手順（プロフィールパネル）と、項目ごとの変更（設定パネル）で共通
// 各関数の idFor には、そのボタンに付ける customId を作る関数を渡す

export type Row = ActionRowBuilder<MessageActionRowComponentBuilder>;

export const FIRST_NAME_INPUT_ID = 'firstName';
export const LAST_NAME_INPUT_ID = 'lastName';
export const COMMENT_INPUT_ID = 'comment';
/** 活動時間の「指定しない」 */
export const NO_TIME = 'none';
export const START_HOURS = Array.from({ length: 24 }, (_, i) => i);
export const END_HOURS = START_HOURS.map((hour) => hour + 1);

const BUTTONS_PER_ROW = 4;
const PROGRESS_BUTTONS_PER_ROW = 3;
// ゲーム内のロールの色に合わせる（タンク=青・ヒーラー=緑・DPS=赤）
export const JOB_ROLE_STYLES: Record<JobRole, ButtonStyle> = {
  tank: ButtonStyle.Primary,
  healer: ButtonStyle.Success,
  dps: ButtonStyle.Danger,
};

export interface NameAndCommentInput {
  firstName: string;
  lastName: string;
  comment: string;
}

/** 名前・苗字・ひとことの入力欄 */
export const nameAndCommentLabels = (input: NameAndCommentInput, commentDescription?: string): LabelBuilder[] => {
  const commentInput = new TextInputBuilder()
    .setCustomId(COMMENT_INPUT_ID)
    .setStyle(TextInputStyle.Paragraph)
    .setPlaceholder('例: よろしくお願いします！')
    .setMaxLength(300)
    .setRequired(false);
  if (input.comment) commentInput.setValue(input.comment);

  const commentLabel = new LabelBuilder().setLabel('ひとこと').setTextInputComponent(commentInput);
  if (commentDescription) commentLabel.setDescription(commentDescription);

  return [
    new LabelBuilder()
      .setLabel('名前（First Name）')
      .setDescription(`半角英字と ' - のみ・${MIN_NAME_PART_LENGTH}〜${MAX_NAME_PART_LENGTH}文字`)
      .setTextInputComponent(nameInput(FIRST_NAME_INPUT_ID, '例: Taro', input.firstName)),
    new LabelBuilder()
      .setLabel('苗字（Family Name）')
      .setDescription(`${MIN_NAME_PART_LENGTH}〜${MAX_NAME_PART_LENGTH}文字・名前と合わせて${MAX_NAME_TOTAL_LENGTH}文字以内`)
      .setTextInputComponent(nameInput(LAST_NAME_INPUT_ID, '例: Yamada', input.lastName)),
    commentLabel,
  ];
};

/** コンテンツロールのボタン。付いているロールは青く表示する */
export const contentRows = (member: GuildMember, idFor: (roleId: string) => string): Row[] =>
  toRows(
    findContentRoles(member.guild).map((role) => {
      const button = toggleButton(idFor(role.id), role.name, member.roles.cache.has(role.id));
      const emoji = contentEmoji(role.name);
      return emoji ? button.setEmoji({ name: emoji }) : button;
    }),
  );

/** 進行度ロールのボタン。付いているロールは青く表示する */
export const progressRows = (member: GuildMember, idFor: (roleId: string) => string): Row[] =>
  toRows(
    findProgressRoles(member.guild).map((role) => toggleButton(idFor(role.id), role.name, member.roles.cache.has(role.id))),
    PROGRESS_BUTTONS_PER_ROW,
  );

/** VC通知を受け取るかのボタン。選んでいる方を青く表示する（まだ選んでいなければ、どちらも灰色） */
export const vcNoticeButtons = (selected: boolean | undefined, idFor: (choice: 'on' | 'off') => string): ButtonBuilder[] => [
  toggleButton(idFor('on'), '受け取る', selected === true).setEmoji({ name: '🔔' }),
  toggleButton(idFor('off'), '受け取らない', selected === false).setEmoji({ name: '🔕' }),
];

export const dataCenterRows = (selected: string | null, idFor: (dataCenter: string) => string): Row[] =>
  toRows(DATA_CENTERS.map((dc) => toggleButton(idFor(dc.name), dc.name, dc.name === selected)));

export const worldRows = (dataCenter: DataCenter, selected: string | null, idFor: (world: string) => string): Row[] =>
  toRows(dataCenter.worlds.map((world) => toggleButton(idFor(world), world, world === selected)));

export const hourSelect = (id: string, placeholder: string, hours: number[], selected: number | null) =>
  new StringSelectMenuBuilder()
    .setCustomId(id)
    .setPlaceholder(placeholder)
    .addOptions(
      { label: '指定しない', value: NO_TIME },
      ...hours.map((hour) => ({ label: `${hour}:00`, value: String(hour), default: hour === selected })),
    );

/** 活動時間のセレクトメニューで選ばれた値を、時刻（指定しないなら null）にする */
export const parseHour = (value: string | undefined): number | null =>
  value === undefined || value === NO_TIME ? null : Number(value);

/**
 * ジョブのボタン（ロールの色分け・選んだものに ✅）。
 * 最後の行に「次へ」などのボタンを足せるよう、最後の行は4個までにしてある（jobs.ts）
 */
export const jobRows = (selected: string[], idFor: (jobKey: string) => string): Row[] =>
  JOB_ROWS.map((jobs) => toRow(...jobs.map((job) => jobButton(job, selected.includes(job.key), idFor(job.key)))));

/** 条件に合うジョブだけのボタン（並びとロールの色はジョブ選択と同じ。空になった行は詰める） */
export const jobButtonRows = (include: (job: Job) => boolean, idFor: (jobKey: string) => string): Row[] =>
  JOB_ROWS.map((jobs) => jobs.filter(include))
    .filter((jobs) => jobs.length > 0)
    .map((jobs) => toRow(...jobs.map((job) => jobButton(job, false, idFor(job.key)))));

export const toggleButton = (id: string, label: string, selected: boolean): ButtonBuilder =>
  new ButtonBuilder()
    .setCustomId(id)
    .setLabel(label)
    .setStyle(selected ? ButtonStyle.Primary : ButtonStyle.Secondary);

export const toRow = (...components: MessageActionRowComponentBuilder[]): Row =>
  new ActionRowBuilder<MessageActionRowComponentBuilder>().addComponents(components);

export const toRows = (buttons: ButtonBuilder[], perRow = BUTTONS_PER_ROW): Row[] => {
  const rows: Row[] = [];
  for (let i = 0; i < buttons.length; i += perRow) {
    rows.push(toRow(...buttons.slice(i, i + perRow)));
  }
  return rows;
};

const jobButton = (job: Job, selected: boolean, id: string): ButtonBuilder => {
  const button = new ButtonBuilder().setCustomId(id).setLabel(job.name).setStyle(JOB_ROLE_STYLES[job.role]);
  return selected ? button.setEmoji({ name: '✅' }) : button;
};

const nameInput = (id: string, placeholder: string, value: string): TextInputBuilder => {
  const input = new TextInputBuilder()
    .setCustomId(id)
    .setStyle(TextInputStyle.Short)
    .setPlaceholder(placeholder)
    .setMinLength(MIN_NAME_PART_LENGTH)
    .setMaxLength(MAX_NAME_PART_LENGTH)
    .setRequired(true);
  // 文字数の範囲外の値（以前の形式で登録された名前など）は入れられないので空にする
  if (value.length >= MIN_NAME_PART_LENGTH && value.length <= MAX_NAME_PART_LENGTH) input.setValue(value);
  return input;
};
