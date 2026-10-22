import {
  ChannelType,
  ComponentType,
  DiscordAPIError,
  PermissionFlagsBits,
  RESTJSONErrorCodes,
  messageLink,
  type Guild,
  type Message,
} from 'discord.js';
import { sendLog } from './activityLog.js';
import * as adminPanel from './commands/adminPanel.js';
import * as contentPanel from './commands/contentPanel.js';
import * as profilePanel from './commands/profilePanel.js';
import * as progressPanel from './commands/progressPanel.js';
import * as recruitPanel from './commands/recruitPanel.js';
import * as settingsPanel from './commands/settingsPanel.js';
import {
  forgetPanel,
  hashPanelPayload,
  listPanels,
  rememberPanel,
  updatePanelHash,
  type PanelKind,
  type PanelPayload,
} from './panels.js';

// Botの起動時に、設置済みのパネルを今のBotの内容に作り直す。
// メッセージは消さずに編集するので、場所も並び順もそのまま。前回から中身が変わったパネルだけ編集する

const PANELS: Record<PanelKind, { label: string; prefix: string; build: (guild: Guild) => PanelPayload }> = {
  progress: { label: '進行度パネル', prefix: progressPanel.BUTTON_PREFIX, build: progressPanel.buildPanel },
  content: { label: 'コンテンツパネル', prefix: contentPanel.BUTTON_PREFIX, build: contentPanel.buildPanel },
  profile: { label: 'プロフィールパネル', prefix: profilePanel.CUSTOM_ID_PREFIX, build: profilePanel.buildPanel },
  settings: { label: '設定パネル', prefix: settingsPanel.CUSTOM_ID_PREFIX, build: settingsPanel.buildPanel },
  admin: { label: '管理パネル', prefix: adminPanel.CUSTOM_ID_PREFIX, build: adminPanel.buildPanel },
  // 募集の投稿にも recruit: のボタンがあるので、パネルの「募集を作成」ボタンだけで見分ける
  recruit: { label: '募集パネル', prefix: recruitPanel.CREATE_BUTTON_ID, build: recruitPanel.buildPanel },
};
/** 覚えていないパネルを探すとき、各チャンネルで遡るメッセージ数 */
const DISCOVER_LIMIT = 100;

/** 失敗しても起動は止めない（作り直せなかったパネルは古い内容のまま使える） */
export const refreshPanels = async (guild: Guild): Promise<void> => {
  let panels = await listPanels(guild.id);
  // この仕組みより前に設置されたパネルは覚えていないので、一度だけチャンネルから探す
  if (panels.length === 0) {
    await discoverPanels(guild);
    panels = await listPanels(guild.id);
  }

  const updated: string[] = [];
  for (const panel of panels) {
    const payload = PANELS[panel.kind].build(guild);
    if (hashPanelPayload(payload) === panel.payloadHash) continue;
    // ロールが消されるなどでボタンが1つもなくなるときは、押せるパネルを壊さないよう、前のままにしておく
    if (payload.components.length === 0) {
      console.warn(`「${guild.name}」の${PANELS[panel.kind].label}は、ボタンがなくなるため作り直しませんでした`);
      continue;
    }

    const channel = guild.channels.cache.get(panel.channelId);
    if (!channel?.isTextBased()) {
      await forgetPanel(panel.messageId);
      continue;
    }
    try {
      await channel.messages.edit(panel.messageId, payload);
      await updatePanelHash(panel.messageId, payload);
      updated.push(`・[${PANELS[panel.kind].label}](${messageLink(panel.channelId, panel.messageId, guild.id)})（${channel}）`);
    } catch (error) {
      // 消されたパネルは、もう覚えておかない
      if (error instanceof DiscordAPIError && error.code === RESTJSONErrorCodes.UnknownMessage) {
        await forgetPanel(panel.messageId);
      } else {
        console.error(`「${guild.name}」の${PANELS[panel.kind].label}を作り直せませんでした:`, error);
      }
    }
  }

  if (updated.length > 0) {
    await sendLog(guild, 'system', [`パネルを最新の内容に更新しました（${updated.length}件）`, ...updated].join('\n'));
  }
};

/** Botが送ったメッセージのうち、パネルのボタンが付いているものを覚える */
const discoverPanels = async (guild: Guild): Promise<void> => {
  const me = guild.members.me;
  if (!me) return;
  for (const channel of guild.channels.cache.values()) {
    if (channel.type !== ChannelType.GuildText && channel.type !== ChannelType.GuildAnnouncement) continue;
    if (!channel.permissionsFor(me).has([PermissionFlagsBits.ViewChannel, PermissionFlagsBits.ReadMessageHistory])) continue;

    const messages = await channel.messages.fetch({ limit: DISCOVER_LIMIT }).catch(() => null);
    for (const message of messages?.values() ?? []) {
      if (message.author.id !== me.id) continue;
      const kind = detectPanelKind(message);
      // 中身を覚えていないので、次の作り直しで必ず編集される
      if (kind) await rememberPanel(message, kind);
    }
  }
};

/** ボタンの customId から、どのパネルかを見分ける（入力画面などは本人にだけ見えるメッセージなので、ここには出てこない） */
const detectPanelKind = (message: Message): PanelKind | null => {
  const customIds = message.components
    .flatMap((row) => (row.type === ComponentType.ActionRow ? row.components : []))
    .flatMap((component) => (component.type === ComponentType.Button && component.customId ? [component.customId] : []));
  const kinds = Object.keys(PANELS) as PanelKind[];
  return kinds.find((kind) => customIds.some((id) => id.startsWith(PANELS[kind].prefix))) ?? null;
};
