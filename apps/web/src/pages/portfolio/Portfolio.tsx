/**
 * 组合看板（协作底座 §3–§4）：数字人单一叙事 + 域组合 + 决策包 ≤7 + 任务契约。
 * 数据源：collaboration.narrative / contracts.list（全部 RLS 上下文只读投影；缺数据如实空态）。
 */
import { useEffect, useState } from "react";
import { ensureDemoLogin, trpc } from "../../lib/trpc";
import { BannerAlert, EmptyState, Skeleton } from "../../components/hud";
import { Icon } from "@workloom/ui";
import { actionText } from "../../lib/display";

interface DomainRow { domain: string; label: string; agents: number; pending: number; actions7d: number; redLines7d: number }
interface PacketItem { id: string; title: string; tier: "l2_captain" | "l3_fleet" | "l4_chairman"; risk: number; deadline: string | null; createdAt: string; action?: string }
interface NarrativeData {
  narrative: string;
  portfolio: { domains: DomainRow[]; totals: { agents: number; pending: number; actions7d: number; redLines7d: number } };
  packet: { quota: number; items: PacketItem[]; overflowCount: number };
}
interface ContractRow {
  id: string; title: string; goal: string; status: string; mode: string;
  assigneePreset: string; verifierPreset: string; createdAt: string; updatedAt: string;
}

const TIER_TEXT: Record<PacketItem["tier"], string> = {
  l4_chairman: "L4 董事长", l3_fleet: "L3 集团", l2_captain: "L2 公司",
};

/**
 * 决策包条目标题：服务端在「决策快照没有人工标题」时会把内部动作码当标题回落
 * （如 `skill.install.conflict`），客户端必须中文化再上屏——否则董事长看到的是裸代码。
 */
function packetTitle(item: PacketItem): string {
  const title = (item.title ?? "").trim();
  const looksLikeActionCode = /^[a-z][a-z0-9_]*(\.[a-z0-9_]+)+$/.test(title);
  if (title && !looksLikeActionCode) return title;
  return actionText(item.action ?? title);
}

const STATUS_TEXT: Record<string, string> = {
  draft: "草稿", offered: "已邀约", accepted: "已接单", in_progress: "进行中",
  delivered: "已交付", verified: "已验收", settled: "已结清", cancelled: "已取消",
};

/** 截止时间展示：本地可读格式；空值/非法值不渲染（不出现裸 ISO 串） */
function formatDeadline(value: string | null): string {
  if (!value) return "";
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return "";
  return ` · 截止 ${d.toLocaleString("zh-CN", { hour12: false, month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" })}`;
}

export default function Portfolio() {
  const [data, setData] = useState<NarrativeData | null>(null);
  const [contracts, setContracts] = useState<ContractRow[]>([]);
  const [state, setState] = useState<"loading" | "ready" | "error">("loading");
  const [error, setError] = useState("");

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        await ensureDemoLogin();
        const svc = trpc.collaboration as unknown as {
          narrative: { query: () => Promise<NarrativeData> };
          contracts: { list: { query: () => Promise<ContractRow[]> } };
        };
        const [narrative, rows] = await Promise.all([svc.narrative.query(), svc.contracts.list.query()]);
        if (cancelled) return;
        setData(narrative);
        setContracts(rows);
        setState("ready");
      } catch (err) {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : "组合看板加载失败");
        setState("error");
      }
    })();
    return () => { cancelled = true; };
  }, []);

  if (state === "loading") return <div className="mx-auto max-w-5xl space-y-3 px-4 py-6"><Skeleton /><Skeleton /><Skeleton /></div>;
  if (state === "error") return <div className="mx-auto max-w-5xl px-4 py-6"><BannerAlert level="alert">组合看板加载失败：{error}</BannerAlert></div>;

  const totals = data?.portfolio.totals;
  return (
    <div className="mx-auto max-w-5xl space-y-4 px-4 py-6">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-h1 font-black text-ink">组合看板</h1>
          <p className="mt-1 text-body text-ink3">按结果组合看整支舰队：域健康、待董事长决策（≤{data?.packet.quota ?? 7} 件/日）、任务契约。</p>
        </div>
        <div className="rounded-lg border border-line bg-card px-3 py-2 text-body text-ink2">
          在岗 <b className="font-orb text-h3 text-ink">{totals?.agents ?? 0}</b> 人 · 待批 <b className="font-orb text-h3 text-gold">{totals?.pending ?? 0}</b> 件
        </div>
      </header>

      <section className="rounded-msg border border-line bg-card p-4">
        <div className="flex items-start gap-3">
          <div className="mt-0.5 flex size-9 shrink-0 items-center justify-center rounded-full bg-gold/15 text-gold"><Icon name="chat" size={18} /></div>
          <div className="min-w-0">
            <div className="text-body font-bold text-holo">数字人叙事 · 单一接口</div>
            <p className="mt-1 break-words text-body leading-relaxed text-ink2">{data?.narrative}</p>
          </div>
        </div>
      </section>

      <section className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {(data?.portfolio.domains ?? []).map((d) => (
          <div key={d.domain} className="rounded-msg border border-line bg-card p-3.5">
            <div className="flex items-center justify-between gap-2">
              <span className="text-body font-bold text-ink">{d.label}</span>
              <span className="text-body text-ink3">{d.agents} 人</span>
            </div>
            <div className="mt-2 grid grid-cols-3 gap-2 text-body text-ink3">
              <div><div className="text-h3 font-orb text-ink">{d.pending}</div>待批</div>
              <div><div className="text-h3 font-orb text-ink">{d.actions7d}</div>7 天动作</div>
              <div><div className={`text-h3 font-orb ${d.redLines7d > 0 ? "text-alert" : "text-ink"}`}>{d.redLines7d}</div>红线</div>
            </div>
          </div>
        ))}
        {(!data || data.portfolio.domains.length === 0) && <div className="rounded-msg border border-line bg-card p-3.5 sm:col-span-2 lg:col-span-3"><EmptyState title="暂无域数据" /></div>}
      </section>

      <section className="rounded-msg border border-line bg-card p-4">
        <div className="flex items-center justify-between gap-2">
          <div className="text-body font-bold text-holo">今日决策包（≤{data?.packet.quota ?? 7} 件）</div>
          {(data?.packet.overflowCount ?? 0) > 0 && <span className="text-body text-gold">另有 {data?.packet.overflowCount} 件超配额，按层级排入明日或带内先决</span>}
        </div>
        {data && data.packet.items.length > 0 ? (
          <ul className="mt-2 divide-y divide-line">
            {data.packet.items.map((item) => (
              <li key={item.id} className="flex items-center justify-between gap-3 py-2">
                <div className="min-w-0">
                  <div className="truncate text-body text-ink">{packetTitle(item)}</div>
                  <div className="text-body text-ink3">{TIER_TEXT[item.tier]}{formatDeadline(item.deadline)}</div>
                </div>
                <span className="shrink-0 rounded border border-gline px-2 py-0.5 text-body text-ink2">风险 {item.risk}</span>
              </li>
            ))}
          </ul>
        ) : <div className="mt-2 text-body text-ink3">今日无需董事长决策事项。</div>}
      </section>

      <section className="rounded-msg border border-line bg-card p-4">
        <div className="text-body font-bold text-holo">任务契约（跨团队协作单据）</div>
        {contracts.length > 0 ? (
          <ul className="mt-2 divide-y divide-line">
            {contracts.slice(0, 20).map((c) => (
              <li key={c.id} className="flex items-center justify-between gap-3 py-2">
                <div className="min-w-0">
                  <div className="truncate text-body text-ink">{c.title}</div>
                  <div className="text-body text-ink3">{c.id} · {c.assigneePreset} → 验收 {c.verifierPreset} · {c.mode}</div>
                </div>
                <span className="shrink-0 rounded border border-line px-2 py-0.5 text-body text-ink2">{STATUS_TEXT[c.status] ?? c.status}</span>
              </li>
            ))}
          </ul>
        ) : <div className="mt-2 text-body text-ink3">暂无契约。跨团队任务可经 collaboration.contracts.create 建立契约并留痕。</div>}
      </section>
    </div>
  );
}
