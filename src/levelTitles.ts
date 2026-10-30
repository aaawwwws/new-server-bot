import { PermissionFlagsBits, type Guild, type GuildMember, type Role } from 'discord.js';
import { sendLog } from './activityLog.js';
import { fetchAllMembers } from './guildUtils.js';
import { levelFromXp } from './levelMath.js';
import { listLevelStats, listXpOf } from './levelStore.js';

// レベルの称号。決まったレベルになると、称号のロールが付く（持つのは一番上の1つだけ）。
// 上がったときは本人にDMで知らせる。XPが減って下がったとき（管理者の調整）は、下の称号に付け替える

export interface LevelTitle {
  level: number;
  name: string;
}

/** 低い順。名前を変えたら、前の名前のロールはサーバー設定から消す（Botは名前でロールを探す） */
export const LEVEL_TITLES: LevelTitle[] = [
  { level: 5, name: '駆け出し冒険者' },
  { level: 10, name: '一人前の冒険者' },
  { level: 20, name: '熟練の冒険者' },
  { level: 30, name: '歴戦の冒険者' },
  { level: 50, name: '伝説の冒険者' },
];
/** ログに名前を並べる人数 */
const MAX_NAMES_IN_LOG = 30;

/** そのレベルの称号（まだなければ null） */
export const titleForLevel = (level: number): LevelTitle | null => LEVEL_TITLES.filter((title) => title.level <= level).at(-1) ?? null;

/** 次の称号（一番上まで来ていれば null） */
export const nextTitle = (level: number): LevelTitle | null => LEVEL_TITLES.find((title) => title.level > level) ?? null;

/** 「一人前の冒険者（次は Lv.20 で熟練の冒険者）」 */
export const describeTitle = (level: number): string => {
  const title = titleForLevel(level);
  const next = nextTitle(level);
  return [title ? `**${title.name}**` : 'まだなし', next ? `（次は Lv.${next.level} で「${next.name}」）` : '（一番上の称号です）'].join('');
};

/** 称号の名前 → ロール（サーバーにあるものだけ） */
const findTitleRoles = (guild: Guild): Map<string, Role> =>
  new Map(
    LEVEL_TITLES.flatMap((title) => {
      const role = guild.roles.cache.find((r) => r.name === title.name);
      return role ? [[title.name, role] as const] : [];
    }),
  );

/**
 * 称号のロールがなければ作る。作った称号の名前を返す。
 * 新しいロールは一番下にできるので、上の称号から作ると、ロールの一覧で上の称号が上に並ぶ。
 * 名前の色を変えないよう色は付けず、誰でもメンションできる設定にもしない
 */
export const ensureTitleRoles = async (guild: Guild): Promise<string[]> => {
  const missing = LEVEL_TITLES.filter((title) => !guild.roles.cache.some((role) => role.name === title.name));
  if (missing.length === 0) return [];

  const me = guild.members.me ?? (await guild.members.fetchMe());
  if (!me.permissions.has(PermissionFlagsBits.ManageRoles)) {
    console.warn(`「${guild.name}」: Botにロールの管理権限がないため、称号のロールを作れません`);
    return [];
  }
  for (const title of [...missing].reverse()) {
    await guild.roles.create({ name: title.name, permissions: [], mentionable: false, reason: `Lv.${title.level}の称号` });
  }
  console.log(`「${guild.name}」に称号のロール（${missing.map((title) => title.name).join('・')}）を作りました`);
  return missing.map((title) => title.name);
};

interface TitleChange {
  before: LevelTitle | null;
  after: LevelTitle | null;
  level: number;
}

/** そのXPに合う称号に付け替える（一番上の1つだけにする）。変えたときだけ変更前・後を返す */
const applyTitle = async (member: GuildMember, xp: number, roles: Map<string, Role>): Promise<TitleChange | null> => {
  const { level } = levelFromXp(xp);
  const target = member.user.bot ? null : titleForLevel(level);
  const targetRole = target ? roles.get(target.name) : undefined;
  // 付けるはずのロールが消されているときは、今の称号もそのままにする
  if (target && !targetRole) return null;

  const held = LEVEL_TITLES.filter((title) => {
    const role = roles.get(title.name);
    return !!role && member.roles.cache.has(role.id);
  });
  const toRemove = held.filter((title) => title !== target).flatMap((title) => roles.get(title.name) ?? []);
  const toAdd = targetRole && !member.roles.cache.has(targetRole.id) ? targetRole : null;
  if (!toAdd && toRemove.length === 0) return null;

  const reason = target ? `Lv.${level}の称号` : '称号のレベルに届いていないため';
  if (toRemove.length > 0) await member.roles.remove(toRemove, reason);
  if (toAdd) await member.roles.add(toAdd, reason);
  return { before: held.at(-1) ?? null, after: target, level };
};

/** 前回見たレベル（「サーバーID:ユーザーID」→ レベル）。同じなら Discord のロールを見に行かない */
const knownLevels = new Map<string, number>();
/** 付け替えている途中の人（発言とVCのXPが同時に入っても、知らせるのは1回にする） */
const updating = new Set<string>();

/**
 * XPが増えた（減った）人の称号を付け替える。上がった人には DM で知らせ、変えたことはログに残す。
 * actor は管理者がXPを調整したとき、その管理者
 */
export const updateTitles = async (guild: Guild, userIds: string[], actor?: GuildMember): Promise<void> => {
  const roles = findTitleRoles(guild);
  if (userIds.length === 0 || roles.size === 0) return;
  const xps = await listXpOf(guild.id, userIds);
  for (const userId of new Set(userIds)) {
    const key = `${guild.id}:${userId}`;
    const xp = xps.get(userId) ?? 0;
    const { level } = levelFromXp(xp);
    if (knownLevels.get(key) === level || updating.has(key)) continue;
    updating.add(key);
    try {
      const member = guild.members.cache.get(userId) ?? (await guild.members.fetch(userId).catch(() => null));
      if (!member) continue;
      const change = await applyTitle(member, xp, roles);
      knownLevels.set(key, level);
      if (change) await announceTitle(member, change, actor);
    } finally {
      updating.delete(key);
    }
  }
};

/** 上がったら本人にDMで知らせ、ログに残す */
const announceTitle = async (member: GuildMember, { before, after, level }: TitleChange, actor?: GuildMember): Promise<void> => {
  const rank = (title: LevelTitle | null): number => (title ? LEVEL_TITLES.indexOf(title) : -1);
  const raised = rank(after) > rank(before);
  const next = nextTitle(level);
  const dm =
    raised && after
      ? await member
          .send(
            [
              `🎖️ 「${member.guild.name}」で、称号「**${after.name}**」になりました！（Lv.${level}）`,
              next ? `次の称号は Lv.${next.level} の「${next.name}」です。` : 'これが一番上の称号です。おめでとうございます！',
            ].join('\n'),
          )
          .then(
            () => '送りました',
            () => '送れませんでした（DMを受け付けていない設定）',
          )
      : null;
  const text = after
    ? raised
      ? `${member} が称号「${after.name}」になりました（Lv.${level}）`
      : `${member} の称号を「${after.name}」にしました（Lv.${level}）`
    : `${member} の称号を外しました（Lv.${level}）`;
  void sendLog(member.guild, 'level', text, actor ?? member, {
    title: '称号の変更',
    target: member,
    fields: [
      { name: '🎖️ 前の称号', value: before?.name ?? 'なし', inline: true },
      { name: '🎖️ 今の称号', value: after?.name ?? 'なし', inline: true },
      ...(dm ? [{ name: '✉️ お知らせのDM', value: dm, inline: true }] : []),
    ],
  });
};

/**
 * 全員の称号を、今のXPに合わせて付け直す（起動時。Botが止まっていた間や、称号のロールを作ったときの分）。
 * まとめて付け直すので、DMは送らず、ログも1件にまとめる
 */
export const syncTitles = async (guild: Guild): Promise<number> => {
  const roles = findTitleRoles(guild);
  if (roles.size === 0) return 0;
  const [members, stats] = await Promise.all([fetchAllMembers(guild), listLevelStats(guild.id)]);
  const xps = new Map(stats.map((s) => [s.userId, s.xp]));
  const changed: string[] = [];
  let failed = 0;
  for (const member of members.values()) {
    const xp = xps.get(member.id) ?? 0;
    try {
      const change = await applyTitle(member, xp, roles);
      knownLevels.set(`${guild.id}:${member.id}`, levelFromXp(xp).level);
      if (change) changed.push(`${member} ${change.after ? `→ ${change.after.name}` : '（外した）'}`);
    } catch (error) {
      console.error(`「${member.user.tag}」の称号を付け直せませんでした:`, error);
      failed++;
    }
  }
  if (changed.length > 0 || failed > 0) {
    const rest = changed.length - MAX_NAMES_IN_LOG;
    void sendLog(guild, 'level', `称号を今のレベルに合わせて付け直しました（${changed.length}人）`, undefined, {
      title: '称号の付け直し',
      fields: [
        ...(changed.length > 0
          ? [{ name: '🎖️ 付け直した人', value: [...changed.slice(0, MAX_NAMES_IN_LOG), ...(rest > 0 ? [`ほか ${rest}人`] : [])].join('\n') }]
          : []),
        ...(failed > 0 ? [{ name: '⚠ 付け直せなかった', value: `${failed}人（Botのロールが称号のロールより上にあるか確認してください）` }] : []),
      ],
    });
  }
  return changed.length;
};
