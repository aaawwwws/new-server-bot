import { pool } from './db.js';

// メンバーが自分で切り替える設定（自分がVCに入ったときに、Botがお知らせするか）

export interface JoinAnnounceSettings {
  /** 自分が通話を始めたとき、「通知」チャンネルで @VC に知らせるか（知らせないときは、通知なしで流す） */
  callStart: boolean;
  /** 自分がVCに入ったとき、そのVCのチャットにプロフィールを出すか */
  vcJoin: boolean;
}
export type JoinAnnounceKey = keyof JoinAnnounceSettings;

/** 設定していない人は、どちらもお知らせする（これまでどおり） */
export const DEFAULT_JOIN_ANNOUNCE: JoinAnnounceSettings = { callStart: true, vcJoin: true };

const COLUMNS: Record<JoinAnnounceKey, string> = {
  callStart: 'announce_call_start',
  vcJoin: 'announce_vc_join',
};

export const loadJoinAnnounce = async (guildId: string, userId: string): Promise<JoinAnnounceSettings> => {
  const { rows } = await pool.query<{ announce_call_start: boolean; announce_vc_join: boolean }>(
    'SELECT announce_call_start, announce_vc_join FROM member_settings WHERE guild_id = $1 AND user_id = $2',
    [guildId, userId],
  );
  const row = rows[0];
  return row ? { callStart: row.announce_call_start, vcJoin: row.announce_vc_join } : { ...DEFAULT_JOIN_ANNOUNCE };
};

/**
 * お知らせのたびに読むので、DBに届かないときはこれまでどおりお知らせする（お知らせ自体は止めない）
 */
export const loadJoinAnnounceOrDefault = (guildId: string, userId: string): Promise<JoinAnnounceSettings> =>
  loadJoinAnnounce(guildId, userId).catch((error: unknown) => {
    console.error('メンバーの設定を読めませんでした:', error);
    return { ...DEFAULT_JOIN_ANNOUNCE };
  });

export const saveJoinAnnounce = async (guildId: string, userId: string, key: JoinAnnounceKey, value: boolean): Promise<void> => {
  // 列名は上の決まった値だけなので、そのまま埋め込んでよい
  const column = COLUMNS[key];
  await pool.query(
    `INSERT INTO member_settings (guild_id, user_id, ${column}) VALUES ($1, $2, $3)
     ON CONFLICT (guild_id, user_id) DO UPDATE SET ${column} = EXCLUDED.${column}, updated_at = now()`,
    [guildId, userId, value],
  );
};
