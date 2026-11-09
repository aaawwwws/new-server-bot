import { pool } from './db.js';

// 流したメンテナンス・障害のお知らせ（同じものを二重に流さないため）。kind は news（記事）/ reminder（始まる前）/ seed（初めて読んだ印）

/** そのサーバーで、一度でもお知らせを読んだことがあるか（初めてなら、今ある記事は流さずに既読にする） */
export const hasMaintenanceNotices = async (guildId: string): Promise<boolean> => {
  const { rowCount } = await pool.query('SELECT 1 FROM maintenance_notices WHERE guild_id = $1 LIMIT 1', [guildId]);
  return (rowCount ?? 0) > 0;
};

/** 今ある記事を、流さずに既読にする（初めて読んだときに、過去の記事をまとめて流さないため） */
export const seedMaintenanceNotices = async (guildId: string, entryIds: string[]): Promise<void> => {
  await pool.query(
    `INSERT INTO maintenance_notices (guild_id, entry_id, kind)
     SELECT $1, id, 'news' FROM unnest($2::text[]) AS id
     UNION ALL SELECT $1, '', 'seed'
     ON CONFLICT DO NOTHING`,
    [guildId, entryIds],
  );
};

/** そのお知らせを流すことにする。もう流していれば false */
export const claimMaintenanceNotice = async (guildId: string, entryId: string, kind: 'news' | 'reminder'): Promise<boolean> => {
  const { rowCount } = await pool.query(
    'INSERT INTO maintenance_notices (guild_id, entry_id, kind) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING',
    [guildId, entryId, kind],
  );
  return rowCount === 1;
};

/** 流せなかったときに、次にまた流せるよう戻す */
export const releaseMaintenanceNotice = async (guildId: string, entryId: string, kind: 'news' | 'reminder'): Promise<void> => {
  await pool.query('DELETE FROM maintenance_notices WHERE guild_id = $1 AND entry_id = $2 AND kind = $3', [guildId, entryId, kind]);
};
