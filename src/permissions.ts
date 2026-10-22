import {
  MessageFlags,
  PermissionFlagsBits,
  type Guild,
  type GuildMember,
  type RepliableInteraction,
  type ChatInputCommandInteraction,
  type Role,
} from 'discord.js';
// activityLog もこのファイルを読み込むが、どちらも関数の中で使うだけなので、読み込む順番には関係しない
import { sendLog } from './activityLog.js';

/** パネルの設置や申請の審査ができるロールの名前 */
export const ADMIN_ROLE_NAME = '管理者';

/** 「管理者」ロールを持っているか。ロールを作る前に締め出されないよう、サーバーのオーナーは常に許可する */
export const isAdmin = (member: GuildMember): boolean =>
  member.id === member.guild.ownerId || member.roles.cache.some((role) => role.name === ADMIN_ROLE_NAME);

/** 管理者でなければ本人にだけ断りを返し、「権限拒否」としてログに残す。続けてよければ true */
export const ensureAdmin = async (interaction: RepliableInteraction<'cached'>): Promise<boolean> => {
  if (isAdmin(interaction.member)) return true;
  await interaction.reply({
    content: `この操作は「${ADMIN_ROLE_NAME}」ロールを持つメンバーだけが使えます。`,
    flags: MessageFlags.Ephemeral,
  });
  logDenied(interaction);
  return false;
};

/** 同じ人が同じ操作を連打しても、権限拒否のログはこの間隔に1回まで */
const DENIED_LOG_COOLDOWN_MS = 60_000;
const lastDeniedAt = new Map<string, number>();

/** ログに残せなくても、断る処理は止めない */
const logDenied = (interaction: RepliableInteraction<'cached'>): void => {
  try {
    const attempt = interactionLabel(interaction);
    const key = `${interaction.guildId}:${interaction.user.id}:${attempt}`;
    const now = Date.now();
    if (now - (lastDeniedAt.get(key) ?? 0) < DENIED_LOG_COOLDOWN_MS) return;
    lastDeniedAt.set(key, now);
    void sendLog(interaction.guild, 'denied', `${interaction.member} が管理者専用の操作をしようとしました`, interaction.member, {
      channel: interaction.channel,
      fields: [{ name: '🚫 操作', value: attempt, inline: true }],
    });
  } catch (error) {
    console.error('権限拒否のログを残せませんでした:', error);
  }
};

/** 管理コマンドを使ったこと（失敗したらその理由も）をログに残す */
export const logCommand = (interaction: ChatInputCommandInteraction<'cached'>, error: unknown): void => {
  const options = interaction.options.data.map((option) => `${option.name}: ${option.user?.username ?? option.value ?? ''}`);
  void sendLog(
    interaction.guild,
    'command',
    `${interaction.member} が ${interactionLabel(interaction)} を${error ? '実行しましたが、失敗しました' : '実行しました'}`,
    interaction.member,
    {
      title: error ? '管理コマンド失敗' : '管理コマンド実行',
      channel: interaction.channel,
      fields: [
        ...(options.length > 0 ? [{ name: '⚙️ オプション', value: options.join('\n'), inline: true }] : []),
        ...(error ? [{ name: '⚠ エラー', value: error instanceof Error ? error.message : String(error) }] : []),
      ],
    },
  );
};

/** ログに出す、何をしたか（「/募集パネル」「「ユーザーを登録」ボタン」など） */
export const interactionLabel = (interaction: RepliableInteraction<'cached'>): string => {
  if (interaction.isChatInputCommand()) {
    return `/${interaction.command?.nameLocalizations?.ja ?? interaction.commandName}`;
  }
  if (interaction.isButton()) return `「${interaction.component.label ?? interaction.customId}」ボタン`;
  if (interaction.isModalSubmit()) return '入力画面の送信';
  if (interaction.isAnySelectMenu()) return 'メニューの選択';
  return '操作';
};

export const findAdminRole = (guild: Guild): Role | undefined =>
  guild.roles.cache.find((role) => role.name === ADMIN_ROLE_NAME);

/**
 * 「管理者」ロールがなければ作り、Botのロールのすぐ下（Botが動かせる一番上）に置く。作ったときはそのロールを返す。
 * Discordの権限は何も付けない（Botのコマンドを使える人の目印にするだけ）
 */
export const ensureAdminRole = async (guild: Guild): Promise<Role | null> => {
  if (findAdminRole(guild)) return null;

  const me = guild.members.me ?? (await guild.members.fetchMe());
  if (!me.permissions.has(PermissionFlagsBits.ManageRoles)) {
    console.warn(`「${guild.name}」: Botにロールの管理権限がないため、「${ADMIN_ROLE_NAME}」ロールを作れません`);
    return null;
  }

  const role = await guild.roles.create({
    name: ADMIN_ROLE_NAME,
    permissions: [],
    reason: 'Botのコマンドを使える人のロール',
  });
  // Botは自分のロールより上には動かせない。ほかのロールの位置は変えず、このロールだけを動かす
  const position = me.roles.highest.position - 1;
  if (position > role.position) {
    await guild.roles.setPositions([{ role, position }]);
  }
  console.log(`「${guild.name}」に「${ADMIN_ROLE_NAME}」ロールを作りました`);
  return role;
};

/** パネル設置時に出す注意。「管理者」ロールがないと、オーナー以外は誰も使えない */
export const adminRoleWarnings = (guild: Guild): string[] =>
  findAdminRole(guild)
    ? []
    : [`⚠「${ADMIN_ROLE_NAME}」ロールがないため、今はサーバーのオーナーだけがパネルの設置や申請の審査をできます。`];
