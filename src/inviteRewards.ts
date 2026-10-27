import type { GuildMember } from 'discord.js';
import { sendLog } from './activityLog.js';
import { fetchAllMembers } from './guildUtils.js';
import { claimInviteReward, findInviter } from './inviteStore.js';
import { formatNumber, levelFromXp } from './levels.js';
import { adjustXp } from './levelStore.js';
import { boldName } from './names.js';

// 招待のご褒美。招待した人がプロフィール登録まで進んだら（申請の許可・管理者の登録）、連れてきた人にXPを渡す。
// 1人の招待につき1回だけ。合計のXPだけを足す（今日・今週・今月のランキングは、活動の分だけで数える）

export const INVITE_REWARD_XP = 300;

export interface InviteReward {
  inviter: GuildMember;
  xp: number;
}

/** 連れてきた人にXPを渡し、DMで知らせる。渡さなかったとき（招待の記録がない・もう渡した・連れてきた人が抜けた）は null */
export const rewardInviter = async (invitee: GuildMember): Promise<InviteReward | null> => {
  const { guild } = invitee;
  const invite = await findInviter(guild.id, invitee.id);
  if (!invite || invite.rewardedAt) return null;
  const inviter = (await fetchAllMembers(guild)).get(invite.inviterId);
  if (!inviter || inviter.user.bot || inviter.id === invitee.id) return null;
  if (!(await claimInviteReward(guild.id, invitee.id))) return null;

  const { before, after } = await adjustXp(guild.id, inviter.id, INVITE_REWARD_XP);
  const levels = `Lv.${levelFromXp(before).level} → Lv.${levelFromXp(after).level}`;
  void sendLog(guild, 'level', `${inviter} が招待した ${invitee} がプロフィール登録まで進んだので、${inviter} に ${formatNumber(INVITE_REWARD_XP)} XP を渡しました`, undefined, {
    target: inviter,
    title: '招待のご褒美',
    fields: [
      { name: '✏️ XP', value: `${formatNumber(before)} → ${formatNumber(after)}`, inline: true },
      { name: '📊 レベル', value: levels, inline: true },
    ],
  });
  // 本人にも知らせる（DMを受け付けていない人には届かないが、XPは渡してある）
  await inviter
    .send(
      [
        `🎉 あなたが「${guild.name}」に招待した ${boldName(invitee)} さんが、プロフィール登録を済ませました！`,
        `お礼に **${formatNumber(INVITE_REWARD_XP)} XP** をプレゼントしました（${levels}）。招待ありがとうございます！`,
      ].join('\n'),
    )
    .catch(() => undefined);
  return { inviter, xp: INVITE_REWARD_XP };
};
