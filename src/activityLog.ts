import {
  ChannelType,
  EmbedBuilder,
  MessageFlags,
  PermissionFlagsBits,
  channelMention,
  time,
  userMention,
  type APIEmbedField,
  type Guild,
  type GuildMember,
  type GuildTextBasedChannel,
  type Message,
  type PartialGuildMember,
  type PartialMessage,
  type ReadonlyCollection,
  type TextChannel,
  type User,
  type VoiceBasedChannel,
  type VoiceState,
} from 'discord.js';
import { formatDuration } from './duration.js';
import { canBotPost, findTextChannel } from './guildUtils.js';
import type { UsedInvite } from './inviteTracker.js';
import {
  closeVoiceSession,
  closeVoiceSessionById,
  findMessageLogs,
  firstRecordedMessageAt,
  listOpenVoiceSessions,
  markMessagesDeleted,
  openVoiceSession,
  saveActivityLog,
  saveMessageLog,
  updateMessageLog,
  type StoredMessage,
} from './logStore.js';
import { nameById, nameWithUsername, replaceMentions } from './names.js';
import { ADMIN_ROLE_NAME, findAdminRole } from './permissions.js';

/** 行動ログを送るチャンネルの名前（なければログは送らない。DBには残す） */
export const LOG_CHANNEL_NAME = 'ログ';
/** 削除・編集ログに載せる本文の長さの上限（埋め込みの項目1つに収まるように） */
const MAX_CONTENT_LENGTH = 1000;
/** 埋め込みの項目1つ・本文に入る長さ（Discordの上限） */
const MAX_FIELD_LENGTH = 1024;
const MAX_DESCRIPTION_LENGTH = 4096;
/** これより新しいアカウントの参加は、捨てアカウントの可能性があるので目立たせる */
const NEW_ACCOUNT_DAYS = 7;
const DAY_MS = 24 * 60 * 60 * 1000;

/** label はログの埋め込みのタイトル（種類ごとに色を変えて、一覧で見分けやすくする） */
const LOG_STYLES = {
  join: { label: 'メンバー参加', color: 0x57f287 },
  leave: { label: 'メンバー退出', color: 0x4f545c },
  progress: { label: '進行度の変更', color: 0xd4a72c },
  unregister: { label: 'プロフィール削除', color: 0xed4245 },
  content: { label: 'コンテンツロールの変更', color: 0x9b59b6 },
  apply: { label: 'プロフィール申請', color: 0x5865f2 },
  approve: { label: '申請の許可', color: 0x57f287 },
  register: { label: 'プロフィール登録（管理者）', color: 0x57f287 },
  settings: { label: 'プロフィール変更', color: 0x5865f2 },
  reject: { label: '申請の拒否', color: 0xed4245 },
  kick: { label: 'キック（審査）', color: 0xe67e22 },
  ban: { label: 'BAN（審査）', color: 0x992d22 },
  voice: { label: 'VC', color: 0x3498db },
  vcNotice: { label: 'VC通知の設定', color: 0x3498db },
  inviteMe: { label: '「いつでも誘って」の設定', color: 0x57f287 },
  welcome: { label: '入った人への案内', color: 0x57f287 },
  autoApprove: { label: '申請の自動許可の設定', color: 0x57f287 },
  inactive: { label: '非アクティブ', color: 0x95a5a6 },
  level: { label: 'レベル・ランキング', color: 0xf1c40f },
  messageDelete: { label: 'メッセージ削除', color: 0xe67e22 },
  messageEdit: { label: 'メッセージ編集', color: 0xf1c40f },
  panel: { label: 'パネル設置', color: 0x99aab5 },
  recruit: { label: 'パーティ募集', color: 0x57f287 },
  moderation: { label: '管理操作', color: 0xe74c3c },
  invite: { label: '招待リンク', color: 0x1abc9c },
  command: { label: '管理コマンド', color: 0x607d8b },
  denied: { label: '権限拒否', color: 0xed4245 },
  error: { label: 'Botのエラー', color: 0xed4245 },
  system: { label: 'Bot', color: 0x99aab5 },
} as const;
export type LogKind = keyof typeof LOG_STYLES;

/** ログに付け足す情報（どれも任意） */
export interface LogDetails {
  /** 行動の対象になった人（実行した人と別のとき）。抜けた人など、IDしか分からないときはIDを渡す */
  target?: GuildMember | User | string;
  /** 起きた場所 */
  channel?: { id: string } | null;
  /**
   * 種類ごとの詳しい内容。inline の短いものは本文に「見出し: 内容」の1行で並べ、
   * 長いもの（メッセージの内容・ロールの一覧など）は項目として下に分けて出す
   */
  fields?: APIEmbedField[];
  /** 関連するメッセージ（申請・プロフィール・パネルなど）へのリンク */
  links?: { label: string; url: string }[];
  /** タイトルを種類の名前から変えたいとき（VCの入室・退出など） */
  title?: string;
}

/**
 * 行動ログを1件残す（「ログ」チャンネルに送り、DBにも保存する）。actor はその行動をした人。
 * 抜けた人はメンションが「@不明」と表示されるので、ユーザー名とIDも書く。
 * 呼び出し側は完了を待たずに進めるので、どんな失敗でも例外を外に出さない（コンソールに出すだけ）
 */
export const sendLog = async (
  guild: Guild,
  kind: LogKind,
  text: string,
  actor?: GuildMember | User,
  details: LogDetails = {},
): Promise<void> => {
  try {
    const { label, color } = LOG_STYLES[kind];
    const title = details.title ?? label;
    const { target, fields = [], links = [] } = details;
    const targetId = typeof target === 'string' ? target : target?.id;
    const showTarget = target !== undefined && targetId !== actor?.id;
    const shown = fields.filter((field) => field.value);

    void saveActivityLog({
      guildId: guild.id,
      kind,
      title,
      text,
      actorId: actor?.id ?? null,
      actorName: actor ? nameOf(actor) : null,
      targetId: showTarget ? (targetId ?? null) : null,
      targetName: showTarget && target !== undefined && typeof target !== 'string' ? nameOf(target) : null,
      channelId: details.channel?.id ?? null,
      details: [...shown.map(({ name, value }) => ({ name, value })), ...links.map((link) => ({ name: link.label, value: link.url }))],
    }).catch((error: unknown) => {
      console.error('ログをDBに保存できませんでした:', error);
    });

    const channel = findTextChannel(guild, LOG_CHANNEL_NAME);
    if (!channel || !canBotPost(channel)) return;

    // 埋め込みのメンションは、読み込まれていない人だと正しく出ないので名前にして出す（DBにはメンションのまま残す）
    const known = new Map(
      [actor, typeof target === 'string' ? undefined : target].flatMap((who) => (who ? [[who.id, who.displayName] as const] : [])),
    );
    const display = (value: string): string => replaceMentions(guild, value, known);

    // 本文: 何があったかの一文と、「👤 ユーザー: …」のような1行ずつの情報
    const people =
      actor && showTarget && target !== undefined
        ? [`🛠️ 実行者: ${describeUser(guild, actor)}`, `👤 対象: ${describeUser(guild, target)}`, `🆔 対象のID: ${targetId}`]
        : actor
          ? [`👤 ユーザー: ${describeUser(guild, actor)}`, `🆔 ユーザーID: ${actor.id}`]
          : target !== undefined
            ? [`👤 対象: ${describeUser(guild, target)}`, `🆔 対象のID: ${targetId}`]
            : [];
    const lines = [
      ...people,
      ...(details.channel ? [`📢 チャンネル: ${channelMention(details.channel.id)}`] : []),
      ...shown.filter((field) => field.inline).map((field) => `${field.name}: ${display(field.value).replace(/\n/g, ' / ')}`),
    ];
    const embed = new EmbedBuilder()
      .setColor(color)
      .setTitle(title)
      .setDescription(clip([display(text), ...(lines.length > 0 ? ['', ...lines] : [])].join('\n'), MAX_DESCRIPTION_LENGTH))
      .addFields(
        // 空の項目は送れないので除く。長すぎる項目は途中で切る
        ...shown.filter((field) => !field.inline).map((field) => ({ name: field.name, value: clip(display(field.value), MAX_FIELD_LENGTH) })),
        ...(links.length > 0 ? [{ name: '🔗 リンク', value: links.map((link) => `[${link.label}](${link.url})`).join('\n') }] : []),
      )
      .setTimestamp();
    // 誰についてのログか一目で分かるよう、上に実行した人、右に対象（いなければ実行した人）のアイコンを出す
    if (actor) embed.setAuthor({ name: actor.displayName, iconURL: actor.displayAvatarURL() });
    const pictured = showTarget ? (typeof target === 'string' ? undefined : target) : actor;
    if (pictured) embed.setThumbnail(pictured.displayAvatarURL());
    // ログは後から見返すものなので、通知は飛ばさない
    await channel.send({ embeds: [embed], flags: MessageFlags.SuppressNotifications, allowedMentions: { parse: [] } });
  } catch (error) {
    console.error('ログを送れませんでした:', error);
  }
};

/** 「**名前**（@ユーザー名）」。IDしか分からない人は、サーバーにいれば名前、いなければその旨 */
const describeUser = (guild: Guild, who: GuildMember | User | string): string =>
  typeof who === 'string' ? nameById(guild, who) : nameWithUsername(who);

const usernameOf = (who: GuildMember | User): string => ('user' in who ? who.user : who).username;

/** DBに残す名前（抜けたあとでも誰か分かるように、表示名とユーザー名の両方） */
const nameOf = (who: GuildMember | User): string => `${who.displayName}（${usernameOf(who)}）`;

/** 日時と「〇日前」 */
export const describeDate = (date: Date): string => `${time(date, 'f')}（${time(date, 'R')}）`;

/**
 * 「ログ」チャンネルがなければ作る。作ったときはそのチャンネルを返す。
 * 管理用なので @everyone からは見えなくし、「管理者」ロールとBotだけが見られるようにする
 */
export const ensureLogChannel = async (guild: Guild): Promise<TextChannel | null> => {
  if (findTextChannel(guild, LOG_CHANNEL_NAME)) return null;

  const me = guild.members.me ?? (await guild.members.fetchMe());
  if (!me.permissions.has(PermissionFlagsBits.ManageChannels)) {
    console.warn(`「${guild.name}」: Botにチャンネルの管理権限がないため、「${LOG_CHANNEL_NAME}」チャンネルを作れません`);
    return null;
  }

  const adminRole = findAdminRole(guild);
  const channel = await guild.channels.create({
    name: LOG_CHANNEL_NAME,
    type: ChannelType.GuildText,
    topic: 'Botの行動ログ（参加・退出、申請と審査、進行度、VCの出入りなど）',
    reason: 'Botの行動ログ用',
    permissionOverwrites: [
      { id: guild.roles.everyone.id, deny: [PermissionFlagsBits.ViewChannel] },
      {
        id: me.id,
        allow: [
          PermissionFlagsBits.ViewChannel,
          PermissionFlagsBits.SendMessages,
          PermissionFlagsBits.EmbedLinks,
          PermissionFlagsBits.ReadMessageHistory,
        ],
      },
      ...(adminRole
        ? [{ id: adminRole.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.ReadMessageHistory] }]
        : []),
    ],
  });
  console.log(`「${guild.name}」に「${LOG_CHANNEL_NAME}」チャンネルを作りました`);
  return channel;
};

// ---- 参加・退出

/** サーバーへの参加をログに残す。invite は使われた招待リンク（分からなければ null）、welcome は案内のDMを送れたか */
export const logMemberJoin = async (member: GuildMember, invite: UsedInvite | null = null, welcome: string | null = null): Promise<void> => {
  const { user } = member;
  const isNewAccount = Date.now() - user.createdTimestamp < NEW_ACCOUNT_DAYS * DAY_MS;
  await sendLog(
    member.guild,
    'join',
    [
      `${member} がサーバーに参加しました${user.bot ? '（Bot）' : ''}`,
      ...(isNewAccount ? [`⚠ 作成から${NEW_ACCOUNT_DAYS}日以内の新しいアカウントです`] : []),
    ].join('\n'),
    member,
    {
      fields: [
        { name: '🕒 アカウント作成', value: describeDate(user.createdAt), inline: true },
        { name: '🔗 招待リンク', value: describeInvite(invite), inline: true },
        { name: '👥 メンバー数', value: `${member.guild.memberCount}人`, inline: true },
        ...(welcome ? [{ name: '✉️ 案内のDM', value: welcome, inline: true }] : []),
      ],
    },
  );
};

const describeInvite = (invite: UsedInvite | null): string => {
  if (!invite) return '不明（1回限り・期限切れのリンク、またはBotが招待リンクを見られない設定）';
  if (invite.vanity) return `discord.gg/${invite.code}（サーバーのカスタムURL・${invite.uses}回目）`;
  return `discord.gg/${invite.code}（作成: ${invite.inviterId ? userMention(invite.inviterId) : '不明'}${invite.personal ? '・専用リンク' : ''}・${invite.uses}回目）`;
};

/** キック・BANで抜けたとき、誰がやったか（監査ログから） */
export interface MemberRemoval {
  kind: 'kick' | 'ban';
  executorId: string | null;
  reason: string | null;
}

/**
 * サーバーからの退出をログに残す（キック・BANされた場合はそれも書く）。
 * Botが覚えていなかったメンバーは、参加日やロールが分からないので省く。
 * cleanupNotes には、プロフィールの投稿を消したなどの後片付けの結果を渡す
 */
export const logMemberLeave = async (
  member: GuildMember | PartialGuildMember,
  cleanupNotes: string[] = [],
  removal: MemberRemoval | null = null,
): Promise<void> => {
  const { user, guild } = member;
  const roleNames = member.partial ? [] : member.roles.cache.filter((role) => role.id !== guild.id).map((role) => role.name);
  const how = removal ? (removal.kind === 'kick' ? 'キックされました' : 'BANされました') : '退出しました';
  await sendLog(guild, 'leave', `${user} がサーバーから${how}${user.bot ? '（Bot）' : ''}`, user, {
    title: removal ? `メンバー退出（${removal.kind === 'kick' ? 'キック' : 'BAN'}）` : undefined,
    fields: [
      ...(removal
        ? [
            { name: '🔨 実行者', value: removal.executorId ? userMention(removal.executorId) : '不明', inline: true },
            { name: '📝 理由', value: removal.reason ?? '（理由なし）', inline: true },
          ]
        : []),
      ...(member.joinedAt
        ? [
            { name: '📅 参加日', value: describeDate(member.joinedAt), inline: true },
            { name: '⏳ 在籍期間', value: formatDuration(Date.now() - member.joinedAt.getTime()), inline: true },
          ]
        : []),
      { name: '👥 メンバー数', value: `${guild.memberCount}人`, inline: true },
      ...(roleNames.length > 0 ? [{ name: `🏷️ 持っていたロール（${roleNames.length}）`, value: roleNames.join('、') }] : []),
      ...(cleanupNotes.length > 0 ? [{ name: '🧹 後片付け', value: cleanupNotes.join('\n') }] : []),
    ],
  });
};

// ---- メッセージ

/** 発言をDBに残す（あとで消されたり編集されたりしたとき、再起動をまたいでも内容が分かるように） */
export const recordMessage = async (message: Message): Promise<void> => {
  if (!message.inGuild() || !isLoggableMessage(message) || message.system) return;
  await saveMessageLog(message.guildId, toStored(message));
};

const toStored = (message: Message<true>): StoredMessage => ({
  messageId: message.id,
  channelId: message.channelId,
  authorId: message.author.id,
  authorName: message.member ? `${message.member.displayName}（${message.author.username}）` : message.author.username,
  content: message.content,
  attachments: message.attachments.map((file) => file.name),
  createdAt: message.createdAt,
});

/** 削除されたメッセージをログに残す。Botが覚えていないメッセージ（起動前のものなど）は、DBの記録から内容を出す */
export const logMessageDelete = async (message: Message | PartialMessage): Promise<void> => {
  if (!message.inGuild() || !isLoggableMessage(message)) return;
  const stored = (await findMessageLogs([message.id]).catch(() => new Map<string, StoredMessage>())).get(message.id);
  // 記録を始めた後のメッセージなのに記録がないなら、Bot・Webhookのメッセージ（Botが古いパネルを消したときなど）
  if (message.partial && !stored) {
    const first = await firstRecordedMessageAt(message.guildId).catch(() => null);
    if (first && message.createdAt > first) return;
  }
  await markMessagesDeleted([message.id]).catch(() => undefined);
  // Botが覚えていなくても、DBに記録があれば誰のメッセージか分かる。どちらにもなければ、消されたことだけ残す
  const authorId = message.author?.id ?? stored?.authorId;
  const content = describeContent(message, stored);
  await sendLog(
    message.guild,
    'messageDelete',
    `${authorId ? `${userMention(authorId)} のメッセージ` : 'メッセージ'}が削除されました`,
    message.author ?? undefined,
    {
      ...(message.author ? {} : authorId ? { target: authorId } : {}),
      channel: message.channel,
      fields: [
        { name: '🕒 送信日時', value: describeDate(message.createdAt), inline: true },
        { name: '🆔 メッセージID', value: message.id, inline: true },
        { name: '💬 内容', value: content.text },
        ...(content.attachments ? [{ name: '📎 添付ファイル', value: content.attachments }] : []),
      ],
    },
  );
};

/** 編集されたメッセージをログに残す。リンクのプレビューが付いた・ピン留めなど、本文が変わっていないものは残さない */
export const logMessageUpdate = async (
  oldMessage: Message | PartialMessage,
  newMessage: Message | PartialMessage,
): Promise<void> => {
  const message = newMessage.partial ? await newMessage.fetch().catch(() => null) : newMessage;
  if (!message?.inGuild() || !isLoggableMessage(message)) return;
  const stored = oldMessage.partial
    ? (await findMessageLogs([message.id]).catch(() => new Map<string, StoredMessage>())).get(message.id)
    : undefined;
  const before = oldMessage.partial ? stored?.content : oldMessage.content;
  if (before === message.content) return;
  await updateMessageLog(message.id, message.content, message.attachments.map((file) => file.name)).catch(() => undefined);

  await sendLog(message.guild, 'messageEdit', `${message.author} がメッセージを編集しました`, message.author, {
    channel: message.channel,
    fields: [
      { name: '🕒 送信日時', value: describeDate(message.createdAt), inline: true },
      { name: '🆔 メッセージID', value: message.id, inline: true },
      { name: '📝 編集前', value: describeContent(oldMessage, stored).text },
      { name: '📝 編集後', value: describeContent(message).text },
    ],
    links: [{ label: 'メッセージへ移動', url: message.url }],
  });
};

/** まとめて削除されたメッセージは、件数と、分かる範囲で誰のメッセージだったかを残す */
export const logMessageBulkDelete = async (
  messages: ReadonlyCollection<string, Message | PartialMessage>,
  channel: GuildTextBasedChannel,
): Promise<void> => {
  if (channel.id === findTextChannel(channel.guild, LOG_CHANNEL_NAME)?.id) return;
  const ids = [...messages.keys()];
  const stored = await findMessageLogs(ids).catch(() => new Map<string, StoredMessage>());
  await markMessagesDeleted(ids).catch(() => undefined);

  const counts = new Map<string, number>();
  for (const message of messages.values()) {
    const authorId = message.author?.id ?? stored.get(message.id)?.authorId;
    const who = authorId ? userMention(authorId) : '不明';
    counts.set(who, (counts.get(who) ?? 0) + 1);
  }
  await sendLog(channel.guild, 'messageDelete', `メッセージが${messages.size}件まとめて削除されました`, undefined, {
    title: 'メッセージの一括削除',
    channel,
    fields: [
      { name: '🔢 件数', value: `${messages.size}件`, inline: true },
      {
        name: '👥 誰のメッセージか',
        value: [...counts]
          .sort((a, b) => b[1] - a[1])
          .map(([who, count]) => `${who} ${count}件`)
          .join('\n'),
      },
    ],
  });
};

/** Bot・Webhookのメッセージと、ログチャンネル自体のメッセージは残さない */
const isLoggableMessage = (message: Message<true>): boolean =>
  !message.author?.bot && !message.webhookId && message.channelId !== findTextChannel(message.guild, LOG_CHANNEL_NAME)?.id;

/** ログに載せる本文と添付ファイル。Botが覚えていないメッセージは、DBの記録（stored）から出す */
const describeContent = (
  message: Message | PartialMessage,
  stored?: StoredMessage,
): { text: string; attachments: string | null } => {
  if (message.partial) {
    if (!stored) return { text: '（Botが記録する前のメッセージのため、内容は分かりません）', attachments: null };
    return {
      text: stored.content ? clip(stored.content, MAX_CONTENT_LENGTH) : '（本文なし）',
      attachments: stored.attachments.length > 0 ? stored.attachments.join('\n') : null,
    };
  }
  // 添付ファイルは削除と同時に Discord から消えるので、ファイル名だけ残す
  const files = [
    ...message.attachments.map((file) => file.name),
    ...message.stickers.map((sticker) => `ステッカー: ${sticker.name}`),
  ];
  return {
    text: message.content ? clip(message.content, MAX_CONTENT_LENGTH) : '（本文なし）',
    attachments: files.length > 0 ? files.join('\n') : null,
  };
};

const clip = (text: string, max: number): string => (text.length > max ? `${text.slice(0, max - 1)}…` : text);

// ---- VC

/** VCの入室・退出・移動をログに残す（ミュートの切り替えなどと、Botの出入りは除く）。入っていた時間はDBで数える */
export const logVoiceActivity = async (oldState: VoiceState, newState: VoiceState): Promise<void> => {
  const member = newState.member ?? oldState.member;
  if (!member || member.user.bot || oldState.channelId === newState.channelId) return;

  const now = new Date();
  const { channel: from } = oldState;
  const { channel: to } = newState;
  // 前のVCにいた時間（Botが記録する前から入っていた人は分からない）
  const session = from ? await closeVoiceSession(member.guild.id, member.id, now).catch(() => null) : null;
  const stayed = session
    ? `${formatDuration(now.getTime() - session.joinedAt.getTime())}${session.startEstimated ? '以上（Botの再起動をはさむため目安）' : ''}`
    : '不明（Botが記録する前から入室）';
  if (to) await openVoiceSession(member.guild.id, member.id, nameOfMember(member), to.id, now).catch(() => undefined);

  const people = (channel: VoiceBasedChannel): string => `${channel.members.filter((m) => !m.user.bot).size}人`;
  if (!from && to) {
    await sendLog(newState.guild, 'voice', `${member} が ${to} に入室しました`, member, {
      title: 'VC入室',
      channel: to,
      fields: [{ name: '👥 入室後の人数', value: people(to), inline: true }],
    });
  } else if (from && !to) {
    await sendLog(newState.guild, 'voice', `${member} が ${from} から退出しました`, member, {
      title: 'VC退出',
      channel: from,
      fields: [
        { name: '⏱️ 滞在時間', value: stayed, inline: true },
        { name: '👥 残っている人数', value: people(from), inline: true },
      ],
    });
  } else if (from && to) {
    await sendLog(newState.guild, 'voice', `${member} が ${from} → ${to} に移動しました`, member, {
      title: 'VC移動',
      fields: [
        { name: '⬅️ 移動元', value: `${from}`, inline: true },
        { name: '➡️ 移動先', value: `${to}`, inline: true },
        { name: '⏱️ 移動元にいた時間', value: stayed, inline: true },
        { name: '👥 移動先の人数', value: people(to), inline: true },
      ],
    });
  }
};

const nameOfMember = (member: GuildMember): string => `${member.displayName}（${member.user.username}）`;

/**
 * 起動時に、VCの記録を今の状態に合わせる。Botが止まっている間に抜けた人の記録は今の時刻で終わらせ、
 * 止まっている間に入った人は、今入ったことにして記録を始める（入った時刻は目安）
 */
export const reconcileVoiceSessions = async (guild: Guild): Promise<void> => {
  const now = new Date();
  const open = await listOpenVoiceSessions(guild.id);
  const stillThere = new Set<string>();
  for (const session of open) {
    const state = guild.voiceStates.cache.get(session.userId);
    if (state?.channelId === session.channelId && !stillThere.has(session.userId)) {
      stillThere.add(session.userId);
    } else {
      await closeVoiceSessionById(session.id, now);
    }
  }
  for (const state of guild.voiceStates.cache.values()) {
    if (!state.channelId || !state.member || state.member.user.bot || stillThere.has(state.id)) continue;
    await openVoiceSession(guild.id, state.id, nameOfMember(state.member), state.channelId, now, true);
  }
};
