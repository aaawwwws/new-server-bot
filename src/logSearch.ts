import { AttachmentBuilder, EmbedBuilder, channelMention, escapeMarkdown, userMention, type Guild } from 'discord.js';
import { pool } from './db.js';
import { formatDuration } from './duration.js';
import { formatFullDateTime, formatShortDateTime, jstDay } from './jst.js';
import { MESSAGE_RETENTION_DAYS } from './logStore.js';
import { nameById, replaceMentions } from './names.js';

// 残しておいた行動ログ・発言・VCの出入りを、期間・人・キーワードで探す（管理者用）。一覧で見るか、CSVで出す

export type LogSearchType = 'all' | 'activity' | 'message' | 'voice';

export const LOG_SEARCH_TYPES: { value: LogSearchType; label: string }[] = [
  { value: 'all', label: 'すべて' },
  { value: 'activity', label: '行動ログ（ログチャンネルに出たもの）' },
  { value: 'message', label: '発言' },
  { value: 'voice', label: 'VCの出入り' },
];

export interface LogSearchFilter {
  type: LogSearchType;
  /** この人が実行した・対象になったもの（null なら全員） */
  userId: string | null;
  /** 何日前まで遡るか */
  days: number;
  /** 見出し・内容に含まれる言葉（VCの出入りには使わない） */
  keyword: string | null;
}

export interface LogRow {
  at: Date;
  source: 'activity' | 'message' | 'voice';
  title: string;
  userId: string | null;
  userName: string | null;
  targetId: string | null;
  targetName: string | null;
  channelId: string | null;
  text: string;
  /** 行動ログの詳しい内容（「見出し: 内容」） */
  details: string;
}

const SOURCE_LABELS: Record<LogRow['source'], string> = { activity: '行動ログ', message: '発言', voice: 'VC' };
/** 一覧に出す件数 */
export const LIST_LIMIT = 15;
/** CSVに出す件数の上限 */
export const CSV_LIMIT = 10_000;
const MAX_LINE_LENGTH = 180;

export const toSearchType = (value: string | null | undefined): LogSearchType =>
  LOG_SEARCH_TYPES.some((type) => type.value === value) ? (value as LogSearchType) : 'all';

/** 条件に合うものを新しい順に limit 件まで。total は条件に合う全部の件数 */
export const searchLogs = async (guildId: string, filter: LogSearchFilter, limit: number): Promise<{ rows: LogRow[]; total: number }> => {
  const since = new Date(Date.now() - filter.days * 24 * 60 * 60 * 1000);
  const pattern = filter.keyword ? `%${filter.keyword.replace(/[\\%_]/g, (c) => `\\${c}`)}%` : null;
  const wants = (source: LogRow['source']) => filter.type === 'all' || filter.type === source;
  const results = await Promise.all([
    wants('activity') ? searchActivity(guildId, since, filter.userId, pattern, limit) : empty(),
    wants('message') ? searchMessages(guildId, since, filter.userId, pattern, limit) : empty(),
    // VCの出入りにはキーワードがないので、キーワードで探すときは出さない
    wants('voice') && !pattern ? searchVoice(guildId, since, filter.userId, limit) : empty(),
  ]);
  const rows = results
    .flatMap((result) => result.rows)
    .sort((a, b) => b.at.getTime() - a.at.getTime())
    .slice(0, limit);
  return { rows, total: results.reduce((sum, result) => sum + result.total, 0) };
};

const empty = async (): Promise<{ rows: LogRow[]; total: number }> => ({ rows: [], total: 0 });

const searchActivity = async (guildId: string, since: Date, userId: string | null, pattern: string | null, limit: number) => {
  const where = `guild_id = $1 AND created_at >= $2
    AND ($3::text IS NULL OR actor_id = $3 OR target_id = $3)
    AND ($4::text IS NULL OR title ILIKE $4 OR text ILIKE $4 OR details::text ILIKE $4)`;
  const params = [guildId, since, userId, pattern];
  const [{ rows }, count] = await Promise.all([
    pool.query<{
      created_at: Date;
      title: string;
      text: string;
      actor_id: string | null;
      actor_name: string | null;
      target_id: string | null;
      target_name: string | null;
      channel_id: string | null;
      details: { name: string; value: string }[];
    }>(
      `SELECT created_at, title, text, actor_id, actor_name, target_id, target_name, channel_id, details
         FROM activity_logs WHERE ${where} ORDER BY created_at DESC LIMIT $5`,
      [...params, limit],
    ),
    countRows('activity_logs', where, params),
  ]);
  return {
    total: count,
    rows: rows.map((row): LogRow => ({
      at: row.created_at,
      source: 'activity',
      title: row.title,
      userId: row.actor_id,
      userName: row.actor_name,
      targetId: row.target_id,
      targetName: row.target_name,
      channelId: row.channel_id,
      text: row.text,
      details: row.details.map((detail) => `${detail.name}: ${detail.value}`).join(' / '),
    })),
  };
};

const searchMessages = async (guildId: string, since: Date, userId: string | null, pattern: string | null, limit: number) => {
  const where = `guild_id = $1 AND created_at >= $2 AND ($3::text IS NULL OR author_id = $3) AND ($4::text IS NULL OR content ILIKE $4)`;
  const params = [guildId, since, userId, pattern];
  const [{ rows }, count] = await Promise.all([
    pool.query<{
      created_at: Date;
      author_id: string;
      author_name: string;
      channel_id: string;
      content: string;
      attachments: string[];
      edited_at: Date | null;
      deleted_at: Date | null;
    }>(
      `SELECT created_at, author_id, author_name, channel_id, content, attachments, edited_at, deleted_at
         FROM message_logs WHERE ${where} ORDER BY created_at DESC LIMIT $5`,
      [...params, limit],
    ),
    countRows('message_logs', where, params),
  ]);
  return {
    total: count,
    rows: rows.map((row): LogRow => ({
      at: row.created_at,
      source: 'message',
      title: ['発言', ...(row.edited_at ? ['編集あり'] : []), ...(row.deleted_at ? ['削除済み'] : [])].join('・'),
      userId: row.author_id,
      userName: row.author_name,
      targetId: null,
      targetName: null,
      channelId: row.channel_id,
      text: [row.content || '（本文なし）', ...(row.attachments.length > 0 ? [`📎 ${row.attachments.join('、')}`] : [])].join(' '),
      details: '',
    })),
  };
};

const searchVoice = async (guildId: string, since: Date, userId: string | null, limit: number) => {
  const where = `guild_id = $1 AND joined_at >= $2 AND ($3::text IS NULL OR user_id = $3)`;
  const params = [guildId, since, userId];
  const [{ rows }, count] = await Promise.all([
    pool.query<{ joined_at: Date; left_at: Date | null; user_id: string; user_name: string; channel_id: string; start_estimated: boolean }>(
      `SELECT joined_at, left_at, user_id, user_name, channel_id, start_estimated
         FROM voice_sessions WHERE ${where} ORDER BY joined_at DESC LIMIT $4`,
      [...params, limit],
    ),
    countRows('voice_sessions', where, params),
  ]);
  return {
    total: count,
    rows: rows.map((row): LogRow => {
      const until = row.left_at ? formatShortDateTime(row.left_at) : '今も入っている';
      const stayed = row.left_at ? `（${formatDuration(row.left_at.getTime() - row.joined_at.getTime())}${row.start_estimated ? '以上' : ''}）` : '';
      return {
        at: row.joined_at,
        source: 'voice',
        title: 'VCの出入り',
        userId: row.user_id,
        userName: row.user_name,
        targetId: null,
        targetName: null,
        channelId: row.channel_id,
        text: `${formatShortDateTime(row.joined_at)}${row.start_estimated ? '頃' : ''} 〜 ${until}${stayed}`,
        details: '',
      };
    }),
  };
};

const countRows = async (table: string, where: string, params: unknown[]): Promise<number> => {
  const { rows } = await pool.query<{ count: string }>(`SELECT count(*) AS count FROM ${table} WHERE ${where}`, params);
  return Number(rows[0]?.count ?? 0);
};

/** 探した条件の説明（一覧の上とログに出す） */
export const describeFilter = (filter: LogSearchFilter): string =>
  [
    `種類: ${LOG_SEARCH_TYPES.find((type) => type.value === filter.type)?.label ?? 'すべて'}`,
    `人: ${filter.userId ? userMention(filter.userId) : '全員'}`,
    `期間: 過去${filter.days}日`,
    ...(filter.keyword ? [`キーワード: 「${filter.keyword}」`] : []),
  ].join(' ・ ');

/** 一覧の埋め込み（新しい順） */
export const buildSearchEmbed = (guild: Guild, filter: LogSearchFilter, rows: LogRow[], total: number): EmbedBuilder => {
  const lines = rows.map((row) => {
    // 埋め込みのメンションは正しく出ないことがあるので、残しておいた名前（なければ今の名前）にする
    const who = row.userId ? (row.userName ? `**${escapeMarkdown(row.userName)}**` : nameById(guild, row.userId)) : '';
    const where = row.channelId ? channelMention(row.channelId) : '';
    const head = `\`${formatShortDateTime(row.at)}\` **[${SOURCE_LABELS[row.source]}${row.source === 'activity' ? `: ${row.title}` : ''}]**`;
    const body = row.source === 'activity' ? replaceMentions(guild, row.text) : `${where} ${who}: ${row.text}`;
    return clip(`${head} ${body.replace(/\n/g, ' ')}`, MAX_LINE_LENGTH);
  });
  const notes = [
    ...(filter.days > MESSAGE_RETENTION_DAYS && filter.type !== 'activity' && filter.type !== 'voice'
      ? [`※ 発言は${MESSAGE_RETENTION_DAYS}日で消しているので、それより前の発言は出ません。`]
      : []),
    ...(filter.keyword && (filter.type === 'all' || filter.type === 'voice') ? ['※ キーワードで探すときは、VCの出入りは出しません。'] : []),
  ];
  return new EmbedBuilder()
    .setColor(0x607d8b)
    .setTitle(`🔎 ログ検索（${total}件）`)
    .setDescription(
      [replaceMentions(guild, describeFilter(filter)), ...notes, '', ...(lines.length > 0 ? lines : ['見つかりませんでした。'])].join('\n').slice(0, 4096),
    )
    .setFooter({ text: total > rows.length ? `新しい順に${rows.length}件だけ出しています。すべて見るには CSV で出してください` : '新しい順' });
};

/** CSV（Excelで文字化けしないよう、先頭にBOMを付ける）。メンションは名前に置き換える */
export const buildCsv = (guild: Guild, rows: LogRow[]): AttachmentBuilder => {
  const header = ['日時（日本時間）', '種類', '見出し', 'ユーザー', 'ユーザーID', '対象', '対象ID', 'チャンネル', '内容', '詳細'];
  const body = rows.map((row) => [
    formatFullDateTime(row.at),
    SOURCE_LABELS[row.source],
    row.title,
    row.userName ?? (row.userId ? nameOf(guild, row.userId) : ''),
    row.userId ?? '',
    row.targetName ?? (row.targetId ? nameOf(guild, row.targetId) : ''),
    row.targetId ?? '',
    row.channelId ? `#${guild.channels.cache.get(row.channelId)?.name ?? row.channelId}` : '',
    plainText(guild, row.text),
    plainText(guild, row.details),
  ]);
  const csv = [header, ...body].map((cells) => cells.map(csvCell).join(',')).join('\r\n');
  return new AttachmentBuilder(Buffer.from(`﻿${csv}`, 'utf8'), { name: `logs-${jstDay()}.csv` });
};

const csvCell = (value: string): string => (/[",\r\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value);

/** 「<@123>」「<#456>」「<@&789>」を、名前に置き換える（CSVでは表示されないので） */
const plainText = (guild: Guild, text: string): string =>
  text
    .replace(/<@!?(\d+)>/g, (_, id: string) => `@${nameOf(guild, id)}`)
    .replace(/<#(\d+)>/g, (_, id: string) => `#${guild.channels.cache.get(id)?.name ?? id}`)
    .replace(/<@&(\d+)>/g, (_, id: string) => `@${guild.roles.cache.get(id)?.name ?? id}`)
    .replace(/<t:(\d+)(?::[a-zA-Z])?>/g, (_, seconds: string) => formatFullDateTime(new Date(Number(seconds) * 1000)));

const nameOf = (guild: Guild, userId: string): string => {
  const member = guild.members.cache.get(userId);
  return member ? `${member.displayName}（${member.user.username}）` : userId;
};

const clip = (text: string, max: number): string => (text.length > max ? `${text.slice(0, max - 1)}…` : text);
