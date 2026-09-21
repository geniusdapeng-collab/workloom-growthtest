/**
 * Codex 工作台入口（P2 实验）：
 *  - 内嵌本地数字人工作台（gateway /stage，只读投影）；
 *  - 直接读取 gateway /stage/snapshot，展示真实 roster/theater 与 P1 模拟 Run 的分层数据；
 *  - 所有写操作（审批/派遣/Run）仍由 Codex 或工作台经能力网关发起，本页只做观察与入口。
 */
import { useEffect, useState } from "react";
import { Bridge } from "../../shell/Bridge";

const GATEWAY_URL = (import.meta.env.VITE_WORKLOOM_GATEWAY_URL as string | undefined) ?? "http://127.0.0.1:4310";

interface Snapshot {
  dataMode: "real" | "simulated" | "mock";
  sources?: Record<string, string>;
  live?: { ok: boolean; url?: string; error?: string; fetchedAt?: string };
  counts?: { agents: number; working: number; needsInput: number; blocked: number; pendingApprovals: number; activeRuns: number };
}

export default function CodexWorkbench() {
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    const load = async () => {
      try {
        const response = await fetch(`${GATEWAY_URL}/stage/snapshot`);
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const data = (await response.json()) as Snapshot;
        if (alive) {
          setSnapshot(data);
          setError(null);
        }
      } catch (err) {
        if (alive) setError(err instanceof Error ? err.message : String(err));
      }
    };
    void load();
    const timer = setInterval(() => void load(), 10000);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, []);

  const counts = snapshot?.counts;
  return (
    <Bridge>
      <div className="mb-4 flex min-w-0 flex-wrap items-center justify-between gap-3">
        <div className="min-w-0">
          <h2 className="break-words text-h1 font-black text-ink">Codex 工作台</h2>
          <p className="mt-1 break-words text-caption text-ink3">
            任务在 Codex 里发起；这里只做数字人团队与运行态观察。写操作经能力网关的围栏 → 人审 → 五元事件 → 回执。
          </p>
        </div>
        <div className="flex items-center gap-2 text-caption">
          <span className={`rounded-full border px-3 py-1 ${snapshot?.dataMode === "real" ? "border-go/50 text-go" : "border-gold/50 text-gold"}`}>
            数据模式：{snapshot?.dataMode ?? "加载中"}
          </span>
          {snapshot?.live?.ok ? <span className="text-ink3">roster/ticker 真实 · Run/审批模拟</span> : null}
        </div>
      </div>

      {counts ? (
        <div className="mb-4 grid grid-cols-2 gap-3 md:grid-cols-6">
          {[
            ["数字员工", counts.agents],
            ["在岗", counts.working],
            ["待输入", counts.needsInput],
            ["阻塞", counts.blocked],
            ["待审批", counts.pendingApprovals],
            ["运行 Run", counts.activeRuns],
          ].map(([label, value]) => (
            <div key={String(label)} className="rounded-lg border border-line bg-card p-3">
              <div className="text-caption text-ink3">{label}</div>
              <div className="mt-1 text-h1 font-black text-ink">{value}</div>
            </div>
          ))}
        </div>
      ) : null}

      {error ? (
        <div className="mb-4 rounded-lg border border-alert/50 bg-alert/10 p-3 text-caption text-alert">
          网关未连接：{error}。请先运行{" "}
          <code>node tools/codex-gateway/bin/cli.mjs stage serve</code>（默认 http://127.0.0.1:4310）。
        </div>
      ) : null}

      <div className="overflow-hidden rounded-lg border border-line bg-bg850">
        <iframe
          title="WorkLoom 数字人团队工作台"
          src={`${GATEWAY_URL}/stage`}
          className="h-[78vh] w-full border-0"
          referrerPolicy="no-referrer"
        />
      </div>

      <p className="mt-3 break-words text-caption text-ink3">
        说明：内嵌页面的执行器为显式模拟（<code>workloom-sim://</code> 回执）；真实平台动作必须等连接器与考试院通过后开放。
      </p>
    </Bridge>
  );
}
