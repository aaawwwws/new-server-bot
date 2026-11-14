// FF14のコンテンツ一覧（コンテンツファインダーのID・日本語の名前・カテゴリー・拡張）を XIVAPI から取り、src/duties.ts に書き出す。
// パッチで新しいコンテンツが増えたら、もう一度動かす: npx tsx scripts/fetch-duties.ts
import { writeFileSync } from 'node:fs';

const BASE = 'https://v2.xivapi.com/api/sheet/ContentFinderCondition';
const FIELDS = ['Name', 'ContentType.Name', 'ClassJobLevelRequired', 'SortKey', 'AllianceRoulette', 'TerritoryType.ExVersion.Name'].join(',');
const PAGE_SIZE = 500;
const OUT = new URL('../src/duties.ts', import.meta.url);

interface Row {
  row_id: number;
  fields: {
    Name?: string;
    ContentType?: { fields?: { Name?: string } };
    ClassJobLevelRequired?: number;
    SortKey?: number;
    AllianceRoulette?: boolean;
    TerritoryType?: { fields?: { ExVersion?: { row_id?: number } } };
  };
}

/** カテゴリー（ゲームの種類を、メンバーが選びやすい分け方にしたもの）。どれにも入らないもの（チョコボレース・一人用のバトルなど）は null */
const categoryOf = (type: string, name: string, alliance: boolean): string | null => {
  switch (type) {
    case 'レイド':
      if (alliance) return 'alliance';
      return name.includes('零式') ? 'savage' : 'raid';
    case '滅アライアンスレイド':
      return 'alliance';
    case '絶レイド':
      return 'ultimate';
    case '討伐・討滅戦':
      return /^(極|幻)/.test(name) ? 'extreme' : 'trial';
    case 'ダンジョン':
      return 'dungeon';
    case 'ディープダンジョン':
      return 'deep';
    case '特殊ダンジョン探索':
      return 'variant';
    case '禁断の地エウレカ':
    case 'セイブ・ザ・クイーン':
    case '蜃気楼の島 クレセントアイル':
      return 'field';
    case 'トレジャーハント':
      return 'treasure';
    case 'PvP':
      // カスタムマッチは同じ場所の重複なので入れない
      return name.includes('カスタムマッチ') ? null : 'pvp';
    default:
      return null;
  }
};

const fetchAll = async (): Promise<Row[]> => {
  const rows: Row[] = [];
  let after: number | null = null;
  for (;;) {
    const url = `${BASE}?fields=${FIELDS}&language=ja&limit=${PAGE_SIZE}${after === null ? '' : `&after=${after}`}`;
    const response = await fetch(url, { headers: { 'User-Agent': 'new-server-bot (duty list for a FINAL FANTASY XIV community)' } });
    if (!response.ok) throw new Error(`XIVAPI: HTTP ${response.status}`);
    const page = (await response.json()) as { rows: Row[] };
    rows.push(...page.rows);
    const last = page.rows.at(-1);
    if (page.rows.length < PAGE_SIZE || !last) return rows;
    after = last.row_id;
  }
};

const main = async (): Promise<void> => {
  const rows = await fetchAll();
  const seen = new Set<string>();
  const duties = rows
    .flatMap((row) => {
      const name = row.fields.Name?.trim() ?? '';
      const category = name ? categoryOf(row.fields.ContentType?.fields?.Name ?? '', name, row.fields.AllianceRoulette === true) : null;
      if (!category) return [];
      return [
        {
          id: row.row_id,
          name,
          category,
          expansion: row.fields.TerritoryType?.fields?.ExVersion?.row_id ?? 0,
          level: row.fields.ClassJobLevelRequired ?? 0,
          sortKey: row.fields.SortKey ?? 0,
        },
      ];
    })
    // 同じカテゴリーに同じ名前があれば、最初の1つだけ（PvPの同じ場所など）
    .filter((duty) => {
      const key = `${duty.category}:${duty.name}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .sort((a, b) => a.expansion - b.expansion || a.level - b.level || a.sortKey - b.sortKey || a.id - b.id);

  const lines = duties.map(
    (duty) => `  { id: ${duty.id}, name: ${JSON.stringify(duty.name)}, category: '${duty.category}', expansion: ${duty.expansion} },`,
  );
  writeFileSync(
    OUT,
    [
      '// このファイルは scripts/fetch-duties.ts で作る（手で直さない）。もとは XIVAPI（FF14のゲームデータ）',
      '// パッチで新しいコンテンツが増えたら `npx tsx scripts/fetch-duties.ts` で作り直す',
      `// 作った日: ${new Date().toISOString().slice(0, 10)}・${duties.length}件`,
      '',
      "export type DutyCategory = 'savage' | 'ultimate' | 'raid' | 'alliance' | 'extreme' | 'trial' | 'dungeon' | 'deep' | 'variant' | 'field' | 'treasure' | 'pvp';",
      '',
      'export interface Duty {',
      '  /** コンテンツファインダーのID（ContentFinderCondition） */',
      '  id: number;',
      '  name: string;',
      '  category: DutyCategory;',
      '  /** 0: 新生エオルゼア 〜 5: 黄金のレガシー */',
      '  expansion: number;',
      '}',
      '',
      '/** 拡張・レベル・ゲーム内の並びの順 */',
      'export const DUTIES: readonly Duty[] = [',
      ...lines,
      '];',
      '',
    ].join('\n'),
  );
  const counts = new Map<string, number>();
  for (const duty of duties) counts.set(duty.category, (counts.get(duty.category) ?? 0) + 1);
  console.log(`${duties.length}件を書き出しました:`, Object.fromEntries(counts));
};

await main();
