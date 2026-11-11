import { FONT_FAMILIES, fit, loadAvatar, loadCanvas, roundRect, type Context, type LoadedImage } from './canvas.js';

// ランキングの表彰台の画像（上位3人のアイコン・名前・XP・昨日からの変化）。ランキング掲示板と、週・月の結果の投稿で使う。
// @napi-rs/canvas を読み込めない環境では null を返し、呼び出し側は文字だけで表示する

const WIDTH = 1200;
const HEIGHT = 680;
/** 光の中心（1位のアイコンのあたり） */
const LIGHT_Y = 320;
/** 台の幅 */
const BASE_WIDTH = 260;
/** 名前を収める幅 */
const NAME_WIDTH = 300;

export interface PodiumEntry {
  name: string;
  /** PNG のアイコンのURL */
  avatarUrl: string;
  /** 「12,340 XP」など */
  value: string;
  /** 昨日からの変化（「▲2」「▼1」「NEW」）。出さないなら null */
  change: string | null;
}

export type PodiumTheme = 'gold' | 'purple';

export interface PodiumData {
  /** 上の大きな見出し（絵文字は使わない。フォントがない環境でも崩れないように） */
  title: string;
  subtitle: string;
  /** 右上の札（「XP 2倍 開催中」など）。なければ null */
  badge: string | null;
  theme: PodiumTheme;
  /** 1位から順に（3人まで） */
  entries: PodiumEntry[];
}

/** 週の結果と掲示板は金、月の結果は紫 */
const THEMES: Record<PodiumTheme, { accent: string; glow: string; title: [string, string]; background: [string, string] }> = {
  gold: { accent: '#f5cd47', glow: 'rgba(241, 196, 15, 0.28)', title: ['#fff6c8', '#f1c40f'], background: ['#15171d', '#272b36'] },
  purple: { accent: '#d2b0ff', glow: 'rgba(155, 89, 182, 0.34)', title: ['#f6ecff', '#c39bff'], background: ['#17141f', '#2b2438'] },
};

/** 金・銀・銅（輪と台のグラデーション） */
const MEDALS = [
  { ring: ['#fff4b8', '#f1c40f', '#a8780a'], base: ['#f6d66b', '#9c6f0c'], text: '#5a3f00' },
  { ring: ['#ffffff', '#c3cad3', '#7a838e'], base: ['#e4e9ef', '#858f9b'], text: '#3c434c' },
  { ring: ['#ffd6ad', '#cd7f32', '#7c4515'], base: ['#e3a56b', '#86501f'], text: '#4a2709' },
] as const;

/** 表彰台の並び（左から2位・1位・3位）。x は中心、size はアイコンの直径、height は台の高さ */
const SLOTS = [
  { index: 1, x: 320, size: 156, height: 112 },
  { index: 0, x: 600, size: 196, height: 152 },
  { index: 2, x: 880, size: 156, height: 86 },
] as const;

export const renderPodium = async (data: PodiumData): Promise<Buffer | null> => {
  const canvas = await loadCanvas();
  if (!canvas) return null;
  try {
    const avatars = await Promise.all(data.entries.slice(0, 3).map((entry) => loadAvatar(canvas, entry.avatarUrl)));
    const image = canvas.createCanvas(WIDTH, HEIGHT);
    draw(image.getContext('2d'), data, avatars);
    return image.toBuffer('image/png');
  } catch (error) {
    console.error('ランキングの画像を作れませんでした:', error);
    return null;
  }
};

const draw = (ctx: Context, data: PodiumData, avatars: (LoadedImage | null)[]): void => {
  const theme = THEMES[data.theme];
  drawBackground(ctx, data, theme);

  // 見出し
  ctx.textAlign = 'center';
  ctx.textBaseline = 'alphabetic';
  ctx.font = `bold 50px ${FONT_FAMILIES}`;
  const titleFill = ctx.createLinearGradient(0, 30, 0, 80);
  titleFill.addColorStop(0, theme.title[0]);
  titleFill.addColorStop(1, theme.title[1]);
  ctx.fillStyle = titleFill;
  ctx.fillText(fit(ctx, data.title, WIDTH - 320), WIDTH / 2, 78);
  ctx.font = `26px ${FONT_FAMILIES}`;
  ctx.fillStyle = '#aab1be';
  ctx.fillText(fit(ctx, data.subtitle, WIDTH - 320), WIDTH / 2, 118);
  if (data.badge) drawBadge(ctx, data.badge, theme.accent);

  for (const slot of SLOTS) {
    drawSlot(ctx, slot, data.entries[slot.index], avatars[slot.index] ?? null, theme.accent);
  }
  if (data.entries.length === 0) {
    // 1位の名前が入るところに書く
    ctx.textAlign = 'center';
    ctx.font = `bold 40px ${FONT_FAMILIES}`;
    ctx.fillStyle = '#d5d9e0';
    ctx.fillText('まだ記録がありません', WIDTH / 2, nameBaseline(SLOTS[1]));
  }
};

const drawBackground = (ctx: Context, data: PodiumData, theme: (typeof THEMES)[PodiumTheme]): void => {
  roundRect(ctx, 0, 0, WIDTH, HEIGHT, 36);
  const background = ctx.createLinearGradient(0, 0, 0, HEIGHT);
  background.addColorStop(0, theme.background[0]);
  background.addColorStop(1, theme.background[1]);
  ctx.fillStyle = background;
  ctx.fill();
  ctx.save();
  ctx.clip();
  // 1位の後ろの光
  const glow = ctx.createRadialGradient(WIDTH / 2, LIGHT_Y, 20, WIDTH / 2, LIGHT_Y, 540);
  glow.addColorStop(0, theme.glow);
  glow.addColorStop(1, 'rgba(0, 0, 0, 0)');
  ctx.fillStyle = glow;
  ctx.fillRect(0, 0, WIDTH, HEIGHT);
  // 放射状の光の筋
  ctx.globalAlpha = 0.06;
  ctx.fillStyle = theme.accent;
  for (let i = 0; i < 12; i++) {
    const angle = (Math.PI * 2 * i) / 12;
    ctx.beginPath();
    ctx.moveTo(WIDTH / 2, LIGHT_Y);
    ctx.arc(WIDTH / 2, LIGHT_Y, 900, angle, angle + Math.PI / 24);
    ctx.closePath();
    ctx.fill();
  }
  // きらきら（見出しから決まる並びにして、同じ内容なら同じ画像になるようにする）
  const random = seededRandom(data.title + data.subtitle);
  for (let i = 0; i < 46; i++) {
    const x = random() * WIDTH;
    const y = random() * (HEIGHT - 160);
    const size = 2 + random() * 5;
    const alpha = 0.25 + random() * 0.55;
    // 見出しの文字には重ねない
    if (y < 135 && Math.abs(x - WIDTH / 2) < 340) continue;
    ctx.globalAlpha = alpha;
    drawSparkle(ctx, x, y, size, i % 3 === 0 ? '#ffffff' : theme.accent);
  }
  ctx.restore();
};

/** 4つの角を持つ星 */
const drawSparkle = (ctx: Context, x: number, y: number, size: number, color: string): void => {
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.moveTo(x, y - size * 2);
  ctx.quadraticCurveTo(x, y, x + size * 2, y);
  ctx.quadraticCurveTo(x, y, x, y + size * 2);
  ctx.quadraticCurveTo(x, y, x - size * 2, y);
  ctx.quadraticCurveTo(x, y, x, y - size * 2);
  ctx.fill();
};

/** 右上の札（XPアップ中など） */
const drawBadge = (ctx: Context, text: string, accent: string): void => {
  ctx.font = `bold 24px ${FONT_FAMILIES}`;
  const width = ctx.measureText(text).width + 40;
  const x = WIDTH - 36 - width;
  roundRect(ctx, x, 32, width, 46, 23);
  ctx.fillStyle = accent;
  ctx.fill();
  ctx.fillStyle = '#1b1d23';
  ctx.textAlign = 'center';
  ctx.fillText(text, x + width / 2, 64);
};

/** 名前の文字の下端（台の上に XP、その上に名前） */
const nameBaseline = (slot: (typeof SLOTS)[number]): number => HEIGHT - slot.height - 20 - 44;

const drawSlot = (ctx: Context, slot: (typeof SLOTS)[number], entry: PodiumEntry | undefined, avatar: LoadedImage | null, accent: string): void => {
  const medal = MEDALS[slot.index] ?? MEDALS[2];
  const top = HEIGHT - slot.height;

  // 台（下の角は画像の外に出して、上だけ丸く見せる）
  roundRect(ctx, slot.x - BASE_WIDTH / 2, top, BASE_WIDTH, slot.height + 30, 22);
  const base = ctx.createLinearGradient(0, top, 0, HEIGHT);
  base.addColorStop(0, medal.base[0]);
  base.addColorStop(1, medal.base[1]);
  ctx.fillStyle = base;
  ctx.fill();
  ctx.fillStyle = 'rgba(255, 255, 255, 0.35)';
  ctx.fillRect(slot.x - BASE_WIDTH / 2 + 18, top + 8, BASE_WIDTH - 36, 4);
  ctx.textAlign = 'center';
  ctx.font = `bold ${slot.index === 0 ? 76 : 62}px ${FONT_FAMILIES}`;
  ctx.fillStyle = medal.text;
  ctx.fillText(String(slot.index + 1), slot.x, top + slot.height / 2 + (slot.index === 0 ? 30 : 24));

  // 台の上に、XP・名前・アイコンを下から積む
  const valueY = top - 20;
  const nameY = nameBaseline(slot);
  const radius = slot.size / 2;
  const cy = nameY - 50 - radius;

  // アイコンの輪（金・銀・銅）
  const ring = ctx.createLinearGradient(slot.x - radius, cy - radius, slot.x + radius, cy + radius);
  ring.addColorStop(0, medal.ring[0]);
  ring.addColorStop(0.5, medal.ring[1]);
  ring.addColorStop(1, medal.ring[2]);
  ctx.fillStyle = ring;
  ctx.beginPath();
  ctx.arc(slot.x, cy, radius + 9, 0, Math.PI * 2);
  ctx.fill();
  ctx.save();
  ctx.beginPath();
  ctx.arc(slot.x, cy, radius, 0, Math.PI * 2);
  ctx.clip();
  if (avatar && entry) {
    ctx.drawImage(avatar, slot.x - radius, cy - radius, slot.size, slot.size);
  } else {
    ctx.fillStyle = '#3a3f4b';
    ctx.fillRect(slot.x - radius, cy - radius, slot.size, slot.size);
    ctx.fillStyle = entry ? '#ffffff' : '#7d8492';
    ctx.font = `bold ${Math.round(slot.size * 0.42)}px ${FONT_FAMILIES}`;
    ctx.textBaseline = 'middle';
    ctx.fillText(entry ? ([...entry.name][0] ?? '?') : '?', slot.x, cy + 4);
    ctx.textBaseline = 'alphabetic';
  }
  ctx.restore();
  if (slot.index === 0) drawCrown(ctx, slot.x, cy - radius - 14);

  // 名前とXP（空いている台には何も書かない）
  if (!entry) return;
  ctx.textAlign = 'center';
  ctx.font = `bold ${slot.index === 0 ? 46 : 40}px ${FONT_FAMILIES}`;
  ctx.fillStyle = '#ffffff';
  ctx.fillText(fit(ctx, entry.name, NAME_WIDTH), slot.x, nameY);
  drawValue(ctx, entry, slot.x, valueY, accent);
};

/** XPと、その右に昨日からの変化（上がったら緑・下がったら赤・NEW は水色） */
const drawValue = (ctx: Context, entry: PodiumEntry, x: number, y: number, accent: string): void => {
  ctx.font = `bold 32px ${FONT_FAMILIES}`;
  const valueWidth = ctx.measureText(entry.value).width;
  ctx.font = `bold 26px ${FONT_FAMILIES}`;
  const changeWidth = entry.change ? ctx.measureText(entry.change).width + 12 : 0;
  const left = x - (valueWidth + changeWidth) / 2;
  ctx.textAlign = 'left';
  ctx.font = `bold 32px ${FONT_FAMILIES}`;
  ctx.fillStyle = accent;
  ctx.fillText(entry.value, left, y);
  if (!entry.change) return;
  ctx.font = `bold 26px ${FONT_FAMILIES}`;
  ctx.fillStyle = entry.change.startsWith('▲') ? '#57f287' : entry.change.startsWith('▼') ? '#ff6b6b' : '#5bc0eb';
  ctx.fillText(entry.change, left + valueWidth + 12, y);
};

/** 1位の王冠（下の中心が x, bottom） */
const drawCrown = (ctx: Context, x: number, bottom: number): void => {
  const width = 92;
  const height = 56;
  const left = x - width / 2;
  const top = bottom - height;
  const fill = ctx.createLinearGradient(0, top, 0, bottom);
  fill.addColorStop(0, '#fff2a6');
  fill.addColorStop(1, '#e0a800');
  ctx.fillStyle = fill;
  ctx.strokeStyle = '#8a6400';
  ctx.lineWidth = 3;
  ctx.beginPath();
  ctx.moveTo(left, bottom);
  ctx.lineTo(left - 4, top + 14);
  ctx.lineTo(left + width * 0.27, top + 32);
  ctx.lineTo(x, top);
  ctx.lineTo(left + width * 0.73, top + 32);
  ctx.lineTo(left + width + 4, top + 14);
  ctx.lineTo(left + width, bottom);
  ctx.closePath();
  ctx.fill();
  ctx.stroke();
  // 先の玉
  for (const [px, py] of [
    [left - 4, top + 14],
    [x, top],
    [left + width + 4, top + 14],
  ] as const) {
    ctx.fillStyle = '#fff6c4';
    ctx.beginPath();
    ctx.arc(px, py, 7, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
  }
  // 宝石
  ctx.fillStyle = '#e74c3c';
  ctx.beginPath();
  ctx.arc(x, bottom - 18, 8, 0, Math.PI * 2);
  ctx.fill();
};

/** 文字列から決まる乱数（同じ文字列なら同じ並び） */
const seededRandom = (seed: string): (() => number) => {
  let state = [...seed].reduce((hash, char) => (Math.imul(hash ^ (char.codePointAt(0) ?? 0), 16777619) >>> 0), 2166136261);
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 0x1_0000_0000;
  };
};
