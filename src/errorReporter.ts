import { codeBlock, type Client, type Guild } from 'discord.js';
import { sendLog } from './activityLog.js';

// Botで起きたエラーを、コンソールだけでなく「ログ」チャンネルにも知らせる（VPSのログを見なくても気づけるように）。
// 同じエラーが続くときは、30分に1回にまとめる

const THROTTLE_MS = 30 * 60_000;
const MAX_MESSAGE_LENGTH = 900;
const STACK_LINES = 3;

/** エラーごとの、最後に知らせた時刻と、そのあとまとめた回数 */
const recent = new Map<string, { at: number; skipped: number }>();
let client: Client | null = null;

/** どのサーバーに知らせるかを決めるため、起動時に Bot を渡しておく */
export const setErrorReportClient = (readyClient: Client): void => {
  client = readyClient;
};

/**
 * エラーを知らせる。guild を渡すとそのサーバーに、渡さなければ Bot がいる全サーバーに。
 * 知らせるのに失敗しても例外は出さない（呼び出し側の処理は止めない）
 */
export const reportError = (context: string, error: unknown, guild?: Guild | null): void => {
  console.error(`${context}:`, error);
  const message = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  const key = `${guild?.id ?? '*'}:${context}:${message}`;
  const now = Date.now();
  const last = recent.get(key);
  if (last && now - last.at < THROTTLE_MS) {
    last.skipped++;
    return;
  }
  recent.set(key, { at: now, skipped: 0 });

  const stack = error instanceof Error ? (error.stack ?? '').split('\n').slice(1, STACK_LINES + 1).map((line) => line.trim()) : [];
  const fields = [
    { name: '📄 内容', value: codeBlock(message.slice(0, MAX_MESSAGE_LENGTH)) },
    ...(stack.length > 0 ? [{ name: '📍 場所', value: codeBlock(stack.join('\n').slice(0, MAX_MESSAGE_LENGTH)) }] : []),
    ...(last && last.skipped > 0 ? [{ name: '🔁 まとめた回数', value: `前に知らせてから、同じエラーがあと${last.skipped}回ありました`, inline: true }] : []),
  ];
  const guilds = guild ? [guild] : [...(client?.guilds.cache.values() ?? [])];
  for (const target of guilds) {
    void sendLog(target, 'error', `⚠ ${context}`, undefined, { fields });
  }
};
