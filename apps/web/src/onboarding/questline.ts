/**
 * questline · 首日上岗（Day-1 Questline）纯逻辑层
 *
 * 定位：把"新客户首日容易被晾在首页"这件事，做成一条可续播、可跳过、可验收的主线。
 * 纪律（与基座同口径）：
 *  - 进度只能来自真实事实或客户自己的操作；`autoAdvance` 只认事实，不认猜测；
 *  - 跳过要留痕（skipped），不把"跳过"伪装成"完成"；
 *  - XP 口径与 server `roster` 的 gameOf 完全一致（裁决×3 + 派遣×2 + 沉淀×5），
 *    避免出现"前端一套、后端一套"的双账本；
 *  - 本文件不依赖 DOM / React / 网络，可在 node 环境直接单测。
 */

/** 旅程版本：结构变更时递增，旧版本进度按新旅程重新开始（不脏读旧字段） */
export const QUEST_JOURNEY_VERSION = 1;
export const QUEST_STORAGE_KEY = "wl-questline-v1";

export type QuestStageId = "meet" | "goal" | "dispatch" | "review";

/**
 * 关卡顺序即叙事顺序：认人 → 定目标 → 派活 → 验收。
 *
 * 2026-09-21 产品所有者口径（本机单人运行）：基座通用审批环节已移除，原第 4 关「拍板」
 * （真实审批队列 + 批准/修改/驳回）随之删除；业务链路自带的关卡（如视频管线 G1–G10、
 * 定妆照确认）仍由各自业务页面就地放行，不再由首日上岗引导代管。
 */
export const QUEST_STAGE_ORDER: readonly QuestStageId[] = ["meet", "goal", "dispatch", "review"];

export type QuestStatus = "idle" | "running" | "completed";

/** 来自系统真实事实的进度信号（由调用方从 tRPC/事件流推导，不在这里编造） */
export interface QuestFacts {
  /** L2：客户已确认经营目标 */
  goalConfirmed: boolean;
  /** L3：已通过真实通道派出第一件活 */
  dispatched: boolean;
  /** 已完成过一次关卡放行（如视频管线定妆照确认）；仅用于 XP 口径与事件识别，不再作为单独关卡 */
  decided: boolean;
  /** L5：首单已产生交付（线程完成） */
  delivered: boolean;
}

export const EMPTY_FACTS: QuestFacts = {
  goalConfirmed: false,
  dispatched: false,
  decided: false,
  delivered: false,
};

export interface QuestXpTally {
  decided: number;
  dispatched: number;
  settled: number;
}

export interface QuestState {
  version: number;
  status: QuestStatus;
  stage: QuestStageId;
  /** 已点亮的员工卡（收集要素） */
  litCards: string[];
  /** 已完成的关卡（含被事实自动推进的） */
  stageDone: QuestStageId[];
  /** 客户主动跳过的关卡；不并入 stageDone 语义 */
  skipped: QuestStageId[];
  /** 已解锁成就 id */
  achievements: string[];
  /**
   * 首单线程号：用于第 5 关判定交付。
   * 必须持久化——否则刷新/次日回来就认不出"那件活"，只能退回主观确认。
   */
  lastThreadId: string | null;
  xp: QuestXpTally;
  startedAt: number | null;
  completedAt: number | null;
  updatedAt: number;
}

export type XpKind = keyof QuestXpTally;

const STAGE_SET = new Set<string>(QUEST_STAGE_ORDER);

function isStageId(value: unknown): value is QuestStageId {
  return typeof value === "string" && STAGE_SET.has(value);
}

function uniqueStrings<T extends string>(values: readonly T[]): T[] {
  return [...new Set(values)];
}

function stagesOnly(values: unknown): QuestStageId[] {
  if (!Array.isArray(values)) return [];
  return uniqueStrings(values.filter(isStageId));
}

export function createQuestState(now: number = Date.now()): QuestState {
  return {
    version: QUEST_JOURNEY_VERSION,
    status: "idle",
    stage: "meet",
    litCards: [],
    stageDone: [],
    skipped: [],
    achievements: [],
    lastThreadId: null,
    xp: { decided: 0, dispatched: 0, settled: 0 },
    startedAt: null,
    completedAt: null,
    updatedAt: now,
  };
}

/** 记下首单线程号（幂等；空值忽略） */
export function withThreadId(state: QuestState, threadId: string | null | undefined, now: number = Date.now()): QuestState {
  const id = (threadId ?? "").trim();
  if (!id || state.lastThreadId === id) return state;
  return { ...state, lastThreadId: id, updatedAt: now };
}

export function stageIndex(stage: QuestStageId): number {
  return QUEST_STAGE_ORDER.indexOf(stage);
}

export function nextStageOf(stage: QuestStageId): QuestStageId | null {
  const index = stageIndex(stage);
  return QUEST_STAGE_ORDER[index + 1] ?? null;
}

export function isLastStage(stage: QuestStageId): boolean {
  return stageIndex(stage) === QUEST_STAGE_ORDER.length - 1;
}

/** 进入旅程（首次打开引导层时调用；重复调用不重置已有进度） */
export function startQuestline(state: QuestState, now: number = Date.now()): QuestState {
  if (state.status === "completed") return state;
  if (state.status === "running" && state.startedAt !== null) return state;
  return { ...state, status: "running", startedAt: state.startedAt ?? now, updatedAt: now };
}

/**
 * 完成一关：记录完成、清理跳过标记、顺延到下一关。
 * 只在传入的关卡就是当前关卡时才顺延，避免越关推进。
 */
export function completeStage(state: QuestState, stage: QuestStageId, now: number = Date.now()): QuestState {
  const stageDone = uniqueStrings([...state.stageDone, stage]);
  const skipped = state.skipped.filter((item) => item !== stage);
  const base: QuestState = {
    ...state,
    status: state.status === "idle" ? "running" : state.status,
    stageDone,
    skipped,
    startedAt: state.startedAt ?? now,
    updatedAt: now,
  };
  if (isLastStage(stage)) {
    return { ...base, status: "completed", stage, completedAt: base.completedAt ?? now };
  }
  const next = nextStageOf(stage);
  if (!next) return base;
  const advanced: QuestState = { ...base, stage: next };
  // 仅当被完成的正是"当前关卡"时才顺延；历史关卡补写不回退当前指针
  return stageIndex(stage) >= stageIndex(state.stage) ? advanced : base;
}

/** 跳过一关：留痕但不计入完成，仍然顺延到下一关 */
export function skipStage(state: QuestState, stage: QuestStageId, now: number = Date.now()): QuestState {
  const skipped = uniqueStrings([...state.skipped, stage]);
  const base: QuestState = {
    ...state,
    status: state.status === "idle" ? "running" : state.status,
    skipped,
    startedAt: state.startedAt ?? now,
    updatedAt: now,
  };
  if (isLastStage(stage)) {
    return { ...base, status: "completed", stage, completedAt: base.completedAt ?? now };
  }
  const next = nextStageOf(stage);
  return next ? { ...base, stage: next } : base;
}

/** 点亮员工卡（收集）：幂等 */
export function lightCard(state: QuestState, cardId: string, now: number = Date.now()): QuestState {
  if (!cardId.trim()) return state;
  if (state.litCards.includes(cardId)) return state;
  return { ...state, litCards: [...state.litCards, cardId], updatedAt: now };
}

/** 解锁成就（幂等）；返回新状态与本次真正新解锁的 id，便于只给新成就放动画 */
export function unlockAchievements(
  state: QuestState,
  ids: readonly string[],
  now: number = Date.now(),
): { state: QuestState; unlocked: string[] } {
  const unlocked = ids.filter((id) => id.trim().length > 0 && !state.achievements.includes(id));
  if (unlocked.length === 0) return { state, unlocked: [] };
  return {
    state: { ...state, achievements: uniqueStrings([...state.achievements, ...unlocked]), updatedAt: now },
    unlocked: uniqueStrings(unlocked),
  };
}

/** 记一次 XP 事件（客户侧只记"人做的三件事"：裁决/派遣/沉淀） */
export function bumpXp(state: QuestState, kind: XpKind, times = 1, now: number = Date.now()): QuestState {
  if (!Number.isFinite(times) || times <= 0) return state;
  return {
    ...state,
    xp: { ...state.xp, [kind]: state.xp[kind] + Math.floor(times) },
    updatedAt: now,
  };
}

/** 与 server `roster` gameOf 同口径：裁决×3 + 派遣×2 + 沉淀×5 */
export function computeXp(tally: QuestXpTally): number {
  return tally.decided * 3 + tally.dispatched * 2 + tally.settled * 5;
}

export type QuestRank = "青铜" | "白银" | "黄金" | "铂金" | "星钻";

export interface QuestLevel {
  level: number;
  rank: QuestRank;
  xp: number;
  xpFloor: number;
  xpNext: number;
}

/** 等级阶梯 xp ≥ 8·LV²（与 server roster `gameOf` 保持一致，禁止前端另立公式） */
export function levelOf(xp: number): QuestLevel {
  let level = 1;
  while (xp >= 8 * (level + 1) * (level + 1)) level += 1;
  const rank: QuestRank =
    level >= 15 ? "星钻" : level >= 10 ? "铂金" : level >= 6 ? "黄金" : level >= 3 ? "白银" : "青铜";
  return {
    level,
    rank,
    xp,
    xpFloor: level === 1 ? 0 : 8 * level * level,
    xpNext: 8 * (level + 1) * (level + 1),
  };
}

/** 某关是否已被真实事实证明完成 */
export function stageSatisfiedByFacts(stage: QuestStageId, facts: QuestFacts): boolean {
  switch (stage) {
    case "meet":
      // 认人属于"客户主观确认"，只能由点亮卡片或跳过推进，事实无法替他完成
      return false;
    case "goal":
      return facts.goalConfirmed;
    case "dispatch":
      return facts.dispatched;
    case "review":
      // 验收必须由客户自己看完（交付卡 + 成绩单）再点确认：
      // 若用事实自动关掉这一关，客户会在"秒级完成"的演示环境里直接跳到完成面板，
      // 永远看不到成绩单与成就墙（审计 D7）。交付事实仍决定交付卡内容与"首次闭环"成就。
      return false;
    default:
      return false;
  }
}

/**
 * 按真实事实自动推进：覆盖"客户在别处把活干了"的场景——P0 从剧场 ticker
 * （近 14 条真实事件）推导 `thread.dispatch` / `approval.gesture` 是否由本人发出，
 * 因此 3D 职场拖拽派活、AskRail 派活都能被认出来。
 * 认人（meet）与验收（review）必须由客户本人确认，事实不能代劳。
 */
export function autoAdvance(state: QuestState, facts: QuestFacts, now: number = Date.now()): QuestState {
  let current = state.status === "idle" && hasAnyFact(facts) ? startQuestline(state, now) : state;
  // 每关最多推进一次；每次只消化"当前关已满足"的情况，避免跳关
  for (let guard = 0; guard < QUEST_STAGE_ORDER.length; guard += 1) {
    if (current.status === "completed") break;
    if (!stageSatisfiedByFacts(current.stage, facts)) break;
    current = completeStage(current, current.stage, now);
  }
  return current;
}

function hasAnyFact(facts: QuestFacts): boolean {
  return facts.goalConfirmed || facts.dispatched || facts.decided || facts.delivered;
}

export interface QuestActionRow {
  action: string;
  /** 事件 who.id（人类身份是 memberNo，例如 MEM-001） */
  who: string;
}

/**
 * 从"最近动作"推导跨页面事实。
 *
 * 数据源：`captain.theater().ticker`（服务端已过滤测试噪声，近 14 条真实事件）。
 * 纪律：只认本人（who === memberNo）发出的动作；认不出就不推进，绝不猜测。
 */
export function factsFromRecentActions(
  rows: readonly QuestActionRow[] | null | undefined,
  memberNo: string | null | undefined,
): Pick<QuestFacts, "dispatched" | "decided"> {
  const me = (memberNo ?? "").trim();
  if (!me || !Array.isArray(rows) || rows.length === 0) return { dispatched: false, decided: false };
  let dispatched = false;
  let decided = false;
  for (const row of rows) {
    if (!row || typeof row.action !== "string" || row.who !== me) continue;
    if (row.action === "thread.dispatch") dispatched = true;
    if (row.action === "approval.gesture") decided = true;
  }
  return { dispatched, decided };
}

export interface QuestProgressSummary {
  done: number;
  total: number;
  skipped: number;
  stage: QuestStageId;
  /** 剩余分钟估算（每关约 1.2 分钟，用于"还差 3 分钟"这类提示） */
  remainingMinutes: number;
  /** 给 HUD/气泡用的一句话 */
  label: string;
}

export function progressSummary(state: QuestState): QuestProgressSummary {
  const total = QUEST_STAGE_ORDER.length;
  const done = state.stageDone.length;
  const remaining = Math.max(0, total - done);
  const remainingMinutes = Math.max(0, Math.ceil(remaining * 1.2));
  const label =
    state.status === "completed"
      ? "首日上岗已完成"
      : state.status === "idle"
        ? "首日上岗还没开始"
        : remaining <= 0
          ? "就差最后一关"
          : remaining === 1
            ? "就差最后一关"
            : `还差 ${remaining} 关，约 ${remainingMinutes} 分钟`;
  return { done, total, skipped: state.skipped.length, stage: state.stage, remainingMinutes, label };
}

/** 从 localStorage 原始串恢复进度；任何异常都回落到全新状态，不抛错、不脏读 */
export function parseQuestState(raw: string | null | undefined, now: number = Date.now()): QuestState {
  if (!raw) return createQuestState(now);
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return createQuestState(now);
  }
  if (typeof parsed !== "object" || parsed === null) return createQuestState(now);
  const record = parsed as Record<string, unknown>;
  if (record.version !== QUEST_JOURNEY_VERSION) return createQuestState(now);
  const status = record.status === "running" || record.status === "completed" ? record.status : "idle";
  const stage = isStageId(record.stage) ? record.stage : "meet";
  const xpRecord = (typeof record.xp === "object" && record.xp !== null ? record.xp : {}) as Record<string, unknown>;
  const xpNumber = (value: unknown) => (typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.floor(value) : 0);
  return {
    version: QUEST_JOURNEY_VERSION,
    status,
    stage,
    litCards: Array.isArray(record.litCards)
      ? uniqueStrings(record.litCards.filter((item): item is string => typeof item === "string" && item.length > 0))
      : [],
    stageDone: stagesOnly(record.stageDone),
    skipped: stagesOnly(record.skipped),
    achievements: Array.isArray(record.achievements)
      ? uniqueStrings(record.achievements.filter((item): item is string => typeof item === "string" && item.length > 0))
      : [],
    lastThreadId: typeof record.lastThreadId === "string" && record.lastThreadId.trim().length > 0
      ? record.lastThreadId.trim()
      : null,
    xp: {
      decided: xpNumber(xpRecord.decided),
      dispatched: xpNumber(xpRecord.dispatched),
      settled: xpNumber(xpRecord.settled),
    },
    startedAt: typeof record.startedAt === "number" ? record.startedAt : null,
    completedAt: typeof record.completedAt === "number" ? record.completedAt : null,
    updatedAt: typeof record.updatedAt === "number" ? record.updatedAt : now,
  };
}

export function serializeQuestState(state: QuestState): string {
  return JSON.stringify(state);
}
