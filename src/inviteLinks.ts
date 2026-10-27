import { ChannelType, PermissionFlagsBits, type Guild, type GuildMember, type TextChannel } from 'discord.js';
import { sendLog } from './activityLog.js';
import { findPersonalLink, retirePersonalLink, savePersonalLink } from './inviteStore.js';

// メンバー専用の招待リンク。招待リンクの作り方が分からない人や、作る権限がない人でも招待できるよう、Botが作って渡す。
// 期限・回数の制限なし。1人1つで、作り直すまで同じリンクを使う

export interface PersonalInvite {
  url: string;
  code: string;
  /** 今回新しく作ったか */
  created: boolean;
}

/**
 * 招待リンクの行き先のチャンネル。ルール → システムメッセージ → 誰でも見られる一番上のテキストチャンネル の順に探す。
 * 誰でも見られて、Botが招待を作れるチャンネルだけ
 */
export const pickInviteChannel = (guild: Guild): TextChannel | null => {
  const me = guild.members.me;
  const usable = (channel: unknown): channel is TextChannel => {
    if (!channel || typeof channel !== 'object' || !('type' in channel) || channel.type !== ChannelType.GuildText) return false;
    const text = channel as TextChannel;
    return (
      !!me &&
      text.permissionsFor(guild.roles.everyone)?.has(PermissionFlagsBits.ViewChannel) === true &&
      text.permissionsFor(me)?.has(PermissionFlagsBits.CreateInstantInvite) === true
    );
  };
  const candidates = [
    guild.rulesChannel,
    guild.systemChannel,
    ...[...guild.channels.cache.values()].filter((channel) => channel.type === ChannelType.GuildText).sort((a, b) => a.position - b.position),
  ];
  return candidates.find(usable) ?? null;
};

/**
 * その人の専用リンクを返す。まだない・消されていたら作る。renew なら前のリンクを止めて作り直す。
 * 作れないときは理由（文字列）を返す
 */
export const ensurePersonalInvite = async (member: GuildMember, { renew = false } = {}): Promise<PersonalInvite | string> => {
  const { guild } = member;
  const current = await findPersonalLink(guild.id, member.id);
  if (current && !renew) {
    // Discord側で消されていないか確かめる（消されていたら作り直す）
    const alive = await guild.client.fetchInvite(current.code).then(
      () => true,
      () => false,
    );
    if (alive) return { url: `https://discord.gg/${current.code}`, code: current.code, created: false };
  }

  const channel = pickInviteChannel(guild);
  if (!channel) {
    return 'Botが招待リンクを作れるチャンネルがありません（誰でも見られるチャンネルで、Botに「招待を作成」の権限が要ります）。管理者に伝えてください。';
  }
  if (current) {
    await retirePersonalLink(guild.id, current.code);
    // 前のリンクはDiscordからも消す（消せなくても、そのリンクで入った人は持ち主に数える）
    await guild.invites.delete(current.code, `${member.user.username} が専用の招待リンクを作り直したため`).catch(() => undefined);
  }
  const invite = await channel.createInvite({
    maxAge: 0,
    maxUses: 0,
    unique: true,
    reason: `${member.user.username} の専用の招待リンク（Botが作成）`,
  });
  await savePersonalLink(guild.id, member.id, { code: invite.code, channelId: channel.id });
  void sendLog(guild, 'invite', `${member} が専用の招待リンクを${current ? '作り直しました' : '作りました'}`, member, {
    title: current ? '専用の招待リンクの作り直し' : '専用の招待リンク作成',
    channel,
    fields: [
      { name: '🔗 リンク', value: `discord.gg/${invite.code}`, inline: true },
      ...(current ? [{ name: '🗑️ 前のリンク', value: `discord.gg/${current.code}`, inline: true }] : []),
    ],
  });
  return { url: `https://discord.gg/${invite.code}`, code: invite.code, created: true };
};
