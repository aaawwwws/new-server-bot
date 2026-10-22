import { randomInt } from 'node:crypto';
import type { Client, Collection, Guild, GuildMember, Message, VoiceState } from 'discord.js';
import { jstDay } from './jst.js';
import { addMessageActivity, addVoiceMinute, listLevelStats, type LevelStats } from './levelStore.js';

// 経験値（XP）の貯まり方。数字を変えれば、貯まる速さを調整できる
/** 発言1回でもらえるXP（この範囲でランダム） */
export const MESSAGE_XP_MIN = 15;
export const MESSAGE_XP_MAX = 25;
/** 連投でXPが増えすぎないよう、発言のXPは1人この間隔に1回まで（発言の数はすべて数える） */
export const MESSAGE_XP_COOLDOWN_MS = 60_000;
/** VCに1分いるともらえるXP（2人以上いるVCで、ミュートしていないとき） */
export const VOICE_XP_PER_MINUTE = 5;
const VOICE_TICK_MS = 60_000;

/** そのレベルから次のレベルに上がるのに要るXP。レベルが上がるほど多く要る */
export const xpForNextLevel = (level: number): number => 5 * level ** 2 + 50 * level + 100;

export interface LevelProgress {
  level: number;
  /** 今のレベルになってから貯めたXP */
  current: number;
  /** 次のレベルに上がるのに要るXP（current を含めた全体） */
  needed: number;
}

export const levelFromXp = (xp: number): LevelProgress => {
  let level = 0;
  let rest = xp;
  while (rest >= xpForNextLevel(level)) {
    rest -= xpForNextLevel(level);
    level++;
  }
  return { level, current: rest, needed: xpForNextLevel(level) };
};

/** 「1,234」のような区切り付きの数字 */
export const formatNumber = (value: number): string => value.toLocaleString('ja-JP');

/** 最後に発言でXPをもらった時刻（「サーバーID:ユーザーID」ごと） */
const lastMessageXpAt = new Map<string, number>();

/** 発言でXPを貯める（Bot・Webhook・システムメッセージは除く） */
export const handleMessageXp = async (message: Message): Promise<void> => {
  if (!message.inGuild() || message.author.bot || message.webhookId || message.system) return;

  const key = `${message.guildId}:${message.author.id}`;
  const now = Date.now();
  const earns = now - (lastMessageXpAt.get(key) ?? 0) >= MESSAGE_XP_COOLDOWN_MS;
  if (earns) lastMessageXpAt.set(key, now);
  await addMessageActivity(message.guildId, message.author.id, earns ? randomInt(MESSAGE_XP_MIN, MESSAGE_XP_MAX + 1) : 0, jstDay());
};

/**
 * 今VCでXPをもらえる人。2人以上いるVCで、ミュート・スピーカーミュートしていない人（AFKチャンネルとBotは除く）。
 * ミュートしている人も、人数には数える
 */
export const voiceXpEarners = (guild: Guild): string[] => {
  const byChannel = new Map<string, VoiceState[]>();
  for (const state of guild.voiceStates.cache.values()) {
    if (!state.channelId || state.channelId === guild.afkChannelId || !state.member || state.member.user.bot) continue;
    byChannel.set(state.channelId, [...(byChannel.get(state.channelId) ?? []), state]);
  }
  return [...byChannel.values()]
    .filter((states) => states.length >= 2)
    .flatMap((states) => states.filter((state) => !state.mute && !state.deaf).map((state) => state.id));
};

/** 1分ごとに、VCにいる人へXPを配る */
export const startVoiceXp = (client: Client<true>): void => {
  setInterval(() => {
    for (const guild of client.guilds.cache.values()) {
      addVoiceMinute(guild.id, voiceXpEarners(guild), VOICE_XP_PER_MINUTE, jstDay()).catch((error: unknown) => {
        console.error(`「${guild.name}」のVCのXPを保存できませんでした:`, error);
      });
    }
  }, VOICE_TICK_MS).unref();
};

export type RankingKey = 'xp' | 'messageCount' | 'voiceMinutes';

export interface RankedMember {
  member: GuildMember;
  stats: LevelStats;
}

/** サーバーにいる人（Botを除く）の記録を多い順に並べる。抜けた人と、まだ記録がない人は入れない */
export const rankMembers = async (guild: Guild, key: RankingKey = 'xp'): Promise<RankedMember[]> => {
  const [members, stats] = await Promise.all([currentMembers(guild), listLevelStats(guild.id)]);
  return stats
    .flatMap((s) => {
      const member = members.get(s.userId);
      return member && !member.user.bot && s[key] > 0 ? [{ member, stats: s }] : [];
    })
    .sort((a, b) => b.stats[key] - a.stats[key] || b.stats.xp - a.stats.xp);
};

/** サーバーにいる人。全員分が覚えてあればそれを使い、足りなければ Discord から取り直す */
export const currentMembers = async (guild: Guild): Promise<Collection<string, GuildMember>> =>
  guild.members.cache.size >= guild.memberCount ? guild.members.cache : guild.members.fetch();
