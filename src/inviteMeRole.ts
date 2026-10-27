import { PermissionFlagsBits, type Guild, type GuildMember, type Role } from 'discord.js';
import { sendLog } from './activityLog.js';

/** 「いつでも誘ってほしい」人が自分で付けるロールの名前。プロフィールに出て、PT募集のメンション先にも選べる */
export const INVITE_ME_ROLE_NAME = 'いつでも誘って下さい';

export const findInviteMeRole = (guild: Guild): Role | undefined => guild.roles.cache.find((role) => role.name === INVITE_ME_ROLE_NAME);

/**
 * 「いつでも誘って下さい」ロールがなければ作る。作ったときはそのロールを返す。
 * 名前の色を変えないよう色は付けず、メンバー同士で鳴らし合わないよう、誰でもメンションできる設定にはしない
 * （PT募集では Bot がメンションできる）
 */
export const ensureInviteMeRole = async (guild: Guild): Promise<Role | null> => {
  if (findInviteMeRole(guild)) return null;

  const me = guild.members.me ?? (await guild.members.fetchMe());
  if (!me.permissions.has(PermissionFlagsBits.ManageRoles)) {
    console.warn(`「${guild.name}」: Botにロールの管理権限がないため、「${INVITE_ME_ROLE_NAME}」ロールを作れません`);
    return null;
  }

  const role = await guild.roles.create({
    name: INVITE_ME_ROLE_NAME,
    permissions: [],
    mentionable: false,
    reason: 'いつでも誘ってほしい人が自分で付けるロール',
  });
  console.log(`「${guild.name}」に「${INVITE_ME_ROLE_NAME}」ロールを作りました`);
  return role;
};

/**
 * 「いつでも誘って下さい」を付けるか外す。変更後のメンバーを返す（変わらなければそのまま）。
 * actor は操作した人（管理者が代わりに登録しているときは、その管理者）
 */
export const setInviteMe = async (member: GuildMember, role: Role, on: boolean, actor: GuildMember = member): Promise<GuildMember> => {
  if (member.roles.cache.has(role.id) === on) return member;
  const updated = on ? await member.roles.add(role, 'いつでも誘っての設定') : await member.roles.remove(role, 'いつでも誘っての設定');
  const subject = actor.id === member.id ? `${member} が` : `${actor} が ${member} の`;
  void sendLog(member.guild, 'inviteMe', `${subject}「${INVITE_ME_ROLE_NAME}」を${on ? '付けました' : '外しました'}`, actor, {
    target: member,
    fields: [{ name: '🙌 いつでも誘って', value: on ? '付けた' : '外した', inline: true }],
  });
  return updated;
};
