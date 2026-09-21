/**
 * useQuestline · 首日上岗的浏览器侧状态容器
 *
 * 职责：
 *  1. 进度持久化（本次为 localStorage；生产化迁到服务端 onboarding_progress 同构表）；
 *  2. 按真实事实自动推进（`autoAdvance`）与成就解锁；
 *  3. 本地漏斗埋点（`questline.*`），离线部署也能复盘"客户卡在哪一关"。
 *
 * 纪律：这里不产生任何"假完成"——只有客户操作或系统事实能让关卡前进。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  QUEST_STORAGE_KEY,
  autoAdvance,
  bumpXp,
  completeStage,
  computeXp,
  createQuestState,
  levelOf,
  lightCard,
  parseQuestState,
  progressSummary,
  serializeQuestState,
  skipStage,
  startQuestline,
  unlockAchievements,
  withThreadId,
  type QuestFacts,
  type QuestLevel,
  type QuestProgressSummary,
  type QuestStageId,
  type QuestState,
  type XpKind,
} from "./questline";
import { QUESTLINE, coreCardIds, type QuestlineConfig } from "./questline.config";

const EVENT_KEY = "wl-questline-events-v1";
const EVENT_LIMIT = 200;

export interface QuestEvent {
  name: string;
  at: number;
  payload?: Record<string, string | number | boolean>;
}

function readEvents(): QuestEvent[] {
  if (typeof localStorage === "undefined") return [];
  try {
    const raw = localStorage.getItem(EVENT_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((item): item is QuestEvent => (
      typeof item === "object" && item !== null
      && typeof (item as QuestEvent).name === "string"
      && typeof (item as QuestEvent).at === "number"
    ));
  } catch {
    return [];
  }
}

function appendEvent(event: QuestEvent): QuestEvent[] {
  const next = [...readEvents(), event].slice(-EVENT_LIMIT);
  if (typeof localStorage !== "undefined") {
    try {
      localStorage.setItem(EVENT_KEY, JSON.stringify(next));
    } catch {
      /* 隐私模式/配额满：埋点失败不影响业务 */
    }
  }
  return next;
}

export interface QuestCelebration {
  achievements: string[];
  stage: QuestStageId | null;
}

export interface QuestlineApi {
  state: QuestState;
  summary: QuestProgressSummary;
  level: QuestLevel;
  xp: number;
  open: boolean;
  celebration: QuestCelebration;
  openQuestline: () => void;
  closeQuestline: () => void;
  completeCurrent: () => void;
  skipCurrent: () => void;
  markCard: (cardId: string) => void;
  /** 记下首单线程号（派活成功后调用；持久化，供第 5 关判定交付） */
  setThreadId: (threadId: string | null) => void;
  noteXp: (kind: XpKind, times?: number) => void;
  clearCelebration: () => void;
  reset: () => void;
  track: (name: string, payload?: QuestEvent["payload"]) => void;
  events: () => QuestEvent[];
}

export interface UseQuestlineOptions {
  /** 欢迎仪式已结束（首日上岗的起跑线） */
  ready: boolean;
  /** 真实事实信号 */
  facts: QuestFacts;
  /** 当前工作区活动 Bundle 的内容包（员工卡/目标/任务卡随行业切换） */
  content?: QuestlineConfig;
}

export function useQuestline({ ready, facts, content = QUESTLINE }: UseQuestlineOptions): QuestlineApi {
  const [state, setState] = useState<QuestState>(() => (
    typeof localStorage === "undefined"
      ? createQuestState()
      : parseQuestState(localStorage.getItem(QUEST_STORAGE_KEY))
  ));
  const [open, setOpen] = useState(false);
  const [celebration, setCelebration] = useState<QuestCelebration>({ achievements: [], stage: null });
  const factsRef = useRef(facts);
  factsRef.current = facts;
  const stateRef = useRef(state);
  stateRef.current = state;
  /** 上一次已记账的状态：用于在 updater 之外做"差异 → 埋点/庆祝"（StrictMode 安全） */
  const bookedRef = useRef<QuestState | null>(null);
  const factsKey = useMemo(() => [
    facts.goalConfirmed ? "g" : "-",
    facts.dispatched ? "d" : "-",
    facts.decided ? "a" : "-",
    facts.delivered ? "v" : "-",
  ].join(""), [facts.goalConfirmed, facts.dispatched, facts.decided, facts.delivered]);

  const track = useCallback<QuestlineApi["track"]>((name, payload) => {
    appendEvent({ name, at: Date.now(), ...(payload ? { payload } : {}) });
  }, []);

  /* ---------- 持久化 ---------- */
  useEffect(() => {
    if (typeof localStorage === "undefined") return;
    try {
      localStorage.setItem(QUEST_STORAGE_KEY, serializeQuestState(state));
    } catch {
      /* 忽略配额错误：内存态仍可用 */
    }
  }, [state]);

  /* ---------- 起跑：欢迎仪式结束后自动开始（已完成则不再自动弹） ---------- */
  useEffect(() => {
    if (!ready) return;
    // 完成态只在 HUD 提供"重播"入口；自动弹层只服务"还没走完"的客户，
    // 否则每次进首页都会被引导层拦一次（审计 S1）。
    if (stateRef.current.status === "completed") return;
    setState((current) => startQuestline(current));
    setOpen(true);
    // 仅以 ready 是否到位的边沿触发
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready]);

  /* ---------- 事实驱动推进（纯 updater） ---------- */
  useEffect(() => {
    setState((current) => autoAdvance(current, factsRef.current));
    // factsKey 是 facts 的稳定指纹；用字符串依赖避免每帧重算
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [factsKey]);

  /* ---------- 成就解锁（只认事实与客户操作；纯 updater） ---------- */
  useEffect(() => {
    const desired: string[] = [];
    if (ready) desired.push("aboard");
    // 三位当家人 = 内容包前三张卡（禁止在机制里硬编码岗位 id，否则换行业包即失效）
    const coreIds = coreCardIds(content);
    if (coreIds.every((id) => state.litCards.includes(id))) desired.push("three-keepers");
    if (facts.dispatched || state.stageDone.includes("dispatch")) desired.push("first-dispatch");
    if (facts.delivered || state.stageDone.includes("review")) desired.push("first-close");
    setState((current) => unlockAchievements(current, desired).state);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready, factsKey, state.litCards.join(","), state.stageDone.join(","), content]);

  /* ---------- 状态差异 → 埋点与庆祝（副作用留在 updater 之外，StrictMode 不会重复记账） ---------- */
  useEffect(() => {
    const previous = bookedRef.current;
    if (!previous) {
      bookedRef.current = state;
      return;
    }
    if (previous === state) return;
    if (previous.status === "idle" && state.status !== "idle") {
      track("questline.started", { journey_version: state.version, from: "welcome" });
    }
    const doneAdded = state.stageDone.filter((id) => !previous.stageDone.includes(id));
    for (const stage of doneAdded) track("questline.step.completed", { stage, next: state.stage, status: state.status });
    const skippedAdded = state.skipped.filter((id) => !previous.skipped.includes(id));
    for (const stage of skippedAdded) track("questline.step.skipped", { stage, next: state.stage });
    const cardsAdded = state.litCards.filter((id) => !previous.litCards.includes(id));
    for (const cardId of cardsAdded) track("questline.card.lit", { card_id: cardId, total: state.litCards.length });
    const achievementsAdded = state.achievements.filter((id) => !previous.achievements.includes(id));
    for (const id of achievementsAdded) track("questline.achievement.unlocked", { achievement_id: id });
    if (previous.status !== "completed" && state.status === "completed") {
      track("questline.completed", { skipped: state.skipped.length });
    }
    if (previous.status !== "idle" && state.status === "idle" && state.stageDone.length === 0 && previous.stageDone.length > 0) {
      track("questline.reset");
    }
    if (previous.stage !== state.stage) track("questline.stage.auto_advanced", { from: previous.stage, to: state.stage });
    if (achievementsAdded.length > 0 || previous.stage !== state.stage) {
      setCelebration((current) => ({
        achievements: [...current.achievements, ...achievementsAdded],
        stage: previous.stage !== state.stage ? previous.stage : current.stage,
      }));
    }
    bookedRef.current = state;
  }, [state, track]);

  /* ---------- 客户操作 ---------- */
  const completeCurrent = useCallback(() => {
    setState((current) => completeStage(current, current.stage));
  }, []);

  const skipCurrent = useCallback(() => {
    setState((current) => skipStage(current, current.stage));
  }, []);

  const markCard = useCallback((cardId: string) => {
    setState((current) => lightCard(current, cardId));
  }, []);

  /** 记下首单线程号：第 5 关据此判定交付（刷新/次日回来仍认得出那件活） */
  const setThreadId = useCallback((threadId: string | null) => {
    setState((current) => withThreadId(current, threadId));
  }, []);

  const noteXp = useCallback((kind: XpKind, times = 1) => {
    setState((current) => bumpXp(current, kind, times));
  }, []);

  const reset = useCallback(() => {
    const fresh = createQuestState();
    setState(fresh);
    setCelebration({ achievements: [], stage: null });
    track("questline.reset");
  }, [track]);

  const xp = computeXp(state.xp);
  const level = useMemo(() => levelOf(xp), [xp]);
  const summary = useMemo(() => progressSummary(state), [state]);

  return {
    state,
    summary,
    level,
    xp,
    open,
    celebration,
    openQuestline: useCallback(() => {
      setOpen(true);
      // 手动打开也要正式起跑：否则 HUD 会一直显示"还没开始"
      setState((current) => startQuestline(current));
      track("questline.opened", { stage: state.stage });
    }, [state.stage, track]),
    closeQuestline: useCallback(() => {
      setOpen(false);
      track("questline.closed", { stage: state.stage });
    }, [state.stage, track]),
    completeCurrent,
    skipCurrent,
    markCard,
    setThreadId,
    noteXp,
    clearCelebration: useCallback(() => setCelebration({ achievements: [], stage: null }), []),
    reset,
    track,
    events: readEvents,
  };
}

/** 供界面直接引用的关卡/成就元数据（避免多处重复查找） */
export const QUESTLINE_META = QUESTLINE;
