/**
 * P3 掌上日报（F6：夜班交接班消息 · 移动端监督者视角；PRD P3-①②③④⑤ 逐条对账）
 *  - 375px 内容区（§4.2 拇指化重排）：日报计数头置顶 → 求援卡 → 底部紧急制动
 *  - P3E1 三栏计数头与 P1 交接班卡强一致（F4.4 同一 stats 数据源）；点击筛选消息列表
 *  - P3E5 紧急制动（二次确认 → nightShift.pause，G5 ≤60s 全端生效）
 * 状态变体：p3 默认 / p3_empty 夜班未启用
 * 权限态：无夜班管理权的成员仅可查看，不显示制动入口（E2.6 隐藏非置灰）
 * 2026-09-21 产品所有者口径（本机单人运行）：基座通用审批环节已移除，本页不再逐条列出审批卡、
 * 不再提供批量采纳与三手势；业务链路自带的关卡（如视频管线 G1–G10、定妆照确认）在各自业务页面就地放行。
 */
import { useCallback, useEffect, useState } from "react";
import { ensureDemoLogin, trpc } from "../../lib/trpc";
import {
  BannerAlert,
  EmergencyBrake,
  EmptyState,
  Skeleton,
} from "../../components/hud";
import { useNavigate } from "react-router";
import { useNavigationAccess } from "../../shell/NavigationAccess";
import { Icon } from "@workloom/ui";

interface NightRun {
  id: string; status: string; fenceSnapshot: string | null;
  stats: { done: number; pending: number; need_human: number; credits_used: number } | null;
}
type Filter = "all" | "done" | "needHuman";

export default function P3() {
  const navigate = useNavigate();
  const { entries, canAction } = useNavigationAccess();
  const [ready, setReady] = useState(false);
  const [nightConfigured, setNightConfigured] = useState(true);
  const [run, setRun] = useState<NightRun | null>(null);
  const [filter, setFilter] = useState<Filter>("all");
  const [banner, setBanner] = useState<{ level: "alert" | "warn" | "info"; text: string } | null>(null);
  const canReadNight = entries.some((entry) => entry.route === "/night");

  const load = useCallback(async () => {
    try {
      await ensureDemoLogin();
      const cur = await (canReadNight
        ? trpc.nightShift.current.query() as Promise<{ configured: boolean; run?: NightRun }>
        : Promise.resolve({ configured: false } as { configured: boolean; run?: NightRun }));
      setNightConfigured(cur.configured);
      setRun(cur.run ?? null);
    } finally {
      setReady(true);
    }
  }, [canReadNight]);

  useEffect(() => {
    void load();
    const t = setInterval(() => void load(), 10000); // 移动端 10s（D6）
    return () => clearInterval(t);
  }, [load]);

  const stats = run?.stats ?? { done: 0, pending: 0, need_human: 0, credits_used: 0 };
  const canManageNight = canAction("night.manage");

  const doPause = useCallback(async () => {
    if (!run) return;
    const r = await trpc.nightShift.pause.mutate({ runId: run.id }) as { elapsedMs: number; withinSla: boolean };
    const elapsed = `${Math.max(0.1, r.elapsedMs / 1000).toFixed(1)} 秒`;
    setBanner(r.withinSla
      ? { level: "info", text: `夜班已暂停，并在 ${elapsed} 内同步到全部客户端。` }
      : { level: "alert", text: `暂停指令在 ${elapsed} 内未能完成，系统已升级为首页告警。` });
    await load();
  }, [run, load]);

  /* 同一响应式内容同时适配桌面窄栏与移动视口，不模拟固定尺寸手机壳。 */
  return (
    <div className="mx-auto flex min-h-full w-full min-w-0 max-w-3xl items-start justify-center px-2 py-4 sm:px-4 sm:py-6">
      <div className="w-full overflow-hidden rounded-panel border border-line bg-bg900 shadow-[0_20px_60px_rgba(0,0,0,.35)]">
        <div className="space-y-3 p-3.5">
          {/* 页头 */}
          <div className="flex items-center gap-2">
            <span className="text-h2 font-black text-ink">掌上日报</span>
            <span className="text-body tracking-[.2em] text-ink3">夜班交接</span>
          </div>

          {banner && <BannerAlert level={banner.level} actionLabel="好" onAction={() => setBanner(null)}>{banner.text}</BannerAlert>}

          {!ready ? (
            <><Skeleton count={2} height={56} label="夜班摘要正在加载" /><Skeleton count={4} label="夜班详情正在加载" /></>
          ) : !nightConfigured ? (
            /* p3_empty：夜班未启用（F4.8） */
            <EmptyState
              icon={<Icon name="night" size={24} />}
              title="夜班中心尚未出征"
              hint="前往规则与权限配置夜班，明早 08:30 日报送达。"
              actionLabel="去配置 →"
              // actionLabel 存在即渲染按钮：不传 onAction 会得到一个点了没反应的按钮（实测缺陷）
              onAction={() => navigate("/configuration")}
            />
          ) : (
            <>
              {/* P3E1 三栏计数头（与 P1 交接班卡强一致 F4.4；点击筛选） */}
              <div className="rounded-2xl border border-line bg-card p-3.5">
                <div className="mb-2 flex items-center justify-between">
                  <span className="inline-flex items-center gap-1 text-body font-black text-goldhi"><Icon name="night" size={14} />昨夜日报</span>
                  {run?.fenceSnapshot && <span className="text-body text-holo">围栏快照已锁定</span>}
                </div>
                <div className="grid grid-cols-2 gap-2">
                  {([
                    { k: "done" as Filter, n: stats.done, label: "已完成", cls: "text-go" },
                    { k: "needHuman" as Filter, n: stats.need_human, label: "需介入", cls: "text-alert" },
                  ]).map((c) => (
                    <button
                      key={c.k}
                      type="button"
                      onClick={() => setFilter(filter === c.k ? "all" : c.k)}
                      className={`cursor-pointer rounded-xl border px-2 py-2.5 text-center ${
                        filter === c.k ? "border-gline bg-gold/8" : "border-line bg-bg800/60"
                      }`}
                    >
                      <div className={`font-orb text-kpi font-bold ${c.cls}`}>{c.n}</div>
                      <div className="mt-0.5 text-body text-ink2">{c.label}</div>
                    </button>
                  ))}
                </div>
                <div className="mt-2 text-center font-mono text-body text-ink3">
                  积分 {stats.credits_used} · 已应用峰谷费率 · 与工作台数据同步
                </div>
              </div>

              {/* 求援卡（需介入：夜间未执行任何动作 L4.2） */}
              {(filter === "all" || filter === "needHuman") && stats.need_human > 0 && (
                <div className="rounded-2xl border border-alert/50 bg-alert/6 p-3.5">
                  <div className="mb-1 flex items-center gap-1 text-body font-bold text-alert"><Icon name="warning" size={14} />求援 · 需介入 {stats.need_human} 项</div>
                  <div className="text-body text-ink2">夜间未执行任何动作；系统不会在信息不足时猜测，请到任务中心查看对应任务并处理。</div>
                  <div className="mt-2 text-right">
                    <button type="button" onClick={() => navigate("/tasks")} className="cursor-pointer text-body text-holo underline-offset-2 hover:underline">去任务中心 →</button>
                  </div>
                </div>
              )}

              {/* 底部单键（§4.2：紧急制动） */}
              {canManageNight && (
                <div className="flex items-stretch pb-2">
                  <EmergencyBrake onConfirm={() => void doPause()} />
                </div>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}
