import { PermissionFlagsBits, type VoiceState } from 'discord.js';
import { buildJoinNoticeEmbed, buildProfileEmbed } from './profile.js';
import { loadJoinAnnounceOrDefault } from './memberSettings.js';
import { findStoredProfile } from './profileStore.js';
import { findLobby } from './tempVoiceStore.js';

/** 抜けてすぐ入り直したとき（回線落ちなど）に何度も送らないための間隔 */
const COOLDOWN_MS = 60_000;
const lastNotifiedAt = new Map<string, number>();

/** VCに入ったら、そのVCのテキストチャットにお知らせを送る */
export const handleVoiceStateUpdate = async (oldState: VoiceState, newState: VoiceState): Promise<void> => {
  const channel = newState.channel;
  const member = newState.member;
  // 入室（別のVCからの移動を含む）だけが対象。ミュートの切り替えや退出、Botは無視する
  if (!channel || oldState.channelId === newState.channelId || !member || member.user.bot) return;
  // 一時VCの入口はすぐ部屋へ動かすので、できた部屋の方に出す
  if (findLobby(channel.id)) return;

  // VCのチャットに書き込めない設定なら何もしない
  const me = newState.guild.members.me;
  const canSend = me && channel.permissionsFor(me).has([
    PermissionFlagsBits.ViewChannel,
    PermissionFlagsBits.SendMessages,
    PermissionFlagsBits.EmbedLinks,
  ]);
  if (!canSend || !channel.isSendable()) return;

  const key = `${channel.id}:${member.id}`;
  const now = Date.now();
  // 一時VCは次々に作っては消すので、間隔を過ぎた記録は捨てる（溜まらないように）
  for (const [notifiedKey, at] of lastNotifiedAt) {
    if (now - at >= COOLDOWN_MS) lastNotifiedAt.delete(notifiedKey);
  }
  if (now - (lastNotifiedAt.get(key) ?? 0) < COOLDOWN_MS) return;
  lastNotifiedAt.set(key, now);

  // 本人が設定パネルで「出さない」にしていたら送らない
  const { vcJoin } = await loadJoinAnnounceOrDefault(newState.guild.id, member.id);
  if (!vcJoin) return;

  // 登録済みならプロフに投稿したものと同じ埋め込み、未登録なら入室したことだけ送る
  const stored = await findStoredProfile(newState.guild.id, member.id);
  const embed = stored ? buildProfileEmbed(member, stored.profile) : buildJoinNoticeEmbed(member);
  await channel.send({ embeds: [embed] });
};
