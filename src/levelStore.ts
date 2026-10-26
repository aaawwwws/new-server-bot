import { pool } from './db.js';

export interface LevelStats {
  userId: string;
  xp: number;
  messageCount: number;
  voiceMinutes: number;
}

interface LevelRow {
  user_id: string;
  xp: string;
  message_count: number | string;
  voice_minutes: number | string;
}

// bigint や合計（sum）は文字列で返ってくるので数値にする（XPが Number の上限を超えることはない）
const toStats = (row: LevelRow): LevelStats => ({
  userId: row.user_id,
  xp: Number(row.xp),
  messageCount: Number(row.message_count),
  voiceMinutes: Number(row.voice_minutes),
});

/** 発言を1回数え、xp を足す（連投の間は 0）。day はその日（日本時間） */
export const addMessageActivity = async (guildId: string, userId: string, xp: number, day: string): Promise<void> => {
  await pool.query(
    `INSERT INTO member_levels (guild_id, user_id, xp, message_count) VALUES ($1, $2, $3, 1)
     ON CONFLICT (guild_id, user_id) DO UPDATE
       SET xp = member_levels.xp + EXCLUDED.xp, message_count = member_levels.message_count + 1, updated_at = now()`,
    [guildId, userId, xp],
  );
  // 日ごとの記録には、XPにならなかった発言も数える（期間ごとの発言数と、連続日数に使う）
  await pool.query(
    `INSERT INTO level_daily_xp (guild_id, day, user_id, xp, message_count) VALUES ($1, $2::date, $3, $4, 1)
     ON CONFLICT (guild_id, day, user_id) DO UPDATE
       SET xp = level_daily_xp.xp + EXCLUDED.xp, message_count = level_daily_xp.message_count + 1`,
    [guildId, day, userId, xp],
  );
};

/** VCにいた人たちに、1分ぶんの xp をまとめて足す */
export const addVoiceMinute = async (guildId: string, userIds: string[], xp: number, day: string): Promise<void> => {
  if (userIds.length === 0) return;
  await pool.query(
    `INSERT INTO member_levels (guild_id, user_id, xp, voice_minutes)
     SELECT $1, user_id, $3, 1 FROM unnest($2::text[]) AS user_id
     ON CONFLICT (guild_id, user_id) DO UPDATE
       SET xp = member_levels.xp + EXCLUDED.xp, voice_minutes = member_levels.voice_minutes + 1, updated_at = now()`,
    [guildId, userIds, xp],
  );
  await pool.query(
    `INSERT INTO level_daily_xp (guild_id, day, user_id, xp, voice_minutes)
     SELECT $1, $2::date, user_id, $4, 1 FROM unnest($3::text[]) AS user_id
     ON CONFLICT (guild_id, day, user_id) DO UPDATE
       SET xp = level_daily_xp.xp + EXCLUDED.xp, voice_minutes = level_daily_xp.voice_minutes + 1`,
    [guildId, day, userIds, xp],
  );
};

/** from の日から to の日の前日まで（日本時間）の、人ごとの XP・発言数・VCの時間 */
export const listPeriodStats = async (guildId: string, from: string, to: string): Promise<LevelStats[]> => {
  const { rows } = await pool.query<LevelRow>(
    `SELECT user_id, sum(xp) AS xp, sum(message_count) AS message_count, sum(voice_minutes) AS voice_minutes
       FROM level_daily_xp
      WHERE guild_id = $1 AND day >= $2::date AND day < $3::date
      GROUP BY user_id`,
    [guildId, from, to],
  );
  return rows.map(toStats);
};

/** サーバーの全員分（抜けた人も含む。順位を出すときにサーバーにいる人だけに絞る） */
export const listLevelStats = async (guildId: string): Promise<LevelStats[]> => {
  const { rows } = await pool.query<LevelRow>(
    'SELECT user_id, xp, message_count, voice_minutes FROM member_levels WHERE guild_id = $1',
    [guildId],
  );
  return rows.map(toStats);
};

/** 1人分の合計（まだ記録がなければ全部 0） */
export const findLevelStats = async (guildId: string, userId: string): Promise<LevelStats> => {
  const { rows } = await pool.query<LevelRow>(
    'SELECT user_id, xp, message_count, voice_minutes FROM member_levels WHERE guild_id = $1 AND user_id = $2',
    [guildId, userId],
  );
  const [row] = rows;
  return row ? toStats(row) : { userId, xp: 0, messageCount: 0, voiceMinutes: 0 };
};

export interface Streak {
  userId: string;
  /** 今続いている日数。今日まだ来ていなくても、昨日まで続いていれば途切れていない扱い */
  current: number;
  /** これまでで一番長く続いた日数 */
  best: number;
}

/**
 * 連続日数（発言かVCがあった日が何日続いているか）。user を渡すとその人だけ。
 * 続いている日の並びは「日付 − 何日目か」が同じになるので、それでまとめて数える
 */
const queryStreaks = async (guildId: string, today: string, userId: string | null): Promise<Streak[]> => {
  const { rows } = await pool.query<{ user_id: string; current: number; best: number }>(
    `WITH days AS (
       SELECT user_id, day FROM level_daily_xp
        WHERE guild_id = $1 AND day <= $2::date AND ($3::text IS NULL OR user_id = $3)
          AND (xp > 0 OR message_count > 0 OR voice_minutes > 0)
     ), runs AS (
       SELECT user_id, day, day - (row_number() OVER (PARTITION BY user_id ORDER BY day))::int AS run FROM days
     ), streaks AS (
       SELECT user_id, max(day) AS last_day, count(*)::int AS length FROM runs GROUP BY user_id, run
     )
     SELECT user_id, coalesce(max(length) FILTER (WHERE last_day >= $2::date - 1), 0)::int AS current, max(length)::int AS best
       FROM streaks GROUP BY user_id`,
    [guildId, today, userId],
  );
  return rows.map((row) => ({ userId: row.user_id, current: row.current, best: row.best }));
};

export const listStreaks = (guildId: string, today: string): Promise<Streak[]> => queryStreaks(guildId, today, null);

export const findStreak = async (guildId: string, userId: string, today: string): Promise<Streak> =>
  (await queryStreaks(guildId, today, userId))[0] ?? { userId, current: 0, best: 0 };

/** 1日で一番XPを貯めた日 */
export const findBestDayXp = async (guildId: string, userId: string): Promise<{ day: string; xp: number } | null> => {
  const { rows } = await pool.query<{ day: string; xp: number }>(
    `SELECT day::text AS day, xp FROM level_daily_xp
      WHERE guild_id = $1 AND user_id = $2 AND xp > 0 ORDER BY xp DESC, day DESC LIMIT 1`,
    [guildId, userId],
  );
  const [row] = rows;
  return row ? { day: row.day, xp: row.xp } : null;
};

/** 1週間（月曜〜日曜）で一番XPを貯めた週（week はその週の月曜） */
export const findBestWeekXp = async (guildId: string, userId: string): Promise<{ week: string; xp: number } | null> => {
  const { rows } = await pool.query<{ week: string; xp: string }>(
    `SELECT date_trunc('week', day)::date::text AS week, sum(xp) AS xp FROM level_daily_xp
      WHERE guild_id = $1 AND user_id = $2
      GROUP BY 1 HAVING sum(xp) > 0 ORDER BY sum(xp) DESC, 1 DESC LIMIT 1`,
    [guildId, userId],
  );
  const [row] = rows;
  return row ? { week: row.week, xp: Number(row.xp) } : null;
};
