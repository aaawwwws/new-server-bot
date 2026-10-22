import { findJob, findPartyType, jobLabel, type SlotRole } from './recruitParty.js';

// 募集の枠と参加者の割り振り（Discordに関係しない計算だけ）。
// 参加者は「入ってよい枠（FLEXなら複数）」と「使えるジョブ（複数・空なら未定）」を出し、
// ジョブ指定・ジョブ重複の禁止・事前埋まり・〆 をすべて守る割り振りを、毎回まとめて探し直す

export interface RecruitSlot {
  key: string;
  role: SlotRole;
  /** ジョブ指定（このジョブの人だけ入れる） */
  requiredJob: string | null;
  /** 事前埋まり（サーバーにいない人など）。name は表示名（空でもよい） */
  external: { name: string; job: string | null } | null;
  /** 〆（ゲーム内募集で埋まった）。job は分かれば */
  closed: { job: string | null } | null;
}

export interface RecruitParticipant {
  userId: string;
  /** 入ってよい枠（2つ以上ならFLEX） */
  positions: string[];
  /** 使えるジョブ（空なら未定） */
  jobs: string[];
  comment: string | null;
  /** 参加した時刻（ISO）。先に参加した人ほど優先して枠に入れる */
  joinedAt: string;
  /** 主催があらかじめ入れた人（事前埋まりのサーバーメンバー）。いちばん優先する */
  prefilled: boolean;
  /** 割り振られた枠とジョブ。入れる枠がなければ slot は null（補欠） */
  slot: string | null;
  job: string | null;
}

/** 割り振りに使う、募集（または作成中の下書き）の中身 */
export interface RecruitConfig {
  slots: RecruitSlot[];
  participants: RecruitParticipant[];
  allowDuplicateJobs: boolean;
}

/** 割り振りを探す手数の上限（人数が少ないので普通はすぐ終わる。念のため） */
const MAX_SEARCH_STEPS = 50_000;

export const createSlots = (party: string): RecruitSlot[] =>
  (findPartyType(party)?.slots ?? []).map((slot) => ({ key: slot.key, role: slot.role, requiredJob: null, external: null, closed: null }));

/** 事前埋まり・〆になっていない枠（参加者が入れる枠） */
export const isOpenSlot = (slot: RecruitSlot): boolean => !slot.external && !slot.closed;

/** そのジョブでその枠に入れるか（ロールとジョブ指定） */
export const jobFitsSlot = (slot: RecruitSlot, job: string | null): boolean => {
  if (slot.requiredJob) return job === slot.requiredJob;
  if (job === null) return true;
  const found = findJob(job);
  return !!found && (slot.role === 'any' || found.role === slot.role);
};

/** 埋まっている枠の数（参加者・事前埋まり・〆） */
export const filledCount = (config: RecruitConfig): number =>
  config.slots.filter((slot) => !isOpenSlot(slot) || config.participants.some((p) => p.slot === slot.key)).length;

export const isFull = (config: RecruitConfig): boolean => filledCount(config) >= config.slots.length;

/**
 * 参加者を枠に割り振り直す（参加者の slot / job を書き換えた新しい一覧を返す）。
 * 事前埋まりの人 → 先に参加した人 の順に優先し、今の割り振りはできるだけ変えない。
 * 誰かを入れると前から入っている人が入れなくなる場合は、後から来た人を補欠（slot: null）にする
 */
export const assignParticipants = (config: RecruitConfig): RecruitParticipant[] => {
  const order = [...config.participants].sort(
    (a, b) => Number(b.prefilled) - Number(a.prefilled) || a.joinedAt.localeCompare(b.joinedAt),
  );
  const fixedJobs = config.slots.flatMap((slot) => [slot.external?.job, slot.closed?.job]).filter((job): job is string => !!job);
  const accepted: RecruitParticipant[] = [];
  let placement = new Map<string, Placement>();

  for (const participant of order) {
    const trial = solve(config, [...accepted, participant], fixedJobs, placement);
    if (trial) {
      accepted.push(participant);
      placement = trial;
    }
  }
  return config.participants.map((participant) => {
    const placed = placement.get(participant.userId);
    return { ...participant, slot: placed?.slot ?? null, job: placed ? placed.job : null };
  });
};

interface Placement {
  slot: string;
  job: string | null;
}

/** その人が入れる「枠とジョブ」の組み合わせ（今の割り振りを先に試す） */
const optionsFor = (config: RecruitConfig, participant: RecruitParticipant, current?: Placement): Placement[] => {
  const options: Placement[] = [];
  for (const key of participant.positions) {
    const slot = config.slots.find((s) => s.key === key);
    if (!slot || !isOpenSlot(slot)) continue;
    const jobs = participant.jobs.length > 0 ? participant.jobs : [null];
    for (const job of jobs) {
      if (jobFitsSlot(slot, job)) options.push({ slot: key, job });
    }
  }
  if (!current) return options;
  return [
    ...options.filter((o) => o.slot === current.slot && o.job === current.job),
    ...options.filter((o) => o.slot !== current.slot || o.job !== current.job),
  ];
};

/** people を全員入れられる割り振りを探す（見つからなければ null） */
const solve = (
  config: RecruitConfig,
  people: RecruitParticipant[],
  fixedJobs: string[],
  previous: Map<string, Placement>,
): Map<string, Placement> | null => {
  const options = people.map((person) =>
    optionsFor(config, person, previous.get(person.userId) ?? (person.slot ? { slot: person.slot, job: person.job } : undefined)),
  );
  const usedSlots = new Set<string>();
  const usedJobs = new Map<string, number>(fixedJobs.map((job) => [job, 1]));
  const chosen: Placement[] = [];
  let steps = 0;

  const visit = (index: number): boolean => {
    if (index === people.length) return true;
    for (const option of options[index] ?? []) {
      if (++steps > MAX_SEARCH_STEPS) return false;
      if (usedSlots.has(option.slot)) continue;
      if (!config.allowDuplicateJobs && option.job && (usedJobs.get(option.job) ?? 0) > 0) continue;
      usedSlots.add(option.slot);
      if (option.job) usedJobs.set(option.job, (usedJobs.get(option.job) ?? 0) + 1);
      chosen[index] = option;
      if (visit(index + 1)) return true;
      usedSlots.delete(option.slot);
      if (option.job) usedJobs.set(option.job, (usedJobs.get(option.job) ?? 1) - 1);
    }
    return false;
  };

  if (!visit(0)) return null;
  return new Map(people.map((person, i) => [person.userId, chosen[i] as Placement]));
};

// ---- 参加・取り消し

export type JoinResult =
  | { ok: true; participants: RecruitParticipant[]; placed: RecruitParticipant }
  | { ok: false; reason: string };

/** 参加（参加済みなら参加内容の変更）。入れる枠がなければ、前の状態のまま理由を返す */
export const joinRecruit = (
  config: RecruitConfig,
  entry: { userId: string; positions: string[]; jobs: string[]; comment: string | null; now?: Date },
): JoinResult => {
  const existing = config.participants.find((p) => p.userId === entry.userId);
  const participant: RecruitParticipant = {
    userId: entry.userId,
    positions: entry.positions,
    jobs: entry.jobs,
    comment: entry.comment,
    joinedAt: existing?.joinedAt ?? (entry.now ?? new Date()).toISOString(),
    prefilled: existing?.prefilled ?? false,
    slot: existing?.slot ?? null,
    job: existing?.job ?? null,
  };
  const others = config.participants.filter((p) => p.userId !== entry.userId);
  const participants = assignParticipants({ ...config, participants: [...others, participant] });
  const placed = participants.find((p) => p.userId === entry.userId);
  if (!placed?.slot) return { ok: false, reason: noRoomReason(config, entry) };
  // 前から入っている人が新しく補欠になるなら、受け付けない（新しく来た人のせいで外れる人を出さない）
  const bumped = others.some((p) => p.slot && !participants.find((q) => q.userId === p.userId)?.slot);
  if (bumped) return { ok: false, reason: noRoomReason(config, entry) };
  return { ok: true, participants, placed };
};

const noRoomReason = (config: RecruitConfig, entry: { positions: string[]; jobs: string[] }): string => {
  const open = config.slots.filter((slot) => entry.positions.includes(slot.key) && isOpenSlot(slot));
  if (open.length === 0) return '選んだ枠は、事前埋まりか〆で埋まっています。';
  const fits = open.some((slot) => (entry.jobs.length > 0 ? entry.jobs : [null]).some((job) => jobFitsSlot(slot, job)));
  if (!fits) {
    const required = open.map((slot) => slot.requiredJob).filter(Boolean);
    return required.length > 0
      ? `選んだ枠はジョブ指定があります（${[...new Set(required)].map(jobLabel).join('・')}）。`
      : '選んだジョブは、選んだ枠のロールに合いません。';
  }
  return config.allowDuplicateJobs
    ? '選んだ枠はほかの人で埋まっています。'
    : '選んだ枠はほかの人で埋まっているか、同じジョブの人がもういます（この募集はジョブ重複なし）。';
};

/** 取り消し。空いた枠に補欠の人が入れれば入れる */
export const leaveRecruit = (config: RecruitConfig, userId: string): RecruitParticipant[] =>
  assignParticipants({ ...config, participants: config.participants.filter((p) => p.userId !== userId) });

// ---- 枠の設定（ジョブ指定・事前埋まり・〆）

export type SlotEdit =
  | { type: 'require'; job: string | null }
  | { type: 'member'; userId: string; job: string | null; now?: Date }
  | { type: 'external'; name: string; job: string | null }
  | { type: 'close'; job: string | null }
  | { type: 'clear' };

export type SlotEditResult = { ok: true; config: RecruitConfig; displaced: string[] } | { ok: false; reason: string };

/**
 * 枠の設定を変えて、参加者を割り振り直す。displaced は、そのせいで補欠になった人
 */
export const editSlot = (config: RecruitConfig, key: string, edit: SlotEdit): SlotEditResult => {
  const slot = config.slots.find((s) => s.key === key);
  if (!slot) return { ok: false, reason: 'その枠は見つかりません。' };

  const job = 'job' in edit ? edit.job : null;
  if (job && !findJob(job)) return { ok: false, reason: 'そのジョブは見つかりません。' };
  if ((edit.type === 'member' || edit.type === 'external' || edit.type === 'close') && job && !jobFitsSlot(slot, job)) {
    return {
      ok: false,
      reason: slot.requiredJob ? `${key} は ${jobLabel(slot.requiredJob)} 指定です。` : `${jobLabel(job)} は ${key} のロールに合いません。`,
    };
  }
  if (edit.type === 'require' && edit.job && !jobFitsSlot({ ...slot, requiredJob: null }, edit.job)) {
    return { ok: false, reason: `${jobLabel(edit.job)} は ${key} のロールに合いません。` };
  }

  // その枠に事前埋まりのメンバーがいたら外す（入れ直す・空ける・別の人で埋めるとき）
  const removePrefilledHere = (participants: RecruitParticipant[]) =>
    participants.filter((p) => !(p.prefilled && p.positions.length === 1 && p.positions[0] === key && edit.type !== 'require'));
  let participants = removePrefilledHere(config.participants);
  const slots = config.slots.map((s): RecruitSlot => {
    if (s.key !== key) return s;
    switch (edit.type) {
      case 'require':
        return { ...s, requiredJob: edit.job };
      case 'external':
        return { ...s, external: { name: edit.name.trim(), job: edit.job ?? s.requiredJob }, closed: null };
      case 'close':
        return { ...s, closed: { job: edit.job ?? s.requiredJob }, external: null };
      case 'member':
      case 'clear':
        return { ...s, external: null, closed: null };
    }
  });

  if (edit.type === 'member') {
    const existing = participants.find((p) => p.userId === edit.userId);
    participants = [
      ...participants.filter((p) => p.userId !== edit.userId),
      {
        userId: edit.userId,
        positions: [key],
        jobs: edit.job ? [edit.job] : slot.requiredJob ? [slot.requiredJob] : [],
        comment: existing?.comment ?? null,
        joinedAt: existing?.joinedAt ?? (edit.now ?? new Date()).toISOString(),
        prefilled: true,
        slot: null,
        job: null,
      },
    ];
  }

  const next: RecruitConfig = { ...config, slots, participants };
  if (!config.allowDuplicateJobs) {
    const fixed = slots.flatMap((s) => [s.external?.job, s.closed?.job]).filter((j): j is string => !!j);
    if (new Set(fixed).size !== fixed.length) return { ok: false, reason: 'この募集はジョブ重複なしなので、同じジョブで2つの枠は埋められません。' };
  }
  const assigned = assignParticipants(next);
  if (edit.type === 'member' && !assigned.find((p) => p.userId === edit.userId)?.slot) {
    return { ok: false, reason: 'その人をその枠に入れられません（ジョブが重なっている可能性があります）。' };
  }
  const displaced = config.participants
    .filter((p) => p.slot && assigned.some((q) => q.userId === p.userId && !q.slot))
    .map((p) => p.userId);
  return { ok: true, config: { ...next, participants: assigned }, displaced };
};

/** ジョブ重複のルールを変えて割り振り直す。displaced は、そのせいで補欠になった人 */
export const changeDuplicateRule = (config: RecruitConfig, allowDuplicateJobs: boolean): { config: RecruitConfig; displaced: string[] } => {
  const next = { ...config, allowDuplicateJobs };
  const assigned = assignParticipants(next);
  const displaced = config.participants
    .filter((p) => p.slot && assigned.some((q) => q.userId === p.userId && !q.slot))
    .map((p) => p.userId);
  return { config: { ...next, participants: assigned }, displaced };
};

/** その枠の今の状態（「空き」「ナイト指定」「〆（学者）」など） */
export const describeSlotState = (config: RecruitConfig, slot: RecruitSlot): string => {
  const required = slot.requiredJob ? `（${jobLabel(slot.requiredJob)}指定）` : '';
  if (slot.external) return `事前埋まり: ${slot.external.name || '外部の人'}（${jobLabel(slot.external.job)}）`;
  if (slot.closed) return `〆 ゲーム内募集（${slot.closed.job ? jobLabel(slot.closed.job) : 'ジョブ不明'}）`;
  const person = config.participants.find((p) => p.slot === slot.key);
  if (person) return `参加: ${person.prefilled ? '事前埋まり ' : ''}<@${person.userId}>（${jobLabel(person.job)}）${required}`;
  return `空き${required}`;
};
