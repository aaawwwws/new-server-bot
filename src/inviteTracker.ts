import { PermissionFlagsBits, time, userMention, type Guild, type Invite } from 'discord.js';
import { sendLog } from './activityLog.js';

// どの招待リンクで入ったかを調べる。Discordは教えてくれないので、
// 招待リンクごとの使用回数を覚えておき、人が入ったときに回数が増えたリンクを探す。
// 招待リンクを見るには、Botに「サーバーの管理」権限が要る

export interface UsedInvite {
  code: string;
  inviterId: string | null;
  /** 今回で何回目の使用か */
  uses: number;
  /** サーバーのカスタムURL（discord.gg/〇〇）か */
  vanity: boolean;
}

interface InviteSnapshot {
  code: string;
  inviterId: string | null;
  uses: number;
  maxUses: number;
  /** 消された時刻（1回限りのリンクは、使われると人が入るより先に消えることがあるので、少し覚えておく） */
  deletedAt: number | null;
}

/** 消された招待リンクを覚えておく時間 */
const KEEP_DELETED_MS = 60_000;

/** サーバーごと、招待リンクごとの使用回数 */
const snapshots = new Map<string, Map<string, InviteSnapshot>>();
const vanityUses = new Map<string, number>();

const canSeeInvites = (guild: Guild): boolean => guild.members.me?.permissions.has(PermissionFlagsBits.ManageGuild) ?? false;

const toSnapshot = (invite: Invite): InviteSnapshot => ({
  code: invite.code,
  inviterId: invite.inviterId,
  uses: invite.uses ?? 0,
  maxUses: invite.maxUses ?? 0,
  deletedAt: null,
});

/** 起動時に、今ある招待リンクの使用回数を覚える */
export const loadInvites = async (guild: Guild): Promise<void> => {
  if (!canSeeInvites(guild)) return;
  const invites = await guild.invites.fetch();
  snapshots.set(guild.id, new Map(invites.map((invite) => [invite.code, toSnapshot(invite)])));
  if (guild.vanityURLCode) {
    const vanity = await guild.fetchVanityData().catch(() => null);
    if (vanity) vanityUses.set(guild.id, vanity.uses);
  }
};

/** 入った人が使った招待リンク。1つに決められなければ null */
export const findUsedInvite = async (guild: Guild): Promise<UsedInvite | null> => {
  const before = snapshots.get(guild.id);
  if (!before || !canSeeInvites(guild)) return null;
  const invites = await guild.invites.fetch();
  const now = Date.now();

  const used: UsedInvite[] = invites
    .filter((invite) => (invite.uses ?? 0) > (before.get(invite.code)?.uses ?? 0))
    .map((invite) => ({ code: invite.code, inviterId: invite.inviterId, uses: invite.uses ?? 0, vanity: false }));
  // 1回限り（使用回数の上限に達した）リンクは、使われると消えるので、消えたものからも探す
  for (const snapshot of before.values()) {
    const gone = !invites.has(snapshot.code);
    const recentlyGone = snapshot.deletedAt === null || now - snapshot.deletedAt < KEEP_DELETED_MS;
    if (gone && recentlyGone && snapshot.maxUses > 0 && snapshot.uses + 1 >= snapshot.maxUses) {
      used.push({ code: snapshot.code, inviterId: snapshot.inviterId, uses: snapshot.uses + 1, vanity: false });
    }
  }
  if (guild.vanityURLCode) {
    const vanity = await guild.fetchVanityData().catch(() => null);
    if (vanity && vanity.uses > (vanityUses.get(guild.id) ?? vanity.uses)) {
      used.push({ code: guild.vanityURLCode, inviterId: null, uses: vanity.uses, vanity: true });
    }
    if (vanity) vanityUses.set(guild.id, vanity.uses);
  }

  snapshots.set(guild.id, new Map(invites.map((invite) => [invite.code, toSnapshot(invite)])));
  // 同時に何人か入ったなどで、どれか分からないときは決めつけない
  return used.length === 1 ? (used[0] ?? null) : null;
};

/** 招待リンクが作られたら、覚えてログに残す */
export const handleInviteCreate = async (invite: Invite): Promise<void> => {
  const { guild } = invite;
  if (!guild || !('members' in guild)) return;
  snapshots.get(guild.id)?.set(invite.code, toSnapshot(invite));
  const inviter = invite.inviterId ? (guild.members.cache.get(invite.inviterId) ?? invite.inviter ?? undefined) : undefined;
  await sendLog(guild, 'invite', `${invite.inviterId ? userMention(invite.inviterId) : '誰か'} が招待リンクを作りました`, inviter, {
    title: '招待リンク作成',
    channel: invite.channelId ? { id: invite.channelId } : null,
    fields: [
      { name: '🔗 リンク', value: `discord.gg/${invite.code}`, inline: true },
      { name: '⏳ 有効期限', value: invite.expiresAt ? time(invite.expiresAt, 'f') : '無期限', inline: true },
      { name: '🔢 使える回数', value: invite.maxUses ? `${invite.maxUses}回` : '無制限', inline: true },
      ...(invite.temporary ? [{ name: '⚠ 一時的なメンバー', value: 'このリンクで入った人は、抜けたあとロールがなくなります', inline: true }] : []),
    ],
  });
};

/** 招待リンクが消されたら（期限切れ・使い切りも含む）、ログに残す */
export const handleInviteDelete = async (invite: Invite): Promise<void> => {
  const { guild } = invite;
  if (!guild || !('members' in guild)) return;
  const snapshot = snapshots.get(guild.id)?.get(invite.code);
  if (snapshot) snapshot.deletedAt = Date.now();
  await sendLog(guild, 'invite', `招待リンク discord.gg/${invite.code} がなくなりました（削除・期限切れ・使い切り）`, undefined, {
    title: '招待リンク削除',
    channel: invite.channelId ? { id: invite.channelId } : null,
    fields: [
      { name: '👤 作った人', value: snapshot?.inviterId ? userMention(snapshot.inviterId) : '不明', inline: true },
      { name: '🔢 使われた回数', value: snapshot ? `${snapshot.uses}回` : '不明', inline: true },
    ],
  });
};
