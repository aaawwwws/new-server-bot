import { setTimeout as sleep } from 'node:timers/promises';
import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  MessageFlags,
  PermissionFlagsBits,
  type GuildMember,
  type Role,
  type TextChannel,
  type VoiceBasedChannel,
  type VoiceState,
} from 'discord.js';
import { formatDuration } from './duration.js';
import { canBotPost, findTextChannel } from './guildUtils.js';
import { loadJoinAnnounceOrDefault } from './memberSettings.js';
import { findVcRole } from './vcRole.js';

/** 通話の開始・終了のお知らせを流すチャンネルの名前 */
export const NOTICE_CHANNEL_NAME = '通知';
/**
 * 入ってすぐ移動・退出した場合を除くため、少し待ってから開始を流す
 * （自動でVCを作るBotの入口チャンネルを通っただけ、など）
 */
const START_SETTLE_MS = 5_000;
/** 誰もいなくなってからこの間に誰か戻れば、同じ通話の続きとして扱う（回線落ちなど） */
const END_SETTLE_MS = 30_000;
/** 終了のお知らせに名前を載せる人数の上限 */
const MAX_LISTED_PARTICIPANTS = 10;

interface CallSession {
  startedAt: number;
  /** 通話に入った人（ID → 表示名） */
  participants: Map<string, string>;
  /** 開始のお知らせを流したか。流した通話だけ終了も流す */
  announced: boolean;
  /** 誰もいなくなった時刻 */
  emptySince: number | null;
}

/** 今続いている通話（VCのID → 通話）。Botを再起動すると忘れるので、その前からの通話は終了を流さない */
const sessions = new Map<string, CallSession>();

/** VCの出入りから、通話の開始（最初の1人が入った）と終了（最後の1人が抜けた）を見つけてお知らせする */
export const handleCallStateUpdate = async (oldState: VoiceState, newState: VoiceState): Promise<void> => {
  // ミュートの切り替えなど、VCを移っていないものは関係ない。Botは人数に数えない
  const member = newState.member ?? oldState.member;
  if (oldState.channelId === newState.channelId || !member || member.user.bot) return;

  await Promise.all([
    oldState.channel ? onLeave(oldState.channel) : undefined,
    newState.channel ? onJoin(newState.channel, member) : undefined,
  ]);
};

const onJoin = async (channel: VoiceBasedChannel, member: GuildMember): Promise<void> => {
  if (channel.id === channel.guild.afkChannelId) return;

  const current = sessions.get(channel.id);
  if (current) {
    // 誰もいなくなった直後に戻ってきた場合も、同じ通話の続き
    current.emptySince = null;
    current.participants.set(member.id, member.displayName);
    return;
  }
  // 入った本人しかいない = 通話が始まった（ほかに人がいるのは、Botの再起動前から続いている通話）
  if (humansIn(channel).size !== 1) return;

  const session: CallSession = {
    startedAt: Date.now(),
    participants: new Map([[member.id, member.displayName]]),
    announced: false,
    emptySince: null,
  };
  sessions.set(channel.id, session);

  await sleep(START_SETTLE_MS);
  const humans = humansIn(channel);
  const noticeChannel = findNoticeChannel(channel);
  if (humans.size === 0 || sessions.get(channel.id) !== session || !noticeChannel) return;
  session.announced = true;

  // 待っている間に始めた人が抜けていたら、残っている人を表示する
  const starter = humans.get(member.id) ?? humans.first() ?? member;
  // 始めた人が「知らせない」にしていたら、@VC なしの通知なしで流す（通話があったことと通話時間は残す）
  const { callStart: announce } = await loadJoinAnnounceOrDefault(channel.guild.id, starter.id);
  // VC通知をオンにしている人（「VC」ロール）にだけ通知が届くようにする
  const vcRole = announce ? findVcRole(channel.guild) : undefined;
  if (vcRole && !canMention(noticeChannel, vcRole)) {
    console.warn(
      `「${channel.guild.name}」: Botに「@everyone、@here、すべてのロールにメンション」の権限がないため、「${vcRole.name}」ロールに通知が届きません`,
    );
  }
  // お知らせが目的なので、サイレントにはしない。本文はメンションだけ（始めた人へのメンションでは通知を飛ばさない）
  await noticeChannel.send({
    content: vcRole ? `${vcRole} ${starter}` : `${starter}`,
    embeds: [
      new EmbedBuilder()
        .setColor(0x3498db)
        .setAuthor({ name: `${starter.displayName} さんが始めました`, iconURL: starter.displayAvatarURL() })
        .setTitle('🔊 通話が始まりました')
        .setDescription(`${channel}`)
        .setTimestamp(),
    ],
    components: [
      new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder().setStyle(ButtonStyle.Link).setLabel('通話に参加').setEmoji({ name: '🎧' }).setURL(channel.url),
      ),
    ],
    allowedMentions: { parse: [], roles: vcRole ? [vcRole.id] : [] },
    ...(announce ? {} : { flags: MessageFlags.SuppressNotifications }),
  });
};

/** 誰でもメンションできるロールでなければ、Botにすべてのロールへのメンション権限が必要 */
const canMention = (channel: TextChannel, role: Role): boolean => {
  const me = channel.guild.members.me;
  return role.mentionable || (!!me && channel.permissionsFor(me).has(PermissionFlagsBits.MentionEveryone));
};

const onLeave = async (channel: VoiceBasedChannel): Promise<void> => {
  const session = sessions.get(channel.id);
  if (!session || humansIn(channel).size > 0) return;

  const emptySince = Date.now();
  session.emptySince = emptySince;
  await sleep(END_SETTLE_MS);
  // 待っている間に誰かが戻っていたら、通話は続いている
  if (sessions.get(channel.id) !== session || session.emptySince !== emptySince) return;
  sessions.delete(channel.id);

  const noticeChannel = findNoticeChannel(channel);
  if (!session.announced || !noticeChannel) return;

  const duration = formatDuration(emptySince - session.startedAt);
  const names = [...session.participants.values()];
  const listed = names.slice(0, MAX_LISTED_PARTICIPANTS).join('、');
  const others = names.length > MAX_LISTED_PARTICIPANTS ? ` ほか${names.length - MAX_LISTED_PARTICIPANTS}人` : '';
  // 終わった通話で通知が鳴っても邪魔なので、サイレントにする。通話時間は最後に載せる
  await noticeChannel.send({
    embeds: [
      new EmbedBuilder()
        .setColor(0x95a5a6)
        .setTitle('🔇 通話が終了しました')
        .setDescription(`${channel}`)
        .addFields(
          { name: `参加した人（${names.length}人）`, value: `${listed}${others}` },
          { name: '通話時間', value: duration },
        )
        .setTimestamp(),
    ],
    flags: MessageFlags.SuppressNotifications,
  });
};

const humansIn = (channel: VoiceBasedChannel) => channel.members.filter((m) => !m.user.bot);

/**
 * お知らせを流せる通知チャンネル。
 * 通知チャンネルを見られる人がそのVCを見られないときは、通話の存在が伝わらないよう流さない（Bot用のロールは除く）
 */
const findNoticeChannel = (voice: VoiceBasedChannel): TextChannel | undefined => {
  const notice = findTextChannel(voice.guild, NOTICE_CHANNEL_NAME);
  if (!notice || !canBotPost(notice)) return undefined;
  const visibleToReaders = voice.guild.roles.cache
    .filter((role) => !role.managed && notice.permissionsFor(role).has(PermissionFlagsBits.ViewChannel))
    .every((role) => voice.permissionsFor(role).has(PermissionFlagsBits.ViewChannel));
  return visibleToReaders ? notice : undefined;
};
