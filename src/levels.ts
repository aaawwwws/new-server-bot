import { randomInt } from 'node:crypto';
import type { Client, Guild, Message, VoiceState } from 'discord.js';
import { jstDay } from './jst.js';
import { addMessageActivity, addVoiceMinute } from './levelStore.js';
import { applyBoost, boostPercent } from './xpBoost.js';

// 経験値（XP）の貯まり方。数字を変えれば、貯まる速さを調整できる（XPアップ期間中は、ここに倍率がかかる）
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
  const xp = earns ? applyBoost(randomInt(MESSAGE_XP_MIN, MESSAGE_XP_MAX + 1), boostPercent(message.guildId)) : 0;
  await addMessageActivity(message.guildId, message.author.id, xp, jstDay());
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
      const xp = applyBoost(VOICE_XP_PER_MINUTE, boostPercent(guild.id));
      addVoiceMinute(guild.id, voiceXpEarners(guild), xp, jstDay()).catch((error: unknown) => {
        console.error(`「${guild.name}」のVCのXPを保存できませんでした:`, error);
      });
    }
  }, VOICE_TICK_MS).unref();
};
