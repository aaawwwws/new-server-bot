import type { Guild, GuildMember, Role } from 'discord.js';
import { sendLog } from './activityLog.js';
import { findRoleByName } from './progressRoles.js';

export interface ContentRole {
  /** ロール名・ボタンの表示名 */
  name: string;
  /** ボタンに付ける絵文字 */
  emoji: string;
}

// よく遊ぶコンテンツのロール（いくつでも付けられる）。
// 変えたら /コンテンツパネル を設置し直す（ボタンは1行4個で、全部で20個まで）
export const CONTENT_ROLES: ContentRole[] = [
  { name: 'レイド', emoji: '🐉' },
  { name: 'ギャザクラ', emoji: '⛏️' },
  { name: 'SS', emoji: '📸' },
  { name: 'ハウジング', emoji: '🏠' },
  { name: 'PvP', emoji: '⚔️' },
  { name: '地図', emoji: '🗺️' },
  { name: '特殊フィールド', emoji: '🧭' },
  { name: 'ルレ', emoji: '🎲' },
];

/** サーバーにあるコンテンツロールを一覧の順に返す（ないロールは飛ばす） */
export const findContentRoles = (guild: Guild): Role[] =>
  CONTENT_ROLES.flatMap((content) => findRoleByName(guild, content.name) ?? []);

/** ロール名から、ボタンに付ける絵文字を探す */
export const contentEmoji = (roleName: string): string | undefined =>
  CONTENT_ROLES.find((content) => content.name === roleName)?.emoji;

/** メンバーに付いているコンテンツロールの名前（一覧の順） */
export const memberContentNames = (member: GuildMember): string[] =>
  findContentRoles(member.guild)
    .filter((role) => member.roles.cache.has(role.id))
    .map((role) => role.name);

/**
 * コンテンツロールを付け外しする（付いていれば外す）。変更後のメンバーと、付けたかどうかを返す。
 * actor は操作した人（管理者が代わりに登録しているときは、その管理者）
 */
export const toggleContentRole = async (
  member: GuildMember,
  role: Role,
  actor: GuildMember = member,
): Promise<{ member: GuildMember; added: boolean }> => {
  const added = !member.roles.cache.has(role.id);
  const updated = added
    ? await member.roles.add(role, 'コンテンツロールの変更')
    : await member.roles.remove(role, 'コンテンツロールの変更');
  const subject = actor.id === member.id ? `${member} がコンテンツロール` : `${actor} が ${member} のコンテンツロール`;
  void sendLog(member.guild, 'content', `${subject}「${role.name}」を${added ? '付け' : '外し'}ました`, actor, {
    target: member,
    fields: [{ name: '🎮 今のコンテンツロール', value: memberContentNames(updated).join('・') || 'なし', inline: true }],
  });
  return { member: updated, added };
};
