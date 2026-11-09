import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  MessageFlags,
  PermissionFlagsBits,
  escapeMarkdown,
  type ButtonInteraction,
  type Client,
  type Guild,
  type GuildMember,
  type MessageCreateOptions,
  type Role,
  type TextChannel,
} from 'discord.js';
import { sendLog } from './activityLog.js';
import { NOTICE_CHANNEL_NAME } from './callNotice.js';
import { formatDuration } from './duration.js';
import { reportError } from './errorReporter.js';
import { canBotPost, findTextChannel } from './guildUtils.js';
import { fromJst, jstDay, toJst } from './jst.js';
import { claimMaintenanceNotice, hasMaintenanceNotices, releaseMaintenanceNotice, seedMaintenanceNotices } from './maintenanceStore.js';

// FF14公式（The Lodestone）のニュースのフィードから、メンテナンスと障害のお知らせを「通知」チャンネルに流す。
// 全ワールド・日本データセンターのもの（ゲームで遊べなくなるもの）は「メンテナンス情報」ロールにメンションし、
// そのメンテナンスは始まる1時間前にもう一度知らせる。
// customId は「maint:<操作>」

export const CUSTOM_ID_PREFIX = 'maint:';
/** 設定パネルの「🛠️ メンテ情報」 */
export const OPEN_BUTTON_ID = `${CUSTOM_ID_PREFIX}open`;
const ROLE_ON_ID = `${CUSTOM_ID_PREFIX}role-on`;
const ROLE_OFF_ID = `${CUSTOM_ID_PREFIX}role-off`;

/** お知らせでメンションされる人が、自分で付けるロール */
export const MAINTENANCE_ROLE_NAME = 'メンテナンス情報';

/** 公式のニュースのフィード（Atom。新しい20件） */
const FEED_URL = 'https://jp.finalfantasyxiv.com/lodestone/news/news.xml';
const USER_AGENT = 'new-server-bot (Discord bot for a FINAL FANTASY XIV community)';
const POLL_MS = 5 * 60_000;
const FETCH_TIMEOUT_MS = 20_000;
/** メンテナンスが始まる何分前にもう一度知らせるか */
const REMIND_BEFORE_MS = 60 * 60_000;
/** これより古い記事は流さない（Botが長く止まっていたときに、終わったお知らせを流さないため） */
const MAX_NEWS_AGE_MS = 24 * 60 * 60_000;
/** 読めないのがこの時間続いたら、「ログ」にエラーとして知らせる（一時的な失敗では知らせない） */
const REPORT_AFTER_FAILING_MS = 60 * 60_000;
/** 設定パネルの画面に出す、最近のお知らせの数 */
const RECENT_IN_SCREEN = 3;
const MAX_WHEN_LENGTH = 300;
const WEEKDAYS = ['日', '月', '火', '水', '木', '金', '土'];

/** 流す記事の種類（「お知らせ」は流さない） */
const CATEGORY_STYLES: Record<string, { emoji: string; color: number }> = {
  メンテナンス: { emoji: '🛠️', color: 0xe67e22 },
  障害情報: { emoji: '⚠️', color: 0xed4245 },
};

/** 作業の日時。approx は「頃」（予定・見込み） */
export interface Period {
  start: Date;
  startApprox: boolean;
  end: Date | null;
  endApprox: boolean;
}

export interface NewsEntry {
  id: string;
  title: string;
  url: string;
  /** メンテナンス / 障害情報 / お知らせ */
  category: string;
  published: Date;
  /** 本文の「日時」の欄（なければ null） */
  when: string | null;
  /** 「日時」の欄から読んだ日時（読めなければ null） */
  period: Period | null;
}

// ---- フィードを読む（Discordに触らないところ）

const ENTITIES: Record<string, string> = { lt: '<', gt: '>', amp: '&', quot: '"', apos: "'", nbsp: ' ' };

/** &lt; や &#12354; を文字に戻す（1段だけ） */
const decodeEntities = (text: string): string =>
  text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (entity, code: string) => {
    const lower = code.toLowerCase();
    if (lower.startsWith('#x')) return String.fromCodePoint(Number.parseInt(lower.slice(2), 16));
    if (lower.startsWith('#')) return String.fromCodePoint(Number(lower.slice(1)));
    return ENTITIES[lower] ?? entity;
  });

/** 本文のHTMLを、改行を残した文にする */
const htmlToText = (html: string): string =>
  decodeEntities(
    html
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<\/(?:p|div|li|h\d)>/gi, '\n')
      .replace(/<[^>]+>/g, ''),
  );

/** 本文の「日　時：」の欄（最初のもの）。次の項目（対象・内容など）や注意書き（※）の前まで。なければ null */
export const whenText = (text: string): string | null => {
  const lines = text.normalize('NFKC').split('\n');
  const startIndex = lines.findIndex((line) => /^\s*日\s*時\s*:/.test(line));
  const first = lines[startIndex];
  if (first === undefined) return null;
  const parts = [first.replace(/^\s*日\s*時\s*:\s*/, '')];
  for (const line of lines.slice(startIndex + 1, startIndex + 6)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    // 次の項目（「対 象:」「障害内容:」など）や注意書きで終わり。「19:00頃まで」は数字から始まるので項目ではない
    if (/^(?:※|[^\s:\d]{1,6}(?:\s[^\s:\d]{1,6})?\s*:)/.test(trimmed)) break;
    parts.push(trimmed);
  }
  const joined = parts.join(' ').replace(/\s+/g, ' ').trim();
  return joined ? joined.slice(0, MAX_WHEN_LENGTH) : null;
};

const DATE_TIME = String.raw`(\d{4})年(\d{1,2})月(\d{1,2})日(?:\s*\([^)]*\))?\s*(\d{1,2}):(\d{2})(頃)?`;

/**
 * 「2026年11月9日(月) 19:00より 2026年11月10日(火) 19:00頃まで」「2026年11月2日(月) 16:00より17:00頃まで」
 * 「2026年11月9日(月) 13:57頃より」（終わりが決まっていない）を読む。読めなければ null
 */
export const parsePeriod = (when: string): Period | null => {
  const start = new RegExp(`${DATE_TIME}\\s*より`).exec(when.normalize('NFKC'));
  if (!start) return null;
  const [, year = '', month = '', day = '', hour = '', minute = '', startApprox] = start;
  const startDate = fromJst(Number(year), Number(month), Number(day), Number(hour), Number(minute));
  const rest = when.normalize('NFKC').slice(start.index + start[0].length);
  const endFull = new RegExp(`^\\s*${DATE_TIME}\\s*まで`).exec(rest);
  const endTime = /^\s*(\d{1,2}):(\d{2})(頃)?\s*まで/.exec(rest);
  let end: Date | null = null;
  let endApprox = false;
  if (endFull) {
    const [, y = '', mo = '', d = '', h = '', mi = '', approx] = endFull;
    end = fromJst(Number(y), Number(mo), Number(d), Number(h), Number(mi));
    endApprox = !!approx;
  } else if (endTime) {
    const [, h = '', mi = '', approx] = endTime;
    end = fromJst(Number(year), Number(month), Number(day), Number(h), Number(mi));
    // 「22:00より5:00まで」のように日をまたぐときは、次の日
    if (end <= startDate) end = new Date(end.getTime() + 24 * 60 * 60_000);
    endApprox = !!approx;
  }
  return { start: startDate, startApprox: !!startApprox, end, endApprox };
};

/** フィード（Atom）から記事を読む。形が合わない記事は飛ばす */
export const parseFeed = (xml: string): NewsEntry[] =>
  [...xml.matchAll(/<entry>([\s\S]*?)<\/entry>/g)].flatMap(([, body = '']): NewsEntry[] => {
    const pick = (pattern: RegExp): string | undefined => pattern.exec(body)?.[1];
    const id = pick(/<id>([^<]+)<\/id>/);
    const title = pick(/<title[^>]*>([\s\S]*?)<\/title>/);
    const url = pick(/<link\b[^>]*\brel="alternate"[^>]*\bhref="([^"]+)"/) ?? pick(/<link\b[^>]*\bhref="([^"]+)"[^>]*\brel="alternate"/);
    const published = pick(/<published>([^<]+)<\/published>/);
    if (!id || !title || !url || !published || Number.isNaN(Date.parse(published))) return [];
    const content = pick(/<content\b[^>]*>([\s\S]*?)<\/content>/) ?? '';
    const cdata = /^\s*<!\[CDATA\[([\s\S]*)\]\]>\s*$/.exec(content)?.[1];
    const when = whenText(htmlToText(cdata ?? decodeEntities(content)));
    return [
      {
        id: decodeEntities(id).trim(),
        title: decodeEntities(title).trim(),
        url: decodeEntities(url),
        category: decodeEntities(pick(/<category\b[^>]*\bterm="([^"]+)"/) ?? ''),
        published: new Date(published),
        when,
        period: when ? parsePeriod(when) : null,
      },
    ];
  });

/** 流す種類（メンテナンス・障害情報）か */
export const isWatched = (entry: NewsEntry): boolean => entry.category in CATEGORY_STYLES;

/** 全ワールド・日本データセンターのもの（ゲームで遊べなくなるもの）で、終了・続報ではないもの。メンションするのはこれだけ */
export const isMajor = (entry: NewsEntry): boolean =>
  isWatched(entry) && /全ワールド|日本データセンター/.test(entry.title) && !/終了|完了|復旧|続報/.test(entry.title);

/** 始まる前にもう一度知らせるときか（大きなメンテナンスの、始まる1時間前から始まるまで） */
export const isReminderDue = (entry: NewsEntry, now: Date): boolean => {
  const start = entry.period?.start.getTime();
  return entry.category === 'メンテナンス' && isMajor(entry) && start !== undefined && start - REMIND_BEFORE_MS <= now.getTime() && now.getTime() < start;
};

const formatPoint = (date: Date, approx: boolean, withDay: boolean): string => {
  const { month, day, hour, minute, weekday } = toJst(date);
  return `${withDay ? `${month}/${day}(${WEEKDAYS[weekday]}) ` : ''}${hour}:${String(minute).padStart(2, '0')}${approx ? '頃' : ''}`;
};

/** 「11/9(月) 19:00 〜 11/10(火) 19:00頃」「11/2(月) 16:00 〜 17:00頃」「11/9(月) 13:57頃 〜」 */
export const formatPeriod = (period: Period): string => {
  const sameDay = period.end !== null && jstDay(period.start) === jstDay(period.end);
  const end = period.end ? formatPoint(period.end, period.endApprox, !sameDay) : '';
  return `${formatPoint(period.start, period.startApprox, true)} 〜 ${end}`.trim();
};

const describeWhen = (entry: NewsEntry): string | null => (entry.period ? formatPeriod(entry.period) : entry.when);

// ---- 「メンテナンス情報」ロール

export const findMaintenanceRole = (guild: Guild): Role | undefined => guild.roles.cache.find((role) => role.name === MAINTENANCE_ROLE_NAME);

/**
 * 「メンテナンス情報」ロールがなければ作る。作ったときはそのロールを返す。
 * メンバー同士で鳴らし合わないよう、誰でもメンションできる設定にはしない（お知らせは Bot がメンションする）
 */
export const ensureMaintenanceRole = async (guild: Guild): Promise<Role | null> => {
  if (findMaintenanceRole(guild)) return null;
  const me = guild.members.me ?? (await guild.members.fetchMe());
  if (!me.permissions.has(PermissionFlagsBits.ManageRoles)) {
    console.warn(`「${guild.name}」: Botにロールの管理権限がないため、「${MAINTENANCE_ROLE_NAME}」ロールを作れません`);
    return null;
  }
  const role = await guild.roles.create({ name: MAINTENANCE_ROLE_NAME, permissions: [], mentionable: false, reason: 'メンテナンス・障害のお知らせを受け取る人のロール' });
  console.log(`「${guild.name}」に「${MAINTENANCE_ROLE_NAME}」ロールを作りました`);
  return role;
};

// ---- お知らせ

const newsMessage = (entry: NewsEntry, role: Role | undefined): MessageCreateOptions => {
  const style = CATEGORY_STYLES[entry.category] ?? { emoji: '📰', color: 0x99aab5 };
  const when = describeWhen(entry);
  return {
    ...(role ? { content: `${role}` } : {}),
    embeds: [
      new EmbedBuilder()
        .setColor(style.color)
        .setAuthor({ name: `${style.emoji} ${entry.category}（FF14公式）` })
        .setTitle(entry.title.slice(0, 256))
        .setURL(entry.url)
        .setDescription(when ? `🕒 ${when}` : null)
        .setFooter({ text: 'The Lodestone' })
        .setTimestamp(entry.published),
    ],
    allowedMentions: { parse: [], roles: role ? [role.id] : [] },
    // メンションしないもの（大きくないもの・終了・続報）は、通知を鳴らさない
    ...(role ? {} : { flags: MessageFlags.SuppressNotifications }),
  };
};

const reminderMessage = (entry: NewsEntry, role: Role | undefined, now: Date): MessageCreateOptions => {
  const start = entry.period?.start ?? now;
  return {
    ...(role ? { content: `${role}` } : {}),
    embeds: [
      new EmbedBuilder()
        .setColor(0xe67e22)
        .setTitle(`⏰ あと${formatDuration(start.getTime() - now.getTime())}でメンテナンスが始まります`)
        .setDescription([`[${escapeMarkdown(entry.title)}](${entry.url})`, ...(entry.period ? [`🕒 ${formatPeriod(entry.period)}`] : [])].join('\n'))
        .setFooter({ text: 'The Lodestone' }),
    ],
    allowedMentions: { parse: [], roles: role ? [role.id] : [] },
  };
};

/** 流して、ログに残す。流せなかったら、次にまた流せるよう戻す */
const post = async (
  guild: Guild,
  channel: TextChannel,
  entry: NewsEntry,
  kind: 'news' | 'reminder',
  payload: MessageCreateOptions,
  mentioned: Role | undefined,
): Promise<void> => {
  const message = await channel.send(payload).catch(async (error: unknown) => {
    await releaseMaintenanceNotice(guild.id, entry.id, kind);
    throw error;
  });
  void sendLog(guild, 'maintenance', `${kind === 'news' ? '' : '始まる前のお知らせ: '}「${entry.title}」を「${NOTICE_CHANNEL_NAME}」に流しました`, undefined, {
    title: 'メンテナンス・障害のお知らせ',
    fields: [{ name: '🔔 メンション', value: mentioned ? `「${MAINTENANCE_ROLE_NAME}」ロール（${mentioned.members.size}人）` : 'なし', inline: true }],
    links: [
      { label: 'お知らせへ移動', url: message.url },
      { label: '公式の記事', url: entry.url },
    ],
  });
};

/** そのサーバーで、まだ流していないお知らせを流す */
export const sendMaintenanceNotices = async (guild: Guild, entries: NewsEntry[], now: Date = new Date()): Promise<void> => {
  const watched = entries.filter(isWatched).sort((a, b) => a.published.getTime() - b.published.getTime());
  // 初めて読んだときは、今ある記事を流さずに既読にする（過去の記事をまとめて流さないため。始まる前のお知らせは出す）
  if (!(await hasMaintenanceNotices(guild.id))) await seedMaintenanceNotices(guild.id, watched.map((entry) => entry.id));

  const channel = findTextChannel(guild, NOTICE_CHANNEL_NAME);
  if (!channel || !canBotPost(channel)) return;
  const role = findMaintenanceRole(guild);

  for (const entry of watched) {
    if (now.getTime() - entry.published.getTime() > MAX_NEWS_AGE_MS) continue;
    if (!(await claimMaintenanceNotice(guild.id, entry.id, 'news'))) continue;
    const mentioned = isMajor(entry) ? role : undefined;
    await post(guild, channel, entry, 'news', newsMessage(entry, mentioned), mentioned);
  }
  for (const entry of watched) {
    if (!isReminderDue(entry, now) || !(await claimMaintenanceNotice(guild.id, entry.id, 'reminder'))) continue;
    await post(guild, channel, entry, 'reminder', reminderMessage(entry, role, now), role);
  }
};

/** 最後に読めた記事（設定パネルの画面に出す） */
let latestEntries: NewsEntry[] = [];
/** 読めなくなった時刻（読めていれば null） */
let failingSince: number | null = null;

const fetchFeed = async (): Promise<NewsEntry[]> => {
  const response = await fetch(FEED_URL, { headers: { 'User-Agent': USER_AGENT }, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  if (!response.ok) throw new Error(`公式のニュースを読めませんでした（HTTP ${response.status}）`);
  const entries = parseFeed(await response.text());
  if (entries.length === 0) throw new Error('公式のニュースが1件も読めません（フィードの形が変わったかもしれません）');
  return entries;
};

const poll = async (client: Client<true>): Promise<void> => {
  let entries: NewsEntry[];
  try {
    entries = await fetchFeed();
    failingSince = null;
  } catch (error) {
    const now = Date.now();
    failingSince ??= now;
    console.warn('公式のニュースを読めませんでした（次の回にまた読みます）:', error);
    if (now - failingSince >= REPORT_AFTER_FAILING_MS) reportError('公式のニュース（メンテナンス・障害のお知らせ）を1時間以上読めていません', error);
    return;
  }
  latestEntries = entries;
  for (const guild of client.guilds.cache.values()) {
    await sendMaintenanceNotices(guild, entries).catch((error: unknown) => {
      reportError(`「${guild.name}」のメンテナンス・障害のお知らせに失敗しました`, error, guild);
    });
  }
};

/** 起動時と、そのあと5分ごとに公式のニュースを読む */
export const startMaintenanceNotices = (client: Client<true>): void => {
  const run = () => {
    void poll(client);
  };
  run();
  setInterval(run, POLL_MS).unref();
};

// ---- メンバーの画面（設定パネルの「🛠️ メンテ情報」）

/** 文の中のリンクの文字（[] があると崩れるので、全角にする） */
const linkText = (text: string): string => escapeMarkdown(text.replace(/\[/g, '［').replace(/\]/g, '］'));

export const memberScreen = (member: GuildMember, note?: string) => {
  const role = findMaintenanceRole(member.guild);
  const on = !!role && member.roles.cache.has(role.id);
  const recent = latestEntries.filter(isWatched).slice(0, RECENT_IN_SCREEN);
  const toggle = (value: boolean): ButtonBuilder =>
    new ButtonBuilder()
      .setCustomId(value ? ROLE_ON_ID : ROLE_OFF_ID)
      .setLabel(value ? '受け取る' : '受け取らない')
      .setEmoji({ name: value ? '🔔' : '🔕' })
      .setStyle(on === value ? ButtonStyle.Primary : ButtonStyle.Secondary)
      .setDisabled(!role);
  return {
    content: [
      ...(note ? [note, ''] : []),
      '🛠️ **メンテナンス・障害のお知らせ**',
      `FF14公式（The Lodestone）のメンテナンスと障害の情報を「${NOTICE_CHANNEL_NAME}」チャンネルに流します。`,
      role
        ? `受け取ると「${MAINTENANCE_ROLE_NAME}」ロールが付き、全ワールド・日本データセンターのものでメンションが届きます。全ワールドのメンテナンスは、始まる1時間前にもう一度知らせます（青いボタンが今の設定）。`
        : `「${MAINTENANCE_ROLE_NAME}」ロールがないため、今はメンションの受け取りを切り替えられません（Botの再起動時に作られます）。`,
      '',
      '📰 **最近のお知らせ**',
      ...(recent.length > 0
        ? recent.map((entry) => {
            const when = describeWhen(entry);
            return `${CATEGORY_STYLES[entry.category]?.emoji ?? '📰'} [${linkText(entry.title)}](<${entry.url}>)${when ? `\n　🕒 ${when}` : ''}`;
          })
        : ['まだ読めていません（少し待ってから開き直してください）。']),
    ].join('\n'),
    components: [new ActionRowBuilder<ButtonBuilder>().addComponents(toggle(true), toggle(false))],
    allowedMentions: { parse: [] },
  };
};

export const handleButton = async (interaction: ButtonInteraction<'cached'>): Promise<void> => {
  const { guild, member, customId } = interaction;
  if (customId === OPEN_BUTTON_ID) {
    // 本人にだけ見える画面からなら切り替え、パネルからなら新しく出す
    if (interaction.message.flags.has(MessageFlags.Ephemeral)) {
      await interaction.update(memberScreen(member));
    } else {
      await interaction.reply({ ...memberScreen(member), flags: MessageFlags.Ephemeral });
    }
    return;
  }
  if (customId !== ROLE_ON_ID && customId !== ROLE_OFF_ID) return;
  await interaction.deferUpdate();
  const role = findMaintenanceRole(guild);
  const on = customId === ROLE_ON_ID;
  if (!role || member.roles.cache.has(role.id) === on) {
    await interaction.editReply(memberScreen(member, '変更はありませんでした。'));
    return;
  }
  const updated = on ? await member.roles.add(role, 'メンテナンス・障害のお知らせの設定') : await member.roles.remove(role, 'メンテナンス・障害のお知らせの設定');
  void sendLog(guild, 'maintenance', `${member} が「${MAINTENANCE_ROLE_NAME}」を${on ? '付けました' : '外しました'}`, member, {
    title: 'メンテナンス・障害のお知らせの設定',
  });
  await interaction.editReply(memberScreen(updated, on ? `🔔 「${MAINTENANCE_ROLE_NAME}」ロールを付けました。` : `🔕 「${MAINTENANCE_ROLE_NAME}」ロールを外しました。`));
};
