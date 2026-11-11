// 画像（レベルカード・ランキングの表彰台）を描くための共通の部品。
// @napi-rs/canvas を読み込めない環境では loadCanvas が null を返し、呼び出し側は文字だけで表示する

/** 日本語と絵文字も描けるよう、入っていそうなフォントを順に並べる（Docker では Noto、Windows では游ゴシック・Segoe） */
export const FONT_FAMILIES = '"Noto Sans CJK JP", "Noto Sans JP", "Yu Gothic", "Meiryo", "Noto Color Emoji", "Segoe UI Emoji", sans-serif';
const AVATAR_TIMEOUT_MS = 3_000;
/** 読み込んだアイコンを覚えておく数（掲示板は5分ごとに描き直すので、毎回取りに行かないように。アイコンを変えるとURLも変わる） */
const AVATAR_CACHE_SIZE = 200;

export type CanvasModule = typeof import('@napi-rs/canvas');
export type Context = ReturnType<ReturnType<CanvasModule['createCanvas']>['getContext']>;
export type LoadedImage = Awaited<ReturnType<CanvasModule['loadImage']>>;

let canvasModule: Promise<CanvasModule | null> | undefined;
export const loadCanvas = (): Promise<CanvasModule | null> =>
  (canvasModule ??= import('@napi-rs/canvas').catch((error: unknown) => {
    console.error('画像を描くライブラリを読み込めませんでした（文字だけで表示します）:', error);
    return null;
  }));

const avatarCache = new Map<string, LoadedImage>();

/** アイコンを読み込む。読めなければ null（呼び出し側で頭文字の丸などにする） */
export const loadAvatar = async (canvas: CanvasModule, url: string): Promise<LoadedImage | null> => {
  const cached = avatarCache.get(url);
  if (cached) {
    // 最近使ったものを後ろに回す（あふれたら、長く使っていないものから捨てる）
    avatarCache.delete(url);
    avatarCache.set(url, cached);
    return cached;
  }
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(AVATAR_TIMEOUT_MS) });
    if (!response.ok) return null;
    const image = await canvas.loadImage(Buffer.from(await response.arrayBuffer()));
    avatarCache.set(url, image);
    const oldest = avatarCache.keys().next().value;
    if (avatarCache.size > AVATAR_CACHE_SIZE && oldest !== undefined) avatarCache.delete(oldest);
    return image;
  } catch {
    return null;
  }
};

/** 幅に収まらなければ、後ろを「…」にする */
export const fit = (ctx: Context, text: string, maxWidth: number): string => {
  if (ctx.measureText(text).width <= maxWidth) return text;
  const chars = [...text];
  while (chars.length > 1 && ctx.measureText(`${chars.join('')}…`).width > maxWidth) chars.pop();
  return `${chars.join('')}…`;
};

export const roundRect = (ctx: Context, x: number, y: number, width: number, height: number, radius: number): void => {
  ctx.beginPath();
  ctx.roundRect(x, y, width, height, radius);
};

/** 暗い背景で読みにくい暗い色は、白を混ぜて明るくする */
export const readableColor = (color: number): number => {
  const channels = [(color >> 16) & 0xff, (color >> 8) & 0xff, color & 0xff];
  const luminance = (0.2126 * (channels[0] ?? 0) + 0.7152 * (channels[1] ?? 0) + 0.0722 * (channels[2] ?? 0)) / 255;
  if (luminance >= 0.35) return color;
  const [r = 0, g = 0, b = 0] = channels.map((c) => Math.round(c + (255 - c) * 0.45));
  return (r << 16) | (g << 8) | b;
};

export const toCss = (color: number): string => `#${color.toString(16).padStart(6, '0')}`;
