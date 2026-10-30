import { messageLink, type GuildMember } from 'discord.js';
import { memberContentNames } from './contentRoles.js';
import { fetchAllMembers } from './guildUtils.js';
import { findInactiveRole } from './inactiveRole.js';
import { findInviteMeRole } from './inviteMeRole.js';
import { listLastActiveDays } from './levelStore.js';
import { listFriendsHiddenIds } from './memberSettings.js';
import type { Profile } from './profile.js';
import { listStoredProfiles } from './profileStore.js';
import { findProgressRoles } from './progressRoles.js';

// フレンド候補。プロフィール（DC・ワールド・遊ぶ時間）と、よく遊ぶコンテンツ・進行度のロールが近い人を、近い順に出す。
// 候補に出ない設定の人・「非アクティブ」の人・Botは出さない

/** 出す候補の数（これより下は、近いところがほとんどない人なので出さない） */
export const MAX_FRIEND_CANDIDATES = 20;
// 近さの点数。同じワールドなら一緒に遊びやすいので一番重くする
const SAME_WORLD_POINTS = 4;
const SAME_DC_POINTS = 3;
const SHARED_CONTENT_POINTS = 2;
const SAME_PROGRESS_POINTS = 1;
const INVITE_ME_POINTS = 1;
/** 遊ぶ時間の重なりは、2時間で1点（3点まで） */
const HOURS_PER_POINT = 2;
const MAX_TIME_POINTS = 3;

export interface FriendCandidate {
  member: GuildMember;
  profile: Profile;
  score: number;
  /** 近いところ（「🌍 同じワールド（Tiamat）」など） */
  reasons: string[];
  /** 「プロフ」チャンネルの投稿（なければ null） */
  profileUrl: string | null;
}

/** 遊ぶ時間（0〜23時のどれか）。終わりが始まり以下なら日をまたぐ（22〜2時など）。どちらか未設定なら空 */
export const playHours = (profile: Profile): Set<number> => {
  const { startHour, endHour } = profile;
  if (startHour === null || endHour === null) return new Set();
  const length = (((endHour - startHour) % 24) + 24) % 24 || 24;
  return new Set(Array.from({ length }, (_, i) => (startHour + i) % 24));
};

/**
 * その人のフレンド候補を、近い順に返す。プロフィールを登録していなければ null。
 * 同じ点数なら、最近来た人を先にする
 */
export const findFriendCandidates = async (member: GuildMember): Promise<FriendCandidate[] | null> => {
  const { guild } = member;
  const [profiles, members, hidden, lastActive] = await Promise.all([
    listStoredProfiles(guild.id),
    fetchAllMembers(guild),
    listFriendsHiddenIds(guild.id),
    listLastActiveDays(guild.id),
  ]);
  const mine = profiles.find((p) => p.userId === member.id);
  if (!mine) return null;

  const inactiveRole = findInactiveRole(guild);
  const inviteMeRole = findInviteMeRole(guild);
  const progressRoles = findProgressRoles(guild);
  const myContents = new Set(memberContentNames(member));
  const myProgress = progressRoles.find((role) => member.roles.cache.has(role.id));
  const myHours = playHours(mine.profile);

  const candidates = profiles.flatMap((stored): FriendCandidate[] => {
    const other = members.get(stored.userId);
    if (!other || other.id === member.id || other.user.bot || hidden.has(other.id)) return [];
    if (inactiveRole && other.roles.cache.has(inactiveRole.id)) return [];

    const { profile } = stored;
    const reasons: string[] = [];
    let score = 0;
    if (profile.world && profile.world === mine.profile.world) {
      score += SAME_WORLD_POINTS;
      reasons.push(`🌍 同じワールド（${profile.world}）`);
    } else if (profile.dataCenter && profile.dataCenter === mine.profile.dataCenter) {
      score += SAME_DC_POINTS;
      reasons.push(`🌍 同じDC（${profile.dataCenter}）`);
    }
    const overlap = [...playHours(profile)].filter((hour) => myHours.has(hour)).length;
    if (overlap > 0) {
      score += Math.min(MAX_TIME_POINTS, Math.max(1, Math.floor(overlap / HOURS_PER_POINT)));
      reasons.push(`🕘 遊ぶ時間が${overlap}時間重なる`);
    }
    const shared = memberContentNames(other).filter((name) => myContents.has(name));
    if (shared.length > 0) {
      score += shared.length * SHARED_CONTENT_POINTS;
      reasons.push(`🎮 ${shared.join('・')}`);
    }
    if (myProgress && other.roles.cache.has(myProgress.id)) {
      score += SAME_PROGRESS_POINTS;
      reasons.push(`📖 進行度が同じ（${myProgress.name}）`);
    }
    // 近いところがなければ候補にしない（いつでも誘ってOK だけでは出さない）
    if (score === 0) return [];
    if (inviteMeRole && other.roles.cache.has(inviteMeRole.id)) {
      score += INVITE_ME_POINTS;
      reasons.push('🙌 いつでも誘ってOK');
    }
    const profileUrl = stored.channelId && stored.messageId ? messageLink(stored.channelId, stored.messageId, guild.id) : null;
    return [{ member: other, profile, score, reasons, profileUrl }];
  });

  return candidates
    .sort((a, b) => b.score - a.score || (lastActive.get(b.member.id) ?? '').localeCompare(lastActive.get(a.member.id) ?? ''))
    .slice(0, MAX_FRIEND_CANDIDATES);
};
