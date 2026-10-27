import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  DiscordAPIError,
  EmbedBuilder,
  MessageFlags,
  RESTJSONErrorCodes,
  ThreadAutoArchiveDuration,
  time,
  userMention,
  type APIEmbedField,
  type Client,
  type Guild,
  type GuildTextBasedChannel,
  type Message,
  type ThreadChannel,
} from 'discord.js';
import { reportError } from './errorReporter.js';
import { createLock } from './locks.js';
import { nameById } from './names.js';
import { filledCount, isFull, type RecruitConfig } from './recruitEngine.js';
import { ROLE_EMOJIS, findPartyType, jobLabel, type PartyType } from './recruitParty.js';
import {
  deleteRecruitList,
  findRecruit,
  findRecruitList,
  listActiveRecruits,
  listRecruitsToFinish,
  listRecruitsToRemind,
  saveRecruit,
  type Recruit,
  type RecruitStatus,
} from './recruitStore.js';

// 募集の投稿（埋め込みとボタン）・連絡用スレッド・募集一覧と、開始前のお知らせ・終わった募集の片付け

export const RECRUIT_PREFIX = 'recruit:';
/** 開始のこの時間前に、参加者へお知らせする */
export const REMIND_BEFORE_MS = 10 * 60_000;
/** 開始からこの時間たったら、募集を終了にする */
const FINISH_AFTER_MS = 3 * 60 * 60_000;
const TICK_MS = 60_000;
/** 募集一覧の書き換えをまとめる時間（続けて変わったときに何度も書き換えないように） */
const LIST_REFRESH_DELAY_MS = 3_000;
const MAX_FIELD_LENGTH = 1024;
const MAX_COMMENT_IN_POST = 40;

/** 同じ募集の操作（参加・取り消し・主催の変更・お知らせ）を1つずつ順番に行う */
export const withRecruitLock = createLock();

/** customId は「recruit:<場面>:<操作>[:<値>…]」の形 */
export const recruitCustomId = (scope: string, action: string, ...args: string[]): string =>
  [`${RECRUIT_PREFIX}${scope}`, action, ...args].join(':');

/** 募集の形。見つからない（古い形など）ときは、人数だけの募集として扱う */
export const partyOf = (party: string, config: RecruitConfig): PartyType =>
  findPartyType(party) ?? {
    value: party,
    label: '',
    slots: config.slots.map((slot) => ({ key: slot.key, role: 'any' })),
    hasRoles: false,
  };

/** 割り振られている人（補欠を除く） */
export const placedIds = (config: RecruitConfig): string[] => config.participants.filter((p) => p.slot).map((p) => p.userId);
/** 参加している人全員（補欠も含む） */
export const participantIds = (config: RecruitConfig): string[] => config.participants.map((p) => p.userId);

/** 投稿に出す中身（投稿前のプレビューにも使う） */
export interface RecruitView extends RecruitConfig {
  id: string | null;
  title: string;
  comment: string;
  startsAt: Date | null;
  party: string;
  dataCenter: string | null;
  hostId: string;
  status: RecruitStatus;
}

const LOOKS = {
  open: { prefix: '', color: 0x57f287 },
  full: { prefix: '【満員】', color: 0x5865f2 },
  closed: { prefix: '【締切】', color: 0x99aab5 },
  cancelled: { prefix: '【中止】', color: 0xed4245 },
  finished: { prefix: '【終了】', color: 0x4f545c },
} as const;

export const buildRecruitEmbed = (guild: Guild, view: RecruitView): EmbedBuilder => {
  const look = LOOKS[view.status === 'open' && isFull(view) ? 'full' : view.status];
  return new EmbedBuilder()
    .setColor(look.color)
    .setAuthor({ name: '📣 パーティ募集' })
    .setTitle(`${look.prefix}${view.title}`)
    .setDescription(view.comment ? `>>> ${view.comment}` : null)
    .addFields(
      { name: '🕘 開始', value: view.startsAt ? `${time(view.startsAt, 'F')}（${time(view.startsAt, 'R')}）` : '未定' },
      { name: '👑 主催', value: nameById(guild, view.hostId), inline: true },
      { name: '👥 人数', value: `${filledCount(view)} / ${view.slots.length}人`, inline: true },
      ...(view.dataCenter ? [{ name: '🌍 DC', value: view.dataCenter, inline: true }] : []),
      { name: '📋 ルール', value: view.allowDuplicateJobs ? 'ジョブ重複あり' : 'ジョブ重複なし', inline: true },
      ...memberFields(guild, view),
    )
    .setFooter({ text: view.id ? `募集ID: ${view.id}` : 'プレビュー（まだ投稿していません）' });
};

/** 枠の一覧。長いときは項目を分ける（1項目1024文字まで） */
const memberFields = (guild: Guild, view: RecruitView): APIEmbedField[] => {
  const lines = [...memberLines(guild, view), ...waitlistLines(guild, view)];
  const fields: APIEmbedField[] = [];
  let current: string[] = [];
  for (const line of lines) {
    if ([...current, line].join('\n').length > MAX_FIELD_LENGTH) {
      fields.push({ name: fields.length === 0 ? 'メンバー' : 'メンバー（続き）', value: current.join('\n') });
      current = [];
    }
    current.push(line);
  }
  if (current.length > 0) fields.push({ name: fields.length === 0 ? 'メンバー' : 'メンバー（続き）', value: current.join('\n') });
  return fields;
};

const memberLines = (guild: Guild, view: RecruitView): string[] => {
  const party = partyOf(view.party, view);
  const personNote = (p: { userId: string; job: string | null; positions: string[]; comment: string | null }) =>
    `${p.userId === view.hostId ? '👑 ' : ''}${nameById(guild, p.userId)}（${jobLabel(p.job)}）` +
    (party.hasRoles && p.positions.length > 1 ? ` FLEX: ${p.positions.join('/')}` : '') +
    (p.comment ? ` 💬 ${clip(p.comment, MAX_COMMENT_IN_POST)}` : '');

  if (party.hasRoles) {
    return view.slots.map((slot) => {
      const head = `${ROLE_EMOJIS[slot.role]} **${slot.key}**`;
      if (slot.external) return `${head} 🧑‍🤝‍🧑 ${slot.external.name || '外部の人'}（${jobLabel(slot.external.job)}）`;
      if (slot.closed) return `${head} 🔒 〆 ゲーム内募集（${slot.closed.job ? jobLabel(slot.closed.job) : 'ジョブ不明'}）`;
      const person = view.participants.find((p) => p.slot === slot.key);
      if (person) return `${head} ${personNote(person)}`;
      return `${head} ー 空き${slot.requiredJob ? `（${jobLabel(slot.requiredJob)}指定）` : ''}`;
    });
  }
  const lines = [
    ...view.participants.filter((p) => p.slot).map((p) => `${ROLE_EMOJIS.any} ${personNote(p)}`),
    ...view.slots.flatMap((slot) =>
      slot.external
        ? [`${ROLE_EMOJIS.any} 🧑‍🤝‍🧑 ${slot.external.name || '外部の人'}（${jobLabel(slot.external.job)}）`]
        : slot.closed
          ? [`${ROLE_EMOJIS.any} 🔒 〆 ゲーム内募集（${slot.closed.job ? jobLabel(slot.closed.job) : 'ジョブ不明'}）`]
          : [],
    ),
  ];
  const open = view.slots.length - filledCount(view);
  return [...lines, ...(open > 0 ? [`ー あと${open}人`] : [])];
};

const waitlistLines = (guild: Guild, view: RecruitView): string[] => {
  const waiting = view.participants.filter((p) => !p.slot);
  return waiting.length > 0 ? [`⏳ 補欠: ${waiting.map((p) => nameById(guild, p.userId)).join(' ')}（枠が空くと自動で入ります）`] : [];
};

/** 投稿のボタン。終わった募集はボタンを消す */
export const buildRecruitComponents = (recruit: Recruit): ActionRowBuilder<ButtonBuilder>[] => {
  const button = (action: string, label: string, emoji: string, style: ButtonStyle) =>
    new ButtonBuilder().setCustomId(recruitCustomId('p', action, recruit.id)).setLabel(label).setEmoji({ name: emoji }).setStyle(style);
  const buttons = [
    ...(recruit.status === 'open' ? [button('join', '参加する', '✋', ButtonStyle.Success)] : []),
    ...(recruit.status === 'open' || recruit.status === 'closed'
      ? [button('menu', '参加メニュー', '📋', ButtonStyle.Secondary), button('host', '主催メニュー', '⚙️', ButtonStyle.Secondary)]
      : []),
  ];
  return buttons.length > 0 ? [new ActionRowBuilder<ButtonBuilder>().addComponents(buttons)] : [];
};

export const buildRecruitPost = (guild: Guild, recruit: Recruit) => ({
  embeds: [buildRecruitEmbed(guild, recruit)],
  components: buildRecruitComponents(recruit),
});

const recruitChannel = (guild: Guild, recruit: Recruit): GuildTextBasedChannel | undefined => {
  const channel = guild.channels.cache.get(recruit.channelId);
  return channel?.isTextBased() ? channel : undefined;
};

/** 投稿を今の内容に書き換え、募集一覧も書き換える（投稿が消されていたら何もしない） */
export const refreshRecruitPost = async (guild: Guild, recruit: Recruit): Promise<void> => {
  scheduleRecruitListRefresh(guild);
  const channel = recruitChannel(guild, recruit);
  if (!channel || !recruit.messageId) return;
  await channel.messages.edit(recruit.messageId, buildRecruitPost(guild, recruit)).catch((error: unknown) => {
    console.error(`募集（ID: ${recruit.id}）の投稿を更新できませんでした:`, error);
  });
};

// ---- 連絡用スレッド

/** 投稿に参加者の連絡用スレッドを作る（作れなければ null） */
export const createRecruitThread = async (post: Message, recruit: Recruit): Promise<ThreadChannel | null> => {
  try {
    const thread = await post.startThread({
      name: clip(recruit.title, 90),
      autoArchiveDuration: ThreadAutoArchiveDuration.OneDay,
      reason: 'パーティ募集の連絡用',
    });
    await thread.send({
      content: `📣 「${recruit.title}」の連絡用スレッドです。参加した人はここに追加され、開始前のお知らせもここに届きます。`,
      flags: MessageFlags.SuppressNotifications,
    });
    for (const userId of new Set([recruit.hostId, ...participantIds(recruit)])) await thread.members.add(userId).catch(() => undefined);
    return thread;
  } catch (error) {
    console.error(`募集（ID: ${recruit.id}）のスレッドを作れませんでした:`, error);
    return null;
  }
};

const recruitThread = async (guild: Guild, recruit: Recruit): Promise<ThreadChannel | null> => {
  if (!recruit.threadId) return null;
  const cached = guild.channels.cache.get(recruit.threadId);
  const channel = cached ?? (await guild.channels.fetch(recruit.threadId).catch(() => null));
  return channel?.isThread() ? channel : null;
};

/** スレッドに一言（通知なし）。参加した人をスレッドに入れたいときは addUserIds を渡す */
export const threadNote = async (guild: Guild, recruit: Recruit, text: string, addUserIds: string[] = []): Promise<void> => {
  const thread = await recruitThread(guild, recruit);
  if (!thread) return;
  try {
    if (thread.archived) await thread.setArchived(false);
    for (const userId of addUserIds) await thread.members.add(userId).catch(() => undefined);
    await thread.send({ content: text, flags: MessageFlags.SuppressNotifications, allowedMentions: { parse: [] } });
  } catch (error) {
    console.error(`募集（ID: ${recruit.id}）のスレッドに書き込めませんでした:`, error);
  }
};

/** 終わった募集のスレッドを閉じる */
export const archiveRecruitThread = async (guild: Guild, recruit: Recruit): Promise<void> => {
  const thread = await recruitThread(guild, recruit);
  await thread?.setArchived(true).catch(() => undefined);
};

/** 参加者にメンションで知らせる。スレッドがあればスレッドに、なければ募集の投稿への返信にする */
export const notifyParticipants = async (
  guild: Guild,
  recruit: Recruit,
  text: string,
  userIds: string[] = participantIds(recruit),
): Promise<void> => {
  if (userIds.length === 0) return;
  const content = [text, userIds.map(userMention).join(' ')].join('\n');
  const thread = await recruitThread(guild, recruit);
  try {
    if (thread) {
      if (thread.archived) await thread.setArchived(false);
      await thread.send({ content, allowedMentions: { users: userIds } });
      return;
    }
    const channel = recruitChannel(guild, recruit);
    await channel?.send({
      content,
      ...(recruit.messageId ? { reply: { messageReference: recruit.messageId, failIfNotExists: false } } : {}),
      allowedMentions: { users: userIds, repliedUser: false },
    });
  } catch (error) {
    console.error(`募集（ID: ${recruit.id}）のお知らせを送れませんでした:`, error);
  }
};

// ---- 募集一覧

const listTimers = new Map<string, NodeJS.Timeout>();

/** 少し待ってから募集一覧を書き換える（続けて変わったときは1回にまとめる） */
export const scheduleRecruitListRefresh = (guild: Guild): void => {
  const pending = listTimers.get(guild.id);
  if (pending) clearTimeout(pending);
  listTimers.set(
    guild.id,
    setTimeout(() => {
      listTimers.delete(guild.id);
      refreshRecruitList(guild).catch((error: unknown) => {
        console.error(`「${guild.name}」の募集一覧を更新できませんでした:`, error);
      });
    }, LIST_REFRESH_DELAY_MS).unref(),
  );
};

export const buildRecruitListEmbed = (guild: Guild, recruits: Recruit[]): EmbedBuilder => {
  const lines = recruits.slice(0, 20).map((recruit) => {
    const full = isFull(recruit);
    const mark = recruit.status === 'closed' ? '⚪' : full ? '🔵' : '🟢';
    const state = recruit.status === 'closed' ? '・締切' : full ? '・満員' : '';
    const link = recruit.messageId ? `https://discord.com/channels/${guild.id}/${recruit.channelId}/${recruit.messageId}` : null;
    const title = link ? `[${recruit.title}](${link})` : recruit.title;
    return [
      `${mark} **${title}**`,
      `　🕘 ${time(recruit.startsAt, 'f')}（${time(recruit.startsAt, 'R')}）・👥 ${filledCount(recruit)}/${recruit.slots.length}人` +
        `${recruit.dataCenter ? `・🌍 ${recruit.dataCenter}` : ''}${state}・👑 ${nameById(guild, recruit.hostId)}`,
    ].join('\n');
  });
  return new EmbedBuilder()
    .setColor(0x57f287)
    .setTitle('📋 募集中のパーティ')
    .setDescription(
      lines.length > 0
        ? [...lines, ...(recruits.length > 20 ? [`ほか ${recruits.length - 20}件`] : [])].join('\n')
        : 'いまは募集はありません。',
    )
    .setFooter({ text: '🟢 募集中 / 🔵 満員 / ⚪ 締切。募集が変わると自動で書き換わります' })
    .setTimestamp();
};

/** 募集一覧のメッセージを今の内容に書き換える。消されていたら、もう使わない */
export const refreshRecruitList = async (guild: Guild): Promise<void> => {
  const list = await findRecruitList(guild.id);
  if (!list) return;
  const channel = guild.channels.cache.get(list.channelId);
  if (!channel?.isTextBased()) {
    await deleteRecruitList(guild.id);
    return;
  }
  const recruits = await listActiveRecruits(guild.id);
  await channel.messages.edit(list.messageId, { embeds: [buildRecruitListEmbed(guild, recruits)] }).catch(async (error: unknown) => {
    if (error instanceof DiscordAPIError && error.code === RESTJSONErrorCodes.UnknownMessage) {
      await deleteRecruitList(guild.id);
    } else {
      console.error(`「${guild.name}」の募集一覧を書き換えられませんでした:`, error);
    }
  });
};

// ---- 予定（開始前のお知らせ・終わった募集の片付け）

/** 1分ごとに、開始が近い募集のお知らせと、終わった募集の片付けをする */
export const startRecruitScheduler = (client: Client<true>): void => {
  setInterval(() => {
    runRecruitSchedule(client).catch((error: unknown) => {
      reportError('募集の予定の処理に失敗しました', error);
    });
  }, TICK_MS).unref();
};

export const runRecruitSchedule = async (client: Client<true>, now: Date = new Date()): Promise<void> => {
  for (const { id } of await listRecruitsToRemind(new Date(now.getTime() + REMIND_BEFORE_MS))) {
    await withRecruitLock(id, async () => {
      const recruit = await findRecruit(id);
      if (!recruit || recruit.reminded || (recruit.status !== 'open' && recruit.status !== 'closed')) return;
      recruit.reminded = true;
      await saveRecruit(recruit);
      // Botが止まっていた間に始まった募集は、今さら知らせない
      const guild = client.guilds.cache.get(recruit.guildId);
      if (guild && recruit.startsAt.getTime() > now.getTime() - REMIND_BEFORE_MS) {
        const missing = recruit.slots.length - filledCount(recruit);
        await notifyParticipants(
          guild,
          recruit,
          `⏰ **${recruit.title}** がまもなく始まります（${time(recruit.startsAt, 'R')}）${missing > 0 ? `。まだ ${missing}人 空いています` : ''}`,
          [...new Set([recruit.hostId, ...placedIds(recruit)])],
        );
      }
    });
  }

  for (const { id } of await listRecruitsToFinish(new Date(now.getTime() - FINISH_AFTER_MS))) {
    await withRecruitLock(id, async () => {
      const recruit = await findRecruit(id);
      if (!recruit || (recruit.status !== 'open' && recruit.status !== 'closed')) return;
      recruit.status = 'finished';
      await saveRecruit(recruit);
      const guild = client.guilds.cache.get(recruit.guildId);
      if (!guild) return;
      await refreshRecruitPost(guild, recruit);
      await archiveRecruitThread(guild, recruit);
    });
  }
};

/** 起動時に、続いている募集の投稿と募集一覧を今の形に書き換える（Botを更新して見た目が変わったときのため） */
export const refreshActiveRecruits = async (client: Client<true>): Promise<void> => {
  for (const recruit of await listActiveRecruits()) {
    const guild = client.guilds.cache.get(recruit.guildId);
    if (guild) await refreshRecruitPost(guild, recruit);
  }
};

export const clip = (text: string, max: number): string => (text.length > max ? `${text.slice(0, max - 1)}…` : text);
