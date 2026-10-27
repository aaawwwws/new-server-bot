import type { Collection, Guild, GuildMember } from 'discord.js';
import { formatDuration } from './duration.js';
import { fetchAllMembers } from './guildUtils.js';
import { listMemberInvites } from './inviteStore.js';
import { addDays, addMonths, dayStart, formatDay, formatMonth, jstDay, monthStart, weekStart } from './jst.js';
import { formatNumber, levelFromXp } from './levels.js';
import { listLevelStats, listPeriodStats, listStreaks, type LevelStats } from './levelStore.js';
import { listRankingHiddenIds } from './memberSettings.js';
import { ADMIN_ROLE_NAME } from './permissions.js';
import { listStoredProfiles } from './profileStore.js';
import { boldName } from './names.js';
import { listFinishedRecruits } from './recruitStore.js';

// ランキングの中身（何を・どの期間で数えるか、順位、昨日からの変化）と、1行ぶんの書き方

export type RankingKind = 'xp' | 'messages' | 'voice' | 'reactions' | 'streak' | 'hosted' | 'joined' | 'invites';
export type RankingPeriod = 'day' | 'week' | 'month' | 'all';

export const RANKING_KINDS: RankingKind[] = ['xp', 'messages', 'voice', 'reactions', 'streak', 'hosted', 'joined', 'invites'];
export const RANKING_PERIODS: RankingPeriod[] = ['day', 'week', 'month', 'all'];

/** periods: 期間で区切れるか（連続日数は「今」だけ） */
export const KIND_INFO: Record<RankingKind, { label: string; emoji: string; periods: boolean }> = {
  xp: { label: 'XP', emoji: '✨', periods: true },
  messages: { label: '発言数', emoji: '💬', periods: true },
  voice: { label: 'VCの時間', emoji: '🎧', periods: true },
  reactions: { label: 'もらったリアクション', emoji: '💖', periods: true },
  streak: { label: '連続日数', emoji: '🔥', periods: false },
  hosted: { label: '募集の主催', emoji: '📣', periods: true },
  joined: { label: '募集の参加', emoji: '🙋', periods: true },
  invites: { label: '招待', emoji: '📨', periods: true },
};

export const PERIOD_LABELS: Record<RankingPeriod, string> = { day: '今日', week: '今週', month: '今月', all: '累計' };

export const MEDALS = ['🥇', '🥈', '🥉'];

export const toRankingKind = (value: string | null | undefined): RankingKind =>
  RANKING_KINDS.find((kind) => kind === value) ?? 'xp';

export const toRankingPeriod = (value: string | null | undefined): RankingPeriod =>
  RANKING_PERIODS.find((period) => period === value) ?? 'week';

export interface RankingEntry {
  member: GuildMember;
  value: number;
  /** 連続日数の最長記録（ほかの種類では 0） */
  best: number;
  /** 昨日の時点からの順位の変化（上がったらプラス）。昨日はいなかった人は 'new'。比べないランキングでは null */
  change: number | 'new' | null;
}

export interface Ranking {
  kind: RankingKind;
  /** 連続日数は期間で区切らないので 'all' */
  period: RankingPeriod;
  /** 期間の最初の日と、終わりの次の日（日本時間。累計は null） */
  range: DayRange | null;
  entries: RankingEntry[];
}

export interface DayRange {
  from: string;
  to: string;
}

/** 期間の最初の日と、終わりの次の日 */
export const periodRange = (period: RankingPeriod, today: string): DayRange | null => {
  switch (period) {
    case 'day':
      return { from: today, to: addDays(today, 1) };
    case 'week': {
      const from = weekStart(today);
      return { from, to: addDays(from, 7) };
    }
    case 'month': {
      const from = monthStart(today);
      return { from, to: addMonths(from, 1) };
    }
    default:
      return null;
  }
};

/** 「10/27（火）」「10/26（月）〜11/1（日）」「2026年10月」「これまでの合計」 */
export const describeRange = (period: RankingPeriod, range: DayRange | null): string => {
  if (!range) return 'これまでの合計';
  if (period === 'day') return formatDay(range.from);
  if (period === 'month') return formatMonth(range.from);
  return `${formatDay(range.from)}〜${formatDay(addDays(range.to, -1))}`;
};

// ---- 人ごとの値を読む

interface Score {
  value: number;
  best: number;
  /** 同じ値のときに上にする方（発言数・VCはXP、連続日数は最長記録） */
  tie: number;
}
type Scores = Map<string, Score>;
type StatKind = 'xp' | 'messages' | 'voice' | 'reactions';

const STAT_FIELDS: Record<StatKind, keyof Omit<LevelStats, 'userId'>> = {
  xp: 'xp',
  messages: 'messageCount',
  voice: 'voiceMinutes',
  reactions: 'reactionsReceived',
};
const isStatKind = (kind: RankingKind): kind is StatKind => kind in STAT_FIELDS;

const statScores = (stats: LevelStats[], kind: StatKind): Scores =>
  new Map(stats.map((s) => [s.userId, { value: s[STAT_FIELDS[kind]], best: 0, tie: s.xp }]));

/** 終わった募集の、主催した回数か参加した回数（待ちの人は数えない） */
const recruitScores = async (guildId: string, kind: 'hosted' | 'joined', range: DayRange | null): Promise<Scores> => {
  const recruits = await listFinishedRecruits(guildId, range ? dayStart(range.from) : null, range ? dayStart(range.to) : null);
  const counts = new Map<string, number>();
  for (const recruit of recruits) {
    const userIds = kind === 'hosted' ? [recruit.hostId] : [...new Set(recruit.participants.filter((p) => p.slot).map((p) => p.userId))];
    for (const userId of userIds) counts.set(userId, (counts.get(userId) ?? 0) + 1);
  }
  return new Map([...counts].map(([userId, count]) => [userId, { value: count, best: 0, tie: 0 }]));
};

/**
 * 招待した人の数。招待リンクで入って、今もサーバーにいて、プロフィール登録（審査に通る）まで進んだ人だけを数える
 * （サブアカウントで数を増やしにくくするため）。期間は入った日で区切る。tie は、リンクで入った人の全部の数
 */
const inviteScores = async (guildId: string, members: Collection<string, GuildMember>, range: DayRange | null): Promise<Scores> => {
  const [invites, profiles] = await Promise.all([
    listMemberInvites(guildId, range ? dayStart(range.from) : null, range ? dayStart(range.to) : null),
    listStoredProfiles(guildId),
  ]);
  const registered = new Set(profiles.map((profile) => profile.userId));
  const scores: Scores = new Map();
  for (const invite of invites) {
    const score = scores.get(invite.inviterId) ?? { value: 0, best: 0, tie: 0 };
    const invitee = members.get(invite.userId);
    score.tie++;
    if (invitee && !invitee.user.bot && registered.has(invite.userId)) score.value++;
    scores.set(invite.inviterId, score);
  }
  return scores;
};

export interface InviteSummary {
  /** 招待して、今もいてプロフィール登録まで進んだ人 */
  counted: number;
  /** その人のリンクで入った人の全部 */
  total: number;
  /** その人を招待した人（記録がなければ null） */
  inviterId: string | null;
}

/** 1人分の招待のまとめ（メンバーの詳細用） */
export const summarizeInvites = async (guild: Guild, userId: string): Promise<InviteSummary> => {
  const [members, invites, profiles] = await Promise.all([fetchAllMembers(guild), listMemberInvites(guild.id), listStoredProfiles(guild.id)]);
  const registered = new Set(profiles.map((profile) => profile.userId));
  const mine = invites.filter((invite) => invite.inviterId === userId);
  return {
    counted: mine.filter((invite) => members.get(invite.userId) && !members.get(invite.userId)?.user.bot && registered.has(invite.userId)).length,
    total: mine.length,
    inviterId: invites.find((invite) => invite.userId === userId)?.inviterId ?? null,
  };
};

const loadScores = async (
  guildId: string,
  kind: RankingKind,
  range: DayRange | null,
  today: string,
  members: Collection<string, GuildMember>,
): Promise<Scores> => {
  if (kind === 'invites') return inviteScores(guildId, members, range);
  if (isStatKind(kind)) {
    return statScores(range ? await listPeriodStats(guildId, range.from, range.to) : await listLevelStats(guildId), kind);
  }
  if (kind === 'streak') {
    return new Map((await listStreaks(guildId, today)).map((s) => [s.userId, { value: s.current, best: s.best, tie: s.best }]));
  }
  return recruitScores(guildId, kind, range);
};

/**
 * 昨日の時点の値（今の値から今日の分を引いたもの）。
 * 比べないとき（今日のランキング・期間の初日・XP／発言数／VC／もらったリアクション以外）は null
 */
const previousScores = async (guildId: string, kind: RankingKind, period: RankingPeriod, range: DayRange | null, today: string, current: Scores): Promise<Scores | null> => {
  if (!isStatKind(kind) || period === 'day' || range?.from === today) return null;
  const todays = statScores(await listPeriodStats(guildId, today, addDays(today, 1)), kind);
  return new Map(
    [...current].map(([userId, score]) => {
      const added = todays.get(userId);
      return [userId, { ...score, value: score.value - (added?.value ?? 0), tie: score.tie - (added?.tie ?? 0) }];
    }),
  );
};

/** 「管理者」ロールの人はランキングに入れない（XPは貯まる。週間・月間のロールも付かない） */
export const isRankingExempt = (member: GuildMember): boolean => member.roles.cache.some((role) => role.name === ADMIN_ROLE_NAME);

/** サーバーにいる人（Bot・ランキングに出ない人・管理者を除く）を、多い順に。値が 0 の人は入れない */
const order = (members: Collection<string, GuildMember>, hidden: Set<string>, scores: Scores, alsoInclude?: string): [GuildMember, Score][] =>
  [...scores]
    .flatMap(([userId, score]): [GuildMember, Score][] => {
      const member = members.get(userId);
      const visible = userId === alsoInclude || (!hidden.has(userId) && !(member && isRankingExempt(member)));
      return member && !member.user.bot && visible && score.value > 0 ? [[member, score]] : [];
    })
    .sort(([a, x], [b, y]) => y.value - x.value || y.tie - x.tie || a.id.localeCompare(b.id));

export interface RankingOptions {
  /** 昨日からの変化を出すか（出さなければ少し速い） */
  changes?: boolean;
  /** ランキングに出ない設定・管理者でも、この人は入れる（本人が自分の順位を見るとき） */
  alsoInclude?: string;
}

export const computeRanking = async (
  guild: Guild,
  kind: RankingKind,
  period: RankingPeriod,
  now: Date = new Date(),
  options: RankingOptions = {},
): Promise<Ranking> => {
  const today = jstDay(now);
  const usedPeriod = KIND_INFO[kind].periods ? period : 'all';
  const range = periodRange(usedPeriod, today);
  const [members, hidden] = await Promise.all([fetchAllMembers(guild), listRankingHiddenIds(guild.id)]);
  const scores = await loadScores(guild.id, kind, range, today, members);
  const previous = options.changes === false ? null : await previousScores(guild.id, kind, usedPeriod, range, today, scores);
  const previousRanks = previous
    ? new Map(order(members, hidden, previous, options.alsoInclude).map(([member], i) => [member.id, i + 1]))
    : null;
  const entries = order(members, hidden, scores, options.alsoInclude).map(([member, score], i): RankingEntry => {
    const before = previousRanks?.get(member.id);
    return {
      member,
      value: score.value,
      best: score.best,
      change: previousRanks ? (before === undefined ? 'new' : before - (i + 1)) : null,
    };
  });
  return { kind, period: usedPeriod, range, entries };
};

/** 終わった期間（from の日から to の日の前日まで）のXPの順位。週・月の結果の投稿と記録に使う */
export const rankXpBetween = async (guild: Guild, from: string, to: string): Promise<RankingEntry[]> => {
  const [members, hidden, stats] = await Promise.all([
    fetchAllMembers(guild),
    listRankingHiddenIds(guild.id),
    listPeriodStats(guild.id, from, to),
  ]);
  return order(members, hidden, statScores(stats, 'xp')).map(([member, score]) => ({ member, value: score.value, best: 0, change: null }));
};

// ---- 書き方

/** 値の見せ方。累計のXPはレベルも出す */
export const formatScore = (kind: RankingKind, period: RankingPeriod, entry: Pick<RankingEntry, 'value' | 'best'>): string => {
  switch (kind) {
    case 'xp':
      return period === 'all' ? `Lv.${levelFromXp(entry.value).level}（${formatNumber(entry.value)} XP）` : `${formatNumber(entry.value)} XP`;
    case 'voice':
      return formatDuration(entry.value * 60_000);
    case 'streak':
      return `${entry.value}日連続（最長${entry.best}日）`;
    case 'invites':
      return `${formatNumber(entry.value)}人`;
    default:
      return `${formatNumber(entry.value)}回`;
  }
};

/** 「あと ○○」の ○○ */
export const formatGap = (kind: RankingKind, gap: number): string => {
  switch (kind) {
    case 'xp':
      return `${formatNumber(gap)} XP`;
    case 'voice':
      return formatDuration(gap * 60_000);
    case 'streak':
      return `${gap}日`;
    case 'invites':
      return `${formatNumber(gap)}人`;
    default:
      return `${formatNumber(gap)}回`;
  }
};

/** 「 ⬆2」「 ⬇1」「 🆕」（変わっていなければ何も付けない） */
export const changeMark = (change: RankingEntry['change']): string => {
  if (change === null || change === 0) return '';
  if (change === 'new') return ' 🆕';
  return change > 0 ? ` ⬆${change}` : ` ⬇${-change}`;
};

/** ランキングの1行。index は0から数えた順位 */
export const rankingLine = (ranking: Pick<Ranking, 'kind' | 'period'>, entry: RankingEntry, index: number): string =>
  `${MEDALS[index] ?? `**${index + 1}.**`} ${boldName(entry.member)} ${formatScore(ranking.kind, ranking.period, entry)}${changeMark(entry.change)}`;

/** 「✨ XPランキング（今週）」「🔥 連続日数ランキング」 */
export const rankingTitle = (kind: RankingKind, period: RankingPeriod): string => {
  const { emoji, label, periods } = KIND_INFO[kind];
  return periods ? `${emoji} ${label}ランキング（${PERIOD_LABELS[period]}）` : `${emoji} ${label}ランキング`;
};
