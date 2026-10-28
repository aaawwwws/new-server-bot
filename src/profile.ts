import { EmbedBuilder, type APIEmbedField, type Embed, type GuildMember, type Role } from 'discord.js';
import { memberContentNames } from './contentRoles.js';
import { findInviteMeRole } from './inviteMeRole.js';
import { DATA_CENTERS } from './dataCenters.js';
import { JOBS, type JobRole } from './jobs.js';
import { findProgressRoles } from './progressRoles.js';

// 登録済みのプロフィールはDBに保存する。入力途中の内容（プレビュー）と、DB導入前の投稿は埋め込みから読む
export interface Profile {
  name: string;
  comment: string;
  /** 最近やっているゲーム・コンテンツ（自由入力・任意） */
  recent: string;
  dataCenter: string | null;
  world: string | null;
  startHour: number | null;
  endHour: number | null;
  /** Job.key の一覧 */
  jobs: string[];
}

const WORLD_FIELD = '🌍 ワールド';
const TIME_FIELD = '🕘 活動時間';
const PROGRESS_FIELD = '📖 進行度';
const JOB_FIELD = '⚔️ ジョブ';
const CONTENT_FIELD = '🎮 よく遊ぶ';
export const RECENT_LABEL = '最近やっていること';
const RECENT_FIELD = `🕹️ ${RECENT_LABEL}`;
const UNSET = '未設定';
const JOB_SEPARATOR = '・';
const COMMENT_QUOTE = '>>> ';
const INVITE_ME_FIELD = '🙌 お誘い';
/** 進行度ロールがない（または色なし）ときの色 */
const DEFAULT_COLOR = 0x99aab5;
const JOB_ROLE_LINES: { role: JobRole; emoji: string }[] = [
  { role: 'tank', emoji: '🛡️' },
  { role: 'healer', emoji: '💚' },
  { role: 'dps', emoji: '🗡️' },
];

/** 投稿の本文。埋め込みがあるので、本文はメンションだけにする（誰のプロフィールか探すときにも使う） */
export const profileHeader = (userId: string): string => `<@${userId}>`;

/** 以前の投稿の本文（「〜のプロフィール」まで書いていた頃のもの） */
export const legacyProfileHeader = (userId: string): string => `<@${userId}> のプロフィール`;

/** 進行度・よく遊ぶコンテンツと色は、その時点でメンバーに付いているロールから決める */
export const buildProfileEmbed = (member: GuildMember, profile: Profile): EmbedBuilder => {
  const progress = findMemberProgress(member);

  return new EmbedBuilder()
    .setColor(progress?.colors.primaryColor || DEFAULT_COLOR)
    .setTitle(profile.name)
    .setThumbnail(member.displayAvatarURL({ size: 256 }))
    .setDescription(profile.comment ? `${COMMENT_QUOTE}${profile.comment}` : null)
    .addFields(
      { name: WORLD_FIELD, value: describeWorld(profile), inline: true },
      { name: TIME_FIELD, value: describeTime(profile), inline: true },
      { name: PROGRESS_FIELD, value: progress?.name ?? UNSET, inline: true },
      { name: JOB_FIELD, value: formatJobs(profile.jobs) || UNSET },
      { name: CONTENT_FIELD, value: memberContentNames(member).join(JOB_SEPARATOR) || UNSET },
      // 任意なので、書いた人だけ出す
      ...(profile.recent ? [{ name: RECENT_FIELD, value: profile.recent }] : []),
      // 「いつでも誘って下さい」ロールを付けている人だけ（ひとことの欄は申請内容の読み取りに使うので、別の欄にする）
      ...(hasInviteMe(member) ? [{ name: INVITE_ME_FIELD, value: 'いつでも誘ってください！' }] : []),
    )
    .setFooter({ text: member.guild.name, iconURL: member.guild.iconURL() ?? undefined })
    .setTimestamp();
};

const hasInviteMe = (member: GuildMember): boolean => {
  const role = findInviteMeRole(member.guild);
  return !!role && member.roles.cache.has(role.id);
};

/** 項目ごとの表示（ログに変更前・変更後を出すときにも使う） */
export const describeWorld = (profile: Profile): string =>
  profile.world ? `${profile.world} (${profile.dataCenter})` : UNSET;

export const describeTime = (profile: Profile): string => formatTime(profile.startHour, profile.endHour) ?? UNSET;

export const describeJobs = (profile: Profile): string =>
  JOBS.filter((job) => profile.jobs.includes(job.key))
    .map((job) => job.name)
    .join(JOB_SEPARATOR) || UNSET;

/** ログに載せるプロフィールの中身（申請・登録・審査のログで使う） */
export const profileLogFields = (profile: Profile): APIEmbedField[] => [
  { name: '🪪 キャラクター名', value: profile.name, inline: true },
  { name: WORLD_FIELD, value: describeWorld(profile), inline: true },
  { name: TIME_FIELD, value: describeTime(profile), inline: true },
  { name: JOB_FIELD, value: describeJobs(profile), inline: true },
  ...(profile.comment ? [{ name: '💬 ひとこと', value: profile.comment }] : []),
  ...(profile.recent ? [{ name: RECENT_FIELD, value: profile.recent }] : []),
];

/** プロフィール未登録の人がVCに入ったときのお知らせ */
export const buildJoinNoticeEmbed = (member: GuildMember): EmbedBuilder =>
  new EmbedBuilder()
    .setColor(findMemberProgress(member)?.colors.primaryColor || DEFAULT_COLOR)
    .setAuthor({ name: `${member.displayName} が入室しました`, iconURL: member.displayAvatarURL() })
    .setTimestamp();

const findMemberProgress = (member: GuildMember): Role | undefined =>
  findProgressRoles(member.guild).find((role) => member.roles.cache.has(role.id));

export const buildProfileMessage = (member: GuildMember, profile: Profile) => {
  return {
    content: profileHeader(member.id),
    embeds: [buildProfileEmbed(member, profile)],
    // メンションは表示だけにして、通知は飛ばさない
    allowedMentions: { parse: [] },
  };
};

export const parseProfile = (embed: Embed | undefined): Profile => {
  // 以前の形式（絵文字なしの項目名や区切り「、」）の投稿も読めるよう、項目名の一部と中身の単語で判定する
  const field = (name: string) => embed?.fields.find((f) => f.name.includes(name))?.value ?? '';

  const worldWords = field('ワールド').split(/[^A-Za-z]+/);
  const dataCenter = DATA_CENTERS.find((dc) => dc.worlds.some((world) => worldWords.includes(world)));
  const time = field('活動時間').match(/(?:(\d+):00)?〜(?:(\d+):00)?/);
  const jobWords = field('ジョブ').split(/[\s、・,]+/);

  return {
    name: embed?.title ?? '',
    comment: embed?.description?.replace(COMMENT_QUOTE, '') ?? '',
    recent: field(RECENT_LABEL),
    world: dataCenter?.worlds.find((world) => worldWords.includes(world)) ?? null,
    dataCenter: dataCenter?.name ?? null,
    startHour: time?.[1] ? Number(time[1]) : null,
    endHour: time?.[2] ? Number(time[2]) : null,
    jobs: JOBS.filter((job) => jobWords.includes(job.name)).map((job) => job.key),
  };
};

const formatTime = (startHour: number | null, endHour: number | null): string | null => {
  if (startHour === null && endHour === null) return null;
  const start = startHour === null ? '' : `${startHour}:00`;
  const end = endHour === null ? '' : `${endHour}:00`;
  return `${start}〜${end}`;
};

/** タンク・ヒーラー・DPSごとに1行ずつ並べる */
const formatJobs = (jobKeys: string[]): string =>
  JOB_ROLE_LINES.flatMap(({ role, emoji }) => {
    const names = JOBS.filter((job) => job.role === role && jobKeys.includes(job.key)).map((job) => job.name);
    return names.length > 0 ? [`${emoji} ${names.join(JOB_SEPARATOR)}`] : [];
  }).join('\n');
