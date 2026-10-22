import {
  ButtonBuilder,
  ButtonStyle,
  LabelBuilder,
  MessageFlags,
  ModalBuilder,
  StringSelectMenuBuilder,
  TextInputBuilder,
  TextInputStyle,
  UserSelectMenuBuilder,
  type ButtonInteraction,
  type EmbedBuilder,
  type Guild,
  type GuildMember,
  type ModalSubmitInteraction,
  type RoleSelectMenuInteraction,
  type StringSelectMenuInteraction,
  type UserSelectMenuInteraction,
} from 'discord.js';
import { JOBS } from './jobs.js';
import { addDays, formatDay, fromJst, jstDay } from './jst.js';
import { isAdmin } from './permissions.js';
import { toRow, toRows, type Row } from './profileInputs.js';
import { MEMBER_ROLE_NAME, findMemberRole } from './profilePublish.js';
import { describeSlotState, type RecruitConfig, type RecruitSlot } from './recruitEngine.js';
import { recruitCustomId } from './recruitMessage.js';
import { jobLabel, jobsForRole } from './recruitParty.js';

// 募集の画面の部品（作成の手順と主催メニューで共通）。画面はどれも、押した本人にだけ見える

export type RecruitComponentInteraction =
  | ButtonInteraction<'cached'>
  | StringSelectMenuInteraction<'cached'>
  | UserSelectMenuInteraction<'cached'>
  | RoleSelectMenuInteraction<'cached'>;

export interface Screen {
  content: string;
  embeds?: EmbedBuilder[];
  components: Row[];
}

/** 作成中の下書きを表す target（主催メニューでは募集のID） */
export const DRAFT_TARGET = 'w';
/** 「未定」のジョブ（セレクトメニューの値） */
export const NO_JOB = 'none';
/** 選んでいるうちに少し過ぎた時刻は受け付ける */
const PAST_TOLERANCE_MS = 10 * 60_000;
/** 募集できるのはこの日数先まで */
const MAX_DAYS_AHEAD = 60;

/**
 * 画面を出す。本人にだけ見える画面からの操作ならその画面を切り替え、
 * 募集の投稿やパネルからの操作なら、新しく本人にだけ見える画面を出す（投稿自体は書き換えない）
 */
export const respond = async (interaction: RecruitComponentInteraction, screen: Screen): Promise<void> => {
  const payload = { content: screen.content, embeds: screen.embeds ?? [], components: screen.components, allowedMentions: { parse: [] } };
  if (interaction.message.flags.has(MessageFlags.Ephemeral)) {
    await interaction.update(payload);
  } else {
    await interaction.reply({ ...payload, flags: MessageFlags.Ephemeral });
  }
};

/** 時間のかかる処理の前に応答しておく（3秒以内に応答しないと失敗になる）。そのあと editScreen で出す */
export const deferScreen = async (interaction: RecruitComponentInteraction | ModalSubmitInteraction<'cached'>): Promise<void> => {
  if (interaction.isModalSubmit()) {
    // 本人にだけ見える画面のボタンから開いたモーダルなら、その画面を書き換える
    if (interaction.isFromMessage() && interaction.message.flags.has(MessageFlags.Ephemeral)) {
      await interaction.deferUpdate();
    } else {
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    }
    return;
  }
  if (interaction.message.flags.has(MessageFlags.Ephemeral)) {
    await interaction.deferUpdate();
  } else {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  }
};

export const editScreen = async (interaction: RecruitComponentInteraction | ModalSubmitInteraction<'cached'>, screen: Screen): Promise<void> => {
  await interaction.editReply({ content: screen.content, embeds: screen.embeds ?? [], components: screen.components, allowedMentions: { parse: [] } });
};

export const button = (id: string, label: string, style: ButtonStyle = ButtonStyle.Secondary, emoji?: string): ButtonBuilder => {
  const built = new ButtonBuilder().setCustomId(id).setLabel(label).setStyle(style);
  return emoji ? built.setEmoji({ name: emoji }) : built;
};

/** 選んでいるものは青、ほかは灰色 */
export const choice = (id: string, label: string, selected: boolean, emoji?: string): ButtonBuilder =>
  button(id, label, selected ? ButtonStyle.Primary : ButtonStyle.Secondary, emoji);

export const NOT_ALLOWED = `募集は「${MEMBER_ROLE_NAME}」の人だけが使えます。先にプロフィールパネルから申請してください。`;

/** 募集を作ったり参加したりできるか。「正規メンバー」ロールがあるサーバーでは、その人と管理者だけ */
export const canUseRecruit = (member: GuildMember): boolean => {
  const role = findMemberRole(member.guild);
  return !role || member.roles.cache.has(role.id) || isAdmin(member);
};

export const displayName = (guild: Guild, userId: string): string => guild.members.cache.get(userId)?.displayName ?? 'メンバー';

// ---- 選んだものを customId に入れる（モーダルを挟むとき。customId は100文字まで）

export const toMask = (selected: number[]): string => selected.reduce((mask, i) => mask | (1n << BigInt(i)), 0n).toString(36);

export const fromMask = (mask: string): number[] => {
  let value = 0n;
  for (const char of mask) value = value * 36n + BigInt(parseInt(char, 36));
  const indices: number[] = [];
  for (let i = 0; value > 0n; i++, value >>= 1n) if (value & 1n) indices.push(i);
  return indices;
};

export const jobsToMask = (jobs: string[]): string => toMask(jobs.map((job) => JOBS.findIndex((j) => j.key === job)).filter((i) => i >= 0));
export const maskToJobs = (mask: string): string[] => fromMask(mask).flatMap((i) => (JOBS[i] ? [JOBS[i].key] : []));

// ---- 開始日時を選ぶ画面（日付 → 時 → 分）

/** 「2026-10-22」⇔「20261022」（customId を短くする） */
export const compactDay = (day: string): string => day.replaceAll('-', '');
export const expandDay = (compact: string): string => `${compact.slice(0, 4)}-${compact.slice(4, 6)}-${compact.slice(6, 8)}`;

export const startTimeOf = (day: string, hour: number, minute: number): Date => {
  const [year = 0, month = 1, date = 1] = day.split('-').map(Number);
  return fromJst(year, month, date, hour, minute);
};

/** 開始日時として使えないときの理由（使えるなら null） */
export const startTimeProblem = (date: Date, now: Date = new Date()): string | null => {
  if (date.getTime() < now.getTime() - PAST_TOLERANCE_MS) return 'その時刻はもう過ぎています。日付から選び直してください。';
  if (date.getTime() > now.getTime() + MAX_DAYS_AHEAD * 24 * 60 * 60_000) return `募集できるのは${MAX_DAYS_AHEAD}日先までです。`;
  return null;
};

const DATE_CHOICES = 7;
const QUICK_HOURS = [18, 19, 20, 21, 22, 23];
const MINUTES = [0, 10, 20, 30, 40, 50];

export const dateScreen = (target: string, header: string, extra: { selected?: string | null; nav: ButtonBuilder[]; note?: string }): Screen => {
  const today = jstDay();
  const days = Array.from({ length: DATE_CHOICES }, (_, i) => addDays(today, i));
  const names = ['今日', '明日', '明後日'];
  const dayButtons = days.map((day, i) =>
    choice(recruitCustomId('t', 'date', target, compactDay(day)), `${names[i] ? `${names[i]} ` : ''}${formatDay(day)}`, day === extra.selected),
  );
  return {
    content: [header, ...(extra.note ? [extra.note] : []), '開始する日を選んでください（7日より先は、主催メニューの「開始時刻」から日付を進められます）。'].join('\n'),
    components: [
      ...toRows(dayButtons, 4),
      toRow(button(recruitCustomId('t', 'now', target), '今すぐ始める', ButtonStyle.Success, '⚡'), ...extra.nav),
    ],
  };
};

export const hourScreen = (target: string, header: string, day: string, selected: number | null, nav: ButtonBuilder[]): Screen => {
  const quick = QUICK_HOURS.map((hour) => choice(recruitCustomId('t', 'hour', target, compactDay(day), String(hour)), `${hour}:00`, hour === selected));
  const select = new StringSelectMenuBuilder()
    .setCustomId(recruitCustomId('t', 'hoursel', target, compactDay(day)))
    .setPlaceholder('ほかの時間（0〜23時）')
    .addOptions(Array.from({ length: 24 }, (_, hour) => ({ label: `${hour}時`, value: String(hour), default: hour === selected })));
  return {
    content: `${header}\n**${formatDay(day)}** の何時に始めますか？`,
    components: [...toRows(quick, 3), toRow(select), toRow(...nav)],
  };
};

export const minuteScreen = (target: string, header: string, day: string, hour: number, selected: number | null, nav: ButtonBuilder[]): Screen => {
  const buttons = MINUTES.map((minute) =>
    choice(
      recruitCustomId('t', 'min', target, compactDay(day), String(hour), String(minute)),
      `${hour}:${String(minute).padStart(2, '0')}`,
      minute === selected,
    ),
  );
  return {
    content: `${header}\n**${formatDay(day)} ${hour}時** の何分に始めますか？`,
    components: [...toRows(buttons, 3), toRow(...nav)],
  };
};

// ---- 枠の設定（ジョブ指定・事前埋まり・〆）

/** セレクトメニューの見出しに使う、枠の状態（メンションは表示されないので名前にする） */
const plainSlotState = (guild: Guild, config: RecruitConfig, slot: RecruitSlot): string =>
  describeSlotState(config, slot).replace(/<@(\d+)>/g, (_, id: string) => displayName(guild, id));

export const slotListScreen = (guild: Guild, target: string, config: RecruitConfig, header: string, nav: ButtonBuilder[], note?: string): Screen => {
  const select = new StringSelectMenuBuilder()
    .setCustomId(recruitCustomId('s', 'pick', target))
    .setPlaceholder('設定する枠を選ぶ')
    .addOptions(config.slots.map((slot) => ({ label: `${slot.key}: ${plainSlotState(guild, config, slot)}`.slice(0, 100), value: slot.key })));
  return {
    content: [
      header,
      ...(note ? [note] : []),
      '枠ごとに **ジョブ指定**・**事前埋まり**（決まっている人で先に埋める）・**〆**（ゲーム内募集で埋まった）を設定できます。',
      '設定しない枠は、そのまま参加を受け付けます。',
    ].join('\n'),
    components: [toRow(select), toRow(...nav)],
  };
};

export const slotScreen = (guild: Guild, target: string, config: RecruitConfig, key: string, header: string, note?: string): Screen => {
  const slot = config.slots.find((s) => s.key === key);
  const back = button(recruitCustomId('s', 'list', target), '枠の一覧へ', ButtonStyle.Secondary, '◀');
  if (!slot) return { content: `${header}\nその枠は見つかりません。`, components: [toRow(back)] };
  const id = (action: string) => recruitCustomId('s', action, target, key);
  return {
    content: [header, ...(note ? [note] : []), `**${key}** の今の状態: ${plainSlotState(guild, config, slot)}`].join('\n'),
    components: [
      toRow(
        button(id('req'), slot.requiredJob ? `ジョブ指定: ${jobLabel(slot.requiredJob)}` : 'ジョブ指定', ButtonStyle.Secondary, '🎯'),
        button(id('member'), 'サーバーの人で埋める', ButtonStyle.Secondary, '👤'),
        button(id('ext'), '外部の人で埋める', ButtonStyle.Secondary, '🧑‍🤝‍🧑'),
      ),
      toRow(button(id('close'), '〆にする（ゲーム内で埋まった）', ButtonStyle.Secondary, '🔒'), button(id('clear'), '空きに戻す', ButtonStyle.Danger, '🧹'), back),
    ],
  };
};

/** ジョブ指定を選ぶ画面 */
export const requireScreen = (target: string, slot: RecruitSlot, header: string): Screen => {
  const select = new StringSelectMenuBuilder()
    .setCustomId(recruitCustomId('s', 'reqsel', target, slot.key))
    .setPlaceholder('このジョブの人だけ入れる')
    .addOptions(
      { label: '指定しない', value: NO_JOB, default: !slot.requiredJob },
      ...jobsForRole(slot.role).map((job) => ({ label: job.name, value: job.key, default: job.key === slot.requiredJob })),
    );
  return {
    content: `${header}\n**${slot.key}** に入れるジョブを指定しますか？`,
    components: [toRow(select), toRow(button(recruitCustomId('s', 'pick', target, slot.key), '戻る', ButtonStyle.Secondary, '◀'))],
  };
};

const jobSelect = (id: string, slot: RecruitSlot, required: boolean, placeholder: string): StringSelectMenuBuilder =>
  new StringSelectMenuBuilder()
    .setCustomId(id)
    .setPlaceholder(placeholder)
    .setRequired(required)
    .addOptions(
      ...(slot.requiredJob
        ? [{ label: jobLabel(slot.requiredJob), value: slot.requiredJob, default: true }]
        : [{ label: '未定・分からない', value: NO_JOB }, ...jobsForRole(slot.role).map((job) => ({ label: job.name, value: job.key }))]),
    );

/** サーバーの人で埋めるモーダル（メンバーとジョブ） */
export const memberModal = (target: string, slot: RecruitSlot): ModalBuilder =>
  new ModalBuilder()
    .setCustomId(recruitCustomId('s', 'membersub', target, slot.key))
    .setTitle(`${slot.key} をサーバーの人で埋める`)
    .addLabelComponents(
      new LabelBuilder()
        .setLabel('メンバー')
        .setUserSelectMenuComponent(new UserSelectMenuBuilder().setCustomId('member').setRequired(true)),
      new LabelBuilder().setLabel('ジョブ').setStringSelectMenuComponent(jobSelect('job', slot, true, 'ジョブを選ぶ')),
    );

/** 外部の人（サーバーにいない人）で埋めるモーダル（名前とジョブ） */
export const externalModal = (target: string, slot: RecruitSlot): ModalBuilder =>
  new ModalBuilder()
    .setCustomId(recruitCustomId('s', 'extsub', target, slot.key))
    .setTitle(`${slot.key} を外部の人で埋める`)
    .addLabelComponents(
      new LabelBuilder()
        .setLabel('名前（任意）')
        .setDescription('募集に出す名前。空なら「外部の人」')
        .setTextInputComponent(new TextInputBuilder().setCustomId('name').setStyle(TextInputStyle.Short).setMaxLength(30).setRequired(false)),
      new LabelBuilder().setLabel('ジョブ').setStringSelectMenuComponent(jobSelect('job', slot, true, 'ジョブを選ぶ')),
    );

/** 〆にするモーダル（ジョブは分かれば） */
export const closeModal = (target: string, slot: RecruitSlot): ModalBuilder =>
  new ModalBuilder()
    .setCustomId(recruitCustomId('s', 'closesub', target, slot.key))
    .setTitle(`${slot.key} を〆にする`)
    .addLabelComponents(
      new LabelBuilder()
        .setLabel('入った人のジョブ（分かれば）')
        .setDescription('ゲーム内の募集で埋まった枠です')
        .setStringSelectMenuComponent(jobSelect('job', slot, true, 'ジョブを選ぶ')),
    );

/** モーダルで選ばれたジョブ（「未定」なら null） */
export const pickedJob = (interaction: ModalSubmitInteraction<'cached'>): string | null => {
  const value = interaction.fields.getStringSelectValues('job')[0];
  return value && value !== NO_JOB ? value : null;
};
