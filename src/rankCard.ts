import { formatNumber } from './levels.js';

// レベルの画像カード（アイコン・名前・順位・レベル・次のレベルまでのゲージ）。
// @napi-rs/canvas を読み込めない環境では null を返し、呼び出し側は文字だけで表示する

const WIDTH = 960;
const HEIGHT = 300;
const PADDING = 56;
const AVATAR_SIZE = 200;
const TEXT_LEFT = PADDING + AVATAR_SIZE + 44;
/** 日本語と絵文字も描けるよう、入っていそうなフォントを順に並べる（Docker では Noto、Windows では游ゴシック・Segoe） */
const FONT_FAMILIES = '"Noto Sans CJK JP", "Noto Sans JP", "Yu Gothic", "Meiryo", "Noto Color Emoji", "Segoe UI Emoji", sans-serif';
const AVATAR_TIMEOUT_MS = 3_000;
const NAME_FONT_SIZE = 44;
const MIN_NAME_FONT_SIZE = 30;
/** 名前に色が付いていない人の色 */
const DEFAULT_COLOR = 0x5865f2;

export interface RankCardData {
  name: string;
  /** PNG のアイコンのURL */
  avatarUrl: string;
  /** 名前の色（0 なら決まった色） */
  color: number;
  level: number;
  /** 今のレベルになってから貯めたXP */
  current: number;
  /** 次のレベルまでに要るXP（current を含めた全体） */
  needed: number;
  totalXp: number;
  /** 「3位」「—」など */
  rank: string;
  /** 下に並べる小さな数字（「連続 5日」など） */
  stats: string[];
}

type CanvasModule = typeof import('@napi-rs/canvas');
type Context = ReturnType<ReturnType<CanvasModule['createCanvas']>['getContext']>;

let canvasModule: Promise<CanvasModule | null> | undefined;
const loadCanvas = (): Promise<CanvasModule | null> =>
  (canvasModule ??= import('@napi-rs/canvas').catch((error: unknown) => {
    console.error('画像カード用のライブラリを読み込めませんでした（文字だけで表示します）:', error);
    return null;
  }));

export const renderRankCard = async (data: RankCardData): Promise<Buffer | null> => {
  const canvas = await loadCanvas();
  if (!canvas) return null;
  try {
    const avatar = await loadAvatar(canvas, data.avatarUrl);
    const image = canvas.createCanvas(WIDTH, HEIGHT);
    draw(image.getContext('2d'), data, avatar);
    return image.toBuffer('image/png');
  } catch (error) {
    console.error('レベルの画像カードを作れませんでした:', error);
    return null;
  }
};

/** アイコンを読み込む。読めなければ null（頭文字の丸で代わりにする） */
const loadAvatar = async (canvas: CanvasModule, url: string) => {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(AVATAR_TIMEOUT_MS) });
    if (!response.ok) return null;
    return await canvas.loadImage(Buffer.from(await response.arrayBuffer()));
  } catch {
    return null;
  }
};

const draw = (ctx: Context, data: RankCardData, avatar: Awaited<ReturnType<typeof loadAvatar>>): void => {
  const accent = toCss(readableColor(data.color || DEFAULT_COLOR));

  // 背景（角を丸めた暗い板と、右上に名前の色の大きな丸）
  roundRect(ctx, 0, 0, WIDTH, HEIGHT, 32);
  const background = ctx.createLinearGradient(0, 0, WIDTH, HEIGHT);
  background.addColorStop(0, '#1d1f25');
  background.addColorStop(1, '#2c2f38');
  ctx.fillStyle = background;
  ctx.fill();
  ctx.save();
  ctx.clip();
  ctx.globalAlpha = 0.16;
  ctx.fillStyle = accent;
  ctx.beginPath();
  ctx.arc(WIDTH - 40, -30, 240, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();

  // アイコン（名前の色の輪）
  const cx = PADDING + AVATAR_SIZE / 2;
  const cy = HEIGHT / 2;
  ctx.fillStyle = accent;
  ctx.beginPath();
  ctx.arc(cx, cy, AVATAR_SIZE / 2 + 7, 0, Math.PI * 2);
  ctx.fill();
  ctx.save();
  ctx.beginPath();
  ctx.arc(cx, cy, AVATAR_SIZE / 2, 0, Math.PI * 2);
  ctx.clip();
  if (avatar) {
    ctx.drawImage(avatar, cx - AVATAR_SIZE / 2, cy - AVATAR_SIZE / 2, AVATAR_SIZE, AVATAR_SIZE);
  } else {
    ctx.fillStyle = '#3b3f4a';
    ctx.fillRect(cx - AVATAR_SIZE / 2, cy - AVATAR_SIZE / 2, AVATAR_SIZE, AVATAR_SIZE);
    ctx.fillStyle = '#ffffff';
    ctx.font = `bold 84px ${FONT_FAMILIES}`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText([...data.name][0] ?? '?', cx, cy + 4);
  }
  ctx.restore();

  // 右上の「レベル」と「順位」
  ctx.textBaseline = 'alphabetic';
  ctx.textAlign = 'right';
  const right = WIDTH - PADDING;
  ctx.font = `bold 72px ${FONT_FAMILIES}`;
  const levelText = String(data.level);
  const levelWidth = ctx.measureText(levelText).width;
  ctx.fillStyle = accent;
  ctx.fillText(levelText, right, 132);
  ctx.font = `24px ${FONT_FAMILIES}`;
  ctx.fillStyle = '#9da3b0';
  ctx.fillText('レベル', right, 64);

  const rankRight = right - Math.max(levelWidth, 80) - 48;
  ctx.font = `bold 52px ${FONT_FAMILIES}`;
  const rankWidth = ctx.measureText(data.rank).width;
  ctx.fillStyle = '#ffffff';
  ctx.fillText(data.rank, rankRight, 132);
  ctx.font = `24px ${FONT_FAMILIES}`;
  ctx.fillStyle = '#9da3b0';
  ctx.fillText('順位', rankRight, 64);

  // 名前（順位とぶつからない幅に収める。長い名前は少し小さくし、それでも入らなければ後ろを「…」にする）
  ctx.textAlign = 'left';
  ctx.fillStyle = '#ffffff';
  const nameWidth = rankRight - Math.max(rankWidth, 60) - 32 - TEXT_LEFT;
  let nameSize = NAME_FONT_SIZE;
  ctx.font = `bold ${nameSize}px ${FONT_FAMILIES}`;
  while (nameSize > MIN_NAME_FONT_SIZE && ctx.measureText(data.name).width > nameWidth) {
    nameSize -= 2;
    ctx.font = `bold ${nameSize}px ${FONT_FAMILIES}`;
  }
  ctx.fillText(fit(ctx, data.name, nameWidth), TEXT_LEFT, 120);

  // 次のレベルまでのゲージ
  const barTop = 196;
  const barHeight = 28;
  const barWidth = right - TEXT_LEFT;
  ctx.font = `22px ${FONT_FAMILIES}`;
  ctx.fillStyle = '#c3c7d1';
  ctx.fillText(`累計 ${formatNumber(data.totalXp)} XP`, TEXT_LEFT, barTop - 14);
  ctx.textAlign = 'right';
  ctx.fillText(`${formatNumber(data.current)} / ${formatNumber(data.needed)} XP`, right, barTop - 14);
  roundRect(ctx, TEXT_LEFT, barTop, barWidth, barHeight, barHeight / 2);
  ctx.fillStyle = '#3b3f4a';
  ctx.fill();
  const ratio = data.needed > 0 ? Math.min(1, data.current / data.needed) : 0;
  if (ratio > 0) {
    roundRect(ctx, TEXT_LEFT, barTop, Math.max(barHeight, barWidth * ratio), barHeight, barHeight / 2);
    ctx.fillStyle = accent;
    ctx.fill();
  }

  // 下の小さな数字
  ctx.textAlign = 'left';
  ctx.font = `22px ${FONT_FAMILIES}`;
  ctx.fillStyle = '#9da3b0';
  ctx.fillText(fit(ctx, data.stats.join(' ・ '), barWidth), TEXT_LEFT, 262);
};

/** 幅に収まらなければ、後ろを「…」にする */
const fit = (ctx: Context, text: string, maxWidth: number): string => {
  if (ctx.measureText(text).width <= maxWidth) return text;
  const chars = [...text];
  while (chars.length > 1 && ctx.measureText(`${chars.join('')}…`).width > maxWidth) chars.pop();
  return `${chars.join('')}…`;
};

const roundRect = (ctx: Context, x: number, y: number, width: number, height: number, radius: number): void => {
  ctx.beginPath();
  ctx.roundRect(x, y, width, height, radius);
};

/** 暗い背景で読みにくい暗い色は、白を混ぜて明るくする */
const readableColor = (color: number): number => {
  const channels = [(color >> 16) & 0xff, (color >> 8) & 0xff, color & 0xff];
  const luminance = (0.2126 * (channels[0] ?? 0) + 0.7152 * (channels[1] ?? 0) + 0.0722 * (channels[2] ?? 0)) / 255;
  if (luminance >= 0.35) return color;
  const [r = 0, g = 0, b = 0] = channels.map((c) => Math.round(c + (255 - c) * 0.45));
  return (r << 16) | (g << 8) | b;
};

const toCss = (color: number): string => `#${color.toString(16).padStart(6, '0')}`;
