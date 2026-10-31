import type { Client } from 'discord.js';
import { pool } from './db.js';
import { formatShortDateTime, parseJstDateTime } from './jst.js';

// XPアップ期間。管理者が決めた期間だけ、発言とVCでもらえるXPを増やす（重なっているときは大きい方）

export interface XpBoost {
  id: string;
  guildId: string;
  /** 「ハロウィン」など（なくてもよい） */
  label: string;
  /** 倍率（%）。200 なら2倍 */
  percent: number;
  startsAt: Date;
  endsAt: Date;
  createdBy: string;
}

/** 選べる倍率（%） */
export const BOOST_PERCENTS = [150, 200, 300];
/** 選べる長さ（時間） */
export const BOOST_HOURS = [1, 2, 3, 6, 12, 24, 48, 72, 168];
/** どれくらい先まで予約できるか */
const MAX_START_DAYS = 60;
/** 開始に少し前の時刻が入っていても、今から始める（入力に時間がかかった分） */
const PAST_GRACE_MS = 10 * 60_000;
const DAY_MS = 24 * 60 * 60_000;
const RELOAD_MS = 60_000;

interface BoostRow {
  id: string;
  guild_id: string;
  label: string;
  percent: number;
  starts_at: Date;
  ends_at: Date;
  created_by: string;
}

const toBoost = (row: BoostRow): XpBoost => ({
  id: row.id,
  guildId: row.guild_id,
  label: row.label,
  percent: row.percent,
  startsAt: row.starts_at,
  endsAt: row.ends_at,
  createdBy: row.created_by,
});

/** まだ終わっていないもの（開催中と、これから）を、始まる順に */
export const listBoosts = async (guildId: string, now: Date = new Date()): Promise<XpBoost[]> => {
  const { rows } = await pool.query<BoostRow>(
    'SELECT id, guild_id, label, percent, starts_at, ends_at, created_by FROM xp_boosts WHERE guild_id = $1 AND ends_at > $2 ORDER BY starts_at, id',
    [guildId, now],
  );
  return rows.map(toBoost);
};

export const createBoost = async (boost: Omit<XpBoost, 'id'>): Promise<XpBoost> => {
  const { rows } = await pool.query<BoostRow>(
    `INSERT INTO xp_boosts (guild_id, label, percent, starts_at, ends_at, created_by) VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING id, guild_id, label, percent, starts_at, ends_at, created_by`,
    [boost.guildId, boost.label, boost.percent, boost.startsAt, boost.endsAt, boost.createdBy],
  );
  await reloadBoosts(boost.guildId);
  return toBoost(rows[0] as BoostRow);
};

/** 止める。開催中なら今で終わりにし、まだ始まっていないものは消す。止めたもの（なければ null）を返す */
export const stopBoost = async (guildId: string, id: string, now: Date = new Date()): Promise<XpBoost | null> => {
  const { rows } = await pool.query<BoostRow>(
    'SELECT id, guild_id, label, percent, starts_at, ends_at, created_by FROM xp_boosts WHERE guild_id = $1 AND id = $2 AND ends_at > $3',
    [guildId, id, now],
  );
  const [row] = rows;
  if (!row) return null;
  if (row.starts_at <= now) {
    await pool.query('UPDATE xp_boosts SET ends_at = $2 WHERE id = $1', [id, now]);
  } else {
    await pool.query('DELETE FROM xp_boosts WHERE id = $1', [id]);
  }
  await reloadBoosts(guildId);
  return toBoost(row);
};

// 発言のたびにDBを読まないよう、サーバーごとのまだ終わっていないものを覚えておく（変えたときと、1分ごとに読み直す）
const cache = new Map<string, XpBoost[]>();

export const reloadBoosts = async (guildId: string): Promise<void> => {
  cache.set(guildId, await listBoosts(guildId));
};

export const startBoostCache = (client: Client<true>): void => {
  const run = () => {
    for (const guild of client.guilds.cache.values()) {
      reloadBoosts(guild.id).catch((error: unknown) => {
        console.error(`「${guild.name}」のXPアップ期間を読めませんでした:`, error);
      });
    }
  };
  run();
  setInterval(run, RELOAD_MS).unref();
};

/** 今開催中のもの（重なっていれば倍率が大きいもの） */
export const activeBoost = (guildId: string, now: Date = new Date()): XpBoost | null =>
  (cache.get(guildId) ?? [])
    .filter((boost) => boost.startsAt <= now && now < boost.endsAt)
    .reduce<XpBoost | null>((best, boost) => (!best || boost.percent > best.percent ? boost : best), null);

/** 今の倍率（%）。XPアップ期間でなければ 100 */
export const boostPercent = (guildId: string, now: Date = new Date()): number => activeBoost(guildId, now)?.percent ?? 100;

/** XPに倍率をかける（端数は四捨五入） */
export const applyBoost = (xp: number, percent: number): number => Math.round((xp * percent) / 100);

/** 「2倍」「1.5倍」 */
export const formatPercent = (percent: number): string => `${percent / 100}倍`;

/** 「3時間」「1日」「1週間」 */
export const formatHours = (hours: number): string => {
  if (hours % 168 === 0) return `${hours / 168}週間`;
  if (hours % 24 === 0) return `${hours / 24}日`;
  return `${hours}時間`;
};

/** 「2倍 10/31 20:00〜11/1 20:00「ハロウィン」」 */
export const describeBoostPeriod = (boost: XpBoost): string =>
  `**${formatPercent(boost.percent)}** ${formatShortDateTime(boost.startsAt)}〜${formatShortDateTime(boost.endsAt)}${boost.label ? `「${boost.label}」` : ''}`;

/** 掲示板やレベルの表示に出す一言。開催中ならそれ、なければ次の予定（どちらもなければ null） */
export const describeBoost = (guildId: string, now: Date = new Date()): string | null => {
  const active = activeBoost(guildId, now);
  if (active) {
    return `⚡ **XP${formatPercent(active.percent)} 開催中**（〜${formatShortDateTime(active.endsAt)}）${active.label ? `「${active.label}」` : ''}`;
  }
  const next = (cache.get(guildId) ?? []).find((boost) => boost.startsAt > now);
  return next
    ? `⚡ 次のXPアップ: ${formatShortDateTime(next.startsAt)}〜 XP${formatPercent(next.percent)}${next.label ? `「${next.label}」` : ''}`
    : null;
};

/**
 * 開始の入力を読む（日本時間）。空欄・「今」「今すぐ」なら now。
 * 「10/31 20:00」「10/31 20」「2026/10/31 20:00」の形。年を省いたときは、少し前の日付なら来年とみなす。
 * 読めなければ理由（文字列）を返す
 */
export const parseBoostStart = (input: string, now: Date): Date | string => {
  const text = input.normalize('NFKC').trim();
  if (text === '' || text === '今' || text === '今すぐ') return now;
  const start = parseJstDateTime(text, now);
  if (start === 'format') return '開始は「10/31 20:00」の形で入力してください（空欄なら今すぐ始まります）。';
  if (start === 'invalid') return `「${text}」という日時はありません。`;
  if (start.getTime() < now.getTime() - PAST_GRACE_MS) return `${formatShortDateTime(start)} はもう過ぎています。`;
  if (start.getTime() > now.getTime() + MAX_START_DAYS * DAY_MS) return `開始は${MAX_START_DAYS}日先までにしてください。`;
  return start.getTime() < now.getTime() ? now : start;
};
