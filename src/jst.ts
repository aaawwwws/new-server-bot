// 日本時間の日付・時刻。Botが動いているサーバーの時刻設定（Docker では UTC）に関係なく、日本時間で数える

const JST_OFFSET_MS = 9 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;
const WEEKDAYS = ['日', '月', '火', '水', '木', '金', '土'];

/** 日本時間の年月日時分から、その時刻を作る（日や時がはみ出したら繰り上がる） */
export const fromJst = (year: number, month: number, day: number, hour = 0, minute = 0): Date =>
  new Date(Date.UTC(year, month - 1, day, hour, minute) - JST_OFFSET_MS);

export const toJst = (date: Date) => {
  const jst = new Date(date.getTime() + JST_OFFSET_MS);
  return {
    year: jst.getUTCFullYear(),
    month: jst.getUTCMonth() + 1,
    day: jst.getUTCDate(),
    hour: jst.getUTCHours(),
    minute: jst.getUTCMinutes(),
    /** 0 が日曜 */
    weekday: jst.getUTCDay(),
  };
};

/** 日本時間のその日（「2026-10-22」の形。DBの date 型にそのまま渡せる） */
export const jstDay = (date: Date = new Date()): string => {
  const { year, month, day } = toJst(date);
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
};

/** 「2026-10-22」の n 日後（マイナスなら前） */
export const addDays = (day: string, n: number): string => jstDay(new Date(dayStart(day).getTime() + n * DAY_MS));

/** その日を含む週の月曜 */
export const weekStart = (day: string): string => {
  const { weekday } = toJst(dayStart(day));
  return addDays(day, -((weekday + 6) % 7));
};

/** その日を含む月の1日 */
export const monthStart = (day: string): string => `${day.slice(0, 8)}01`;

/** 「2026-10-01」の n か月後の1日（マイナスなら前） */
export const addMonths = (day: string, n: number): string => {
  const [year = 0, month = 1] = day.split('-').map(Number);
  const index = year * 12 + (month - 1) + n;
  return `${Math.floor(index / 12)}-${String((index % 12) + 1).padStart(2, '0')}-01`;
};

/** 「2026年10月」 */
export const formatMonth = (day: string): string => {
  const [year = 0, month = 1] = day.split('-').map(Number);
  return `${year}年${month}月`;
};

/** 「10/22（木）」 */
export const formatDay = (day: string): string => {
  const { month, day: date, weekday } = toJst(dayStart(day));
  return `${month}/${date}（${WEEKDAYS[weekday]}）`;
};

/** 「10/22 21:05」（日本時間） */
export const formatShortDateTime = (date: Date): string => {
  const { month, day, hour, minute } = toJst(date);
  return `${month}/${day} ${hour}:${String(minute).padStart(2, '0')}`;
};

/** 「2026-10-22 21:05:33」（日本時間。CSV用） */
export const formatFullDateTime = (date: Date): string => {
  const jst = new Date(date.getTime() + JST_OFFSET_MS);
  return jst.toISOString().slice(0, 19).replace('T', ' ');
};

/** その日の 0:00（日本時間） */
export const dayStart = (day: string): Date => {
  const [year = 0, month = 1, date = 1] = day.split('-').map(Number);
  return fromJst(year, month, date);
};
