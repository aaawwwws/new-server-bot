import {
  ButtonStyle,
  LabelBuilder,
  MessageFlags,
  ModalBuilder,
  RoleSelectMenuBuilder,
  StringSelectMenuBuilder,
  TextInputBuilder,
  TextInputStyle,
  roleMention,
  time,
  type Guild,
  type ModalSubmitInteraction,
} from 'discord.js';
import { sendLog } from './activityLog.js';
import { DATA_CENTERS } from './dataCenters.js';
import { JOBS } from './jobs.js';
import { formatDay } from './jst.js';
import { isAdmin } from './permissions.js';
import { toRow } from './profileInputs.js';
import { findStoredProfile } from './profileStore.js';
import {
  assignParticipants,
  changeDuplicateRule,
  createSlots,
  editSlot,
  isOpenSlot,
  type RecruitConfig,
  type RecruitParticipant,
  type SlotEdit,
} from './recruitEngine.js';
import {
  REMIND_BEFORE_MS,
  buildRecruitEmbed,
  buildRecruitPost,
  createRecruitThread,
  partyOf,
  recruitCustomId,
  scheduleRecruitListRefresh,
} from './recruitMessage.js';
import { bumpRecruitPanel } from './recruitPanelPost.js';
import { FREE_SIZES, jobLabel, jobsForRole, shortPartyLabel } from './recruitParty.js';
import {
  MAX_TEMPLATES,
  countTemplates,
  createRecruit,
  deleteDraft,
  deleteTemplate,
  findTemplate,
  listTemplates,
  loadDraft,
  saveDraft,
  saveRecruit,
  saveTemplate,
  type RecruitDraft,
  type RecruitTemplateData,
} from './recruitStore.js';
import {
  DRAFT_TARGET,
  NOT_ALLOWED,
  NO_JOB,
  button,
  canUseRecruit,
  choice,
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
  pickedJob,
  requireScreen,
  respond,
  slotListScreen,
  slotScreen,
  startTimeOf,
  startTimeProblem,
  type RecruitComponentInteraction,
  type Screen,
} from './recruitUi.js';

// 募集を作る手順（下書きをDBに残しながら、1画面ずつ進める。Botを再起動しても続きから作れる）
// 内容 → 形 → DC → 開始日 → 時 → 分 → 主催の参加 → 枠の設定 → メンション → 確認・投稿

const STEPS = ['party', 'dc', 'date', 'hour', 'minute', 'host', 'slots', 'mention', 'confirm'] as const;
type Step = (typeof STEPS)[number];
const STEP_LABELS: Record<Step, string> = {
  party: '募集の形',
  dc: 'DC',
  date: '開始日',
  hour: '開始時刻',
  minute: '開始時刻（分）',
  host: '主催の参加',
  slots: '枠の設定',
  mention: 'メンション',
  confirm: '確認',
};
const BASIC_MODAL_ID = recruitCustomId('w', 'basic');
const TEMPLATE_MODAL_ID = recruitCustomId('w', 'tplsub');
/** 主催は下書きの中で、いちばん先に参加した人として扱う */
const HOST_JOINED_AT = new Date(0).toISOString();
const MAX_MENTION_ROLES = 5;

/** パネルの「募集を作成」。テンプレートや作りかけがあれば選ぶ画面、なければすぐ入力 */
export const openCreate = async (interaction: RecruitComponentInteraction): Promise<void> => {
  if (!canUseRecruit(interaction.member)) {
    await respond(interaction, { content: NOT_ALLOWED, components: [] });
    return;
  }
  const [templates, draft] = await Promise.all([listTemplates(interaction.guild.id), loadDraft(interaction.guild.id, interaction.user.id)]);
  if (templates.length === 0 && !draft) {
    await interaction.showModal(basicModal());
    return;
  }
  await respond(interaction, createScreen(interaction, templates, !!draft));
};

const createScreen = (
  interaction: RecruitComponentInteraction | ModalSubmitInteraction<'cached'>,
  templates: { id: string; name: string; createdBy: string; data: RecruitTemplateData }[],
  hasDraft: boolean,
  note?: string,
): Screen => {
  const deletable = templates.filter((t) => t.createdBy === interaction.user.id || isAdmin(interaction.member));
  return {
    content: [
      '📣 **パーティ募集を作る**',
      ...(note ? [note] : []),
      ...(templates.length > 0 ? ['テンプレートから作ると、内容・形・枠の設定・時刻が入った状態から始まります。'] : []),
    ].join('\n'),
    components: [
      ...(templates.length > 0
        ? [
            toRow(
              new StringSelectMenuBuilder()
                .setCustomId(recruitCustomId('w', 'tpl'))
                .setPlaceholder('テンプレートから作る')
                .addOptions(
                  templates.map((t) => ({ label: t.name.slice(0, 100), description: `${t.data.title}・${shortPartyLabel(t.data.party)}`.slice(0, 100), value: t.id })),
                ),
            ),
          ]
        : []),
      toRow(
        button(recruitCustomId('w', 'new'), '新しく作る', ButtonStyle.Success, '✏️'),
        ...(hasDraft ? [button(recruitCustomId('w', 'resume'), '作りかけの続きから', ButtonStyle.Primary, '▶')] : []),
        ...(deletable.length > 0 ? [button(recruitCustomId('w', 'tpldel-menu'), 'テンプレートを消す', ButtonStyle.Danger, '🗑️')] : []),
      ),
    ],
  };
};

const basicModal = (draft?: RecruitDraft | null): ModalBuilder => {
  const title = new TextInputBuilder()
    .setCustomId('title')
    .setStyle(TextInputStyle.Short)
    .setPlaceholder('例: 絶エデン 練習 / 零式4層 消化 / 地図')
    .setMaxLength(60)
    .setRequired(true);
  const comment = new TextInputBuilder()
    .setCustomId('comment')
    .setStyle(TextInputStyle.Paragraph)
    .setPlaceholder('例: 初見歓迎！ VCあり・聞き専OK')
    .setMaxLength(500)
    .setRequired(false);
  if (draft?.title) title.setValue(draft.title);
  if (draft?.comment) comment.setValue(draft.comment);
  return new ModalBuilder()
    .setCustomId(BASIC_MODAL_ID)
    .setTitle('パーティ募集を作成')
    .addLabelComponents(
      new LabelBuilder().setLabel('タイトル（コンテンツ）').setTextInputComponent(title),
      new LabelBuilder().setLabel('コメント（任意）').setTextInputComponent(comment),
    );
};

const newDraft = async (interaction: RecruitComponentInteraction | ModalSubmitInteraction<'cached'>): Promise<RecruitDraft> => {
  // DCは、登録しているプロフィールのDCから始める
  const profile = await findStoredProfile(interaction.guild.id, interaction.user.id).catch(() => null);
  return {
    channelId: interaction.channelId ?? '',
    title: '',
    comment: '',
    party: 'full',
    dataCenter: profile?.profile.dataCenter ?? null,
    allowDuplicateJobs: false,
    mentionRoleIds: [],
    date: null,
    hour: null,
    minute: null,
    startNow: false,
    slots: createSlots('full'),
    participants: [],
  };
};

// ---- 画面

const header = (draft: RecruitDraft, step: Step): string =>
  [`📣 **募集の作成**（${STEPS.indexOf(step) + 1}/${STEPS.length}: ${STEP_LABELS[step]}）`, `> ${summary(draft)}`].join('\n');

const summary = (draft: RecruitDraft): string =>
  [
    `**${draft.title || 'タイトル未入力'}**`,
    `${shortPartyLabel(draft.party)}・${draft.allowDuplicateJobs ? 'ジョブ重複あり' : 'ジョブ重複なし'}`,
    draft.dataCenter ?? 'DC指定なし',
    startText(draft),
  ].join(' ／ ');

const startText = (draft: RecruitDraft): string => {
  if (draft.startNow) return '開始: 今すぐ';
  if (!draft.date) return '開始: 未定';
  return `開始: ${formatDay(draft.date)}${draft.hour !== null ? ` ${draft.hour}:${String(draft.minute ?? 0).padStart(2, '0')}` : ''}`;
};

const startsAtOf = (draft: RecruitDraft): Date | null => {
  if (draft.startNow) return new Date();
  if (!draft.date || draft.hour === null || draft.minute === null) return null;
  return startTimeOf(draft.date, draft.hour, draft.minute);
};

const go = (step: Step, label: string, style: ButtonStyle = ButtonStyle.Secondary, emoji?: string) =>
  button(recruitCustomId('w', 'go', step), label, style, emoji);
const back = (step: Step) => go(step, '戻る', ButtonStyle.Secondary, '◀');
const next = (step: Step) => go(step, '次へ', ButtonStyle.Success, '▶');

const stepScreen = (guild: Guild, userId: string, draft: RecruitDraft, step: Step, note?: string): Screen => {
  const head = header(draft, step);
  const withNote = (text: string) => [head, ...(note ? [note] : []), text].join('\n');
  switch (step) {
    case 'party': {
      const free = new StringSelectMenuBuilder()
        .setCustomId(recruitCustomId('w', 'partyfree'))
        .setPlaceholder('人数だけ決める（ロール不問）')
        .addOptions(FREE_SIZES.map((size) => ({ label: `人数だけ: ${size}人`, value: `free${size}`, default: draft.party === `free${size}` })));
      return {
        content: withNote('募集の形を選んでください。「ジョブ重複なし」にすると、同じジョブの人は1人までになります。'),
        components: [
          toRow(
            choice(recruitCustomId('w', 'party', 'full'), 'フルパーティ（8人）', draft.party === 'full'),
            choice(recruitCustomId('w', 'party', 'light'), 'ライトパーティ（4人）', draft.party === 'light'),
          ),
          toRow(free),
          toRow(
            choice(recruitCustomId('w', 'dup', 'off'), 'ジョブ重複なし', !draft.allowDuplicateJobs),
            choice(recruitCustomId('w', 'dup', 'on'), 'ジョブ重複あり', draft.allowDuplicateJobs),
          ),
          toRow(button(recruitCustomId('w', 'basic-edit'), 'タイトル・コメントを直す', ButtonStyle.Secondary, '✏️'), next('dc')),
        ],
      };
    }
    case 'dc':
      return {
        content: withNote('どのDC（データセンター）でやりますか？'),
        components: [
          toRow(
            ...DATA_CENTERS.map((dc) => choice(recruitCustomId('w', 'dc', dc.name), dc.name, draft.dataCenter === dc.name)),
            choice(recruitCustomId('w', 'dc', 'none'), '指定しない', draft.dataCenter === null),
          ),
          toRow(back('party'), next('date')),
        ],
      };
    case 'date':
      return dateScreen(DRAFT_TARGET, head, { selected: draft.date, nav: [back('dc')], note });
    case 'hour':
      return hourScreen(DRAFT_TARGET, [head, ...(note ? [note] : [])].join('\n'), draft.date ?? '', draft.hour, [back('date')]);
    case 'minute':
      return minuteScreen(DRAFT_TARGET, head, draft.date ?? '', draft.hour ?? 0, draft.minute, [
        button(recruitCustomId('t', 'date', DRAFT_TARGET, compactDay(draft.date ?? '')), '時間へ戻る', ButtonStyle.Secondary, '◀'),
      ]);
    case 'host':
      return hostScreen(draft, userId, head, note);
    case 'slots':
      return slotListScreen(guild, DRAFT_TARGET, draft, head, [back('host'), next('mention')], note);
    case 'mention': {
      const select = new RoleSelectMenuBuilder()
        .setCustomId(recruitCustomId('w', 'mention'))
        .setPlaceholder('メンションするロール（いくつでも・任意）')
        .setMinValues(0)
        .setMaxValues(MAX_MENTION_ROLES)
        .setDefaultRoles(draft.mentionRoleIds);
      return {
        content: withNote(
          [
            'この募集を知らせたいロールがあれば選んでください（投稿するときにメンションします。例: レイド）。',
            `今: ${draft.mentionRoleIds.length > 0 ? draft.mentionRoleIds.map(roleMention).join(' ') : 'メンションしない'}`,
          ].join('\n'),
        ),
        components: [toRow(select), toRow(button(recruitCustomId('w', 'nomention'), 'メンションしない', ButtonStyle.Secondary), back('slots'), next('confirm'))],
      };
    }
    case 'confirm': {
      const startsAt = startsAtOf(draft);
      return {
        content: withNote(
          [
            'この内容で投稿します。直したいところは下のボタンから。',
            ...(draft.mentionRoleIds.length > 0 ? [`投稿するときに ${draft.mentionRoleIds.map(roleMention).join(' ')} にメンションします。`] : []),
            '投稿すると、参加者の連絡用スレッドも作ります。',
          ].join('\n'),
        ),
        embeds: [buildRecruitEmbed({ ...draft, id: null, startsAt, hostId: userId, status: 'open' })],
        components: [
          toRow(
            button(recruitCustomId('w', 'post'), '投稿する', ButtonStyle.Success, '📣'),
            button(recruitCustomId('w', 'tplsave'), 'テンプレートに保存', ButtonStyle.Secondary, '💾'),
            button(recruitCustomId('w', 'discard'), 'やめる', ButtonStyle.Danger, '🗑️'),
          ),
          toRow(
            button(recruitCustomId('w', 'basic-edit'), '内容', ButtonStyle.Secondary, '✏️'),
            go('party', '形', ButtonStyle.Secondary, '👥'),
            go('dc', 'DC', ButtonStyle.Secondary, '🌍'),
            go('date', '日時', ButtonStyle.Secondary, '🕘'),
            go('host', '主催', ButtonStyle.Secondary, '👑'),
          ),
          toRow(go('slots', '枠の設定', ButtonStyle.Secondary, '🧩'), go('mention', 'メンション', ButtonStyle.Secondary, '🔔')),
        ],
      };
    }
  }
};

/** 主催の参加。ロールの枠がある募集は、入る枠（2つ以上ならFLEX）とジョブを選ぶ */
const hostScreen = (draft: RecruitDraft, userId: string, head: string, note?: string): Screen => {
  const party = partyOf(draft.party, draft);
  const host = draft.participants.find((p) => p.userId === userId);
  const state = !host
    ? '今: 主催は参加しない'
    : host.slot
      ? `今: ${party.hasRoles ? `**${host.slot}**` : '参加'}（${jobLabel(host.job)}）${party.hasRoles && host.positions.length > 1 ? ` FLEX: ${host.positions.join('/')}` : ''}`
      : '⚠ その組み合わせでは入れる枠がありません（ジョブ指定や事前埋まりを見直してください）';
  const roles = new Set(draft.slots.filter((slot) => !host || host.positions.includes(slot.key)).map((slot) => slot.role));
  const jobs = JOBS.filter((job) => roles.has('any') || roles.has(job.role) || roles.size === 0);
  const jobSelect = new StringSelectMenuBuilder()
    .setCustomId(recruitCustomId('w', 'hostjob'))
    .setPlaceholder('使うジョブ（いくつでも。選ばなければ未定）')
    .setMinValues(0)
    .setMaxValues(jobs.length)
    .addOptions(jobs.map((job) => ({ label: job.name, value: job.key, default: !!host?.jobs.includes(job.key) })));
  const nav = toRow(button(recruitCustomId('w', 'hostnone'), '主催は参加しない', ButtonStyle.Secondary), back('date'), next('slots'));

  if (!party.hasRoles) {
    return {
      content: [head, ...(note ? [note] : []), '主催も参加しますか？', state].join('\n'),
      components: [
        toRow(choice(recruitCustomId('w', 'hostjoin'), '主催も参加する', !!host, '👑')),
        ...(host ? [toRow(jobSelect)] : []),
        nav,
      ],
    };
  }
  const open = draft.slots.filter(isOpenSlot);
  const positions = new StringSelectMenuBuilder()
    .setCustomId(recruitCustomId('w', 'hostpos'))
    .setPlaceholder('主催が入る枠（2つ以上選ぶとFLEX）')
    .setMinValues(0)
    .setMaxValues(Math.max(open.length, 1))
    .addOptions(
      open.length > 0
        ? open.map((slot) => ({ label: slot.key, description: slot.requiredJob ? `${jobLabel(slot.requiredJob)}指定` : undefined, value: slot.key, default: !!host?.positions.includes(slot.key) }))
        : [{ label: '入れる枠がありません', value: NO_JOB }],
    );
  return {
    content: [head, ...(note ? [note] : []), '主催も参加しますか？ 参加するなら、入る枠（2つ以上選ぶとFLEXで空いている方に入ります）と、使うジョブを選んでください。', state].join('\n'),
    components: [toRow(positions), toRow(jobSelect), nav],
  };
};

// ---- 操作

/** 「recruit:w:…」のボタン・メニュー */
export const handleWizard = async (interaction: RecruitComponentInteraction, action: string, args: string[]): Promise<void> => {
  if (!canUseRecruit(interaction.member)) {
    await respond(interaction, { content: NOT_ALLOWED, components: [] });
    return;
  }
  const { guild, user } = interaction;
  switch (action) {
    case 'new':
      await interaction.showModal(basicModal());
      return;
    case 'basic-edit':
      await interaction.showModal(basicModal(await loadDraft(guild.id, user.id)));
      return;
    case 'tplsave':
      await interaction.showModal(
        new ModalBuilder()
          .setCustomId(TEMPLATE_MODAL_ID)
          .setTitle('テンプレートに保存')
          .addLabelComponents(
            new LabelBuilder()
              .setLabel('テンプレートの名前')
              .setDescription('同じ名前があれば上書きします')
              .setTextInputComponent(new TextInputBuilder().setCustomId('name').setStyle(TextInputStyle.Short).setMaxLength(30).setRequired(true)),
          ),
      );
      return;
  }

  await deferScreen(interaction);
  if (action === 'tpl' || action === 'tpldel' || action === 'tpldel-menu') {
    await editScreen(interaction, await templateAction(interaction, action));
    return;
  }

  const draft = await loadDraft(guild.id, user.id);
  if (!draft) {
    await editScreen(interaction, { content: '作りかけの募集が見つかりません（24時間たつと消えます）。パネルの「募集を作成」からやり直してください。', components: [] });
    return;
  }
  const value = interaction.isAnySelectMenu() ? interaction.values : [];
  let step: Step = 'party';
  let note: string | undefined;

  switch (action) {
    case 'resume':
      // 作りかけを、今いるチャンネルのパネルから続けたら、そのチャンネルに投稿する
      if (interaction.channelId) draft.channelId = interaction.channelId;
      step = draft.startNow || draft.date ? 'confirm' : 'party';
      break;
    case 'go':
      step = STEPS.includes(args[0] as Step) ? (args[0] as Step) : 'party';
      if (step === 'hour' && !draft.date) step = 'date';
      if (step === 'minute' && (draft.date === null || draft.hour === null)) step = 'date';
      break;
    case 'party':
    case 'partyfree': {
      const party = action === 'party' ? (args[0] ?? 'full') : (value[0] ?? draft.party);
      if (party !== draft.party) {
        const hadSettings = draft.participants.length > 0 || draft.slots.some((s) => s.requiredJob || s.external || s.closed);
        draft.party = party;
        draft.slots = createSlots(party);
        draft.participants = [];
        if (hadSettings) note = '⚠ 募集の形を変えたので、主催の参加と枠の設定はやり直しになりました。';
      }
      step = 'party';
      break;
    }
    case 'dup': {
      const result = changeDuplicateRule(draft, args[0] === 'on');
      Object.assign(draft, result.config);
      if (result.displaced.length > 0) note = '⚠ ジョブが重なっている人がいたので、その人は入れなくなりました。';
      step = 'party';
      break;
    }
    case 'dc':
      draft.dataCenter = args[0] && args[0] !== 'none' ? args[0] : null;
      step = 'date';
      break;
    case 'hostpos':
    case 'hostjob':
    case 'hostjoin':
    case 'hostnone':
      updateHost(draft, user.id, action, value);
      step = 'host';
      break;
    case 'mention':
      draft.mentionRoleIds = value.filter((id) => id !== guild.id).slice(0, MAX_MENTION_ROLES);
      step = 'mention';
      break;
    case 'nomention':
      draft.mentionRoleIds = [];
      step = 'mention';
      break;
    case 'discard':
      await deleteDraft(guild.id, user.id);
      await editScreen(interaction, { content: '🗑️ 作りかけの募集をやめました。', components: [] });
      return;
    case 'post':
      await post(interaction, draft);
      return;
    default:
      return;
  }
  await saveDraft(guild.id, user.id, draft);
  await editScreen(interaction, stepScreen(guild, user.id, draft, step, note));
};

/** 主催の参加を変えて、割り振り直す */
const updateHost = (draft: RecruitDraft, userId: string, action: string, values: string[]): void => {
  const others = draft.participants.filter((p) => p.userId !== userId);
  const current = draft.participants.find((p) => p.userId === userId);
  const allKeys = draft.slots.map((slot) => slot.key);
  let host: RecruitParticipant | null = current ?? null;
  switch (action) {
    case 'hostnone':
      host = null;
      break;
    case 'hostjoin':
      host = current ? null : hostParticipant(userId, allKeys, []);
      break;
    case 'hostpos': {
      const positions = values.filter((v) => allKeys.includes(v));
      // 選んだ枠のロールに合わなくなったジョブは外す
      const roles = new Set(draft.slots.filter((slot) => positions.includes(slot.key)).map((slot) => slot.role));
      const jobs = (current?.jobs ?? []).filter((job) => [...roles].some((role) => jobsForRole(role).some((j) => j.key === job)));
      host = positions.length > 0 ? hostParticipant(userId, positions, jobs) : null;
      break;
    }
    case 'hostjob':
      host = current ? { ...current, jobs: values.filter((v) => JOBS.some((job) => job.key === v)) } : null;
      break;
  }
  draft.participants = assignParticipants({ ...draft, participants: host ? [...others, host] : others });
};

const hostParticipant = (userId: string, positions: string[], jobs: string[]): RecruitParticipant => ({
  userId,
  positions,
  jobs,
  comment: null,
  joinedAt: HOST_JOINED_AT,
  prefilled: true,
  slot: null,
  job: null,
});

/** テンプレートを選ぶ・消す */
const templateAction = async (interaction: RecruitComponentInteraction, action: string): Promise<Screen> => {
  const { guild, user } = interaction;
  const value = interaction.isStringSelectMenu() ? interaction.values[0] : undefined;
  if (action === 'tpldel-menu') {
    const deletable = (await listTemplates(guild.id)).filter((t) => t.createdBy === user.id || isAdmin(interaction.member));
    return {
      content: '消すテンプレートを選んでください（作った人と管理者だけが消せます）。',
      components: [
        toRow(
          new StringSelectMenuBuilder()
            .setCustomId(recruitCustomId('w', 'tpldel'))
            .setPlaceholder('消すテンプレート')
            .addOptions(deletable.length > 0 ? deletable.map((t) => ({ label: t.name, value: t.id })) : [{ label: '消せるテンプレートがありません', value: '0' }]),
        ),
      ],
    };
  }
  const template = value ? await findTemplate(guild.id, value) : null;
  if (!template) return createScreen(interaction, await listTemplates(guild.id), !!(await loadDraft(guild.id, user.id)), 'そのテンプレートは見つかりません。');
  if (action === 'tpldel') {
    if (template.createdBy !== user.id && !isAdmin(interaction.member)) return { content: 'そのテンプレートは消せません（作った人と管理者だけ）。', components: [] };
    await deleteTemplate(guild.id, template.id);
    return createScreen(interaction, await listTemplates(guild.id), !!(await loadDraft(guild.id, user.id)), `🗑️ テンプレート「${template.name}」を消しました。`);
  }
  // テンプレートから下書きを作る（日付は毎回選ぶ）
  const draft = await newDraft(interaction);
  const { data } = template;
  Object.assign(draft, {
    title: data.title,
    comment: data.comment,
    party: data.party,
    dataCenter: data.dataCenter,
    allowDuplicateJobs: data.allowDuplicateJobs,
    mentionRoleIds: data.mentionRoleIds,
    hour: data.hour,
    minute: data.minute,
    slots: createSlots(data.party).map((slot) => ({ ...slot, requiredJob: data.requiredJobs[slot.key] ?? null })),
    participants: [],
  });
  await saveDraft(guild.id, user.id, draft);
  return stepScreen(guild, user.id, draft, 'date', `📄 テンプレート「${template.name}」を読み込みました。開始する日を選んでください。`);
};

/** 「recruit:t:…:w」開始日時の選択（下書き） */
export const handleWizardTime = async (interaction: RecruitComponentInteraction, action: string, args: string[]): Promise<void> => {
  await deferScreen(interaction);
  const { guild, user } = interaction;
  const draft = await loadDraft(guild.id, user.id);
  if (!draft) {
    await editScreen(interaction, { content: '作りかけの募集が見つかりません。パネルの「募集を作成」からやり直してください。', components: [] });
    return;
  }
  // args: [target, 日付, 時, 分]
  const day = args[1] ? expandDay(args[1]) : null;
  let step: Step;
  let note: string | undefined;
  switch (action) {
    case 'now':
      draft.startNow = true;
      step = 'host';
      break;
    case 'date':
      draft.startNow = false;
      draft.date = day;
      step = 'hour';
      break;
    case 'hour':
    case 'hoursel':
      draft.startNow = false;
      draft.date = day;
      draft.hour = Number(action === 'hour' ? args[2] : (interaction.isStringSelectMenu() ? interaction.values[0] : 0));
      step = 'minute';
      break;
    case 'min': {
      const minute = Number(args[3]);
      const hour = Number(args[2]);
      const problem = day ? startTimeProblem(startTimeOf(day, hour, minute)) : '日付を選んでください。';
      if (problem) {
        note = `⚠ ${problem}`;
        step = 'date';
        break;
      }
      Object.assign(draft, { date: day, hour, minute, startNow: false });
      step = 'host';
      break;
    }
    default:
      return;
  }
  await saveDraft(guild.id, user.id, draft);
  await editScreen(interaction, stepScreen(guild, user.id, draft, step, note));
};

/** 「recruit:s:…:w」枠の設定（下書き） */
export const handleWizardSlot = async (interaction: RecruitComponentInteraction, action: string, args: string[]): Promise<void> => {
  const { guild, user } = interaction;
  const key = args[1] ?? (interaction.isStringSelectMenu() && action === 'pick' ? interaction.values[0] : undefined);
  // モーダルを開く操作は、先に応答してはいけない
  if (action === 'member' || action === 'ext' || action === 'close') {
    const draft = await loadDraft(guild.id, user.id);
    const slot = draft?.slots.find((s) => s.key === key);
    if (!draft || !slot) {
      await respond(interaction, { content: 'その枠は見つかりません。', components: [] });
      return;
    }
    const target = DRAFT_TARGET;
    await interaction.showModal(action === 'member' ? memberModal(target, slot) : action === 'ext' ? externalModal(target, slot) : closeModal(target, slot));
    return;
  }

  await deferScreen(interaction);
  const draft = await loadDraft(guild.id, user.id);
  if (!draft) {
    await editScreen(interaction, { content: '作りかけの募集が見つかりません。パネルの「募集を作成」からやり直してください。', components: [] });
    return;
  }
  const head = header(draft, 'slots');
  switch (action) {
    case 'list':
      await editScreen(interaction, stepScreen(guild, user.id, draft, 'slots'));
      return;
    case 'pick':
      await editScreen(interaction, key ? slotScreen(guild, DRAFT_TARGET, draft, key, head) : stepScreen(guild, user.id, draft, 'slots'));
      return;
    case 'req': {
      const slot = draft.slots.find((s) => s.key === key);
      await editScreen(interaction, slot ? requireScreen(DRAFT_TARGET, slot, head) : stepScreen(guild, user.id, draft, 'slots'));
      return;
    }
    case 'reqsel':
    case 'clear': {
      if (!key) return;
      const picked = interaction.isStringSelectMenu() ? interaction.values[0] : undefined;
      const edit: SlotEdit = action === 'clear' ? { type: 'clear' } : { type: 'require', job: picked && picked !== NO_JOB ? picked : null };
      await applyDraftSlotEdit(interaction, draft, key, edit);
      return;
    }
  }
};

/** 枠の設定のモーダル（下書き） */
export const handleWizardSlotModal = async (interaction: ModalSubmitInteraction<'cached'>, action: string, key: string): Promise<void> => {
  await deferScreen(interaction);
  const draft = await loadDraft(interaction.guild.id, interaction.user.id);
  if (!draft) {
    await editScreen(interaction, { content: '作りかけの募集が見つかりません。パネルの「募集を作成」からやり直してください。', components: [] });
    return;
  }
  await applyDraftSlotEdit(interaction, draft, key, slotEditFromModal(interaction, action));
};

/** モーダルの入力から、枠の設定の変更を作る */
export const slotEditFromModal = (interaction: ModalSubmitInteraction<'cached'>, action: string): SlotEdit => {
  const job = pickedJob(interaction);
  if (action === 'membersub') {
    const userId = interaction.fields.getSelectedUsers('member')?.first()?.id ?? '';
    return { type: 'member', userId, job };
  }
  if (action === 'extsub') return { type: 'external', name: interaction.fields.getTextInputValue('name'), job };
  return { type: 'close', job };
};

const applyDraftSlotEdit = async (
  interaction: RecruitComponentInteraction | ModalSubmitInteraction<'cached'>,
  draft: RecruitDraft,
  key: string,
  edit: SlotEdit,
): Promise<void> => {
  const { guild, user } = interaction;
  const head = header(draft, 'slots');
  if (edit.type === 'member') {
    const member = edit.userId ? await guild.members.fetch(edit.userId).catch(() => null) : null;
    if (!member || member.user.bot) {
      await editScreen(interaction, slotScreen(guild, DRAFT_TARGET, draft, key, head, '⚠ サーバーにいるメンバーを選んでください（Botは選べません）。'));
      return;
    }
  }
  const result = editSlot(draft, key, edit);
  if (!result.ok) {
    await editScreen(interaction, slotScreen(guild, DRAFT_TARGET, draft, key, head, `⚠ ${result.reason}`));
    return;
  }
  Object.assign(draft, result.config);
  await saveDraft(guild.id, user.id, draft);
  const note = [
    `✅ ${key} を設定しました。`,
    ...result.displaced.map((id) => `⚠ ${displayName(guild, id)} さんは入れる枠がなくなりました。`),
  ].join('\n');
  await editScreen(interaction, stepScreen(guild, user.id, draft, 'slots', note));
};

/** 「recruit:w:basic」「recruit:w:tplsub」のモーダル */
export const handleWizardModal = async (interaction: ModalSubmitInteraction<'cached'>, action: string): Promise<void> => {
  if (!canUseRecruit(interaction.member)) {
    await interaction.reply({ content: NOT_ALLOWED, flags: MessageFlags.Ephemeral });
    return;
  }
  await deferScreen(interaction);
  const { guild, user } = interaction;

  if (action === 'tplsub') {
    const draft = await loadDraft(guild.id, user.id);
    if (!draft) {
      await editScreen(interaction, { content: '作りかけの募集が見つかりません。', components: [] });
      return;
    }
    const name = interaction.fields.getTextInputValue('name').trim();
    const existing = (await listTemplates(guild.id)).some((t) => t.name === name);
    if (!existing && (await countTemplates(guild.id)) >= MAX_TEMPLATES) {
      await editScreen(interaction, stepScreen(guild, user.id, draft, 'confirm', `⚠ テンプレートは${MAX_TEMPLATES}個までです。いらないものを消してから保存してください。`));
      return;
    }
    await saveTemplate(guild.id, name, user.id, toTemplate(draft));
    await editScreen(interaction, stepScreen(guild, user.id, draft, 'confirm', `💾 テンプレート「${name}」に保存しました（次からパネルの「募集を作成」で選べます）。`));
    return;
  }

  // 内容（タイトル・コメント）。作りかけがあれば内容だけ直す
  const existing = await loadDraft(guild.id, user.id);
  const editing = !!existing && interaction.isFromMessage() && interaction.message.flags.has(MessageFlags.Ephemeral);
  const draft = editing && existing ? existing : await newDraft(interaction);
  draft.title = interaction.fields.getTextInputValue('title').trim();
  draft.comment = interaction.fields.getTextInputValue('comment').trim();
  await saveDraft(guild.id, user.id, draft);
  await editScreen(interaction, stepScreen(guild, user.id, draft, editing && (draft.startNow || draft.date) ? 'confirm' : 'party'));
};

const toTemplate = (draft: RecruitDraft): RecruitTemplateData => ({
  title: draft.title,
  comment: draft.comment,
  party: draft.party,
  dataCenter: draft.dataCenter,
  allowDuplicateJobs: draft.allowDuplicateJobs,
  mentionRoleIds: draft.mentionRoleIds,
  requiredJobs: Object.fromEntries(draft.slots.flatMap((slot) => (slot.requiredJob ? [[slot.key, slot.requiredJob]] : []))),
  hour: draft.startNow ? null : draft.hour,
  minute: draft.startNow ? null : draft.minute,
});

// ---- 投稿

/** 下書きから募集を投稿する（ロールへのメンション・連絡用スレッドも） */
const post = async (interaction: RecruitComponentInteraction, draft: RecruitDraft): Promise<void> => {
  const { guild, user } = interaction;
  const startsAt = startsAtOf(draft);
  const problem = !draft.title ? 'タイトルを入れてください。' : !startsAt ? '開始日時を選んでください。' : startTimeProblem(startsAt);
  if (problem || !startsAt) {
    await editScreen(interaction, stepScreen(guild, user.id, draft, problem === 'タイトルを入れてください。' ? 'party' : 'date', `⚠ ${problem}`));
    return;
  }
  const channel = guild.channels.cache.get(draft.channelId);
  if (!channel?.isTextBased() || !channel.isSendable()) {
    await editScreen(interaction, { content: '投稿するチャンネルが見つかりません。パネルのあるチャンネルから「募集を作成」をやり直してください。', components: [] });
    return;
  }

  const config: RecruitConfig = { slots: draft.slots, participants: assignParticipants(draft), allowDuplicateJobs: draft.allowDuplicateJobs };
  const recruit = await createRecruit({
    guildId: guild.id,
    channelId: channel.id,
    hostId: user.id,
    title: draft.title,
    comment: draft.comment,
    startsAt,
    party: draft.party,
    dataCenter: draft.dataCenter,
    mentionRoleIds: draft.mentionRoleIds,
    ...config,
    // すぐ始まる募集（「今すぐ」など）は、開始前のお知らせを送らない
    reminded: startsAt.getTime() - Date.now() <= REMIND_BEFORE_MS,
  });
  const message = await channel.send({
    ...(draft.mentionRoleIds.length > 0 ? { content: `🔔 ${draft.mentionRoleIds.map(roleMention).join(' ')} 募集です！` } : {}),
    ...buildRecruitPost(recruit),
    allowedMentions: { roles: draft.mentionRoleIds },
  });
  recruit.messageId = message.id;
  recruit.threadId = (await createRecruitThread(message, recruit))?.id ?? null;
  await saveRecruit(recruit);
  await deleteDraft(guild.id, user.id);
  await bumpRecruitPanel(channel);
  scheduleRecruitListRefresh(guild);

  await editScreen(interaction, {
    content: [
      `✅ 募集を投稿しました: ${message.url}`,
      ...(recruit.threadId ? [`連絡用スレッド: <#${recruit.threadId}>`] : []),
      '内容の変更・締め切り・中止は、募集の「主催メニュー」からできます。',
    ].join('\n'),
    components: [],
  });
  void sendLog(guild, 'recruit', `${interaction.member} が募集を作成しました`, interaction.member, {
    channel,
    fields: [
      { name: '🎮 コンテンツ', value: recruit.title, inline: true },
      { name: '🕘 開始', value: time(recruit.startsAt, 'f'), inline: true },
      { name: '👥 募集の形', value: `${shortPartyLabel(recruit.party)}・${recruit.allowDuplicateJobs ? 'ジョブ重複あり' : 'ジョブ重複なし'}`, inline: true },
      ...(recruit.dataCenter ? [{ name: '🌍 DC', value: recruit.dataCenter, inline: true }] : []),
    ],
    links: [{ label: '募集を見る', url: message.url }],
  });
};
