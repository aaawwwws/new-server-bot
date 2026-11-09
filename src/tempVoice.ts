import { setTimeout as sleep } from 'node:timers/promises';
import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelSelectMenuBuilder,
  ChannelType,
  DiscordAPIError,
  EmbedBuilder,
  LabelBuilder,
  MessageFlags,
  ModalBuilder,
  OverwriteType,
  PermissionFlagsBits,
  RESTJSONErrorCodes,
  StringSelectMenuBuilder,
  TextInputBuilder,
  TextInputStyle,
  UserSelectMenuBuilder,
  channelMention,
  escapeMarkdown,
  type ButtonInteraction,
  type CategoryChannel,
  type Client,
  type Collection,
  type Guild,
  type GuildMember,
  type Message,
  type ModalSubmitInteraction,
  type VoiceBasedChannel,
  type VoiceChannel,
  type VoiceState,
} from 'discord.js';
import { sendLog } from './activityLog.js';
import { formatDuration } from './duration.js';
import { reportError } from './errorReporter.js';
import { createLock } from './locks.js';
import { boldName, nameById } from './names.js';
import { ensureAdmin, isAdmin } from './permissions.js';
import {
  deleteLobby,
  deleteRoom,
  findLobby,
  findRoom,
  findRoomByOwner,
  listLobbies,
  listRooms,
  loadTempVoice,
  saveLobby,
  saveRoom,
  type VoiceLobby,
  type VoiceRoom,
} from './tempVoiceStore.js';

// 一時VC。管理者が決めた入口のVCに入ると、その人の部屋を作って移動させる。全員抜けると部屋は消える。
// 部屋の持ち主（オーナー）は、部屋のチャットの操作パネルから鍵・名前・人数・招待・キック・BAN・譲渡ができる。
// 招待とBANはVCの権限（その人への Connect の許可・拒否）に残すので、DBには持たない。
// customId は「tempvc:<操作>」

export const CUSTOM_ID_PREFIX = 'tempvc:';
/** 管理パネルの「🔊 一時VC」 */
export const ADMIN_BUTTON_ID = `${CUSTOM_ID_PREFIX}admin`;
const LOBBY_ADD_ID = `${CUSTOM_ID_PREFIX}lobby-add`;
const LOBBY_MODAL_ID = `${CUSTOM_ID_PREFIX}lobby-submit`;
/** 「解除」ボタン（後ろに入口のIDが付く） */
const LOBBY_REMOVE_PREFIX = `${CUSTOM_ID_PREFIX}lobby-remove:`;
const LOCK_ID = `${CUSTOM_ID_PREFIX}lock`;
const RENAME_ID = `${CUSTOM_ID_PREFIX}rename`;
const LIMIT_ID = `${CUSTOM_ID_PREFIX}limit`;
const INVITE_ID = `${CUSTOM_ID_PREFIX}invite`;
const KICK_ID = `${CUSTOM_ID_PREFIX}kick`;
const BAN_ID = `${CUSTOM_ID_PREFIX}ban`;
const TRANSFER_ID = `${CUSTOM_ID_PREFIX}transfer`;
const RENAME_MODAL_ID = `${RENAME_ID}-submit`;
const LIMIT_MODAL_ID = `${LIMIT_ID}-submit`;
const INVITE_MODAL_ID = `${INVITE_ID}-submit`;
const KICK_MODAL_ID = `${KICK_ID}-submit`;
const BAN_MODAL_ID = `${BAN_ID}-submit`;
const TRANSFER_MODAL_ID = `${TRANSFER_ID}-submit`;
const LOBBY_INPUT_ID = 'lobby';
const CATEGORY_INPUT_ID = 'category';
const TEMPLATE_INPUT_ID = 'template';
const NAME_INPUT_ID = 'name';
const LIMIT_INPUT_ID = 'limit';
const MEMBER_INPUT_ID = 'member';

export const DEFAULT_NAME_TEMPLATE = '{name}の部屋';
/** VCの名前の長さ（Discordの上限） */
const MAX_CHANNEL_NAME_LENGTH = 100;
const MAX_TEMPLATE_LENGTH = 50;
/** 入口の数の上限（管理者の画面の「解除」ボタンが2行に収まる数） */
const MAX_LOBBIES = 10;
const BUTTONS_PER_ROW = 5;
/** 選択メニューに並べられる数（Discordの上限） */
const MAX_SELECT_OPTIONS = 25;
/** 誰もいなくなってからこの間に誰か戻れば、部屋を消さない（回線落ちや、入ってすぐ抜けたときのため。VCステータスの案内の5秒より長くする） */
const REMOVE_AFTER_EMPTY_MS = 10_000;
/** VCの名前はDiscordの制限で10分に2回までしか変えられない。超えると待たされるので、先に断る */
const RENAME_WINDOW_MS = 10 * 60_000;
const RENAMES_PER_WINDOW = 2;

const CONNECT = PermissionFlagsBits.Connect;

/** Botが部屋を作って動かすのに要る権限（名前は Discord の画面に出るもの） */
const REQUIRED_PERMISSIONS: readonly (readonly [bigint, string])[] = [
  [PermissionFlagsBits.ManageChannels, 'チャンネルの管理'],
  [PermissionFlagsBits.ManageRoles, 'ロールの管理'],
  [PermissionFlagsBits.MoveMembers, 'メンバーを移動'],
  [PermissionFlagsBits.ViewChannel, 'チャンネルを見る'],
  [PermissionFlagsBits.Connect, '接続'],
  [PermissionFlagsBits.SendMessages, 'メッセージを送信'],
  [PermissionFlagsBits.EmbedLinks, '埋め込みリンク'],
];

/** 部屋の権限を変えるとき、古い状態で上書きしないよう部屋ごとに順番に行う */
const roomLock = createLock();
/** 同じ人の部屋を二重に作らないよう、人ごとに順番に行う */
const ownerLock = createLock();
/** 部屋の名前を変えた時刻（部屋のID → 時刻） */
const renamedAt = new Map<string, number[]>();

// ---- 計算（Discordに触らないところ）

/** 部屋の名前。{name} を入った人の名前にする */
export const roomName = (template: string, displayName: string): string =>
  (template.replaceAll('{name}', () => displayName).trim() || displayName).slice(0, MAX_CHANNEL_NAME_LENGTH);

/** 入力された人数の上限。空欄は上限なし（0）。読めなければ null */
export const parseUserLimit = (text: string): number | null => {
  const normalized = text.normalize('NFKC').trim().replace(/人$/, '');
  if (!normalized) return 0;
  return /^\d{1,2}$/.test(normalized) ? Number(normalized) : null;
};

export interface RoleOverwrite {
  id: string;
  type: OverwriteType.Role;
  allow: bigint;
  deny: bigint;
}

/**
 * 部屋のロールの権限。カテゴリーの権限を土台にして、鍵がかかっているときは入れなくする。
 * ロールの許可は @everyone の拒否より強いので、@everyone を拒否するだけでなく、ロールの Connect の許可も外す
 */
export const roomRoleOverwrites = (base: readonly RoleOverwrite[], everyoneId: string, locked: boolean): RoleOverwrite[] => {
  const roles = base.some((role) => role.id === everyoneId) ? [...base] : [...base, { id: everyoneId, type: OverwriteType.Role as const, allow: 0n, deny: 0n }];
  if (!locked) return roles;
  return roles.map((role) => ({ ...role, allow: role.allow & ~CONNECT, deny: role.id === everyoneId ? role.deny | CONNECT : role.deny }));
};

/** 次に名前を変えられるまでの時間（今すぐ変えられるなら 0） */
export const renameWaitMs = (times: readonly number[], now: number): number => {
  const recent = times.filter((at) => now - at < RENAME_WINDOW_MS);
  const [oldest] = recent;
  return recent.length < RENAMES_PER_WINDOW || oldest === undefined ? 0 : oldest + RENAME_WINDOW_MS - now;
};

// ---- 部屋

const humansIn = (channel: VoiceBasedChannel): Collection<string, GuildMember> => channel.members.filter((member) => !member.user.bot);

const roomChannel = (guild: Guild, channelId: string): VoiceChannel | null => {
  const channel = guild.channels.cache.get(channelId);
  return channel?.type === ChannelType.GuildVoice ? channel : null;
};

/** Discordのエラーの番号が同じか */
const hasCode = (error: unknown, code: number): boolean => error instanceof DiscordAPIError && error.code === code;

/** Botに足りない権限の名前（入口では人を動かせること、部屋を作る場所ではすべて） */
const missingPermissions = (lobby: VoiceBasedChannel, parent: CategoryChannel | null): string[] => {
  const me = lobby.guild.members.me;
  if (!me) return REQUIRED_PERMISSIONS.map(([, name]) => name);
  const place = parent ? me.permissionsIn(parent) : me.permissions;
  const inLobby = me.permissionsIn(lobby);
  return REQUIRED_PERMISSIONS.filter(([flag]) => !place.has(flag) || (flag === PermissionFlagsBits.MoveMembers && !inLobby.has(flag))).map(([, name]) => name);
};

/** 部屋を作る場所。選んだカテゴリーが消されていたら、入口と同じ場所 */
const lobbyParent = (lobbyChannel: VoiceBasedChannel, lobby: VoiceLobby): CategoryChannel | null => {
  const category = lobby.categoryId ? lobbyChannel.guild.channels.cache.get(lobby.categoryId) : undefined;
  return category?.type === ChannelType.GuildCategory ? category : lobbyChannel.parent;
};

const logRoom = (channel: VoiceChannel, text: string, actor?: GuildMember, target?: GuildMember, fields: { name: string; value: string; inline: boolean }[] = []): void => {
  void sendLog(channel.guild, 'voice', text, actor, { title: '一時VC', channel, target, fields });
};

/** 部屋のチャットの操作パネル */
const panelPayload = (channel: VoiceChannel, room: VoiceRoom) => {
  const banned = channel.permissionOverwrites.cache
    .filter((overwrite) => overwrite.type === OverwriteType.Member && overwrite.deny.has(CONNECT))
    .map((overwrite) => nameById(channel.guild, overwrite.id));
  const embed = new EmbedBuilder()
    .setColor(room.locked ? 0xe67e22 : 0x3498db)
    .setTitle('🎧 この部屋の操作')
    .setDescription(
      [
        `👑 オーナー: ${nameById(channel.guild, room.ownerId)}`,
        room.locked ? '🔒 鍵: あり（今いる人と、招待した人だけ入れます）' : '🔓 鍵: なし（誰でも入れます）',
        `👥 人数の上限: ${channel.userLimit > 0 ? `${channel.userLimit}人` : 'なし'}`,
        ...(banned.length > 0 ? [`🚫 BAN: ${banned.join('、')}（招待すると解除できます）`] : []),
        '',
        'オーナーと管理者が使えます。オーナーが抜けると、残っている人に自動で引き継ぎます。全員抜けると部屋は消えます。',
      ].join('\n'),
    );
  const button = (id: string, label: string, emoji: string, style: ButtonStyle = ButtonStyle.Secondary): ButtonBuilder =>
    new ButtonBuilder().setCustomId(id).setLabel(label).setEmoji({ name: emoji }).setStyle(style);
  return {
    embeds: [embed],
    components: [
      new ActionRowBuilder<ButtonBuilder>().addComponents(
        room.locked ? button(LOCK_ID, '鍵を開ける', '🔓', ButtonStyle.Primary) : button(LOCK_ID, '鍵をかける', '🔒', ButtonStyle.Primary),
        button(RENAME_ID, '名前を変える', '✏️'),
        button(LIMIT_ID, '人数の上限', '👥'),
      ),
      new ActionRowBuilder<ButtonBuilder>().addComponents(
        button(INVITE_ID, '招待', '➕'),
        button(KICK_ID, 'キック', '👢'),
        button(BAN_ID, 'BAN', '🚫', ButtonStyle.Danger),
        button(TRANSFER_ID, 'オーナーを譲る', '👑'),
      ),
    ],
  };
};

/** 操作パネルを一番下に出し直す。新しいものを出してから前のものを消す（出せなかったときに、パネルがなくならないように） */
const repostPanel = async (channel: VoiceChannel, room: VoiceRoom): Promise<void> => {
  const message = await channel.send({ ...panelPayload(channel, room), flags: MessageFlags.SuppressNotifications, allowedMentions: { parse: [] } });
  await saveRoom({ ...room, panelMessageId: message.id });
  if (room.panelMessageId) await channel.messages.delete(room.panelMessageId).catch(() => undefined);
};

/** 操作パネルを今の状態に書き換える。消されていたら出し直す */
const refreshPanel = async (channel: VoiceChannel, room: VoiceRoom): Promise<void> => {
  if (room.panelMessageId) {
    const edited = await channel.messages.edit(room.panelMessageId, panelPayload(channel, room)).then(
      () => true,
      (error: unknown) => {
        if (hasCode(error, RESTJSONErrorCodes.UnknownMessage)) return false;
        throw error;
      },
    );
    if (edited) return;
  }
  await repostPanel(channel, room);
};

/** 部屋のチャットの最後のメッセージがパネルでなければ、一番下に出し直す。最後がパネルなら書き換えるだけ */
const bumpPanel = async (channel: VoiceChannel, room: VoiceRoom): Promise<void> => {
  await (channel.lastMessageId === room.panelMessageId ? refreshPanel(channel, room) : repostPanel(channel, room));
};

/**
 * 部屋のチャットに何か書かれたら（人の発言も、入室のお知らせなどのBotのメッセージも）、少し静かになってから操作パネルを一番下に置き直す。
 * 話している途中でパネルが動くと読みにくいので、最後のメッセージからこの時間待つ
 */
const PANEL_BUMP_AFTER_MS = 10_000;
const bumpTimers = new Map<string, NodeJS.Timeout>();

export const handleTempVoiceMessage = (message: Message): void => {
  if (!message.inGuild()) return;
  const room = findRoom(message.channelId);
  if (!room || message.id === room.panelMessageId) return;
  const { guild, channelId } = message;
  clearTimeout(bumpTimers.get(channelId));
  const timer = setTimeout(() => {
    bumpTimers.delete(channelId);
    roomLock(channelId, async () => {
      const latest = findRoom(channelId);
      const channel = roomChannel(guild, channelId);
      // 誰もいない部屋はすぐ消えるので、置き直さない（最後の人が書いてから抜けたときなど）
      if (latest && channel && humansIn(channel).size > 0 && channel.lastMessageId !== latest.panelMessageId) await repostPanel(channel, latest);
    }).catch((error: unknown) => {
      reportError('一時VCの操作パネルを一番下に置き直せませんでした', error, guild);
    });
  }, PANEL_BUMP_AFTER_MS);
  timer.unref();
  bumpTimers.set(channelId, timer);
};

/** 部屋を消す。もう消えていても、後片付けは続ける */
const removeRoom = async (channel: VoiceChannel, room: VoiceRoom): Promise<void> => {
  const { name } = channel;
  await channel.delete('一時VCに誰もいなくなったため').catch((error: unknown) => {
    if (!hasCode(error, RESTJSONErrorCodes.UnknownChannel)) throw error;
  });
  await deleteRoom(channel.id);
  renamedAt.delete(channel.id);
  logRoom(channel, `一時VC「${name}」を消しました（全員抜けました）`, undefined, undefined, [
    { name: '🕒 使っていた時間', value: formatDuration(Date.now() - room.createdAt.getTime()), inline: true },
  ]);
};

/** 少し待って、まだ誰もいなければ部屋を消す */
const scheduleRemoval = (channel: VoiceChannel): void => {
  void sleep(REMOVE_AFTER_EMPTY_MS)
    .then(() =>
      roomLock(channel.id, async () => {
        const room = findRoom(channel.id);
        if (room && humansIn(channel).size === 0) await removeRoom(channel, room);
      }),
    )
    .catch((error: unknown) => {
      reportError(`一時VC「${channel.name}」を消せませんでした`, error, channel.guild);
    });
};

/** オーナーを変えて、部屋のチャットにも知らせる。actor は譲った人（自動の引き継ぎならなし） */
const handOver = async (channel: VoiceChannel, room: VoiceRoom, newOwner: GuildMember, actor?: GuildMember): Promise<VoiceRoom> => {
  const updated = await saveRoom({ ...room, ownerId: newOwner.id });
  await channel
    .send({ content: `👑 ${newOwner} さんがこの部屋のオーナーになりました`, flags: MessageFlags.SuppressNotifications, allowedMentions: { parse: [] } })
    .catch((error: unknown) => {
      console.error(`一時VC「${channel.name}」にオーナーの変更を書き込めませんでした:`, error);
    });
  logRoom(channel, actor ? `${actor} が一時VC「${channel.name}」のオーナーを ${newOwner} に譲りました` : `一時VC「${channel.name}」のオーナーが ${newOwner} に引き継がれました`, actor, newOwner);
  return updated;
};

/** 入口にいる人を部屋へ動かす。先に抜けていたら false */
const moveFromLobby = async (member: GuildMember, channel: VoiceChannel): Promise<boolean> =>
  member.voice.setChannel(channel, '一時VCへの移動').then(
    () => true,
    (error: unknown) => {
      if (hasCode(error, RESTJSONErrorCodes.TargetUserIsNotConnectedToVoice)) return false;
      throw error;
    },
  );

/** 部屋を作って動かす */
const createRoom = async (member: GuildMember, lobby: VoiceLobby, lobbyChannel: VoiceBasedChannel): Promise<void> => {
  const { guild } = member;
  const parent = lobbyParent(lobbyChannel, lobby);
  const missing = missingPermissions(lobbyChannel, parent);
  if (missing.length > 0) throw new Error(`Botの権限が足りないため、一時VCを作れません: ${missing.join('、')}`);

  // 権限は指定しない（カテゴリーの権限をそのまま受け継ぐ）。指定すると、Bot自身が持っていない権限を含むときに作れなくなる
  const channel = await guild.channels.create({
    name: roomName(lobby.nameTemplate, member.displayName),
    type: ChannelType.GuildVoice,
    parent: parent?.id,
    userLimit: lobby.userLimit,
    // ブーストが減ると入口の音質がサーバーの上限を超えていることがあるので、上限で抑える
    bitrate: Math.min(lobbyChannel.bitrate, guild.maximumBitrate),
    reason: `${member.user.username} の一時VC`,
  });
  try {
    // 鍵をかけた部屋やカテゴリーの権限に関係なく、Botは操作を続けられるようにする
    const me = guild.members.me ?? (await guild.members.fetchMe());
    await channel.permissionOverwrites.edit(
      me,
      { ViewChannel: true, Connect: true, SendMessages: true, EmbedLinks: true, ManageChannels: true, MoveMembers: true },
      { reason: '一時VCの操作のため' },
    );
    // 入った人のイベントより先に、部屋だと分かるようにしておく
    const room = await saveRoom({ channelId: channel.id, guildId: guild.id, ownerId: member.id, locked: false, panelMessageId: null, createdAt: new Date() });
    await refreshPanel(channel, room).catch((error: unknown) => {
      reportError(`一時VC「${channel.name}」に操作パネルを出せませんでした`, error, guild);
    });
    if (!(await moveFromLobby(member, channel))) {
      await removeRoom(channel, findRoom(channel.id) ?? room);
      return;
    }
  } catch (error) {
    // 作りかけの部屋を残さない
    await channel.delete('一時VCの準備に失敗したため').catch(() => undefined);
    await deleteRoom(channel.id);
    throw error;
  }
  logRoom(channel, `${member} の一時VC「${channel.name}」を作りました`, member, undefined, [{ name: '🚪 入口', value: lobbyChannel.name, inline: true }]);
};

const onLobbyJoin = async (member: GuildMember, lobby: VoiceLobby): Promise<void> => {
  const { guild } = member;
  await ownerLock(`${guild.id}:${member.id}`, async () => {
    if (guild.voiceStates.cache.get(member.id)?.channelId !== lobby.channelId) return;
    const lobbyChannel = guild.channels.cache.get(lobby.channelId);
    if (!lobbyChannel?.isVoiceBased()) return;
    // もう自分の部屋があれば（消える前に入り直したなど）、そこへ戻す
    const own = findRoomByOwner(guild.id, member.id);
    const ownChannel = own ? roomChannel(guild, own.channelId) : null;
    if (ownChannel) {
      await moveFromLobby(member, ownChannel);
      return;
    }
    await createRoom(member, lobby, lobbyChannel);
  });
};

const onRoomLeave = async (guild: Guild, channelId: string): Promise<void> => {
  await roomLock(channelId, async () => {
    const room = findRoom(channelId);
    if (!room) return;
    const channel = roomChannel(guild, channelId);
    if (!channel) {
      await deleteRoom(channelId);
      return;
    }
    const humans = humansIn(channel);
    const next = humans.first();
    if (!next) {
      scheduleRemoval(channel);
      return;
    }
    if (humans.has(room.ownerId)) return;
    await refreshPanel(channel, await handOver(channel, room, next));
  });
};

/** 誰もいなくなった部屋に、オーナーでない人が戻ってきたら、その人がオーナーになる */
const onRoomJoin = async (channelId: string, member: GuildMember): Promise<void> => {
  await roomLock(channelId, async () => {
    const room = findRoom(channelId);
    const channel = room ? roomChannel(member.guild, channelId) : null;
    if (!room || !channel || humansIn(channel).has(room.ownerId)) return;
    await refreshPanel(channel, await handOver(channel, room, member));
  });
};

/** VCの出入りから、部屋を作る・引き継ぐ・消す */
export const handleTempVoiceUpdate = async (oldState: VoiceState, newState: VoiceState): Promise<void> => {
  const member = newState.member ?? oldState.member;
  if (oldState.channelId === newState.channelId || !member || member.user.bot) return;
  // 抜ける方を先に済ませる（自分の部屋から入口に移ったときに、オーナーが誰かを正しく見るため）
  if (oldState.channelId && findRoom(oldState.channelId)) await onRoomLeave(member.guild, oldState.channelId);
  if (!newState.channelId) return;
  if (findRoom(newState.channelId)) await onRoomJoin(newState.channelId, member);
  const lobby = findLobby(newState.channelId);
  if (lobby) await onLobbyJoin(member, lobby);
};

/** VCが消されたら（手で消された部屋・入口も）、覚えていたものを消す */
export const handleTempVoiceChannelDelete = async (guild: Guild, channelId: string): Promise<void> => {
  if (findRoom(channelId)) await deleteRoom(channelId);
  renamedAt.delete(channelId);
  clearTimeout(bumpTimers.get(channelId));
  bumpTimers.delete(channelId);
  if (findLobby(channelId)) {
    await deleteLobby(channelId);
    void sendLog(guild, 'voice', `一時VCの入口だったVC（${channelId}）が消されたので、入口の設定を消しました`, undefined, { title: '一時VC' });
  }
};

/** 起動時の片付け。Botが止まっていた間に空になった部屋を消し、抜けたオーナーを引き継ぎ、入口で待っている人の部屋を作る */
const reconcileGuild = async (guild: Guild): Promise<void> => {
  for (const { channelId } of listRooms(guild.id)) {
    await roomLock(channelId, async () => {
      const room = findRoom(channelId);
      if (!room) return;
      const channel = roomChannel(guild, channelId);
      if (!channel) {
        await deleteRoom(channelId);
        return;
      }
      const humans = humansIn(channel);
      const next = humans.first();
      if (!next) {
        await removeRoom(channel, room);
        return;
      }
      // 止まっている間にパネルが埋もれていたら、一番下に出し直す
      await bumpPanel(channel, humans.has(room.ownerId) ? room : await handOver(channel, room, next));
    });
  }
  for (const lobby of listLobbies(guild.id)) {
    const channel = guild.channels.cache.get(lobby.channelId);
    if (!channel?.isVoiceBased()) {
      await handleTempVoiceChannelDelete(guild, lobby.channelId);
      continue;
    }
    for (const member of humansIn(channel).values()) {
      await onLobbyJoin(member, lobby);
    }
  }
};

export const startTempVoice = async (client: Client<true>): Promise<void> => {
  await loadTempVoice();
  for (const guild of client.guilds.cache.values()) {
    // 障害で読めないサーバーは、チャンネルがないように見えるので触らない（入口の設定を消してしまわないように）
    if (!guild.available) continue;
    await reconcileGuild(guild).catch((error: unknown) => {
      reportError(`「${guild.name}」の一時VCを片付けられませんでした`, error, guild);
    });
  }
};

// ---- 部屋の操作（どれも結果の一言を返す）

const toggleLock = async (channel: VoiceChannel, room: VoiceRoom, actor: GuildMember): Promise<string> => {
  const locked = !room.locked;
  const everyoneId = channel.guild.roles.everyone.id;
  const base = [...(channel.parent?.permissionOverwrites.cache.values() ?? [])]
    .filter((overwrite) => overwrite.type === OverwriteType.Role)
    .map((overwrite): RoleOverwrite => ({ id: overwrite.id, type: OverwriteType.Role, allow: overwrite.allow.bitfield, deny: overwrite.deny.bitfield }));
  const members = new Map(
    channel.permissionOverwrites.cache
      .filter((overwrite) => overwrite.type === OverwriteType.Member)
      .map((overwrite) => [overwrite.id, { allow: overwrite.allow.bitfield, deny: overwrite.deny.bitfield }]),
  );
  // 鍵をかけるときは、今いる人が回線落ちしても戻れるようにしておく
  for (const id of locked ? [...channel.members.keys(), room.ownerId] : []) {
    const current = members.get(id) ?? { allow: 0n, deny: 0n };
    members.set(id, { allow: current.allow | CONNECT, deny: current.deny & ~CONNECT });
  }
  await channel.permissionOverwrites.set(
    [...roomRoleOverwrites(base, everyoneId, locked), ...[...members].map(([id, bits]) => ({ id, type: OverwriteType.Member as const, ...bits }))],
    `${actor.user.username} が一時VCの鍵を${locked ? 'かけました' : '開けました'}`,
  );
  await saveRoom({ ...room, locked });
  logRoom(channel, `${actor} が一時VC「${channel.name}」の鍵を${locked ? 'かけました' : '開けました'}`, actor);
  return locked ? '🔒 鍵をかけました。今いる人と、招待した人だけ入れます。' : '🔓 鍵を開けました。誰でも入れます。';
};

const renameRoom = async (channel: VoiceChannel, actor: GuildMember, name: string): Promise<string> => {
  const now = Date.now();
  const times = renamedAt.get(channel.id) ?? [];
  const wait = renameWaitMs(times, now);
  if (wait > 0) return `⚠ VCの名前はDiscordの制限で10分に${RENAMES_PER_WINDOW}回までしか変えられません。あと約${formatDuration(wait + 60_000)}待ってください。`;
  if (!name) return '⚠ 名前を入力してください。';
  const before = channel.name;
  try {
    await channel.setName(name, `${actor.user.username} が一時VCの名前を変えました`);
  } catch (error) {
    if (hasCode(error, RESTJSONErrorCodes.InvalidFormBodyOrContentType)) return '⚠ その名前は使えません。別の名前にしてください。';
    throw error;
  }
  renamedAt.set(channel.id, [...times.filter((at) => now - at < RENAME_WINDOW_MS), now]);
  logRoom(channel, `${actor} が一時VC「${before}」の名前を「${name}」に変えました`, actor);
  return `✏️ 名前を「${name}」に変えました。`;
};

const changeLimit = async (channel: VoiceChannel, actor: GuildMember, text: string): Promise<string> => {
  const limit = parseUserLimit(text);
  if (limit === null) return '⚠ 人数は0〜99の数字で入力してください（空欄か0で上限なし）。';
  await channel.setUserLimit(limit, `${actor.user.username} が一時VCの人数の上限を変えました`);
  const label = limit > 0 ? `${limit}人` : 'なし';
  logRoom(channel, `${actor} が一時VC「${channel.name}」の人数の上限を変えました`, actor, undefined, [{ name: '👥 人数の上限', value: label, inline: true }]);
  return `👥 人数の上限を${label}にしました。`;
};

/** 招待。その人の Connect を許可する（BANされていた人は解除になる）。部屋のチャットでメンションして知らせる */
const inviteMember = async (channel: VoiceChannel, actor: GuildMember, target: GuildMember): Promise<string> => {
  const wasBanned = channel.permissionOverwrites.cache.get(target.id)?.deny.has(CONNECT) ?? false;
  await channel.permissionOverwrites.edit(target, { ViewChannel: true, Connect: true }, { reason: `${actor.user.username} が一時VCに招待しました` });
  await channel.send({ content: `➕ ${target} ${escapeMarkdown(actor.displayName)} さんがこの部屋に招待しました`, allowedMentions: { users: [target.id] } });
  logRoom(channel, `${actor} が ${target} を一時VC「${channel.name}」に招待しました${wasBanned ? '（BANの解除）' : ''}`, actor, target);
  return `➕ ${boldName(target)} を招待しました。${wasBanned ? 'BANも解除しました。' : ''}`;
};

/** キックやBANで、その人を対象にできないときの理由（できるなら null） */
const removalProblem = (channel: VoiceChannel, actor: GuildMember, target: GuildMember): string | null => {
  if (target.id === actor.id) return '⚠ 自分は選べません。';
  if (target.id === channel.guild.members.me?.id) return '⚠ Bot自身は選べません。';
  if (isAdmin(target)) return '⚠ 管理者は選べません。';
  return null;
};

/** キック。部屋から出して、招待の許可も外す（鍵がない部屋には、また入れる） */
const kickMember = async (channel: VoiceChannel, room: VoiceRoom, actor: GuildMember, target: GuildMember): Promise<string> => {
  const problem = removalProblem(channel, actor, target);
  if (problem) return problem;
  if (!channel.members.has(target.id)) return `⚠ ${boldName(target)} はこの部屋にいません。`;
  if (channel.permissionOverwrites.cache.get(target.id)?.allow.has(CONNECT)) {
    await channel.permissionOverwrites.edit(target, { ViewChannel: null, Connect: null }, { reason: `${actor.user.username} が一時VCからキックしました` });
  }
  await target.voice.disconnect(`${actor.user.username} が一時VCからキックしました`);
  logRoom(channel, `${actor} が ${target} を一時VC「${channel.name}」からキックしました`, actor, target);
  return `👢 ${boldName(target)} をキックしました。${room.locked ? '' : '鍵がないので、また入れます（入れたくないときはBAN）。'}`;
};

/** BAN。その人の Connect を拒否する（部屋がある間だけ）。部屋にいれば出す */
const banMember = async (channel: VoiceChannel, actor: GuildMember, target: GuildMember): Promise<string> => {
  const problem = removalProblem(channel, actor, target);
  if (problem) return problem;
  await channel.permissionOverwrites.edit(target, { Connect: false }, { reason: `${actor.user.username} が一時VCからBANしました` });
  if (channel.members.has(target.id)) await target.voice.disconnect(`${actor.user.username} が一時VCからBANしました`);
  logRoom(channel, `${actor} が ${target} を一時VC「${channel.name}」からBANしました`, actor, target);
  return `🚫 ${boldName(target)} をBANしました。この部屋に入れません（招待すると解除できます）。`;
};

const transferOwner = async (channel: VoiceChannel, room: VoiceRoom, actor: GuildMember, target: GuildMember): Promise<string> => {
  if (!channel.members.has(target.id) || target.user.bot) return `⚠ ${boldName(target)} はこの部屋にいません。`;
  if (target.id === room.ownerId) return `⚠ ${boldName(target)} はもうオーナーです。`;
  await handOver(channel, room, target, actor);
  return `👑 ${boldName(target)} にオーナーを譲りました。`;
};

const canControl = (member: GuildMember, room: VoiceRoom): boolean => room.ownerId === member.id || isAdmin(member);

const deniedText = (guild: Guild, room: VoiceRoom): string => `この操作は、部屋のオーナー（${nameById(guild, room.ownerId)}）と管理者だけが使えます。`;

/** パネルのボタンの入口。部屋がない・操作できないなら本人に断って null */
const controlledRoom = async (interaction: ButtonInteraction<'cached'> | ModalSubmitInteraction<'cached'>): Promise<{ channel: VoiceChannel; room: VoiceRoom } | null> => {
  const room = findRoom(interaction.channelId);
  const channel = room ? roomChannel(interaction.guild, room.channelId) : null;
  if (!room || !channel) {
    await interaction.reply({ content: 'この部屋はもうありません。', flags: MessageFlags.Ephemeral });
    return null;
  }
  if (!canControl(interaction.member, room)) {
    await interaction.reply({ content: deniedText(interaction.guild, room), flags: MessageFlags.Ephemeral, allowedMentions: { parse: [] } });
    return null;
  }
  return { channel, room };
};

/** 部屋の操作を順番に行い、操作パネルを今の状態にして、結果の一言を本人に返す（先に応答を保留しておくこと） */
const runRoomAction = async (
  interaction: ButtonInteraction<'cached'> | ModalSubmitInteraction<'cached'>,
  channelId: string,
  action: (channel: VoiceChannel, room: VoiceRoom) => Promise<string>,
): Promise<void> => {
  let note = 'この部屋はもうありません。';
  try {
    await roomLock(channelId, async () => {
      const room = findRoom(channelId);
      const channel = roomChannel(interaction.guild, channelId);
      if (!room || !channel) return;
      // 待っている間に譲ったなど、操作できなくなっていないかも見る
      if (!canControl(interaction.member, room)) {
        note = deniedText(interaction.guild, room);
        return;
      }
      note = await action(channel, room);
      await refreshPanel(channel, findRoom(channelId) ?? room).catch((error: unknown) => {
        reportError(`一時VC「${channel.name}」の操作パネルを書き換えられませんでした`, error, interaction.guild);
      });
    });
  } catch (error) {
    if (!hasCode(error, RESTJSONErrorCodes.MissingPermissions)) throw error;
    reportError('一時VCの操作に必要なBotの権限が足りません', error, interaction.guild);
    note = '⚠ Botの権限が足りないため、できませんでした。管理者に伝えてください。';
  }
  await interaction.editReply({ content: note, allowedMentions: { parse: [] } });
};

// ---- 入力画面

const singleInputModal = (id: string, title: string, label: string, description: string, input: TextInputBuilder): ModalBuilder =>
  new ModalBuilder().setCustomId(id).setTitle(title).addLabelComponents(new LabelBuilder().setLabel(label).setDescription(description).setTextInputComponent(input));

/** サーバーの誰かを選ぶ画面（招待・BAN） */
const memberModal = (id: string, title: string, description: string): ModalBuilder =>
  new ModalBuilder()
    .setCustomId(id)
    .setTitle(title)
    .addLabelComponents(
      new LabelBuilder()
        .setLabel('メンバー')
        .setDescription(description)
        .setUserSelectMenuComponent(new UserSelectMenuBuilder().setCustomId(MEMBER_INPUT_ID).setRequired(true)),
    );

/** 部屋にいる人から選ぶ画面（キック・譲渡） */
const roomMemberModal = (id: string, title: string, members: GuildMember[]): ModalBuilder =>
  new ModalBuilder()
    .setCustomId(id)
    .setTitle(title)
    .addLabelComponents(
      new LabelBuilder().setLabel('部屋にいる人').setStringSelectMenuComponent(
        new StringSelectMenuBuilder()
          .setCustomId(MEMBER_INPUT_ID)
          .setRequired(true)
          .addOptions(members.slice(0, MAX_SELECT_OPTIONS).map((member) => ({ label: member.displayName.slice(0, 100), value: member.id }))),
      ),
    );

const lobbyModal = (): ModalBuilder =>
  new ModalBuilder()
    .setCustomId(LOBBY_MODAL_ID)
    .setTitle('一時VCの入口を設定')
    .addLabelComponents(
      new LabelBuilder()
        .setLabel('入口のVC')
        .setDescription('ここに入ると部屋ができます。設定済みのVCを選ぶと、設定を変更します')
        .setChannelSelectMenuComponent(new ChannelSelectMenuBuilder().setCustomId(LOBBY_INPUT_ID).setChannelTypes(ChannelType.GuildVoice).setRequired(true)),
      new LabelBuilder()
        .setLabel('部屋を作るカテゴリー（任意）')
        .setDescription('選ばなければ入口と同じ場所')
        .setChannelSelectMenuComponent(new ChannelSelectMenuBuilder().setCustomId(CATEGORY_INPUT_ID).setChannelTypes(ChannelType.GuildCategory).setRequired(false)),
      new LabelBuilder()
        .setLabel('部屋の名前（任意）')
        .setDescription('{name} は入った人の名前になります')
        .setTextInputComponent(new TextInputBuilder().setCustomId(TEMPLATE_INPUT_ID).setStyle(TextInputStyle.Short).setMaxLength(MAX_TEMPLATE_LENGTH).setRequired(false).setPlaceholder(DEFAULT_NAME_TEMPLATE)),
      new LabelBuilder()
        .setLabel('人数の上限（任意）')
        .setDescription('0〜99。空欄か0で上限なし')
        .setTextInputComponent(new TextInputBuilder().setCustomId(LIMIT_INPUT_ID).setStyle(TextInputStyle.Short).setMaxLength(3).setRequired(false).setPlaceholder('8')),
    );

// ---- 管理者の画面（管理パネルの「🔊 一時VC」）

const describeLobby = (guild: Guild, lobby: VoiceLobby): string[] => {
  const channel = guild.channels.cache.get(lobby.channelId);
  if (!channel?.isVoiceBased()) return [`・（消されたVC ${lobby.channelId}）`];
  const parent = lobbyParent(channel, lobby);
  const missing = missingPermissions(channel, parent);
  return [
    `・${channel} → 📁 ${parent ? channelMention(parent.id) : 'カテゴリーなし'} / 🏷️「${escapeMarkdown(lobby.nameTemplate)}」 / 👥 ${lobby.userLimit > 0 ? `${lobby.userLimit}人まで` : '上限なし'}`,
    ...(missing.length > 0 ? [`　⚠ Botの権限が足りないため、部屋を作れません: ${missing.join('、')}`] : []),
  ];
};

export const adminScreen = (guild: Guild, note?: string) => {
  const lobbies = listLobbies(guild.id);
  const removeButtons = lobbies.map((lobby) =>
    new ButtonBuilder()
      .setCustomId(`${LOBBY_REMOVE_PREFIX}${lobby.channelId}`)
      .setLabel(`解除: ${guild.channels.cache.get(lobby.channelId)?.name ?? lobby.channelId}`.slice(0, 80))
      .setStyle(ButtonStyle.Danger),
  );
  const removeRows: ActionRowBuilder<ButtonBuilder>[] = [];
  for (let i = 0; i < removeButtons.length; i += BUTTONS_PER_ROW) {
    removeRows.push(new ActionRowBuilder<ButtonBuilder>().addComponents(removeButtons.slice(i, i + BUTTONS_PER_ROW)));
  }
  return {
    content: [
      ...(note ? [note, ''] : []),
      '🔊 **一時VC**',
      '入口のVCに入ると、その人の部屋を自動で作って移動させます。全員抜けると部屋は消えます。',
      '部屋のチャットの操作パネルで、オーナーと管理者が鍵・名前・人数の上限・招待・キック・BAN・譲渡を操作できます。',
      '',
      ...(lobbies.length > 0 ? lobbies.flatMap((lobby) => describeLobby(guild, lobby)) : ['まだ入口がありません。「入口を設定」で、入口にするVCを選んでください。']),
      '',
      `今ある部屋: ${listRooms(guild.id).length}個`,
    ].join('\n'),
    components: [
      new ActionRowBuilder<ButtonBuilder>().addComponents(new ButtonBuilder().setCustomId(LOBBY_ADD_ID).setLabel('入口を設定').setEmoji({ name: '➕' }).setStyle(ButtonStyle.Primary)),
      ...removeRows,
    ],
    allowedMentions: { parse: [] },
  };
};

const saveLobbyFromModal = async (interaction: ModalSubmitInteraction<'cached'>): Promise<string> => {
  const { guild, member, fields } = interaction;
  const channelId = fields.getSelectedChannels(LOBBY_INPUT_ID)?.first()?.id;
  const channel = channelId ? guild.channels.cache.get(channelId) : undefined;
  if (!channel?.isVoiceBased()) return '⚠ そのVCが見つかりません。';
  if (channel.id === guild.afkChannelId) return '⚠ AFKチャンネルは入口にできません。';
  if (findRoom(channel.id)) return '⚠ 一時VCの部屋は入口にできません。';
  if (!findLobby(channel.id) && listLobbies(guild.id).length >= MAX_LOBBIES) return `⚠ 入口は${MAX_LOBBIES}個までです。`;
  const userLimit = parseUserLimit(fields.getTextInputValue(LIMIT_INPUT_ID));
  if (userLimit === null) return '⚠ 人数の上限は0〜99の数字で入力してください（空欄か0で上限なし）。';

  const nameTemplate = fields.getTextInputValue(TEMPLATE_INPUT_ID).trim() || DEFAULT_NAME_TEMPLATE;
  const categoryId = fields.getSelectedChannels(CATEGORY_INPUT_ID)?.first()?.id ?? null;
  const existed = !!findLobby(channel.id);
  await saveLobby({ channelId: channel.id, guildId: guild.id, categoryId, nameTemplate, userLimit });
  void sendLog(guild, 'voice', `${member} が ${channel} を一時VCの入口に${existed ? 'した設定を変えました' : 'しました'}`, member, {
    title: '一時VCの入口',
    channel,
    fields: [
      { name: '🏷️ 部屋の名前', value: nameTemplate, inline: true },
      { name: '👥 人数の上限', value: userLimit > 0 ? `${userLimit}人` : 'なし', inline: true },
      ...(categoryId ? [{ name: '📁 カテゴリー', value: channelMention(categoryId), inline: true }] : []),
    ],
  });
  return `✅ ${channel} を入口にしました。`;
};

const removeLobby = async (guild: Guild, member: GuildMember, channelId: string): Promise<string> => {
  if (!findLobby(channelId)) return 'その入口はもうありません。';
  await deleteLobby(channelId);
  const channel = guild.channels.cache.get(channelId);
  void sendLog(guild, 'voice', `${member} が ${channel ?? channelId} を一時VCの入口から外しました`, member, { title: '一時VCの入口', channel: channel ?? null });
  return `🗑️ ${channel ?? channelId} を入口から外しました（VC自体は消していません。今ある部屋は、全員抜けるまで残ります）。`;
};

// ---- ボタンと入力画面の受け取り

export const handleButton = async (interaction: ButtonInteraction<'cached'>): Promise<void> => {
  const { customId, guild, member } = interaction;
  if (customId === ADMIN_BUTTON_ID || customId === LOBBY_ADD_ID || customId.startsWith(LOBBY_REMOVE_PREFIX)) {
    if (!(await ensureAdmin(interaction))) return;
    if (customId === LOBBY_ADD_ID) {
      await interaction.showModal(lobbyModal());
    } else if (customId === ADMIN_BUTTON_ID) {
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      await interaction.editReply(adminScreen(guild));
    } else {
      await interaction.deferUpdate();
      const note = await removeLobby(guild, member, customId.slice(LOBBY_REMOVE_PREFIX.length));
      await interaction.editReply(adminScreen(guild, note));
    }
    return;
  }

  const target = await controlledRoom(interaction);
  if (!target) return;
  const { channel, room } = target;
  switch (customId) {
    case LOCK_ID:
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      await runRoomAction(interaction, channel.id, (current, latest) => toggleLock(current, latest, member));
      return;
    case RENAME_ID:
      await interaction.showModal(
        singleInputModal(
          RENAME_MODAL_ID,
          '部屋の名前を変える',
          '新しい名前',
          `Discordの制限で、10分に${RENAMES_PER_WINDOW}回まで変えられます`,
          new TextInputBuilder().setCustomId(NAME_INPUT_ID).setStyle(TextInputStyle.Short).setMaxLength(MAX_CHANNEL_NAME_LENGTH).setRequired(true).setValue(channel.name),
        ),
      );
      return;
    case LIMIT_ID:
      await interaction.showModal(
        singleInputModal(
          LIMIT_MODAL_ID,
          '人数の上限を変える',
          '人数の上限',
          '0〜99。空欄か0で上限なし',
          new TextInputBuilder().setCustomId(LIMIT_INPUT_ID).setStyle(TextInputStyle.Short).setMaxLength(3).setRequired(false).setValue(`${channel.userLimit}`),
        ),
      );
      return;
    case INVITE_ID:
      await interaction.showModal(memberModal(INVITE_MODAL_ID, 'この部屋に招待', '鍵がかかっていても入れるようになり、部屋のチャットで知らせます。BANも解除されます'));
      return;
    case BAN_ID:
      await interaction.showModal(memberModal(BAN_MODAL_ID, 'この部屋からBAN', 'この部屋に入れなくします（部屋が消えるまで）。サーバーからのBANではありません'));
      return;
    case KICK_ID:
    case TRANSFER_ID: {
      const isKick = customId === KICK_ID;
      const candidates = [...channel.members.values()].filter((candidate) =>
        isKick ? candidate.id !== member.id && candidate.id !== guild.members.me?.id : !candidate.user.bot && candidate.id !== room.ownerId,
      );
      if (candidates.length === 0) {
        await interaction.reply({ content: 'この部屋には、ほかに誰もいません。', flags: MessageFlags.Ephemeral });
        return;
      }
      await interaction.showModal(roomMemberModal(isKick ? KICK_MODAL_ID : TRANSFER_MODAL_ID, isKick ? 'この部屋からキック' : 'オーナーを譲る', candidates));
    }
  }
};

export const handleModalSubmit = async (interaction: ModalSubmitInteraction<'cached'>): Promise<void> => {
  const { customId, guild, member, fields } = interaction;
  if (customId === LOBBY_MODAL_ID) {
    if (!(await ensureAdmin(interaction))) return;
    // 管理者の画面から開いたので、その画面を書き換える
    if (interaction.isFromMessage()) {
      await interaction.deferUpdate();
    } else {
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    }
    const note = await saveLobbyFromModal(interaction);
    await interaction.editReply(adminScreen(guild, note));
    return;
  }

  const target = await controlledRoom(interaction);
  if (!target) return;
  const channelId = target.channel.id;
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  switch (customId) {
    case RENAME_MODAL_ID:
      await runRoomAction(interaction, channelId, (channel) => renameRoom(channel, member, fields.getTextInputValue(NAME_INPUT_ID).trim()));
      return;
    case LIMIT_MODAL_ID:
      await runRoomAction(interaction, channelId, (channel) => changeLimit(channel, member, fields.getTextInputValue(LIMIT_INPUT_ID)));
      return;
  }

  // ここから先は、人を選ぶ操作。招待・BANはメンバーの選択、キック・譲渡は部屋にいる人のリストから届く
  const isUserSelect = customId === INVITE_MODAL_ID || customId === BAN_MODAL_ID;
  const targetId = isUserSelect ? fields.getSelectedUsers(MEMBER_INPUT_ID)?.first()?.id : fields.getStringSelectValues(MEMBER_INPUT_ID)[0];
  const picked = targetId ? await guild.members.fetch(targetId).catch(() => null) : null;
  if (!picked) {
    await interaction.editReply('そのメンバーはサーバーにいません。');
    return;
  }
  switch (customId) {
    case INVITE_MODAL_ID:
      await runRoomAction(interaction, channelId, (channel) => inviteMember(channel, member, picked));
      return;
    case BAN_MODAL_ID:
      await runRoomAction(interaction, channelId, (channel) => banMember(channel, member, picked));
      return;
    case KICK_MODAL_ID:
      await runRoomAction(interaction, channelId, (channel, room) => kickMember(channel, room, member, picked));
      return;
    case TRANSFER_MODAL_ID:
      await runRoomAction(interaction, channelId, (channel, room) => transferOwner(channel, room, member, picked));
  }
};
