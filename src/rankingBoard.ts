import { createHash } from 'node:crypto';
import {
  DiscordAPIError,
  EmbedBuilder,
  MessageFlags,
  PermissionFlagsBits,
  RESTJSONErrorCodes,
  type Client,
  type Guild,
  type GuildMember,
  type GuildTextBasedChannel,
} from 'discord.js';
import { sendLog } from './activityLog.js';
import { pool } from './db.js';
import { reportError } from './errorReporter.js';
import { fetchAllMembers } from './guildUtils.js';
import { addDays, addMonths, formatDay, formatMonth, jstDay, monthStart, weekStart } from './jst.js';
import { computeRanking, rankXpBetween, rankingLine, type RankingEntry } from './rankings.js';
import { hasResults, recordResults, type ResultPeriod } from './rankingStore.js';
import { boardButtons } from './rankingView.js';
import { describeBoost } from './xpBoost.js';

// 経験値ランキングの掲示板（今日・今週・今月を自動で更新）と、毎週月曜0時・毎月1日0時の結果の投稿。
// 結果（上位の人）は、掲示板がなくても歴代記録として残す

export const WEEKLY_TOP_ROLE_NAME = '週間ランキング上位';
/** 先週の何位までにロールを付けるか */
export const WEEKLY_ROLE_COUNT = 3;
export const MONTHLY_TOP_ROLE_NAME = '月間MVP';
/** 先月の何位までにロールを付けるか */
export const MONTHLY_ROLE_COUNT = 1;
const TOP_COUNT = 10;
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
    end: (start: string) => addDays(start, 7),
    describe: (start: string) => `${formatDay(start)}〜${formatDay(addDays(start, 6))}`,
    name: '先週',
  },
  month: {
    roleName: MONTHLY_TOP_ROLE_NAME,
    roleCount: MONTHLY_ROLE_COUNT,
    roleColor: 0xe67e22,
    title: '🌟 先月の経験値ランキング',
    end: (start: string) => addMonths(start, 1),
    describe: (start: string) => formatMonth(start),
    name: '先月',
  },
} as const satisfies Record<ResultPeriod, unknown>;

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

export const findBoard = async (guildId: string): Promise<RankingBoard | null> => {
  const { rows } = await pool.query<BoardRow>(`SELECT ${BOARD_COLUMNS} FROM ranking_boards WHERE guild_id = $1`, [guildId]);
  const [row] = rows;
  return row ? toBoard(row) : null;
};

const listBoards = async (): Promise<RankingBoard[]> => {
  const { rows } = await pool.query<BoardRow>(`SELECT ${BOARD_COLUMNS} FROM ranking_boards`);
  return rows.map(toBoard);
};

export const saveBoard = async (board: RankingBoard): Promise<void> => {
  await pool.query(
    `INSERT INTO ranking_boards (guild_id, channel_id, message_id, last_weekly_post, last_monthly_post) VALUES ($1, $2, $3, $4::date, $5::date)
     ON CONFLICT (guild_id) DO UPDATE
       SET channel_id = EXCLUDED.channel_id, message_id = EXCLUDED.message_id,
           last_weekly_post = EXCLUDED.last_weekly_post, last_monthly_post = EXCLUDED.last_monthly_post`,
    [board.guildId, board.channelId, board.messageId, board.lastWeeklyPost, board.lastMonthlyPost],
  );
};

const deleteBoard = async (guildId: string): Promise<void> => {
  await pool.query('DELETE FROM ranking_boards WHERE guild_id = $1', [guildId]);
};

/** 上位 count 人の行（XPの、終わった期間か、今日・今週・今月） */
const rankingLines = (entries: RankingEntry[], period: 'day' | 'week' | 'month', count: number, empty: string): string =>
  entries.length === 0 ? empty : entries.slice(0, count).map((entry, i) => rankingLine({ kind: 'xp', period }, entry, i)).join('\n');

/** 掲示板の中身。日付が変われば「今日」、月曜になれば「今週」、1日になれば「今月」が自動で切り替わる */
export const buildBoard = async (guild: Guild, now: Date = new Date()): Promise<EmbedBuilder> => {
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
  const boost = describeBoost(guild.id, now);
  return new EmbedBuilder()
    .setColor(COLOR)
    .setTitle('🏆 経験値ランキング')
    .setDescription(
      [
        '発言とVCで貯まった経験値のランキングです（5分ごとに更新・⬆⬇🆕 は昨日からの変化）。',
        '下のボタンで、自分の順位やほかのランキング（発言数・VC・連続日数・PT募集）を見られます。',
        ...(boost ? ['', boost] : []),
      ].join('\n'),
    )
    .addFields(
      { name: `📅 今日 ${formatDay(today)}`, value: rankingLines(daily.entries, 'day', TOP_COUNT, 'まだ記録がありません'), inline: true },
      { name: `🗓️ 今週 ${formatDay(thisWeek)}〜`, value: rankingLines(weekly.entries, 'week', TOP_COUNT, 'まだ記録がありません'), inline: true },
      { name: `🌙 今月 ${formatMonth(thisMonth)}`, value: rankingLines(monthly.entries, 'month', TOP_COUNT, 'まだ記録がありません'), inline: true },
      {
        name: `👑 先週の上位 ${formatDay(lastWeek)}〜${formatDay(addDays(thisWeek, -1))}`,
        value: rankingLines(previousWeek, 'week', WEEKLY_ROLE_COUNT, '記録がありません'),
        inline: true,
      },
      {
        name: `🌟 先月のMVP ${formatMonth(lastMonth)}`,
        value: rankingLines(previousMonth, 'month', MONTHLY_ROLE_COUNT, '記録がありません'),
        inline: true,
      },
    )
    .setFooter({
      text: `毎週月曜0時に先週の結果を投稿して1〜${WEEKLY_ROLE_COUNT}位に「${WEEKLY_TOP_ROLE_NAME}」、毎月1日0時に先月の結果を投稿して1位に「${MONTHLY_TOP_ROLE_NAME}」ロールを付けます`,
    });
};

/** 前回から中身が変わったときだけ書き換える（掲示板ごとの、前回の中身） */
const lastBoardHash = new Map<string, string>();
const lastBoardRefresh = new Map<string, number>();

/** 掲示板を今の内容に書き換える。消されていたら、掲示板はもう使わない（false） */
export const refreshBoard = async (guild: Guild, channel: GuildTextBasedChannel, board: RankingBoard, now: Date = new Date()): Promise<boolean> => {
  const embed = await buildBoard(guild, now);
  const hash = createHash('sha256').update(JSON.stringify(embed.toJSON())).digest('hex');
  if (lastBoardHash.get(board.messageId) === hash) return true;
  try {
    await channel.messages.edit(board.messageId, { embeds: [embed.setTimestamp(now)], components: [boardButtons()] });
    lastBoardHash.set(board.messageId, hash);
    return true;
  } catch (error) {
    if (error instanceof DiscordAPIError && error.code === RESTJSONErrorCodes.UnknownMessage) return false;
    reportError(`「${guild.name}」のランキング掲示板を更新できませんでした`, error, guild);
    return true;
  }
};

/** 先週・先月の結果を投稿し、上位の人にロールを付け替える */
const postResult = async (guild: Guild, channel: GuildTextBasedChannel, period: ResultPeriod, start: string): Promise<void> => {
  const type = RESULT_TYPES[period];
  const entries = await rankXpBetween(guild, start, type.end(start));
  const winners = entries.slice(0, type.roleCount).map((entry) => entry.member);
  const roleNote = await giveTopRole(guild, period, winners);
  const embed = new EmbedBuilder()
    .setColor(COLOR)
    .setTitle(type.title)
    .setDescription([type.describe(start), '', rankingLines(entries, period, TOP_COUNT, `${type.name}は記録がありませんでした。`)].join('\n'))
    .addFields({ name: `🎖️ 「${type.roleName}」ロール`, value: roleNote });
  await channel.send({ embeds: [embed], allowedMentions: { parse: [] } });
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
      ? `${winners.map((member) => `${member}`).join(' ')} に付けました（前に付いていた人からは外しました）。`
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
  for (const board of await listBoards()) {
    const guild = client.guilds.cache.get(board.guildId);
    const channel = guild?.channels.cache.get(board.channelId);
    if (!guild) continue;
    if (!channel?.isTextBased()) {
      await deleteBoard(board.guildId);
      continue;
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

    if (posted || now.getTime() - (lastBoardRefresh.get(board.guildId) ?? 0) >= BOARD_REFRESH_MS) {
      lastBoardRefresh.set(board.guildId, now.getTime());
      // 掲示板が消されていたら、もう更新しない（設置し直せばまた使える）
      if (!(await refreshBoard(guild, channel, board, now))) await deleteBoard(board.guildId);
    }
  }
};

/** 掲示板を新しく置く（前の掲示板があれば消す）。前の週・月の結果は投稿済みとして始める */
export const placeBoard = async (guild: Guild, channel: GuildTextBasedChannel, now: Date = new Date()): Promise<{ replaced: boolean }> => {
  const old = await findBoard(guild.id);
  if (old) {
    const oldChannel = guild.channels.cache.get(old.channelId);
    if (oldChannel?.isTextBased()) await oldChannel.messages.delete(old.messageId).catch(() => undefined);
  }
  const embed = await buildBoard(guild, now);
  const message = await channel.send({
    embeds: [embed.setTimestamp(now)],
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
  lastBoardRefresh.set(guild.id, now.getTime());
  return { replaced: old !== null };
};
