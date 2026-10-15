/**
 * WelcomeCeremony · 首次启动欢迎仪式（方案 V4 §0 + 织伴开场 v1.2）
 * 全屏覆盖层：织伴开场序列（MateWelcome：全身像自我介绍/行业化系统介绍/官方详细介绍/过渡）
 *   → 3D 团队仪式（CeremonyStage）+ 金色横幅 + 彩带 + 剪彩 → 直接进入系统。
 * 2026-09-20 产品所有者决定：删除仪式末尾的 V4 主弹窗（「您的 AI 公司，已在运转」+ 三张说明卡 +
 * 「进入系统，先逛逛」/「定制我的行业版」按钮行）——仪式演完即进系统，不再有中间落地页。
 * 触发与续播由服务端 onboarding_progress 决定，按账号/角色/工作区/旅程版本隔离。
 * 用户可稍后继续。
 * 文案变体：行业版按 bundle 显示名与团队人数替换（八仓通用）；织伴 S2 话术按 bundle id 切换（缺省回落通用版）。
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { CeremonyStage, type CeremonyActor } from "../extensions/workplace/CeremonyStage";
import { MateWelcome } from "./MateWelcome";
import type { BundleWelcomeProjection } from "./welcomeScripts";
import { Icon, useManagedSurface } from "@workloom/ui";

const CONFETTI_COLORS = ["#d6dce4", "#f0f4f9", "#ffd98a", "#8fa9c9", "#a8b2be"];

function Confetti({ count, seed }: { count: number; seed: number }) {
  const pieces = useMemo(() => Array.from({ length: count }, (_, i) => ({
    left: (seed * 37 + i * 61) % 100,
    delay: ((seed + i * 13) % 40) / 100,
    dur: 1.6 + ((seed + i * 29) % 160) / 100,
    color: CONFETTI_COLORS[i % CONFETTI_COLORS.length]!,
    round: i % 3 === 0,
  })), [count, seed]);
  return (
    <>
      {pieces.map((p, i) => (
        <div key={i} style={{
          position: "absolute", top: -20, left: `${p.left}%`, width: 10, height: 16, zIndex: 8,
          background: p.color, borderRadius: p.round ? "50%" : 0,
          animation: `wl-confetti-fall ${p.dur}s linear ${p.delay}s forwards`,
        }} />
      ))}
      <style>{`@keyframes wl-confetti-fall { to { transform: translateY(1100px) rotate(720deg); opacity: .9; } }`}</style>
    </>
  );
}

type WelcomeStep = "start" | "mate" | "team" | "summary" | "done";

export function WelcomeCeremony({
  actors,
  bundleName,
  welcome = null,
  initialStep = "start",
  role = "staff",
  onProgress,
  onPause,
  onDone,
}: {
  actors: CeremonyActor[];
  bundleName: string;
  /** 已验证的 Bundle 行业介绍投影；缺省回落基座通用版。 */
  welcome?: BundleWelcomeProjection | null;
  initialStep?: WelcomeStep;
  role?: string;
  onProgress?: (step: WelcomeStep) => void;
  onPause: (step: WelcomeStep) => void;
  onDone: () => void;
}) {
  // 阶段：mate(织伴开场 S0-S4) → entrance(0-1.6s) → dance(1.6-7s) → ribbon(7-8.2s) → 收尾（onDone，进系统）
  const [phase, setPhase] = useState<"mate" | "entrance" | "dance" | "ribbon">(() => {
    if (initialStep === "team") return "entrance";
    // 团队仪式已看过（summary/done）：只做一次快速收尾，不再回放整个开场
    if (initialStep === "summary" || initialStep === "done") return "ribbon";
    return "mate";
  });
  const lastReported = useRef<WelcomeStep | null>(null);
  const currentStep: WelcomeStep = phase === "mate" ? "mate" : phase === "ribbon" ? "summary" : "team";
  const roleLabel = role === "owner" ? "董事长" : role === "manager" ? "管理员" : role === "readonly" ? "观察成员" : "团队成员";
  const welcomeSurface = useManagedSurface<HTMLDivElement>({
    open: true,
    kind: "welcome",
    onDismiss: () => onPause(currentStep),
    modal: true,
  });

  useEffect(() => {
    if (lastReported.current === currentStep) return;
    lastReported.current = currentStep;
    onProgress?.(currentStep);
  }, [currentStep, onProgress]);

  useEffect(() => {
    queueMicrotask(() => {
      const surface = welcomeSurface.ref.current;
      const target = surface?.querySelector<HTMLElement>("button:not([disabled]), a[href], input:not([disabled])");
      (target ?? surface)?.focus();
    });
  }, [phase, welcomeSurface.ref]);

  // 团队仪式计时：织伴开场演完（team-bridge）进入 entrance 后才启动
  useEffect(() => {
    // 每段只挂"下一跳"：总节奏与原来一致（1.6s → dance / 7.0s → ribbon / 8.4s → modal）。
    // 原实现把三个定时器一次性挂在 entrance 上，phase 一变 dance 就触发 cleanup，
    // 把还没到点的 ribbon/modal 一起清掉 → 仪式永久停在 dance（审计 B1）。
    // 用函数式 setPhase 并校验当前阶段，避免用户点"跳到介绍"后旧定时器把阶段拉回去。
    const advanceTo = (ms: number, next: "dance" | "ribbon") =>
      window.setTimeout(() => {
        setPhase((current) => (current === phase ? next : current));
      }, ms);
    const timers =
      phase === "entrance" ? [advanceTo(1600, "dance")]
        : phase === "dance" ? [advanceTo(5400, "ribbon")]
          // 剪彩收尾后直接进系统（原实现是弹 V4 主弹窗，2026-09-20 产品决定删除）
          : phase === "ribbon" ? [window.setTimeout(() => onDone(), 1400)]
            : [];
    return () => timers.forEach(clearTimeout);
  }, [phase, onDone]);

  /** 团队仪式期「直接进入」：跳过舞蹈与剪彩，立刻完成欢迎流程 */
  const skip = () => { onDone(); };

  return (
    <div
      {...welcomeSurface}
      data-welcome-phase={phase}
      role="dialog"
      aria-modal="true"
      aria-label="首次运行介绍"
      style={{
        position: "fixed", inset: 0, zIndex: "var(--wl-z-fullscreen)", background: "#0b0d10",
        fontFamily: "inherit", overflow: "auto",
      }}
    >
      {/* 织伴开场序列（S0-S4：全身像独占舞台；右下角跳过直达首页） */}
      {phase === "mate" && (
        <MateWelcome
          welcome={welcome}
          onBridge={() => setPhase("entrance")}
          onSkipAll={() => onPause("mate")}
        />
      )}

      {/* 3D 仪式舞台（织伴开场谢幕后登场） */}
      {phase !== "mate" && (
        <div style={{ position: "absolute", inset: 0, display: "flex", alignItems: "flex-end" }}>
          <div style={{ width: "100%", height: "100%" }}>
            <CeremonyStage actors={actors} occasion="first-install" dancing={phase === "dance"} height="100%" />
          </div>
        </div>
      )}

      {/* 金色横幅 */}
      {phase !== "entrance" && (
        <div style={{
          position: "absolute", top: 90, left: "50%", transform: "translateX(-50%)",
          width: "min(760px, calc(100vw - 32px))", padding: "22px clamp(20px, 6vw, 64px)", borderRadius: 18, zIndex: 10, textAlign: "center",
          background: "linear-gradient(135deg, rgba(28,32,37,.92), rgba(21,24,28,.88))",
          border: "1px solid rgba(255,217,138,.45)",
          boxShadow: "0 0 60px rgba(255,217,138,.18), inset 0 1px 0 rgba(240,244,249,.1)",
          animation: "wl-banner-unfurl .7s cubic-bezier(.2,1.3,.4,1) forwards",
        }}>
          <div style={{
            fontSize: "clamp(24px, 5vw, 34px)", fontWeight: 800, letterSpacing: 3, overflowWrap: "anywhere",
            background: "linear-gradient(135deg, #ffe9b8, #ffd98a 45%, #d9a045)",
            WebkitBackgroundClip: "text", backgroundClip: "text", color: "transparent",
          }}>欢迎{roleLabel} · 首次开启</div>
          <div style={{ marginTop: 8, color: "#9aa2ac", fontSize: 15, letterSpacing: 2 }}>
            您的专属 <b style={{ color: "#d6dce4" }}>AI 智能经营系统</b> —— 全体员工列队欢迎
          </div>
          <style>{`@keyframes wl-banner-unfurl { from { transform: translateX(-50%) scaleX(0); } to { transform: translateX(-50%) scaleX(1); } }`}</style>
        </div>
      )}

      {/* 彩带（舞蹈期两波） */}
      {phase === "dance" && <><Confetti count={50} seed={7} /><Confetti count={30} seed={23} /></>}

      {/* 剪彩礼带 */}
      {(phase === "ribbon") && (
        <div style={{
          position: "absolute", top: 460, left: 0, right: 0, height: 14, zIndex: 20,
          background: "linear-gradient(90deg, transparent, #d6dce4 8%, #f0f4f9 50%, #d6dce4 92%, transparent)",
          boxShadow: "0 0 30px rgba(214,220,228,.5)",
          animation: "wl-ribbon-cut .9s ease-in .3s forwards",
        }}>
          <style>{`@keyframes wl-ribbon-cut { 0% { clip-path: inset(0 0 0 0); opacity: 1; } 100% { clip-path: inset(0 50% 0 50%); opacity: 0; transform: translateY(40px); } }`}</style>
        </div>
      )}

      {/* 团队仪式期可稍后继续，也可直接进入系统；织伴开场期由 MateWelcome 按钮接管。 */}
      {phase !== "mate" && (
        <div style={{ position: "absolute", top: 34, right: 40, zIndex: 50, display: "flex", gap: 8 }}>
          <button
            onClick={() => onPause("team")}
            style={{ cursor: "pointer", color: "#9aa2ac", fontSize: 14, background: "rgba(11,13,16,.75)", border: "1px solid rgba(214,220,228,.2)", borderRadius: 8, padding: "8px 14px" }}
          >稍后继续</button>
          <button
            data-welcome-action="skip-team"
            onClick={skip}
            style={{ cursor: "pointer", color: "#9aa2ac", fontSize: 14, background: "rgba(11,13,16,.75)", border: "1px solid rgba(214,220,228,.2)", borderRadius: 8, padding: "8px 14px" }}
          >直接进入 <Icon name="chevron" size={13} style={{ display: "inline" }} /></button>
        </div>
      )}

    </div>
  );
}
