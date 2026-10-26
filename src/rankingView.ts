import {
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  MessageFlags,
  type ButtonInteraction,
  type ChatInputCommandInteraction,
  type GuildMember,
} from 'discord.js';
import { sendLog } from './activityLog.js';
import { formatDay, formatMonth, jstDay } from './jst.js';
import { formatNumber } from './levels.js';
import { findBestDayXp, findBestWeekXp, findStreak } from './levelStore.js';
import { loadRankingHidden, saveRankingHidden } from './memberSettings.js';
import { toRow, type Row } from './profileInputs.js';
import {
  KIND_INFO,
  MEDALS,
  PERIOD_LABELS,
  RANKING_PERIODS,
  computeRanking,
  describeRange,
  isRankingExempt,
  formatGap,
  formatScore,
  rankingLine,
  rankingTitle,
  toRankingKind,
  toRankingPeriod,
  type Ranking,
  type RankingKind,
  type RankingPeriod,
} from './rankings.js';
import { findResultBests, listChampions, listWinCounts } from './rankingStore.js';
import { describeBoost } from './xpBoost.js';

// ランキングの画面（本人にだけ見える）。/ランキング・設定パネル・ランキング掲示板のボタンから開く。
// 表示中の種類・期間・ページは customId（「rank:v:<種類>:<期間>:<ページ>:<ボタンの見分け>」）に入れるので、
// Botを再起動しても続きから操作できる

export const CUSTOM_ID_PREFIX = 'rank:';
export const MY_RANKS_ID = `${CUSTOM_ID_PREFIX}me`;
export const HALL_OF_FAME_ID = `${CUSTOM_ID_PREFIX}hof`;
/** 設定パネルの「自分のレベル」と同じボタン（レベルの画面は設定パネルが出す） */
const MY_LEVEL_ID = 'settings:menu:level';
const PAGE_SIZE = 10;
const COLOR = 0xf1c40f;
const HALL_OF_FAME_WEEKS = 8;
const HALL_OF_FAME_MONTHS = 6;
const WIN_COUNT_LIMIT = 5;
/** 種類のボタンの並び（1行目が発言・VCまわり、2行目がそのほか） */
const KIND_ROWS: RankingKind[][] = [
  ['xp', 'messages', 'voice', 'reactions'],
  ['streak', 'hosted', 'joined'],
];
const PERIOD_EMOJIS: Record<RankingPeriod, string> = { day: '📅', week: '🗓️', month: '🌙', all: '🏆' };

export interface RankScreen {
  content: string;
  embeds: EmbedBuilder[];
  components: Row[];
}

/** ランキングを開くボタンの customId。slot はボタンの見分け用（1つの画面に同じ customId は置けない） */
export const rankingId = (kind: RankingKind, period: RankingPeriod, page: number | 'me', slot: string): string =>
  `${CUSTOM_ID_PREFIX}v:${kind}:${period}:${page}:${slot}`;

const hideId = (hidden: boolean): string => `${CUSTOM_ID_PREFIX}hide:${hidden ? 'on' : 'off'}`;

export const handleButton = async (interaction: ButtonInteraction<'cached'>): Promise<void> => {
  const [, action, ...args] = interaction.customId.split(':');
  switch (action) {
    case 'v': {
      const [kind, period, page] = args;
      await respond(interaction, () =>
        rankingScreen(interaction.member, toRankingKind(kind), toRankingPeriod(period), page === 'me' ? 'me' : Number.parseInt(page ?? '', 10) || 0),
      );
      return;
    }
    case 'me':
      await respond(interaction, () => myRanksScreen(interaction.member));
      return;
    case 'hof':
      await respond(interaction, () => hallOfFameScreen(interaction.member));
      return;
    case 'hide': {
      const hidden = args[0] === 'on';
      await respond(interaction, async () => {
        await setRankingHidden(interaction.member, hidden);
        return myRanksScreen(interaction.member, hidden ? '🙈 ランキングに出ないようにしました。' : '🙋 ランキングに出るようにしました。');
      });
      return;
    }
  }
};

/** /ランキング（本人にだけ見える画面を出す） */
export const replyRanking = async (interaction: ChatInputCommandInteraction<'cached'>, kind: RankingKind, period: RankingPeriod): Promise<void> => {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  await interaction.editReply(screenPayload(await rankingScreen(interaction.member, kind, period, 0)));
};

/**
 * 本人にだけ見える画面からの操作ならその画面を切り替え、掲示板などみんなが見るメッセージからなら、本人にだけ見える画面を新しく出す。
 * 集計に時間がかかることがあるので、先に応答しておく
 */
const respond = async (interaction: ButtonInteraction<'cached'>, build: () => Promise<RankScreen>): Promise<void> => {
  if (interaction.message.flags.has(MessageFlags.Ephemeral)) {
    await interaction.deferUpdate();
  } else {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  }
  await interaction.editReply(screenPayload(await build()));
};

/** 画面を出すときの中身。前の画面に付いていた画像（レベルのカード）は外す */
export const screenPayload = (screen: RankScreen) => ({ ...screen, files: [], attachments: [] });

/** ランキングに出すかを変え、変わったときはログに残す */
export const setRankingHidden = async (member: GuildMember, hidden: boolean): Promise<void> => {
  if ((await loadRankingHidden(member.guild.id, member.id)) === hidden) return;
  await saveRankingHidden(member.guild.id, member.id, hidden);
  void sendLog(member.guild, 'level', `${member} が「ランキングに${hidden ? '出さない' : '出す'}」にしました`, member, {
    fields: [{ name: '🏆 ランキング', value: hidden ? '出さない（順位に入らず、週間・月間のロールも付かない）' : '出す', inline: true }],
  });
};

// ---- ランキング

/** 種類ごとの、数え方の説明 */
const KIND_NOTES: Partial<Record<RankingKind, string>> = {
  voice: '2人以上いるVCで、ミュートしていなかった時間（配信中はミュートでも数えます）',
  reactions: '同じ人から同じメッセージへのリアクションは1回。自分の投稿へのリアクションとBotのリアクションは数えません',
  streak: '発言・VC・リアクションをした日が続いている日数（今日まだでも、昨日まで続いていれば途切れていない扱い）',
  hosted: '終わった募集だけを数えます（中止は数えません）',
  joined: '終わった募集で、枠に入っていた回数（待ちと中止は数えません）',
};

export const rankingScreen = async (
  viewer: GuildMember,
  kind: RankingKind,
  period: RankingPeriod,
  page: number | 'me',
  now: Date = new Date(),
): Promise<RankScreen> => {
  const ranking = await computeRanking(viewer.guild, kind, period, now);
  const { entries } = ranking;
  const pages = Math.max(1, Math.ceil(entries.length / PAGE_SIZE));
  const myIndex = entries.findIndex((entry) => entry.member.id === viewer.id);
  const requested = page === 'me' ? Math.floor(Math.max(myIndex, 0) / PAGE_SIZE) : page;
  const current = Math.min(Math.max(requested, 0), pages - 1);
  const first = current * PAGE_SIZE;
  const onPage = myIndex >= first && myIndex < first + PAGE_SIZE;
  const line = (index: number): string => {
    const entry = entries[index];
    if (!entry) return '';
    return `${rankingLine(ranking, entry, index)}${index === myIndex ? ' ← あなた' : ''}`;
  };
  const shown = entries.slice(first, first + PAGE_SIZE).map((_, i) => line(first + i));
  // 自分がこのページにいなければ、自分の前後を下に出す
  const around = myIndex >= 0 && !onPage ? [myIndex - 1, myIndex, myIndex + 1].filter((i) => i >= 0 && i < entries.length).map(line) : [];
  const excluded = myIndex < 0 && isRankingExempt(viewer);
  const hidden = myIndex < 0 && !excluded && (await loadRankingHidden(viewer.guild.id, viewer.id));
  const boost = kind === 'xp' ? describeBoost(viewer.guild.id, now) : null;
  const showsChanges = entries.some((entry) => entry.change !== null);

  const embed = new EmbedBuilder()
    .setColor(COLOR)
    .setTitle(rankingTitle(kind, period))
    .setDescription(
      [
        describeRange(ranking.period, ranking.range),
        ...(KIND_NOTES[kind] ? [KIND_NOTES[kind]] : []),
        '',
        ...(entries.length === 0 ? ['まだ記録がありません。'] : shown),
        ...(around.length > 0 ? ['', '**あなたの周り**', ...around] : []),
        '',
        excluded ? 'あなたは「管理者」ロールがあるので、ランキングには入りません（XPは貯まっています）。' : myStatus(ranking, myIndex, hidden),
        ...(boost ? ['', boost] : []),
      ].join('\n'),
    )
    .setFooter({
      text: [
        entries.length === 0 ? '0人' : `${entries.length}人中 ${first + 1}〜${first + shown.length}位`,
        `${current + 1}/${pages}ページ`,
        ...(showsChanges ? ['⬆⬇🆕 は昨日からの変化'] : []),
      ].join('・'),
    });

  const kindButton = (k: RankingKind): ButtonBuilder =>
    new ButtonBuilder()
      .setCustomId(rankingId(k, period, 0, 'k'))
      .setLabel(KIND_INFO[k].label)
      .setEmoji({ name: KIND_INFO[k].emoji })
      .setStyle(k === kind ? ButtonStyle.Primary : ButtonStyle.Secondary);
  const usesPeriods = KIND_INFO[kind].periods;
  const periodButton = (p: RankingPeriod): ButtonBuilder =>
    new ButtonBuilder()
      .setCustomId(rankingId(kind, p, 0, 'p'))
      .setLabel(PERIOD_LABELS[p])
      .setStyle(usesPeriods && p === period ? ButtonStyle.Primary : ButtonStyle.Secondary)
      .setDisabled(!usesPeriods);
  return {
    content: '',
    embeds: [embed],
    components: [
      ...KIND_ROWS.map((row) => toRow(...row.map(kindButton))),
      toRow(...RANKING_PERIODS.map(periodButton)),
      toRow(
        button(rankingId(kind, period, current - 1, 'prev'), '前へ', '◀️').setDisabled(current === 0),
        button(rankingId(kind, period, current + 1, 'next'), '次へ', '▶️').setDisabled(current >= pages - 1),
        button(rankingId(kind, period, 'me', 'me'), '自分の位置へ', '📍').setDisabled(myIndex < 0 || onPage),
      ),
      toRow(myRanksButton(), hallOfFameButton(), myLevelButton()),
    ],
  };
};

/** 一番下に出す、自分の順位と「あと何で1つ上か」 */
const myStatus = (ranking: Ranking, myIndex: number, hidden: boolean): string => {
  if (hidden) return 'あなたは「ランキングに出ない」設定です（「自分の順位」から変えられます）。';
  const mine = ranking.entries[myIndex];
  if (!mine) return 'あなたはまだこのランキングに入っていません。';
  const head = `あなた: **${myIndex + 1}位** ${formatScore(ranking.kind, ranking.period, mine)}`;
  const above = ranking.entries[myIndex - 1];
  if (!above) return `${head} 🎉`;
  const gap = above.value - mine.value;
  return gap > 0 ? `${head}・${myIndex}位まであと **${formatGap(ranking.kind, gap)}**` : `${head}・${myIndex}位と並んでいます`;
};

// ---- 自分の順位

export const myRanksScreen = async (viewer: GuildMember, note?: string, now: Date = new Date()): Promise<RankScreen> => {
  const { guild } = viewer;
  // ランキングに出ない設定でも、本人には「出した場合の順位」を見せる
  const options = { changes: false, alsoInclude: viewer.id };
  const statKinds: RankingKind[] = ['xp', 'messages', 'voice', 'reactions'];
  const [hidden, byPeriod, streakRanking, streak, hosted, joined] = await Promise.all([
    loadRankingHidden(guild.id, viewer.id),
    Promise.all(RANKING_PERIODS.map((period) => Promise.all(statKinds.map((kind) => computeRanking(guild, kind, period, now, options))))),
    computeRanking(guild, 'streak', 'all', now, options),
    findStreak(guild.id, viewer.id, jstDay(now)),
    computeRanking(guild, 'hosted', 'all', now, options),
    computeRanking(guild, 'joined', 'all', now, options),
  ]);
  const place = (ranking: Ranking): string => {
    const index = ranking.entries.findIndex((entry) => entry.member.id === viewer.id);
    const entry = ranking.entries[index];
    return entry ? `**${index + 1}位**・${formatScore(ranking.kind, ranking.period, entry)}` : '—';
  };
  const streakIndex = streakRanking.entries.findIndex((entry) => entry.member.id === viewer.id);
  const boost = describeBoost(guild.id, now);

  const embed = new EmbedBuilder()
    .setColor(COLOR)
    .setAuthor({ name: viewer.displayName, iconURL: viewer.displayAvatarURL() })
    .setTitle('🙋 あなたの順位')
    .setDescription(
      [
        ...(note ? [note, ''] : []),
        isRankingExempt(viewer)
          ? '🛠️ 「管理者」ロールがあるので、ランキングには入りません（ここの順位は、入った場合の順位です）。'
          : hidden
            ? '🙈 **ランキングに出ない設定中**です。ほかの人が見るランキングには出ていません（ここの順位は、出した場合の順位です）。'
            : '各ランキングでの、今のあなたの順位です。',
        ...(boost ? ['', boost] : []),
      ].join('\n'),
    )
    .addFields(
      ...RANKING_PERIODS.map((period, i) => ({
        name: `${PERIOD_EMOJIS[period]} ${PERIOD_LABELS[period]}`,
        value: (byPeriod[i] ?? []).map((ranking) => `${KIND_INFO[ranking.kind].emoji} ${place(ranking)}`).join('\n'),
        inline: true,
      })),
      {
        name: '🔥 連続日数',
        value: `今 **${streak.current}日**${streakIndex >= 0 ? `（${streakIndex + 1}位）` : ''}\n最長 ${streak.best}日`,
        inline: true,
      },
      { name: '📣 PT募集（累計）', value: `主催 ${place(hosted)}\n参加 ${place(joined)}`, inline: true },
    )
    .setFooter({ text: '✨XP・💬発言数・🎧VCの時間・💖もらったリアクション。順位は「ランキングに出ない」設定の人と管理者を除いて数えています' });

  return {
    content: '',
    embeds: [embed],
    components: [
      toRow(button(rankingId('xp', 'week', 0, 'o'), 'ランキングを開く', '🏆', ButtonStyle.Primary), hallOfFameButton(), myLevelButton()),
      toRow(hidden ? button(hideId(false), 'ランキングに出す', '🙋') : button(hideId(true), 'ランキングに出さない', '🙈')),
    ],
  };
};

// ---- 歴代記録

export const hallOfFameScreen = async (viewer: GuildMember, now: Date = new Date()): Promise<RankScreen> => {
  const guildId = viewer.guild.id;
  const [weekly, monthly, wins, weekBests, monthBests, bestWeek, bestDay, streak] = await Promise.all([
    listChampions(guildId, 'week', HALL_OF_FAME_WEEKS),
    listChampions(guildId, 'month', HALL_OF_FAME_MONTHS),
    listWinCounts(guildId, 'week', WIN_COUNT_LIMIT),
    findResultBests(guildId, viewer.id, 'week'),
    findResultBests(guildId, viewer.id, 'month'),
    findBestWeekXp(guildId, viewer.id),
    findBestDayXp(guildId, viewer.id),
    findStreak(guildId, viewer.id, jstDay(now)),
  ]);

  const embed = new EmbedBuilder()
    .setColor(COLOR)
    .setTitle('🏛️ 歴代記録')
    .setDescription('週・月が終わったときの経験値ランキングの記録です（毎週月曜0時・毎月1日0時に、上位10人を残します）。')
    .addFields(
      {
        name: '👑 歴代の週間1位',
        value: weekly.map((c) => `${formatDay(c.start)}〜 <@${c.userId}> ${formatNumber(c.xp)} XP`).join('\n') || 'まだありません',
      },
      {
        name: '🌟 歴代の月間MVP',
        value: monthly.map((c) => `${formatMonth(c.start)} <@${c.userId}> ${formatNumber(c.xp)} XP`).join('\n') || 'まだありません',
        inline: true,
      },
      {
        name: '🏅 週間1位の回数',
        value: wins.map((w, i) => `${MEDALS[i] ?? `**${i + 1}.**`} <@${w.userId}> ${w.wins}回`).join('\n') || 'まだありません',
        inline: true,
      },
      {
        name: '📈 あなたの自己ベスト',
        value: [
          `週間の最高順位: ${weekBests.bestRank ? `**${weekBests.bestRank.rank}位**（${formatDay(weekBests.bestRank.start)}〜）` : '—'}`,
          `月間の最高順位: ${monthBests.bestRank ? `**${monthBests.bestRank.rank}位**（${formatMonth(monthBests.bestRank.start)}）` : '—'}`,
          `週間1位: ${weekBests.wins}回・月間MVP: ${monthBests.wins}回`,
          `1週間の最高XP: ${bestWeek ? `**${formatNumber(bestWeek.xp)} XP**（${formatDay(bestWeek.week)}〜）` : '—'}`,
          `1日の最高XP: ${bestDay ? `**${formatNumber(bestDay.xp)} XP**（${formatDay(bestDay.day)}）` : '—'}`,
          `最長の連続日数: **${streak.best}日**`,
        ].join('\n'),
      },
    );

  return {
    content: '',
    embeds: [embed],
    components: [toRow(button(rankingId('xp', 'week', 0, 'o'), 'ランキング', '🏆', ButtonStyle.Primary), myRanksButton(), myLevelButton())],
  };
};

// ---- ボタン

/** ランキング掲示板に付けるボタン */
export const boardButtons = (): Row =>
  toRow(
    button(MY_RANKS_ID, '自分の順位を見る', '🙋', ButtonStyle.Primary),
    button(rankingId('xp', 'week', 0, 'o'), 'ランキングを詳しく見る', '🏆'),
    hallOfFameButton(),
  );

/** 設定パネルのレベルの画面に付けるボタン */
export const levelScreenButtons = (): ButtonBuilder[] => [
  button(rankingId('xp', 'week', 0, 'o'), 'ランキング', '🏆', ButtonStyle.Primary),
  myRanksButton(),
  hallOfFameButton(),
];

const myRanksButton = (): ButtonBuilder => button(MY_RANKS_ID, '自分の順位', '🙋');
const hallOfFameButton = (): ButtonBuilder => button(HALL_OF_FAME_ID, '歴代記録', '🏛️');
const myLevelButton = (): ButtonBuilder => button(MY_LEVEL_ID, '自分のレベル', '📊');

const button = (id: string, label: string, emoji: string, style: ButtonStyle = ButtonStyle.Secondary): ButtonBuilder =>
  new ButtonBuilder().setCustomId(id).setLabel(label).setEmoji({ name: emoji }).setStyle(style);
