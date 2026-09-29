/**
 * QuestlineOverlay · 首日上岗引导壳（四关：认人 → 定目标 → 派活 → 验收）
 *
 * 设计要点：
 *  - 不新增路由：客户始终在经营主页之上走完，走完落回原处，不会"迷路"；
 *  - 派活走**真实通道**（threads.dispatch），不做假按钮；基座通用审批环节已移除
 *    （2026-09-21 产品所有者口径），业务关卡由各自业务页面就地放行；
 *  - 事实回传（onFact）：由 P0 汇总成 QuestFacts，再交给 useQuestline 的 autoAdvance；
 *  - 随时"稍后再来"：进度在 useQuestline 里持久化，下次从同一关继续。
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { Icon, clientChineseText, useManagedSurface } from "@workloom/ui";
import { ensureDemoLogin, trpc } from "../../lib/trpc";
import { AudioEngine } from "../../audio/AudioEngine";
import {
  QUEST_STAGE_ORDER,
  type QuestFacts,
  type QuestLevel,
  type QuestStageId,
  type QuestState,
} from "../../onboarding/questline";
import { coreCardIds, stageDef, type TaskCardDef } from "../../onboarding/questline.config";
import { useQuestlineContent } from "../../onboarding/QuestlineContent";
import { MateGuideAvatar, type GuideMood } from "./MateGuideAvatar";
import { MateGuideBubble } from "./MateGuideBubble";
import {
  CompletionPanel,
  DispatchStage,
  GoalStage,
  ReviewStage,
  StageActions,
  type ThreadView,
} from "./QuestlineStages";

export interface QuestCelebrationView {
  achievements: string[];
  stage: QuestStageId | null;
}

export interface QuestlineOverlayProps {
  open: boolean;
  state: QuestState;
  level: QuestLevel;
  xp: number;
  celebration: QuestCelebrationView;
  canDispatch: boolean;
  onClose: () => void;
  onCompleteStage: () => void;
  onSkipStage: () => void;
  onLightCard: (cardId: string) => void;
  onFact: (key: keyof QuestFacts, value: boolean) => void;
  onXp: (kind: "decided" | "dispatched" | "settled", times?: number) => void;
  /** 记下首单线程号（持久化；第 5 关据此判定交付） */
  onThreadId: (threadId: string | null) => void;
  onClearCelebration: () => void;
  onTrack: (name: string, payload?: Record<string, string | number | boolean>) => void;
}

const STAGE_HINT_MS = 9000;

export function QuestlineOverlay({
  open,
  state,
  level,
  xp,
  celebration,
  canDispatch,
  onClose,
  onCompleteStage,
  onSkipStage,
  onLightCard,
  onFact,
  onXp,
  onThreadId,
  onClearCelebration,
  onTrack,
}: QuestlineOverlayProps) {
  const content = useQuestlineContent();
  const def = stageDef(state.stage, content);
  const [cardPage, setCardPage] = useState(0);
  const [goalId, setGoalId] = useState<string | null>(null);
  const [goalFree, setGoalFree] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [toast, setToast] = useState("");
  const [thread, setThread] = useState<ThreadView | null>(null);
  const [dispatchedTaskId, setDispatchedTaskId] = useState<string | null>(null);
  const [hintVisible, setHintVisible] = useState(false);

  /* M3：无障碍与表面管理交给基座统一实现（Esc 关闭 / 焦点圈定 / 背景 inert / 焦点恢复） */
  const surface = useManagedSurface<HTMLDivElement>({
    open,
    kind: "dialog",
    onDismiss: onClose,
    modal: true,
    dismissOnEscape: true,
    trapFocus: true,
    focusOnOpen: true,
    restoreFocusOnClose: true,
  });

  /* m4：引导层打开期间让织伴浮层让位（关闭后恢复用户原本的隐藏偏好） */
  useEffect(() => {
    if (!open || typeof window === "undefined") return;
    let wasHidden = false;
    try {
      wasHidden = localStorage.getItem("loommate.hidden") === "1";
    } catch { /* 隐私模式忽略 */ }
    window.dispatchEvent(new CustomEvent("workloom:loommate-visibility", { detail: "hide" }));
    return () => {
      window.dispatchEvent(new CustomEvent("workloom:loommate-visibility", { detail: wasHidden ? "hide" : "show" }));
    };
  }, [open]);

  const cards = useMemo(() => {
    const primary = content.employees.slice(0, 3);
    const extra = content.employees.slice(3);
    return cardPage === 0 ? primary : extra.length > 0 ? extra : primary;
  }, [cardPage, content]);

  const litCore = useMemo(
    () => coreCardIds(content).filter((id) => state.litCards.includes(id)).length,
    [state.litCards, content],
  );

  const showToast = useCallback((text: string, ms = 2600) => {
    setToast(text);
    window.setTimeout(() => setToast(""), ms);
  }, []);

  /* 停留 9 秒未操作 → 织伴给提示（不打断，不清空输入） */
  useEffect(() => {
    if (!open) return;
    setHintVisible(false);
    const timer = window.setTimeout(() => setHintVisible(true), STAGE_HINT_MS);
    return () => window.clearTimeout(timer);
  }, [open, state.stage]);

  /* 进关音效 + 埋点 */
  useEffect(() => {
    if (!open) return;
    onTrack("questline.stage.viewed", { stage: state.stage });
    try {
      AudioEngine.play("chime");
    } catch {
      /* 音效失败不影响体验 */
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, state.stage]);

  /* 成就横幅 */
  useEffect(() => {
    if (!open || celebration.achievements.length === 0) return;
    const titles = celebration.achievements
      .map((id) => content.achievements.find((item) => item.id === id)?.title)
      .filter((title): title is string => Boolean(title));
    if (titles.length > 0) showToast(`解锁成就：${titles.join("、")}`, 4200);
    try {
      AudioEngine.play("celebrate");
    } catch {
      /* 忽略 */
    }
    onClearCelebration();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, celebration.achievements.join(",")]);

  /* S4a：首单线程号 = 本地派活结果 ∪ 持久化线程号；刷新/次日回来仍认得出那件活 */
  const threadId = thread?.id ?? state.lastThreadId ?? null;

  /* S4a-恢复：进入验收关但本地没有线程号时（例如在别处派的活），从服务端取最近一条本人线程 */
  useEffect(() => {
    if (!open || state.stage !== "review" || threadId) return;
    let stopped = false;
    void (async () => {
      try {
        await ensureDemoLogin();
        const list = await trpc.threads.list.query() as Array<ThreadView & { created_by?: string }>;
        if (stopped || list.length === 0) return;
        const newest = list[0];
        if (!newest?.id) return;
        setThread(newest);
        onThreadId(newest.id);
        onTrack("questline.thread.adopted", { thread_id: newest.id });
      } catch {
        /* 取不到就保持"暂无可关联任务"的诚实态，不猜 */
      }
    })();
    return () => { stopped = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, state.stage, threadId]);

  /* L5：任务状态轮询（真实事实，完成与否以服务端为准） */
  useEffect(() => {
    if (!open || state.stage !== "review" || !threadId) return;
    let stopped = false;
    const load = async () => {
      try {
        await ensureDemoLogin();
        const row = await trpc.threads.get.query({ threadId }) as ThreadView | null;
        if (stopped || !row) return;
        setThread(row);
        if (row.status === "completed") {
          onFact("delivered", true);
          onTrack("questline.thread.completed", { thread_id: row.id });
        }
      } catch {
        /* 轮询失败保持最后一次已知进度，不伪造完成 */
      }
    };
    void load();
    const timer = window.setInterval(() => void load(), 4000);
    return () => {
      stopped = true;
      window.clearInterval(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, state.stage, threadId]);

  /* ---------- 各关动作 ---------- */
  const confirmGoal = () => {
    const goal = goalId ? content.goals.find((item) => item.id === goalId) : undefined;
    if (!goal && !goalFree.trim()) {
      setError("先选一个，或者跟我说一句您最想解决的事。");
      return;
    }
    setError("");
    onFact("goalConfirmed", true);
    onXp("settled");
    onTrack("questline.goal.confirmed", { template: goal?.id ?? "free_text" });
    showToast(goal ? `目标已确认：${goal.title}` : "目标已确认");
    onCompleteStage();
  };

  const dispatch = async (task: TaskCardDef) => {
    if (!canDispatch) {
      setError("当前角色没有派活权限；可以让店主账号来试这一步。");
      return;
    }
    setBusy(true);
    setError("");
    try {
      await ensureDemoLogin();
      const result = await trpc.threads.dispatch.mutate({
        title: task.dispatchTitle,
        presetKey: task.ownerPresetKey,
        runImmediately: true,
      }) as { kind?: string; question?: string; threadId?: string; status?: string; mode?: string };
      if (result.kind === "clarify") {
        setError(clientChineseText(result.question, "指令还不够具体，再补一句细节。"));
        return;
      }
      // M4：首单必须是一件"可交付的活"。若被意图路由判成问答/单员工任务，
      // 就不会有产出与验收，不能按"已派活"过关。
      if (result.mode !== "quest") {
        setError(result.mode === "ask"
          ? "这句话被理解成了一次提问。首单需要一件有产出的活，例如「巡检今天的房态与渠道价格，产出异常清单」。"
          : "这句话被理解成了单人任务，首单需要一件可交付的活（会走完整流程、留下产出与凭证）。换个说法再试。");
        return;
      }
      if (!result.threadId) {
        setError("任务没有拿到线程号，已按未派成功处理。请再试一次。");
        return;
      }
      setDispatchedTaskId(task.id);
      onThreadId(result.threadId);
      setThread({
        id: result.threadId,
        title: task.title,
        status: result.status && result.status !== "queued" ? result.status : "running",
        progress_done: 0,
        progress_total: task.steps,
      });
      onFact("dispatched", true);
      onXp("dispatched");
      onTrack("questline.task.dispatched", { preset_key: task.ownerPresetKey, task: task.id, via: "click" });
      try {
        AudioEngine.play("assign");
      } catch {
        /* 忽略 */
      }
      showToast(`已派给${task.ownerTitle}，进度我帮您盯着`);
      onCompleteStage();
    } catch (err) {
      const message = err instanceof Error ? err.message : "";
      setError(message.includes("权限") || message.includes("FORBIDDEN")
        ? "当前角色没有派活权限；可以让店主账号来试这一步。"
        : "派活没有成功，任务没有被创建。稍后重试即可。");
    } finally {
      setBusy(false);
    }
  };

  const openNextStep = (to: string, id: string) => {
    onTrack("questline.next_step.clicked", { target: id });
    onClose();
    window.location.assign(to);
  };

  // 关闭时由 QuestlineHud 接管"织伴待命位"，这里不重复渲染
  if (!open) return null;

  const completed = state.status === "completed";
  const mood: GuideMood = completed
    ? "celebrate"
    : state.stage === "dispatch"
      ? thread ? "think" : "listen"
      : "listen";

  const bubbleText = completed
    ? `${content.stages[3]?.script.success ?? ""}`
    : hintVisible
      ? def.script.hint
      : def.script.enter;

  return (
    <div
      {...surface}
      className="fixed inset-0 z-40 overflow-y-auto bg-bg950/88 backdrop-blur-sm"
      data-questline-overlay="true"
      data-questline-stage={state.stage}
      role="dialog"
      aria-modal="true"
      aria-label="首日上岗引导"
    >
      <div className="mx-auto flex min-h-full w-full max-w-3xl flex-col gap-3 px-4 py-5">
        {/* 顶部：关卡灯 + 进度 + 关闭 */}
        <header className="min-w-0 rounded-2xl border border-gline/60 bg-panel/80 px-4 py-3">
          <div className="flex min-w-0 flex-wrap items-center gap-2">
            <span className="rounded border border-gold/60 bg-gold/10 px-2 py-0.5 text-body font-black tracking-widest text-gold">
              {content.journeyName}
            </span>
            <span className="text-body text-ink3">{content.mateName}（{content.mateRole}）陪您走</span>
            <span className="flex-1" />
            <span className="text-body text-ink3">董事长等级 {level.level} · {level.rank}</span>
            <span className="font-mono text-body text-goldhi">{xp} XP</span>
            {completed ? (
              <button
                type="button"
                onClick={onClose}
                className="min-h-8 rounded border border-line px-2 py-0.5 text-body text-ink3 hover:border-gline hover:text-ink"
              >
                关闭
              </button>
            ) : (
              <button
                type="button"
                onClick={onClose}
                className="min-h-8 rounded border border-line px-2 py-0.5 text-body text-ink3 hover:border-gline hover:text-ink"
              >
                稍后再来
              </button>
            )}
          </div>
          <div className="mt-2 flex min-w-0 items-center gap-1.5">
            {QUEST_STAGE_ORDER.map((id, index) => {
              const done = state.stageDone.includes(id);
              const skipped = state.skipped.includes(id);
              const active = state.stage === id && !completed;
              const meta = stageDef(id);
              return (
                <div key={id} className="flex min-w-0 items-center gap-1.5">
                  <span
                    className={`inline-flex h-6 items-center gap-1 rounded-full border px-2 text-body ${
                      done
                        ? "border-go/60 bg-go/10 text-go"
                        : active
                          ? "border-gold/70 bg-gold/10 text-gold"
                          : skipped
                            ? "border-line bg-card text-ink3 line-through"
                            : "border-line bg-card text-ink3"
                    }`}
                    title={meta.title}
                  >
                    {done ? <Icon name="check" size={12} /> : <span className="font-mono">{index + 1}</span>}
                    <span className="hidden sm:inline">{meta.badge}</span>
                  </span>
                  {index < QUEST_STAGE_ORDER.length - 1 && <span className="h-px w-3 bg-line" />}
                </div>
              );
            })}
          </div>
        </header>

        {/* 关卡主体 */}
        <section className="min-w-0 rounded-2xl border border-line bg-card/95 px-4 py-4">
          {completed ? (
            <div className="min-w-0 space-y-3">
              <div className="mx-auto flex justify-center">
                <MateGuideAvatar size={96} mood="celebrate" />
              </div>
              <CompletionPanel onNext={openNextStep} />
              {/* 完成时也要"开口"：既是收尾台词，也把字幕条刷新到当前这句话 */}
              <MateGuideBubble text={bubbleText} tone="gold" />
            </div>
          ) : (
            <>
              <div className="mb-1 flex min-w-0 flex-wrap items-center gap-2">
                <h2 className="min-w-0 break-words text-h2 font-black text-ink">{def.title}</h2>
                <span className="text-body text-ink3">{def.badge}</span>
              </div>
              <p className="mb-3 min-w-0 break-words text-body leading-relaxed text-ink2">{def.objective}</p>

              {state.stage === "meet" && (
                <div className="min-w-0">
                  <div className="mb-2 flex items-center gap-2 text-body text-ink3">
                    <span>已认识 {litCore}/3 位当家人</span>
                    <button
                      type="button"
                      className="rounded border border-line px-2 py-0.5 hover:border-gline hover:text-ink"
                      onClick={() => setCardPage((p) => (p === 0 ? 1 : 0))}
                    >
                      {cardPage === 0 ? "换一批看看" : "看三位当家人"}
                    </button>
                  </div>
                  <div className="grid min-w-0 grid-cols-1 gap-3 sm:grid-cols-3">
                    {cards.map((card) => {
                      const lit = state.litCards.includes(card.id);
                      return (
                        <div
                          key={card.id}
                          className={`min-w-0 rounded-xl border p-3 ${lit ? "border-go/50 bg-go/5" : "border-line bg-bg900/60"}`}
                          data-employee-card={card.id}
                        >
                          <div className="flex items-center gap-2">
                            <span className="flex h-8 w-8 items-center justify-center rounded-md border border-gline/60 bg-gold/10 text-body font-black text-gold">
                              {card.title.slice(0, 1)}
                            </span>
                            <div className="min-w-0">
                              <div className="break-words text-body font-bold text-ink">{card.title}</div>
                              <div className="font-mono text-body text-ink3">{card.presetKey}</div>
                            </div>
                          </div>
                          <p className="mt-2 min-w-0 break-words text-body leading-relaxed text-ink2">{card.duty}</p>
                          <ul className="mt-2 space-y-0.5">
                            {card.fences.map((fence) => (
                              <li key={fence} className="break-words text-body text-holo">🛡 {fence}</li>
                            ))}
                          </ul>
                          <div className="mt-2 break-words text-body text-ink3">
                            常用：{card.tasks.join(" / ")}
                          </div>
                          {card.sampleIsDemo && (
                            <div className="mt-1 break-words text-body text-amber-300/80">
                              〔演示样例〕{card.sample}
                            </div>
                          )}
                          <button
                            type="button"
                            disabled={lit}
                            onClick={() => {
                              onLightCard(card.id);
                              try {
                                AudioEngine.play("pop");
                              } catch {
                                /* 忽略 */
                              }
                            }}
                            className={`mt-3 w-full rounded-lg border px-3 py-1.5 text-body font-bold ${
                              lit ? "border-go/50 text-go" : "border-gline/70 bg-gold/10 text-gold hover:bg-gold/20"
                            }`}
                          >
                            {lit ? "已认识 ✓" : "认识他"}
                          </button>
                        </div>
                      );
                    })}
                  </div>
                </div>
              )}

              {state.stage === "goal" && (
                <GoalStage
                  goalId={goalId}
                  onPick={setGoalId}
                  free={goalFree}
                  onFree={setGoalFree}
                />
              )}

              {state.stage === "dispatch" && (
                <DispatchStage
                  thread={thread}
                  dispatchedTaskId={dispatchedTaskId}
                  canDispatch={canDispatch}
                  onDispatch={(task) => void dispatch(task)}
                  busy={busy}
                />
              )}

              {state.stage === "review" && (
                <ReviewStage
                  thread={thread}
                  achievements={state.achievements}
                  xp={xp}
                  level={level}
                />
              )}

              {error && (
                <div role="alert" className="mt-3 min-w-0 break-words rounded-lg border border-warn/50 bg-warn/10 px-3 py-2 text-body leading-relaxed text-warn">
                  {error}
                </div>
              )}
            </>
          )}
        </section>

        {/* 底部：织伴 + 主按钮 */}
        {!completed && (
          <footer className="min-w-0 rounded-2xl border border-gline/50 bg-panel/85 px-4 py-3">
            <div className="flex min-w-0 items-end gap-3">
              {/* 窄屏隐藏织伴形象、只留台词气泡：移动端把屏留给可点的卡片 */}
              <span className="hidden shrink-0 sm:inline-flex">
                <MateGuideAvatar size={84} mood={mood} speaking />
              </span>
              <div className="min-w-0 flex-1">
                <MateGuideBubble text={bubbleText} tone="default">
                  <StageActions
                    stage={state.stage}
                    busy={busy}
                    thread={thread}
                    litCore={litCore}
                    goalReady={Boolean(goalId) || goalFree.trim().length > 0}
                    onPrimary={state.stage === "meet"
                      ? onCompleteStage
                      : state.stage === "goal"
                        ? confirmGoal
                        : state.stage === "review"
                          ? onCompleteStage
                          : undefined}
                    onSkip={onSkipStage}
                    onOpenThread={(id) => window.location.assign(`/tasks/${id}`)}
                    primaryLabel={state.stage === "meet"
                      ? def.primaryLabel
                      : state.stage === "goal"
                        ? def.primaryLabel
                        : state.stage === "review"
                          ? def.primaryLabel
                          : undefined}
                    disabled={state.stage === "goal" && !goalId && goalFree.trim().length === 0}
                  />
                </MateGuideBubble>
              </div>
            </div>
          </footer>
        )}
      </div>

      {toast && (
        <div className="pointer-events-none fixed left-1/2 top-6 z-50 -translate-x-1/2">
          <div className="rounded-full border border-gold/60 bg-bg900/95 px-4 py-2 text-body text-gold shadow-lg">
            {toast}
          </div>
        </div>
      )}
    </div>
  );
}
