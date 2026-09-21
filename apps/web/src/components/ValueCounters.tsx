/**
 * ValueCounters · 累计价值计数器（方案 V4 §6.2「数得清的战果」）
 * 两枚呼吸计数器：已自主完成 N 项作业 / 团队成员 N 人。
 * 数据全部来自真实事件库（onboarding.status 工作区计数），
 * 首次启动即非零——"系统在替我干活"一眼可证。
 * 2026-09-21 产品所有者口径（本机单人运行）：基座通用审批环节已移除，「待您拍板」计数随之下线；
 * 业务链路自带的关卡（如定妆照确认）在各自业务页面就地放行，不在此汇总。
 */
import { useEffect, useState } from "react";
import { ensureDemoLogin, trpc } from "../lib/trpc";

interface Counts { events: number; agents: number }

export function ValueCounters() {
  const [c, setC] = useState<Counts | null>(null);
  useEffect(() => {
    let stop = false;
    const load = async () => {
      try {
        await ensureDemoLogin();
        const st = await trpc.onboarding.status.query() as { workspace?: { events?: number; agents?: number } };
        if (!stop) setC({ events: st.workspace?.events ?? 0, agents: st.workspace?.agents ?? 0 });
      } catch { /* 静默 */ }
    };
    void load();
    const id = setInterval(() => void load(), 30_000);
    return () => { stop = true; clearInterval(id); };
  }, []);
  if (!c) return null;

  const items = [
    { label: "已自主完成", value: c.events, unit: "项作业", tone: "text-holo" },
    { label: "团队在岗", value: c.agents, unit: "人", tone: "text-go" },
  ];
  return (
    <div className="flex items-center gap-4 rounded-lg border border-line bg-card px-3 py-1.5">
      {items.map((it) => (
        <div key={it.label} className="flex items-baseline gap-1.5 text-body text-ink3">
          <span>{it.label}</span>
          <span className={`font-orb text-[15px] font-bold tracking-wider ${it.tone}`}
            style={{ animation: it.value > 0 ? "wl-counter-breathe 2.4s ease-in-out infinite" : undefined }}>
            {it.value.toLocaleString()}
          </span>
          <span>{it.unit}</span>
        </div>
      ))}
      <style>{`@keyframes wl-counter-breathe { 0%,100% { opacity: 1; } 50% { opacity: .62; } }`}</style>
    </div>
  );
}
