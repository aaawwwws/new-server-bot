export interface Expansion {
  /** ロール名・ボタンの表示名 */
  name: string;
  /** ロール作成時の色 */
  color: number;
}

// 新しい拡張が出たら末尾に追加して、/進行度パネル を設置し直す
export const EXPANSIONS: Expansion[] = [
  { name: '新生', color: 0x4a90d9 },
  { name: '蒼天', color: 0x9ec9e8 },
  { name: '紅蓮', color: 0xc0392b },
  { name: '漆黒', color: 0x7b4fbf },
  { name: '暁月', color: 0x3fb6c4 },
  { name: '黄金', color: 0xd4a72c },
];
