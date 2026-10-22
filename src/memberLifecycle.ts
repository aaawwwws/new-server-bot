import { setTimeout as sleep } from 'node:timers/promises';
import type { GuildMember, PartialGuildMember } from 'discord.js';
import { logMemberLeave } from './activityLog.js';
import { findRemoval } from './moderationLog.js';
import { closeInvalidReview } from './profileReview.js';
import { closePendingApplicationsOfLeftMember, findStoredProfile, markProfileLeft } from './profileStore.js';

/** 監査ログにキック・BANが載るまで少しかかるので、待ってから調べる */
const AUDIT_LOG_DELAY_MS = 1_500;

/** サーバーを抜けた人の後片付けをして、退出のログを残す（キック・BANされたのなら、誰がやったかも書く） */
export const handleMemberLeave = async (member: GuildMember | PartialGuildMember): Promise<void> => {
  const [notes, removal] = await Promise.all([
    cleanUpLeftMember(member).catch((error: unknown) => {
      // 後片付けに失敗しても、退出のログは残す
      console.error('退出したメンバーの後片付けに失敗しました:', error);
      return ['※ プロフィールの後片付けに失敗しました'];
    }),
    sleep(AUDIT_LOG_DELAY_MS).then(() => findRemoval(member.guild, member.id).catch(() => null)),
  ]);
  await logMemberLeave(member, notes, removal);
};

/**
 * プロフの投稿を消してプロフィールを「退出済み」にし（戻ってきたときのためにデータは残す）、
 * 審査中の申請は無効にする。ログに載せる結果を返す
 */
const cleanUpLeftMember = async (member: GuildMember | PartialGuildMember): Promise<string[]> => {
  const { guild } = member;
  const notes: string[] = [];

  const stored = await findStoredProfile(guild.id, member.id);
  if (stored) {
    const channel = stored.channelId ? guild.channels.cache.get(stored.channelId) : undefined;
    const deleted =
      channel?.isTextBased() && stored.messageId
        ? await channel.messages.delete(stored.messageId).then(
            () => true,
            () => false,
          )
        : false;
    await markProfileLeft(guild.id, member.id);
    notes.push(`プロフィール: ${stored.profile.name}（${deleted ? 'プロフの投稿を削除しました' : 'プロフの投稿は見つかりませんでした'}）`);
  }

  const reviews = await closePendingApplicationsOfLeftMember(guild.id, member.id);
  for (const review of reviews) {
    await closeInvalidReview(guild, review, '⚠ 申請者がサーバーから退出したため、この申請は無効になりました。');
  }
  if (reviews.length > 0) notes.push(`審査中の申請を無効にしました（${reviews.length}件）`);

  return notes;
};
