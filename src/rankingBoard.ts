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
import { fetchAllMembers } from './guildUtils.js';
import { addDays, formatDay, jstDay, weekStart } from './jst.js';
import { formatNumber } from './levels.js';
import { listPeriodXp } from './levelStore.js';

// 経験値ランキングの掲示板（今日・今週を自動で更新）と、毎週月曜0時の「先週の結果」の投稿

export const WEEKLY_TOP_ROLE_NAME = '週間ランキング上位';
/** 先週の何位までにロールを付けるか */
export const WEEKLY_ROLE_COUNT = 3;
const TOP_COUNT = 10;
const BOARD_REFRESH_MS = 5 * 60_000;
const TICK_MS = 60_000;
const MEDALS = ['🥇', '🥈', '🥉'];
const COLOR = 0xf1c40f;

export interface RankingBoard {
  guildId: string;
  channelId: string;
  messageId: string;
  /** どの週（その週の月曜）の結果まで投稿したか */
  lastWeeklyPost: string | null;
}

interface BoardRow {
  guild_id: string;
  channel_id: string;
  message_id: string;
  last_weekly_post: string | null;
}

const toBoard = (row: BoardRow): RankingBoard => ({
  guildId: row.guild_id,
  channelId: row.channel_id,
  messageId: row.message_id,
  lastWeeklyPost: row.last_weekly_post,
});

const BOARD_COLUMNS = 'guild_id, channel_id, message_id, last_weekly_post::text AS last_weekly_post';

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
    `INSERT INTO ranking_boards (guild_id, channel_id, message_id, last_weekly_post) VALUES ($1, $2, $3, $4::date)
     ON CONFLICT (guild_id) DO UPDATE
       SET channel_id = EXCLUDED.channel_id, message_id = EXCLUDED.message_id, last_weekly_post = EXCLUDED.last_weekly_post`,
    [board.guildId, board.channelId, board.messageId, board.lastWeeklyPost],
  );
};

const deleteBoard = async (guildId: string): Promise<void> => {
  await pool.query('DELETE FROM ranking_boards WHERE guild_id = $1', [guildId]);
};

interface PeriodEntry {
  member: GuildMember;
  xp: number;
}

/** from の日から to の日の前日まで（日本時間）のランキング。サーバーにいる人だけで、Botは除く */
const rankPeriod = async (guild: Guild, from: string, to: string): Promise<PeriodEntry[]> => {
  const [members, rows] = await Promise.all([fetchAllMembers(guild), listPeriodXp(guild.id, from, to)]);
  return rows.flatMap((row) => {
    const member = members.get(row.userId);
    return member && !member.user.bot && row.xp > 0 ? [{ member, xp: row.xp }] : [];
  });
};

const rankingLines = (entries: PeriodEntry[], count: number, empty: string): string =>
  entries.length === 0
    ? empty
    : entries
        .slice(0, count)
        .map((entry, i) => `${MEDALS[i] ?? `**${i + 1}.**`} ${entry.member} ${formatNumber(entry.xp)} XP`)
        .join('\n');

/** 掲示板の中身。日付が変われば「今日」、月曜になれば「今週」が自動で切り替わる */
export const buildBoard = async (guild: Guild, now: Date = new Date()): Promise<EmbedBuilder> => {
  const today = jstDay(now);
  const thisWeek = weekStart(today);
  const lastWeek = addDays(thisWeek, -7);
  const [daily, weekly, previous] = await Promise.all([
    rankPeriod(guild, today, addDays(today, 1)),
    rankPeriod(guild, thisWeek, addDays(thisWeek, 7)),
    rankPeriod(guild, lastWeek, thisWeek),
  ]);
  return new EmbedBuilder()
    .setColor(COLOR)
    .setTitle('🏆 経験値ランキング')
    .setDescription('発言とVCで貯まった経験値のランキングです（5分ごとに更新）。')
    .addFields(
      { name: `📅 今日 ${formatDay(today)}`, value: rankingLines(daily, TOP_COUNT, 'まだ記録がありません'), inline: true },
      { name: `🗓️ 今週 ${formatDay(thisWeek)}〜`, value: rankingLines(weekly, TOP_COUNT, 'まだ記録がありません'), inline: true },
      {
        name: `👑 先週の上位 ${formatDay(lastWeek)}〜${formatDay(addDays(thisWeek, -1))}`,
        value: rankingLines(previous, WEEKLY_ROLE_COUNT, '記録がありません'),
      },
    )
    .setFooter({ text: `毎週月曜0時に先週の結果を投稿し、1〜${WEEKLY_ROLE_COUNT}位に「${WEEKLY_TOP_ROLE_NAME}」ロールを付けます` });
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
    await channel.messages.edit(board.messageId, { embeds: [embed.setTimestamp(now)] });
    lastBoardHash.set(board.messageId, hash);
    return true;
  } catch (error) {
    if (error instanceof DiscordAPIError && error.code === RESTJSONErrorCodes.UnknownMessage) return false;
    console.error(`「${guild.name}」のランキング掲示板を更新できませんでした:`, error);
    return true;
  }
};

/** 先週の結果を投稿し、上位の人に「週間ランキング上位」ロールを付け替える */
const postWeeklyResult = async (guild: Guild, channel: GuildTextBasedChannel, week: string): Promise<void> => {
  const entries = await rankPeriod(guild, week, addDays(week, 7));
  const winners = entries.slice(0, WEEKLY_ROLE_COUNT).map((entry) => entry.member);
  const roleNote = await giveWeeklyRole(guild, winners);
  const embed = new EmbedBuilder()
    .setColor(COLOR)
    .setTitle('🏆 先週の経験値ランキング')
    .setDescription(
      [`${formatDay(week)}〜${formatDay(addDays(week, 6))}`, '', rankingLines(entries, TOP_COUNT, '先週は記録がありませんでした。')].join('\n'),
    )
    .addFields({ name: `🎖️ 「${WEEKLY_TOP_ROLE_NAME}」ロール`, value: roleNote });
  await channel.send({ embeds: [embed], allowedMentions: { parse: [] } });
  void sendLog(guild, 'system', `先週（${formatDay(week)}〜）の経験値ランキングを投稿しました`, undefined, {
    channel,
    fields: [{ name: `🎖️ 「${WEEKLY_TOP_ROLE_NAME}」ロール`, value: roleNote }],
  });
};

/** 上位の人にロールを付け、それ以外で付いている人からは外す。結果の説明を返す */
const giveWeeklyRole = async (guild: Guild, winners: GuildMember[]): Promise<string> => {
  const me = guild.members.me;
  if (!me?.permissions.has(PermissionFlagsBits.ManageRoles)) return '⚠ Botにロールの管理権限がないため、付けられませんでした。';
  try {
    const role =
      guild.roles.cache.find((r) => r.name === WEEKLY_TOP_ROLE_NAME) ??
      (await guild.roles.create({
        name: WEEKLY_TOP_ROLE_NAME,
        colors: { primaryColor: COLOR },
        permissions: [],
        reason: '週間ランキングの上位の人のロール',
      }));
    if (!role.editable) return `⚠ Botのロールが「${role.name}」より下にあるため、付けられませんでした。`;

    const winnerIds = new Set(winners.map((member) => member.id));
    const members = await fetchAllMembers(guild);
    for (const member of members.values()) {
      if (member.roles.cache.has(role.id) && !winnerIds.has(member.id)) await member.roles.remove(role, '週間ランキングの付け替え');
    }
    for (const member of winners) {
      if (!member.roles.cache.has(role.id)) await member.roles.add(role, '先週の経験値ランキング上位');
    }
    return winners.length > 0
      ? `${winners.map((member) => `${member}`).join(' ')} に付けました（先週付いていた人からは外しました）。`
      : '先週は記録がなかったので、誰にも付けていません。';
  } catch (error) {
    console.error(`「${guild.name}」の「${WEEKLY_TOP_ROLE_NAME}」ロールを付け替えられませんでした:`, error);
    return '⚠ ロールの付け替えに失敗しました。';
  }
};

/** 1分ごとに、月曜0時を過ぎていれば先週の結果を投稿し、5分ごとに掲示板を書き換える */
export const startRankingBoards = (client: Client<true>): void => {
  setInterval(() => {
    runRankingSchedule(client).catch((error: unknown) => {
      console.error('ランキング掲示板の処理に失敗しました:', error);
    });
  }, TICK_MS).unref();
};

export const runRankingSchedule = async (client: Client<true>, now: Date = new Date()): Promise<void> => {
  const lastWeek = addDays(weekStart(jstDay(now)), -7);
  for (const board of await listBoards()) {
    const guild = client.guilds.cache.get(board.guildId);
    const channel = guild?.channels.cache.get(board.channelId);
    if (!guild) continue;
    if (!channel?.isTextBased()) {
      await deleteBoard(board.guildId);
      continue;
    }

    // Botが止まっていて月曜0時を過ぎていたら、動き出したときに投稿する。二重に投稿しないよう、先に記録する
    let weeklyPosted = false;
    if (board.lastWeeklyPost === null || board.lastWeeklyPost < lastWeek) {
      board.lastWeeklyPost = lastWeek;
      await saveBoard(board);
      await postWeeklyResult(guild, channel, lastWeek);
      weeklyPosted = true;
    }

    if (weeklyPosted || now.getTime() - (lastBoardRefresh.get(board.guildId) ?? 0) >= BOARD_REFRESH_MS) {
      lastBoardRefresh.set(board.guildId, now.getTime());
      // 掲示板が消されていたら、もう更新しない（設置し直せばまた使える）
      if (!(await refreshBoard(guild, channel, board, now))) await deleteBoard(board.guildId);
    }
  }
};

/** 掲示板を新しく置く（前の掲示板があれば消す）。前の週の結果は投稿済みとして始める */
export const placeBoard = async (guild: Guild, channel: GuildTextBasedChannel, now: Date = new Date()): Promise<{ replaced: boolean }> => {
  const old = await findBoard(guild.id);
  if (old) {
    const oldChannel = guild.channels.cache.get(old.channelId);
    if (oldChannel?.isTextBased()) await oldChannel.messages.delete(old.messageId).catch(() => undefined);
  }
  const message = await channel.send({ embeds: [(await buildBoard(guild, now)).setTimestamp(now)], flags: MessageFlags.SuppressNotifications });
  await saveBoard({
    guildId: guild.id,
    channelId: channel.id,
    messageId: message.id,
    lastWeeklyPost: old?.lastWeeklyPost ?? addDays(weekStart(jstDay(now)), -7),
  });
  lastBoardRefresh.set(guild.id, now.getTime());
  return { replaced: old !== null };
};
