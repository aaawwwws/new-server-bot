import { pool } from './db.js';

// やりたいコンテンツの「そのほか」の一覧・メンバーが選んだもの・設置したパネル。
// 選んだものは item_key で持つ（「d<コンテンツファインダーのID>」がゲームのコンテンツ、「c<want_items の id>」がそのほか）

export interface WantItem {
  /** DBの番号（文字列のまま扱う） */
  id: string;
  name: string;
  /** 選択肢に付ける絵文字（なければ null） */
  emoji: string | null;
  position: number;
}

export const listWantItems = async (guildId: string): Promise<WantItem[]> => {
  const { rows } = await pool.query<WantItem>(
    'SELECT id::text AS id, name, emoji, position FROM want_items WHERE guild_id = $1 ORDER BY position, id',
    [guildId],
  );
  return rows;
};

/** 一覧が空なら、決まった一覧を入れる（パネルを初めて置いたとき） */
export const seedWantItems = async (guildId: string, items: readonly { name: string; emoji: string }[]): Promise<boolean> => {
  const { rowCount } = await pool.query(
    `INSERT INTO want_items (guild_id, name, emoji, position)
     SELECT $1, item.name, item.emoji, item.position
       FROM unnest($2::text[], $3::text[]) WITH ORDINALITY AS item(name, emoji, position)
      WHERE NOT EXISTS (SELECT 1 FROM want_items WHERE guild_id = $1)`,
    [guildId, items.map((item) => item.name), items.map((item) => item.emoji)],
  );
  return (rowCount ?? 0) > 0;
};

/** 一覧の最後に足す。同じ名前がもうあれば 'duplicate' */
export const addWantItem = async (guildId: string, name: string, emoji: string | null): Promise<WantItem | 'duplicate'> => {
  const { rows } = await pool.query<{ id: string; position: number }>(
    `INSERT INTO want_items (guild_id, name, emoji, position)
     VALUES ($1, $2, $3, (SELECT COALESCE(max(position), 0) + 1 FROM want_items WHERE guild_id = $1))
     ON CONFLICT (guild_id, name) DO NOTHING
     RETURNING id::text AS id, position`,
    [guildId, name, emoji],
  );
  const [row] = rows;
  return row ? { id: row.id, name, emoji, position: row.position } : 'duplicate';
};

/** 一覧から消す（選んでいた人の選択も消す）。もうなければ null */
export const deleteWantItem = async (guildId: string, itemId: string): Promise<WantItem | null> => {
  const { rows } = await pool.query<WantItem>(
    'DELETE FROM want_items WHERE guild_id = $1 AND id = $2::bigint RETURNING id::text AS id, name, emoji, position',
    [guildId, itemId],
  );
  const [removed] = rows;
  if (removed) await pool.query('DELETE FROM want_votes WHERE guild_id = $1 AND item_key = $2', [guildId, `c${removed.id}`]);
  return removed ?? null;
};

/** 選ばれているものごとの、選んだ人（選んだ順） */
export const listWantVotes = async (guildId: string): Promise<Map<string, string[]>> => {
  const { rows } = await pool.query<{ item_key: string; user_id: string }>(
    'SELECT item_key, user_id FROM want_votes WHERE guild_id = $1 ORDER BY created_at, user_id',
    [guildId],
  );
  const votes = new Map<string, string[]>();
  for (const row of rows) votes.set(row.item_key, [...(votes.get(row.item_key) ?? []), row.user_id]);
  return votes;
};

/** その人が選んでいるもの */
export const listMemberWants = async (guildId: string, userId: string): Promise<string[]> => {
  const { rows } = await pool.query<{ item_key: string }>('SELECT item_key FROM want_votes WHERE guild_id = $1 AND user_id = $2', [guildId, userId]);
  return rows.map((row) => row.item_key);
};

/**
 * 選択メニュー1つ分（scope）の選択を置き換える。scope の外の選択はそのまま。
 * 前から選んでいたものは、選んだ順を変えない
 */
export const replaceMemberWants = async (guildId: string, userId: string, scope: string[], selected: string[]): Promise<void> => {
  const chosen = selected.filter((key) => scope.includes(key));
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('DELETE FROM want_votes WHERE guild_id = $1 AND user_id = $2 AND item_key = ANY($3::text[]) AND NOT (item_key = ANY($4::text[]))', [
      guildId,
      userId,
      scope,
      chosen,
    ]);
    await client.query(
      `INSERT INTO want_votes (guild_id, user_id, item_key)
       SELECT $1, $2, key FROM unnest($3::text[]) AS key
       ON CONFLICT DO NOTHING`,
      [guildId, userId, chosen],
    );
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
};

/** その人の選択を全部消す */
export const clearMemberWants = async (guildId: string, userId: string): Promise<void> => {
  await pool.query('DELETE FROM want_votes WHERE guild_id = $1 AND user_id = $2', [guildId, userId]);
};

/** 全員の選択を消す。消した数を返す */
export const resetWantVotes = async (guildId: string): Promise<number> => {
  const { rowCount } = await pool.query('DELETE FROM want_votes WHERE guild_id = $1', [guildId]);
  return rowCount ?? 0;
};

// ---- 設置したパネル

export const addWantPanel = async (guildId: string, channelId: string, messageId: string): Promise<void> => {
  await pool.query('INSERT INTO want_panels (message_id, guild_id, channel_id) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING', [messageId, guildId, channelId]);
};

export const listWantPanels = async (guildId: string): Promise<{ messageId: string; channelId: string }[]> => {
  const { rows } = await pool.query<{ message_id: string; channel_id: string }>(
    'SELECT message_id, channel_id FROM want_panels WHERE guild_id = $1 ORDER BY created_at',
    [guildId],
  );
  return rows.map((row) => ({ messageId: row.message_id, channelId: row.channel_id }));
};

export const forgetWantPanel = async (messageId: string): Promise<void> => {
  await pool.query('DELETE FROM want_panels WHERE message_id = $1', [messageId]);
};
