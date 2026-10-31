import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ComponentType,
  EmbedBuilder,
  LabelBuilder,
  MessageFlags,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  type ButtonComponent,
  type ButtonInteraction,
  type Client,
  type ModalSubmitInteraction,
} from 'discord.js';
import { formatDuration } from './duration.js';
import { reportError } from './errorReporter.js';
import { formatShortDateTime, parseJstDateTime } from './jst.js';
import {
  claimReturnedSubmarines,
  deleteSubmarine,
  listSubmarines,
  relaunchSubmarine,
  saveSubmarine,
  type SubmarineTimer,
} from './submarineStore.js';

// 潜水艦の帰還通知。帰ってくる時間を登録すると、その時間に本人へDMで知らせる（1人4隻まで）。
// customId は「sub:<操作>:…」。DMのボタンはサーバーの外で押されるので、サーバーのIDも customId に入れる

export const CUSTOM_ID_PREFIX = 'sub:';
/** 設定パネルの「🚢 潜水艦」 */
export const OPEN_BUTTON_ID = `${CUSTOM_ID_PREFIX}open`;
/** 登録・変更のボタン（後ろに何隻目か） */
const EDIT_PREFIX = `${CUSTOM_ID_PREFIX}edit:`;
const MODAL_PREFIX = `${CUSTOM_ID_PREFIX}save:`;
/** DMの「同じ時間でもう一度」（後ろに「サーバーのID:何隻目か」） */
const AGAIN_PREFIX = `${CUSTOM_ID_PREFIX}again:`;
const NAME_INPUT_ID = 'name';
const TIME_INPUT_ID = 'time';
export const SUBMARINE_SLOTS = 4;
const MAX_NAME_LENGTH = 20;
/** 帰ってくるまでの長さの上限（日） */
const MAX_VOYAGE_DAYS = 7;
const DAY_MINUTES = 24 * 60;
const TICK_MS = 60_000;
/** これより遅れて知らせるときは、遅れたことを書く（Botが止まっていたときなど） */
const LATE_NOTICE_MS = 5 * 60_000;
const COLOR = 0x3498db;

export interface Voyage {
  returnsAt: Date;
  /** 今から帰ってくるまでの長さ（分） */
  minutes: number;
}

/**
 * 帰ってくるまでの時間を読む。ゲームの残り時間（「23:40」「23:40:12」「1日2時間」「2時間30分」「45分」）か、
 * 帰ってくる日時（「10/31 21:00」日本時間）。秒は1分に切り上げる（早く知らせないように）。読めなければ理由を返す
 */
export const parseVoyage = (input: string, now: Date): Voyage | string => {
  const text = input.normalize('NFKC').replace(/\s+/g, ' ').trim();
  let returnsAt: Date;
  if (text.includes('/')) {
    const at = parseJstDateTime(text, now);
    if (at === 'format') return '日時は「10/31 21:00」の形で入力してください。';
    if (at === 'invalid') return `「${text}」という日時はありません。`;
    if (at.getTime() <= now.getTime()) return `${formatShortDateTime(at)} はもう過ぎています。`;
    returnsAt = at;
  } else {
    const clock = /^(\d{1,3}):(\d{2})(?::(\d{2}))?$/.exec(text);
    const words = /^(?:(\d+)日)?(?:(\d+)時間)?(?:(\d+)分)?$/.exec(text.replace(/ /g, ''));
    let minutes: number;
    if (clock) {
      if (Number(clock[2]) >= 60 || Number(clock[3] ?? 0) >= 60) return `「${text}」は時間として読めません（分・秒は59まで）。`;
      minutes = Number(clock[1]) * 60 + Number(clock[2]) + (Number(clock[3] ?? 0) > 0 ? 1 : 0);
    } else if (words && (words[1] || words[2] || words[3])) {
      minutes = Number(words[1] ?? 0) * DAY_MINUTES + Number(words[2] ?? 0) * 60 + Number(words[3] ?? 0);
    } else {
      return '「23:40」（残り時間）・「1日2時間」・「10/31 21:00」（帰ってくる日時）のどれかの形で入力してください。';
    }
    if (minutes < 1) return '帰ってくるまでの時間が0分です。';
    returnsAt = new Date(now.getTime() + minutes * 60_000);
  }
  const minutes = Math.ceil((returnsAt.getTime() - now.getTime()) / 60_000);
  if (minutes > MAX_VOYAGE_DAYS * DAY_MINUTES) return `帰ってくるまでの時間は${MAX_VOYAGE_DAYS}日までにしてください。`;
  return { returnsAt, minutes };
};

/** 「1号（1隻目）」。名前がなければ「1隻目」 */
const slotLabel = (slot: number, name: string): string => (name ? `${name}（${slot}隻目）` : `${slot}隻目`);

const isSlot = (slot: number): boolean => Number.isInteger(slot) && slot >= 1 && slot <= SUBMARINE_SLOTS;

/** 4隻の今の様子と、登録・変更のボタン（本人にだけ見える画面）。note は操作の結果 */
export const submarineScreen = async (guildId: string, userId: string, note?: string, now: Date = new Date()) => {
  const bySlot = new Map((await listSubmarines(guildId, userId)).map((timer) => [timer.slot, timer]));
  const slots = Array.from({ length: SUBMARINE_SLOTS }, (_, i) => i + 1);
  const lines = slots.map((slot) => {
    const timer = bySlot.get(slot);
    if (!timer) return `**${slot}隻目** —（登録なし）`;
    const name = timer.name ? `${timer.name}　` : '';
    return timer.returnsAt <= now
      ? `**${slot}隻目** ${name}✅ 帰ってきています（${formatShortDateTime(timer.returnsAt)}）`
      : `**${slot}隻目** ${name}🕒 **${formatShortDateTime(timer.returnsAt)}** に帰還（あと ${formatDuration(timer.returnsAt.getTime() - now.getTime())}）`;
  });
  const embed = new EmbedBuilder()
    .setColor(COLOR)
    .setTitle('🚢 潜水艦の帰還通知')
    .setDescription(lines.join('\n'))
    .setFooter({
      text: '帰ってくる時間になったら、DMでお知らせします（DMを受け取れる設定にしておいてください）。時間は、ゲームの残り時間（23:40）か、帰ってくる日時（10/31 21:00）で入れられます。',
    });
  const buttons = slots.map((slot) => {
    const timer = bySlot.get(slot);
    return new ButtonBuilder()
      .setCustomId(`${EDIT_PREFIX}${slot}`)
      .setLabel(timer?.name || `${slot}隻目`)
      .setEmoji({ name: '✏️' })
      .setStyle(timer && timer.returnsAt > now ? ButtonStyle.Primary : ButtonStyle.Secondary);
  });
  return {
    content: [...(note ? [note, ''] : []), 'ボタンを押すと、その潜水艦の帰ってくる時間を登録・変更できます（時間を空欄で送ると取り消し）。'].join('\n'),
    embeds: [embed],
    components: [new ActionRowBuilder<ButtonBuilder>().addComponents(buttons)],
  };
};

/** 「23:40」（今から帰ってくるまで。分は切り上げ） */
const toClock = (ms: number): string => {
  const minutes = Math.ceil(ms / 60_000);
  return `${Math.floor(minutes / 60)}:${String(minutes % 60).padStart(2, '0')}`;
};

const editModal = (slot: number, timer: SubmarineTimer | undefined, now: Date): ModalBuilder => {
  const name = new TextInputBuilder().setCustomId(NAME_INPUT_ID).setStyle(TextInputStyle.Short).setMaxLength(MAX_NAME_LENGTH).setRequired(false).setPlaceholder('1号');
  if (timer?.name) name.setValue(timer.name);
  const time = new TextInputBuilder().setCustomId(TIME_INPUT_ID).setStyle(TextInputStyle.Short).setMaxLength(20).setRequired(false).setPlaceholder('23:40');
  // まだ帰ってきていなければ、今の残り時間を入れておく（名前だけ変えたいとき用）
  if (timer && timer.returnsAt > now) time.setValue(toClock(timer.returnsAt.getTime() - now.getTime()));
  return new ModalBuilder()
    .setCustomId(`${MODAL_PREFIX}${slot}`)
    .setTitle(`${slot}隻目の潜水艦`)
    .addLabelComponents(
      new LabelBuilder().setLabel('名前（任意）').setTextInputComponent(name),
      new LabelBuilder()
        .setLabel('帰ってくるまでの時間')
        .setDescription('残り時間（23:40・1日2時間）か、帰ってくる日時（10/31 21:00）。空欄で取り消し')
        .setTextInputComponent(time),
    );
};

/** 画面を開く・登録のボタンと、DMの「同じ時間でもう一度」 */
export const handleButton = async (interaction: ButtonInteraction): Promise<void> => {
  if (interaction.customId.startsWith(AGAIN_PREFIX)) {
    await relaunchFromDm(interaction);
    return;
  }
  if (!interaction.inCachedGuild()) return;
  if (interaction.customId === OPEN_BUTTON_ID) {
    // 本人にだけ見える画面からなら切り替え、パネルからなら新しく出す
    if (interaction.message.flags.has(MessageFlags.Ephemeral)) {
      await interaction.deferUpdate();
    } else {
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    }
    await interaction.editReply(await submarineScreen(interaction.guild.id, interaction.user.id));
    return;
  }
  if (interaction.customId.startsWith(EDIT_PREFIX)) {
    const slot = Number(interaction.customId.slice(EDIT_PREFIX.length));
    if (!isSlot(slot)) return;
    const timer = (await listSubmarines(interaction.guild.id, interaction.user.id)).find((t) => t.slot === slot);
    await interaction.showModal(editModal(slot, timer, new Date()));
  }
};

/** 登録のモーダルの送信。時間が空欄なら取り消す */
export const handleModalSubmit = async (interaction: ModalSubmitInteraction<'cached'>): Promise<void> => {
  const slot = Number(interaction.customId.slice(MODAL_PREFIX.length));
  if (!interaction.customId.startsWith(MODAL_PREFIX) || !isSlot(slot)) return;
  if (interaction.isFromMessage()) {
    await interaction.deferUpdate();
  } else {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  }

  const { guild, user } = interaction;
  const name = interaction.fields.getTextInputValue(NAME_INPUT_ID).trim().slice(0, MAX_NAME_LENGTH);
  const time = interaction.fields.getTextInputValue(TIME_INPUT_ID).trim();
  const now = new Date();
  let note: string;
  if (!time) {
    note = (await deleteSubmarine(guild.id, user.id, slot)) ? `🗑️ ${slotLabel(slot, name)}の登録を取り消しました。` : `${slot}隻目は登録されていません。`;
  } else {
    const voyage = parseVoyage(time, now);
    if (typeof voyage === 'string') {
      note = `⚠ ${voyage}`;
    } else {
      await saveSubmarine({ guildId: guild.id, userId: user.id, slot, name, returnsAt: voyage.returnsAt, minutes: voyage.minutes });
      note = `✅ ${slotLabel(slot, name)}: **${formatShortDateTime(voyage.returnsAt)}** に帰ってきます（あと ${formatDuration(voyage.returnsAt.getTime() - now.getTime())}）。帰ってきたらDMでお知らせします。`;
    }
  }
  await interaction.editReply(await submarineScreen(guild.id, user.id, note, now));
};

/** DMの「同じ時間でもう一度」。押したボタンを消して、次に帰ってくる時間を書き足す */
const relaunchFromDm = async (interaction: ButtonInteraction): Promise<void> => {
  const [guildId = '', slotText] = interaction.customId.slice(AGAIN_PREFIX.length).split(':');
  const slot = Number(slotText);
  const timer = isSlot(slot) ? await relaunchSubmarine(guildId, interaction.user.id, slot, new Date()) : null;
  if (!timer) {
    await interaction.reply({ content: 'その潜水艦は登録されていません（取り消した可能性があります）。', flags: MessageFlags.Ephemeral });
    return;
  }
  const rest = interaction.message.components.flatMap((row) =>
    'components' in row
      ? row.components.flatMap((component) =>
          component.type === ComponentType.Button && component.customId !== interaction.customId ? [ButtonBuilder.from(component as ButtonComponent)] : [],
        )
      : [],
  );
  await interaction.update({
    content: `${interaction.message.content}\n🔁 ${slotLabel(timer.slot, timer.name)}: **${formatShortDateTime(timer.returnsAt)}** に帰ってきます（${formatDuration(timer.minutes * 60_000)}）。`,
    components: rest.length > 0 ? [new ActionRowBuilder<ButtonBuilder>().addComponents(rest)] : [],
  });
};

// ---- 帰ってきたときのDM

/** 帰ってきたもののDM（同じ人の分は1通にまとめる） */
const returnedMessage = (guildName: string, timers: SubmarineTimer[], now: Date) => {
  const late = timers.filter((timer) => now.getTime() - timer.returnsAt.getTime() > LATE_NOTICE_MS);
  return {
    content: [
      `🚢 「${guildName}」で登録した潜水艦が帰ってきました！`,
      ...timers.map((timer) => `・${slotLabel(timer.slot, timer.name)}`),
      ...(late.length > 0
        ? [`-# Botが止まっていたため、お知らせが遅れました（帰ってきたのは ${[...new Set(late.map((timer) => formatShortDateTime(timer.returnsAt)))].join('・')}）`]
        : []),
      '同じ航路でもう一度出したら、下のボタンで次の帰ってくる時間を登録できます。',
    ].join('\n'),
    components: [
      new ActionRowBuilder<ButtonBuilder>().addComponents(
        timers.map((timer) =>
          new ButtonBuilder()
            .setCustomId(`${AGAIN_PREFIX}${timer.guildId}:${timer.slot}`)
            .setLabel(`${timer.name || `${timer.slot}隻目`}: 同じ時間（${formatDuration(timer.minutes * 60_000)}）`.slice(0, 80))
            .setEmoji({ name: '🔁' })
            .setStyle(ButtonStyle.Primary),
        ),
      ),
    ],
  };
};

/** 帰ってきたものを、本人にDMで知らせる。サーバーを抜けた人には送らない */
export const notifyReturnedSubmarines = async (client: Client<true>, now: Date = new Date()): Promise<void> => {
  const groups = new Map<string, SubmarineTimer[]>();
  for (const timer of await claimReturnedSubmarines(now)) {
    const key = `${timer.guildId}:${timer.userId}`;
    groups.set(key, [...(groups.get(key) ?? []), timer]);
  }
  for (const timers of groups.values()) {
    const [{ guildId, userId }] = timers as [SubmarineTimer, ...SubmarineTimer[]];
    const guild = client.guilds.cache.get(guildId);
    const member = guild ? await guild.members.fetch(userId).catch(() => null) : null;
    if (!guild || !member) continue;
    await member.send(returnedMessage(guild.name, timers, now)).catch((error: unknown) => {
      console.warn(`潜水艦の帰還を「${member.user.tag}」にDMで送れませんでした:`, error);
    });
  }
};

/** 起動時と、そのあと1分ごとに、帰ってきたものを知らせる（Botが止まっていた間の分も） */
export const startSubmarineNotices = (client: Client<true>): void => {
  const run = () => {
    notifyReturnedSubmarines(client).catch((error: unknown) => {
      reportError('潜水艦の帰還を知らせられませんでした', error);
    });
  };
  run();
  setInterval(run, TICK_MS).unref();
};
