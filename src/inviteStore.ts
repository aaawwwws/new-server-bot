import type { GuildMember } from 'discord.js';
import { pool } from './db.js';
import type { UsedInvite } from './inviteTracker.js';

// 誰の招待リンクで入ったか（招待ランキング・メンバーの詳細・管理レポート用）。
// 入り直しても、最初に連れてきた人のまま（抜けて入り直してもらって数を増やすのを防ぐ）

export interface MemberInvite {
  userId: string;
  inviterId: string;
  code: string;
  joinedAt: Date;
}

interface InviteRow {
  user_id: string;
  inviter_id: string;
  invite_code: string;
  joined_at: Date;
}

const INVITE_COLUMNS = 'user_id, inviter_id, invite_code, joined_at';

const toInvite = (row: InviteRow): MemberInvite => ({
  userId: row.user_id,
  inviterId: row.inviter_id,
  code: row.invite_code,
  joinedAt: row.joined_at,
});

/** 記録する。もう記録がある人（入り直した人）は前のまま。初めての記録なら true */
export const saveMemberInvite = async (guildId: string, invite: MemberInvite): Promise<boolean> => {
  const { rowCount } = await pool.query(
    `INSERT INTO member_invites (guild_id, user_id, inviter_id, invite_code, joined_at) VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (guild_id, user_id) DO NOTHING`,
    [guildId, invite.userId, invite.inviterId, invite.code, invite.joinedAt],
  );
  return rowCount === 1;
};

/**
 * 入った人が使った招待リンクを記録する。作った人が分かるリンクだけ（サーバーのカスタムURL・作った人が不明なものは数えない）。
 * Botが入ったときと、自分で作ったリンクで入ったとき（入り直し）は数えない
 */
export const recordMemberInvite = async (member: GuildMember, invite: UsedInvite | null, joinedAt: Date = new Date()): Promise<void> => {
  if (!invite || invite.vanity || !invite.inviterId || member.user.bot || invite.inviterId === member.id) return;
  await saveMemberInvite(member.guild.id, { userId: member.id, inviterId: invite.inviterId, code: invite.code, joinedAt });
};

/** from〜to に入った人の記録（null なら区切らない） */
export const listMemberInvites = async (guildId: string, from: Date | null = null, to: Date | null = null): Promise<MemberInvite[]> => {
  const { rows } = await pool.query<InviteRow>(
    `SELECT ${INVITE_COLUMNS} FROM member_invites
      WHERE guild_id = $1 AND ($2::timestamptz IS NULL OR joined_at >= $2) AND ($3::timestamptz IS NULL OR joined_at < $3)
      ORDER BY joined_at`,
    [guildId, from, to],
  );
  return rows.map(toInvite);
};

/** その人を招待した人（記録がなければ null） */
export const findInviter = async (guildId: string, userId: string): Promise<MemberInvite | null> => {
  const { rows } = await pool.query<InviteRow>(`SELECT ${INVITE_COLUMNS} FROM member_invites WHERE guild_id = $1 AND user_id = $2`, [
    guildId,
    userId,
  ]);
  const [row] = rows;
  return row ? toInvite(row) : null;
};

// ---- Botが作った、メンバー専用の招待リンク

export interface PersonalLink {
  code: string;
  channelId: string;
}

/** その人の今の専用リンク（作り直した前のものは除く） */
export const findPersonalLink = async (guildId: string, userId: string): Promise<PersonalLink | null> => {
  const { rows } = await pool.query<{ code: string; channel_id: string }>(
    `SELECT code, channel_id FROM invite_links
      WHERE guild_id = $1 AND user_id = $2 AND retired_at IS NULL ORDER BY created_at DESC LIMIT 1`,
    [guildId, userId],
  );
  const [row] = rows;
  return row ? { code: row.code, channelId: row.channel_id } : null;
};

export const savePersonalLink = async (guildId: string, userId: string, link: PersonalLink): Promise<void> => {
  await pool.query('INSERT INTO invite_links (guild_id, code, user_id, channel_id) VALUES ($1, $2, $3, $4) ON CONFLICT DO NOTHING', [
    guildId,
    link.code,
    userId,
    link.channelId,
  ]);
};

/** 作り直したリンクを「前のもの」にする（そのリンクで入った人も、持ち主に数え続ける） */
export const retirePersonalLink = async (guildId: string, code: string): Promise<void> => {
  await pool.query('UPDATE invite_links SET retired_at = now() WHERE guild_id = $1 AND code = $2 AND retired_at IS NULL', [guildId, code]);
};

/** そのリンクの持ち主（専用リンクでなければ null） */
export const findLinkOwner = async (guildId: string, code: string): Promise<string | null> => {
  const { rows } = await pool.query<{ user_id: string }>('SELECT user_id FROM invite_links WHERE guild_id = $1 AND code = $2', [guildId, code]);
  return rows[0]?.user_id ?? null;
};

/** 使われたリンクが専用リンクなら、作成者（Bot）の代わりに持ち主を「連れてきた人」にする */
export const resolveInviteOwner = async (guildId: string, invite: UsedInvite | null): Promise<UsedInvite | null> => {
  if (!invite || invite.vanity) return invite;
  const owner = await findLinkOwner(guildId, invite.code);
  return owner ? { ...invite, inviterId: owner, personal: true } : invite;
};

/**
 * この機能より前の参加も数えられるよう、参加のログ（「🔗 招待リンク: discord.gg/abc（作成: <@123>・3回目）」）から記録を作る。
 * 古い順に入れるので、入り直した人は最初の参加のまま。何度動かしても同じ結果になる
 */
export const backfillMemberInvites = async (guildId: string): Promise<number> => {
  const { rows } = await pool.query<{ actor_id: string | null; created_at: Date; details: { name: string; value: string }[] }>(
    `SELECT actor_id, created_at, details FROM activity_logs WHERE guild_id = $1 AND kind = 'join' ORDER BY created_at`,
    [guildId],
  );
  let added = 0;
  for (const row of rows) {
    const value = row.details.find((field) => field.name.includes('招待リンク'))?.value ?? '';
    const match = /discord\.gg\/([^\s（]+)（作成: <@!?(\d+)>/.exec(value);
    if (!row.actor_id || !match?.[1] || !match[2] || match[2] === row.actor_id) continue;
    if (await saveMemberInvite(guildId, { userId: row.actor_id, inviterId: match[2], code: match[1], joinedAt: row.created_at })) added++;
  }
  return added;
};
