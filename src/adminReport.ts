import { readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { EmbedBuilder, MessageFlags, time, type Client, type Guild } from 'discord.js';
import { LOG_CHANNEL_NAME } from './activityLog.js';
import { pool } from './db.js';
import { formatDuration } from './duration.js';
import { reportError } from './errorReporter.js';
import { canBotPost, fetchAllMembers, findTextChannel } from './guildUtils.js';
import { addDays, dayStart, formatDay, jstDay, toJst, weekStart } from './jst.js';
import { formatNumber } from './levels.js';
import { listActiveDayCounts, listPeriodStats } from './levelStore.js';
import { countLogsByKind } from './logStore.js';
import { countApplications, listStoredProfiles } from './profileStore.js';
import { countRecruitsByStatus } from './recruitStore.js';

// 管理レポート（参加・退出・申請・来た人・来なくなった人・PT募集・バックアップ）。
// 毎週月曜9時（日本時間）に先週の分を「ログ」チャンネルに投稿する。管理パネルからは直近7日の分をいつでも見られる。
// あわせて、DBのバックアップが作られ続けているかを見張る

/** バックアップのフォルダ（Docker では compose.yaml で ./backups をここに見せている） */
const BACKUP_DIR = process.env.BACKUP_DIR ?? '/backups';
const REPORT_HOUR = 9;
/** 「よく来ている」とみなす、1週間に来た日数 */
const REGULAR_DAYS = 4;
/** 未登録のままの人を数えるときの、入ってからの日数 */
const UNREGISTERED_DAYS = 7;
/** 来なくなった人を名前で出す人数 */
const MAX_NAMED = 10;
/** これより古いバックアップしかなければ知らせる */
const BACKUP_STALE_MS = 36 * 60 * 60_000;
/** バックアップを見に行く間隔と、起動してから見始めるまで（作られる前に知らせないため） */
const BACKUP_CHECK_MS = 6 * 60 * 60_000;
const BACKUP_GRACE_MS = 60 * 60_000;
const TICK_MS = 60_000;
const COLOR = 0x5865f2;

export interface BackupStatus {
  count: number;
  latest: Date | null;
}

/** バックアップの数と、一番新しいものの時刻。フォルダが見えなければ null（PC上での開発中など） */
export const readBackupStatus = async (dir: string = BACKUP_DIR): Promise<BackupStatus | null> => {
  try {
    const names = (await readdir(dir)).filter((name) => /^bot-.+\.sql\.gz$/.test(name));
    const times = await Promise.all(names.map(async (name) => (await stat(join(dir, name))).mtime));
    return { count: names.length, latest: times.sort((a, b) => b.getTime() - a.getTime())[0] ?? null };
  } catch {
    return null;
  }
};

/** from の日から to の日の前日まで（日本時間）のレポート */
export const buildAdminReport = async (guild: Guild, from: string, to: string, title: string, now: Date = new Date()): Promise<EmbedBuilder> => {
  const fromDate = dayStart(from);
  const toDate = dayStart(to);
  const [members, logs, applications, active, previousActive, stats, recruits, profiles, backup] = await Promise.all([
    fetchAllMembers(guild),
    countLogsByKind(guild.id, ['join', 'leave'], fromDate, toDate),
    countApplications(guild.id, fromDate, toDate),
    listActiveDayCounts(guild.id, from, to),
    listActiveDayCounts(guild.id, addDays(from, -7), from),
    listPeriodStats(guild.id, from, to),
    countRecruitsByStatus(guild.id, fromDate, toDate),
    listStoredProfiles(guild.id),
    readBackupStatus(),
  ]);
  const humans = members.filter((member) => !member.user.bot);
  const activeMembers = [...active].filter(([id]) => humans.has(id));
  const regular = activeMembers.filter(([, days]) => days >= REGULAR_DAYS).length;
  // 前の7日は来ていたのに、この7日は1回も来なかった人
  const stopped = [...previousActive.keys()].filter((id) => humans.has(id) && !active.has(id));
  const registered = new Set(profiles.map((profile) => profile.userId));
  const unregisteredSince = now.getTime() - UNREGISTERED_DAYS * 24 * 60 * 60_000;
  const unregistered = humans.filter((member) => !registered.has(member.id) && (member.joinedTimestamp ?? 0) < unregisteredSince).size;
  const sum = (key: 'messageCount' | 'voiceMinutes' | 'reactionsGiven') => stats.reduce((total, s) => total + s[key], 0);

  return new EmbedBuilder()
    .setColor(COLOR)
    .setTitle(title)
    .setDescription(`${formatDay(from)}〜${formatDay(addDays(to, -1))}`)
    .addFields(
      {
        name: '👥 メンバー',
        value: `${humans.size}人（参加 +${logs.get('join') ?? 0}・退出 −${logs.get('leave') ?? 0}）`,
        inline: true,
      },
      { name: '🔥 来た人', value: `${activeMembers.length}人（${REGULAR_DAYS}日以上来た人 ${regular}人）`, inline: true },
      {
        name: '📝 プロフィール申請',
        value: `新しく ${applications.created}件・許可 ${applications.approved}・拒否 ${applications.rejected}\n審査待ち（今）${applications.pending}件`,
        inline: true,
      },
      {
        name: `💤 来なくなった人（${stopped.length}人）`,
        value:
          stopped.length === 0
            ? 'いません'
            : `${stopped.slice(0, MAX_NAMED).map((id) => `<@${id}>`).join(' ')}${stopped.length > MAX_NAMED ? ` ほか${stopped.length - MAX_NAMED}人` : ''}\n-# その前の7日は来ていて、この7日は来ていない人`,
      },
      { name: `🆕 未登録のまま${UNREGISTERED_DAYS}日以上`, value: `${unregistered}人`, inline: true },
      {
        name: '💬 発言・🎧 VC・👍 リアクション',
        value: `${formatNumber(sum('messageCount'))}回・${formatDuration(sum('voiceMinutes') * 60_000)}・${formatNumber(sum('reactionsGiven'))}回`,
        inline: true,
      },
      { name: '🎮 PT募集', value: `終わった ${recruits.get('finished') ?? 0}件・中止 ${recruits.get('cancelled') ?? 0}件`, inline: true },
      { name: '💾 DBのバックアップ', value: describeBackup(backup, now) },
    )
    .setFooter({ text: '「来た」は発言・VC・リアクションをした日。管理パネルの「来ていない人」で、もっと詳しく見られます' });
};

const describeBackup = (backup: BackupStatus | null, now: Date): string => {
  if (!backup) return '確認できません（Botからバックアップのフォルダが見えません）';
  if (!backup.latest) return '⚠ まだありません';
  const stale = now.getTime() - backup.latest.getTime() > BACKUP_STALE_MS;
  return `${stale ? '⚠ ' : ''}最新: ${time(backup.latest, 'f')}（${time(backup.latest, 'R')}）・${backup.count}日分`;
};

// ---- 毎週の投稿と、バックアップの見張り

/** レポートを投稿し終えた週（毎分DBに聞かないため） */
const postedWeeks = new Set<string>();
let lastBackupCheck = 0;
const startedAt = Date.now();

export const startAdminReports = (client: Client<true>): void => {
  setInterval(() => {
    runAdminSchedule(client).catch((error: unknown) => {
      reportError('管理レポートの処理に失敗しました', error);
    });
  }, TICK_MS).unref();
};

export const runAdminSchedule = async (client: Client<true>, now: Date = new Date()): Promise<void> => {
  // 月曜は9時から出す。Botが止まっていて月曜を過ぎたときは、動き出したときに出す
  const { weekday, hour } = toJst(now);
  if (weekday !== 1 || hour >= REPORT_HOUR) {
    const lastWeek = addDays(weekStart(jstDay(now)), -7);
    for (const guild of client.guilds.cache.values()) {
      await postWeeklyReport(guild, lastWeek, now).catch((error: unknown) => {
        reportError(`「${guild.name}」の管理レポートを投稿できませんでした`, error, guild);
      });
    }
  }
  if (now.getTime() - lastBackupCheck >= BACKUP_CHECK_MS && now.getTime() - startedAt >= BACKUP_GRACE_MS) {
    lastBackupCheck = now.getTime();
    await checkBackups(now);
  }
};

/** 先週のレポートを、まだ出していなければ「ログ」チャンネルに出す。二重に出さないよう、先に記録する */
const postWeeklyReport = async (guild: Guild, week: string, now: Date): Promise<void> => {
  const key = `${guild.id}:${week}`;
  if (postedWeeks.has(key)) return;
  const { rowCount } = await pool.query(
    'INSERT INTO admin_reports (guild_id, week_start) VALUES ($1, $2::date) ON CONFLICT DO NOTHING',
    [guild.id, week],
  );
  postedWeeks.add(key);
  if (rowCount === 0) return;

  const channel = findTextChannel(guild, LOG_CHANNEL_NAME);
  if (!channel || !canBotPost(channel)) return;
  const embed = await buildAdminReport(guild, week, addDays(week, 7), '📊 週間の管理レポート', now);
  await channel.send({ embeds: [embed], allowedMentions: { parse: [] }, flags: MessageFlags.SuppressNotifications });
};

/** バックアップが作られ続けているか。古ければ（なければ）エラーとして知らせる */
const checkBackups = async (now: Date): Promise<void> => {
  const backup = await readBackupStatus();
  if (!backup) return;
  if (backup.latest && now.getTime() - backup.latest.getTime() <= BACKUP_STALE_MS) return;
  reportError(
    'DBのバックアップが作られていません',
    new Error(backup.latest ? `最新のバックアップが ${backup.latest.toISOString()} から更新されていません` : 'バックアップがまだ1つもありません'),
  );
};
