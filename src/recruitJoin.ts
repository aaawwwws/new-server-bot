import {
  ButtonStyle,
  ComponentType,
  LabelBuilder,
  ModalBuilder,
  StringSelectMenuBuilder,
  TextInputBuilder,
  TextInputStyle,
  time,
  userMention,
  type Guild,
  type GuildMember,
  type Message,
  type ModalSubmitInteraction,
} from 'discord.js';
import { JOBS } from './jobs.js';
import { toRow } from './profileInputs.js';
import { describeSlotState, isFull, isOpenSlot, joinRecruit, leaveRecruit, type RecruitParticipant } from './recruitEngine.js';
import {
  notifyParticipants,
  partyOf,
  placedIds,
  recruitCustomId,
  refreshRecruitPost,
  threadNote,
  withRecruitLock,
} from './recruitMessage.js';
import { jobLabel, jobsForRole } from './recruitParty.js';
import { findRecruit, saveRecruit, type Recruit } from './recruitStore.js';
import {
  NOT_ALLOWED,
  button,
  canUseRecruit,
  deferScreen,
  displayName,
  editScreen,
  fromMask,
  jobsToMask,
  maskToJobs,
  respond,
  toMask,
  type RecruitComponentInteraction,
  type Screen,
} from './recruitUi.js';

// 参加する（入ってよい枠とジョブを選ぶ）・参加メニュー（参加内容の変更・コメント・取り消し）。
// 選んでいる途中の枠とジョブはBotに持たず、画面のメニューから読むので、再起動しても続きから操作できる

const NOT_FOUND = 'この募集は見つかりません。';
const MAX_COMMENT_LENGTH = 100;

interface Selection {
  positions: string[];
  jobs: string[];
}

/** 新しく参加できないときの理由（参加済みの人の変更は、締め切ったあとでもできる） */
const joinProblem = (member: GuildMember, recruit: Recruit | null): string | null => {
  if (!recruit) return NOT_FOUND;
  const joined = recruit.participants.some((p) => p.userId === member.id);
  if (recruit.status === 'cancelled' || recruit.status === 'finished') return 'この募集はもう終わっています。';
  if (!joined && recruit.status === 'closed') return 'この募集は締め切られています。';
  if (!canUseRecruit(member)) return NOT_ALLOWED;
  if (!joined && isFull(recruit)) return 'この募集は満員です。';
  return null;
};

/** 「参加する」を押したとき */
export const openJoin = async (interaction: RecruitComponentInteraction, id: string): Promise<void> => {
  const recruit = await findRecruit(id);
  const problem = joinProblem(interaction.member, recruit);
  if (problem || !recruit) {
    await respond(interaction, { content: problem ?? NOT_FOUND, components: [] });
    return;
  }
  await respond(interaction, joinScreen(interaction.guild, recruit, interaction.user.id, currentSelection(recruit, interaction.user.id)));
};

/** 参加済みなら今の参加内容、まだならロールの枠の空いているところから */
const currentSelection = (recruit: Recruit, userId: string): Selection => {
  const mine = recruit.participants.find((p) => p.userId === userId);
  return mine ? { positions: mine.positions, jobs: mine.jobs } : { positions: [], jobs: [] };
};

const joinScreen = (guild: Guild, recruit: Recruit, userId: string, selection: Selection, note?: string): Screen => {
  const party = partyOf(recruit.party, recruit);
  const mine = recruit.participants.find((p) => p.userId === userId);
  const open = recruit.slots.filter(isOpenSlot);
  const chosenRoles = new Set(recruit.slots.filter((slot) => selection.positions.includes(slot.key)).map((slot) => slot.role));
  const jobs = party.hasRoles && chosenRoles.size > 0 ? JOBS.filter((job) => [...chosenRoles].some((role) => jobsForRole(role).includes(job))) : JOBS;

  const positionSelect = new StringSelectMenuBuilder()
    .setCustomId(recruitCustomId('j', 'pos', recruit.id))
    .setPlaceholder('入ってよい枠（2つ以上選ぶとFLEX）')
    .setMinValues(0)
    .setMaxValues(Math.max(open.length, 1))
    .addOptions(
      open.length > 0
        ? open.map((slot) => ({
            label: slot.key,
            description: describeSlotState(recruit, slot)
              .replace(/<@(\d+)>/g, (_, uid: string) => displayName(guild, uid))
              .slice(0, 100),
            value: slot.key,
            default: selection.positions.includes(slot.key),
          }))
        : [{ label: '入れる枠がありません', value: '-' }],
    );
  const jobSelect = new StringSelectMenuBuilder()
    .setCustomId(recruitCustomId('j', 'job', recruit.id))
    .setPlaceholder('使えるジョブ（いくつでも。選ばなければ未定）')
    .setMinValues(0)
    .setMaxValues(jobs.length)
    .addOptions(jobs.map((job) => ({ label: job.name, value: job.key, default: selection.jobs.includes(job.key) })));

  return {
    content: [
      `✋ **${recruit.title}** に${mine ? '参加しています。参加内容を変えられます' : '参加します'}。`,
      ...(note ? [note] : []),
      ...(party.hasRoles ? ['入ってよい枠を選んでください。2つ以上選ぶと **FLEX** になり、空いている方に自動で入ります。'] : []),
      '使えるジョブを選んでください（いくつでも。2つ以上選ぶと、空いている枠・ジョブ重複に合わせて自動で決まります）。',
      ...(mine ? [`今: ${mine.slot ? `**${party.hasRoles ? mine.slot : '参加'}**（${jobLabel(mine.job)}）` : '補欠'}`] : []),
    ].join('\n'),
    components: [
      ...(party.hasRoles ? [toRow(positionSelect)] : []),
      toRow(jobSelect),
      toRow(
        button(recruitCustomId('j', 'ok', recruit.id), mine ? 'この内容に変える' : 'この内容で参加', ButtonStyle.Success, '✅'),
        button(recruitCustomId('j', 'okc', recruit.id), mine ? 'コメントも直して変える' : 'コメントを付けて参加', ButtonStyle.Primary, '💬'),
      ),
    ],
  };
};

/** 画面のメニューで選ばれている枠とジョブ */
const readSelection = (message: Message): Selection => {
  const selects = message.components
    .flatMap((row) => (row.type === ComponentType.ActionRow ? row.components : []))
    .flatMap((component) => (component.type === ComponentType.StringSelect ? [component] : []));
  const picked = (action: string) =>
    selects.find((select) => select.customId.startsWith(`recruit:j:${action}:`))?.options.filter((o) => o.default).map((o) => o.value) ?? [];
  return { positions: picked('pos'), jobs: picked('job') };
};

/** 「recruit:j:…」参加の画面の操作 */
export const handleJoin = async (interaction: RecruitComponentInteraction, action: string, id: string): Promise<void> => {
  const selection = readSelection(interaction.message);
  const values = interaction.isStringSelectMenu() ? interaction.values.filter((v) => v !== '-') : [];
  switch (action) {
    case 'pos':
    case 'job': {
      const recruit = await findRecruit(id);
      if (!recruit) {
        await respond(interaction, { content: NOT_FOUND, components: [] });
        return;
      }
      const next: Selection = action === 'pos' ? { positions: values, jobs: selection.jobs } : { positions: selection.positions, jobs: values };
      // 選んだ枠のロールに合わなくなったジョブは外す
      if (action === 'pos' && next.positions.length > 0) {
        const roles = recruit.slots.filter((slot) => next.positions.includes(slot.key)).map((slot) => slot.role);
        next.jobs = next.jobs.filter((job) => roles.some((role) => jobsForRole(role).some((j) => j.key === job)));
      }
      await respond(interaction, joinScreen(interaction.guild, recruit, interaction.user.id, next));
      return;
    }
    case 'ok':
      await submitJoin(interaction, id, selection, undefined);
      return;
    case 'okc': {
      const recruit = await findRecruit(id);
      const current = recruit?.participants.find((p) => p.userId === interaction.user.id)?.comment ?? '';
      const slotIndexes = selection.positions.map((key) => recruit?.slots.findIndex((slot) => slot.key === key) ?? -1).filter((i) => i >= 0);
      await interaction.showModal(commentModal(recruitCustomId('j', 'cs', id, toMask(slotIndexes) || '0', jobsToMask(selection.jobs) || '0'), current));
      return;
    }
  }
};

const commentModal = (customId: string, current: string): ModalBuilder => {
  const input = new TextInputBuilder()
    .setCustomId('comment')
    .setStyle(TextInputStyle.Short)
    .setPlaceholder('例: 初見です / 聞き専です / 22時から参加')
    .setMaxLength(MAX_COMMENT_LENGTH)
    .setRequired(false);
  if (current) input.setValue(current);
  return new ModalBuilder()
    .setCustomId(customId)
    .setTitle('参加コメント')
    .addLabelComponents(new LabelBuilder().setLabel('一言（任意）').setDescription('募集の投稿に表示されます。空にすると消えます').setTextInputComponent(input));
};

/** 「recruit:j:cs」「recruit:m:cs」コメントのモーダル */
export const handleJoinModal = async (interaction: ModalSubmitInteraction<'cached'>, scope: string, args: string[]): Promise<void> => {
  const [id = '', positionMask = '0', jobMask = '0'] = args;
  const comment = interaction.fields.getTextInputValue('comment').trim();
  if (scope === 'j') {
    const recruit = await findRecruit(id);
    const positions = fromMask(positionMask).flatMap((i) => (recruit?.slots[i] ? [recruit.slots[i].key] : []));
    await submitJoin(interaction, id, { positions, jobs: maskToJobs(jobMask) }, comment);
    return;
  }
  // 参加メニューからのコメントの変更
  await deferScreen(interaction);
  await withRecruitLock(id, async () => {
    const recruit = await findRecruit(id);
    const mine = recruit?.participants.find((p) => p.userId === interaction.user.id);
    if (!recruit || !mine) {
      await editScreen(interaction, { content: recruit ? 'この募集には参加していません。' : NOT_FOUND, components: [] });
      return;
    }
    mine.comment = comment || null;
    await saveRecruit(recruit);
    await refreshRecruitPost(interaction.guild, recruit);
    await editScreen(interaction, menuScreen(recruit, interaction.user.id, comment ? '💬 コメントを変えました。' : '💬 コメントを消しました。'));
  });
};

/** 選んだ枠とジョブで参加する（参加済みなら変更）。入れる枠がなければ、理由を出して選び直してもらう */
const submitJoin = async (
  interaction: RecruitComponentInteraction | ModalSubmitInteraction<'cached'>,
  id: string,
  selection: Selection,
  comment: string | undefined,
): Promise<void> => {
  await deferScreen(interaction);
  await withRecruitLock(id, async () => {
    const { guild, user, member } = interaction;
    const recruit = await findRecruit(id);
    const problem = joinProblem(member, recruit);
    if (problem || !recruit) {
      await editScreen(interaction, { content: problem ?? NOT_FOUND, components: [] });
      return;
    }
    const party = partyOf(recruit.party, recruit);
    const positions = party.hasRoles ? selection.positions.filter((key) => recruit.slots.some((slot) => slot.key === key)) : recruit.slots.map((slot) => slot.key);
    if (positions.length === 0) {
      await editScreen(interaction, joinScreen(guild, recruit, user.id, selection, '⚠ 入ってよい枠を選んでください。'));
      return;
    }
    const before = recruit.participants;
    const existing = before.find((p) => p.userId === user.id);
    const result = joinRecruit(recruit, {
      userId: user.id,
      positions,
      jobs: selection.jobs,
      comment: comment === undefined ? (existing?.comment ?? null) : comment || null,
    });
    if (!result.ok) {
      await editScreen(interaction, joinScreen(guild, recruit, user.id, selection, `⚠ ${result.reason}${existing ? '（前の参加内容のままです）' : ''}`));
      return;
    }

    const wasFull = isFull(recruit);
    recruit.participants = result.participants;
    await saveRecruit(recruit);
    await refreshRecruitPost(guild, recruit);

    const where = placementText(party.hasRoles, result.placed);
    const moved = movedPeople(before, result.participants, user.id);
    await threadNote(
      guild,
      recruit,
      [
        existing ? `✏️ ${userMention(user.id)} が参加内容を変えました → ${where}` : `✋ ${userMention(user.id)} が ${where} で参加しました`,
        ...moved.map((m) => `🔁 FLEXで ${userMention(m.userId)} が ${m.from} → ${m.to} に移りました`),
      ].join('\n'),
      existing ? [] : [user.id],
    );
    if (!wasFull && isFull(recruit)) {
      await notifyParticipants(guild, recruit, `🎉 **${recruit.title}** のメンバーが揃いました！（${time(recruit.startsAt, 'f')} 開始）`, [
        ...new Set([recruit.hostId, ...placedIds(recruit)]),
      ]);
    }
    await editScreen(interaction, {
      content: [
        `✅ **${recruit.title}** に ${where} で${existing ? '変えました' : '参加しました'}。`,
        '変更・コメント・取り消しは、募集の「参加メニュー」からできます。',
      ].join('\n'),
      components: [toRow(button(recruitCustomId('p', 'menu', recruit.id), '参加メニュー', ButtonStyle.Secondary, '📋'))],
    });
  });
};

const placementText = (hasRoles: boolean, placed: RecruitParticipant): string =>
  `${hasRoles ? `**${placed.slot}**` : '**参加**'}（${jobLabel(placed.job)}）${hasRoles && placed.positions.length > 1 ? ` FLEX: ${placed.positions.join('/')}` : ''}`;

/** FLEXの割り振り直しで、ほかの人の枠が変わったところ */
const movedPeople = (before: RecruitParticipant[], after: RecruitParticipant[], except: string) =>
  after.flatMap((p) => {
    const old = before.find((b) => b.userId === p.userId);
    return p.userId !== except && old?.slot && p.slot && old.slot !== p.slot ? [{ userId: p.userId, from: old.slot, to: p.slot }] : [];
  });

// ---- 参加メニュー

export const openMenu = async (interaction: RecruitComponentInteraction, id: string): Promise<void> => {
  const recruit = await findRecruit(id);
  await respond(interaction, recruit ? menuScreen(recruit, interaction.user.id) : { content: NOT_FOUND, components: [] });
};

const menuScreen = (recruit: Recruit, userId: string, note?: string): Screen => {
  const party = partyOf(recruit.party, recruit);
  const mine = recruit.participants.find((p) => p.userId === userId);
  if (!mine) {
    return {
      content: [...(note ? [note] : []), `**${recruit.title}** にはまだ参加していません。`].join('\n'),
      components: recruit.status === 'open' ? [toRow(button(recruitCustomId('p', 'join', recruit.id), '参加する', ButtonStyle.Success, '✋'))] : [],
    };
  }
  return {
    content: [
      `📋 **${recruit.title}** の参加メニュー`,
      ...(note ? [note] : []),
      `今: ${mine.slot ? placementText(party.hasRoles, mine) : '⏳ 補欠（枠が空くと自動で入ります）'}`,
      ...(party.hasRoles ? [`入ってよい枠: ${mine.positions.join('・')}`] : []),
      `使えるジョブ: ${mine.jobs.length > 0 ? mine.jobs.map(jobLabel).join('・') : '未定'}`,
      `コメント: ${mine.comment ?? 'なし'}`,
    ].join('\n'),
    components: [
      toRow(
        button(recruitCustomId('m', 'edit', recruit.id), '参加内容を変える', ButtonStyle.Primary, '✏️'),
        button(recruitCustomId('m', 'comment', recruit.id), 'コメント', ButtonStyle.Secondary, '💬'),
        button(recruitCustomId('m', 'leave', recruit.id), '参加を取り消す', ButtonStyle.Danger, '↩️'),
      ),
    ],
  };
};

/** 「recruit:m:…」参加メニューの操作 */
export const handleMenu = async (interaction: RecruitComponentInteraction, action: string, id: string): Promise<void> => {
  switch (action) {
    case 'edit': {
      const recruit = await findRecruit(id);
      const problem = joinProblem(interaction.member, recruit);
      if (problem || !recruit) {
        await respond(interaction, { content: problem ?? NOT_FOUND, components: [] });
        return;
      }
      await respond(interaction, joinScreen(interaction.guild, recruit, interaction.user.id, currentSelection(recruit, interaction.user.id)));
      return;
    }
    case 'comment': {
      const recruit = await findRecruit(id);
      await interaction.showModal(
        commentModal(recruitCustomId('m', 'cs', id), recruit?.participants.find((p) => p.userId === interaction.user.id)?.comment ?? ''),
      );
      return;
    }
    case 'leave':
      await leave(interaction, id);
      return;
  }
};

const leave = async (interaction: RecruitComponentInteraction, id: string): Promise<void> => {
  await deferScreen(interaction);
  await withRecruitLock(id, async () => {
    const { guild, user } = interaction;
    const recruit = await findRecruit(id);
    if (!recruit || !recruit.participants.some((p) => p.userId === user.id)) {
      await editScreen(interaction, { content: recruit ? 'この募集には参加していません。' : NOT_FOUND, components: [] });
      return;
    }
    const before = recruit.participants;
    recruit.participants = leaveRecruit(recruit, user.id);
    await saveRecruit(recruit);
    await refreshRecruitPost(guild, recruit);
    // 空いた枠に補欠の人が入れたら、その人に知らせる
    const promoted = recruit.participants.filter((p) => p.slot && !before.find((b) => b.userId === p.userId)?.slot).map((p) => p.userId);
    await threadNote(guild, recruit, `↩️ ${userMention(user.id)} が参加を取り消しました`);
    if (promoted.length > 0) await notifyParticipants(guild, recruit, `✅ 枠が空いたので、補欠から入りました: **${recruit.title}**`, promoted);
    await editScreen(interaction, { content: `↩️ **${recruit.title}** への参加を取り消しました。`, components: [] });
  });
};
