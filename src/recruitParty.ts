import { JOBS, type Job, type JobRole } from './jobs.js';

// 募集の形（フルパーティ・ライトパーティ・人数だけ）と、その枠

/** 枠に入れるロール。any はロール不問 */
export type SlotRole = JobRole | 'any';

export interface SlotDefinition {
  key: string;
  role: SlotRole;
}

export interface PartyType {
  /** DBと customId に入れる値 */
  value: string;
  /** 募集を作る画面に出す名前 */
  label: string;
  slots: SlotDefinition[];
  /** 枠ごとにロールが決まっているか（人数だけの募集は、枠を選ばずにジョブだけ選ぶ） */
  hasRoles: boolean;
}

const slots = (role: SlotRole, ...keys: string[]): SlotDefinition[] => keys.map((key) => ({ key, role }));

/** 人数だけの募集で選べる人数（24人はアライアンス） */
export const FREE_SIZES = [2, 3, 4, 5, 6, 7, 8, 24];

export const PARTY_TYPES: PartyType[] = [
  {
    value: 'full',
    label: 'フルパーティ（8人・MT/ST/H1/H2/D1〜D4）',
    slots: [...slots('tank', 'MT', 'ST'), ...slots('healer', 'H1', 'H2'), ...slots('dps', 'D1', 'D2', 'D3', 'D4')],
    hasRoles: true,
  },
  {
    value: 'light',
    label: 'ライトパーティ（4人・T/H/D1/D2）',
    slots: [...slots('tank', 'T'), ...slots('healer', 'H'), ...slots('dps', 'D1', 'D2')],
    hasRoles: true,
  },
  ...FREE_SIZES.map((size) => ({
    value: `free${size}`,
    label: `人数だけ: ${size}人（ロール不問）`,
    slots: Array.from({ length: size }, (_, i): SlotDefinition => ({ key: String(i + 1), role: 'any' })),
    hasRoles: false,
  })),
];

export const findPartyType = (value: string): PartyType | undefined => PARTY_TYPES.find((party) => party.value === value);

/** 短い名前（「フル」「ライト」「4人」） */
export const shortPartyLabel = (value: string): string => {
  if (value === 'full') return 'フルパーティ';
  if (value === 'light') return 'ライトパーティ';
  return `${value.replace('free', '')}人（ロール不問）`;
};

export const ROLE_EMOJIS: Record<SlotRole, string> = { tank: '🛡️', healer: '💚', dps: '🗡️', any: '👤' };

/** その枠に入れるジョブ */
export const jobsForRole = (role: SlotRole): Job[] => (role === 'any' ? JOBS : JOBS.filter((job) => job.role === role));

export const findJob = (key: string | null | undefined): Job | undefined => JOBS.find((job) => job.key === key);

/** ジョブの表示名。未定（null）なら「未定」 */
export const jobLabel = (key: string | null | undefined): string => findJob(key)?.name ?? '未定';
