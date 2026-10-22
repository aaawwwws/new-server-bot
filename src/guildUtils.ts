import {
  ChannelType,
  GatewayRateLimitError,
  PermissionFlagsBits,
  type Collection,
  type Guild,
  type GuildMember,
  type TextChannel,
} from 'discord.js';

/**
 * 全員分を取り直す間隔。Discordは全員分の取得を約30秒に1回までしか受け付けない。
 * 入退室や変更はBotに届き続けるので、一度全員分を取れば、あとは覚えているもので足りる
 */
const MEMBER_REFETCH_MS = 60_000;
/** 最後に全員分を取り直した時刻（サーバーのID → 時刻） */
const membersFetchedAt = new Map<string, number>();
/** 取り直している途中のもの（同時に頼まれたら、同じ結果を待つ） */
const membersFetching = new Map<string, Promise<Collection<string, GuildMember>>>();

/** サーバーにいる人全員。覚えている分で足りればそれを使い、足りなければ Discord から取り直す */
export const fetchAllMembers = (guild: Guild): Promise<Collection<string, GuildMember>> => {
  const running = membersFetching.get(guild.id);
  if (running) return running;
  const recent = Date.now() - (membersFetchedAt.get(guild.id) ?? 0) < MEMBER_REFETCH_MS;
  if (guild.members.cache.size >= guild.memberCount || recent) return Promise.resolve(guild.members.cache);

  membersFetchedAt.set(guild.id, Date.now());
  const request = guild.members
    .fetch()
    .catch((error: unknown) => {
      // 回数制限に当たったら、覚えている分で代わりにする（表示は止めない）
      if (!(error instanceof GatewayRateLimitError)) throw error;
      console.warn(`「${guild.name}」のメンバー一覧の取得が回数制限に当たったため、覚えている分を使います`);
      return guild.members.cache;
    })
    .finally(() => membersFetching.delete(guild.id));
  membersFetching.set(guild.id, request);
  return request;
};

/** 名前でテキストチャンネルを探す */
export const findTextChannel = (guild: Guild, name: string): TextChannel | undefined =>
  guild.channels.cache.find(
    (channel): channel is TextChannel => channel.type === ChannelType.GuildText && channel.name === name,
  );

/** Bot がそのチャンネルに埋め込み付きで書き込めるか */
export const canBotPost = (channel: TextChannel): boolean => {
  const me = channel.guild.members.me;
  return (
    !!me &&
    channel
      .permissionsFor(me)
      .has([PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.EmbedLinks])
  );
};
