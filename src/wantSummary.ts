import { DUTIES } from './duties.js';
import { listMemberWants, listWantItems, type WantMode } from './wantStore.js';

// プロフィールに出す「やりたいこと」（やりたいコンテンツで選んだもの）。
// プロフィールの投稿から読み込まれるので、Discord に触るもの（wantList.ts）とは分けておく

/** プロフィールに名前を出す数（残りは「ほか○件」） */
const MAX_LISTED = 8;
/** 埋め込みの項目1つに入る長さ（Discordの上限は1024） */
const MAX_LENGTH = 1000;

const DUTY_BY_KEY = new Map(DUTIES.map((duty, index) => [`d${duty.id}`, { name: duty.name, order: index }]));

/** 選んだやり方の書き方（通常だけなら何も付けない） */
export const modeTag = (modes: ReadonlySet<WantMode>): string => {
  if (!modes.has('unsynced')) return '';
  return modes.has('normal') ? '（どちらでも）' : '（制限解除）';
};

/**
 * その人が選んでいるものを、プロフィールに出す1行にする（「希望の園エデン零式：覚醒編1（どちらでも）・絶もうひとつの未来・🗺️ 地図」）。
 * ゲームの一覧の順、そのほかは最後。何も選んでいなければ null
 */
export const loadWantSummary = async (guildId: string, userId: string): Promise<string | null> => {
  const picks = await listMemberWants(guildId, userId);
  if (picks.length === 0) return null;
  const modes = new Map<string, Set<WantMode>>();
  for (const pick of picks) modes.set(pick.key, new Set([...(modes.get(pick.key) ?? []), pick.mode]));

  const custom = [...modes.keys()].some((key) => key.startsWith('c')) ? await listWantItems(guildId) : [];
  const customByKey = new Map(custom.map((item, index) => [`c${item.id}`, { name: `${item.emoji ? `${item.emoji} ` : ''}${item.name}`, order: DUTIES.length + index }]));
  const labels = [...modes]
    .flatMap(([key, set]) => {
      const found = DUTY_BY_KEY.get(key) ?? customByKey.get(key);
      return found ? [{ ...found, label: `${found.name}${modeTag(set)}` }] : [];
    })
    .sort((a, b) => a.order - b.order)
    .map((item) => item.label);
  if (labels.length === 0) return null;
  const listed = labels.slice(0, MAX_LISTED).join('・');
  const more = labels.length > MAX_LISTED ? ` ほか${labels.length - MAX_LISTED}件` : '';
  const text = `${listed}${more}`;
  return text.length > MAX_LENGTH ? `${text.slice(0, MAX_LENGTH - 1)}…` : text;
};
