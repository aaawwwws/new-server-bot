import 'dotenv/config';
import {
  Client,
  DiscordAPIError,
  Events,
  GatewayDispatchEvents,
  GatewayIntentBits,
  MessageFlags,
  Partials,
  RESTJSONErrorCodes,
  type GatewayMessageReactionAddDispatchData,
  type GatewayVoiceChannelStatusUpdateDispatchData,
  type Guild,
  type Interaction,
} from 'discord.js';
import {
  LOG_CHANNEL_NAME,
  ensureLogChannel,
  logMemberJoin,
  logMessageBulkDelete,
  logMessageDelete,
  logMessageUpdate,
  logVoiceActivity,
  reconcileVoiceSessions,
  recordMessage,
  sendLog,
} from './activityLog.js';
import { startAdminReports } from './adminReport.js';
import { handleCallStateUpdate } from './callNotice.js';
import * as adminPanel from './commands/adminPanel.js';
import * as contentPanel from './commands/contentPanel.js';
import * as level from './commands/level.js';
import * as logSearch from './commands/logSearch.js';
import * as memberSearch from './commands/memberSearch.js';
import * as profilePanel from './commands/profilePanel.js';
import * as progressPanel from './commands/progressPanel.js';
import * as ranking from './commands/ranking.js';
import * as rankingBoard from './commands/rankingBoard.js';
import * as recruitList from './commands/recruitList.js';
import * as recruitPanel from './commands/recruitPanel.js';
import * as settingsPanel from './commands/settingsPanel.js';
import { closeDatabase, initDatabase } from './db.js';
import { reportError, setErrorReportClient } from './errorReporter.js';
import { loadAllGuildSettings } from './guildSettings.js';
import { backfillMemberInvites, recordMemberInvite, resolveInviteOwner } from './inviteStore.js';
import { findUsedInvite, handleInviteCreate, handleInviteDelete, loadInvites } from './inviteTracker.js';
import { handleMessageXp, handleReactionXp, startVoiceXp } from './levels.js';
import { deleteOldReactions } from './levelStore.js';
import { LEVEL_TITLES, ensureTitleRoles, syncTitles } from './levelTitles.js';
import { deleteOldLogs } from './logStore.js';
import { handleMemberLeave } from './memberLifecycle.js';
import {
  INACTIVE_ROLE_NAME,
  ensureInactiveRole,
  noteMessageActivity,
  noteReactionActivity,
  noteVoiceActivity,
  startInactiveRoles,
} from './inactiveRole.js';
import { handleAuditLogEntry } from './moderationLog.js';
import { refreshPanels } from './panelRefresh.js';
import { startRankingBoards } from './rankingBoard.js';
import * as rankingView from './rankingView.js';
import { refreshActiveRecruits, startRecruitScheduler } from './recruitMessage.js';
import { ADMIN_ROLE_NAME, ensureAdmin, ensureAdminRole, interactionLabel, logCommand } from './permissions.js';
import * as profileReview from './profileReview.js';
import { INVITE_ME_ROLE_NAME, ensureInviteMeRole } from './inviteMeRole.js';
import { VC_ROLE_NAME, ensureVcRole } from './vcRole.js';
import { handleVoiceStateUpdate } from './voiceJoinNotice.js';
import * as voiceStatus from './voiceStatus.js';
import { WELCOME_RESULT_LABELS, sendWelcome } from './welcome.js';
import { startBoostCache } from './xpBoost.js';

const commands = [
  progressPanel,
  contentPanel,
  profilePanel,
  settingsPanel,
  adminPanel,
  recruitPanel,
  recruitList,
  rankingBoard,
  logSearch,
  memberSearch,
  level,
  ranking,
];
/** 管理者以外も使えるコマンド（ほかはパネルの設置用なので「管理者」ロールの人だけ） */
const PUBLIC_COMMANDS = new Set([memberSearch.data.name, level.data.name, ranking.data.name]);

const token = process.env.DISCORD_TOKEN;
if (!token) {
  console.error('DISCORD_TOKEN が設定されていません。.env を確認してください。');
  process.exit(1);
}
if (!process.env.DATABASE_URL) {
  console.error('DATABASE_URL が設定されていません。.env を確認してください。');
  process.exit(1);
}

try {
  await initDatabase();
  console.log('データベースに接続しました');
} catch (error) {
  console.error('データベースに接続できません。DBが起動しているか確認してください（docker compose up -d db）:', error);
  process.exit(1);
}

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    // VC の入退室を受け取るため
    GatewayIntentBits.GuildVoiceStates,
    // サーバーへの参加・退出を受け取るため。Developer Portal で「Server Members Intent」をオンにしておく必要がある
    GatewayIntentBits.GuildMembers,
    // メッセージの削除・編集のログのため。本文を受け取るには Developer Portal で「Message Content Intent」もオンにしておく
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    // 監査ログ（誰がロールを変えた・キックした など）を受け取るため
    GatewayIntentBits.GuildModeration,
    // どの招待リンクで入ったかを調べるため（招待リンクの作成・削除を受け取る）
    GatewayIntentBits.GuildInvites,
    // リアクションでXPを貯めるため（特権インテントではないので、Developer Portal での設定は要らない）
    GatewayIntentBits.GuildMessageReactions,
  ],
  // Bot が覚えていない（起動前からいる）メンバーが抜けたときや、起動前のメッセージが消された・編集されたときも、イベントを受け取るため
  partials: [Partials.GuildMember, Partials.Message],
});

client.once(Events.ClientReady, async (readyClient) => {
  console.log(`ログインしました: ${readyClient.user.tag}`);
  // ここから先のエラーは「ログ」チャンネルにも知らせる
  setErrorReportClient(readyClient);

  try {
    await readyClient.application.commands.set(commands.map((command) => command.data.toJSON()));
    console.log('スラッシュコマンドを登録しました');
  } catch (error) {
    reportError('スラッシュコマンドの登録に失敗しました', error);
  }

  // Botが使う「管理者」「VC」ロールと「ログ」チャンネルを、ないサーバーでは作っておく。
  // そのあと、設置済みのパネルを今のBotの内容に作り直す（更新の記録をログチャンネルに残すので、ログの用意のあと）
  for (const guild of readyClient.guilds.cache.values()) {
    await prepareGuild(guild);
    await refreshPanels(guild).catch((error: unknown) => {
      reportError(`「${guild.name}」のパネルを作り直せませんでした`, error, guild);
    });
  }

  // XPを入れないチャンネルとXPアップ期間を読み込み（XPアップは1分ごとに読み直す）、VCにいる人へ1分ごとに経験値を配る
  await loadAllGuildSettings(readyClient);
  startBoostCache(readyClient);
  startVoiceXp(readyClient);
  // 1分ごとに、開始が近い募集のお知らせと、終わった募集の片付けをする（Botが止まっていた間の分も、ここでまとめて行う）
  startRecruitScheduler(readyClient);
  // 続いている募集の投稿と募集一覧を、今のBotの形に書き換える
  await refreshActiveRecruits(readyClient).catch((error: unknown) => {
    reportError('募集の投稿を書き換えられませんでした', error);
  });
  // ランキング掲示板を5分ごとに書き換え、月曜0時に先週・1日0時に先月の結果を投稿する（結果は歴代記録にも残す）
  startRankingBoards(readyClient);
  // 古い発言・ログ・リアクションの記録を消す（起動時と、そのあと6時間ごと）
  startLogRetention();
  // 毎週月曜9時に先週の管理レポートを「ログ」チャンネルに出し、DBのバックアップが作られ続けているかを見張る
  startAdminReports(readyClient);
  // しばらく来ていない人に「非アクティブ」を付ける（起動時と、そのあと日が変わるたび。また来たら、すぐ外す）
  startInactiveRoles(readyClient);
});

const LOG_RETENTION_INTERVAL_MS = 6 * 60 * 60 * 1000;
const startLogRetention = (): void => {
  const run = () => {
    deleteOldReactions().catch((error: unknown) => {
      reportError('古いリアクションの記録を消せませんでした', error);
    });
    deleteOldLogs().catch((error: unknown) => {
      reportError('古い記録を消せませんでした', error);
    });
  };
  run();
  setInterval(run, LOG_RETENTION_INTERVAL_MS).unref();
};

// 起動中に新しいサーバーへ招待されたとき
client.on(Events.GuildCreate, (guild) => {
  void prepareGuild(guild);
});

/** どれかを作れなくても起動は止めない（ロールがなくてもオーナーはコマンドを使える。ログはチャンネルがなければ送らないだけ） */
const prepareGuild = async (guild: Guild): Promise<void> => {
  // ロールはログチャンネルを見られる人の設定に使うので、先に作る
  const adminRole = await ensureAdminRole(guild).catch((error: unknown) => {
    reportError(`「${guild.name}」に「${ADMIN_ROLE_NAME}」ロールを作れませんでした`, error, guild);
    return null;
  });
  const logChannel = await ensureLogChannel(guild).catch((error: unknown) => {
    reportError(`「${guild.name}」に「${LOG_CHANNEL_NAME}」チャンネルを作れませんでした`, error, guild);
    return null;
  });
  const vcRole = await ensureVcRole(guild).catch((error: unknown) => {
    reportError(`「${guild.name}」に「${VC_ROLE_NAME}」ロールを作れませんでした`, error, guild);
    return null;
  });

  const inviteMeRole = await ensureInviteMeRole(guild).catch((error: unknown) => {
    reportError(`「${guild.name}」に「${INVITE_ME_ROLE_NAME}」ロールを作れませんでした`, error, guild);
    return null;
  });
  const inactiveRole = await ensureInactiveRole(guild).catch((error: unknown) => {
    reportError(`「${guild.name}」に「${INACTIVE_ROLE_NAME}」ロールを作れませんでした`, error, guild);
    return null;
  });
  const titleRoles = await ensureTitleRoles(guild).catch((error: unknown): string[] => {
    reportError(`「${guild.name}」に称号のロールを作れませんでした`, error, guild);
    return [];
  });

  // 作ったことは、用意できたログチャンネルに残す
  if (logChannel) {
    await sendLog(guild, 'system', `${logChannel} チャンネルがなかったので作成しました（「${ADMIN_ROLE_NAME}」ロールの人だけが見られます）`);
  }
  if (adminRole) {
    await sendLog(guild, 'system', `「${ADMIN_ROLE_NAME}」ロールがなかったので作成しました。管理する人に付けてください`);
  }
  if (inviteMeRole) {
    await sendLog(guild, 'system', `「${INVITE_ME_ROLE_NAME}」ロールがなかったので作成しました。設定パネルの「いつでも誘って」で、本人が付け外しできます`);
  }
  if (vcRole) {
    await sendLog(guild, 'system', `「${VC_ROLE_NAME}」ロールがなかったので作成しました。VC通知を受け取る人に、設定パネルや登録の手順で付きます`);
  }
  if (inactiveRole) {
    await sendLog(
      guild,
      'system',
      `「${INACTIVE_ROLE_NAME}」ロールがなかったので作成しました。しばらく発言・リアクション・VCがない人に付きます（日数とオン・オフは管理パネルの「非アクティブ」で変えられます）`,
    );
  }
  if (titleRoles.length > 0) {
    const levels = LEVEL_TITLES.filter((title) => titleRoles.includes(title.name)).map((title) => `Lv.${title.level}「${title.name}」`);
    await sendLog(guild, 'system', `称号のロールがなかったので作成しました（${levels.join('・')}）。レベルが上がると自動で付きます`);
  }
  // 称号を今のレベルに合わせる（Botが止まっていた間の分と、ロールを作ったときの分）
  await syncTitles(guild).catch((error: unknown) => {
    reportError(`「${guild.name}」の称号を付け直せませんでした`, error, guild);
  });

  // 参加した人が使った招待リンクを調べられるよう、今の招待リンクの使用回数を覚える
  await loadInvites(guild).catch((error: unknown) => {
    reportError(`「${guild.name}」の招待リンクを読めませんでした`, error, guild);
  });
  // 招待ランキングの記録を、これまでの参加のログからも作る（何度動かしても同じ）
  await backfillMemberInvites(guild.id).catch((error: unknown) => {
    reportError(`「${guild.name}」の招待の記録を作れませんでした`, error, guild);
  });
  // VCの出入りの記録を、今VCにいる人に合わせる（Botが止まっていた間の出入りの分）
  await reconcileVoiceSessions(guild).catch((error: unknown) => {
    reportError(`「${guild.name}」のVCの記録を合わせられませんでした`, error, guild);
  });
};

client.on(Events.InteractionCreate, async (interaction) => {
  if (!interaction.inCachedGuild()) return;

  try {
    if (interaction.isChatInputCommand()) {
      const isPublic = PUBLIC_COMMANDS.has(interaction.commandName);
      if (!isPublic && !(await ensureAdmin(interaction))) return;
      const command = commands.find((c) => c.data.name === interaction.commandName);
      try {
        await command?.execute(interaction);
        if (!isPublic) logCommand(interaction, null);
      } catch (error) {
        if (!isPublic) logCommand(interaction, error);
        throw error;
      }
    } else if (interaction.isButton() && interaction.customId.startsWith(progressPanel.BUTTON_PREFIX)) {
      await progressPanel.handleButton(interaction);
    } else if (interaction.isButton() && interaction.customId.startsWith(contentPanel.BUTTON_PREFIX)) {
      await contentPanel.handleButton(interaction);
    } else if (
      (interaction.isButton() || interaction.isStringSelectMenu()) &&
      interaction.customId.startsWith(profilePanel.CUSTOM_ID_PREFIX)
    ) {
      await profilePanel.handleComponent(interaction);
    } else if (interaction.isModalSubmit() && interaction.customId.startsWith(profilePanel.CUSTOM_ID_PREFIX)) {
      await profilePanel.handleModalSubmit(interaction);
    } else if (interaction.isButton() && interaction.customId.startsWith(profileReview.CUSTOM_ID_PREFIX)) {
      await profileReview.handleButton(interaction);
    } else if (interaction.isModalSubmit() && interaction.customId.startsWith(profileReview.CUSTOM_ID_PREFIX)) {
      await profileReview.handleModalSubmit(interaction);
    } else if (interaction.isButton() && interaction.customId.startsWith(adminPanel.CUSTOM_ID_PREFIX)) {
      await adminPanel.handleButton(interaction);
    } else if (interaction.isModalSubmit() && interaction.customId.startsWith(adminPanel.CUSTOM_ID_PREFIX)) {
      await adminPanel.handleModalSubmit(interaction);
    } else if (interaction.isChannelSelectMenu() && interaction.customId.startsWith(adminPanel.CUSTOM_ID_PREFIX)) {
      await adminPanel.handleChannelSelect(interaction);
    } else if (
      (interaction.isButton() || interaction.isStringSelectMenu() || interaction.isUserSelectMenu()) &&
      interaction.customId.startsWith(settingsPanel.CUSTOM_ID_PREFIX)
    ) {
      await settingsPanel.handleComponent(interaction);
    } else if (interaction.isModalSubmit() && interaction.customId.startsWith(settingsPanel.CUSTOM_ID_PREFIX)) {
      await settingsPanel.handleModalSubmit(interaction);
    } else if (
      (interaction.isButton() || interaction.isStringSelectMenu() || interaction.isUserSelectMenu() || interaction.isRoleSelectMenu()) &&
      interaction.customId.startsWith(recruitPanel.CUSTOM_ID_PREFIX)
    ) {
      await recruitPanel.handleComponent(interaction);
    } else if (interaction.isModalSubmit() && interaction.customId.startsWith(recruitPanel.CUSTOM_ID_PREFIX)) {
      await recruitPanel.handleModalSubmit(interaction);
    } else if (interaction.isButton() && interaction.customId.startsWith(rankingView.CUSTOM_ID_PREFIX)) {
      await rankingView.handleButton(interaction);
    } else if (interaction.isButton() && interaction.customId.startsWith(voiceStatus.CUSTOM_ID_PREFIX)) {
      await voiceStatus.handleButton(interaction);
    } else if (interaction.isModalSubmit() && interaction.customId.startsWith(voiceStatus.CUSTOM_ID_PREFIX)) {
      await voiceStatus.handleModalSubmit(interaction);
    }
  } catch (error) {
    reportError(`操作の処理に失敗しました（${interaction.isRepliable() ? interactionLabel(interaction) : interaction.type}）`, error, interaction.guild);
    await replyError(interaction, error);
  }
});

client.on(Events.VoiceStateUpdate, (oldState, newState) => {
  logVoiceActivity(oldState, newState).catch((error: unknown) => {
    reportError('VCのログを残せませんでした', error);
  });
  handleVoiceStateUpdate(oldState, newState).catch((error: unknown) => {
    reportError('VC入室のお知らせに失敗しました', error);
  });
  handleCallStateUpdate(oldState, newState).catch((error: unknown) => {
    reportError('通話の開始・終了のお知らせに失敗しました', error);
  });
  voiceStatus.handleVoiceStatusPrompt(oldState, newState).catch((error: unknown) => {
    reportError('VCステータスのお知らせに失敗しました', error);
  });
  noteVoiceActivity(oldState, newState).catch((error: unknown) => {
    reportError('VCに入った日を残せませんでした', error);
  });
});

// VCステータスがDiscord側で変わったとき（VCの画面から変えた、誰もいなくなって消えた など）
client.ws.on(GatewayDispatchEvents.VoiceChannelStatusUpdate, (data: GatewayVoiceChannelStatusUpdateDispatchData) => {
  voiceStatus.trackVoiceStatus(data);
});

// リアクションでのXP（付けられたメッセージを書いた人が要るので、届いたままの形で受け取る）
client.ws.on(GatewayDispatchEvents.MessageReactionAdd, (data: GatewayMessageReactionAddDispatchData) => {
  handleReactionXp(client, data).catch((error: unknown) => {
    reportError('リアクションのXPを保存できませんでした', error);
  });
  noteReactionActivity(client, data).catch((error: unknown) => {
    reportError('リアクションした日を残せませんでした', error);
  });
});

client.on(Events.Error, (error) => {
  reportError('Discordとの接続でエラーが起きました', error);
});

process.on('unhandledRejection', (reason) => {
  reportError('処理されなかったエラー', reason);
});

client.on(Events.GuildMemberAdd, (member) => {
  // どの招待リンクで入ったかも載せる（調べられなければ「不明」）。招待ランキングのために、誰が連れてきたかも残す
  findUsedInvite(member.guild)
    .catch(() => null)
    // Botが作った専用リンクなら、作成者（Bot）ではなく持ち主が連れてきた人
    .then((invite) => resolveInviteOwner(member.guild.id, invite).catch(() => invite))
    .then(async (invite) => {
      await recordMemberInvite(member, invite).catch((error: unknown) => {
        reportError('招待の記録を残せませんでした', error, member.guild);
      });
      // 入った人に、DMで「まず何をすればいいか」を送る（送れたかどうかも参加のログに載せる）
      const welcome = await sendWelcome(member).catch((error: unknown) => {
        reportError('入った人への案内を送れませんでした', error, member.guild);
        return 'failed' as const;
      });
      await logMemberJoin(member, invite, welcome ? WELCOME_RESULT_LABELS[welcome] : null);
    })
    .catch((error: unknown) => {
      reportError('参加のログを残せませんでした', error);
    });
});

client.on(Events.InviteCreate, (invite) => {
  handleInviteCreate(invite).catch((error: unknown) => {
    reportError('招待リンク作成のログを残せませんでした', error);
  });
});

client.on(Events.InviteDelete, (invite) => {
  handleInviteDelete(invite).catch((error: unknown) => {
    reportError('招待リンク削除のログを残せませんでした', error);
  });
});

// Discordの画面で直接行われた管理操作（ロールの付け外し・キック・BANなど）
client.on(Events.GuildAuditLogEntryCreate, (entry, guild) => {
  handleAuditLogEntry(entry, guild).catch((error: unknown) => {
    reportError('管理操作のログを残せませんでした', error);
  });
});

client.on(Events.GuildMemberRemove, (member) => {
  // プロフィールの後片付けをして、その結果も退出のログに残す
  handleMemberLeave(member).catch((error: unknown) => {
    reportError('退出の処理に失敗しました', error);
  });
});

client.on(Events.MessageCreate, (message) => {
  handleMessageXp(message).catch((error: unknown) => {
    reportError('発言の経験値を保存できませんでした', error);
  });
  // あとで消された・編集されたときに内容が分かるよう、発言を記録する
  recordMessage(message).catch((error: unknown) => {
    reportError('発言を記録できませんでした', error);
  });
  // 来た日を残し、「非アクティブ」が付いていれば外す
  noteMessageActivity(message).catch((error: unknown) => {
    reportError('発言した日を残せませんでした', error);
  });
});

client.on(Events.MessageDelete, (message) => {
  logMessageDelete(message).catch((error: unknown) => {
    reportError('メッセージ削除のログを残せませんでした', error);
  });
});

client.on(Events.MessageBulkDelete, (messages, channel) => {
  logMessageBulkDelete(messages, channel).catch((error: unknown) => {
    reportError('メッセージ一括削除のログを残せませんでした', error);
  });
});

client.on(Events.MessageUpdate, (oldMessage, newMessage) => {
  logMessageUpdate(oldMessage, newMessage).catch((error: unknown) => {
    reportError('メッセージ編集のログを残せませんでした', error);
  });
});

const replyError = async (interaction: Interaction, error: unknown): Promise<void> => {
  if (!interaction.isRepliable()) return;

  const content =
    error instanceof DiscordAPIError && error.code === RESTJSONErrorCodes.MissingPermissions
      ? 'Botの権限が足りません。Botのロールの権限（ロールの管理・メッセージの送信・メッセージ履歴を読む）と、Botのロールが進行度ロールより上にあるかを確認してください。'
      : 'エラーが発生しました。時間をおいて試してください。';

  try {
    if (interaction.deferred) {
      await interaction.editReply(content);
    } else if (interaction.replied) {
      await interaction.followUp({ content, flags: MessageFlags.Ephemeral });
    } else {
      await interaction.reply({ content, flags: MessageFlags.Ephemeral });
    }
  } catch (replyError) {
    console.error('エラーメッセージの送信に失敗しました:', replyError);
  }
};

// docker stop などで止められたとき、Discord と DB の接続を閉じてから終了する
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    console.log(`${signal} を受け取ったので終了します`);
    void Promise.allSettled([client.destroy(), closeDatabase()]).finally(() => process.exit(0));
  });
}

client.login(token).catch((error: unknown) => {
  console.error('ログインに失敗しました:', error);
  process.exit(1);
});
