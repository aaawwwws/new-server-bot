// XPとレベルの計算（称号など、XPを貯める仕組み（levels.ts）を読み込まずにレベルを知りたいところでも使う）

/** そのレベルから次のレベルに上がるのに要るXP。レベルが上がるほど多く要る */
export const xpForNextLevel = (level: number): number => 5 * level ** 2 + 50 * level + 100;

export interface LevelProgress {
  level: number;
  /** 今のレベルになってから貯めたXP */
  current: number;
  /** 次のレベルに上がるのに要るXP（current を含めた全体） */
  needed: number;
}

export const levelFromXp = (xp: number): LevelProgress => {
  let level = 0;
  let rest = xp;
  while (rest >= xpForNextLevel(level)) {
    rest -= xpForNextLevel(level);
    level++;
  }
  return { level, current: rest, needed: xpForNextLevel(level) };
};
