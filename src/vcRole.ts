import { PermissionFlagsBits, type Guild, type GuildMember, type Role } from 'discord.js';
import { sendLog } from './activityLog.js';

/** 通話が始まったときのお知らせでメンションするロールの名前（受け取りたい人だけに付ける） */
export const VC_ROLE_NAME = 'VC';

export const findVcRole = (guild: Guild): Role | undefined => guild.roles.cache.find((role) => role.name === VC_ROLE_NAME);

/**
 * 「VC」ロールがなければ作る。作ったときはそのロールを返す。
 * メンバー同士で鳴らし合わないよう、誰でもメンションできる設定にはしない（Botは権限があればメンションできる）
 */
export const ensureVcRole = async (guild: Guild): Promise<Role | null> => {
  if (findVcRole(guild)) return null;

  const me = guild.members.me ?? (await guild.members.fetchMe());
  if (!me.permissions.has(PermissionFlagsBits.ManageRoles)) {
    console.warn(`「${guild.name}」: Botにロールの管理権限がないため、「${VC_ROLE_NAME}」ロールを作れません`);
    return null;
  }

  const role = await guild.roles.create({
    name: VC_ROLE_NAME,
    permissions: [],
    mentionable: false,
    reason: '通話が始まったときのお知らせを受け取る人のロール',
  });
  console.log(`「${guild.name}」に「${VC_ROLE_NAME}」ロールを作りました`);
  return role;
};

/**
 * VC通知を受け取るかを変える（「VC」ロールの付け外し）。変更後のメンバーを返す。
 * actor は操作した人（管理者が代わりに登録しているときは、その管理者）
 */
export const setVcNotice = async (
  member: GuildMember,
  role: Role,
  on: boolean,
  actor: GuildMember = member,
): Promise<GuildMember> => {
  if (member.roles.cache.has(role.id) === on) return member;
  const updated = on ? await member.roles.add(role, 'VC通知の設定') : await member.roles.remove(role, 'VC通知の設定');
  const subject = actor.id === member.id ? `${member} が` : `${actor} が ${member} の`;
  void sendLog(member.guild, 'vcNotice', `${subject}VC通知を${on ? 'オン' : 'オフ'}にしました`, actor, {
    target: member,
    fields: [{ name: '🔔 通知を受け取る', value: on ? '受け取る（「VC」ロールあり）' : '受け取らない', inline: true }],
  });
  return updated;
};
