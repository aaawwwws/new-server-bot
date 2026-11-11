import { createHash } from 'node:crypto';
import {
  AttachmentBuilder,
  DiscordAPIError,
  EmbedBuilder,
  MessageFlags,
  PermissionFlagsBits,
  RESTJSONErrorCodes,
  type Client,
  type Guild,
  type GuildMember,
  type GuildTextBasedChannel,
  type Message,
} from 'discord.js';
import { sendLog } from './activityLog.js';
import { pool } from './db.js';
import { reportError } from './errorReporter.js';
import { fetchAllMembers } from './guildUtils.js';
import { createLock } from './locks.js';
import { addDays, addMonths, formatDay, formatMonth, jstDay, monthStart, weekStart } from './jst.js';
import { boldName } from './names.js';
import { renderPodium, type PodiumEntry, type PodiumTheme } from './rankingImage.js';
import { computeRanking, formatScore, rankXpBetween, rankingLine, type RankingEntry } from './rankings.js';
import { hasResults, recordResults, type ResultPeriod } from './rankingStore.js';
import { boardButtons } from './rankingView.js';
import { activeBoost, describeBoost, formatPercent } from './xpBoost.js';

// 経験値ランキングの掲示板（今日・今週・今月を自動で更新）と、毎週月曜0時・毎月1日0時の結果の投稿。
// 結果（上位の人）は、掲示板がなくても歴代記録として残す

export const WEEKLY_TOP_ROLE_NAME = '週間ランキング上位';
/** 先週の何位までにロールを付けるか */
export const WEEKLY_ROLE_COUNT = 3;
export const MONTHLY_TOP_ROLE_NAME = '月間MVP';
/** 先月の何位までにロールを付けるか */
export const MONTHLY_ROLE_COUNT = 1;
const TOP_COUNT = 10;
/** 表彰台の画像に出す人数（ここから下は文字で出す） */
const PODIUM_COUNT = 3;
const PODIUM_FILE_NAME = 'ranking.png';
/** 歴代記録として残す人数 */
const RESULT_COUNT = 10;
const BOARD_REFRESH_MS = 5 * 60_000;
const TICK_MS = 60_000;
const COLOR = 0xf1c40f;

/** 週と月の結果の違い（期間の長さ・ロール・見出し） */
const RESULT_TYPES = {
  week: {
    roleName: WEEKLY_TOP_ROLE_NAME,
    roleCount: WEEKLY_ROLE_COUNT,
    roleColor: COLOR,
    title: '🏆 先週の経験値ランキング',
    /** 表彰台の画像の見出しと色 */
    imageTitle: '先週の経験値ランキング',
    theme: 'gold',
    end: (start: string) => addDays(start, 7),
    describe: (start: string) => `${formatDay(start)}〜${formatDay(addDays(start, 6))}`,
    name: '先週',
  },
  month: {
    roleName: MONTHLY_TOP_ROLE_NAME,
    roleCount: MONTHLY_ROLE_COUNT,
    roleColor: 0xe67e22,
    title: '🌟 先月の経験値ランキング',
    imageTitle: '先月の経験値ランキング',
    theme: 'purple',
    end: (start: string) => addMonths(start, 1),
    describe: (start: string) => formatMonth(start),
    name: '先月',
  },
} as const satisfies Record<ResultPeriod, { theme: PodiumTheme } & Record<string, unknown>>;

export interface RankingBoard {
  guildId: string;
  channelId: string;
  messageId: string;
  /** どの週（その週の月曜）の結果まで投稿したか */
  lastWeeklyPost: string | null;
  /** どの月（1日）の結果まで投稿したか */
  lastMonthlyPost: string | null;
}

interface BoardRow {
  guild_id: string;
  channel_id: string;
  message_id: string;
  last_weekly_post: string | null;
  last_monthly_post: string | null;
}

const toBoard = (row: BoardRow): RankingBoard => ({
  guildId: row.guild_id,
  channelId: row.channel_id,
  messageId: row.message_id,
  lastWeeklyPost: row.last_weekly_post,
  lastMonthlyPost: row.last_monthly_post,
});

const BOARD_COLUMNS = 'guild_id, channel_id, message_id, last_weekly_post::text AS last_weekly_post, last_monthly_post::text AS last_monthly_post';

/**
 * 掲示板の場所（サーバーのID → 掲示板）。発言のたびにDBを読まないよう、Botの中でも覚えておく
 * （掲示板のチャンネルに書かれたら、掲示板を一番下に置き直すため）
 */
const knownBoards = new Map<string, RankingBoard>();

export const findBoard = async (guildId: string): Promise<RankingBoard | null> => {
  const { rows } = await pool.query<BoardRow>(`SELECT ${BOARD_COLUMNS} FROM ranking_boards WHERE guild_id = $1`, [guildId]);
  const [row] = rows;
  return row ? toBoard(row) : null;
};

const listBoards = async (): Promise<RankingBoard[]> => {
  const { rows } = await pool.query<BoardRow>(`SELECT ${BOARD_COLUMNS} FROM ranking_boards`);
  const boards = rows.map(toBoard);
  knownBoards.clear();
  for (const board of boards) knownBoards.set(board.guildId, board);
  return boards;
};

export const saveBoard = async (board: RankingBoard): Promise<void> => {
  await pool.query(
    `INSERT INTO ranking_boards (guild_id, channel_id, message_id, last_weekly_post, last_monthly_post) VALUES ($1, $2, $3, $4::date, $5::date)
     ON CONFLICT (guild_id) DO UPDATE
       SET channel_id = EXCLUDED.channel_id, message_id = EXCLUDED.message_id,
           last_weekly_post = EXCLUDED.last_weekly_post, last_monthly_post = EXCLUDED.last_monthly_post`,
    [board.guildId, board.channelId, board.messageId, board.lastWeeklyPost, board.lastMonthlyPost],
  );
  knownBoards.set(board.guildId, { ...board });
};

const deleteBoard = async (guildId: string): Promise<void> => {
  await pool.query('DELETE FROM ranking_boards WHERE guild_id = $1', [guildId]);
  knownBoards.delete(guildId);
};

/**
 * 掲示板の書き換え・置き直し・設置を、サーバーごとに1つずつ行う
 * （置き直しで掲示板のメッセージが変わった直後に、前のメッセージを書き換えようとして「消された」と取り違えないように）
 */
const boardLock = createLock();

/** 上位 count 人の行（XPの、終わった期間か、今日・今週・今月） */
const rankingLines = (entries: RankingEntry[], period: 'day' | 'week' | 'month', count: number, empty: string): string =>
  entries.length === 0 ? empty : entries.slice(0, count).map((entry, i) => rankingLine({ kind: 'xp', period }, entry, i)).join('\n');

/** 表彰台に出す、昨日からの変化（上がったら ▲2、下がったら ▼1、昨日はいなかった人は NEW） */
const podiumChange = (change: RankingEntry['change']): string | null => {
  if (change === null || change === 0) return null;
  if (change === 'new') return 'NEW';
  return change > 0 ? `▲${change}` : `▼${-change}`;
};

/** 表彰台の画像に出す上位の人 */
const podiumEntries = (entries: RankingEntry[], period: 'day' | 'week' | 'month'): PodiumEntry[] =>
  entries.slice(0, PODIUM_COUNT).map((entry) => ({
    name: entry.member.displayName,
    avatarUrl: entry.member.displayAvatarURL({ extension: 'png', size: 256, forceStatic: true }),
    value: formatScore('xp', period, entry),
    change: podiumChange(entry.change),
  }));

/** 表彰台の画像と、それを使う埋め込みの組 */
const podiumFile = (image: Buffer): AttachmentBuilder => new AttachmentBuilder(image, { name: PODIUM_FILE_NAME });

interface BoardData {
  today: string;
  thisWeek: string;
  thisMonth: string;
  lastWeek: string;
  lastMonth: string;
  daily: RankingEntry[];
  weekly: RankingEntry[];
  monthly: RankingEntry[];
  previousWeek: RankingEntry[];
  previousMonth: RankingEntry[];
  /** XPアップの一言（開催中・次の予定） */
  boost: string | null;
  /** 画像の右上に出す、開催中のXPアップ */
  boostBadge: string | null;
}

/** 掲示板に出すランキング。日付が変われば「今日」、月曜になれば「今週」、1日になれば「今月」が自動で切り替わる */
const loadBoardData = async (guild: Guild, now: Date): Promise<BoardData> => {
  const today = jstDay(now);
  const thisWeek = weekStart(today);
  const lastWeek = addDays(thisWeek, -7);
  const thisMonth = monthStart(today);
  const lastMonth = addMonths(thisMonth, -1);
  const [daily, weekly, monthly, previousWeek, previousMonth] = await Promise.all([
    computeRanking(guild, 'xp', 'day', now),
    computeRanking(guild, 'xp', 'week', now),
    computeRanking(guild, 'xp', 'month', now),
    rankXpBetween(guild, lastWeek, thisWeek),
    rankXpBetween(guild, lastMonth, thisMonth),
  ]);
  const active = activeBoost(guild.id, now);
  return {
    today,
    thisWeek,
    thisMonth,
    lastWeek,
    lastMonth,
    daily: daily.entries,
    weekly: weekly.entries,
    monthly: monthly.entries,
    previousWeek,
    previousMonth,
    boost: describeBoost(guild.id, now),
    boostBadge: active ? `XP ${formatPercent(active.percent)} 開催中` : null,
  };
};

/** 掲示板の表彰台（今週の上位3人） */
const boardPodium = (data: BoardData) => ({
  title: '今週の経験値ランキング',
  subtitle: `${formatDay(data.thisWeek)}〜 ・ 上位${PODIUM_COUNT}人`,
  badge: data.boostBadge,
  theme: 'gold' as const,
  entries: podiumEntries(data.weekly, 'week'),
});

/**
 * 掲示板の埋め込み。1つ目に表彰台の画像（今週の上位3人）、2つ目に文字のランキング。
 * withImage が false（画像を作れなかった）なら、今週も1位から文字で出す
 */
const boardEmbeds = (data: BoardData, withImage: boolean): EmbedBuilder[] => {
  const header = new EmbedBuilder()
    .setColor(COLOR)
    .setTitle('🏆 経験値ランキング')
    .setDescription(
      [
        '発言とVCで貯まった経験値のランキングです（5分ごとに更新・⬆⬇🆕 は昨日からの変化）。',
        '下のボタンで、自分の順位やほかのランキング（発言数・VC・連続日数・PT募集）を見られます。',
        ...(data.boost ? ['', data.boost] : []),
      ].join('\n'),
    );
  if (withImage) header.setImage(`attachment://${PODIUM_FILE_NAME}`);
  const rest = data.weekly.slice(PODIUM_COUNT, TOP_COUNT);
  const weekField = withImage
    ? {
        name: `🗓️ 今週 ${PODIUM_COUNT + 1}〜${TOP_COUNT}位`,
        value: rest.length > 0 ? rest.map((entry, i) => rankingLine({ kind: 'xp', period: 'week' }, entry, PODIUM_COUNT + i)).join('\n') : 'まだいません',
        inline: true,
      }
    : { name: `🗓️ 今週 ${formatDay(data.thisWeek)}〜`, value: rankingLines(data.weekly, 'week', TOP_COUNT, 'まだ記録がありません'), inline: true };
  const lists = new EmbedBuilder()
    .setColor(COLOR)
    .addFields(
      { name: `📅 今日 ${formatDay(data.today)}`, value: rankingLines(data.daily, 'day', TOP_COUNT, 'まだ記録がありません'), inline: true },
      weekField,
      { name: `🌙 今月 ${formatMonth(data.thisMonth)}`, value: rankingLines(data.monthly, 'month', TOP_COUNT, 'まだ記録がありません'), inline: true },
      {
        name: `👑 先週の上位 ${formatDay(data.lastWeek)}〜${formatDay(addDays(data.thisWeek, -1))}`,
        value: rankingLines(data.previousWeek, 'week', WEEKLY_ROLE_COUNT, '記録がありません'),
        inline: true,
      },
      {
        name: `🌟 先月のMVP ${formatMonth(data.lastMonth)}`,
        value: rankingLines(data.previousMonth, 'month', MONTHLY_ROLE_COUNT, '記録がありません'),
        inline: true,
      },
    )
    .setFooter({
      text: `毎週月曜0時に先週の結果を投稿して1〜${WEEKLY_ROLE_COUNT}位に「${WEEKLY_TOP_ROLE_NAME}」、毎月1日0時に先月の結果を投稿して1位に「${MONTHLY_TOP_ROLE_NAME}」ロールを付けます`,
    });
  return [header, lists];
};

/** 掲示板のメッセージの中身（画像を作れなければ文字だけ） */
const renderBoard = async (data: BoardData, now: Date): Promise<{ embeds: EmbedBuilder[]; files: AttachmentBuilder[] }> => {
  const image = await renderPodium(boardPodium(data));
  const embeds = boardEmbeds(data, image !== null);
  embeds.at(-1)?.setTimestamp(now);
  return { embeds, files: image ? [podiumFile(image)] : [] };
};

/** 中身が変わったかを見るための値。画像を描く前に比べて、変わっていなければ描かない */
const boardHash = (data: BoardData): string =>
  createHash('sha256')
    .update(JSON.stringify({ embeds: boardEmbeds(data, true).map((embed) => embed.toJSON()), podium: boardPodium(data) }))
    .digest('hex');

/** 前回から中身が変わったときだけ書き換える（掲示板ごとの、前回の中身） */
const lastBoardHash = new Map<string, string>();
const lastBoardRefresh = new Map<string, number>();

/** 掲示板を今の内容に書き換える。消されていたら、掲示板はもう使わない（false） */
export const refreshBoard = async (guild: Guild, channel: GuildTextBasedChannel, board: RankingBoard, now: Date = new Date()): Promise<boolean> => {
  const data = await loadBoardData(guild, now);
  const hash = boardHash(data);
  if (lastBoardHash.get(board.messageId) === hash) return true;
  try {
    const { embeds, files } = await renderBoard(data, now);
    // 前の画像は外して、新しい画像に差し替える
    await channel.messages.edit(board.messageId, { embeds, components: [boardButtons()], files, attachments: [] });
    lastBoardHash.set(board.messageId, hash);
    return true;
  } catch (error) {
    if (isUnknownMessage(error)) return false;
    reportError(`「${guild.name}」のランキング掲示板を更新できませんでした`, error, guild);
    return true;
  }
};

const isUnknownMessage = (error: unknown): boolean => error instanceof DiscordAPIError && error.code === RESTJSONErrorCodes.UnknownMessage;

/**
 * 掲示板をチャンネルの一番下に出し直す（新しいものを出してから前のものを消す。出せなかったときに、掲示板がなくならないように）。
 * 前の掲示板が消されていたら（管理者が消した）、出し直さずに掲示板をやめる
 */
const repostBoard = async (guild: Guild, channel: GuildTextBasedChannel, board: RankingBoard, now: Date): Promise<void> => {
  const exists = await channel.messages.fetch(board.messageId).then(
    () => true,
    (error: unknown) => {
      if (isUnknownMessage(error)) return false;
      throw error;
    },
  );
  if (!exists) {
    await deleteBoard(guild.id);
    return;
  }
  const data = await loadBoardData(guild, now);
  const { embeds, files } = await renderBoard(data, now);
  const message = await channel.send({ embeds, files, components: [boardButtons()], flags: MessageFlags.SuppressNotifications });
  await saveBoard({ ...board, messageId: message.id });
  lastBoardHash.delete(board.messageId);
  lastBoardHash.set(message.id, boardHash(data));
  lastBoardRefresh.set(guild.id, now.getTime());
  await channel.messages.delete(board.messageId).catch(() => undefined);
};

/** 掲示板のチャンネルに何か書かれたら、この時間静かになってから掲示板を一番下に置き直す（話している途中で動くと読みにくいので） */
const BUMP_AFTER_MS = 10_000;
const bumpTimers = new Map<string, NodeJS.Timeout>();

/** 掲示板のチャンネルの発言（人の発言も、結果の投稿などのBotのメッセージも） */
export const handleRankingChannelMessage = (message: Message): void => {
  if (!message.inGuild()) return;
  const known = knownBoards.get(message.guildId);
  if (!known || known.channelId !== message.channelId || message.id === known.messageId) return;
  const { guild } = message;
  clearTimeout(bumpTimers.get(guild.id));
  const timer = setTimeout(() => {
    bumpTimers.delete(guild.id);
    boardLock(guild.id, async () => {
      // 待っている間に置き直した・設置し直したかもしれないので、今の掲示板を読み直す
      const board = await findBoard(guild.id);
      const channel = board ? guild.channels.cache.get(board.channelId) : undefined;
      if (!board || !channel?.isTextBased() || channel.lastMessageId === board.messageId) return;
      await repostBoard(guild, channel, board, new Date());
    }).catch((error: unknown) => {
      reportError(`「${guild.name}」のランキング掲示板を一番下に置き直せませんでした`, error, guild);
    });
  }, BUMP_AFTER_MS);
  timer.unref();
  bumpTimers.set(guild.id, timer);
};

/** 先週・先月の結果を投稿し、上位の人にロールを付け替える */
const postResult = async (guild: Guild, channel: GuildTextBasedChannel, period: ResultPeriod, start: string): Promise<void> => {
  const type = RESULT_TYPES[period];
  const entries = await rankXpBetween(guild, start, type.end(start));
  const winners = entries.slice(0, type.roleCount).map((entry) => entry.member);
  const roleNote = await giveTopRole(guild, period, winners);
  // 上位3人の表彰台の画像（作れなければ文字だけ）
  const image =
    entries.length > 0
      ? await renderPodium({ title: type.imageTitle, subtitle: type.describe(start), badge: null, theme: type.theme, entries: podiumEntries(entries, period) })
      : null;
  const embed = new EmbedBuilder()
    .setColor(COLOR)
    .setTitle(type.title)
    .setDescription([type.describe(start), '', rankingLines(entries, period, TOP_COUNT, `${type.name}は記録がありませんでした。`)].join('\n'))
    .addFields({ name: `🎖️ 「${type.roleName}」ロール`, value: roleNote });
  if (image) embed.setImage(`attachment://${PODIUM_FILE_NAME}`);
  await channel.send({ embeds: [embed], files: image ? [podiumFile(image)] : [], allowedMentions: { parse: [] } });
  void sendLog(guild, 'system', `${type.name}（${type.describe(start)}）の経験値ランキングを投稿しました`, undefined, {
    channel,
    fields: [{ name: `🎖️ 「${type.roleName}」ロール`, value: roleNote }],
  });
};

/** 上位の人にロールを付け、それ以外で付いている人からは外す。結果の説明を返す */
const giveTopRole = async (guild: Guild, period: ResultPeriod, winners: GuildMember[]): Promise<string> => {
  const { roleName, roleColor, name } = RESULT_TYPES[period];
  const me = guild.members.me;
  if (!me?.permissions.has(PermissionFlagsBits.ManageRoles)) return '⚠ Botにロールの管理権限がないため、付けられませんでした。';
  try {
    const role =
      guild.roles.cache.find((r) => r.name === roleName) ??
      (await guild.roles.create({
        name: roleName,
        colors: { primaryColor: roleColor },
        permissions: [],
        reason: `${name}の経験値ランキングの上位の人のロール`,
      }));
    if (!role.editable) return `⚠ Botのロールが「${role.name}」より下にあるため、付けられませんでした。`;

    const winnerIds = new Set(winners.map((member) => member.id));
    const members = await fetchAllMembers(guild);
    for (const member of members.values()) {
      if (member.roles.cache.has(role.id) && !winnerIds.has(member.id)) await member.roles.remove(role, `${name}の経験値ランキングの付け替え`);
    }
    for (const member of winners) {
      if (!member.roles.cache.has(role.id)) await member.roles.add(role, `${name}の経験値ランキング上位`);
    }
    return winners.length > 0
      ? `${winners.map(boldName).join(' ')} に付けました（前に付いていた人からは外しました）。`
      : `${name}は記録がなかったので、誰にも付けていません。`;
  } catch (error) {
    console.error(`「${guild.name}」の「${roleName}」ロールを付け替えられませんでした:`, error);
    return '⚠ ロールの付け替えに失敗しました。';
  }
};

/** 歴代記録として残し終えた期間（毎分DBに聞かないため） */
const recordedPeriods = new Set<string>();

/** 終わったばかりの週と月の結果を、まだ残していなければ残す（掲示板がなくても残す） */
const recordFinishedPeriods = async (guild: Guild, now: Date): Promise<void> => {
  const today = jstDay(now);
  const targets: [ResultPeriod, string][] = [
    ['week', addDays(weekStart(today), -7)],
    ['month', addMonths(monthStart(today), -1)],
  ];
  for (const [period, start] of targets) {
    const key = `${guild.id}:${period}:${start}`;
    if (recordedPeriods.has(key)) continue;
    if (!(await hasResults(guild.id, period, start))) {
      const entries = await rankXpBetween(guild, start, RESULT_TYPES[period].end(start));
      await recordResults(
        guild.id,
        period,
        start,
        entries.slice(0, RESULT_COUNT).map((entry, i) => ({ rank: i + 1, userId: entry.member.id, xp: entry.value })),
      );
    }
    recordedPeriods.add(key);
  }
};

/** 1分ごとに、週・月が終わっていれば結果を残して投稿し、5分ごとに掲示板を書き換える */
export const startRankingBoards = (client: Client<true>): void => {
  // 掲示板の場所を覚える（最初の1分を待たずに、置き直しが効くように）
  listBoards().catch((error: unknown) => {
    reportError('ランキング掲示板を読み込めませんでした', error);
  });
  setInterval(() => {
    runRankingSchedule(client).catch((error: unknown) => {
      reportError('ランキング掲示板の処理に失敗しました', error);
    });
  }, TICK_MS).unref();
};

export const runRankingSchedule = async (client: Client<true>, now: Date = new Date()): Promise<void> => {
  for (const guild of client.guilds.cache.values()) {
    await recordFinishedPeriods(guild, now).catch((error: unknown) => {
      reportError(`「${guild.name}」のランキングの結果を残せませんでした`, error, guild);
    });
  }

  const today = jstDay(now);
  const lastWeek = addDays(weekStart(today), -7);
  const lastMonth = addMonths(monthStart(today), -1);
  for (const { guildId } of await listBoards()) {
    const guild = client.guilds.cache.get(guildId);
    if (!guild) continue;
    await boardLock(guildId, async () => {
      // 置き直しで掲示板のメッセージが変わっているかもしれないので、今の掲示板を読み直す
      const board = await findBoard(guildId);
      if (!board) return;
      const channel = guild.channels.cache.get(board.channelId);
      if (!channel?.isTextBased()) {
        await deleteBoard(guildId);
        return;
      }

      // Botが止まっていて月曜0時・1日0時を過ぎていたら、動き出したときに投稿する。二重に投稿しないよう、先に記録する。
      // 月の結果の機能より前からある掲示板（記録が空）は、先月の分を投稿済みとして始める
      let posted = false;
      if (board.lastWeeklyPost === null || board.lastWeeklyPost < lastWeek) {
        board.lastWeeklyPost = lastWeek;
        await saveBoard(board);
        await postResult(guild, channel, 'week', lastWeek);
        posted = true;
      }
      if (board.lastMonthlyPost === null) {
        board.lastMonthlyPost = lastMonth;
        await saveBoard(board);
      } else if (board.lastMonthlyPost < lastMonth) {
        board.lastMonthlyPost = lastMonth;
        await saveBoard(board);
        await postResult(guild, channel, 'month', lastMonth);
        posted = true;
      }

      if (posted) {
        // 結果の投稿で掲示板が上に流れたので、一番下に出し直す（消されていたら、もう使わない）
        await repostBoard(guild, channel, board, now);
      } else if (now.getTime() - (lastBoardRefresh.get(guildId) ?? 0) >= BOARD_REFRESH_MS) {
        lastBoardRefresh.set(guildId, now.getTime());
        if (channel.lastMessageId && channel.lastMessageId !== board.messageId) {
          // Botが止まっている間の投稿や、取りこぼした発言で掲示板が上に流れていたら、一番下に出し直す（起動して最初の回にも直る）
          await repostBoard(guild, channel, board, now);
        } else if (!(await refreshBoard(guild, channel, board, now))) {
          // 掲示板が消されていたら、もう更新しない（設置し直せばまた使える）
          await deleteBoard(guildId);
        }
      }
    });
  }
};

/** 掲示板を新しく置く（前の掲示板があれば消す）。前の週・月の結果は投稿済みとして始める */
export const placeBoard = async (guild: Guild, channel: GuildTextBasedChannel, now: Date = new Date()): Promise<{ replaced: boolean }> => {
  let replaced = false;
  await boardLock(guild.id, async () => {
    const old = await findBoard(guild.id);
    if (old) {
      const oldChannel = guild.channels.cache.get(old.channelId);
      if (oldChannel?.isTextBased()) await oldChannel.messages.delete(old.messageId).catch(() => undefined);
    }
    const data = await loadBoardData(guild, now);
    const { embeds, files } = await renderBoard(data, now);
    const message = await channel.send({
      embeds,
      files,
      components: [boardButtons()],
      flags: MessageFlags.SuppressNotifications,
    });
    const today = jstDay(now);
    await saveBoard({
      guildId: guild.id,
      channelId: channel.id,
      messageId: message.id,
      lastWeeklyPost: old?.lastWeeklyPost ?? addDays(weekStart(today), -7),
      lastMonthlyPost: old?.lastMonthlyPost ?? addMonths(monthStart(today), -1),
    });
    lastBoardHash.set(message.id, boardHash(data));
    lastBoardRefresh.set(guild.id, now.getTime());
    replaced = old !== null;
  });
  return { replaced };
};
