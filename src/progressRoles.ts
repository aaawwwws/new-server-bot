import type { Guild, GuildMember, Role } from 'discord.js';
import { sendLog } from './activityLog.js';
import { EXPANSIONS } from './expansions.js';

/** サーバーにある進行度ロールを拡張の順に返す（ないロールは作らずに飛ばす） */
export const findProgressRoles = (guild: Guild): Role[] =>
  EXPANSIONS.flatMap((expansion) => findRoleByName(guild, expansion.name) ?? []);

/**
 * 進行度ロールを1つだけ付ける（ほかの進行度ロールは外す）。ロール変更後のメンバーを返す。
 * actor は操作した人（管理者が代わりに登録しているときは、その管理者）
 */
export const setProgressRole = async (
  member: GuildMember,
  role: Role,
  progressRoleIds: string[],
  actor: GuildMember = member,
): Promise<GuildMember> => {
  const oldRoleIds = progressRoleIds.filter((id) => id !== role.id && member.roles.cache.has(id));
  // 変わらないときは何もしない（ログも残さない）
  if (member.roles.cache.has(role.id) && oldRoleIds.length === 0) return member;

  // 先に付与してから外すことで、付与に失敗してもロールなしの状態にならない
  let updated = member.roles.cache.has(role.id) ? member : await member.roles.add(role, '進行度ロールの変更');
  if (oldRoleIds.length > 0) {
    updated = await updated.roles.remove(oldRoleIds, '進行度ロールの変更');
  }

  const oldNames = oldRoleIds.flatMap((id) => member.guild.roles.cache.get(id)?.name ?? []);
  const subject = actor.id === member.id ? `${member} が進行度を` : `${actor} が ${member} の進行度を`;
  void sendLog(
    member.guild,
    'progress',
    oldNames.length > 0
      ? `${subject}「${oldNames.join('・')}」→「${role.name}」に変更しました`
      : `${subject}「${role.name}」にしました`,
    actor,
    {
      target: member,
      fields: [
        { name: '📖 変更前', value: oldNames.join('・') || 'なし', inline: true },
        { name: '📖 変更後', value: role.name, inline: true },
      ],
    },
  );
  return updated;
};

export const findRoleByName = (guild: Guild, name: string): Role | undefined =>
  guild.roles.cache.find((role) => role.name === name);
