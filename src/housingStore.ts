import { pool } from './db.js';

// ハウジング抽選の日程・申し込みメモ（お知らせを受け取る人は「ハウジング抽選」ロールで分かる）

/** 日程の基準（ある回の受付の終わり）。まだ設定していなければ null */
export const loadHousingAnchor = async (guildId: string): Promise<Date | null> => {
  const { rows } = await pool.query<{ housing_anchor: Date | null }>('SELECT housing_anchor FROM guild_settings WHERE guild_id = $1', [guildId]);
  return rows[0]?.housing_anchor ?? null;
};

/** null にすると、お知らせを止める */
export const saveHousingAnchor = async (guildId: string, anchor: Date | null): Promise<void> => {
  await pool.query(
    `INSERT INTO guild_settings (guild_id, housing_anchor) VALUES ($1, $2)
     ON CONFLICT (guild_id) DO UPDATE SET housing_anchor = EXCLUDED.housing_anchor, updated_at = now()`,
    [guildId, anchor],
  );
};

/** その回の申し込みメモ（なければ null） */
export const findHousingEntry = async (guildId: string, userId: string, resultsAt: Date): Promise<string | null> => {
  const { rows } = await pool.query<{ plot: string }>(
    'SELECT plot FROM housing_entries WHERE guild_id = $1 AND user_id = $2 AND results_at = $3',
    [guildId, userId, resultsAt],
  );
  return rows[0]?.plot ?? null;
};

/** 申し込みメモを残す。plot が空なら消す */
export const saveHousingEntry = async (guildId: string, userId: string, resultsAt: Date, plot: string): Promise<void> => {
  if (!plot) {
    await pool.query('DELETE FROM housing_entries WHERE guild_id = $1 AND user_id = $2 AND results_at = $3', [guildId, userId, resultsAt]);
    return;
  }
  await pool.query(
    `INSERT INTO housing_entries (guild_id, user_id, results_at, plot) VALUES ($1, $2, $3, $4)
     ON CONFLICT (guild_id, user_id, results_at) DO UPDATE SET plot = EXCLUDED.plot, updated_at = now()`,
    [guildId, userId, resultsAt, plot],
  );
};

/** その回の申し込みメモ（ユーザーのID → 区画） */
export const listHousingEntries = async (guildId: string, resultsAt: Date): Promise<Map<string, string>> => {
  const { rows } = await pool.query<{ user_id: string; plot: string }>(
    'SELECT user_id, plot FROM housing_entries WHERE guild_id = $1 AND results_at = $2',
    [guildId, resultsAt],
  );
  return new Map(rows.map((row) => [row.user_id, row.plot]));
};

/** そのお知らせを送ることにする。もう送っていれば false（二重に送らないため） */
export const claimHousingNotice = async (guildId: string, kind: string, eventAt: Date): Promise<boolean> => {
  const { rowCount } = await pool.query(
    'INSERT INTO housing_notices (guild_id, kind, event_at) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING',
    [guildId, kind, eventAt],
  );
  return rowCount === 1;
};
