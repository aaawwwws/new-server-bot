import { randomInt } from 'node:crypto';
import type { Client, GatewayMessageReactionAddDispatchData, Guild, Message, VoiceState } from 'discord.js';
import { fetchAllMembers } from './guildUtils.js';
import { jstDay } from './jst.js';
import { addMessageActivity, addReactionActivity, addVoiceMinute, recordReaction } from './levelStore.js';
import { applyBoost, boostPercent } from './xpBoost.js';

// 経験値（XP）の貯まり方。数字を変えれば、貯まる速さを調整できる（XPアップ期間中は、ここに倍率がかかる）
/** 発言1回でもらえるXP（この範囲でランダム） */
export const MESSAGE_XP_MIN = 15;
export const MESSAGE_XP_MAX = 25;
/** 連投でXPが増えすぎないよう、発言のXPは1人この間隔に1回まで（発言の数はすべて数える） */
export const MESSAGE_XP_COOLDOWN_MS = 60_000;
/** VCに1分いるともらえるXP（2人以上いるVCで、ミュートしていないとき） */
export const VOICE_XP_PER_MINUTE = 5;
/** 配信（画面共有）している人が、1分ごとに上乗せでもらえるXP */
export const STREAM_BONUS_PER_MINUTE = 3;
/** リアクションを付けるともらえるXPと、XPになる1日の回数 */
export const REACTION_GIVE_XP = 3;
export const REACTION_GIVE_DAILY_LIMIT = 10;
/** リアクションをもらうともらえるXP（1人から1回）と、XPになる1日の回数 */
export const REACTION_RECEIVE_XP = 5;
export const REACTION_RECEIVE_DAILY_LIMIT = 20;
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
 * リアクションでXPを貯める。付けた人と、付けられたメッセージを書いた人の両方に入る（それぞれ1日の上限まで）。
 * 同じメッセージへは、絵文字を変えても・付け直しても1人1回だけ。外しても減らさない。
 * 自分の投稿へのリアクション、Botのリアクション、Bot・Webhook・抜けた人の投稿へのリアクションは数えない。
 * discord.js は付けられたメッセージを書いた人を教えてくれないので、Discordから届いたままの形で受け取る
 */
export const handleReactionXp = async (client: Client, data: GatewayMessageReactionAddDispatchData): Promise<void> => {
  const { guild_id: guildId, message_author_id: authorId, user_id: userId } = data;
  if (!guildId || !authorId || authorId === userId || data.member?.user.bot) return;
  const guild = client.guilds.cache.get(guildId);
  if (!guild) return;
  const author = (await fetchAllMembers(guild)).get(authorId);
  if (!author || author.user.bot) return;
  if (!(await recordReaction(guildId, data.message_id, userId))) return;

  const percent = boostPercent(guildId);
  const day = jstDay();
  await addReactionActivity(guildId, userId, 'given', applyBoost(REACTION_GIVE_XP, percent), REACTION_GIVE_DAILY_LIMIT, day);
  await addReactionActivity(guildId, authorId, 'received', applyBoost(REACTION_RECEIVE_XP, percent), REACTION_RECEIVE_DAILY_LIMIT, day);
};

/**
 * 今VCでXPをもらえる人。2人以上いるVCで、ミュート・スピーカーミュートしていない人（AFKチャンネルとBotは除く）。
 * ミュートしている人も、人数には数える。配信（画面共有）している人は、ミュート中でももらえる
 */
export const voiceXpEarners = (guild: Guild): string[] => {
  const byChannel = new Map<string, VoiceState[]>();
  for (const state of guild.voiceStates.cache.values()) {
    if (!state.channelId || state.channelId === guild.afkChannelId || !state.member || state.member.user.bot) continue;
    byChannel.set(state.channelId, [...(byChannel.get(state.channelId) ?? []), state]);
  }
  return [...byChannel.values()]
    .filter((states) => states.length >= 2)
    .flatMap((states) => states.filter((state) => state.streaming || (!state.mute && !state.deaf)).map((state) => state.id));
};

/** 1分ごとに、VCにいる人へXPを配る（配信している人には上乗せ） */
export const startVoiceXp = (client: Client<true>): void => {
  setInterval(() => {
    for (const guild of client.guilds.cache.values()) {
      giveVoiceXp(guild).catch((error: unknown) => {
        console.error(`「${guild.name}」のVCのXPを保存できませんでした:`, error);
      });
    }
  }, VOICE_TICK_MS).unref();
};

/** 1分ぶんのVCのXPを配る */
export const giveVoiceXp = async (guild: Guild): Promise<void> => {
  const percent = boostPercent(guild.id);
  const earners = voiceXpEarners(guild);
  const streaming = earners.filter((id) => guild.voiceStates.cache.get(id)?.streaming);
  const others = earners.filter((id) => !streaming.includes(id));
  const day = jstDay();
  await addVoiceMinute(guild.id, others, applyBoost(VOICE_XP_PER_MINUTE, percent), day);
  await addVoiceMinute(guild.id, streaming, applyBoost(VOICE_XP_PER_MINUTE + STREAM_BONUS_PER_MINUTE, percent), day);
};
