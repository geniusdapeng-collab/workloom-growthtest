/**
 * 技能更新通栏（技能保鲜环 · 客户侧通知）
 *
 * 数据源 = skills.skillOps.status（recentLoaded 近 24h 装载事件）：
 *  - 近 24h 有静默装载 → 青条：「夜班已自动更新 N 个技能」，可跳 P6 技能中心查看，
 *    当日可关闭（localStorage 按日记忆，次日有新装载再出现）；
 *  - 无装载事件 → 不渲染（不打扰）。
 * 挂载点：与 SimBanner 同位（P0 经营主页 + Bridge 工作台顶栏下方）。
 *
 * 2026-09-21 产品所有者口径（本机单人运行）：基座通用审批环节已移除，本通栏不再提示
 * 「新工具/新权限待拍板」（原 pendingCount → 审批中心入口）；技能装载继续按事件留痕。
 */
import { useEffect, useState } from "react";
import { Icon } from "@workloom/ui";
import { ensureDemoLogin, trpc } from "../lib/trpc";
import { chineseDisplayName, versionText } from "../lib/display";

interface LoadedItem { skillId: string; name: string; version: string; tier: string; at: string; auto: boolean }
interface DistStatus {
  recentLoaded: LoadedItem[];
}

const dismissKey = (day: string) => `skill-dist-banner-dismissed:${day}`;

export function SkillDistBanner() {
  const [st, setSt] = useState<DistStatus | null>(null);
  const [dismissed, setDismissed] = useState(false);

  useEffect(() => {
    let stop = false;
    const load = async () => {
      try {
        await ensureDemoLogin();
        const s = (await trpc.skills.skillOps.status.query()) as DistStatus;
        if (!stop) setSt(s);
      } catch {
        /* 服务未就绪或分发未启用时静默（不阻塞任何页面） */
      }
    };
    void load();
    const id = setInterval(() => void load(), 30_000);
    return () => {
      stop = true;
      clearInterval(id);
    };
  }, []);

  useEffect(() => {
    const day = new Date().toISOString().slice(0, 10);
    setDismissed(localStorage.getItem(dismissKey(day)) === "1");
  }, []);

  if (!st || dismissed) return null;
  const loaded = st.recentLoaded ?? [];
  if (loaded.length === 0) return null;

  const onDismiss = () => {
    const day = new Date().toISOString().slice(0, 10);
    localStorage.setItem(dismissKey(day), "1");
    setDismissed(true);
  };

  // 装载事件里的 name 可能夹带拉丁记号（如演示包的「Y 域分发技能」）——旧实现整串回落成
  // 「技能能力」，用户看到的是一排同名技能；这里剔除记号后再展示，实在无法中文化才用中性兜底。
  const names = loaded.slice(0, 2).map((x) => `「${chineseDisplayName(x.name, "技能能力")} ${versionText(x.version)}」`).join("、");
  const more = loaded.length > 2 ? ` 等 ${loaded.length} 个` : "";
  return (
    <div className="relative z-30 flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-teal-500/40 bg-teal-50/90 px-4 py-2 text-body text-teal-800 backdrop-blur">
      <Icon name="star" size={16} />
      <span className="min-w-0 flex-1">
        夜班已自动更新 {loaded.length} 个技能：{names}{more}——全程留痕可回溯、可一键回滚。
      </span>
      <a
        href="/skills"
        className="shrink-0 rounded border border-teal-500/50 bg-teal-100/70 px-3 py-1 font-bold text-teal-900 no-underline transition-colors hover:bg-teal-200/70"
      >
        去技能中心 →
      </a>
      <button
        onClick={onDismiss}
        className="shrink-0 cursor-pointer rounded px-2 py-1 text-teal-700 transition-colors hover:bg-teal-100"
        aria-label="今日不再提示"
        title="今日不再提示"
      >
        <Icon name="close" size={15} />
      </button>
    </div>
  );
}
