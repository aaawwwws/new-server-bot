import { pool } from './db.js';

// 行動ログ・発言・VCの出入りの記録（DB）。検索・CSV出力と、再起動をまたいだ削除ログ・滞在時間に使う

/** 発言はこの日数で消す（ほかの記録より中身が多く、個人的な内容も含むので短めにする） */
export const MESSAGE_RETENTION_DAYS = 30;
/** 行動ログとVCの出入りは、この日数で消す */
export const LOG_RETENTION_DAYS = 365;

// ---- 行動ログ

export interface ActivityLogEntry {
  guildId: string;
  kind: string;
  title: string;
  text: string;
  actorId: string | null;
  actorName: string | null;
  targetId: string | null;
  targetName: string | null;
  channelId: string | null;
  details: { name: string; value: string }[];
}

export const saveActivityLog = async (entry: ActivityLogEntry): Promise<void> => {
  await pool.query(
    `INSERT INTO activity_logs (guild_id, kind, title, text, actor_id, actor_name, target_id, target_name, channel_id, details)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb)`,
    [
      entry.guildId,
      entry.kind,
      entry.title,
      entry.text,
      entry.actorId,
      entry.actorName,
      entry.targetId,
      entry.targetName,
      entry.channelId,
      JSON.stringify(entry.details),
    ],
  );
};

// ---- 発言

export interface StoredMessage {
  messageId: string;
  channelId: string;
  authorId: string;
  authorName: string;
  content: string;
  attachments: string[];
  createdAt: Date;
}

interface MessageRow {
  message_id: string;
  channel_id: string;
  author_id: string;
  author_name: string;
  content: string;
  attachments: string[];
  created_at: Date;
}

const toStoredMessage = (row: MessageRow): StoredMessage => ({
  messageId: row.message_id,
  channelId: row.channel_id,
  authorId: row.author_id,
  authorName: row.author_name,
  content: row.content,
  attachments: row.attachments,
  createdAt: row.created_at,
});

export const saveMessageLog = async (guildId: string, message: StoredMessage): Promise<void> => {
  await pool.query(
    `INSERT INTO message_logs (message_id, guild_id, channel_id, author_id, author_name, content, attachments, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     ON CONFLICT (message_id) DO NOTHING`,
    [message.messageId, guildId, message.channelId, message.authorId, message.authorName, message.content, message.attachments, message.createdAt],
  );
};

/** 編集された内容に書き換える（記録がなければ何もしない） */
export const updateMessageLog = async (messageId: string, content: string, attachments: string[]): Promise<void> => {
  await pool.query('UPDATE message_logs SET content = $2, attachments = $3, edited_at = now() WHERE message_id = $1', [
    messageId,
    content,
    attachments,
  ]);
};

export const markMessagesDeleted = async (messageIds: string[]): Promise<void> => {
  if (messageIds.length === 0) return;
  await pool.query('UPDATE message_logs SET deleted_at = now() WHERE message_id = ANY($1::text[])', [messageIds]);
};

/** いちばん古い発言の記録の時刻（記録がなければ null） */
export const firstRecordedMessageAt = async (guildId: string): Promise<Date | null> => {
  const { rows } = await pool.query<{ first: Date | null }>('SELECT min(created_at) AS first FROM message_logs WHERE guild_id = $1', [
    guildId,
  ]);
  return rows[0]?.first ?? null;
};

export const findMessageLogs = async (messageIds: string[]): Promise<Map<string, StoredMessage>> => {
  if (messageIds.length === 0) return new Map();
  const { rows } = await pool.query<MessageRow>(
    `SELECT message_id, channel_id, author_id, author_name, content, attachments, created_at
       FROM message_logs WHERE message_id = ANY($1::text[])`,
    [messageIds],
  );
  return new Map(rows.map((row) => [row.message_id, toStoredMessage(row)]));
};

// ---- VCの出入り

export interface OpenVoiceSession {
  id: string;
  userId: string;
  channelId: string;
  joinedAt: Date;
  startEstimated: boolean;
}

interface VoiceSessionRow {
  id: string;
  user_id: string;
  channel_id: string;
  joined_at: Date;
  start_estimated: boolean;
}

const toOpenSession = (row: VoiceSessionRow): OpenVoiceSession => ({
  id: row.id,
  userId: row.user_id,
  channelId: row.channel_id,
  joinedAt: row.joined_at,
  startEstimated: row.start_estimated,
});

export const openVoiceSession = async (
  guildId: string,
  userId: string,
  userName: string,
  channelId: string,
  joinedAt: Date,
  startEstimated = false,
): Promise<void> => {
  await pool.query(
    `INSERT INTO voice_sessions (guild_id, user_id, user_name, channel_id, joined_at, start_estimated)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [guildId, userId, userName, channelId, joinedAt, startEstimated],
  );
};

/** その人の、まだ終わっていない記録を終わらせる。終わらせた記録（あれば）を返す */
export const closeVoiceSession = async (guildId: string, userId: string, leftAt: Date): Promise<OpenVoiceSession | null> => {
  const { rows } = await pool.query<VoiceSessionRow>(
    `UPDATE voice_sessions SET left_at = $3
      WHERE guild_id = $1 AND user_id = $2 AND left_at IS NULL
      RETURNING id, user_id, channel_id, joined_at, start_estimated`,
    [guildId, userId, leftAt],
  );
  // 何かの理由で複数残っていたら、一番古いもの（いちばん長く入っていた分）を返す
  const sorted = rows.map(toOpenSession).sort((a, b) => a.joinedAt.getTime() - b.joinedAt.getTime());
  return sorted[0] ?? null;
};

export const listOpenVoiceSessions = async (guildId: string): Promise<OpenVoiceSession[]> => {
  const { rows } = await pool.query<VoiceSessionRow>(
    `SELECT id, user_id, channel_id, joined_at, start_estimated FROM voice_sessions WHERE guild_id = $1 AND left_at IS NULL`,
    [guildId],
  );
  return rows.map(toOpenSession);
};

export const closeVoiceSessionById = async (id: string, leftAt: Date): Promise<void> => {
  await pool.query('UPDATE voice_sessions SET left_at = $2 WHERE id = $1', [id, leftAt]);
};

// ---- 古い記録の片付け

export interface RecentLog {
  title: string;
  text: string;
  createdAt: Date;
}

/** その人が実行した・対象になった行動ログ（新しい順） */
export const listRecentLogsFor = async (guildId: string, userId: string, limit: number): Promise<RecentLog[]> => {
  const { rows } = await pool.query<{ title: string; text: string; created_at: Date }>(
    `SELECT title, text, created_at FROM activity_logs
      WHERE guild_id = $1 AND (actor_id = $2 OR target_id = $2) AND kind <> 'error'
      ORDER BY created_at DESC LIMIT $3`,
    [guildId, userId, limit],
  );
  return rows.map((row) => ({ title: row.title, text: row.text, createdAt: row.created_at }));
};

/** 参加したときのログに残した、使った招待リンク（記録がなければ null） */
export const findJoinInvite = async (guildId: string, userId: string): Promise<string | null> => {
  const { rows } = await pool.query<{ details: { name: string; value: string }[] }>(
    `SELECT details FROM activity_logs
      WHERE guild_id = $1 AND kind = 'join' AND (actor_id = $2 OR target_id = $2)
      ORDER BY created_at DESC LIMIT 1`,
    [guildId, userId],
  );
  return rows[0]?.details.find((field) => field.name.includes('招待リンク'))?.value ?? null;
};

/** from〜to の間の、種類ごとのログの数（管理レポート用） */
export const countLogsByKind = async (guildId: string, kinds: string[], from: Date, to: Date): Promise<Map<string, number>> => {
  const { rows } = await pool.query<{ kind: string; count: number }>(
    `SELECT kind, count(*)::int AS count FROM activity_logs
      WHERE guild_id = $1 AND kind = ANY($2) AND created_at >= $3 AND created_at < $4
      GROUP BY kind`,
    [guildId, kinds, from, to],
  );
  return new Map(rows.map((row) => [row.kind, row.count]));
};

export const deleteOldLogs = async (now: Date = new Date()): Promise<{ messages: number; logs: number; voice: number }> => {
  const day = 24 * 60 * 60 * 1000;
  const messageLimit = new Date(now.getTime() - MESSAGE_RETENTION_DAYS * day);
  const logLimit = new Date(now.getTime() - LOG_RETENTION_DAYS * day);
  const messages = await pool.query('DELETE FROM message_logs WHERE created_at < $1', [messageLimit]);
  const logs = await pool.query('DELETE FROM activity_logs WHERE created_at < $1', [logLimit]);
  const voice = await pool.query('DELETE FROM voice_sessions WHERE joined_at < $1 AND left_at IS NOT NULL', [logLimit]);
  return { messages: messages.rowCount ?? 0, logs: logs.rowCount ?? 0, voice: voice.rowCount ?? 0 };
};
