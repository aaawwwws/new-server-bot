import {
  AuditLogEvent,
  PermissionFlagsBits,
  PermissionsBitField,
  channelMention,
  roleMention,
  userMention,
  type APIEmbedField,
  type Guild,
  type GuildAuditLogsEntry,
  type GuildMember,
  type User,
} from 'discord.js';
import { describeDate, sendLog, type MemberRemoval } from './activityLog.js';

// Discordの監査ログ（誰が何をしたか）から、Botを通さない管理操作もログに残す。
// Bot自身の操作は、それぞれの機能が詳しいログを残すので、ここでは残さない

/** 監査ログからのログの中身。target は対象の人のID（チャンネル・ロールなど、人でないものが対象なら付けない） */
interface ModerationLog {
  title: string;
  text: string;
  target?: string;
  channelId?: string;
  fields?: APIEmbedField[];
}

/** 変わった設定の名前（DiscordのAPIの名前 → 画面の名前） */
const KEY_LABELS: Record<string, string> = {
  name: '名前',
  topic: 'トピック',
  nsfw: '年齢制限',
  rate_limit_per_user: '低速モード（秒）',
  bitrate: 'ビットレート',
  user_limit: '人数制限',
  parent_id: 'カテゴリー',
  rtc_region: '地域',
  video_quality_mode: '画質',
  default_auto_archive_duration: 'スレッドの自動アーカイブ',
  permissions: '権限',
  allow: '許可した権限',
  deny: '拒否した権限',
  color: '色',
  colors: '色',
  hoist: 'メンバー一覧で分けて表示',
  mentionable: '誰でもメンションできる',
  icon_hash: 'アイコン',
  unicode_emoji: '絵文字',
  description: '説明',
  verification_level: '認証レベル',
  explicit_content_filter: '不適切なメディアのフィルター',
  default_message_notifications: '通知の初期設定',
  afk_channel_id: 'AFKチャンネル',
  afk_timeout: 'AFKになるまでの時間（秒）',
  system_channel_id: 'システムメッセージのチャンネル',
  rules_channel_id: 'ルールのチャンネル',
  public_updates_channel_id: 'コミュニティ更新のチャンネル',
  vanity_url_code: 'カスタムURL',
  banner_hash: 'バナー',
  splash_hash: '招待の背景',
  owner_id: 'オーナー',
  mfa_level: '管理者の2段階認証',
  preferred_locale: '言語',
};
/** 並び替えなど、残しても役に立たない変更 */
const IGNORED_KEYS = new Set(['position', 'id', 'guild_id', 'type', 'flags', 'permission_overwrites']);
const CHANNEL_KEYS = new Set(['parent_id', 'afk_channel_id', 'system_channel_id', 'rules_channel_id', 'public_updates_channel_id']);
const MAX_VALUE_LENGTH = 100;

export const handleAuditLogEntry = async (entry: GuildAuditLogsEntry, guild: Guild): Promise<void> => {
  const { executorId } = entry;
  if (!executorId || executorId === guild.client.user.id) return;
  const executor = await findPerson(guild, executorId);
  // ほかのBotが自動で付け外しするロール（VCに入ったら付くロールなど）は数が多いので残さない
  if (entry.action === AuditLogEvent.MemberRoleUpdate && executor && userOf(executor).bot) return;

  for (const log of describeEntry(entry, userMention(executorId))) {
    const target = log.target ? ((await findPerson(guild, log.target)) ?? log.target) : undefined;
    await sendLog(guild, 'moderation', log.text, executor ?? undefined, {
      title: log.title,
      target,
      channel: log.channelId ? { id: log.channelId } : null,
      fields: [...(log.fields ?? []), ...(entry.reason ? [{ name: '📝 理由', value: entry.reason }] : [])],
    });
  }
};

/** 監査ログの1件を、ログの中身にする（1件に複数の変更が入っていることがあるので、いくつか返すことがある） */
const describeEntry = (entry: GuildAuditLogsEntry, executor: string): ModerationLog[] => {
  const targetId = entry.targetId ?? undefined;
  const target = targetId ? userMention(targetId) : '誰か';
  const extra: unknown = entry.extra;
  const change = (key: string) => entry.changes.find((c) => c.key === key);

  switch (entry.action) {
    case AuditLogEvent.MemberRoleUpdate: {
      const names = (key: string) => {
        const roles = change(key)?.new;
        return Array.isArray(roles) ? roles.map((role: { name?: string }) => role.name ?? '').filter(Boolean) : [];
      };
      const added = names('$add');
      const removed = names('$remove');
      return [
        {
          title: 'ロール変更',
          text: `${executor} が ${target} のロールを変更しました`,
          target: targetId,
          fields: [
            ...(added.length > 0 ? [{ name: '➕ 付与', value: added.join('、'), inline: true }] : []),
            ...(removed.length > 0 ? [{ name: '➖ 剥奪', value: removed.join('、'), inline: true }] : []),
          ],
        },
      ];
    }
    case AuditLogEvent.MemberUpdate:
      return entry.changes.flatMap((c): ModerationLog[] => {
        const self = entry.executorId === entry.targetId;
        switch (c.key) {
          case 'nick':
            return [
              {
                title: 'ニックネーム変更',
                text: self ? `${target} がニックネームを変更しました` : `${executor} が ${target} のニックネームを変更しました`,
                target: targetId,
                fields: [
                  { name: '📝 変更前', value: `${c.old ?? '（なし）'}`, inline: true },
                  { name: '📝 変更後', value: `${c.new ?? '（なし）'}`, inline: true },
                ],
              },
            ];
          case 'communication_disabled_until':
            return [
              c.new
                ? {
                    title: 'タイムアウト',
                    text: `${executor} が ${target} をタイムアウトしました`,
                    target: targetId,
                    fields: [{ name: '⏰ 解除される日時', value: describeDate(new Date(String(c.new))), inline: true }],
                  }
                : { title: 'タイムアウト解除', text: `${executor} が ${target} のタイムアウトを解除しました`, target: targetId },
            ];
          case 'mute':
            return [{ title: c.new ? 'サーバーミュート' : 'サーバーミュート解除', text: `${executor} が ${target} を${c.new ? 'サーバーミュート' : 'サーバーミュート解除'}しました`, target: targetId }];
          case 'deaf':
            return [{ title: c.new ? 'サーバースピーカーミュート' : 'サーバースピーカーミュート解除', text: `${executor} が ${target} を${c.new ? 'スピーカーミュート' : 'スピーカーミュート解除'}しました`, target: targetId }];
          default:
            return [];
        }
      });
    case AuditLogEvent.MemberKick:
      return [{ title: 'キック', text: `${executor} が ${target} をキックしました`, target: targetId }];
    case AuditLogEvent.MemberBanAdd:
      return [{ title: 'BAN', text: `${executor} が ${target} をBANしました`, target: targetId }];
    case AuditLogEvent.MemberBanRemove:
      return [{ title: 'BAN解除', text: `${executor} が ${target} のBANを解除しました`, target: targetId }];
    case AuditLogEvent.MemberPrune: {
      const { removed = 0, days = 0 } = isRecord(extra) ? (extra as { removed?: number; days?: number }) : {};
      return [{ title: 'メンバーの整理', text: `${executor} が、${days}日以上動いていないメンバー${removed}人をサーバーから外しました` }];
    }
    case AuditLogEvent.MemberMove: {
      const { channelId, count } = channelAndCount(extra);
      return [{ title: 'VC移動（管理者）', text: `${executor} が ${count}人を ${channelId ? channelMention(channelId) : 'VC'} に移動しました`, channelId }];
    }
    case AuditLogEvent.MemberDisconnect: {
      const { count } = channelAndCount(extra);
      return [{ title: 'VC切断（管理者）', text: `${executor} が ${count}人をVCから切断しました` }];
    }
    case AuditLogEvent.MessageDelete: {
      const { channelId, count } = channelAndCount(extra);
      return [
        {
          title: 'メッセージ削除（管理者）',
          text: `${executor} が ${target} のメッセージを削除しました`,
          target: targetId,
          channelId,
          fields: count > 1 ? [{ name: '🔢 件数', value: `${count}件`, inline: true }] : [],
        },
      ];
    }
    case AuditLogEvent.MessageBulkDelete: {
      const { count } = channelAndCount(extra);
      return [
        {
          title: 'メッセージ一括削除（管理者）',
          text: `${executor} が ${targetId ? channelMention(targetId) : 'チャンネル'} でメッセージを${count}件まとめて削除しました`,
          channelId: targetId,
        },
      ];
    }
    case AuditLogEvent.ChannelCreate:
      return [{ title: 'チャンネル作成', text: `${executor} がチャンネル ${targetId ? channelMention(targetId) : ''}（${nameIn(entry, 'new')}）を作成しました` }];
    case AuditLogEvent.ChannelDelete:
      return [{ title: 'チャンネル削除', text: `${executor} がチャンネル「${nameIn(entry, 'old')}」を削除しました` }];
    case AuditLogEvent.ChannelUpdate:
      return settingChanges(entry, 'チャンネル設定変更', `${executor} が ${targetId ? channelMention(targetId) : 'チャンネル'} の設定を変更しました`, targetId);
    case AuditLogEvent.ChannelOverwriteCreate:
    case AuditLogEvent.ChannelOverwriteUpdate:
    case AuditLogEvent.ChannelOverwriteDelete: {
      const verb = { [AuditLogEvent.ChannelOverwriteCreate]: '追加', [AuditLogEvent.ChannelOverwriteUpdate]: '変更', [AuditLogEvent.ChannelOverwriteDelete]: '削除' }[entry.action];
      return [
        {
          title: 'チャンネル権限変更',
          text: `${executor} が ${targetId ? channelMention(targetId) : 'チャンネル'} の ${overwriteTarget(extra)} の権限を${verb}しました`,
          channelId: targetId,
          fields: permissionChanges(entry),
        },
      ];
    }
    case AuditLogEvent.RoleCreate:
      return [{ title: 'ロール作成', text: `${executor} がロール ${targetId ? roleMention(targetId) : ''}（${nameIn(entry, 'new')}）を作成しました` }];
    case AuditLogEvent.RoleDelete:
      return [{ title: 'ロール削除', text: `${executor} がロール「${nameIn(entry, 'old')}」を削除しました` }];
    case AuditLogEvent.RoleUpdate:
      return settingChanges(entry, 'ロール設定変更', `${executor} がロール ${targetId ? roleMention(targetId) : ''} の設定を変更しました`);
    case AuditLogEvent.GuildUpdate:
      return settingChanges(entry, 'サーバー設定変更', `${executor} がサーバーの設定を変更しました`);
    case AuditLogEvent.BotAdd:
      return [{ title: 'Bot追加', text: `${executor} が ${target} をサーバーに追加しました`, target: targetId }];
    default:
      return [];
  }
};

/** 設定の変更を「名前: 前 → 後」で並べる。並び替えだけなどで残すものがなければ、ログにしない */
const settingChanges = (entry: GuildAuditLogsEntry, title: string, text: string, channelId?: string): ModerationLog[] => {
  const fields = entry.changes.flatMap((c): APIEmbedField[] => {
    if (IGNORED_KEYS.has(c.key)) return [];
    if (c.key === 'permissions') return permissionChanges(entry);
    const label = KEY_LABELS[c.key] ?? c.key;
    return [{ name: `✏️ ${label}`, value: `${formatValue(c.key, c.old)} → ${formatValue(c.key, c.new)}`, inline: true }];
  });
  return fields.length > 0 ? [{ title, text, channelId, fields }] : [];
};

/** 権限の数値から、増えた・減った権限の名前を出す */
const permissionChanges = (entry: GuildAuditLogsEntry): APIEmbedField[] =>
  entry.changes.flatMap((c): APIEmbedField[] => {
    if (c.key !== 'permissions' && c.key !== 'allow' && c.key !== 'deny') return [];
    const before = new PermissionsBitField(BigInt(String(c.old ?? 0)));
    const after = new PermissionsBitField(BigInt(String(c.new ?? 0)));
    const added = after.toArray().filter((name) => !before.has(name));
    const removed = before.toArray().filter((name) => !after.has(name));
    const label = KEY_LABELS[c.key] ?? c.key;
    return [
      ...(added.length > 0 ? [{ name: `➕ ${label}（増えた）`, value: added.join(', ') }] : []),
      ...(removed.length > 0 ? [{ name: `➖ ${label}（減った）`, value: removed.join(', ') }] : []),
    ];
  });

const formatValue = (key: string, value: unknown): string => {
  if (value === null || value === undefined || value === '') return '（なし）';
  if (typeof value === 'boolean') return value ? 'オン' : 'オフ';
  if ((key === 'color' || key === 'colors') && typeof value === 'number') return `#${value.toString(16).padStart(6, '0')}`;
  if (CHANNEL_KEYS.has(key)) return channelMention(String(value));
  if (key === 'owner_id') return userMention(String(value));
  const text = typeof value === 'object' ? JSON.stringify(value) : String(value);
  return text.length > MAX_VALUE_LENGTH ? `${text.slice(0, MAX_VALUE_LENGTH - 1)}…` : text;
};

const nameIn = (entry: GuildAuditLogsEntry, side: 'old' | 'new'): string => {
  const value = entry.changes.find((c) => c.key === 'name')?.[side];
  return typeof value === 'string' ? value : '名前不明';
};

/** 権限を変えた相手（ロールかメンバー） */
const overwriteTarget = (extra: unknown): string => {
  if (!isRecord(extra)) return '誰か';
  const { id, name } = extra as { id?: string; name?: string };
  if ('roles' in extra || ('user' in extra && id)) return id ? userMention(id) : 'メンバー';
  if (name) return `ロール「${name}」`;
  return id ? userMention(id) : '誰か';
};

const channelAndCount = (extra: unknown): { channelId?: string; count: number } => {
  if (!isRecord(extra)) return { count: 1 };
  const { channel, count } = extra as { channel?: { id?: string }; count?: number };
  return { channelId: channel?.id, count: count ?? 1 };
};

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null;

const findPerson = async (guild: Guild, id: string): Promise<GuildMember | User | null> =>
  guild.members.cache.get(id) ?? (await guild.client.users.fetch(id).catch(() => null));

const userOf = (who: GuildMember | User): User => ('user' in who ? who.user : who);

/** 抜けた人がキック・BANされたのなら、誰がやったか（監査ログから）。そうでなければ null */
export const findRemoval = async (guild: Guild, userId: string): Promise<MemberRemoval | null> => {
  if (!guild.members.me?.permissions.has(PermissionFlagsBits.ViewAuditLog)) return null;
  const recent = (entry: { targetId: string | null; createdTimestamp: number }) =>
    entry.targetId === userId && Date.now() - entry.createdTimestamp < REMOVAL_WINDOW_MS;
  const kicks = await guild.fetchAuditLogs({ type: AuditLogEvent.MemberKick, limit: 5 }).catch(() => null);
  const kick = kicks?.entries.find(recent);
  if (kick) return { kind: 'kick', executorId: kick.executorId, reason: kick.reason };
  const bans = await guild.fetchAuditLogs({ type: AuditLogEvent.MemberBanAdd, limit: 5 }).catch(() => null);
  const ban = bans?.entries.find(recent);
  if (ban) return { kind: 'ban', executorId: ban.executorId, reason: ban.reason };
  return null;
};

/** 抜けた時刻からこの間に記録されたキック・BANを、その退出のものとみなす */
const REMOVAL_WINDOW_MS = 30_000;
