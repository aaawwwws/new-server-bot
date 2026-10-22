/** 「2日3時間」「1時間5分」「12分」のような長さ。1分未満は「1分未満」 */
export const formatDuration = (ms: number): string => {
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 1) return '1分未満';
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);
  if (days > 0) return `${days}日${hours % 24}時間`;
  return hours > 0 ? `${hours}時間${minutes % 60}分` : `${minutes}分`;
};
