import { pool } from './db.js';
import type { RecruitConfig, RecruitParticipant, RecruitSlot } from './recruitEngine.js';
import { findPartyType } from './recruitParty.js';

export type RecruitStatus = 'open' | 'closed' | 'cancelled' | 'finished';

export interface Recruit extends RecruitConfig {
  id: string;
  guildId: string;
  channelId: string;
  /** 募集の投稿。投稿する前は null */
  messageId: string | null;
  /** 参加者の連絡用スレッド（作れなかったら null） */
  threadId: string | null;
  hostId: string;
  title: string;
  comment: string;
  startsAt: Date;
  party: string;
  dataCenter: string | null;
  /** 投稿するときにメンションしたロール */
  mentionRoleIds: string[];
  status: RecruitStatus;
  reminded: boolean;
  /** 変更のたびに増える（「元に戻す」で、そのあとの変更を上書きしないため） */
  version: number;
}

interface RecruitRow {
  id: string;
  guild_id: string;
  channel_id: string;
  message_id: string | null;
  thread_id: string | null;
  host_id: string;
  title: string;
  comment: string;
  starts_at: Date;
  party: string;
  data_center: string | null;
  allow_duplicate_jobs: boolean;
  mention_role_ids: string[];
  slots: unknown[];
  participants: RecruitParticipant[];
  status: RecruitStatus;
  reminded: boolean;
  version: number;
}

const COLUMNS = `id, guild_id, channel_id, message_id, thread_id, host_id, title, comment, starts_at, party, data_center,
  allow_duplicate_jobs, mention_role_ids, slots, participants, status, reminded, version`;

/** 前の形（枠に参加者を直接入れていた頃）の古い枠 */
interface LegacySlot {
  key: string;
  role?: RecruitSlot['role'];
  requiredJob?: string | null;
  external?: RecruitSlot['external'];
  closed?: RecruitSlot['closed'];
  userId?: string | null;
  job?: string | null;
}

/** 前の形で保存された募集も読めるようにする（枠に入っていた人は、その枠だけを選んだ参加者として扱う） */
const normalize = (party: string, rawSlots: unknown[], rawParticipants: RecruitParticipant[]) => {
  const definitions = findPartyType(party)?.slots ?? [];
  const legacy = rawSlots as LegacySlot[];
  const slots: RecruitSlot[] = legacy.map((slot) => ({
    key: slot.key,
    role: slot.role ?? definitions.find((d) => d.key === slot.key)?.role ?? 'any',
    requiredJob: slot.requiredJob ?? null,
    external: slot.external ?? null,
    closed: slot.closed ?? null,
  }));
  const participants =
    rawParticipants.length > 0
      ? rawParticipants
      : legacy.flatMap((slot, i): RecruitParticipant[] =>
          slot.userId
            ? [
                {
                  userId: slot.userId,
                  positions: [slot.key],
                  jobs: slot.job ? [slot.job] : [],
                  comment: null,
                  joinedAt: new Date(Date.UTC(2000, 0, 1, 0, 0, i)).toISOString(),
                  prefilled: false,
                  slot: slot.key,
                  job: slot.job ?? null,
                },
              ]
            : [],
        );
  return { slots, participants };
};

const toRecruit = (row: RecruitRow): Recruit => ({
  id: row.id,
  guildId: row.guild_id,
  channelId: row.channel_id,
  messageId: row.message_id,
  threadId: row.thread_id,
  hostId: row.host_id,
  title: row.title,
  comment: row.comment,
  startsAt: row.starts_at,
  party: row.party,
  dataCenter: row.data_center,
  allowDuplicateJobs: row.allow_duplicate_jobs,
  mentionRoleIds: row.mention_role_ids,
  ...normalize(row.party, row.slots, row.participants),
  status: row.status,
  reminded: row.reminded,
  version: row.version,
});

export type NewRecruit = Omit<Recruit, 'id' | 'messageId' | 'threadId' | 'status' | 'version'>;

export const createRecruit = async (recruit: NewRecruit): Promise<Recruit> => {
  const { rows } = await pool.query<RecruitRow>(
    `INSERT INTO recruits (guild_id, channel_id, host_id, title, comment, starts_at, party, data_center, allow_duplicate_jobs,
                           mention_role_ids, slots, participants, reminded)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::jsonb, $12::jsonb, $13)
     RETURNING ${COLUMNS}`,
    [
      recruit.guildId,
      recruit.channelId,
      recruit.hostId,
      recruit.title,
      recruit.comment,
      recruit.startsAt,
      recruit.party,
      recruit.dataCenter,
      recruit.allowDuplicateJobs,
      recruit.mentionRoleIds,
      JSON.stringify(recruit.slots),
      JSON.stringify(recruit.participants),
      recruit.reminded,
    ],
  );
  const [row] = rows;
  if (!row) throw new Error('募集を保存できませんでした');
  return toRecruit(row);
};

export const findRecruit = async (id: string): Promise<Recruit | null> => {
  const { rows } = await pool.query<RecruitRow>(`SELECT ${COLUMNS} FROM recruits WHERE id = $1`, [id]);
  const [row] = rows;
  return row ? toRecruit(row) : null;
};

/** 変わった内容をまとめて保存し、version を1つ増やす（recruit.version も新しい値になる） */
export const saveRecruit = async (recruit: Recruit): Promise<void> => {
  const { rows } = await pool.query<{ version: number }>(
    `UPDATE recruits
        SET message_id = $2, thread_id = $3, host_id = $4, title = $5, comment = $6, starts_at = $7, data_center = $8,
            allow_duplicate_jobs = $9, mention_role_ids = $10, slots = $11::jsonb, participants = $12::jsonb,
            status = $13, reminded = $14, version = version + 1
      WHERE id = $1
      RETURNING version`,
    [
      recruit.id,
      recruit.messageId,
      recruit.threadId,
      recruit.hostId,
      recruit.title,
      recruit.comment,
      recruit.startsAt,
      recruit.dataCenter,
      recruit.allowDuplicateJobs,
      recruit.mentionRoleIds,
      JSON.stringify(recruit.slots),
      JSON.stringify(recruit.participants),
      recruit.status,
      recruit.reminded,
    ],
  );
  recruit.version = rows[0]?.version ?? recruit.version + 1;
};

/** 開始前のお知らせをまだ送っていない、before までに始まる募集 */
export const listRecruitsToRemind = async (before: Date): Promise<Recruit[]> => {
  const { rows } = await pool.query<RecruitRow>(
    `SELECT ${COLUMNS} FROM recruits WHERE status IN ('open', 'closed') AND NOT reminded AND starts_at <= $1`,
    [before],
  );
  return rows.map(toRecruit);
};

/** before より前に始まった、まだ終わっていない募集 */
export const listRecruitsToFinish = async (before: Date): Promise<Recruit[]> => {
  const { rows } = await pool.query<RecruitRow>(
    `SELECT ${COLUMNS} FROM recruits WHERE status IN ('open', 'closed') AND starts_at <= $1`,
    [before],
  );
  return rows.map(toRecruit);
};

/** 募集中・締切の募集（guildId を省くと全サーバー）。開始が早い順 */
export const listActiveRecruits = async (guildId?: string): Promise<Recruit[]> => {
  const { rows } = await pool.query<RecruitRow>(
    `SELECT ${COLUMNS} FROM recruits WHERE status IN ('open', 'closed') AND ($1::text IS NULL OR guild_id = $1) ORDER BY starts_at`,
    [guildId ?? null],
  );
  return rows.map(toRecruit);
};

// ---- 作成途中の募集（下書き）

export interface RecruitDraft extends RecruitConfig {
  /** 投稿するチャンネル（パネルのあるチャンネル） */
  channelId: string;
  title: string;
  comment: string;
  party: string;
  dataCenter: string | null;
  mentionRoleIds: string[];
  /** 開始日（日本時間の「2026-10-22」）・時・分。startNow なら今すぐ */
  date: string | null;
  hour: number | null;
  minute: number | null;
  startNow: boolean;
}

/** 下書きはこの時間で消す（作りかけのまま放っておかれたもの） */
const DRAFT_TTL_HOURS = 24;

export const loadDraft = async (guildId: string, userId: string): Promise<RecruitDraft | null> => {
  const { rows } = await pool.query<{ data: RecruitDraft }>(
    `SELECT data FROM recruit_drafts WHERE guild_id = $1 AND user_id = $2 AND updated_at > now() - make_interval(hours => $3)`,
    [guildId, userId, DRAFT_TTL_HOURS],
  );
  return rows[0]?.data ?? null;
};

export const saveDraft = async (guildId: string, userId: string, draft: RecruitDraft): Promise<void> => {
  await pool.query(
    `INSERT INTO recruit_drafts (guild_id, user_id, data) VALUES ($1, $2, $3::jsonb)
     ON CONFLICT (guild_id, user_id) DO UPDATE SET data = EXCLUDED.data, updated_at = now()`,
    [guildId, userId, JSON.stringify(draft)],
  );
};

export const deleteDraft = async (guildId: string, userId: string): Promise<void> => {
  await pool.query('DELETE FROM recruit_drafts WHERE guild_id = $1 AND user_id = $2', [guildId, userId]);
};

// ---- テンプレート

export interface RecruitTemplateData {
  title: string;
  comment: string;
  party: string;
  dataCenter: string | null;
  allowDuplicateJobs: boolean;
  mentionRoleIds: string[];
  /** 枠ごとのジョブ指定（枠 → ジョブ） */
  requiredJobs: Record<string, string>;
  hour: number | null;
  minute: number | null;
}

export interface RecruitTemplate {
  id: string;
  name: string;
  createdBy: string;
  data: RecruitTemplateData;
}

/** テンプレートは1サーバーにこの数まで（選ぶメニューに入る数） */
export const MAX_TEMPLATES = 25;

export const listTemplates = async (guildId: string): Promise<RecruitTemplate[]> => {
  const { rows } = await pool.query<{ id: string; name: string; created_by: string; data: RecruitTemplateData }>(
    'SELECT id, name, created_by, data FROM recruit_templates WHERE guild_id = $1 ORDER BY name LIMIT $2',
    [guildId, MAX_TEMPLATES],
  );
  return rows.map((row) => ({ id: row.id, name: row.name, createdBy: row.created_by, data: row.data }));
};

export const countTemplates = async (guildId: string): Promise<number> => {
  const { rows } = await pool.query<{ count: string }>('SELECT count(*) AS count FROM recruit_templates WHERE guild_id = $1', [guildId]);
  return Number(rows[0]?.count ?? 0);
};

/** 同じ名前があれば上書きする */
export const saveTemplate = async (guildId: string, name: string, createdBy: string, data: RecruitTemplateData): Promise<void> => {
  await pool.query(
    `INSERT INTO recruit_templates (guild_id, name, created_by, data) VALUES ($1, $2, $3, $4::jsonb)
     ON CONFLICT (guild_id, name) DO UPDATE SET data = EXCLUDED.data, created_by = EXCLUDED.created_by`,
    [guildId, name, createdBy, JSON.stringify(data)],
  );
};

export const findTemplate = async (guildId: string, id: string): Promise<RecruitTemplate | null> => {
  const { rows } = await pool.query<{ id: string; name: string; created_by: string; data: RecruitTemplateData }>(
    'SELECT id, name, created_by, data FROM recruit_templates WHERE guild_id = $1 AND id = $2',
    [guildId, id],
  );
  const [row] = rows;
  return row ? { id: row.id, name: row.name, createdBy: row.created_by, data: row.data } : null;
};

export const deleteTemplate = async (guildId: string, id: string): Promise<void> => {
  await pool.query('DELETE FROM recruit_templates WHERE guild_id = $1 AND id = $2', [guildId, id]);
};

// ---- 募集一覧のメッセージ

export interface RecruitList {
  guildId: string;
  channelId: string;
  messageId: string;
}

export const findRecruitList = async (guildId: string): Promise<RecruitList | null> => {
  const { rows } = await pool.query<{ channel_id: string; message_id: string }>(
    'SELECT channel_id, message_id FROM recruit_lists WHERE guild_id = $1',
    [guildId],
  );
  const [row] = rows;
  return row ? { guildId, channelId: row.channel_id, messageId: row.message_id } : null;
};

export const saveRecruitList = async (list: RecruitList): Promise<void> => {
  await pool.query(
    `INSERT INTO recruit_lists (guild_id, channel_id, message_id) VALUES ($1, $2, $3)
     ON CONFLICT (guild_id) DO UPDATE SET channel_id = EXCLUDED.channel_id, message_id = EXCLUDED.message_id`,
    [list.guildId, list.channelId, list.messageId],
  );
};

export const deleteRecruitList = async (guildId: string): Promise<void> => {
  await pool.query('DELETE FROM recruit_lists WHERE guild_id = $1', [guildId]);
};
