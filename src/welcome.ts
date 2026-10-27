import { EmbedBuilder, messageLink, type Guild, type GuildMember } from 'discord.js';
import { loadAutoApprove, loadWelcomeSettings, type WelcomeSettings } from './guildSettings.js';
import { listPanels, type PanelKind } from './panels.js';
import { MEMBER_ROLE_NAME } from './profilePublish.js';

// 入ってすぐの案内。サーバーに入った人に、DMで「まず何をすればいいか」を送る（本人にしか見えない）。
// 案内先は設置済みのパネル（プロフィール・設定・PT募集）へのリンク。管理パネルで、オン・オフと一言を変えられる

export type WelcomeResult = 'sent' | 'failed' | 'off';

export const WELCOME_RESULT_LABELS: Record<WelcomeResult, string> = {
  sent: '送りました',
  failed: '送れませんでした（DMを受け付けていない設定）',
  off: 'オフ（管理パネルで止めています）',
};

/** そのパネルへのリンク（同じ種類が何枚かあれば、一番新しく置いたもの。なければ null） */
const panelLink = (guild: Guild, panels: Awaited<ReturnType<typeof listPanels>>, kind: PanelKind): string | null => {
  const panel = panels.filter((p) => p.kind === kind).at(-1);
  return panel ? messageLink(panel.channelId, panel.messageId, guild.id) : null;
};

/** 案内の中身（送るときと、管理パネルのプレビューで共通） */
export const buildWelcomeEmbed = async (guild: Guild, settings: WelcomeSettings): Promise<EmbedBuilder> => {
  const [panels, autoApprove] = await Promise.all([listPanels(guild.id), loadAutoApprove(guild.id)]);
  const go =(kind: PanelKind, label: string): string => {
    const link = panelLink(guild, panels, kind);
    return link ? `\n→ [${label}](${link})` : '';
  };
  return new EmbedBuilder()
    .setColor(0x57f287)
    .setTitle(`👋 「${guild.name}」へようこそ！`)
    .setThumbnail(guild.iconURL() ?? null)
    .setDescription([...(settings.message.trim() ? [settings.message.trim(), ''] : []), 'まずはこの3つから始めてみてください。'].join('\n'))
    .addFields(
      {
        name: '1️⃣ プロフィールを登録',
        value: `「プロフィールを作成」ボタンから、キャラクター名・ワールド・ジョブなどを登録します。${autoApprove ? '登録するとすぐ' : '管理者が確認したら'}「${MEMBER_ROLE_NAME}」になれます。${go('profile', 'プロフィール登録へ')}`,
      },
      {
        name: '2️⃣ 自分の設定',
        value: `VC通知・「いつでも誘って」・自分専用の招待リンクなどを、自分で切り替えられます。${go('settings', '設定パネルへ')}`,
      },
      {
        name: '3️⃣ 一緒に遊ぶ',
        value: `PT募集から、パーティを集めたり、ほかの人の募集に参加したりできます。${go('recruit', 'PT募集へ')}`,
      },
    )
    .setFooter({ text: 'わからないことがあれば、気軽に聞いてください。' });
};

/** 入った人にDMで案内を送る。Botには送らない（null） */
export const sendWelcome = async (member: GuildMember): Promise<WelcomeResult | null> => {
  if (member.user.bot) return null;
  const settings = await loadWelcomeSettings(member.guild.id);
  if (!settings.enabled) return 'off';
  const embed = await buildWelcomeEmbed(member.guild, settings);
  return member.send({ embeds: [embed] }).then(
    () => 'sent' as const,
    () => 'failed' as const,
  );
};
