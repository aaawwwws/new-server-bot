import { type Guild, type GuildMember, type Message, type Role, type TextChannel } from 'discord.js';
import { findTextChannel } from './guildUtils.js';
import { buildProfileMessage, legacyProfileHeader, parseProfile, profileHeader, type Profile } from './profile.js';
import { findStoredProfile, saveProfile, type StoredProfile } from './profileStore.js';
import { findProgressRoles } from './progressRoles.js';

/** 許可されたプロフィールを投稿するチャンネルの名前 */
export const PROFILE_CHANNEL_NAME = 'プロフ';
/** 申請が届く、管理者用のチャンネルの名前 */
export const REVIEW_CHANNEL_NAME = '確認';
/** 申請が許可されたメンバーに付けるロールの名前 */
export const MEMBER_ROLE_NAME = '正規メンバー';
/** DB導入前の投稿を探す範囲（チャンネルの最新メッセージ件数） */
const SEARCH_LIMIT = 100;

/** skipped は、正規メンバーロールを付けない保存（設定パネルからの変更）だったとき */
export type MemberRoleResult = 'added' | 'already' | 'missing' | 'failed' | 'skipped';

export interface PublishResult {
  message: Message<true>;
  /** すでに投稿があり、それを上書きした */
  updated: boolean;
  memberRole: MemberRoleResult;
}

export const findProfileChannel = (guild: Guild): TextChannel | undefined => findTextChannel(guild, PROFILE_CHANNEL_NAME);

export const findReviewChannel = (guild: Guild): TextChannel | undefined => findTextChannel(guild, REVIEW_CHANNEL_NAME);

export const findMemberRole = (guild: Guild): Role | undefined =>
  guild.roles.cache.find((role) => role.name === MEMBER_ROLE_NAME);

/**
 * プロフィールをプロフチャンネルに投稿（あれば上書き）してDBに保存し、正規メンバーロールを付ける。
 * 登録済みの人の項目を変えるだけのとき（設定パネル）は、grantMemberRole: false にする
 * （管理者が外したロールを、勝手に付け直さないように）
 */
export const publishProfile = async (
  channel: TextChannel,
  member: GuildMember,
  profile: Profile,
  { grantMemberRole: shouldGrant = true }: { grantMemberRole?: boolean } = {},
): Promise<PublishResult> => {
  const payload = buildProfileMessage(member, profile);
  const stored = await findStoredProfile(member.guild.id, member.id);
  const existing = await findPostedProfile(channel, member.id, stored);
  const message = existing ? await existing.edit(payload) : await channel.send(payload);

  const progress = findProgressRoles(member.guild).find((role) => member.roles.cache.has(role.id));
  await saveProfile({
    guildId: member.guild.id,
    userId: member.id,
    profile,
    progress: progress?.name ?? null,
    channelId: channel.id,
    messageId: message.id,
  });

  return {
    message,
    updated: existing !== undefined,
    memberRole: shouldGrant ? await grantMemberRole(member) : 'skipped',
  };
};

/**
 * 登録済みのメンバーなら、プロフの投稿を今のロール（進行度・コンテンツ）で更新する。未登録なら何もしない。
 * ロールの付け外し自体は済んでいるので、投稿を更新できなくても止めない（コンソールに出すだけ）
 */
export const refreshPostedProfile = async (member: GuildMember): Promise<void> => {
  try {
    const channel = findProfileChannel(member.guild);
    const stored = channel ? await findStoredProfile(member.guild.id, member.id) : null;
    if (!channel || !stored) return;
    await publishProfile(channel, member, stored.profile, { grantMemberRole: false });
  } catch (error) {
    console.error('プロフィールの投稿を更新できませんでした:', error);
  }
};

/**
 * 登録済みのプロフィール。DBになければ、DB導入前にプロフチャンネルへ投稿されたものを読む。
 * includeLeft は入力欄に前の内容を入れるとき用で、サーバーを抜けて戻ってきた人の前のプロフィールも返す
 */
export const loadCurrentProfile = async (
  channel: TextChannel,
  userId: string,
  { includeLeft = false }: { includeLeft?: boolean } = {},
): Promise<Profile | null> => {
  const stored = await findStoredProfile(channel.guildId, userId, { includeLeft });
  if (stored) return stored.profile;
  const message = await findProfileMessage(channel, userId);
  return message ? parseProfile(message.embeds[0]) : null;
};

const grantMemberRole = async (member: GuildMember): Promise<MemberRoleResult> => {
  const role = findMemberRole(member.guild);
  if (!role) return 'missing';
  if (member.roles.cache.has(role.id)) return 'already';

  try {
    await member.roles.add(role, 'プロフィールの申請を許可');
    return 'added';
  } catch (error) {
    // プロフィールの投稿自体は済んでいるので、止めずに結果だけ返す
    console.error(`「${role.name}」ロールの付与に失敗しました:`, error);
    return 'failed';
  }
};

/** 投稿済みのプロフィールのメッセージ。DBに記録したものを優先し、なければチャンネルから探す */
const findPostedProfile = async (
  channel: TextChannel,
  userId: string,
  stored: StoredProfile | null,
): Promise<Message<true> | undefined> => {
  if (stored?.messageId && stored.channelId === channel.id) {
    // 手動で消されていたら、チャンネルから探し直す
    const message = await channel.messages.fetch(stored.messageId).catch(() => undefined);
    if (message) return message;
  }
  return findProfileMessage(channel, userId);
};

/** プロフチャンネルの最新メッセージから、このBotが投稿したそのユーザーのプロフィールを探す */
const findProfileMessage = async (channel: TextChannel, userId: string): Promise<Message<true> | undefined> => {
  const messages = await channel.messages.fetch({ limit: SEARCH_LIMIT });
  const headers = [profileHeader(userId), legacyProfileHeader(userId)];
  return messages.find((message) => message.author.id === channel.client.user.id && headers.includes(message.content));
};
