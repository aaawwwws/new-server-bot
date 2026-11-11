import { FONT_FAMILIES, fit, loadAvatar, loadCanvas, readableColor, roundRect, toCss, type Context, type LoadedImage } from './canvas.js';
import { formatNumber } from './levels.js';

// レベルの画像カード（アイコン・名前・順位・レベル・次のレベルまでのゲージ）。
// @napi-rs/canvas を読み込めない環境では null を返し、呼び出し側は文字だけで表示する

const WIDTH = 960;
const HEIGHT = 300;
const PADDING = 56;
const AVATAR_SIZE = 200;
const TEXT_LEFT = PADDING + AVATAR_SIZE + 44;
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

/** avatar が null なら、頭文字の丸で代わりにする */
const draw = (ctx: Context, data: RankCardData, avatar: LoadedImage | null): void => {
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
