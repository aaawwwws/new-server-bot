import type { Client } from 'discord.js';
import { pool } from './db.js';

// サーバーごとの設定（XPを入れないチャンネル）。発言・リアクションのたびにDBを読まないよう、覚えておく

/** XPを入れないチャンネル（サーバーのID → チャンネルのID） */
const excludedChannels = new Map<string, Set<string>>();

export const loadXpExcludedChannels = async (guildId: string): Promise<string[]> => {
  const { rows } = await pool.query<{ xp_excluded_channel_ids: string[] }>(
    'SELECT xp_excluded_channel_ids FROM guild_settings WHERE guild_id = $1',
    [guildId],
  );
  const ids = rows[0]?.xp_excluded_channel_ids ?? [];
  excludedChannels.set(guildId, new Set(ids));
  return ids;
};

export const saveXpExcludedChannels = async (guildId: string, channelIds: string[]): Promise<void> => {
  await pool.query(
    `INSERT INTO guild_settings (guild_id, xp_excluded_channel_ids) VALUES ($1, $2)
     ON CONFLICT (guild_id) DO UPDATE SET xp_excluded_channel_ids = EXCLUDED.xp_excluded_channel_ids, updated_at = now()`,
    [guildId, channelIds],
  );
  excludedChannels.set(guildId, new Set(channelIds));
};

/** 起動時に、全サーバーの設定を読み込む */
export const loadAllGuildSettings = async (client: Client<true>): Promise<void> => {
  for (const guild of client.guilds.cache.values()) {
    await loadXpExcludedChannels(guild.id).catch((error: unknown) => {
      console.error(`「${guild.name}」の設定を読めませんでした:`, error);
    });
  }
};

/** チャンネルの見分けに要るところだけ（スレッドなら親チャンネル、チャンネルならカテゴリーが parentId） */
interface ChannelLike {
  id: string;
  parentId?: string | null;
  parent?: { parentId?: string | null } | null;
}

/**
 * このチャンネルではXPを入れないか。チャンネル自体か、その親（スレッドの親チャンネル・カテゴリー）が選ばれていれば入れない
 */
export const isXpExcluded = (guildId: string, channel: ChannelLike | null | undefined): boolean => {
  const excluded = excludedChannels.get(guildId);
  if (!channel || !excluded || excluded.size === 0) return false;
  return [channel.id, channel.parentId, channel.parent?.parentId].some((id) => !!id && excluded.has(id));
};
