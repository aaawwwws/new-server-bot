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
  message_count: number;
  voice_minutes: number;
}

// bigint は文字列で返ってくるので数値にする（XPが Number の上限を超えることはない）
const toStats = (row: LevelRow): LevelStats => ({
  userId: row.user_id,
  xp: Number(row.xp),
  messageCount: row.message_count,
  voiceMinutes: row.voice_minutes,
});

/** 発言を1回数え、xp を足す（連投の間は 0）。day はその日（日本時間） */
export const addMessageActivity = async (guildId: string, userId: string, xp: number, day: string): Promise<void> => {
  await pool.query(
    `INSERT INTO member_levels (guild_id, user_id, xp, message_count) VALUES ($1, $2, $3, 1)
     ON CONFLICT (guild_id, user_id) DO UPDATE
       SET xp = member_levels.xp + EXCLUDED.xp, message_count = member_levels.message_count + 1, updated_at = now()`,
    [guildId, userId, xp],
  );
  if (xp > 0) await addDailyXp(guildId, [userId], xp, day);
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
  await addDailyXp(guildId, userIds, xp, day);
};

const addDailyXp = async (guildId: string, userIds: string[], xp: number, day: string): Promise<void> => {
  await pool.query(
    `INSERT INTO level_daily_xp (guild_id, day, user_id, xp)
     SELECT $1, $2::date, user_id, $4 FROM unnest($3::text[]) AS user_id
     ON CONFLICT (guild_id, day, user_id) DO UPDATE SET xp = level_daily_xp.xp + EXCLUDED.xp`,
    [guildId, day, userIds, xp],
  );
};

export interface PeriodXp {
  userId: string;
  xp: number;
}

/** from の日から to の日の前日まで（日本時間）に貯まったXPを、人ごとに多い順で */
export const listPeriodXp = async (guildId: string, from: string, to: string): Promise<PeriodXp[]> => {
  const { rows } = await pool.query<{ user_id: string; xp: string }>(
    `SELECT user_id, sum(xp) AS xp FROM level_daily_xp
      WHERE guild_id = $1 AND day >= $2::date AND day < $3::date
      GROUP BY user_id ORDER BY sum(xp) DESC`,
    [guildId, from, to],
  );
  return rows.map((row) => ({ userId: row.user_id, xp: Number(row.xp) }));
};

/** サーバーの全員分（抜けた人も含む。順位を出すときにサーバーにいる人だけに絞る） */
export const listLevelStats = async (guildId: string): Promise<LevelStats[]> => {
  const { rows } = await pool.query<LevelRow>(
    'SELECT user_id, xp, message_count, voice_minutes FROM member_levels WHERE guild_id = $1',
    [guildId],
  );
  return rows.map(toStats);
};
