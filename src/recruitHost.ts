import { randomBytes } from 'node:crypto';
import {
  ButtonStyle,
  LabelBuilder,
  ModalBuilder,
  StringSelectMenuBuilder,
  TextInputBuilder,
  TextInputStyle,
  UserSelectMenuBuilder,
  time,
  userMention,
  type Guild,
  type GuildMember,
  type ModalSubmitInteraction,
} from 'discord.js';
import { sendLog } from './activityLog.js';
import { DATA_CENTERS } from './dataCenters.js';
import { isAdmin } from './permissions.js';
import { toRow } from './profileInputs.js';
import { changeDuplicateRule, editSlot, leaveRecruit, type SlotEdit } from './recruitEngine.js';
import {
  REMIND_BEFORE_MS,
  archiveRecruitThread,
  notifyParticipants,
  participantIds,
  recruitCustomId,
  refreshRecruitPost,
  threadNote,
  withRecruitLock,
} from './recruitMessage.js';
import { jobLabel } from './recruitParty.js';
import { findRecruit, saveRecruit, type Recruit } from './recruitStore.js';
import {
  NO_JOB,
  button,
  closeModal,
  compactDay,
  dateScreen,
  deferScreen,
  displayName,
  editScreen,
  expandDay,
  externalModal,
  hourScreen,
  memberModal,
  minuteScreen,
  requireScreen,
  respond,
  slotListScreen,
  slotScreen,
  startTimeOf,
  startTimeProblem,
  type RecruitComponentInteraction,
  type Screen,
} from './recruitUi.js';
import { slotEditFromModal } from './recruitWizard.js';

// 主催メニュー（主催の人と管理者だけ）。操作のたびに「元に戻す」を出す（そのあとに誰かが変更していたら戻さない）

const NOT_FOUND = 'この募集は見つかりません。';
/** 「元に戻す」が使える時間 */
const UNDO_TTL_MS = 10 * 60_000;

interface UndoEntry {
  recruitId: string;
  /** 操作する前の募集 */
  snapshot: Recruit;
  /** 操作したあとの version。今の version と違えば、そのあとに変更があった */
  version: number;
  label: string;
  expiresAt: number;
}
const undoEntries = new Map<string, UndoEntry>();

const rememberUndo = (before: Recruit, after: Recruit, label: string): string => {
  const now = Date.now();
  for (const [token, entry] of undoEntries) if (entry.expiresAt < now) undoEntries.delete(token);
  const token = randomBytes(6).toString('base64url');
  undoEntries.set(token, { recruitId: after.id, snapshot: before, version: after.version, label, expiresAt: now + UNDO_TTL_MS });
  return token;
};

/** 主催メニューを使えないときの理由（使えるなら null） */
const hostProblem = (member: GuildMember, recruit: Recruit | null, allowEnded = false): string | null => {
  if (!recruit) return NOT_FOUND;
  if (recruit.hostId !== member.id && !isAdmin(member)) return '主催メニューは、募集した人と管理者だけが使えます。';
  if (!allowEnded && (recruit.status === 'cancelled' || recruit.status === 'finished')) return 'この募集はもう終わっているので、変更できません。';
  return null;
};

const head = (recruit: Recruit): string => `⚙️ **${recruit.title}** の主催メニュー（主催の人と管理者だけが使えます）`;

const hostMenu = (recruit: Recruit, note?: string, undoToken?: string): Screen => {
  const id = recruit.id;
  const undo = undoToken ? undoEntries.get(undoToken) : undefined;
  return {
    content: [
      head(recruit),
      ...(note ? [note] : []),
      `状態: ${recruit.status === 'open' ? '募集中' : '締切'} ／ 開始: ${time(recruit.startsAt, 'f')} ／ 主催: ${userMention(recruit.hostId)}`,
    ].join('\n'),
    components: [
      toRow(
        button(recruitCustomId('h', 'edit', id), '内容・ルール', ButtonStyle.Primary, '✏️'),
        button(recruitCustomId('h', 'time', id), '開始時刻', ButtonStyle.Primary, '🕘'),
        button(recruitCustomId('h', 'slots', id), '枠の設定', ButtonStyle.Primary, '🧩'),
        button(recruitCustomId('h', 'transfer', id), '主催を譲る', ButtonStyle.Secondary, '👑'),
      ),
      toRow(
        recruit.status === 'open'
          ? button(recruitCustomId('h', 'close', id), '締め切る', ButtonStyle.Secondary, '🚫')
          : button(recruitCustomId('h', 'reopen', id), '募集を再開', ButtonStyle.Secondary, '🔓'),
        button(recruitCustomId('h', 'kick', id), '参加者を外す', ButtonStyle.Secondary, '👋').setDisabled(recruit.participants.length === 0),
        button(recruitCustomId('h', 'cancel', id), '中止する', ButtonStyle.Danger, '🗑️'),
      ),
      ...(undo && undoToken ? [toRow(button(recruitCustomId('h', 'undo', id, undoToken), `元に戻す（${undo.label}）`, ButtonStyle.Secondary, '↩️'))] : []),
    ],
  };
};

const toMenu = (id: string) => button(recruitCustomId('p', 'host', id), '主催メニュー', ButtonStyle.Secondary, '◀');

/** 「主催メニュー」を押したとき */
export const openHost = async (interaction: RecruitComponentInteraction, id: string): Promise<void> => {
  const recruit = await findRecruit(id);
  const problem = hostProblem(interaction.member, recruit);
  await respond(interaction, problem || !recruit ? { content: problem ?? NOT_FOUND, components: [] } : hostMenu(recruit));
};

/**
 * 主催の操作の共通の流れ: 順番待ち → 読み直し → 権限の確認 → 変更 → 保存 → 投稿の書き換え → 主催メニュー（元に戻す付き）。
 * change は、変えたあとに出す一言を返す（変えられなかったら { error } を返す）
 */
const mutate = async (
  interaction: RecruitComponentInteraction | ModalSubmitInteraction<'cached'>,
  id: string,
  label: string,
  change: (recruit: Recruit) => Promise<{ note: string } | { error: string; screen?: Screen }>,
  options: { allowEnded?: boolean; screen?: (recruit: Recruit, note: string, token: string) => Screen } = {},
): Promise<void> => {
  await deferScreen(interaction);
  await withRecruitLock(id, async () => {
    const recruit = await findRecruit(id);
    const problem = hostProblem(interaction.member, recruit, options.allowEnded);
    if (problem || !recruit) {
      await editScreen(interaction, { content: problem ?? NOT_FOUND, components: [] });
      return;
    }
    const before = structuredClone(recruit);
    const result = await change(recruit);
    if ('error' in result) {
      await editScreen(interaction, result.screen ?? hostMenu(before, `⚠ ${result.error}`));
      return;
    }
    await saveRecruit(recruit);
    await refreshRecruitPost(interaction.guild, recruit);
    const token = rememberUndo(before, recruit, label);
    await editScreen(interaction, options.screen ? options.screen(recruit, result.note, token) : hostMenu(recruit, result.note, token));
  });
};

/** 「recruit:h:…」主催メニューの操作 */
export const handleHost = async (interaction: RecruitComponentInteraction, action: string, args: string[]): Promise<void> => {
  const id = args[0] ?? '';
  const { guild } = interaction;
  switch (action) {
    case 'edit': {
      const recruit = await findRecruit(id);
      const problem = hostProblem(interaction.member, recruit);
      if (problem || !recruit) {
        await respond(interaction, { content: problem ?? NOT_FOUND, components: [] });
        return;
      }
      await interaction.showModal(editModal(recruit));
      return;
    }
    case 'time':
    case 'slots':
    case 'transfer':
    case 'kick':
    case 'cancel': {
      const recruit = await findRecruit(id);
      const problem = hostProblem(interaction.member, recruit);
      if (problem || !recruit) {
        await respond(interaction, { content: problem ?? NOT_FOUND, components: [] });
        return;
      }
      await respond(interaction, subScreen(guild, recruit, action));
      return;
    }
    case 'close':
    case 'reopen':
      await mutate(interaction, id, action === 'close' ? '締め切り' : '再開', async (recruit) => {
        recruit.status = action === 'close' ? 'closed' : 'open';
        return { note: action === 'close' ? '🚫 募集を締め切りました（参加している人はそのままです）。' : '🔓 募集を再開しました。' };
      });
      return;
    case 'transfer-to': {
      const userId = interaction.isUserSelectMenu() ? interaction.values[0] : undefined;
      const member = userId ? await guild.members.fetch(userId).catch(() => null) : null;
      await mutate(interaction, id, '主催の変更', async (recruit) => {
        if (!member || member.user.bot) return { error: 'サーバーにいるメンバーを選んでください（Botは選べません）。' };
        if (member.id === recruit.hostId) return { error: 'その人はもう主催です。' };
        const previous = recruit.hostId;
        recruit.hostId = member.id;
        await threadNote(guild, recruit, `👑 主催が ${userMention(previous)} から ${userMention(member.id)} に変わりました`, [member.id]);
        void sendLog(guild, 'recruit', `${interaction.member} が募集の主催を譲りました`, interaction.member, {
          target: member,
          fields: [{ name: '🎮 コンテンツ', value: recruit.title, inline: true }],
        });
        return { note: `👑 主催を ${userMention(member.id)} に譲りました。` };
      });
      return;
    }
    case 'kick-select': {
      const userId = interaction.isStringSelectMenu() ? interaction.values[0] : undefined;
      await mutate(interaction, id, '参加者を外す', async (recruit) => {
        if (!userId || !recruit.participants.some((p) => p.userId === userId)) return { error: 'その人はもう参加していません。' };
        recruit.participants = leaveRecruit(recruit, userId);
        await threadNote(guild, recruit, `👋 ${userMention(userId)} が主催によって外されました`);
        return { note: `👋 ${displayName(guild, userId)} さんを外しました。` };
      });
      return;
    }
    case 'cancel-yes':
      await mutate(
        interaction,
        id,
        '中止',
        async (recruit) => {
          recruit.status = 'cancelled';
          await notifyParticipants(guild, recruit, `❌ **${recruit.title}** は中止になりました。`);
          await archiveRecruitThread(guild, recruit);
          void sendLog(guild, 'recruit', `${interaction.member} が募集を中止しました`, interaction.member, {
            target: recruit.hostId,
            fields: [
              { name: '🎮 コンテンツ', value: recruit.title, inline: true },
              { name: '👥 参加していた人', value: participantIds(recruit).map(userMention).join(' ') || 'なし', inline: true },
            ],
          });
          return { note: `🗑️ **${recruit.title}** を中止しました。` };
        },
        {
          screen: (recruit, note, token) => ({
            content: note,
            components: [toRow(button(recruitCustomId('h', 'undo', recruit.id, token), '元に戻す（中止）', ButtonStyle.Secondary, '↩️'))],
          }),
        },
      );
      return;
    case 'undo':
      await undo(interaction, id, args[1] ?? '');
      return;
  }
};

/** 主催メニューから開く画面（開始時刻・枠の設定・主催を譲る・外す・中止の確認） */
const subScreen = (guild: Guild, recruit: Recruit, action: string): Screen => {
  const id = recruit.id;
  switch (action) {
    case 'time':
      return timeScreen(recruit);
    case 'slots':
      return slotListScreen(guild, id, recruit, `${head(recruit)}\n🧩 枠の設定`, [toMenu(id)]);
    case 'transfer':
      return {
        content: `${head(recruit)}\n主催を譲る相手を選んでください。譲ると、あなたは主催メニューを使えなくなります（管理者を除く）。`,
        components: [
          toRow(new UserSelectMenuBuilder().setCustomId(recruitCustomId('h', 'transfer-to', id)).setPlaceholder('新しい主催')),
          toRow(toMenu(id)),
        ],
      };
    case 'kick':
      return {
        content: `${head(recruit)}\n外す人を選んでください。`,
        components: [
          toRow(
            new StringSelectMenuBuilder()
              .setCustomId(recruitCustomId('h', 'kick-select', id))
              .setPlaceholder('外す人')
              .addOptions(
                recruit.participants.length > 0
                  ? recruit.participants.map((p) => ({
                      label: `${p.slot ?? '補欠'} ${displayName(guild, p.userId)}`.slice(0, 100),
                      description: jobLabel(p.job),
                      value: p.userId,
                    }))
                  : [{ label: 'まだ誰も参加していません', value: '-' }],
              ),
          ),
          toRow(toMenu(id)),
        ],
      };
    default:
      return {
        content: `${head(recruit)}\n本当に **${recruit.title}** を中止しますか？ 参加している人にはメンションで知らせます（10分以内なら元に戻せます）。`,
        components: [toRow(button(recruitCustomId('h', 'cancel-yes', id), '中止する', ButtonStyle.Danger), toMenu(id))],
      };
  }
};

// ---- 開始時刻

const timeScreen = (recruit: Recruit, note?: string): Screen =>
  dateScreen(recruit.id, `${head(recruit)}\n🕘 今の開始: ${time(recruit.startsAt, 'F')}`, {
    nav: [
      button(recruitCustomId('t', 'plus', recruit.id, '30'), '30分遅らせる', ButtonStyle.Secondary, '⏩'),
      button(recruitCustomId('t', 'plus', recruit.id, '60'), '1時間遅らせる', ButtonStyle.Secondary, '⏩'),
      toMenu(recruit.id),
    ],
    note,
  });

/** 「recruit:t:…:<募集ID>」開始時刻の変更 */
export const handleHostTime = async (interaction: RecruitComponentInteraction, action: string, args: string[]): Promise<void> => {
  const [id = '', compact = '', hourText, minuteText] = args;
  const day = compact ? expandDay(compact) : '';
  if (action === 'date' || action === 'hour' || action === 'hoursel') {
    const recruit = await findRecruit(id);
    const problem = hostProblem(interaction.member, recruit);
    if (problem || !recruit) {
      await respond(interaction, { content: problem ?? NOT_FOUND, components: [] });
      return;
    }
    const header = `${head(recruit)}\n🕘 今の開始: ${time(recruit.startsAt, 'F')}`;
    if (action === 'date') {
      await respond(interaction, hourScreen(id, header, day, null, [button(recruitCustomId('h', 'time', id), '日付へ戻る', ButtonStyle.Secondary, '◀')]));
      return;
    }
    const hour = Number(action === 'hour' ? hourText : interaction.isStringSelectMenu() ? interaction.values[0] : 0);
    await respond(
      interaction,
      minuteScreen(id, header, day, hour, null, [button(recruitCustomId('t', 'date', id, compactDay(day)), '時間へ戻る', ButtonStyle.Secondary, '◀')]),
    );
    return;
  }

  await mutate(interaction, id, '開始時刻の変更', async (recruit) => {
    const startsAt =
      action === 'now'
        ? new Date()
        : action === 'plus'
          ? new Date(recruit.startsAt.getTime() + Number(compact) * 60_000)
          : startTimeOf(day, Number(hourText), Number(minuteText));
    const problem = startTimeProblem(startsAt);
    if (problem) return { error: problem, screen: timeScreen(recruit, `⚠ ${problem}`) };
    recruit.startsAt = startsAt;
    recruit.reminded = startsAt.getTime() - Date.now() <= REMIND_BEFORE_MS;
    await notifyParticipants(interaction.guild, recruit, `🕘 **${recruit.title}** の開始日時が ${time(startsAt, 'F')} に変わりました。`);
    return { note: `🕘 開始を ${time(startsAt, 'F')} に変えました（参加者に知らせました）。` };
  });
};

// ---- 内容・ルール

const editModal = (recruit: Recruit): ModalBuilder => {
  const title = new TextInputBuilder().setCustomId('title').setStyle(TextInputStyle.Short).setMaxLength(60).setRequired(true).setValue(recruit.title);
  const comment = new TextInputBuilder().setCustomId('comment').setStyle(TextInputStyle.Paragraph).setMaxLength(500).setRequired(false);
  if (recruit.comment) comment.setValue(recruit.comment);
  return new ModalBuilder()
    .setCustomId(recruitCustomId('h', 'edit-submit', recruit.id))
    .setTitle('募集の内容・ルール')
    .addLabelComponents(
      new LabelBuilder().setLabel('タイトル（コンテンツ）').setTextInputComponent(title),
      new LabelBuilder().setLabel('コメント（任意）').setTextInputComponent(comment),
      new LabelBuilder()
        .setLabel('DC')
        .setStringSelectMenuComponent(
          new StringSelectMenuBuilder()
            .setCustomId('dc')
            .setRequired(true)
            .addOptions(
              { label: '指定しない', value: NO_JOB, default: recruit.dataCenter === null },
              ...DATA_CENTERS.map((dc) => ({ label: dc.name, value: dc.name, default: dc.name === recruit.dataCenter })),
            ),
        ),
      new LabelBuilder()
        .setLabel('ジョブ重複')
        .setDescription('「なし」にすると、同じジョブの人は1人まで（重なった人は補欠になります）')
        .setStringSelectMenuComponent(
          new StringSelectMenuBuilder()
            .setCustomId('dup')
            .setRequired(true)
            .addOptions(
              { label: 'なし（同じジョブは1人まで）', value: 'off', default: !recruit.allowDuplicateJobs },
              { label: 'あり', value: 'on', default: recruit.allowDuplicateJobs },
            ),
        ),
    );
};

/** 主催の操作のモーダル（内容・ルール、枠の設定） */
export const handleHostModal = async (interaction: ModalSubmitInteraction<'cached'>, scope: string, action: string, args: string[]): Promise<void> => {
  const id = args[0] ?? '';
  if (scope === 's') {
    await applySlotEdit(interaction, id, args[1] ?? '', slotEditFromModal(interaction, action));
    return;
  }
  await mutate(interaction, id, '内容の変更', async (recruit) => {
    recruit.title = interaction.fields.getTextInputValue('title').trim();
    recruit.comment = interaction.fields.getTextInputValue('comment').trim();
    const dc = interaction.fields.getStringSelectValues('dc')[0];
    recruit.dataCenter = dc && dc !== NO_JOB ? dc : null;
    const allowDuplicateJobs = interaction.fields.getStringSelectValues('dup')[0] === 'on';
    let displaced: string[] = [];
    if (allowDuplicateJobs !== recruit.allowDuplicateJobs) {
      const result = changeDuplicateRule(recruit, allowDuplicateJobs);
      Object.assign(recruit, result.config);
      displaced = result.displaced;
      if (displaced.length > 0) {
        await notifyParticipants(interaction.guild, recruit, `⚠ ジョブ重複なしになったので、補欠になりました（ほかのジョブがあれば「参加メニュー」から変えてください）: **${recruit.title}**`, displaced);
      }
    }
    return {
      note: ['✅ 内容を変えました。', ...displaced.map((uid) => `⚠ ${displayName(interaction.guild, uid)} さんはジョブが重なるため補欠になりました。`)].join('\n'),
    };
  });
};

// ---- 枠の設定（ジョブ指定・事前埋まり・〆）

/** 「recruit:s:…:<募集ID>」枠の設定 */
export const handleHostSlot = async (interaction: RecruitComponentInteraction, action: string, args: string[]): Promise<void> => {
  const [id = '', argKey] = args;
  const key = argKey ?? (interaction.isStringSelectMenu() && action === 'pick' ? interaction.values[0] : undefined);
  const recruit = await findRecruit(id);
  const problem = hostProblem(interaction.member, recruit);
  if (problem || !recruit) {
    await respond(interaction, { content: problem ?? NOT_FOUND, components: [] });
    return;
  }
  const slot = recruit.slots.find((s) => s.key === key);
  const header = `${head(recruit)}\n🧩 枠の設定`;
  switch (action) {
    case 'list':
      await respond(interaction, subScreen(interaction.guild, recruit, 'slots'));
      return;
    case 'pick':
      await respond(interaction, key ? slotScreen(interaction.guild, id, recruit, key, header) : subScreen(interaction.guild, recruit, 'slots'));
      return;
    case 'req':
      await respond(interaction, slot ? requireScreen(id, slot, header) : subScreen(interaction.guild, recruit, 'slots'));
      return;
    case 'member':
    case 'ext':
    case 'close':
      if (!slot) return;
      await interaction.showModal(action === 'member' ? memberModal(id, slot) : action === 'ext' ? externalModal(id, slot) : closeModal(id, slot));
      return;
    case 'reqsel':
    case 'clear': {
      if (!key) return;
      const picked = interaction.isStringSelectMenu() ? interaction.values[0] : undefined;
      await applySlotEdit(interaction, id, key, action === 'clear' ? { type: 'clear' } : { type: 'require', job: picked && picked !== NO_JOB ? picked : null });
      return;
    }
  }
};

const applySlotEdit = async (
  interaction: RecruitComponentInteraction | ModalSubmitInteraction<'cached'>,
  id: string,
  key: string,
  edit: SlotEdit,
): Promise<void> => {
  const { guild } = interaction;
  const member = edit.type === 'member' && edit.userId ? await guild.members.fetch(edit.userId).catch(() => null) : null;
  await mutate(
    interaction,
    id,
    `${key} の設定`,
    async (recruit) => {
      const header = `${head(recruit)}\n🧩 枠の設定`;
      if (edit.type === 'member' && (!member || member.user.bot)) {
        return { error: 'サーバーにいるメンバーを選んでください。', screen: slotScreen(guild, id, recruit, key, header, '⚠ サーバーにいるメンバーを選んでください（Botは選べません）。') };
      }
      const result = editSlot(recruit, key, edit);
      if (!result.ok) return { error: result.reason, screen: slotScreen(guild, id, recruit, key, header, `⚠ ${result.reason}`) };
      Object.assign(recruit, result.config);
      if (edit.type === 'member' && member) await threadNote(guild, recruit, `👤 主催が ${userMention(member.id)} を **${key}** に入れました`, [member.id]);
      if (result.displaced.length > 0) {
        await notifyParticipants(guild, recruit, `⚠ 枠の設定が変わり、入れる枠がなくなったので補欠になりました: **${recruit.title}**`, result.displaced);
      }
      return {
        note: [`✅ ${key} を設定しました。`, ...result.displaced.map((uid) => `⚠ ${displayName(guild, uid)} さんは入れる枠がなくなり、補欠になりました。`)].join('\n'),
      };
    },
    {
      screen: (recruit, note, token) => {
        const screen = slotListScreen(guild, id, recruit, `${head(recruit)}\n🧩 枠の設定`, [
          toMenu(id),
          button(recruitCustomId('h', 'undo', id, token), '元に戻す', ButtonStyle.Secondary, '↩️'),
        ], note);
        return screen;
      },
    },
  );
};

// ---- 元に戻す

const undo = async (interaction: RecruitComponentInteraction, id: string, token: string): Promise<void> => {
  await deferScreen(interaction);
  await withRecruitLock(id, async () => {
    const entry = undoEntries.get(token);
    const recruit = await findRecruit(id);
    const problem = hostProblem(interaction.member, recruit, true);
    if (problem || !recruit) {
      await editScreen(interaction, { content: problem ?? NOT_FOUND, components: [] });
      return;
    }
    if (!entry || entry.recruitId !== id || entry.expiresAt < Date.now()) {
      await editScreen(interaction, hostMenuOrEnded(recruit, '⚠ 元に戻せる時間（10分）を過ぎたか、もう元に戻しました。'));
      return;
    }
    if (entry.version !== recruit.version) {
      await editScreen(interaction, hostMenuOrEnded(recruit, '⚠ そのあとに参加・変更があったので、元に戻せません（今の内容を壊さないため）。'));
      return;
    }
    undoEntries.delete(token);
    const { snapshot } = entry;
    const reopened = (recruit.status === 'cancelled' || recruit.status === 'finished') && (snapshot.status === 'open' || snapshot.status === 'closed');
    Object.assign(recruit, {
      hostId: snapshot.hostId,
      title: snapshot.title,
      comment: snapshot.comment,
      startsAt: snapshot.startsAt,
      dataCenter: snapshot.dataCenter,
      allowDuplicateJobs: snapshot.allowDuplicateJobs,
      slots: snapshot.slots,
      participants: snapshot.participants,
      status: snapshot.status,
      reminded: snapshot.reminded,
    });
    await saveRecruit(recruit);
    await refreshRecruitPost(interaction.guild, recruit);
    await threadNote(interaction.guild, recruit, `↩️ 主催が直前の操作（${entry.label}）を元に戻しました`);
    if (reopened) await notifyParticipants(interaction.guild, recruit, `↩️ **${recruit.title}** の中止は取り消されました（募集は続きます）。`);
    await editScreen(interaction, hostMenu(recruit, `↩️ ${entry.label} を元に戻しました。`));
  });
};

const hostMenuOrEnded = (recruit: Recruit, note: string): Screen =>
  recruit.status === 'cancelled' || recruit.status === 'finished' ? { content: note, components: [] } : hostMenu(recruit, note);
