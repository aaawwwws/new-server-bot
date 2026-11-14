import { createHash } from 'node:crypto';
import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  DiscordAPIError,
  EmbedBuilder,
  LabelBuilder,
  MessageFlags,
  ModalBuilder,
  RESTJSONErrorCodes,
  StringSelectMenuBuilder,
  TextInputBuilder,
  TextInputStyle,
  escapeMarkdown,
  type ButtonInteraction,
  type Client,
  type Guild,
  type GuildMember,
  type MessageActionRowComponentBuilder,
  type ModalSubmitInteraction,
  type StringSelectMenuInteraction,
} from 'discord.js';
import { sendLog } from './activityLog.js';
import { DUTIES, type DutyCategory } from './duties.js';
import { reportError } from './errorReporter.js';
import { fetchAllMembers } from './guildUtils.js';
import { INACTIVE_ROLE_NAME, findInactiveRole } from './inactiveRole.js';
import { createLock } from './locks.js';
import { ensureAdmin } from './permissions.js';
import {
  addWantItem,
  addWantPanel,
  clearMemberWants,
  deleteWantItem,
  forgetWantPanel,
  listMemberWants,
  listWantItems,
  listWantPanels,
  listWantVotes,
  replaceMemberWants,
  resetWantVotes,
  seedWantItems,
  type WantItem,
  type WantMode,
  type WantPick,
} from './wantStore.js';

// やりたいコンテンツ。メンバーが今やりたいものをいくつでも選び、パネルに人数の多い順で並べる（誰が選んだかも出す）。
// 選べるのは、ゲームの全コンテンツ（src/duties.ts。零式・絶・討滅戦・ダンジョンなど）と、管理者が足す「そのほか」（地図・ギャザクラなど）。
// 選ぶときは「カテゴリー → 拡張 → コンテンツ」の順に絞り込む（Discordの選択メニューは1つ25件までなので）。
// サーバーを抜けた人と「非アクティブ」の人は数えない（昔の選択で順位がずれないように）。
// customId は「want:<操作>:<値>…」

export const CUSTOM_ID_PREFIX = 'want:';
/** パネルの「✋ やりたいものを選ぶ」と、設定パネルの「🎮 やりたいコンテンツ」（選ぶ画面の一番上に戻るときも） */
export const PICK_ID = `${CUSTOM_ID_PREFIX}pick`;
/** カテゴリーの選択 */
const CATEGORY_ID = `${CUSTOM_ID_PREFIX}cat`;
/** 拡張の選択（want:ex:<カテゴリー>） */
const EXPANSION_PREFIX = `${CUSTOM_ID_PREFIX}ex:`;
/** コンテンツの選択（want:sel:<カテゴリー>:<拡張 か ->:<ページ>:<n（通常）か u（制限解除）>） */
const SELECT_PREFIX = `${CUSTOM_ID_PREFIX}sel:`;
/** ページの切り替え（want:page:<カテゴリー>:<拡張 か ->:<ページ>） */
const PAGE_PREFIX = `${CUSTOM_ID_PREFIX}page:`;
/** 拡張の選択に戻る（want:back:<カテゴリー>） */
const BACK_PREFIX = `${CUSTOM_ID_PREFIX}back:`;
const CLEAR_ID = `${CUSTOM_ID_PREFIX}clear`;
/** パネルの「👀 誰が選んだか見る」と、その画面のコンテンツの選択 */
const WHO_ID = `${CUSTOM_ID_PREFIX}who`;
const WHO_SELECT_ID = `${CUSTOM_ID_PREFIX}whosel`;
/** 管理パネルの「🎮 やりたいコンテンツ」 */
export const ADMIN_BUTTON_ID = `${CUSTOM_ID_PREFIX}admin`;
const ADD_ID = `${CUSTOM_ID_PREFIX}add`;
const ADD_MODAL_ID = `${CUSTOM_ID_PREFIX}add-submit`;
const REMOVE_SELECT_ID = `${CUSTOM_ID_PREFIX}remove`;
const RESET_ID = `${CUSTOM_ID_PREFIX}reset`;
const RESET_CONFIRM_ID = `${CUSTOM_ID_PREFIX}reset-confirm`;
const NAME_INPUT_ID = 'name';
const EMOJI_INPUT_ID = 'emoji';
/** 拡張で分けないカテゴリーの、customId の拡張のところ */
const NO_EXPANSION = '-';

/** 「そのほか」に入れられる数（選択メニューに並べられる数） */
export const MAX_ITEMS = 25;
/** 選択メニュー1つに並べられる数（Discordの上限） */
const PAGE_SIZE = 25;
const MAX_NAME_LENGTH = 30;
/** パネルに出す、カテゴリーごとのコンテンツの数（人数の多い順。残りは件数でまとめる。長くなりすぎたら減らす） */
const PER_CATEGORY = 5;
/** 「誰が選んだか見る」で並べるコンテンツの数（選択メニューの上限） */
const WHO_OPTIONS = 25;
/** 「誰が選んだか見る」で名前を出す人数 */
const MAX_WHO_NAMES = 80;
/** 本文の長さの上限（Discordは4096文字。少し余裕を持たせる） */
const MAX_DESCRIPTION_LENGTH = 4000;
/** 選ぶ画面の上に出す、今の選択の数 */
const MAX_LISTED_PICKS = 15;
const COLOR = 0x9b59b6;
/** 抜けた人・非アクティブになった人を反映するため、この間隔でパネルを作り直す（変わったときだけ編集する） */
const REFRESH_MS = 60 * 60_000;

type CategoryKey = DutyCategory | 'other';

/** 選ぶ画面に出す順のカテゴリー。byExpansion なら、次に拡張を選ぶ */
const CATEGORIES: readonly { key: CategoryKey; label: string; emoji: string; byExpansion: boolean }[] = [
  { key: 'savage', label: '零式', emoji: '⚔️', byExpansion: true },
  { key: 'ultimate', label: '絶', emoji: '🔥', byExpansion: false },
  { key: 'extreme', label: '極・幻討滅戦', emoji: '🐉', byExpansion: true },
  { key: 'raid', label: 'ノーマルレイド', emoji: '🏛️', byExpansion: true },
  { key: 'alliance', label: 'アライアンスレイド', emoji: '🏰', byExpansion: false },
  { key: 'trial', label: '討伐・討滅戦', emoji: '👹', byExpansion: true },
  { key: 'dungeon', label: 'ダンジョン', emoji: '🗝️', byExpansion: true },
  { key: 'deep', label: 'ディープダンジョン', emoji: '🕳️', byExpansion: true },
  { key: 'variant', label: 'ヴァリアント・アナザー', emoji: '🧩', byExpansion: false },
  { key: 'field', label: '特殊フィールド', emoji: '🧭', byExpansion: false },
  { key: 'treasure', label: '宝物庫', emoji: '💎', byExpansion: false },
  { key: 'pvp', label: 'PvP', emoji: '🛡️', byExpansion: false },
  { key: 'other', label: 'そのほか', emoji: '✨', byExpansion: false },
];
const EXPANSIONS = ['新生エオルゼア', '蒼天のイシュガルド', '紅蓮のリベレーター', '漆黒のヴィランズ', '暁月のフィナーレ', '黄金のレガシー'];

/** 制限解除で行ける種類（ディープダンジョン・特殊フィールド・宝物庫・PvPなどは、もともと制限解除がない） */
const UNSYNCABLE: ReadonlySet<CategoryKey> = new Set<CategoryKey>(['savage', 'ultimate', 'extreme', 'raid', 'alliance', 'trial', 'dungeon']);
/** 最新の拡張（一覧で一番新しい拡張）。ここのコンテンツは制限解除できない。次の拡張が出て一覧を作り直せば、自動で次に移る */
export const LATEST_EXPANSION = Math.max(...DUTIES.map((duty) => duty.expansion));
/** customId の、やり方の印 */
const MODE_CODES: Record<WantMode, string> = { normal: 'n', unsynced: 'u' };
/** 🔓 は制限解除でもいい人 */
const UNSYNCED_MARK = '🔓';

/** パネルを初めて置いたときに入れておく「そのほか」（ゲームのコンテンツにないもの。管理者があとで足し引きできる） */
export const DEFAULT_ITEMS = [
  { name: '地図', emoji: '🗺️' },
  { name: 'モブハント', emoji: '🎯' },
  { name: 'F.A.T.E.', emoji: '⚡' },
  { name: 'ギャザクラ', emoji: '⛏️' },
  { name: 'オーシャンフィッシング', emoji: '🎣' },
  { name: '金策', emoji: '💰' },
  { name: 'ハウジング', emoji: '🏠' },
  { name: 'ミラプリ', emoji: '👗' },
  { name: 'レベル上げ', emoji: '📈' },
  { name: 'メインクエスト', emoji: '📖' },
] as const;

/** 選べるもの1つ（ゲームのコンテンツか、そのほか） */
interface WantOption {
  /** 選んだものの記録に使うキー（「d<ID>」「c<ID>」） */
  key: string;
  name: string;
  emoji: string;
  category: CategoryKey;
  /** 拡張（そのほかは null） */
  expansion: number | null;
  /** 並び順（ゲームの順、そのほかは最後） */
  order: number;
}

const categoryInfo = (key: string) => CATEGORIES.find((category) => category.key === key);

const DUTY_OPTIONS: readonly WantOption[] = DUTIES.map((duty, index) => ({
  key: `d${duty.id}`,
  name: duty.name,
  emoji: categoryInfo(duty.category)?.emoji ?? '🎮',
  category: duty.category,
  expansion: duty.expansion,
  order: index,
}));

/** そのサーバーで選べるもの全部 */
const loadOptions = async (guildId: string): Promise<WantOption[]> => [
  ...DUTY_OPTIONS,
  ...(await listWantItems(guildId)).map((item, index) => ({
    key: `c${item.id}`,
    name: item.name,
    emoji: item.emoji ?? '✨',
    category: 'other' as const,
    expansion: null,
    order: DUTY_OPTIONS.length + index,
  })),
];

const optionLabel = (option: WantOption): string => `${option.emoji} ${option.name}`;

/** カテゴリー（と拡張）で絞ったもの */
const groupOptions = (options: WantOption[], category: CategoryKey, expansion: number | null): WantOption[] =>
  options.filter((option) => option.category === category && (expansion === null || option.expansion === expansion));

/** 制限解除でも選べるか（制限解除がある種類で、最新の拡張より前のもの） */
export const canUnsync = (option: Pick<WantOption, 'category' | 'expansion'>): boolean =>
  UNSYNCABLE.has(option.category) && option.expansion !== null && option.expansion < LATEST_EXPANSION;

/** 選んだやり方の書き方（通常だけなら何も付けない） */
const modeTag = (modes: ReadonlySet<WantMode>): string => {
  if (!modes.has('unsynced')) return '';
  return modes.has('normal') ? '（どちらでも）' : '（制限解除）';
};

/** その人の選択を、もの（キー）ごとのやり方にまとめる */
const picksByKey = (mine: WantPick[]): Map<string, Set<WantMode>> => {
  const map = new Map<string, Set<WantMode>>();
  for (const pick of mine) map.set(pick.key, new Set([...(map.get(pick.key) ?? []), pick.mode]));
  return map;
};

// ---- パネル

/** 選んだ人1人（そのものを、どのやり方で選んだか） */
interface Voter {
  member: GuildMember;
  normal: boolean;
  unsynced: boolean;
}

interface Tally {
  option: WantOption;
  voters: Voter[];
}

/** 選ばれているものごとの、数える人（選んだ順）。人数の多い順（同じなら一覧の順）。0人のものは入れない */
const tally = async (guild: Guild): Promise<Tally[]> => {
  const [options, votes, members] = await Promise.all([loadOptions(guild.id), listWantVotes(guild.id), fetchAllMembers(guild)]);
  const inactive = findInactiveRole(guild);
  const counted = (member: GuildMember): boolean => !member.user.bot && !(inactive && member.roles.cache.has(inactive.id));
  return options
    .map((option) => {
      const voters = new Map<string, Voter>();
      for (const vote of votes.get(option.key) ?? []) {
        const member = members.get(vote.userId);
        if (!member || !counted(member)) continue;
        const voter = voters.get(member.id) ?? { member, normal: false, unsynced: false };
        voter[vote.mode] = true;
        voters.set(member.id, voter);
      }
      return { option, voters: [...voters.values()] };
    })
    .filter((entry) => entry.voters.length > 0)
    .sort((a, b) => b.voters.length - a.voters.length || a.option.order - b.option.order);
};

/** 制限解除でもいい人の数 */
const unsyncedCount = (entry: Tally): number => entry.voters.filter((voter) => voter.unsynced).length;

/** パネルに出す名前（そのほかは、管理者が付けた絵文字も。ゲームのコンテンツはカテゴリーの見出しに絵文字がある） */
const panelName = (option: WantOption): string => (option.category === 'other' ? optionLabel(option) : option.name);

/** パネルの1行「4人　希望の園エデン零式：覚醒編1　🔓2」 */
const itemLine = (entry: Tally): string => {
  const unsynced = unsyncedCount(entry);
  return `　**${entry.voters.length}人**　${escapeMarkdown(panelName(entry.option))}${unsynced > 0 ? `　${UNSYNCED_MARK}${unsynced}` : ''}`;
};

/** パネルの中身（設置するときと、選ばれたとき・1時間ごとに作り直すときで共通）。カテゴリーごとに、人数の多い順 */
export const buildWantPanel = async (guild: Guild) => {
  const tallies = await tally(guild);
  const people = new Set(tallies.flatMap((entry) => entry.voters.map((voter) => voter.member.id))).size;
  const sections = CATEGORIES.map((category) => ({ category, entries: tallies.filter((entry) => entry.option.category === category.key) })).filter(
    (section) => section.entries.length > 0,
  );
  const describe = (perCategory: number): string =>
    [
      '「✋ やりたいものを選ぶ」で、今やりたいコンテンツを選べます（いくつでも）。「👀 誰が選んだか見る」で、選んだ人の名前を見られます。',
      `${UNSYNCED_MARK} は制限解除でもいい人の数です（最新の拡張「${EXPANSIONS[LATEST_EXPANSION] ?? ''}」は制限解除できません）。`,
      ...(sections.length > 0
        ? sections.flatMap(({ category, entries }) => [
            '',
            `${category.emoji} **${category.label}**`,
            ...entries.slice(0, perCategory).map(itemLine),
            ...(entries.length > perCategory ? [`　…ほか${entries.length - perCategory}件`] : []),
          ])
        : ['', 'まだ誰も選んでいません。']),
    ].join('\n');
  // 選ぶ人が増えて長くなりすぎたら、カテゴリーごとの件数を減らして収める（それでも長ければ後ろを切る）
  const description =
    [PER_CATEGORY, 3, 1].map(describe).find((text) => text.length <= MAX_DESCRIPTION_LENGTH) ?? `${describe(1).slice(0, MAX_DESCRIPTION_LENGTH - 1)}…`;
  const embed = new EmbedBuilder()
    .setColor(COLOR)
    .setTitle(`🎮 みんなのやりたいコンテンツ（${people}人）`)
    .setDescription(description)
    .setFooter({ text: `サーバーにいない人と「${INACTIVE_ROLE_NAME}」の人は数えません` });
  return {
    embeds: [embed],
    components: [
      new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder().setCustomId(PICK_ID).setLabel('やりたいものを選ぶ').setEmoji({ name: '✋' }).setStyle(ButtonStyle.Primary),
        new ButtonBuilder().setCustomId(WHO_ID).setLabel('誰が選んだか見る').setEmoji({ name: '👀' }).setStyle(ButtonStyle.Secondary),
      ),
    ],
  };
};

/** 「👀 誰が選んだか見る」の画面（本人にだけ見える）。selectedKey を選ぶと、選んだ人の名前を出す */
const whoScreen = async (guild: Guild, selectedKey?: string) => {
  const tallies = await tally(guild);
  if (tallies.length === 0) return { content: 'まだ誰も選んでいません。', components: [], allowedMentions: { parse: [] } };
  const top = tallies.slice(0, WHO_OPTIONS);
  const chosen = selectedKey ? tallies.find((entry) => entry.option.key === selectedKey) : undefined;
  const select = new StringSelectMenuBuilder()
    .setCustomId(WHO_SELECT_ID)
    .setPlaceholder('見たいコンテンツを選ぶ')
    .addOptions(
      top.map((entry) => {
        const unsynced = unsyncedCount(entry);
        return {
          label: entry.option.name.slice(0, 100),
          value: entry.option.key,
          description: `${entry.voters.length}人${unsynced > 0 ? `・制限解除でもいい人 ${unsynced}人` : ''}`,
          emoji: { name: entry.option.emoji },
          default: entry.option.key === chosen?.option.key,
        };
      }),
    );
  const details = chosen
    ? (() => {
        const names = chosen.voters
          .slice(0, MAX_WHO_NAMES)
          .map((voter) => `${escapeMarkdown(voter.member.displayName)}${voter.unsynced ? UNSYNCED_MARK : ''}`)
          .join('・');
        const more = chosen.voters.length > MAX_WHO_NAMES ? ` ほか${chosen.voters.length - MAX_WHO_NAMES}人` : '';
        const unsynced = unsyncedCount(chosen);
        return [
          `${chosen.option.emoji} **${escapeMarkdown(chosen.option.name)}**　${chosen.voters.length}人${unsynced > 0 ? `（${UNSYNCED_MARK} 制限解除でもいい人 ${unsynced}人）` : ''}`,
          `${names}${more}`,
          '',
          '同じものを選んだ人に声をかけたり、PT募集を立ててみましょう。',
        ];
      })()
    : [
        selectedKey ? 'それはもう誰も選んでいません。' : '見たいコンテンツを選んでください（人数の多い順）。',
        ...(tallies.length > WHO_OPTIONS ? [`選ばれているのは${tallies.length}件で、ここには上位${WHO_OPTIONS}件を並べています。`] : []),
      ];
  return {
    content: ['👀 **誰が選んだか見る**', ...details].join('\n'),
    components: [row(select)],
    allowedMentions: { parse: [] },
  };
};

/** パネルを設置する。「そのほか」の一覧が空なら、決まった一覧を入れてから */
export const placeWantPanel = async (guild: Guild, channelId: string, send: (payload: Awaited<ReturnType<typeof buildWantPanel>>) => Promise<{ id: string }>) => {
  const seeded = await seedWantItems(guild.id, DEFAULT_ITEMS);
  const payload = await buildWantPanel(guild);
  const message = await send(payload);
  await addWantPanel(guild.id, channelId, message.id);
  lastPanelHash.set(message.id, hashPayload(payload));
  return { message, seeded };
};

const panelLock = createLock();
/** パネルごとの前回の中身（変わったときだけ編集する） */
const lastPanelHash = new Map<string, string>();

const hashPayload = (payload: Awaited<ReturnType<typeof buildWantPanel>>): string =>
  createHash('sha256')
    .update(JSON.stringify({ embeds: payload.embeds.map((embed) => embed.toJSON()), components: payload.components.map((row) => row.toJSON()) }))
    .digest('hex');

/** そのサーバーのパネルを今の人数に書き換える。消されたパネルは、もう覚えておかない */
export const refreshWantPanels = async (guild: Guild): Promise<void> => {
  await panelLock(guild.id, async () => {
    const panels = await listWantPanels(guild.id);
    if (panels.length === 0) return;
    const payload = await buildWantPanel(guild);
    const hash = hashPayload(payload);
    for (const panel of panels) {
      if (lastPanelHash.get(panel.messageId) === hash) continue;
      const channel = guild.channels.cache.get(panel.channelId);
      if (!channel?.isTextBased()) {
        await forgetWantPanel(panel.messageId);
        continue;
      }
      try {
        await channel.messages.edit(panel.messageId, payload);
        lastPanelHash.set(panel.messageId, hash);
      } catch (error) {
        if (error instanceof DiscordAPIError && error.code === RESTJSONErrorCodes.UnknownMessage) {
          await forgetWantPanel(panel.messageId);
          lastPanelHash.delete(panel.messageId);
        } else {
          reportError(`「${guild.name}」のやりたいコンテンツのパネルを書き換えられませんでした`, error, guild);
        }
      }
    }
  });
};

/** 選んだあとなどに、待たずにパネルを書き換える（失敗しても操作は止めない） */
const refreshSoon = (guild: Guild): void => {
  refreshWantPanels(guild).catch((error: unknown) => {
    reportError(`「${guild.name}」のやりたいコンテンツのパネルを書き換えられませんでした`, error, guild);
  });
};

/** 起動時と、そのあと1時間ごとに作り直す（抜けた人・非アクティブになった人を反映する） */
export const startWantPanels = (client: Client<true>): void => {
  const run = () => {
    for (const guild of client.guilds.cache.values()) refreshSoon(guild);
  };
  run();
  setInterval(run, REFRESH_MS).unref();
};

// ---- 選ぶ画面（本人にだけ見える）

type Row = ActionRowBuilder<MessageActionRowComponentBuilder>;
const row = (...components: MessageActionRowComponentBuilder[]): Row => new ActionRowBuilder<MessageActionRowComponentBuilder>().addComponents(components);
const button = (id: string, label: string, emoji: string, style: ButtonStyle = ButtonStyle.Secondary): ButtonBuilder =>
  new ButtonBuilder().setCustomId(id).setLabel(label).setEmoji({ name: emoji }).setStyle(style);

/** 画面の上に出す、今の選択（制限解除を選んだものには、そのやり方を付ける） */
const picksSummary = (options: WantOption[], mine: WantPick[]): string => {
  const modes = picksByKey(mine);
  const picked = options.filter((option) => modes.has(option.key));
  if (picked.length === 0) return '今の選択: なし';
  const listed = picked
    .slice(0, MAX_LISTED_PICKS)
    .map((option) => `${optionLabel(option)}${modeTag(modes.get(option.key) ?? new Set())}`)
    .join('・');
  const more = picked.length > MAX_LISTED_PICKS ? ` ほか${picked.length - MAX_LISTED_PICKS}件` : '';
  return `今の選択（${picked.length}件）: ${listed}${more}`;
};

/** その中で選んでいる数（やり方は問わない） */
const pickedCount = (group: WantOption[], mine: WantPick[]): number => {
  const keys = new Set(mine.map((pick) => pick.key));
  return group.filter((option) => keys.has(option.key)).length;
};

/** 非アクティブの人には、数えられないことを知らせる */
const inactiveNote = (member: GuildMember): string[] => {
  const inactive = findInactiveRole(member.guild);
  return inactive && member.roles.cache.has(inactive.id)
    ? ['', `⚠ 今は「${INACTIVE_ROLE_NAME}」なので、パネルの人数には入りません（発言やVCに入ると外れます）。`]
    : [];
};

/** 一番上の画面: カテゴリーを選ぶ */
const homeScreen = async (member: GuildMember, note?: string) => {
  const [options, mine] = await Promise.all([loadOptions(member.guild.id), listMemberWants(member.guild.id, member.id)]);
  const select = new StringSelectMenuBuilder()
    .setCustomId(CATEGORY_ID)
    .setPlaceholder('カテゴリーを選ぶ')
    .addOptions(
      CATEGORIES.filter((category) => groupOptions(options, category.key, null).length > 0).map((category) => {
        const picked = pickedCount(groupOptions(options, category.key, null), mine);
        return { label: category.label, value: category.key, emoji: { name: category.emoji }, ...(picked > 0 ? { description: `${picked}件 選択中` } : {}) };
      }),
    );
  return {
    content: [
      ...(note ? [note, ''] : []),
      '✋ **やりたいコンテンツ**',
      'カテゴリーを選ぶと、その中から選べます（いくつでも・あとから何度でも変えられます）。',
      picksSummary(options, mine),
      ...inactiveNote(member),
    ].join('\n'),
    components: [row(select), row(button(CLEAR_ID, '全部外す', '🧹').setDisabled(mine.length === 0))],
    allowedMentions: { parse: [] },
  };
};

/** 拡張を選ぶ画面（拡張で分けるカテゴリーだけ） */
const expansionScreen = async (member: GuildMember, category: CategoryKey) => {
  const info = categoryInfo(category);
  const [options, mine] = await Promise.all([loadOptions(member.guild.id), listMemberWants(member.guild.id, member.id)]);
  const inCategory = groupOptions(options, category, null);
  // 新しい拡張から並べる
  const expansions = [...new Set(inCategory.map((option) => option.expansion ?? 0))].sort((a, b) => b - a);
  const select = new StringSelectMenuBuilder()
    .setCustomId(`${EXPANSION_PREFIX}${category}`)
    .setPlaceholder('拡張を選ぶ')
    .addOptions(
      expansions.map((expansion) => {
        const group = groupOptions(options, category, expansion);
        const picked = pickedCount(group, mine);
        return {
          label: EXPANSIONS[expansion] ?? `拡張${expansion}`,
          value: String(expansion),
          description: `${group.length}件${picked > 0 ? `・${picked}件 選択中` : ''}`,
        };
      }),
    );
  return {
    content: [`${info?.emoji ?? ''} **${info?.label ?? category}**`, '拡張を選んでください。', picksSummary(inCategory, mine)].join('\n'),
    components: [row(select), row(button(PICK_ID, 'カテゴリーに戻る', '↩️'))],
    allowedMentions: { parse: [] },
  };
};

/** コンテンツを選ぶ画面（25件ずつ） */
const groupScreen = async (member: GuildMember, category: CategoryKey, expansion: number | null, page: number, note?: string) => {
  const info = categoryInfo(category);
  const [options, mine] = await Promise.all([loadOptions(member.guild.id), listMemberWants(member.guild.id, member.id)]);
  const group = groupOptions(options, category, expansion);
  const pages = Math.max(1, Math.ceil(group.length / PAGE_SIZE));
  const current = Math.min(Math.max(page, 0), pages - 1);
  const onPage = group.slice(current * PAGE_SIZE, (current + 1) * PAGE_SIZE);
  const expansionKey = expansion === null ? NO_EXPANSION : String(expansion);
  const back = info?.byExpansion ? button(`${BACK_PREFIX}${category}`, '拡張に戻る', '↩️') : button(PICK_ID, 'カテゴリーに戻る', '↩️');
  const title = [`${info?.emoji ?? ''} **${info?.label ?? category}**`, ...(expansion === null ? [] : [EXPANSIONS[expansion] ?? '']), ...(pages > 1 ? [`${current + 1}/${pages}ページ`] : [])].join('・');
  if (onPage.length === 0) {
    return {
      content: [title, category === 'other' ? 'まだありません（管理者が追加します）。' : 'ここにはコンテンツがありません。'].join('\n'),
      components: [row(back)],
      allowedMentions: { parse: [] },
    };
  }
  const has = (key: string, mode: WantMode): boolean => mine.some((pick) => pick.key === key && pick.mode === mode);
  const unsyncable = onPage.filter(canUnsync);
  // 制限解除がある種類なら、「通常」と「制限解除」の2つのメニューを並べる（両方で選ぶと「どちらでも」）
  const selectFor = (mode: WantMode, items: WantOption[], placeholder: string): StringSelectMenuBuilder =>
    new StringSelectMenuBuilder()
      .setCustomId(`${SELECT_PREFIX}${category}:${expansionKey}:${current}:${MODE_CODES[mode]}`)
      .setPlaceholder(placeholder)
      .setMinValues(0)
      .setMaxValues(items.length)
      .addOptions(items.map((option) => ({ label: option.name.slice(0, 100), value: option.key, default: has(option.key, mode) })));
  const selects =
    unsyncable.length > 0
      ? [selectFor('normal', onPage, '通常（レベル・ILの制限あり）でやりたいもの'), selectFor('unsynced', unsyncable, `${UNSYNCED_MARK} 制限解除でやりたいもの`)]
      : [selectFor('normal', onPage, 'やりたいものを選ぶ（いくつでも）')];
  const latestNote =
    UNSYNCABLE.has(category) && unsyncable.length === 0 && expansion === LATEST_EXPANSION
      ? [`最新の拡張「${EXPANSIONS[LATEST_EXPANSION] ?? ''}」のコンテンツは、制限解除できません。`]
      : [];
  const buttons = [
    ...(pages > 1
      ? [
          button(`${PAGE_PREFIX}${category}:${expansionKey}:${current - 1}`, '前へ', '◀️').setDisabled(current === 0),
          button(`${PAGE_PREFIX}${category}:${expansionKey}:${current + 1}`, '次へ', '▶️').setDisabled(current >= pages - 1),
        ]
      : []),
    back,
  ];
  return {
    content: [
      ...(note ? [note, ''] : []),
      title,
      unsyncable.length > 0
        ? `やりたいものを選んでください（いくつでも）。上は通常、下の ${UNSYNCED_MARK} は制限解除で、両方で選ぶと「どちらでも」になります。外すときは、メニューで選択を外します。`
        : 'やりたいものを選んでください（いくつでも）。外すときは、メニューで選択を外します。',
      ...latestNote,
      picksSummary(options, mine),
      ...inactiveNote(member),
    ].join('\n'),
    components: [...selects.map((select) => row(select)), row(...buttons)],
    allowedMentions: { parse: [] },
  };
};

const MODE_LABELS: Record<WantMode, string> = { normal: '通常', unsynced: '制限解除' };

/** メニュー1つ分（そのやり方）の選択を保存して、パネルとログに反映する。結果の一言を返す */
const saveGroup = async (member: GuildMember, scope: WantOption[], mode: WantMode, selected: string[]): Promise<string> => {
  const before = (await listMemberWants(member.guild.id, member.id)).filter((pick) => pick.mode === mode).map((pick) => pick.key);
  await replaceMemberWants(
    member.guild.id,
    member.id,
    mode,
    scope.map((option) => option.key),
    selected,
  );
  const added = scope.filter((option) => selected.includes(option.key) && !before.includes(option.key));
  const removed = scope.filter((option) => before.includes(option.key) && !selected.includes(option.key));
  if (added.length === 0 && removed.length === 0) return '変更はありませんでした。';
  refreshSoon(member.guild);
  logChange(member, added, removed, mode);
  const how = mode === 'unsynced' ? `（${MODE_LABELS.unsynced}）` : '';
  return [...(added.length > 0 ? [`✅ ${added.length}件 選びました${how}`] : []), ...(removed.length > 0 ? [`${removed.length}件 外しました${how}`] : [])].join('・') + '。';
};

const logChange = (member: GuildMember, added: WantOption[], removed: WantOption[], mode: WantMode | null): void => {
  const how = mode === null ? '' : `（${MODE_LABELS[mode]}）`;
  void sendLog(member.guild, 'want', `${member} がやりたいコンテンツを変えました`, member, {
    fields: [
      ...(added.length > 0 ? [{ name: `➕ 選んだ${how}`, value: added.map(optionLabel).join('・').slice(0, 1000), inline: true }] : []),
      ...(removed.length > 0 ? [{ name: `➖ 外した${how}`, value: removed.map(optionLabel).join('・').slice(0, 1000), inline: true }] : []),
    ],
  });
};

/** customId の「<カテゴリー>:<拡張 か ->:<ページ>[:<やり方>]」を読む。おかしければ null */
const parseGroupId = (rest: string): { category: CategoryKey; expansion: number | null; page: number; mode: WantMode } | null => {
  const [category = '', expansionText = '', pageText = '', modeCode = MODE_CODES.normal] = rest.split(':');
  const info = categoryInfo(category);
  if (!info) return null;
  const expansion = expansionText === NO_EXPANSION ? null : Number(expansionText);
  const page = Number(pageText);
  if ((expansion !== null && !Number.isInteger(expansion)) || !Number.isInteger(page)) return null;
  return { category: info.key, expansion, page, mode: modeCode === MODE_CODES.unsynced ? 'unsynced' : 'normal' };
};

// ---- 管理者の画面（管理パネルの「🎮 やりたいコンテンツ」）

export const adminScreen = async (guild: Guild, note?: string) => {
  const [items, votes] = await Promise.all([listWantItems(guild.id), listWantVotes(guild.id)]);
  const count = (item: WantItem): number => new Set((votes.get(`c${item.id}`) ?? []).map((vote) => vote.userId)).size;
  const label = (item: WantItem): string => `${item.emoji ? `${item.emoji} ` : ''}${item.name}`;
  const components: Row[] = [
    row(
      button(ADD_ID, '「そのほか」に足す', '➕', ButtonStyle.Primary).setDisabled(items.length >= MAX_ITEMS),
      button(RESET_ID, '全員の選択をリセット', '🔄', ButtonStyle.Danger),
    ),
  ];
  if (items.length > 0) {
    components.push(
      row(
        new StringSelectMenuBuilder()
          .setCustomId(REMOVE_SELECT_ID)
          .setPlaceholder('「そのほか」から消すものを選ぶ（選んでいた人の選択も消えます）')
          .addOptions(items.map((item) => ({ label: `${item.name}（${count(item)}人）`.slice(0, 100), value: item.id, ...(item.emoji ? { emoji: { name: item.emoji } } : {}) }))),
      ),
    );
  }
  return {
    content: [
      ...(note ? [note, ''] : []),
      '🎮 **やりたいコンテンツ**',
      `ゲームのコンテンツ（零式・絶・討滅戦・ダンジョンなど${DUTIES.length}件）は、自動で選べます。パネルは \`/やりたいコンテンツパネル\` で設置します。`,
      `ここでは、ゲームのコンテンツにないもの（地図・ギャザクラなど）を「そのほか」として足し引きできます（${MAX_ITEMS}個まで・この順で並びます）。`,
      '',
      '✨ **そのほか**',
      ...(items.length > 0 ? items.map((item) => `・${escapeMarkdown(label(item))}（${count(item)}人）`) : ['まだありません。']),
    ].join('\n'),
    components,
    allowedMentions: { parse: [] },
  };
};

const addModal = (): ModalBuilder =>
  new ModalBuilder()
    .setCustomId(ADD_MODAL_ID)
    .setTitle('「そのほか」に足す')
    .addLabelComponents(
      new LabelBuilder()
        .setLabel('名前')
        .setTextInputComponent(new TextInputBuilder().setCustomId(NAME_INPUT_ID).setStyle(TextInputStyle.Short).setMaxLength(MAX_NAME_LENGTH).setRequired(true).setPlaceholder('例: 地図')),
      new LabelBuilder()
        .setLabel('絵文字（任意）')
        .setDescription('選択肢とパネルに付きます。絵文字を1つだけ')
        .setTextInputComponent(new TextInputBuilder().setCustomId(EMOJI_INPUT_ID).setStyle(TextInputStyle.Short).setMaxLength(16).setRequired(false).setPlaceholder('🗺️')),
    );

/** 入力された絵文字（1つだけ・Unicodeの絵文字）。使えなければ null */
export const parseEmoji = (text: string): string | null => {
  const value = text.trim();
  if (!value) return null;
  const graphemes = [...new Intl.Segmenter('ja', { granularity: 'grapheme' }).segment(value)];
  return graphemes.length === 1 && /\p{Extended_Pictographic}/u.test(value) ? value : null;
};

const deferScreen = async (interaction: ButtonInteraction<'cached'> | StringSelectMenuInteraction<'cached'>): Promise<void> => {
  if (interaction.message.flags.has(MessageFlags.Ephemeral)) {
    await interaction.deferUpdate();
  } else {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  }
};

// ---- ボタン・メニュー・入力画面の受け取り

export const handleComponent = async (interaction: ButtonInteraction<'cached'> | StringSelectMenuInteraction<'cached'>): Promise<void> => {
  const { customId, guild, member } = interaction;

  // メンバーの操作
  if (customId === PICK_ID) {
    await deferScreen(interaction);
    await interaction.editReply(await homeScreen(member));
    return;
  }
  if (customId === WHO_ID) {
    await deferScreen(interaction);
    await interaction.editReply(await whoScreen(guild));
    return;
  }
  if (customId === WHO_SELECT_ID && interaction.isStringSelectMenu()) {
    await interaction.deferUpdate();
    await interaction.editReply(await whoScreen(guild, interaction.values[0]));
    return;
  }
  if (customId === CLEAR_ID) {
    await interaction.deferUpdate();
    const [options, before] = await Promise.all([loadOptions(guild.id), listMemberWants(guild.id, member.id)]);
    await clearMemberWants(guild.id, member.id);
    if (before.length > 0) {
      refreshSoon(guild);
      const keys = new Set(before.map((pick) => pick.key));
      logChange(member, [], options.filter((option) => keys.has(option.key)), null);
    }
    await interaction.editReply(await homeScreen(member, before.length > 0 ? '🧹 全部外しました。' : '変更はありませんでした。'));
    return;
  }
  if (customId === CATEGORY_ID && interaction.isStringSelectMenu()) {
    const info = categoryInfo(interaction.values[0] ?? '');
    if (!info) return;
    await interaction.deferUpdate();
    await interaction.editReply(info.byExpansion ? await expansionScreen(member, info.key) : await groupScreen(member, info.key, null, 0));
    return;
  }
  if (customId.startsWith(EXPANSION_PREFIX) && interaction.isStringSelectMenu()) {
    const info = categoryInfo(customId.slice(EXPANSION_PREFIX.length));
    const expansion = Number(interaction.values[0]);
    if (!info || !Number.isInteger(expansion)) return;
    await interaction.deferUpdate();
    await interaction.editReply(await groupScreen(member, info.key, expansion, 0));
    return;
  }
  if (customId.startsWith(BACK_PREFIX)) {
    const info = categoryInfo(customId.slice(BACK_PREFIX.length));
    if (!info) return;
    await interaction.deferUpdate();
    await interaction.editReply(await expansionScreen(member, info.key));
    return;
  }
  if (customId.startsWith(PAGE_PREFIX)) {
    const target = parseGroupId(customId.slice(PAGE_PREFIX.length));
    if (!target) return;
    await interaction.deferUpdate();
    await interaction.editReply(await groupScreen(member, target.category, target.expansion, target.page));
    return;
  }
  if (customId.startsWith(SELECT_PREFIX) && interaction.isStringSelectMenu()) {
    const target = parseGroupId(customId.slice(SELECT_PREFIX.length));
    if (!target) return;
    await interaction.deferUpdate();
    // 保存するのは、そのメニューに並んでいたものだけ（ほかのページ・カテゴリーと、もう一方のやり方の選択はそのまま）。
    // 制限解除のメニューには、制限解除できるものしか並ばない
    const group = groupOptions(await loadOptions(guild.id), target.category, target.expansion);
    const onPage = group.slice(target.page * PAGE_SIZE, (target.page + 1) * PAGE_SIZE);
    const scope = target.mode === 'unsynced' ? onPage.filter(canUnsync) : onPage;
    const note = await saveGroup(member, scope, target.mode, interaction.values);
    await interaction.editReply(await groupScreen(member, target.category, target.expansion, target.page, note));
    return;
  }

  // ここから先は管理者だけ
  if (!(await ensureAdmin(interaction))) return;
  switch (customId) {
    case ADMIN_BUTTON_ID:
      await deferScreen(interaction);
      await interaction.editReply(await adminScreen(guild));
      return;
    case ADD_ID:
      if (!interaction.isButton()) return;
      await interaction.showModal(addModal());
      return;
    case REMOVE_SELECT_ID: {
      if (!interaction.isStringSelectMenu()) return;
      await interaction.deferUpdate();
      const removed = await deleteWantItem(guild.id, interaction.values[0] ?? '');
      if (removed) {
        refreshSoon(guild);
        void sendLog(guild, 'want', `${member} がやりたいコンテンツの「そのほか」から「${removed.name}」を消しました`, member, { title: 'やりたいコンテンツの一覧' });
      }
      await interaction.editReply(await adminScreen(guild, removed ? `🗑️「${removed.name}」を消しました。` : 'それはもうありません。'));
      return;
    }
    case RESET_ID:
      await interaction.update({
        content: '⚠ **全員の選択を消します。** パネルは誰も選んでいない状態に戻ります（「そのほか」の一覧は残ります）。よろしいですか？',
        components: [row(button(RESET_CONFIRM_ID, '消す', '🔄', ButtonStyle.Danger), new ButtonBuilder().setCustomId(ADMIN_BUTTON_ID).setLabel('やめる').setStyle(ButtonStyle.Secondary))],
      });
      return;
    case RESET_CONFIRM_ID: {
      await interaction.deferUpdate();
      const count = await resetWantVotes(guild.id);
      refreshSoon(guild);
      void sendLog(guild, 'want', `${member} がやりたいコンテンツの全員の選択をリセットしました（${count}件）`, member, { title: 'やりたいコンテンツのリセット' });
      await interaction.editReply(await adminScreen(guild, `🔄 全員の選択を消しました（${count}件）。`));
    }
  }
};

export const handleModalSubmit = async (interaction: ModalSubmitInteraction<'cached'>): Promise<void> => {
  if (interaction.customId !== ADD_MODAL_ID || !(await ensureAdmin(interaction))) return;
  const { guild, member, fields } = interaction;
  if (interaction.isFromMessage()) {
    await interaction.deferUpdate();
  } else {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  }
  const name = fields.getTextInputValue(NAME_INPUT_ID).normalize('NFKC').trim().slice(0, MAX_NAME_LENGTH);
  const emojiText = fields.getTextInputValue(EMOJI_INPUT_ID);
  const emoji = parseEmoji(emojiText);
  if (!name) {
    await interaction.editReply(await adminScreen(guild, '⚠ 名前を入力してください。'));
    return;
  }
  if ((await listWantItems(guild.id)).length >= MAX_ITEMS) {
    await interaction.editReply(await adminScreen(guild, `⚠「そのほか」は${MAX_ITEMS}個までです。先にどれかを消してください。`));
    return;
  }
  const added = await addWantItem(guild.id, name, emoji);
  if (added === 'duplicate') {
    await interaction.editReply(await adminScreen(guild, `⚠「${name}」はもうあります。`));
    return;
  }
  refreshSoon(guild);
  void sendLog(guild, 'want', `${member} がやりたいコンテンツの「そのほか」に「${name}」を足しました`, member, { title: 'やりたいコンテンツの一覧' });
  const emojiNote = emojiText.trim() && !emoji ? '（絵文字は1つだけの普通の絵文字にしてください。今回は付けていません）' : '';
  await interaction.editReply(await adminScreen(guild, `➕「${emoji ? `${emoji} ` : ''}${name}」を足しました。${emojiNote}`));
};
