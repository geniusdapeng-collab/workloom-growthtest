/**
 * LoomMate 织伴 · 24h 贴身小秘书浮层（基座能力，全页面常驻）
 * 形态：甜妹人设（可换人设/音色）· 可爱大眼睛会眨眼（纯 SVG/CSS 零素材）
 *      大/小两种尺寸手动切换（默认大尺寸）· 气泡提醒 · 对话面板 · 记忆透明面板
 * 铁律：不替人决策 / 不打扰（勿扰+聚合）/ 不装在线
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router";
import { ensureDemoLogin, trpc } from "../../lib/trpc";
import { VoiceEngine } from "../../voice/VoiceEngine";
import { mateVoiceProfileOf } from "../../voice/mateVoice";
import { AudioEngine } from "../../audio/AudioEngine";
import { MateLive2D, type MateMood, type MateGesture } from "./MateLive2D";
import { LoomBall, emotionLabelOf, emotionOfSystem, loomBallEnabled, useStableEmotion, type SystemStatusSignal } from "../loomball";
import { useAskRailPadding, useSideNavWidth } from "../../lib/useAskRail";
import { canonicalNavigationPath } from "../../shell/NavMenu";
import { Icon, clientChineseText, clientValueText, useManagedSurface } from "@workloom/ui";
import { inboxSpeechText } from "./speechText";

/* ---------------- 类型 ---------------- */
interface Settings {
  member_no: string; display_name: string; persona_key: string;
  persona_custom: { name?: string; tone?: string }; voice_key: string; voice_on: boolean;
  widget_size: "small" | "large" | "fullscreen"; quiet_start: string; quiet_end: string;
  channels: { im?: { provider: string; target: string }; outbox_urls?: string[] };
}
interface InboxItem {
  id: string; kind: "judge" | "done" | "alert" | "daily"; level: "red" | "high" | "mid" | "low";
  title: string; body: string; actions: Array<{ label: string; link: string }>; link: string | null;
  status: string; created_at: string;
}
interface MemRow { id: string; layer: string; mkey: string; content: string; source: string; confidence: string; created_at: string }
interface ChatMsg { from: "me" | "mate"; text: string }
/** 班组活跃度（video.studio.active 只读投影：run 注册表 + approvals 表两路真实信号） */
interface StudioActive {
  activeRuns: number; running: number; awaitingApproval: number;
  pendingApprovals: number; failedRecent: number; activeRunIds: string[];
}

/** 勿扰时段判定（"HH:MM"~"HH:MM"，支持跨零点；格式非法时按不在时段处理，不猜） */
function inQuietHours(start: string | undefined, end: string | undefined, now: Date): boolean {
  const parse = (value: string | undefined): number | null => {
    const match = /^(\d{1,2}):(\d{2})$/.exec((value ?? "").trim());
    if (!match) return null;
    const hours = Number(match[1]);
    const minutes = Number(match[2]);
    if (hours > 23 || minutes > 59) return null;
    return hours * 60 + minutes;
  };
  const from = parse(start);
  const to = parse(end);
  if (from === null || to === null) return false;
  const at = now.getHours() * 60 + now.getMinutes();
  return from <= to ? at >= from && at <= to : at >= from || at <= to;
}

/**
 * 任务完成播报（2026-09-20 产品所有者设计）：
 *   任务一完成，小织主动出来播报——挥魔法棒 → 指向右侧对话框（那里有完成通知卡片）。
 *   纯情绪价值：睁大眼起手、眯眼笑收尾，星尘沿指向飞向右栏，配一声欢快仪式音。
 */
interface SettledTaskNotice {
  threadId: string;
  title: string;
  status: "completed" | "failed";
}
/** 星尘：从魔法棒位置（人物左侧持棒手）洒出，飞向右栏 */
const WAND_SPARKS = [
  { left: 30, top: 42, dx: 120, dy: -70, delay: 0 },
  { left: 27, top: 46, dx: 180, dy: -30, delay: 0.06 },
  { left: 33, top: 49, dx: 240, dy: 10, delay: 0.12 },
  { left: 29, top: 53, dx: 300, dy: 40, delay: 0.18 },
  { left: 35, top: 39, dx: 150, dy: -100, delay: 0.24 },
  { left: 24, top: 50, dx: 260, dy: -40, delay: 0.3 },
  { left: 32, top: 57, dx: 340, dy: 20, delay: 0.36 },
  { left: 26, top: 44, dx: 210, dy: -60, delay: 0.42 },
] as const;

/**
 * 织伴音色档位统一走 voice/mateVoice.ts#mateVoiceProfileOf —— 单一事实源。
 * （旧实现在这里另写了一份 VOICE_MAP，其中 calm 档没标 female，会掉进男声兜底，
 * 于是同一台机器上织伴"一会儿男声一会儿女声"；2026-09-20 真机反馈后合并到一处。）
 */
const PERSONA_NAME: Record<string, string> = { tianmei: "小织", yuanqi: "小元气", chenwen: "织稳" };
const LAYER_TEXT: Record<string, string> = {
  profile: "身份", facts: "事实", preferences: "偏好", relations: "关系", episodic: "情景", working: "进行中",
};
const SOURCE_TEXT: Record<string, string> = { said: "您亲口说的", observed: "观察所得", inferred: "系统推断" };
const LEVEL_STYLE: Record<string, string> = {
  red: "border-alert/60 bg-alert/10", high: "border-gold/50 bg-gold/10",
  mid: "border-gline bg-bg800", low: "border-line bg-bg850",
};

const svc = () => trpc.service as unknown as {
  secretary: {
    settings: { query: () => Promise<{ settings: Settings }> };
    saveSettings: { mutate: (i: Partial<Settings>) => Promise<{ settings: Settings }> };
    scan: { mutate: () => Promise<{ added: number }> };
    inbox: { query: (i?: { unreadOnly: boolean }) => Promise<{ items: InboxItem[] }> };
    markInbox: { mutate: (i: { ids: string[]; status: "read" | "acted" }) => Promise<unknown> };
    reminders: { query: () => Promise<{ reminders: Array<{ id: string; text: string; due_at: string }> }> };
    memoryPanel: { query: () => Promise<{ memory: Record<string, MemRow[]> }> };
    forget: { mutate: (i: { memoryId: string }) => Promise<unknown> };
    chat: { mutate: (i: { text: string }) => Promise<{ reply: string; action?: string; data?: unknown }> };
  };
};

/* ---------------- 小织形象兜底（真实 Mao 海报 · 禁自创） ----------------
 * Live2D 主路径不可用（无 WebGL/模型加载失败）时的兜底：展示官方 Mao 模型的
 * 真实静态海报（poster.png，取自系统实拍），配呼吸动画——
 * 纪律：兜底形象必须是系统内真实形象，禁止手绘/自创替代品（2026-09 教训：
 * 此处曾长期残留已淘汰的紫发卡通 SVG，造成品牌事故；后又被手绘金毛 SVG 二次污染）。
 * 换形象 = 换模型 + 换 poster.png，两件必须同批。 */
function MateAvatar({ size, excited }: { size: number; excited: boolean }) {
  return (
    <>
      <style>{`
        @keyframes matebreath { 0%,100% { transform: translateY(0) } 50% { transform: translateY(-2.5px) } }
        @keyframes matewave { 0%,100% { transform: rotate(-3deg) } 50% { transform: rotate(3deg) } }
      `}</style>
    <img
      src="/live2d/mao/poster.png"
      width={size}
      height={Math.round(size * (400 / 414))}
      alt="小织"
      draggable={false}
      className={excited ? "animate-[matewave_0.9s_ease-in-out_infinite]" : "animate-[matebreath_3.2s_ease-in-out_infinite]"}
      style={{ objectFit: "contain", userSelect: "none" }}
    />
    </>
  );
}

/* ---------------- 主组件 ---------------- */
export function LoomMate() {
  const navigate = useNavigate();
  const railW = useAskRailPadding();
  const navW = useSideNavWidth();
  const [viewport, setViewport] = useState(() => ({ width: window.innerWidth, height: window.innerHeight }));
  const [settings, setSettings] = useState<Settings | null>(null);
  const [items, setItems] = useState<InboxItem[]>([]);
  const [studioActive, setStudioActive] = useState<StudioActive | null>(null);
  const [open, setOpen] = useState<"none" | "settings" | "memory">("none");
  const [busy, setBusy] = useState(false);
  const [memory, setMemory] = useState<Record<string, MemRow[]> | null>(null);
  const seenIds = useRef<Set<string>>(new Set());
  const sizeToggleRef = useRef<HTMLButtonElement | null>(null);
  const size = settings?.widget_size ?? "large";

  /* —— 浮层交互（拖拽移动 / 迷你球 / 隐藏把手；本机偏好存 localStorage，2026-09 浮层 UX 专项） —— */
  const [pos, setPos] = useState<{ x: number; y: number } | null>(() => {
    try {
      const v = localStorage.getItem("loommate.pos");
      if (!v) return null;
      const p = JSON.parse(v) as { x: number; y: number };
      /**
       * 2026-09-20 真机反馈：保存的位置若落在**主视图中央区域**（横向 25%–75%、纵向 25%–80%），
       * 会长期压住经营主页的职场/舞台。这类位置不还原，回落到默认停靠位（右/左下角）；
       * 用户仍可随时拖到任意位置（贴边吸附那套不变）。
       */
      const cx = window.innerWidth * 0.25, cx2 = window.innerWidth * 0.75;
      const cy = window.innerHeight * 0.25, cy2 = window.innerHeight * 0.8;
      if (p.x > cx && p.x < cx2 && p.y > cy && p.y < cy2) return null;
      return p;
    } catch { return null; }
  });
  const [hidden, setHidden] = useState(() => { try { return localStorage.getItem("loommate.hidden") === "1"; } catch { return false; } });
  /**
   * 浮层响应式（真机审计修复）：无本机偏好时，窄屏（≤820px，与 AI 助手同断点）默认收起为小球，
   * 避免大尺寸形象压住页面内容；用户显式展开/收起后按本机偏好持久化。
   */
  const [mini, setMini] = useState(() => {
    try {
      const stored = localStorage.getItem("loommate.mini");
      if (stored === "1") return true;
      if (stored === "0") return false;
    } catch { /* 本机偏好不可写时按视口判断 */ }
    return window.matchMedia("(max-width: 820px)").matches;
  });
  const dragRef = useRef<{ startX: number; startY: number; baseX: number; baseY: number; moved: boolean } | null>(null);
  const persistLocal = (k: string, v: string) => { try { localStorage.setItem(k, v); } catch { /* ignore */ } };
  const availableWidth = Math.max(96, viewport.width - railW - navW - 32);
  const widgetW = size === "large" ? Math.min(480, availableWidth) : Math.min(120, availableWidth);
  const widgetH = size === "large" ? Math.min(560, Math.round(widgetW * 1.17)) : 170;

  /**
   * 大尺寸浮层「吞点击」修复（真机验收实测）：
   * 大形态的容器是 480×560 的矩形，角色本体只占其中一部分，空出来的矩形区域却照样吃指针事件——
   * 真机上关卡三杆（放行/改后放行/退回）滚到右下区域时，点击被小织的空盒子接走，鼠标怎么点都点不动。
   * 两条纪律：① 容器本身 pointer-events:none，只有气泡/面板/角色本体/控制条这几个真实可点区域接收事件；
   * ② 内容区窄（与 Bridge 侧栏降级同一条 880px 口径）时默认收成 64px 小球，别用大形象压住主工作区
   *   （用户显式展开/收起后仍按其本机偏好持久化，不反复弹回）。
   */
  const contentNarrow = viewport.width - railW - navW <= 880;
  useEffect(() => {
    if (!contentNarrow) return;
    try {
      if (localStorage.getItem("loommate.mini") !== null) return; // 用户已表态 → 尊重
    } catch { /* 本机偏好不可读时按窄内容区处理 */ }
    setMini(true);
  }, [contentNarrow]);

  const clampPos = (x: number, y: number) => ({
    x: Math.min(Math.max(navW, x), Math.max(navW, viewport.width - railW - widgetW)),
    y: Math.min(Math.max(0, y), Math.max(0, viewport.height - widgetH)),
  });
  const defaultPos = () => ({
    x: Math.max(navW, viewport.width - railW - widgetW - 16),
    y: Math.max(0, viewport.height - widgetH - 16),
  });
  const docked: "left" | "right" = pos
    ? (pos.x + widgetW / 2 < navW + (viewport.width - railW - navW) / 2 ? "left" : "right")
    : "right";
  const onDragStart = (e: React.PointerEvent) => {
    const base = pos ?? defaultPos();
    dragRef.current = { startX: e.clientX, startY: e.clientY, baseX: base.x, baseY: base.y, moved: false };
    (e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId);
  };
  const onDragMove = (e: React.PointerEvent) => {
    const d = dragRef.current;
    if (!d) return;
    const dx = e.clientX - d.startX, dy = e.clientY - d.startY;
    if (!d.moved && Math.hypot(dx, dy) < 6) return; // 6px 阈值：小于视为点击
    d.moved = true;
    setPos(clampPos(d.baseX + dx, d.baseY + dy));
  };
  const onDragEnd = () => {
    const d = dragRef.current;
    dragRef.current = null;
    if (!d || !d.moved) { openAssistantRail(); return; } // 未拖动=点击唤起右侧「织伴」全局框（我的域）
    setPos((p) => {
      if (!p) return p;
      const snapped = {
        x: p.x + widgetW / 2 < navW + (viewport.width - railW - navW) / 2
          ? navW + 16
          : Math.max(navW, viewport.width - railW - widgetW - 16),
        y: p.y,
      };
      persistLocal("loommate.pos", JSON.stringify(snapped));
      return snapped;
    });
  };
  const webglOk = useMemo(() => {
    try {
      const c = document.createElement("canvas");
      return !!(c.getContext("webgl2") ?? c.getContext("webgl"));
    } catch { return false; }
  }, []);
  const personaName = settings?.persona_key === "custom"
    ? (settings?.persona_custom?.name ?? "小织")
    : (PERSONA_NAME[settings?.persona_key ?? "tianmei"] ?? "小织");

  /* —— 任务完成播报状态机：rise(举棒) → point(挥棒指向右栏) → smile(眯眼笑收尾) —— */
  const [celebrate, setCelebrate] = useState<SettledTaskNotice | null>(null);
  const [wandPhase, setWandPhase] = useState<"rise" | "point" | "smile">("rise");
  const celebrateTimers = useRef<number[]>([]);
  const announceTask = useCallback((task: SettledTaskNotice) => {
    celebrateTimers.current.forEach((t) => window.clearTimeout(t));
    celebrateTimers.current = [];
    setWandPhase("rise");
    setCelebrate(task);
    // 主动出来播报：小球态自动展开成形象（用户显式「隐藏」过则只发声 + 右栏高亮，不强弹）
    setMini(false);
    persistLocal("loommate.mini", "0");
    AudioEngine.play("fanfare");
    VoiceEngine.speak({
      role: "loommate", persona: personaName,
      text: task.status === "completed"
        ? `董事长，${task.title}，任务完成了，请您查看！`
        : `董事长，${task.title}，任务出了点状况，请您查看。`,
      priority: "ceremony",
      voiceOverride: mateVoiceProfileOf(settings?.voice_key),
    });
    celebrateTimers.current.push(
      window.setTimeout(() => setWandPhase("point"), 900),
      window.setTimeout(() => {
        setWandPhase("smile");
        // 指向右栏：让对应的任务完成卡片发光，视线与魔法棒落到同一处
        window.dispatchEvent(new CustomEvent("workloom:notify-highlight", { detail: { threadId: task.threadId } }));
      }, 1500),
      window.setTimeout(() => setCelebrate(null), 9000),
    );
  }, [personaName, settings?.voice_key]);
  useEffect(() => {
    const onSettled = (event: Event) => {
      const detail = (event as CustomEvent<SettledTaskNotice>).detail;
      if (!detail?.threadId) return;
      announceTask(detail);
    };
    window.addEventListener("workloom:task-settled", onSettled);
    return () => {
      window.removeEventListener("workloom:task-settled", onSettled);
      celebrateTimers.current.forEach((t) => window.clearTimeout(t));
    };
  }, [announceTask]);
  const celebrateLine = celebrate
    ? (celebrate.status === "completed"
      ? `董事长，「${celebrate.title}」完成了，请您查看！`
      : `董事长，「${celebrate.title}」出了点状况，请您查看。`)
    : null;

  // 情绪映射（数字人表情）：播报中→excited 睁大眼起手 / happy 眯眼笑收尾；红线→fear；有事项→招呼；常态→甜妹 love
  const topItem = items[0];
  const mood: MateMood = celebrate
    ? (wandPhase === "rise" ? "excited" : "happy")
    : topItem?.level === "red" ? "fear"
      : topItem?.kind === "done" ? "happy"
        : topItem ? "neutral"
          : "love";
  const mateGesture: MateGesture = celebrate
    ? (wandPhase === "rise" ? "handup" : "wandpoint")
    : items.length > 0 ? "handup" : null;

  /**
   * 织球「班组状态眼」（接入面 B）：全局系统状态 → 表情。
   * 三条真实信号：run 注册表活跃数、approvals 待办数、近 15 分钟失败数；
   * 叠加用户自己的勿扰时段（夜班值守）。没有信号就是待机——不装在线、不演忙碌。
   */
  const systemSignal: SystemStatusSignal = {
    activeRuns: studioActive?.activeRuns ?? 0,
    awaitingApprovals: studioActive?.pendingApprovals ?? 0,
    recentFailure: (studioActive?.failedRecent ?? 0) > 0,
    quietHours: inQuietHours(settings?.quiet_start, settings?.quiet_end, new Date()),
  };
  const systemEmotion = useStableEmotion(emotionOfSystem(systemSignal));
  const systemEmotionText = emotionLabelOf(systemEmotion);

  const load = useCallback(async () => {
    await ensureDemoLogin();
    const [s, box] = await Promise.all([
      svc().secretary.settings.query().catch(() => null),
      svc().secretary.inbox.query({ unreadOnly: true }).catch(() => ({ items: [] })),
    ]);
    if (s) setSettings(s.settings);
    const fresh = box.items.filter((it) => !seenIds.current.has(it.id));
    for (const it of box.items) seenIds.current.add(it.id);
    setItems(box.items);
    // 新事件语音播报（红线/高，voice_on 才发声；字幕永远发——VoiceEngine 纪律）
    if (s?.settings.voice_on) {
      for (const it of fresh.filter((x) => x.level === "red" || x.level === "high").slice(0, 2)) {
        VoiceEngine.speak({
          role: "loommate", persona: personaName,
          text: inboxSpeechText(it.title, it.body).slice(0, 120),
          priority: it.level === "red" ? "fuse" : "ambient",
          voiceOverride: mateVoiceProfileOf(s.settings.voice_key),
        });
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [personaName]);

  useEffect(() => { void load(); }, [load]);

  /**
   * 班组活跃度信号（织球「班组状态眼」的另一半输入）：
   * 独立轮询，**不并入上面的 load()**——批量请求里任何一路失败都会让整批 reject，
   * 那样会让状态球永远停在「待机」。失败时保留上一次读数（不猜、不清零成"一切正常"）。
   */
  useEffect(() => {
    let alive = true;
    const pull = async () => {
      try {
        await ensureDemoLogin();
        const active = await trpc.video.studio.active.query() as StudioActive;
        if (alive) setStudioActive(active);
      } catch {
        /* 保留上一次读数：宁可显示旧状态，也不假装一切正常 */
      }
    };
    void pull();
    const timer = window.setInterval(() => void pull(), 20_000);
    return () => {
      alive = false;
      window.clearInterval(timer);
    };
  }, []);

  /**
   * X-08（第五轮实测）：完成/失败播报此前只靠 StarRing 卡片**亲自轮询见证**跃迁，
   * 于是 P8 名册抽屉派的任务、调度器自动跑的任务、以及刷新过页面后完成的任务，小织一律沉默。
   * 现在补一条服务端投影通道：轮询 `threads.settledSince`，对"本机还没播报过"的结算线程补播报；
   * localStorage 记 threadId+closed_at 去重（与 StarRing 的即时播报同事件去重，不重复嚷嚷）。
   */
  useEffect(() => {
    let alive = true;
    const STORAGE_KEY = "workloom:loommate-announced-settled";
    const readSeen = (): Record<string, string> => {
      try { return JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "{}") as Record<string, string>; } catch { return {}; }
    };
    const writeSeen = (seen: Record<string, string>) => {
      try {
        // 只保留最近 200 条，避免长期运行无限膨胀
        const entries = Object.entries(seen).slice(-200);
        localStorage.setItem(STORAGE_KEY, JSON.stringify(Object.fromEntries(entries)));
      } catch { /* 隐私模式/配额异常：仅当次会话去重，功能不降级 */ }
    };
    const pull = async () => {
      try {
        await ensureDemoLogin();
        const rows = await trpc.threads.settledSince.query({ limit: 20 }) as Array<{
          id: string; title: string; status: string; closed_at?: string | null; updated_at?: string;
        }>;
        if (!alive) return;
        const seen = readSeen();
        let changed = false;
        for (const row of rows) {
          const stamp = String(row.closed_at ?? row.updated_at ?? "");
          if (seen[row.id] === stamp) continue;
          seen[row.id] = stamp;
          changed = true;
          if (row.status === "completed" || row.status === "failed") {
            announceTask({ threadId: row.id, title: row.title, status: row.status });
          }
        }
        if (changed) writeSeen(seen);
      } catch {
        /* 拉不到就等下一拍：不猜、不补假播报 */
      }
    };
    void pull();
    const timer = window.setInterval(() => void pull(), 20_000);
    return () => { alive = false; window.clearInterval(timer); };
  }, [announceTask]);

  /** 视口跨入窄屏断点时自动收起为小球（跨出时不自动展开，尊重用户当前选择） */
  useEffect(() => {
    const mq = window.matchMedia("(max-width: 820px)");
    const onChange = (event: MediaQueryListEvent) => { if (event.matches) setMini(true); };
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, []);

  useEffect(() => {
    const keepVisible = () => {
      setViewport({ width: window.innerWidth, height: window.innerHeight });
      setPos((current) => current ? clampPos(current.x, current.y) : current);
    };
    const reset = () => {
      try {
        localStorage.removeItem("loommate.pos");
        localStorage.removeItem("loommate.hidden");
        localStorage.removeItem("loommate.mini");
      } catch { /* 本机偏好不可写时仍恢复当前会话 */ }
      setPos(null);
      setHidden(false);
      setMini(false);
      setOpen("none");
    };
    const setVisibility = (event: Event) => {
      const action = (event as CustomEvent<"show" | "hide" | "toggle">).detail;
      if (action === "show") {
        setHidden(false);
        setMini(false);
        persistLocal("loommate.hidden", "0");
        persistLocal("loommate.mini", "0");
      } else if (action === "hide") {
        setHidden(true);
        setOpen("none");
        persistLocal("loommate.hidden", "1");
      } else {
        setHidden((value) => {
          persistLocal("loommate.hidden", value ? "0" : "1");
          return !value;
        });
      }
    };
    keepVisible();
    window.addEventListener("resize", keepVisible);
    window.addEventListener("workloom:reset-layout", reset);
    window.addEventListener("workloom:loommate-visibility", setVisibility);
    return () => {
      window.removeEventListener("resize", keepVisible);
      window.removeEventListener("workloom:reset-layout", reset);
      window.removeEventListener("workloom:loommate-visibility", setVisibility);
    };
  // clampPos 按当前左右栏/尺寸计算；这些值变化时重新校正一次即可。
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [navW, railW, viewport.width, viewport.height, widgetW, widgetH]);
  // 20s 心跳：先扫描事件源再拉收件箱
  useEffect(() => {
    const h = setInterval(async () => {
      await ensureDemoLogin();
      await svc().secretary.scan.mutate().catch(() => ({ added: 0 }));
      await load();
    }, 20_000);
    return () => clearInterval(h);
  }, [load]);

  const act = async (it: InboxItem) => {
    await svc().secretary.markInbox.mutate({ ids: [it.id], status: "acted" }).catch(() => undefined);
    setItems((prev) => prev.filter((x) => x.id !== it.id));
    if (it.link) navigate(canonicalNavigationPath(it.link));
  };
  const later = async (it: InboxItem) => {
    await svc().secretary.markInbox.mutate({ ids: [it.id], status: "read" }).catch(() => undefined);
    setItems((prev) => prev.filter((x) => x.id !== it.id));
  };

  const MODE_NEXT: Record<string, "small" | "large" | "fullscreen"> = { small: "large", large: "fullscreen", fullscreen: "small" };
  const MODE_LABEL: Record<string, string> = { small: "变大", large: "全屏", fullscreen: "变小" };
  const toggleSize = async () => {
    const next = MODE_NEXT[size] ?? "large";
    setSettings((s) => s ? { ...s, widget_size: next } : s);
    await svc().secretary.saveSettings.mutate({ widget_size: next }).catch(() => undefined);
  };
  const mateSurface = useManagedSurface<HTMLDivElement>({
    open: size === "fullscreen" || (!hidden && open !== "none"),
    kind: "assistant-companion",
    onDismiss: () => {
      if (size === "fullscreen") void toggleSize();
      else setOpen("none");
    },
    modal: size === "fullscreen",
    focusOnOpen: size === "fullscreen",
    restoreFocusOnClose: size === "fullscreen",
    returnFocusRef: sizeToggleRef,
  });

  const moveByKeyboard = (event: React.KeyboardEvent<HTMLElement>) => {
    const movement: Partial<Record<"ArrowUp" | "ArrowDown" | "ArrowLeft" | "ArrowRight", [number, number]>> = {
      ArrowUp: [0, -1],
      ArrowDown: [0, 1],
      ArrowLeft: [-1, 0],
      ArrowRight: [1, 0],
    };
    const direction = movement[event.key as keyof typeof movement];
    if (!direction) return false;
    event.preventDefault();
    const distance = event.shiftKey ? 48 : 16;
    const base = pos ?? defaultPos();
    const next = clampPos(base.x + direction[0] * distance, base.y + direction[1] * distance);
    setPos(next);
    persistLocal("loommate.pos", JSON.stringify(next));
    return true;
  };

  /**
   * 三合一合并（2026-09-20）：小织不再自带第二个对话框——「聊聊」面板下线，
   * 对话统一走右侧全局框的「我的」域（记事/提醒/查任务/找人）。
   * 这里保留：设置、记忆、未读气泡、形象与语音（人格外壳）。
   */
  const openAssistantRail = useCallback(() => {
    window.dispatchEvent(new CustomEvent("workloom:assistant-visibility", { detail: "show" }));
    window.dispatchEvent(new CustomEvent("workloom:assistant-intent", { detail: { intent: "personal", domain: "mine" } }));
  }, []);

  const openPanel = async (p: "settings" | "memory") => {
    setOpen(open === p ? "none" : p);
    if (p === "memory") {
      const m = await svc().secretary.memoryPanel.query().catch(() => null);
      if (m) setMemory(m.memory);
    }
  };

  const dim = size === "large" ? widgetW : Math.min(96, widgetW);
  const unread = items.length;

  // —— 全屏屏保模式：她守着整个场，有事直接喊你 ——
  if (size === "fullscreen") {
    return (
      <div {...mateSurface} className="fixed inset-0 flex flex-col items-center justify-center bg-bg950/98"
        style={{ zIndex: "var(--wl-z-assistant)" }}
        role="dialog" aria-modal="true" aria-label="小织屏保">
        {/* 环境微光背景 */}
        <div className="pointer-events-none absolute inset-0 opacity-30"
          style={{ background: "radial-gradient(ellipse at 50% 62%, rgba(232,160,191,.25), transparent 60%)" }} />
        <button ref={sizeToggleRef} onClick={() => void toggleSize()}
          className="absolute right-5 top-5 rounded-full border border-line bg-bg900/80 px-3 py-1.5 text-body text-ink2 hover:text-ink">
          退出屏保（Esc）
        </button>
        <button onClick={openAssistantRail} className="relative cursor-pointer transition-transform hover:scale-[1.02]" title="打开右侧「织伴」全局框（我的域）">
          {webglOk
            ? <MateLive2D size={Math.min(520, Math.round((typeof window !== "undefined" ? window.innerHeight : 900) * 0.55))} mood={mood} gesture={mateGesture} />
            : <MateAvatar size={Math.min(520, Math.round((typeof window !== "undefined" ? window.innerHeight : 900) * 0.55))} excited={unread > 0} />}
          {unread > 0 && (
            <span className="absolute right-4 top-4 flex h-10 min-w-10 items-center justify-center rounded-full bg-alert px-2 text-[16px] font-bold text-white shadow-xl">
              {unread}
            </span>
          )}
        </button>
        <div className="mt-3 text-[18px] font-semibold text-ink">{personaName} · 正在照看团队</div>
        <div className="mt-1 text-body text-ink3">点她聊聊 · 有事她会直接喊你</div>
        {/* 红色/高级别事件：屏保中央强提醒 */}
        {items.filter((it) => it.level === "red" || it.level === "high").slice(0, 1).map((it) => (
          <div key={it.id} className={`mt-5 w-[min(28rem,calc(100vw-2rem))] max-w-full rounded-2xl border p-4 shadow-2xl ${LEVEL_STYLE[it.level]}`}>
            <div className="flex items-center gap-1.5 text-[14px] font-semibold text-ink"><Icon name={it.level === "red" ? "warning" : "notice"} label={it.level === "red" ? "紧急提醒" : "重要提醒"} size={15} />{clientValueText(it.title)}</div>
            <div className="mt-1 text-body leading-relaxed text-ink2">{clientValueText(it.body)}</div>
            <div className="wl-action-row mt-2.5 flex flex-wrap gap-2">
              <button onClick={() => void act(it)}
                className="rounded-lg bg-gradient-to-br from-gold to-gold2 px-4 py-1.5 text-body font-semibold text-ongold">
                {clientValueText(it.actions[0]?.label ?? "看看")}
              </button>
              <button onClick={() => void later(it)} className="rounded-lg border border-line px-3 py-1.5 text-body text-ink2">稍后</button>
            </div>
          </div>
        ))}
        {/* 底部团队运行串话条 */}
        <div className="absolute bottom-0 left-0 right-0 border-t border-line bg-bg900/80 px-6 py-2.5 backdrop-blur">
          <div className="flex min-w-0 flex-wrap items-center gap-x-6 gap-y-1 overflow-hidden text-body text-ink2">
            <span className="shrink-0 text-gold">● 团队实况</span>
            {items.length === 0 && <span className="animate-pulse">各部门运行正常，一切井然有序……（有事我喊你）</span>}
            {items.slice(0, 6).map((it) => (
              <span key={it.id} className="min-w-0 break-words">{clientValueText(it.title)} · {clientValueText(it.body.slice(0, 30))}</span>
            ))}
          </div>
        </div>
        {/* 面板（聊/设置/记忆）在全屏态同样可用 */}
        {open !== "none" && (
          <div className="absolute bottom-16 right-5 top-16 w-[var(--wl-assistant-expanded)]">
            <MatePanel
              open={open} setOpen={setOpen} openPanel={openPanel}
              personaName={personaName}
              settings={settings} setSettings={setSettings}
              memory={memory} setMemory={setMemory}
            />
          </div>
        )}
      </div>
    );
  }

  // 隐藏态：只留屏幕边缘「小织」把手，点一下唤回（不挡任何功能模块）
  if (hidden) {
    return (
      <button
        onClick={() => { setHidden(false); persistLocal("loommate.hidden", "0"); }}
        title="唤回小织"
        className="fixed flex h-20 w-7 flex-col items-center justify-center gap-1 rounded-l-xl border border-gline bg-bg900/95 text-body font-semibold text-gold shadow-xl hover:bg-bg850"
        style={{ zIndex: "var(--wl-z-assistant)", ...(docked === "left"
          ? { left: navW, top: pos?.y ?? "45%", borderRadius: "0 12px 12px 0" }
          : { right: railW, top: pos?.y ?? "45%" }) }}
      >
        <span style={{ writingMode: "vertical-rl" }}>小织</span>
        <span>{docked === "left" ? "▸" : "◂"}</span>
      </button>
    );
  }

  const rootStyle: React.CSSProperties = pos
    ? { position: "fixed", left: pos.x, top: pos.y, zIndex: "var(--wl-z-assistant)" }
    : { position: "fixed", right: railW + 16, bottom: 16, zIndex: "var(--wl-z-assistant)" };

  return (
    <div
      {...mateSurface}
      className={`pointer-events-none flex flex-col gap-2 ${docked === "left" ? "items-start" : "items-end"}`}
      style={{ fontFamily: "inherit", ...rootStyle }}
    >
      {/* 气泡提醒（最多叠 3 条） */}
      {open === "none" && items.slice(0, 3).map((it) => (
        <div key={it.id} className={`pointer-events-auto w-[min(19rem,calc(100vw-2rem))] max-w-full rounded-2xl border p-3 shadow-xl backdrop-blur ${LEVEL_STYLE[it.level]}`}>
          <div className="flex items-start justify-between gap-2">
            <div className="flex items-center gap-1.5 text-body font-semibold text-ink">{it.level === "red" && <Icon name="warning" size={14} />}{clientValueText(it.title)}</div>
            <button onClick={() => void later(it)} className="shrink-0 text-body text-ink3 hover:text-ink">稍后</button>
          </div>
          <div className="mt-1 text-body leading-relaxed text-ink2">{clientValueText(it.body)}</div>
          <div className="wl-action-row mt-2 flex flex-wrap gap-1.5">
            <button onClick={() => void act(it)}
              className="rounded-lg bg-gradient-to-br from-gold to-gold2 px-3 py-1 text-body font-semibold text-ongold">
              {clientValueText(it.actions[0]?.label ?? "看看")}
            </button>
          </div>
        </div>
      ))}

      {open !== "none" && (
        <div className="pointer-events-auto">
          <MatePanel
            open={open} setOpen={setOpen} openPanel={openPanel}
            personaName={personaName}
            settings={settings} setSettings={setSettings}
            memory={memory} setMemory={setMemory}
          />
        </div>
      )}

      {/* 本体：形象（可拖拽·松手边缘吸附）+ 名字 + 控制条 */}
      {mini && open === "none" ? (
        /* 迷你球：64px 圆球贴在原位置，点击展开 */
        <div className="relative">
          <button
            onClick={() => { setMini(false); persistLocal("loommate.mini", "0"); }}
            title={loomBallEnabled ? `展开${personaName}（班组${systemEmotionText}）` : `展开${personaName}`}
            data-loommate-emotion={loomBallEnabled ? String(systemEmotion) : undefined}
            data-loommate-signal={loomBallEnabled ? JSON.stringify(systemSignal) : undefined}
            className="pointer-events-auto relative block h-16 w-16 overflow-hidden rounded-full border-2 border-gold/60 bg-bg900 shadow-xl transition-transform hover:scale-110"
          >
            {loomBallEnabled ? (
              /* 小角落态：静态小头像 → 织球（班组此刻在干什么，一眼看得见；
                 形象本体与人格不进这颗球——那是大形象的职责） */
              <span className="flex h-full w-full items-center justify-center bg-bg900">
                <LoomBall emotion={systemEmotion} size={56} live followGaze={false} title={`班组${systemEmotionText}`} />
              </span>
            ) : (
              <img src="/live2d/mao/poster.png" alt={personaName} draggable={false} className="h-full w-full object-cover" />
            )}
            {unread > 0 && (
              <span className="absolute -right-0.5 -top-0.5 flex h-5 min-w-5 items-center justify-center rounded-full bg-alert px-1 text-body font-bold text-white shadow-lg">
                {unread}
              </span>
            )}
          </button>
          {/* 迷你球态也要有退出出口（2026-09-20 真机验收整改）：小织收起成球时，
              底栏控制条不渲染，之前只能先展开再隐藏——这里在球体左侧常驻一个 × 直接收起浮层。 */}
          <button
            type="button"
            onClick={() => { setHidden(true); persistLocal("loommate.hidden", "1"); setPos((p) => p ?? defaultPos()); }}
            title="隐藏织伴（屏幕边缘留「小织」把手，点一下唤回）"
            aria-label="隐藏织伴"
            className="pointer-events-auto absolute -left-2 top-1/2 -mt-3.5 inline-flex h-7 w-7 items-center justify-center rounded-full border border-line bg-bg900/95 text-body text-ink2 shadow-lg hover:border-gline hover:text-gold"
          >
            <span aria-hidden="true" className="leading-none">✕</span>
          </button>
        </div>
      ) : (
      <div className="pointer-events-none flex flex-col items-center">
        {/* 任务完成播报的舞台样式（挥棒 / 星尘 / 指向右栏的光轨） */}
        <style>{`
          @keyframes wl-wand-swing { 0%{transform:rotate(0) translateY(0)} 16%{transform:rotate(-7deg) translateY(-4px)} 34%{transform:rotate(6deg) translateY(-7px)} 52%{transform:rotate(-5deg) translateY(-2px)} 70%{transform:rotate(3deg)} 100%{transform:rotate(0) translateY(0)} }
          @keyframes wl-wand-point { 0%{transform:rotate(0)} 38%{transform:rotate(6deg) translateX(3px)} 66%{transform:rotate(4deg) translateX(2px)} 100%{transform:rotate(0) translateX(0)} }
          @keyframes wl-spark-fly { 0%{opacity:0;transform:translate(0,0) scale(.5)} 12%{opacity:1} 60%{opacity:.95} 100%{opacity:0;transform:translate(var(--dx,220px),var(--dy,-40px)) scale(1.25)} }
          @keyframes wl-beam-pulse { 0%{opacity:0;transform:scaleX(.35)} 25%{opacity:.95} 65%{opacity:.8;transform:scaleX(1)} 100%{opacity:0;transform:scaleX(1)} }
          @keyframes wl-say-pop { from{opacity:0;transform:translateY(6px) scale(.95)} to{opacity:1;transform:none} }
          .wl-mate-stage{position:relative;transform-origin:50% 82%}
          .wl-mate-stage[data-wand-phase="rise"]{animation:wl-wand-swing .9s ease-in-out 1}
          .wl-mate-stage[data-wand-phase="point"]{animation:wl-wand-point 1.1s ease-in-out 1}
          .wl-wand-cast{position:absolute;inset:0;pointer-events:none;overflow:visible}
          .wl-wand-spark{position:absolute;font-size:15px;line-height:1;color:#ffe6ad;text-shadow:0 0 10px rgba(255,214,138,.95),0 0 22px rgba(255,186,106,.6);opacity:0;animation:wl-spark-fly 1.5s cubic-bezier(.2,.8,.3,1) forwards}
          .wl-wand-beam{position:absolute;left:62%;top:38%;width:min(46vw,560px);height:3px;border-radius:999px;transform-origin:left center;
            background:linear-gradient(90deg,rgba(255,230,173,0),rgba(255,230,173,.95),rgba(255,214,138,.35) 70%,rgba(255,214,138,0));
            box-shadow:0 0 14px rgba(255,214,138,.8);animation:wl-beam-pulse 1.6s ease-out .95s forwards;opacity:0}
          .wl-wand-beam::after{content:"➤";position:absolute;right:-6px;top:-9px;font-size:13px;color:#ffe6ad;text-shadow:0 0 12px rgba(255,214,138,.9)}
          .wl-mate-say{margin-top:6px;max-width:min(26rem,calc(100vw - 2rem));border-radius:14px;border:1px solid rgba(255,214,138,.55);
            background:linear-gradient(160deg,rgba(46,36,20,.96),rgba(28,24,18,.94));padding:7px 11px;text-align:center;color:#ffe9c2;
            font-size:13px;line-height:1.6;box-shadow:0 12px 30px rgba(0,0,0,.45),0 0 22px rgba(255,214,138,.22);animation:wl-say-pop .35s ease-out}
        `}</style>
        <div
          role="button" tabIndex={0}
          aria-label={`${personaName}助手；回车打开对话，方向键移动，按住 Shift 可加速移动`}
          aria-keyshortcuts="Enter Space ArrowUp ArrowDown ArrowLeft ArrowRight"
          onPointerDown={onDragStart} onPointerMove={onDragMove} onPointerUp={onDragEnd}
          onKeyDown={(e) => {
            if (moveByKeyboard(e)) return;
            if (e.key === "Enter" || e.key === " ") {
              e.preventDefault();
              openAssistantRail();
            }
          }}
          className="pointer-events-auto relative block cursor-grab touch-none select-none transition-transform hover:scale-105 active:cursor-grabbing"
          title={`${personaName}（拖拽挪位置 · 点击打开全局框）`}
        >
          <div className="wl-mate-stage" data-wand-phase={celebrate ? wandPhase : "idle"}>
            {webglOk
              ? <MateLive2D size={dim} mood={mood} gesture={mateGesture} />
              : <MateAvatar size={dim} excited={unread > 0 || Boolean(celebrate)} />}
            {/* 紧凑态（widget_size='small'）：形象保留，右上角挂一枚班组状态眼；
                大形象与全屏屏保不加球（人格外壳零改动） */}
            {loomBallEnabled && size === "small" && (
              <span className="absolute -left-3 -top-1" title={`班组${systemEmotionText}`}>
                <LoomBall emotion={systemEmotion} size={40} live followGaze={false} />
              </span>
            )}
            {/* 任务完成：星尘沿魔法棒洒出并飞向右栏，配一条指向对话框的光轨 */}
            {celebrate && (
              <div className="wl-wand-cast" aria-hidden="true">
                <span className="wl-wand-beam" />
                {WAND_SPARKS.map((s, i) => (
                  <span
                    key={i}
                    className="wl-wand-spark"
                    style={{
                      left: `${s.left}%`,
                      top: `${s.top}%`,
                      animationDelay: `${s.delay}s`,
                      "--dx": `${s.dx}px`,
                      "--dy": `${s.dy}px`,
                    } as React.CSSProperties}
                  >
                    {i % 2 === 0 ? "✦" : "✧"}
                  </span>
                ))}
              </div>
            )}
          </div>
          {/* 2026-09-20（真机验收整改）：大形象在窄屏/舞台低位时控制条会被视口裁掉，
              用户找不到「隐藏」出口。这里在形象本体右上角常驻一个 × 隐藏按钮：
              点击后与底部控制条「隐藏」同一条链路（边缘留小织把手，一点唤回）。 */}
          <button
            type="button"
            onPointerDown={(e) => e.stopPropagation()}
            onClick={(e) => {
              e.stopPropagation();
              setHidden(true);
              persistLocal("loommate.hidden", "1");
              setPos((p) => p ?? defaultPos());
            }}
            title="隐藏织伴（屏幕边缘留「小织」把手，点一下唤回）"
            aria-label="隐藏织伴"
            className={`absolute -top-2 z-10 inline-flex h-7 w-7 items-center justify-center rounded-full border border-line bg-bg900/95 text-body text-ink2 shadow-lg hover:border-gline hover:text-gold ${unread > 0 ? "-left-2" : "-right-2"}`}
          >
            <span aria-hidden="true" className="leading-none">✕</span>
          </button>
          {unread > 0 && (
            <span className="absolute -right-1 -top-1 flex h-6 min-w-6 items-center justify-center rounded-full bg-alert px-1 text-body font-bold text-white shadow-lg">
              {unread}
            </span>
          )}
        </div>
        {/* 播报字幕：她说的话必须看得见（VoiceEngine 纪律：发声的都要有字幕） */}
        {celebrateLine && <div className="wl-mate-say" role="status">{celebrateLine}</div>}
        <div className="pointer-events-auto mt-0.5 flex items-center gap-1.5">
            <span className="rounded-full bg-bg900/90 px-2.5 py-0.5 text-body text-ink shadow">
            {personaName}
          </span>
          <button ref={sizeToggleRef} onClick={() => void toggleSize()} title="切换大小"
            className="rounded-full border border-line bg-bg900/90 px-1.5 py-0.5 text-body text-ink2 opacity-70 shadow hover:text-ink hover:opacity-100">
            {MODE_LABEL[size] ?? "变大"}
          </button>
          <button onClick={() => { setMini(true); persistLocal("loommate.mini", "1"); }} title="收起为小球（不挡界面）"
            className="rounded-full border border-line bg-bg900/90 px-1.5 py-0.5 text-body text-ink2 opacity-70 shadow hover:text-ink hover:opacity-100">
            收起
          </button>
          <button onClick={() => { setHidden(true); persistLocal("loommate.hidden", "1"); setPos((p) => p ?? defaultPos()); }} title="隐藏（屏幕边缘留「小织」把手，点一下唤回）"
            className="rounded-full border border-line bg-bg900/90 px-1.5 py-0.5 text-body text-ink2 opacity-70 shadow hover:text-ink hover:opacity-100">
            隐藏
          </button>
        </div>
      </div>
      )}
    </div>
  );
}

/* ---------------- 展开面板（聊/设置/记忆——角落态与全屏态复用） ---------------- */
function MatePanel({ open, setOpen, openPanel, personaName, settings, setSettings, memory, setMemory }: {
  open: "settings" | "memory";
  setOpen: (v: "none" | "settings" | "memory") => void;
  openPanel: (p: "settings" | "memory") => Promise<void>;
  personaName: string; settings: Settings | null;
  setSettings: React.Dispatch<React.SetStateAction<Settings | null>>;
  memory: Record<string, MemRow[]> | null;
  setMemory: React.Dispatch<React.SetStateAction<Record<string, MemRow[]> | null>>;
}) {
  return (
<div className="flex h-[min(26rem,calc(100vh-2rem))] w-[var(--wl-assistant-expanded)] max-w-full flex-col rounded-2xl border border-gline bg-bg900/95 shadow-2xl backdrop-blur" role="region" aria-label="小织助手面板">
          <div className="flex items-center justify-between border-b border-line px-3 py-2">
            <div className="flex gap-1">
              {/* 三合一：闲聊入口已并入右侧全局框「我的」域，这里只保留设置与记忆 */}
              {([["settings", "设置"], ["memory", "记忆"]] as const).map(([k, label]) => (
                <button key={k} onClick={() => void openPanel(k)}
                  className={`rounded-full px-3 py-1 text-body ${open === k ? "bg-gold/15 text-gold" : "text-ink2 hover:text-ink"}`}>
                  {label}
                </button>
              ))}
            </div>
            <button onClick={() => setOpen("none")} className="text-ink3 hover:text-ink" aria-label="关闭小织助手面板" title="关闭小织助手面板"><Icon name="close" size={16} /></button>
          </div>
          {open === "settings" && settings && (
            <SettingsPanel settings={settings} personaName={personaName}
              onSave={async (patch) => {
                const r = await svc().secretary.saveSettings.mutate(patch);
                setSettings(r.settings);
              }} />
          )}
          {open === "memory" && (
            <div className="flex-1 overflow-y-auto p-3">
              <div className="mb-2 text-body text-ink2">它记住了您什么，全在这里——逐条可删，绝不偷记。</div>
              {memory && Object.entries(memory).map(([layer, rows]) => rows.length > 0 && (
                <div key={layer} className="mb-3">
                  <div className="mb-1 text-body font-semibold text-gold">{LAYER_TEXT[layer] ?? "其他记忆"}（{rows.length}）</div>
                  {rows.map((r) => (
                    <div key={r.id} className="mb-1 flex items-start justify-between gap-2 rounded-lg bg-bg850 px-2.5 py-1.5">
                      <div>
                        <div className="text-body text-ink">{clientValueText(r.content)}</div>
                        <div className="text-body text-ink3">{SOURCE_TEXT[r.source] ?? "来源已记录"}</div>
                      </div>
                      <button onClick={() => {
                        void svc().secretary.forget.mutate({ memoryId: r.id });
                        setMemory((m) => m ? { ...m, [layer]: m[layer]!.filter((x) => x.id !== r.id) } : m);
                      }} className="shrink-0 text-body text-ink3 hover:text-alert" aria-label="删除这条记忆">删除</button>
                    </div>
                  ))}
                </div>
              ))}
              {memory && Object.values(memory).every((r) => r.length === 0) && (
                <div className="py-8 text-center text-body text-ink3">还是空的呢。对它说「记住：……」就会记在这里。</div>
              )}
            </div>
          )}
        </div>
  );
}

/* ---------------- 设置面板 ---------------- */
function SettingsPanel({ settings, personaName, onSave }: {
  settings: Settings; personaName: string; onSave: (patch: Partial<Settings>) => Promise<void>;
}) {
  const [s, setS] = useState(settings);
  const set = <K extends keyof Settings>(k: K, v: Settings[K]) => setS((x) => ({ ...x, [k]: v }));
  return (
    <div className="flex-1 space-y-2.5 overflow-y-auto p-3 text-body">
      <label className="block">
        <span className="text-ink2">它怎么称呼您</span>
        <input value={s.display_name} onChange={(e) => set("display_name", e.target.value)}
          className="mt-0.5 w-full rounded-lg border border-line bg-bg950 px-2.5 py-1.5 outline-none focus:border-gline" />
      </label>
      <div>
        <span className="text-ink2">人设</span>
        <div className="mt-1 grid grid-cols-2 gap-1.5">
          {([["tianmei", "小织 · 甜妹撒娇"], ["yuanqi", "小元气 · 活力满满"], ["chenwen", "织稳 · 沉稳专业"], ["custom", "自定义"]] as const).map(([k, label]) => (
            <button key={k} onClick={() => set("persona_key", k)}
              className={`rounded-lg border px-2 py-1.5 text-body ${s.persona_key === k ? "border-gold text-gold" : "border-line text-ink2"}`}>
              {label}
            </button>
          ))}
        </div>
        {s.persona_key === "custom" && (
          <div className="mt-1.5 space-y-1.5">
            <input value={s.persona_custom?.name ?? ""} placeholder="她的名字"
              onChange={(e) => set("persona_custom", { ...s.persona_custom, name: e.target.value })}
              className="w-full rounded-lg border border-line bg-bg950 px-2.5 py-1.5 outline-none focus:border-gline" />
            <input value={s.persona_custom?.tone ?? ""} placeholder="性格语气（如：毒舌但靠谱）"
              onChange={(e) => set("persona_custom", { ...s.persona_custom, tone: e.target.value })}
              className="w-full rounded-lg border border-line bg-bg950 px-2.5 py-1.5 outline-none focus:border-gline" />
          </div>
        )}
      </div>
      <div>
        <span className="text-ink2">音色</span>
        <div className="mt-1 grid grid-cols-4 gap-1">
          {([["sweet", "甜"], ["bright", "亮"], ["soft", "柔"], ["calm", "稳"]] as const).map(([k, label]) => (
            <button key={k} onClick={() => set("voice_key", k)}
              className={`rounded-lg border px-2 py-1 text-body ${s.voice_key === k ? "border-gold text-gold" : "border-line text-ink2"}`}>
              {label}
            </button>
          ))}
        </div>
      </div>
      <div>
        <span className="text-ink2">形态</span>
        <div className="mt-1 grid grid-cols-3 gap-1">
          {([["small", "小角落"], ["large", "大形象"], ["fullscreen", "屏保"]] as const).map(([k, label]) => (
            <button key={k} onClick={() => set("widget_size", k)}
              className={`rounded-lg border px-2 py-1 text-body ${s.widget_size === k ? "border-gold text-gold" : "border-line text-ink2"}`}>
              {label}
            </button>
          ))}
        </div>
      </div>
      <div className="flex items-center justify-between">
        <span className="text-ink2">语音播报</span>
        <button onClick={() => set("voice_on", !s.voice_on)}
          className={`rounded-full px-3 py-1 text-body ${s.voice_on ? "bg-gold/15 text-gold" : "border border-line text-ink3"}`}>
          {s.voice_on ? "开" : "关"}
        </button>
      </div>
      <div className="flex items-center justify-between gap-2">
        <span className="text-ink2">勿扰时段</span>
        <div className="flex items-center gap-1">
          <input value={s.quiet_start} onChange={(e) => set("quiet_start", e.target.value)} className="w-14 rounded border border-line bg-bg950 px-1.5 py-1 text-center outline-none" />
          <span className="text-ink3">–</span>
          <input value={s.quiet_end} onChange={(e) => set("quiet_end", e.target.value)} className="w-14 rounded border border-line bg-bg950 px-1.5 py-1 text-center outline-none" />
        </div>
      </div>
      <label className="block">
        <span className="text-ink2">外部通知回调地址（最多 3 个，用逗号分隔）</span>
        <input defaultValue={(s.channels?.outbox_urls ?? []).join(",")}
          onBlur={(e) => set("channels", { ...s.channels, outbox_urls: e.target.value.split(",").map((x) => x.trim()).filter(Boolean).slice(0, 3) })}
          placeholder="https://…（红线与高级别实时推送）"
          className="mt-0.5 w-full rounded-lg border border-line bg-bg950 px-2.5 py-1.5 text-body outline-none focus:border-gline" />
      </label>
      <button onClick={() => void onSave(s)}
        className="w-full rounded-lg bg-gradient-to-br from-gold to-gold2 py-2 text-body font-semibold text-ongold">
        保存（{personaName}立即生效）
      </button>
    </div>
  );
}
