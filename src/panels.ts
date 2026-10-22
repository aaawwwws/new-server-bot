import { createHash } from 'node:crypto';
import type { ActionRowBuilder, ButtonBuilder, EmbedBuilder, Message } from 'discord.js';
import { pool } from './db.js';

// 設置したパネルを覚えておき、Botの起動時に最新の内容へ作り直すためのもの

export type PanelKind = 'progress' | 'content' | 'profile' | 'settings' | 'admin' | 'recruit';

/** パネルのメッセージの中身（設置するときと、作り直すときで共通） */
export interface PanelPayload {
  embeds: EmbedBuilder[];
  components: ActionRowBuilder<ButtonBuilder>[];
}

export interface StoredPanel {
  messageId: string;
  channelId: string;
  kind: PanelKind;
  payloadHash: string | null;
}

/** 中身が変わったかを比べるための値 */
export const hashPanelPayload = (payload: PanelPayload): string =>
  createHash('sha256')
    .update(JSON.stringify({ embeds: payload.embeds.map((e) => e.toJSON()), components: payload.components.map((c) => c.toJSON()) }))
    .digest('hex');

/**
 * 設置したパネルを覚える。payload がないとき（前から置いてあったパネルを見つけたとき）は、次の起動で必ず作り直す。
 * 覚えられなくてもパネルはそのまま使えるので、失敗してもエラーにはしない（自動で作り直されなくなるだけ）
 */
export const rememberPanel = async (message: Message, kind: PanelKind, payload?: PanelPayload): Promise<void> => {
  try {
    if (!message.inGuild()) return;
    await pool.query(
      `INSERT INTO panels (message_id, guild_id, channel_id, kind, payload_hash)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (message_id) DO UPDATE SET kind = EXCLUDED.kind, payload_hash = EXCLUDED.payload_hash`,
      [message.id, message.guildId, message.channelId, kind, payload ? hashPanelPayload(payload) : null],
    );
  } catch (error) {
    console.error('設置したパネルを覚えられませんでした:', error);
  }
};

export const listPanels = async (guildId: string): Promise<StoredPanel[]> => {
  const { rows } = await pool.query<{ message_id: string; channel_id: string; kind: PanelKind; payload_hash: string | null }>(
    'SELECT message_id, channel_id, kind, payload_hash FROM panels WHERE guild_id = $1 ORDER BY created_at',
    [guildId],
  );
  return rows.map((row) => ({ messageId: row.message_id, channelId: row.channel_id, kind: row.kind, payloadHash: row.payload_hash }));
};

export const updatePanelHash = async (messageId: string, payload: PanelPayload): Promise<void> => {
  await pool.query('UPDATE panels SET payload_hash = $2 WHERE message_id = $1', [messageId, hashPanelPayload(payload)]);
};

/** 消されたパネルは覚えておく必要がないので外す */
export const forgetPanel = async (messageId: string): Promise<void> => {
  await pool.query('DELETE FROM panels WHERE message_id = $1', [messageId]);
};
