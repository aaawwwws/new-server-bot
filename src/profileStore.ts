import { pool } from './db.js';
import type { Profile } from './profile.js';

export interface StoredProfile {
  profile: Profile;
  /** プロフチャンネルに投稿したメッセージ（更新するときに使う） */
  channelId: string | null;
  messageId: string | null;
}

export interface Application {
  id: string;
  guildId: string;
  userId: string;
  profile: Profile;
}

/** 審査メッセージの場所 */
export interface ReviewMessageRef {
  channelId: string;
  messageId: string;
}

/** profiles と profile_applications に共通のプロフィールの列 */
interface ProfileColumns {
  character_name: string;
  comment: string;
  recent: string;
  data_center: string | null;
  world: string | null;
  start_hour: number | null;
  end_hour: number | null;
  jobs: string[];
}

interface ProfileRow extends ProfileColumns {
  channel_id: string | null;
  message_id: string | null;
}

interface ApplicationRow extends ProfileColumns {
  id: string;
  guild_id: string;
  user_id: string;
}

const PROFILE_COLUMNS = 'character_name, comment, recent, data_center, world, start_hour, end_hour, jobs';

const toProfile = (row: ProfileColumns): Profile => ({
  name: row.character_name,
  comment: row.comment,
  recent: row.recent,
  dataCenter: row.data_center,
  world: row.world,
  startHour: row.start_hour,
  endHour: row.end_hour,
  jobs: row.jobs,
});

/**
 * 登録済みのプロフィール。サーバーを抜けた人のものは返さない。
 * includeLeft にすると抜けた人のものも返す（戻ってきた人の入力欄に、前の内容を入れておくため）
 */
export const findStoredProfile = async (
  guildId: string,
  userId: string,
  { includeLeft = false }: { includeLeft?: boolean } = {},
): Promise<StoredProfile | null> => {
  const { rows } = await pool.query<ProfileRow>(
    `SELECT ${PROFILE_COLUMNS}, channel_id, message_id
       FROM profiles
      WHERE guild_id = $1 AND user_id = $2 AND ($3 OR left_at IS NULL)`,
    [guildId, userId, includeLeft],
  );
  const row = rows[0];
  if (!row) return null;

  return { profile: toProfile(row), channelId: row.channel_id, messageId: row.message_id };
};

export interface MemberProfile extends StoredProfile {
  userId: string;
}

/** サーバーにいる人の登録済みプロフィールをすべて返す（キャラクター名の順） */
export const listStoredProfiles = async (guildId: string): Promise<MemberProfile[]> => {
  const { rows } = await pool.query<ProfileRow & { user_id: string }>(
    `SELECT user_id, ${PROFILE_COLUMNS}, channel_id, message_id
       FROM profiles
      WHERE guild_id = $1 AND left_at IS NULL
      ORDER BY character_name`,
    [guildId],
  );
  return rows.map((row) => ({
    userId: row.user_id,
    profile: toProfile(row),
    channelId: row.channel_id,
    messageId: row.message_id,
  }));
};

/** サーバーを抜けた人のプロフィールを「退出済み」にする（投稿は消すので、メッセージIDも消す） */
export const markProfileLeft = async (guildId: string, userId: string): Promise<void> => {
  await pool.query(
    'UPDATE profiles SET left_at = now(), message_id = NULL WHERE guild_id = $1 AND user_id = $2 AND left_at IS NULL',
    [guildId, userId],
  );
};

/** 管理者がプロフィールを削除する */
export const deleteProfile = async (guildId: string, userId: string): Promise<void> => {
  await pool.query('DELETE FROM profiles WHERE guild_id = $1 AND user_id = $2', [guildId, userId]);
};

export interface SaveProfileParams {
  guildId: string;
  userId: string;
  profile: Profile;
  /** 登録した時点の進行度ロール名 */
  progress: string | null;
  channelId: string;
  messageId: string;
}

/** 1サーバーにつき1人1件。すでにあれば上書きする */
export const saveProfile = async ({ guildId, userId, profile, progress, channelId, messageId }: SaveProfileParams) => {
  await pool.query(
    `INSERT INTO profiles (
       guild_id, user_id, character_name, comment, recent, progress, data_center, world,
       start_hour, end_hour, jobs, channel_id, message_id
     )
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
     ON CONFLICT (guild_id, user_id) DO UPDATE SET
       character_name = EXCLUDED.character_name,
       comment        = EXCLUDED.comment,
       recent         = EXCLUDED.recent,
       progress       = EXCLUDED.progress,
       data_center    = EXCLUDED.data_center,
       world          = EXCLUDED.world,
       start_hour     = EXCLUDED.start_hour,
       end_hour       = EXCLUDED.end_hour,
       jobs           = EXCLUDED.jobs,
       channel_id     = EXCLUDED.channel_id,
       message_id     = EXCLUDED.message_id,
       left_at        = NULL,
       updated_at     = now()`,
    [
      guildId,
      userId,
      profile.name,
      profile.comment,
      profile.recent,
      progress,
      profile.dataCenter,
      profile.world,
      profile.startHour,
      profile.endHour,
      profile.jobs,
      channelId,
      messageId,
    ],
  );
};

/**
 * 申請を作る。同じ人の審査中の申請は無効（superseded）にして、
 * その審査メッセージの場所を返す（無効になったことを表示するため）
 */
export const createApplication = async (
  guildId: string,
  userId: string,
  profile: Profile,
): Promise<{ id: string; superseded: ReviewMessageRef[] }> => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const old = await client.query<{ review_channel_id: string | null; review_message_id: string | null }>(
      `UPDATE profile_applications
          SET status = 'superseded', reviewed_at = now()
        WHERE guild_id = $1 AND user_id = $2 AND status = 'pending'
        RETURNING review_channel_id, review_message_id`,
      [guildId, userId],
    );
    const created = await client.query<{ id: string }>(
      `INSERT INTO profile_applications (guild_id, user_id, ${PROFILE_COLUMNS})
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
       RETURNING id`,
      [
        guildId,
        userId,
        profile.name,
        profile.comment,
        profile.recent,
        profile.dataCenter,
        profile.world,
        profile.startHour,
        profile.endHour,
        profile.jobs,
      ],
    );
    await client.query('COMMIT');

    const superseded = old.rows.flatMap((row) =>
      row.review_channel_id && row.review_message_id
        ? [{ channelId: row.review_channel_id, messageId: row.review_message_id }]
        : [],
    );
    return { id: created.rows[0].id, superseded };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
};

export const setReviewMessage = async (id: string, { channelId, messageId }: ReviewMessageRef): Promise<void> => {
  await pool.query(
    'UPDATE profile_applications SET review_channel_id = $2, review_message_id = $3 WHERE id = $1',
    [id, channelId, messageId],
  );
};

/**
 * 審査中の申請を許可・拒否・キック・BANにする。
 * 審査中のときだけ更新するので、ほかの管理者が先に処理していたら null を返す（二重処理を防ぐ）
 */
export const decideApplication = async (
  id: string,
  status: 'approved' | 'rejected' | 'kicked' | 'banned',
  reviewerId: string,
  reason: string | null,
): Promise<Application | null> => {
  const { rows } = await pool.query<ApplicationRow>(
    `UPDATE profile_applications
        SET status = $2, reviewer_id = $3, reject_reason = $4, reviewed_at = now()
      WHERE id = $1 AND status = 'pending'
      RETURNING id, guild_id, user_id, ${PROFILE_COLUMNS}`,
    [id, status, reviewerId, reason],
  );
  const row = rows[0];
  if (!row) return null;

  return { id: row.id, guildId: row.guild_id, userId: row.user_id, profile: toProfile(row) };
};

/** 申請者がサーバーを抜けたときに、審査中の申請を無効（left）にする。その審査メッセージの場所を返す */
export const closePendingApplicationsOfLeftMember = async (guildId: string, userId: string): Promise<ReviewMessageRef[]> => {
  const { rows } = await pool.query<{ review_channel_id: string | null; review_message_id: string | null }>(
    `UPDATE profile_applications
        SET status = 'left', reviewed_at = now()
      WHERE guild_id = $1 AND user_id = $2 AND status = 'pending'
      RETURNING review_channel_id, review_message_id`,
    [guildId, userId],
  );
  return rows.flatMap((row) =>
    row.review_channel_id && row.review_message_id
      ? [{ channelId: row.review_channel_id, messageId: row.review_message_id }]
      : [],
  );
};

export interface PendingApplication {
  userId: string;
  characterName: string;
  createdAt: Date;
  review: ReviewMessageRef | null;
}

/** 審査中の申請を、届いた順に返す */
export const listPendingApplications = async (guildId: string): Promise<PendingApplication[]> => {
  const { rows } = await pool.query<{
    user_id: string;
    character_name: string;
    created_at: Date;
    review_channel_id: string | null;
    review_message_id: string | null;
  }>(
    `SELECT user_id, character_name, created_at, review_channel_id, review_message_id
       FROM profile_applications
      WHERE guild_id = $1 AND status = 'pending'
      ORDER BY created_at`,
    [guildId],
  );
  return rows.map((row) => ({
    userId: row.user_id,
    characterName: row.character_name,
    createdAt: row.created_at,
    review:
      row.review_channel_id && row.review_message_id
        ? { channelId: row.review_channel_id, messageId: row.review_message_id }
        : null,
  }));
};

/** 許可の処理が途中で失敗したときに、審査中へ戻してもう一度押せるようにする */
export const reopenApplication = async (id: string): Promise<void> => {
  await pool.query(
    `UPDATE profile_applications
        SET status = 'pending', reviewer_id = NULL, reject_reason = NULL, reviewed_at = NULL
      WHERE id = $1`,
    [id],
  );
};

export interface ApplicationCounts {
  /** 期間中に来た申請 */
  created: number;
  /** 期間中に許可した申請 */
  approved: number;
  /** 期間中に拒否した申請（キック・BANを含む） */
  rejected: number;
  /** 今の審査待ち */
  pending: number;
}

/** from〜to の間の申請の数と、今の審査待ちの数（管理レポート用） */
export const countApplications = async (guildId: string, from: Date, to: Date): Promise<ApplicationCounts> => {
  const { rows } = await pool.query<ApplicationCounts>(
    `SELECT count(*) FILTER (WHERE created_at >= $2 AND created_at < $3)::int AS created,
            count(*) FILTER (WHERE reviewed_at >= $2 AND reviewed_at < $3 AND status = 'approved')::int AS approved,
            count(*) FILTER (WHERE reviewed_at >= $2 AND reviewed_at < $3 AND status IN ('rejected', 'kicked', 'banned'))::int AS rejected,
            count(*) FILTER (WHERE status = 'pending')::int AS pending
       FROM profile_applications WHERE guild_id = $1`,
    [guildId, from, to],
  );
  return rows[0] ?? { created: 0, approved: 0, rejected: 0, pending: 0 };
};
