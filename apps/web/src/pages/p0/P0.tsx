/**
 * P0 经营主页（默认首页）——数字CEO 与数字团队的主界面
 *
 * 界面三要素：形象（数字CEO全息CEO+员工员工状态）/ 实况（语音气泡+请示卡+实况字幕）/ 聊天框。
 * 设计原则：剧场负责「感觉」，工作台（/p1…）负责「操作」；全部状态来自真实事件（captain.theater 5s 心跳）。
 * 形象纯 SVG+CSS+Canvas 零素材；仪式：每日首访晨间播报（光核→光环→卫星逐亮→报到词）。
 * 2026-09-21 产品所有者口径（本机单人运行）：基座通用审批环节已移除——本页不再展示「请您决策」
 * 请示卡，员工状态卡不再提供批准/驳回手势；业务链路自带的关卡（如视频管线 G1–G10、定妆照确认）
 * 由各自业务页面就地放行。
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { ensureDemoLogin, isLocalFull, trpc } from "../../lib/trpc";
import { CommandCard } from "../../components/CommandCard";
import { actionText, actorText } from "../../lib/display";
import { SimBanner } from "../../components/SimBanner";
import { SkillDistBanner } from "../../components/SkillDistBanner";
import { FloorView, type FloorPayload, type FloorAgent } from "./Floor";
import { Stage3D } from "../../components/Stage3D";
import { Floor3D } from "../../components/Floor3D";
import { WelcomeCeremony } from "../../components/WelcomeCeremony";
import type { CeremonyActor } from "../../components/CeremonyStage";
import { VoiceEngine } from "../../voice/VoiceEngine";
import { AudioEngine } from "../../audio/AudioEngine";
import { useAmbience } from "../../audio/ambience";
import { ValueCounters } from "../../components/ValueCounters";
import { QuestlineHud } from "../../components/mate-guide/QuestlineHud";
import { QuestlineOverlay } from "../../components/mate-guide/QuestlineOverlay";
import { useQuestline } from "../../onboarding/useQuestline";
import { EMPTY_FACTS, factsFromRecentActions, type QuestFacts } from "../../onboarding/questline";
import { questlineForBundle } from "../../onboarding/questline.config";
import { QuestlineContentProvider } from "../../onboarding/QuestlineContent";
import { useTheaterDiff } from "../../lib/theaterDiff";
import { displayNameOf, hydrateAliases, reportTitleOf, selectReporters } from "../../lib/naming";
import { useNavigate } from "react-router";
import { useNavigationAccess } from "../../shell/NavigationAccess";
import { clientChineseText } from "@workloom/ui";

/* ================= 类型 ================= */
interface Satellite { id: string; presetKey: string; name: string; alias?: string | null; grade: string }
interface TickerItem { event_id: string; action: string; who: string; created_at: string }
interface Theater {
  mode: string; ceoName: string;
  pendingByTier: Record<string, number>;
  latestBriefing: { text: string; at: string } | null;
  satellites: Satellite[];
  ticker: TickerItem[];
  floor?: FloorPayload | null;
}
interface WelcomeState {
  status: "not_started" | "in_progress" | "paused" | "completed";
  currentStep: "start" | "mate" | "team" | "summary" | "done";
  journeyVersion: number;
  replayCount: number;
  shouldShow: boolean;
  persisted: boolean;
  role: string;
}

function safeInteractionError(error: unknown, fallback: string): string {
  const message = error instanceof Error ? error.message : "";
  if (message.includes("未认证")) return "登录状态已失效，请重新登录后继续。";
  if (message.includes("权限") || message.includes("FORBIDDEN")) return "当前角色没有执行该操作的权限。";
  if (message.includes("过期")) return "当前内容已更新，请刷新后再试。";
  return fallback;
}

/** 数字CEO 模式 → 中文（剧场顶栏 chip；与 P21 MODE_LABEL 同口径） */
const MODE_TEXT: Record<string, string> = {
  disabled: "未授权", shadow: "影子模式", trial: "试用期", suspended: "仅汇报", active: "正式受托",
};

/** 未安装行业投影时只展示中性的基座动作，不猜测任何行业。 */
const BASE_TASK_CARDS = ["查看今日待办", "查看任务进度", "处理待审批事项", "查看运行报告"];
const BRIEFING_FALLBACK = "昨夜班组运行正常，今日请指示。";

/* ================= 星野画布 ================= */
function Starfield({ density = 110 }: { density?: number }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const cv = ref.current!;
    const ctx = cv.getContext("2d")!;
    let w = (cv.width = cv.offsetWidth), h = (cv.height = cv.offsetHeight);
    const stars = Array.from({ length: density }, () => ({
      x: Math.random() * w, y: Math.random() * h,
      r: Math.random() * 1.4 + 0.3, s: Math.random() * 0.25 + 0.05, tw: Math.random() * Math.PI * 2,
    }));
    let raf = 0;
    const tick = () => {
      if (cv.offsetWidth !== w || cv.offsetHeight !== h) { w = cv.width = cv.offsetWidth; h = cv.height = cv.offsetHeight; }
      ctx.clearRect(0, 0, w, h);
      for (const st of stars) {
        st.y -= st.s; st.tw += 0.03;
        if (st.y < -4) { st.y = h + 4; st.x = Math.random() * w; }
        const a = 0.25 + 0.35 * (0.5 + 0.5 * Math.sin(st.tw));
        ctx.fillStyle = `rgba(255,120,150,${a})`;
        ctx.beginPath(); ctx.arc(st.x, st.y, st.r, 0, Math.PI * 2); ctx.fill();
      }
      raf = requestAnimationFrame(tick);
    };
    tick();
    return () => cancelAnimationFrame(raf);
  }, [density]);
  return <canvas ref={ref} className="absolute inset-0 h-full w-full" />;
}

/* ================= 数字CEO全息 CEO ================= */
function Hologram({ tone, active }: { tone: "gold" | "holo" | "amber" | "red" | "grey"; active: boolean }) {
  const colors = {
    gold: ["#e8edf4", "#a8b2be"], holo: ["#b3c6de", "#7f97b8"],
    amber: ["#ffbe6a", "#c8842a"], red: ["#ff8a8a", "#c84a4a"], grey: ["#9a9aa8", "#5a5a68"],
  }[tone];
  return (
    <div className={`relative mx-auto h-56 w-56 ${active ? "" : "opacity-70"}`}>
      {/* 三层光环 */}
      {[0, 1, 2].map((i) => (
        <div key={i} className="absolute rounded-[50%] border"
          style={{
            inset: `${i * 14}px`, borderColor: `${colors[1]}${i === 0 ? "88" : i === 1 ? "55" : "33"}`,
            transform: `rotateX(68deg)`, animation: `holo-spin ${9 - i * 2}s linear infinite ${i % 2 ? "reverse" : ""}`,
          }} />
      ))}
      {/* 人形光躯 */}
      <svg data-wl-custom-graphic="hologram-figure" viewBox="0 0 120 160" aria-hidden="true" className="absolute inset-0 m-auto h-40 w-32">
        <defs>
          <radialGradient id="core" cx="50%" cy="42%" r="55%">
            <stop offset="0%" stopColor={colors[0]} stopOpacity="0.95" />
            <stop offset="60%" stopColor={colors[1]} stopOpacity="0.35" />
            <stop offset="100%" stopColor={colors[1]} stopOpacity="0" />
          </radialGradient>
          <linearGradient id="body" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={colors[0]} stopOpacity="0.9" />
            <stop offset="100%" stopColor={colors[1]} stopOpacity="0.15" />
          </linearGradient>
        </defs>
        <ellipse cx="60" cy="26" rx="14" ry="16" fill="none" stroke={colors[0]} strokeOpacity="0.85" strokeWidth="1.4" />
        <path d="M42 52 Q60 42 78 52 L86 108 Q60 122 34 108 Z" fill="none" stroke={colors[0]} strokeOpacity="0.7" strokeWidth="1.4" />
        <ellipse cx="60" cy="72" rx="17" ry="22" fill="url(#core)" className="holo-core" />
        <line x1="34" y1="0" x2="86" y2="0" stroke={colors[0]} strokeOpacity="0.5" strokeWidth="2" className="holo-scan" />
      </svg>
      {/* 基座投影 */}
      <div className="absolute -bottom-2 left-1/2 h-3 w-32 -translate-x-1/2 rounded-[50%]"
        style={{ background: `radial-gradient(ellipse, ${colors[1]}55, transparent 70%)` }} />
    </div>
  );
}

/* ================= 员工员工状态 ================= */
function Satellites({ agents, onPick }: { agents: Satellite[]; onPick: (a: Satellite) => void }) {
  const [t, setT] = useState(0);
  useEffect(() => {
    let raf = 0; const start = Date.now();
    const loop = () => { setT((Date.now() - start) / 1000); raf = requestAnimationFrame(loop); };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, []);
  const colorOf = (g: string) => g === "表扬" ? "#6adf8a" : g === "辅导" ? "#ff8a8a" : g === "关注" ? "#ffbe6a" : "#8ad8ff";
  return (
    <>
      {agents.map((a, i) => {
        const agentName = clientChineseText(a.name, actorText(a.presetKey));
        const ang = (i / agents.length) * Math.PI * 2 + t * 0.07 * (i % 2 ? 1 : -0.7);
        const rx = 200 + (i % 3) * 34, ry = 74 + (i % 3) * 12;
        const x = Math.cos(ang) * rx, y = Math.sin(ang) * ry;
        return (
          <button key={a.id} onClick={() => onPick(a)}
            className="group absolute z-10 -translate-x-1/2 -translate-y-1/2"
            style={{ left: `calc(50% + ${x}px)`, top: `calc(46% + ${y}px)` }}
            title={`${agentName} · ${clientChineseText(a.grade, "状态待确认")}`}>
            <span className="block h-2.5 w-2.5 rounded-full transition-all group-hover:scale-150"
              style={{ background: colorOf(a.grade), boxShadow: `0 0 10px ${colorOf(a.grade)}, 0 0 22px ${colorOf(a.grade)}66`, animation: `sat-pulse ${2.4 + (i % 4) * 0.5}s ease-in-out infinite` }} />
            <span className="pointer-events-none absolute left-1/2 top-3 w-max max-w-48 -translate-x-1/2 break-words text-center text-body text-ink3 opacity-0 transition-opacity group-hover:opacity-100">
              {agentName}
            </span>
          </button>
        );
      })}
    </>
  );
}

/* ================= 主组件 ================= */
export default function P0() {
  const { bundle, entries, canAction, subject } = useNavigationAccess();
  const navigate = useNavigate();
  const canDispatch = canAction("task.dispatch");
  const [wsName, setWsName] = useState("WorkLoom");
  const [showWelcome, setShowWelcome] = useState(false);
  const [welcome, setWelcome] = useState<WelcomeState | null>(null);
  const bundleId = bundle?.bundleId ?? null;
  const setWelcomeVisible = (visible: boolean) => {
    window.dispatchEvent(new CustomEvent<boolean>("workloom:welcome", { detail: visible }));
    setShowWelcome(visible);
  };
  useEffect(() => {
    void ensureDemoLogin().then(async () => {
      await Promise.all([
        trpc.onboarding.status.query().then((r) => {
          const rr = r as { workspace?: { name?: string }; bundle?: { id?: string | null; isExample?: boolean }; workspaceId?: string };
          const n = rr.workspace?.name;
          if (n) setWsName(n);
        }).catch(() => undefined),
        trpc.onboarding.welcomeStatus.query().then((result) => {
          const progress = result as WelcomeState;
          setWelcome(progress);
          if (progress.shouldShow) setWelcomeVisible(true);
        }).catch(() => undefined),
      ]);
    });
  }, []);
  const [data, setData] = useState<Theater | null>(null);

  /**
   * 职场视图分批（2026-09-20 密度重设计）：
   *  - 排序：有请托/异常/汇报/协作/在跑任务的员工优先，其次待命，最后停用工位；
   *  - 分批：每批 18 人（3×6 站位舒适密度），第 1 批天然是"活跃置顶"；
   *  - 自动轮播：每 12 秒换一批，可暂停/手动换批（人数 ≤ 每批上限时不轮播）。
   */
  const FLOOR_BATCH_SIZE = 18;
  const [waveIndex, setWaveIndex] = useState(0);
  const floorAgentsAll = useMemo(() => data?.floor?.agents ?? [], [data]);
  const sortedFloorAgents = useMemo(() => {
    const rank: Record<string, number> = { asking: 0, blocked: 1, celebrating: 2, collab: 3, working: 4, idle: 5, disabled: 6 };
    return [...floorAgentsAll].sort(
      (a, b) => (rank[a.state] ?? 9) - (rank[b.state] ?? 9) || a.id.localeCompare(b.id),
    );
  }, [floorAgentsAll]);
  const floorWaves = useMemo(() => {
    const waves: FloorAgent[][] = [];
    for (let i = 0; i < sortedFloorAgents.length; i += FLOOR_BATCH_SIZE) {
      waves.push(sortedFloorAgents.slice(i, i + FLOOR_BATCH_SIZE));
    }
    return waves.length ? waves : [[]];
  }, [sortedFloorAgents]);
  const visibleFloorAgents = floorWaves[Math.min(waveIndex, floorWaves.length - 1)] ?? [];
  useEffect(() => { setWaveIndex((i) => (i >= floorWaves.length ? 0 : i)); }, [floorWaves.length]);
  useEffect(() => {
    if (floorWaves.length <= 1) return;
    const timer = window.setInterval(() => setWaveIndex((i) => (i + 1) % floorWaves.length), 12_000);
    return () => window.clearInterval(timer);
  }, [floorWaves.length]);
  /* ---- 首日上岗（织伴 · 首席增长官带玩）：进度本地持久化，关卡推进只认客户操作与真实事实 ---- */
  const [questFacts, setQuestFacts] = useState<QuestFacts>(EMPTY_FACTS);
  const [serverXp, setServerXp] = useState<number | null>(null);
  const memberNo = subject?.memberNo ?? null;
  // S3：跨页面事实由剧场 ticker（近 14 条真实事件）推导——
  // 3D 职场拖拽派活、AskRail 派活都能被认出来，而不是只认引导层里的动作。
  const tickerFacts = useMemo(
    () => factsFromRecentActions(
      (data?.ticker ?? []).map((item) => ({ action: item.action, who: item.who })),
      memberNo,
    ),
    [data?.ticker, memberNo],
  );
  const questlineFacts = useMemo<QuestFacts>(
    () => ({
      ...questFacts,
      dispatched: questFacts.dispatched || tickerFacts.dispatched,
      decided: questFacts.decided || tickerFacts.decided,
    }),
    [questFacts, tickerFacts],
  );
  // 欢迎仪式走完才算"起跑线"；中途暂停欢迎的客户仍可从左下角手动开始
  const questlineReady = Boolean(!showWelcome && welcome && welcome.status === "completed");
  // 内容包随当前活动 Bundle 切换（酒店/GEO/短视频各一套）；解析不到就不显示引导，
  // 宁可不引导，也不能把别的行业的岗位与人设塞给客户。
  const questlineContent = useMemo(() => questlineForBundle(bundleId), [bundleId]);
  const questline = useQuestline({
    ready: questlineReady && questlineContent !== null,
    facts: questlineFacts,
    ...(questlineContent ? { content: questlineContent } : {}),
  });
  // M1：等级/XP 以团队页同源（roster 30 天事件投影）为准，避免同一屏出现两个"董事长等级"
  useEffect(() => {
    if (!questlineReady || !memberNo) return;
    let stopped = false;
    const loadXp = async () => {
      try {
        await ensureDemoLogin();
        const roster = await trpc.roster.list.query() as { humans?: Array<{ memberNo: string; game?: { xp?: number } }> };
        if (stopped) return;
        const mine = (roster.humans ?? []).find((h) => h.memberNo === memberNo);
        if (mine?.game && typeof mine.game.xp === "number") setServerXp(mine.game.xp);
      } catch {
        /* 取不到就不显示累计口径，退回本次会话 XP */
      }
    };
    void loadXp();
    const timer = window.setInterval(() => void loadXp(), 60_000);
    return () => {
      stopped = true;
      window.clearInterval(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [questlineReady, memberNo]);
  const markQuestFact = (key: keyof QuestFacts, value: boolean) => {
    setQuestFacts((current) => (current[key] === value ? current : { ...current, [key]: value }));
  };
  const [pick, setPick] = useState<Satellite | null>(null);
  const [ceremony, setCeremony] = useState(0); // 0=未演 1-4=晨间播报阶段 5=完成
  const [msg, setMsg] = useState("");
  // D25 视图：floor=数字办公区（默认） / stage=剧场舞台（D23）
  const [view, setView] = useState<"floor" | "stage">(() =>
    (typeof localStorage !== "undefined" && localStorage.getItem("theater-view") === "stage") ? "stage" : "floor");
  // WebGL 可用性探测：不可用（远程桌面/老驱动/虚拟机）时 3D 舞台自动降级为 SVG 卫星视图
  const webglOk = useMemo(() => {
    try {
      const c = document.createElement("canvas");
      return !!(c.getContext("webgl2") ?? c.getContext("webgl"));
    } catch { return false; }
  }, []);
  const switchView = (v: "floor" | "stage") => { setView(v); localStorage.setItem("theater-view", v); };
  // —— M1 视听觉醒：事件源 / 环境声 / 手势启动 ——
  const directorEvent = useTheaterDiff(data);
  useAmbience();
  useEffect(() => { AudioEngine.bindGesture(); }, []);
  // 调试探针（运行时自测用；生产无副作用）
  useEffect(() => { (window as unknown as { __wlVoice?: typeof VoiceEngine }).__wlVoice = VoiceEngine; }, []);
  // 熔断事件 → 语音强制打断（运镜与警报声由 CineDirector 处理）
  useEffect(() => {
    if (showWelcome) return;
    if (directorEvent?.kind === "fuse") {
      VoiceEngine.speak({ role: "company-ceo", persona: "顾云峥", text: directorEvent.text, priority: "fuse" });
    }
  }, [directorEvent, showWelcome]);
  // 晨间仪式语音播报（F-REPORT1）：CEO 先晨报 → 有事汇报/关键岗位依次报到
  // 遴选纪律：七八十名员工不全上——有事的（评级异常）+ 部门经理级必报，上限 8 名；
  // 命名纪律：设了别名报「岗位名·别名」，未设只报岗位名，绝不报系统默认人名。
  const ceremonyVoiced = useRef(false);
  useEffect(() => {
    if (showWelcome || ceremony >= 5 || ceremony < 2 || ceremonyVoiced.current || !data) return;
    ceremonyVoiced.current = true;
    AudioEngine.play("fanfare");
    // ① CEO 先汇报（晨报主体）
    window.setTimeout(() => {
      const text = clientChineseText(data.latestBriefing?.text, BRIEFING_FALLBACK);
      VoiceEngine.speak({ role: "company-ceo", persona: "数字总经理", text, priority: "ceremony" });
    }, 400);
    // ② 遴选汇报人依次报到
    const reporters = selectReporters(data.satellites);
    reporters.forEach((a, i) => {
      window.setTimeout(() => {
        const title = reportTitleOf(a.name, a.presetKey);
        const abnormal = (a.grade ?? "正常") !== "正常";
        VoiceEngine.speak({
          role: a.presetKey, persona: title,
          text: abnormal ? `${title}，有情况向您汇报` : `${title}，向您报到`,
          priority: "ceremony",
        });
      }, 2400 + i * 1600);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ceremony, data, showWelcome]);

  const load = async () => {
    await ensureDemoLogin();
    const t = await trpc.captain.theater.query() as Theater;
    setData({
      ...t,
      latestBriefing: t.latestBriefing
        ? { ...t.latestBriefing, text: clientChineseText(t.latestBriefing.text, BRIEFING_FALLBACK) }
        : null,
    });
    hydrateAliases(t.satellites.map((a) => ({ presetKey: a.presetKey, alias: a.alias })));
  };
  const saveWelcome = async (
    status: "in_progress" | "paused" | "completed",
    currentStep: WelcomeState["currentStep"],
  ) => {
    try {
      const result = await trpc.onboarding.saveWelcomeProgress.mutate({ status, currentStep }) as Omit<WelcomeState, "role">;
      setWelcome((current) => current ? { ...result, role: current.role } : null);
    } catch {
      setMsg("欢迎引导进度暂时无法保存，请稍后重试。");
      setTimeout(() => setMsg(""), 3500);
    } finally {
      if (status === "paused" || status === "completed") setWelcomeVisible(false);
    }
  };
  useEffect(() => {
    void load();
    const id = setInterval(() => void load(), 5000); // 5s 心跳
    return () => clearInterval(id);
  }, []);

  // 开门仪式（每日首访）
  useEffect(() => {
    const key = `theater-ceremony-${new Date().toDateString()}`;
    if (localStorage.getItem(key)) { setCeremony(5); return; }
    localStorage.setItem(key, "1");
    setCeremony(1);
    const seq = [900, 1800, 2900, 4200];
    seq.forEach((ms, i) => setTimeout(() => setCeremony(i + 2), ms));
  }, []);

  const tone = useMemo(() => {
    if (!data) return "grey" as const;
    if (data.mode === "disabled") return "grey" as const;
    if (data.mode === "trial" || data.mode === "active") return "gold" as const;
    return "holo" as const;
  }, [data]);

  const showCeremony = ceremony < 5;
  return (
    <div
      data-product-ready={data ? "true" : "false"}
      data-product-bundle={bundleId ?? ""}
      data-product-actors={data ? String(data.satellites.length) : "0"}
      className="relative flex min-h-screen flex-col overflow-x-hidden bg-bg950"
    >
      <Starfield density={typeof window !== "undefined" && window.innerWidth < 768 ? 60 : 110} />

      {/* 顶栏（极简） */}
      <header className="relative z-20 flex min-w-0 flex-wrap items-center gap-3 px-4 py-2.5">
        <span className="bg-gradient-to-r from-gold to-gold2 bg-clip-text font-bold text-transparent">{wsName}</span>
        <span className="break-words text-body text-ink3">经营主页 · {clientChineseText(data?.ceoName, "公司负责人")}</span>
        <span className="flex-1" />
        {msg && <span className="break-words text-body text-go">{msg}</span>}
        {/* D25 视图切换：职场=等距办公区 / 舞台=全息员工状态 */}
        <div className="flex overflow-hidden rounded border border-line text-body">
          <button onClick={() => switchView("floor")} className={`px-2 py-0.5 ${view === "floor" ? "bg-gold/15 text-gold" : "text-ink3 hover:text-ink2"}`}>职场</button>
          <button onClick={() => switchView("stage")} className={`px-2 py-0.5 ${view === "stage" ? "bg-gold/15 text-gold" : "text-ink3 hover:text-ink2"}`}>舞台</button>
        </div>
        {/* 本机个人使用：银带删除后，演示数据披露由这枚小徽标承担（不占行、不可点） */}
        {isLocalFull() && (
          <span
            className="rounded border border-line px-2 py-0.5 text-body text-ink3"
            title="当前为示例装配的模拟运行态：数据与团队可真实操作，但不是真实客户的经营数据"
          >
            演示数据
          </span>
        )}
        {/* 本机个人使用：不展示「试用期/未授权」等开通类角标（启动器注入 VITE_WORKLOOM_LOCAL_FULL=1） */}
        {!isLocalFull() && (
          <span className={`rounded border px-2 py-0.5 text-body ${tone === "gold" ? "border-gline text-gold" : "border-line text-ink3"}`}>
            {MODE_TEXT[data?.mode ?? ""] ?? "…"}
          </span>
        )}
        <ValueCounters />
      </header>

      {/* 模拟数据横幅（D24：引导落地向导接入真实数据与真实大模型） */}
      <SimBanner />
      {/* 技能更新通栏（技能保鲜环：夜班自动更新提示 / L2 待审批引导） */}
      <SkillDistBanner />

      {/* 舞台 */}
      <main className="relative z-10 flex min-h-0 flex-1 flex-col items-center justify-center px-4">
        {view === "floor" && data?.floor ? (
          <div className={`w-full max-w-3xl transition-all duration-1000 ${showCeremony && ceremony < 2 ? "scale-95 opacity-0" : "opacity-100"}`}>
            {/* 顶部状态行 / 批次控件 / 操作提示 / 任务卡：2026-09-20 产品决定全部删除（保持主视图纯粹） */}
            {!showWelcome && webglOk ? (
              <Floor3D
                directorEvent={directorEvent}
                floor={{ ...data.floor, agents: visibleFloorAgents }}
                ceoName={clientChineseText(data.ceoName, "公司负责人")}
                onPickAgent={(a) => setPick({ id: a.id, presetKey: a.presetKey, name: a.name, grade: data.satellites.find((s) => s.id === a.id)?.grade ?? "正常" })}
                onOpenProfile={(a) => navigate(`/agents/${encodeURIComponent(a.id)}`)}
                onOpenTask={(threadId) => navigate(`/tasks/${encodeURIComponent(threadId)}`)}
              />
            ) : (
              <FloorView
                floor={{ ...data.floor, agents: visibleFloorAgents }}
                ceoName={clientChineseText(data.ceoName, "公司负责人")}
                onPickAgent={(a) => setPick({ id: a.id, presetKey: a.presetKey, name: a.name, grade: data.satellites.find((s) => s.id === a.id)?.grade ?? "正常" })}
                onOpenProfile={(a) => navigate(`/agents/${encodeURIComponent(a.id)}`)}
                onOpenTask={(threadId) => navigate(`/tasks/${encodeURIComponent(threadId)}`)}
              />
            )}
          </div>
        ) : (
          <div className={`w-full max-w-3xl transition-all duration-1000 ${showCeremony && ceremony < 2 ? "scale-90 opacity-0" : "opacity-100"}`}>
            {data && (!showWelcome && webglOk ? (
              <Stage3D
                agents={data.satellites}
                active={!showCeremony || ceremony >= 3}
                onPick={(a) => setPick(a as Satellite)}
                ceremony={showCeremony && ceremony >= 2}
              />
            ) : (
              <div data-product-scene="report-stage-2d" data-product-scene-actors={String(data.satellites.length + 1)}>
                <Hologram tone={tone} active={!showCeremony || ceremony >= 3} />
                <Satellites agents={data.satellites} onPick={setPick} />
              </div>
            ))}
          </div>
        )}

      </main>

      {/* 实况字幕条：2026-09-20 产品决定删除（不再展示） */}
      {/* 底部对话入口区：2026-09-20 产品决定整块删除（对话统一在右侧「织伴」全局框，⌘K 可唤起） */}

      {/* 员工指挥卡弹层（派活闭环：绩效速览 + 派活输入 + 岗位快捷任务） */}
      {canDispatch && pick && (
        <CommandCard
          target={pick}
          onClose={() => setPick(null)}
          onDispatched={(m) => { setMsg(m); setTimeout(() => setMsg(""), 3500); void load(); }}
        />
      )}

      {/* 开门仪式遮罩 */}
      {showCeremony && (
        <div className="absolute inset-0 z-40 flex items-center justify-center bg-bg950 transition-opacity duration-700"
          style={{ opacity: ceremony >= 4 ? 0 : 1, pointerEvents: ceremony >= 4 ? "none" : "auto" }}>
          <div className="text-center">
            <div className={`mx-auto mb-4 h-3 w-3 rounded-full bg-gold transition-all duration-700 ${ceremony >= 2 ? "scale-[3] shadow-[0_0_60px_#e8edf4]" : "scale-100"}`} />
            <div className={`text-sm tracking-[.3em] text-gold transition-opacity duration-700 ${ceremony >= 3 ? "opacity-100" : "opacity-0"}`}>
              团队全员就位
            </div>
            <div className={`mt-2 text-body text-ink3 transition-opacity duration-700 ${ceremony >= 4 ? "opacity-100" : "opacity-0"}`}>
              向您报到，董事长
            </div>
          </div>
        </div>
      )}
      {/* 首次启动欢迎仪式（V4 §0：is_example 工作区 + 仅一次；团队编制驱动布阵） */}
      {showWelcome && data && (
        <WelcomeCeremony
          actors={[
            { presetKey: "company-ceo", name: displayNameOf({ presetKey: "company-ceo", roleName: data.ceoName }) } satisfies CeremonyActor,
            ...data.satellites.map((a): CeremonyActor => ({ presetKey: a.presetKey, name: displayNameOf({ presetKey: a.presetKey, roleName: a.name }) })),
          ]}
          bundleName={wsName}
          welcome={bundle?.ui.welcome}
          initialStep={welcome?.currentStep ?? "start"}
          role={welcome?.role ?? "staff"}
          onProgress={(currentStep) => void saveWelcome("in_progress", currentStep)}
          onPause={(currentStep) => void saveWelcome("paused", currentStep)}
          onDone={() => void saveWelcome("completed", "done")}
        />
      )}
      {/* 新闻台字幕条（语音字幕等价物 + 降级兜底） */}
      {/* 首日上岗：常驻入口（织伴待命位）+ 引导壳（五关）；内容包随活动 Bundle 切换 */}
      {questlineContent && (
        <QuestlineContentProvider content={questlineContent}>
          {!showWelcome && (
            <QuestlineHud
              summary={questline.summary}
              level={questline.level}
              xp={questline.xp}
              achievements={questline.state.achievements}
              serverXp={serverXp}
              completed={questline.state.status === "completed"}
              onOpen={questline.openQuestline}
            />
          )}
          <QuestlineOverlay
            open={questline.open && !showWelcome}
            state={questline.state}
            level={questline.level}
            xp={questline.xp}
            celebration={questline.celebration}
            canDispatch={canDispatch}
            onClose={questline.closeQuestline}
            onCompleteStage={questline.completeCurrent}
            onSkipStage={questline.skipCurrent}
            onLightCard={questline.markCard}
            onFact={markQuestFact}
            onXp={questline.noteXp}
            onThreadId={questline.setThreadId}
            onClearCelebration={questline.clearCelebration}
            onTrack={questline.track}
          />
        </QuestlineContentProvider>
      )}
      {/* 播报台/字幕条：2026-09-20 产品决定删除（语音字幕不再常驻经营主页） */}
    </div>
  );
}
