export type JobRole = 'tank' | 'healer' | 'dps';

export interface Job {
  /** customId に使う識別子 */
  key: string;
  /** 表示名 */
  name: string;
  /** ボタンの色分けに使う */
  role: JobRole;
}

const tank = (key: string, name: string): Job => ({ key, name, role: 'tank' });
const healer = (key: string, name: string): Job => ({ key, name, role: 'healer' });
const dps = (key: string, name: string): Job => ({ key, name, role: 'dps' });

// ボタンの並び（1行5個まで・最大5行）
// 最後の行の末尾に「次へ」ボタンが入るので、最後の行は4個までにする
export const JOB_ROWS: Job[][] = [
  [tank('PLD', 'ナイト'), tank('WAR', '戦士'), tank('DRK', '暗黒騎士'), tank('GNB', 'ガンブレイカー')],
  [healer('WHM', '白魔道士'), healer('SCH', '学者'), healer('AST', '占星術師'), healer('SGE', '賢者')],
  [dps('MNK', 'モンク'), dps('DRG', '竜騎士'), dps('NIN', '忍者'), dps('SAM', '侍'), dps('RPR', 'リーパー')],
  [dps('VPR', 'ヴァイパー'), dps('BRD', '吟遊詩人'), dps('MCH', '機工士'), dps('DNC', '踊り子')],
  [dps('BLM', '黒魔道士'), dps('SMN', '召喚士'), dps('RDM', '赤魔道士'), dps('PCT', 'ピクトマンサー')],
];

export const JOBS: Job[] = JOB_ROWS.flat();
