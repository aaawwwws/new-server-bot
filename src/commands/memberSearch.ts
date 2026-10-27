import {
  EmbedBuilder,
  InteractionContextType,
  MessageFlags,
  SlashCommandBuilder,
  escapeMarkdown,
  messageLink,
  type ChatInputCommandInteraction,
} from 'discord.js';
import { CONTENT_ROLES, findContentRoles } from '../contentRoles.js';
import { DATA_CENTERS } from '../dataCenters.js';
import { EXPANSIONS } from '../expansions.js';
import { fetchAllMembers } from '../guildUtils.js';
import { INVITE_ME_ROLE_NAME, findInviteMeRole } from '../inviteMeRole.js';
import { JOBS, type JobRole } from '../jobs.js';
import { describeJobs, describeTime, describeWorld, type Profile } from '../profile.js';
import { listStoredProfiles } from '../profileStore.js';
import { findProgressRoles } from '../progressRoles.js';

const JOB_ROLE_LABELS: Record<JobRole, string> = { tank: 'タンク', healer: 'ヒーラー', dps: 'DPS' };
/** 結果に一度に出す人数（多すぎると読めないので、条件を足して絞ってもらう） */
const MAX_RESULTS = 20;

// このコマンドは管理者以外も使える（index.ts の PUBLIC_COMMANDS）
export const data = new SlashCommandBuilder()
  .setName('member-search')
  .setNameLocalizations({ ja: 'メンバー検索' })
  .setDescription('条件に合うメンバーのプロフィールを探します（結果は自分にだけ表示）')
  .setContexts(InteractionContextType.Guild)
  .addStringOption((option) =>
    option
      .setName('job')
      .setNameLocalizations({ ja: 'ジョブ' })
      .setDescription('使っているジョブ')
      .addChoices(...JOBS.map((job) => ({ name: job.name, value: job.key }))),
  )
  .addStringOption((option) =>
    option
      .setName('role')
      .setNameLocalizations({ ja: 'ロール' })
      .setDescription('タンク・ヒーラー・DPS のどれかのジョブを使っている人')
      .addChoices(...Object.entries(JOB_ROLE_LABELS).map(([value, name]) => ({ name, value }))),
  )
  .addStringOption((option) =>
    option
      .setName('datacenter')
      .setNameLocalizations({ ja: 'データセンター' })
      .setDescription('データセンター')
      .addChoices(...DATA_CENTERS.map((dc) => ({ name: dc.name, value: dc.name }))),
  )
  .addStringOption((option) =>
    option.setName('world').setNameLocalizations({ ja: 'ワールド' }).setDescription('ワールド名（例: Tiamat）'),
  )
  .addStringOption((option) =>
    option
      .setName('progress')
      .setNameLocalizations({ ja: '進行度' })
      .setDescription('今進めている拡張')
      .addChoices(...EXPANSIONS.map((expansion) => ({ name: expansion.name, value: expansion.name }))),
  )
  .addStringOption((option) =>
    option
      .setName('content')
      .setNameLocalizations({ ja: 'コンテンツ' })
      .setDescription('よく遊ぶコンテンツ')
      .addChoices(...CONTENT_ROLES.map((content) => ({ name: content.name, value: content.name }))),
  )
  .addIntegerOption((option) =>
    option
      .setName('hour')
      .setNameLocalizations({ ja: '時刻' })
      .setDescription('この時刻（0〜23時）に遊んでいる人')
      .setMinValue(0)
      .setMaxValue(23),
  )
  .addBooleanOption((option) =>
    option
      .setName('invite-me')
      .setNameLocalizations({ ja: 'いつでも誘って' })
      .setDescription(`「${INVITE_ME_ROLE_NAME}」ロールを付けている人だけ`),
  );

export const execute = async (interaction: ChatInputCommandInteraction<'cached'>): Promise<void> => {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  const { guild, options } = interaction;
  const job = options.getString('job');
  const jobRole = options.getString('role') as JobRole | null;
  const dataCenter = options.getString('datacenter');
  const world = options.getString('world')?.trim() || null;
  const progress = options.getString('progress');
  const content = options.getString('content');
  const hour = options.getInteger('hour');
  const inviteMe = options.getBoolean('invite-me') ?? false;
  const inviteMeRole = findInviteMeRole(guild);

  // 進行度・コンテンツはロールなので、今のメンバーの情報が必要
  const [profiles, members] = await Promise.all([listStoredProfiles(guild.id), fetchAllMembers(guild)]);
  const progressRole = progress ? findProgressRoles(guild).find((role) => role.name === progress) : undefined;
  const contentRole = content ? findContentRoles(guild).find((role) => role.name === content) : undefined;

  const matches = profiles.flatMap((entry) => {
    const member = members.get(entry.userId);
    if (!member) return [];
    const { profile } = entry;
    const ok =
      (!job || profile.jobs.includes(job)) &&
      (!jobRole || profile.jobs.some((key) => JOBS.find((j) => j.key === key)?.role === jobRole)) &&
      (!dataCenter || profile.dataCenter === dataCenter) &&
      (!world || profile.world?.toLowerCase() === world.toLowerCase()) &&
      (!progress || (progressRole !== undefined && member.roles.cache.has(progressRole.id))) &&
      (!content || (contentRole !== undefined && member.roles.cache.has(contentRole.id))) &&
      (hour === null || isActiveAt(profile, hour)) &&
      (!inviteMe || (inviteMeRole !== undefined && member.roles.cache.has(inviteMeRole.id)));
    return ok ? [{ entry, member }] : [];
  });

  const conditions = [
    job && JOBS.find((j) => j.key === job)?.name,
    jobRole && JOB_ROLE_LABELS[jobRole],
    dataCenter,
    world,
    progress && `進行度: ${progress}`,
    content && `よく遊ぶ: ${content}`,
    hour !== null && `${hour}時に活動`,
    inviteMe && 'いつでも誘ってOK',
  ].filter(Boolean);

  const lines = matches.slice(0, MAX_RESULTS).flatMap(({ entry, member }) => {
    const link =
      entry.channelId && entry.messageId ? ` ・ [プロフ](${messageLink(entry.channelId, entry.messageId, guild.id)})` : '';
    return [
      `**${entry.profile.name}**（${escapeMarkdown(member.displayName)}・@${escapeMarkdown(member.user.username)}）${inviteMeRole && member.roles.cache.has(inviteMeRole.id) ? ' 🙌' : ''}`,
      `　${describeWorld(entry.profile)} ・ ${describeJobs(entry.profile)} ・ ${describeTime(entry.profile)}${link}`,
    ];
  });
  const rest = matches.length - MAX_RESULTS;

  const embed = new EmbedBuilder()
    .setTitle(`🔍 メンバー検索（${matches.length}人）`)
    .setDescription(
      [
        `条件: ${conditions.length > 0 ? conditions.join('・') : 'なし（登録している全員）'}`,
        '',
        ...(lines.length > 0 ? lines : ['条件に合うメンバーは見つかりませんでした。']),
        ...(rest > 0 ? ['', `ほか ${rest}人（条件を足して絞り込んでください）`] : []),
      ].join('\n'),
    )
    .setColor(0x5865f2);
  await interaction.editReply({ embeds: [embed], allowedMentions: { parse: [] } });
};

/** その時刻が活動時間に入っているか（22〜2時のように日をまたぐ時間帯も見る） */
const isActiveAt = ({ startHour, endHour }: Profile, hour: number): boolean => {
  if (startHour === null && endHour === null) return false;
  if (startHour === null) return hour < (endHour ?? 24);
  if (endHour === null) return hour >= startHour;
  return startHour < endHour ? hour >= startHour && hour < endHour : hour >= startHour || hour < endHour;
};
