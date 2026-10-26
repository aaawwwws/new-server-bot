import { pool } from './db.js';

// 週・月が終わったときの結果（上位の人）。歴代記録と自己ベストに使う

export type ResultPeriod = 'week' | 'month';

export interface PeriodResult {
  rank: number;
  userId: string;
  xp: number;
}

/** その期間の結果をもう残したか */
export const hasResults = async (guildId: string, period: ResultPeriod, start: string): Promise<boolean> => {
  const { rows } = await pool.query(
    'SELECT 1 FROM ranking_periods WHERE guild_id = $1 AND period = $2 AND period_start = $3::date',
    [guildId, period, start],
  );
  return rows.length > 0;
};

/** 結果を残す。同じ期間をもう残していたら何もしない（false）。記録がなかった期間も「残した」ことにする */
export const recordResults = async (guildId: string, period: ResultPeriod, start: string, results: PeriodResult[]): Promise<boolean> => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rowCount } = await client.query(
      'INSERT INTO ranking_periods (guild_id, period, period_start) VALUES ($1, $2, $3::date) ON CONFLICT DO NOTHING',
      [guildId, period, start],
    );
    if (rowCount === 0) {
      await client.query('ROLLBACK');
      return false;
    }
    if (results.length > 0) {
      await client.query(
        `INSERT INTO ranking_results (guild_id, period, period_start, rank, user_id, xp)
         SELECT $1, $2, $3::date, r.rank, r.user_id, r.xp FROM unnest($4::int[], $5::text[], $6::bigint[]) AS r(rank, user_id, xp)`,
        [guildId, period, start, results.map((r) => r.rank), results.map((r) => r.userId), results.map((r) => r.xp)],
      );
    }
    await client.query('COMMIT');
    return true;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
};

export interface Champion {
  /** その期間の最初の日 */
  start: string;
  userId: string;
  xp: number;
}

/** 歴代の1位（新しい順） */
export const listChampions = async (guildId: string, period: ResultPeriod, limit: number): Promise<Champion[]> => {
  const { rows } = await pool.query<{ start: string; user_id: string; xp: string }>(
    `SELECT period_start::text AS start, user_id, xp FROM ranking_results
      WHERE guild_id = $1 AND period = $2 AND rank = 1 ORDER BY period_start DESC LIMIT $3`,
    [guildId, period, limit],
  );
  return rows.map((row) => ({ start: row.start, userId: row.user_id, xp: Number(row.xp) }));
};

/** 1位になった回数の多い人（同じ回数なら、最近1位になった人が上） */
export const listWinCounts = async (guildId: string, period: ResultPeriod, limit: number): Promise<{ userId: string; wins: number }[]> => {
  const { rows } = await pool.query<{ user_id: string; wins: number }>(
    `SELECT user_id, count(*)::int AS wins FROM ranking_results
      WHERE guild_id = $1 AND period = $2 AND rank = 1
      GROUP BY user_id ORDER BY count(*) DESC, max(period_start) DESC LIMIT $3`,
    [guildId, period, limit],
  );
  return rows.map((row) => ({ userId: row.user_id, wins: row.wins }));
};

export interface ResultBests {
  /** 一番よかった順位（同じ順位が何度かあれば、最近のもの） */
  bestRank: { rank: number; start: string } | null;
  /** 1位になった回数 */
  wins: number;
}

export const findResultBests = async (guildId: string, userId: string, period: ResultPeriod): Promise<ResultBests> => {
  const { rows } = await pool.query<{ rank: number; start: string; wins: number }>(
    `SELECT rank, period_start::text AS start, count(*) FILTER (WHERE rank = 1) OVER ()::int AS wins FROM ranking_results
      WHERE guild_id = $1 AND user_id = $2 AND period = $3 ORDER BY rank, period_start DESC LIMIT 1`,
    [guildId, userId, period],
  );
  const [row] = rows;
  return row ? { bestRank: { rank: row.rank, start: row.start }, wins: row.wins } : { bestRank: null, wins: 0 };
};
