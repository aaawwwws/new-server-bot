import { pool } from './db.js';

// 潜水艦の帰ってくる時間（1人4隻まで）

export interface SubmarineTimer {
  guildId: string;
  userId: string;
  /** 1〜4隻目 */
  slot: number;
  /** 「1号」など（なくてもよい） */
  name: string;
  returnsAt: Date;
  /** 登録したときの、帰ってくるまでの長さ（分）。「同じ時間でもう一度」で使う */
  minutes: number;
  /** DMで知らせた時刻（まだなら null） */
  notifiedAt: Date | null;
}

interface TimerRow {
  guild_id: string;
  user_id: string;
  slot: number;
  name: string;
  returns_at: Date;
  minutes: number;
  notified_at: Date | null;
}

const COLUMNS = 'guild_id, user_id, slot, name, returns_at, minutes, notified_at';

const toTimer = (row: TimerRow): SubmarineTimer => ({
  guildId: row.guild_id,
  userId: row.user_id,
  slot: row.slot,
  name: row.name,
  returnsAt: row.returns_at,
  minutes: row.minutes,
  notifiedAt: row.notified_at,
});

/** その人の登録（隻目の順） */
export const listSubmarines = async (guildId: string, userId: string): Promise<SubmarineTimer[]> => {
  const { rows } = await pool.query<TimerRow>(
    `SELECT ${COLUMNS} FROM submarine_timers WHERE guild_id = $1 AND user_id = $2 ORDER BY slot`,
    [guildId, userId],
  );
  return rows.map(toTimer);
};

/** 登録する（同じ隻目があれば上書きし、まだ知らせていない状態に戻す） */
export const saveSubmarine = async (timer: Omit<SubmarineTimer, 'notifiedAt'>): Promise<void> => {
  await pool.query(
    `INSERT INTO submarine_timers (guild_id, user_id, slot, name, returns_at, minutes) VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (guild_id, user_id, slot) DO UPDATE
       SET name = EXCLUDED.name, returns_at = EXCLUDED.returns_at, minutes = EXCLUDED.minutes, notified_at = NULL, updated_at = now()`,
    [timer.guildId, timer.userId, timer.slot, timer.name, timer.returnsAt, timer.minutes],
  );
};

/** 取り消す。消したら true */
export const deleteSubmarine = async (guildId: string, userId: string, slot: number): Promise<boolean> => {
  const { rowCount } = await pool.query('DELETE FROM submarine_timers WHERE guild_id = $1 AND user_id = $2 AND slot = $3', [
    guildId,
    userId,
    slot,
  ]);
  return (rowCount ?? 0) > 0;
};

/** 同じ長さで、今からもう一度出したことにする。登録がなければ null */
export const relaunchSubmarine = async (guildId: string, userId: string, slot: number, now: Date): Promise<SubmarineTimer | null> => {
  const { rows } = await pool.query<TimerRow>(
    `UPDATE submarine_timers
        SET returns_at = $4::timestamptz + minutes * interval '1 minute', notified_at = NULL, updated_at = now()
      WHERE guild_id = $1 AND user_id = $2 AND slot = $3
      RETURNING ${COLUMNS}`,
    [guildId, userId, slot, now],
  );
  return rows[0] ? toTimer(rows[0]) : null;
};

/** 帰ってきたのにまだ知らせていないものを、知らせたことにして返す（同時に動いても二重に知らせない） */
export const claimReturnedSubmarines = async (now: Date): Promise<SubmarineTimer[]> => {
  const { rows } = await pool.query<TimerRow>(
    `UPDATE submarine_timers SET notified_at = $1
      WHERE notified_at IS NULL AND returns_at <= $1
      RETURNING ${COLUMNS}`,
    [now],
  );
  return rows.map(toTimer).sort((a, b) => a.slot - b.slot);
};
