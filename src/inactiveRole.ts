import {
  PermissionFlagsBits,
  type Client,
  type GatewayMessageReactionAddDispatchData,
  type Guild,
  type GuildMember,
  type Message,
  type Role,
  type VoiceState,
} from 'discord.js';
import { sendLog } from './activityLog.js';
import { reportError } from './errorReporter.js';
import { fetchAllMembers } from './guildUtils.js';
import { loadInactiveRoleSettings } from './guildSettings.js';
import { addDays, dayStart, jstDay } from './jst.js';
import { findFirstRecordedDay, listLastActiveDays, touchLastActive } from './levelStore.js';

// 来ていない人を分ける「非アクティブ」ロール。決めた日数、発言・リアクション・VCがなかった人に1日1回付け、
// また来たら（発言・リアクション・VCに入る）すぐ外す。XPにならないもの（XPなしチャンネル・1人のVCなど）も「来た」に数える

export const INACTIVE_ROLE_NAME = '非アクティブ';
/** 管理パネルで選べる日数 */
export const INACTIVE_ROLE_DAYS = [7, 14, 30, 60];
/** 日が変わったかを見る間隔（変わっていたら付け直す） */
const SYNC_TICK_MS = 10 * 60_000;
/** ログに名前を並べる人数 */
const MAX_NAMES_IN_LOG = 30;

export type ActivityKind = '発言' | 'リアクション' | 'VC';

export const findInactiveRole = (guild: Guild): Role | undefined =>
  guild.roles.cache.find((role) => role.name === INACTIVE_ROLE_NAME);

/**
 * 「非アクティブ」ロールがなければ作る（オフにしているサーバーでは作らない）。作ったときはそのロールを返す。
 * 名前の色やメンバー一覧の並びを勝手に変えないよう、色も「分けて表示」も付けない（管理者がサーバー設定で変えられる）
 */
export const ensureInactiveRole = async (guild: Guild): Promise<Role | null> => {
  if (findInactiveRole(guild) || !(await loadInactiveRoleSettings(guild.id)).enabled) return null;

  const me = guild.members.me ?? (await guild.members.fetchMe());
  if (!me.permissions.has(PermissionFlagsBits.ManageRoles)) {
    console.warn(`「${guild.name}」: Botにロールの管理権限がないため、「${INACTIVE_ROLE_NAME}」ロールを作れません`);
    return null;
  }

  const role = await guild.roles.create({
    name: INACTIVE_ROLE_NAME,
    permissions: [],
    mentionable: false,
    reason: 'しばらく来ていない人に付けるロール',
  });
  console.log(`「${guild.name}」に「${INACTIVE_ROLE_NAME}」ロールを作りました`);
  return role;
};

// ---- 来たとき

/** 今日もう来た日を残した人（「サーバーID:ユーザーID」→ 日）。発言のたびにDBへ書かないため */
const touchedDays = new Map<string, string>();
/** ロールを外している途中の人（続けて発言しても、外すのとログは1回にする） */
const removing = new Set<string>();

/**
 * 発言・リアクション・VCに入ったときに呼ぶ。来た日を残し、「非アクティブ」が付いていればすぐ外す。
 * hasRole はその人が今そのロールを持っているか（リアクションは届いたロールのIDで分かるので、メンバーを取りに行かない）
 */
export const noteActivity = async (
  guild: Guild,
  userId: string,
  hasRole: (roleId: string) => boolean,
  how: ActivityKind,
  channel?: { id: string } | null,
): Promise<void> => {
  const key = `${guild.id}:${userId}`;
  const day = jstDay();
  if (touchedDays.get(key) !== day) {
    await touchLastActive(guild.id, userId, day);
    touchedDays.set(key, day);
  }

  const role = findInactiveRole(guild);
  if (!role || !hasRole(role.id) || removing.has(key)) return;
  removing.add(key);
  try {
    const member = await guild.members.fetch(userId).catch(() => null);
    if (!member?.roles.cache.has(role.id) || !role.editable) return;
    await member.roles.remove(role, `また来たため（${how}）`);
    void sendLog(guild, 'inactive', `${member} がまた来たので「${INACTIVE_ROLE_NAME}」を外しました（${how}）`, member, {
      title: '非アクティブから復帰',
      channel,
      fields: [{ name: '👋 きっかけ', value: how, inline: true }],
    });
  } finally {
    removing.delete(key);
  }
};

/** 発言（Bot・Webhook・システムメッセージは除く） */
export const noteMessageActivity = async (message: Message): Promise<void> => {
  if (!message.inGuild() || message.author.bot || message.webhookId || message.system) return;
  await noteActivity(message.guild, message.author.id, (id) => message.member?.roles.cache.has(id) ?? false, '発言', message.channel);
};

/** リアクション（Botは除く） */
export const noteReactionActivity = async (client: Client, data: GatewayMessageReactionAddDispatchData): Promise<void> => {
  const guild = data.guild_id ? client.guilds.cache.get(data.guild_id) : undefined;
  if (!guild || !data.member || data.member.user.bot) return;
  const roles = data.member.roles;
  await noteActivity(guild, data.user_id, (id) => roles.includes(id), 'リアクション', { id: data.channel_id });
};

/** VCに入った・移った（AFKチャンネルとBotは除く） */
export const noteVoiceActivity = async (oldState: VoiceState, newState: VoiceState): Promise<void> => {
  const { guild, member, channelId } = newState;
  if (!channelId || channelId === oldState.channelId || channelId === guild.afkChannelId || !member || member.user.bot) return;
  await noteActivity(guild, member.id, (id) => member.roles.cache.has(id), 'VC', newState.channel);
};

// ---- 1日1回の付け直し

export interface InactiveSyncResult {
  added: GuildMember[];
  removed: GuildMember[];
  /** 付け外しに失敗した人数 */
  failed: number;
  /** 付け直せなかった理由（ロールがない・Botのロールが下にある） */
  problem: string | null;
}

/**
 * 今の設定に合わせて「非アクティブ」を付け直す（オフなら全員から外す）。変わった人がいればログに残す。
 * actor は管理パネルから付け直した人（毎日の付け直しなら省く）
 */
export const syncInactiveRoles = async (guild: Guild, actor?: GuildMember, now: Date = new Date()): Promise<InactiveSyncResult> => {
  const settings = await loadInactiveRoleSettings(guild.id);
  const created = settings.enabled ? await ensureInactiveRole(guild) : null;
  if (created) void sendLog(guild, 'system', `「${INACTIVE_ROLE_NAME}」ロールがなかったので作成しました`);
  const role = created ?? findInactiveRole(guild);
  if (!role) {
    return { added: [], removed: [], failed: 0, problem: settings.enabled ? `「${INACTIVE_ROLE_NAME}」ロールを作れませんでした（Botにロールの管理権限があるか確認してください）` : null };
  }
  if (!role.editable) {
    return { added: [], removed: [], failed: 0, problem: `Botのロールが「${INACTIVE_ROLE_NAME}」より下にあるため、付け外しできません。サーバー設定 > ロール で、Botのロールを上にドラッグしてください` };
  }

  const members = await fetchAllMembers(guild);
  const inactive = settings.enabled ? await findInactiveMembers(guild, [...members.values()], settings.days, now) : new Set<string>();
  const result: InactiveSyncResult = { added: [], removed: [], failed: 0, problem: null };
  for (const member of members.values()) {
    const should = inactive.has(member.id);
    if (member.roles.cache.has(role.id) === should) continue;
    try {
      if (should) {
        await member.roles.add(role, `${settings.days}日間、発言・リアクション・VCがなかったため`);
        result.added.push(member);
      } else {
        await member.roles.remove(role, settings.enabled ? 'また来たため' : '「非アクティブ」をオフにしたため');
        result.removed.push(member);
      }
    } catch (error) {
      console.error(`「${member.user.tag}」の「${INACTIVE_ROLE_NAME}」を付け外しできませんでした:`, error);
      result.failed++;
    }
  }

  if (result.added.length > 0 || result.removed.length > 0 || result.failed > 0) {
    void sendLog(guild, 'inactive', `「${INACTIVE_ROLE_NAME}」を付け直しました（${describeSync(result)}）`, actor, {
      title: '非アクティブの付け直し',
      fields: [
        { name: '📅 日数', value: settings.enabled ? `${settings.days}日` : 'オフ（全員から外す）', inline: true },
        ...(result.added.length > 0 ? [{ name: `🌙 付けた（${result.added.length}人）`, value: listNames(result.added) }] : []),
        ...(result.removed.length > 0 ? [{ name: `👋 外した（${result.removed.length}人）`, value: listNames(result.removed) }] : []),
        ...(result.failed > 0 ? [{ name: '⚠ 付け外しできなかった', value: `${result.failed}人` }] : []),
      ],
    });
  }
  return result;
};

/**
 * days 日以上来ていない人のID。Bot・今VCにいる人・入って days 日たっていない人は除く。
 * 一度も来た記録がない人は、記録が days 日ぶんあるときだけ（記録が始まる前に来ていたかは分からないため）
 */
export const findInactiveMembers = async (guild: Guild, members: GuildMember[], days: number, now: Date = new Date()): Promise<Set<string>> => {
  const since = addDays(jstDay(now), -days);
  const sinceDate = dayStart(since);
  const [lastActiveDays, firstDay] = await Promise.all([listLastActiveDays(guild.id), findFirstRecordedDay(guild.id)]);
  const inVoice = new Set(
    guild.voiceStates.cache.filter((state) => !!state.channelId && state.channelId !== guild.afkChannelId).map((state) => state.id),
  );
  return new Set(
    members
      .filter((member) => {
        if (member.user.bot || inVoice.has(member.id) || !member.joinedAt || member.joinedAt >= sinceDate) return false;
        const last = lastActiveDays.get(member.id);
        return last ? last < since : !!firstDay && firstDay <= since;
      })
      .map((member) => member.id),
  );
};

/** 「付けた 3人・外した 1人」 */
export const describeSync = (result: InactiveSyncResult): string => {
  const parts = [
    ...(result.added.length > 0 ? [`付けた ${result.added.length}人`] : []),
    ...(result.removed.length > 0 ? [`外した ${result.removed.length}人`] : []),
    ...(result.failed > 0 ? [`できなかった ${result.failed}人`] : []),
  ];
  return parts.length > 0 ? parts.join('・') : '変わった人はいません';
};

const listNames = (members: GuildMember[]): string => {
  const rest = members.length - MAX_NAMES_IN_LOG;
  return [members.slice(0, MAX_NAMES_IN_LOG).map((member) => `${member}`).join('、'), ...(rest > 0 ? [`ほか ${rest}人`] : [])].join(' ');
};

/** 付け直した日（サーバーのID → 日）。日が変わったら付け直す */
const syncedDays = new Map<string, string>();

/** 起動時と、そのあと日が変わるたびに付け直す */
export const startInactiveRoles = (client: Client<true>): void => {
  const run = () => {
    const day = jstDay();
    for (const guild of client.guilds.cache.values()) {
      if (syncedDays.get(guild.id) === day) continue;
      syncedDays.set(guild.id, day);
      syncInactiveRoles(guild).catch((error: unknown) => {
        // 次の見回りでもう一度試す
        syncedDays.delete(guild.id);
        reportError(`「${guild.name}」の「${INACTIVE_ROLE_NAME}」を付け直せませんでした`, error, guild);
      });
    }
  };
  run();
  setInterval(run, SYNC_TICK_MS).unref();
};
