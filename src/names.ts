import { escapeMarkdown, type Guild, type GuildMember, type User } from 'discord.js';

// 埋め込みの中のユーザーのメンション（<@123>）は、見る人の Discord がその人を読み込んでいないと
// 「<@123>」や「@不明なユーザー」のまま表示される（本文のメンションは、メッセージに相手の情報が付くのでちゃんと出る）。
// なので、埋め込みには名前を文字で出す。
// 抜けた人などは名前が届かないこともあるので、名前がなければIDで代わりにする

/** 太字の表示名（名前に * や _ が入っていても崩れないようにする） */
export const boldName = (who: GuildMember | User): string => `**${escapeMarkdown(who.displayName ?? who.id)}**`;

/** 表示名とユーザー名（「**たろう**（@taro）」）。同じ表示名の人を見分けたい、管理用の一覧やログで使う */
export const nameWithUsername = (who: GuildMember | User): string => {
  const username = 'user' in who ? who.user?.username : who.username;
  return username ? `${boldName(who)}（@${escapeMarkdown(username)}）` : boldName(who);
};

/** IDしか分からない人の名前。サーバーにいなければ fallback（抜けた人など） */
export const nameById = (guild: Guild, userId: string, fallback = '（サーバーにいない人）'): string => {
  const member = guild.members?.cache?.get(userId);
  return member ? boldName(member) : fallback;
};

/**
 * 文の中のユーザーのメンションを、太字の名前に置き換える。
 * サーバーにいない人は known（ID → 名前）の名前にし、それもなければメンションのまま
 */
export const replaceMentions = (guild: Guild, text: string, known: ReadonlyMap<string, string> = new Map()): string =>
  text.replace(/<@!?(\d{15,25})>/g, (mention, id: string) => {
    const member = guild.members?.cache?.get(id);
    if (member) return boldName(member);
    const name = known.get(id);
    return name ? `**${escapeMarkdown(name)}**` : mention;
  });
