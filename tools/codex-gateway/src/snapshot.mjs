/**
 * TeamProjection / Run / Approval 快照（P0）。
 *
 * 事实与状态的边界必须显式：
 *  - 员工、能力、围栏、管线来自代码事实（bundles/*）；
 *  - 运行态、审批、KPI、额度来自 `fixtures/mock-state.json`（dataMode=mock）；
 *  - 页面与 API 必须把 dataMode 展示给人类，禁止把 mock 伪装成真实。
 */
import { existsSync, readFileSync } from "node:fs";
import { gatewayFile, resolveRepoRoot } from "./paths.mjs";
import { generateCatalog, findCapability } from "./catalog.mjs";

export const DEFAULT_STAGE_PORT = 4310;

export function loadFixture() {
  const path = gatewayFile("fixtures", "mock-state.json");
  if (!existsSync(path)) {
    throw new Error(`缺少模拟夹具：${path}`);
  }
  return JSON.parse(readFileSync(path, "utf8"));
}

function runStateForAgent(runs, agentId) {
  const active = runs.find(
    (run) =>
      (run.agentId === agentId || run.ownerAgentId === agentId) &&
      ["running", "waiting_approval", "paused"].includes(run.state),
  );
  if (!active) return null;
  return active;
}

function statusFromRun(run) {
  if (!run) return null;
  if (run.state === "waiting_approval" || run.state === "paused") return "needs_input";
  if (run.state === "blocked" || run.state === "failed") return "blocked";
  if (run.state === "running" || run.state === "queued") return "working";
  return null;
}

export function buildSnapshot({ repoRoot = resolveRepoRoot(), catalog = generateCatalog({ repoRoot }), store = null, now = new Date().toISOString() } = {}) {
  const fixture = loadFixture();
  const employees = catalog.capabilities.filter((capability) => capability.kind === "employee");
  const storeRuns = store?.listRuns?.() ?? [];
  const storeApprovals = store?.listApprovals?.({ status: "pending" }) ?? [];
  const hasLiveState = storeRuns.length > 0 || storeApprovals.length > 0;
  const runs = hasLiveState ? storeRuns : fixture.runs ?? [];
  const approvals = hasLiveState ? storeApprovals : (fixture.approvals ?? []).filter((approval) => approval.status === "pending");
  const dataMode = hasLiveState ? "simulated" : "mock";

  const agents = employees.map((employee) => {
    const fixtureAgent = fixture.agents?.[employee.presetKey] ?? {};
    const activeRun = runStateForAgent(runs, employee.id);
    // 有真实（P1：显式模拟执行）状态时，不再用夹具状态/战绩冒充在岗与绩效，避免真假混层。
    const status = statusFromRun(activeRun) ?? (hasLiveState ? (employee.nightShift ? "idle" : "offline") : fixtureAgent.status ?? (employee.nightShift ? "idle" : "offline"));
    const agentApprovals = approvals.filter((approval) => approval.ownerAgentId === employee.id || approval.requestedBy === employee.id);
    return {
      id: employee.id,
      presetKey: employee.presetKey,
      name: employee.displayName,
      alias: fixtureAgent.alias ?? null,
      grade: fixtureAgent.grade ?? "正常",
      status: agentApprovals.length ? "needs_input" : status,
      bundles: employee.bundles,
      domains: employee.domains,
      risk: employee.risk,
      nightShift: employee.nightShift,
      highRisk: employee.highRisk,
      fenceBindings: employee.fenceBindings,
      tools: employee.tools,
      currentRunId: activeRun?.runId ?? null,
      currentCapabilityId: activeRun?.capabilityId ?? null,
      progress: activeRun?.progress ?? null,
      pendingApprovals: agentApprovals.map((approval) => approval.approvalId),
      stats: {
        actions30: hasLiveState ? 0 : fixtureAgent.actions30 ?? 0,
        approvals30: hasLiveState ? 0 : fixtureAgent.approvals30 ?? 0,
        receipts30: hasLiveState ? 0 : fixtureAgent.receipts30 ?? 0,
      },
      codexThreadId: null,
      dataMode,
    };
  });

  const runsWithNames = runs.map((run) => {
    const capability = findCapability(catalog, run.capabilityId);
    return {
      ...run,
      displayName: run.displayName ?? capability?.displayName ?? run.capabilityId,
      risk: capability?.risk ?? { level: "review", source: "unknown" },
      dataMode: run.dataMode ?? dataMode,
    };
  });

  return {
    schemaVersion: "workloom.stage-projection/v1",
    workspace: {
      id: catalog.repo.defaultBundle || "geo-growth",
      name: catalog.repo.displayName || catalog.repo.name,
      industry: catalog.repo.defaultBundle || "geo-growth",
      productId: catalog.repo.productId,
    },
    generatedAt: now,
    cursor: hasLiveState ? `store:${store?.lastEventId ?? "E-0"}` : `mock:${fixture.runs?.length ?? 0}:${fixture.approvals?.length ?? 0}`,
    dataMode,
    factsSource: "bundles/*（代码事实）",
    stateSource: hasLiveState ? "data/codex-gateway（P1 Run/Approval JSONL，执行器为显式模拟）" : "tools/codex-gateway/fixtures/mock-state.json",
    note: hasLiveState
      ? "P1 实验：能力/员工来自代码事实，Run/审批来自网关 append-only 存储；执行器为显式模拟（workloom-sim:// 回执），真实连接器接入见计划 P3。"
      : "P0 实验：能力/员工来自代码事实，运行态/审批/KPI/额度来自模拟夹具；接入真实 tRPC 与事件总线见 docs/CODEX-WORKBENCH-PLAN.md 的 P1。",
    night: fixture.night ?? { status: "off", range: "22:00–08:00" },
    counts: {
      agents: agents.length,
      working: agents.filter((agent) => agent.status === "working").length,
      needsInput: agents.filter((agent) => agent.status === "needs_input").length,
      blocked: agents.filter((agent) => agent.status === "blocked").length,
      idle: agents.filter((agent) => agent.status === "idle").length,
      offline: agents.filter((agent) => agent.status === "offline").length,
      pendingApprovals: approvals.length,
      activeRuns: runsWithNames.filter((run) => ["running", "waiting_approval", "paused"].includes(run.state)).length,
    },
    agents,
    runs: runsWithNames,
    approvals,
    // 有真实（P1：显式模拟执行）状态时，不把夹具 KPI/额度混进同一视图；P3 接真实指标后再填。
    kpi: hasLiveState ? [] : fixture.kpi ?? [],
    quota: hasLiveState ? [] : fixture.quota ?? [],
    capabilities: {
      summary: catalog.summary,
      pipelines: catalog.capabilities.filter((capability) => capability.kind === "pipeline").map((pipeline) => ({
        id: pipeline.id,
        displayName: pipeline.displayName,
        gates: pipeline.gates,
        schedule: pipeline.schedule,
      })),
    },
  };
}

export function snapshotEvent(snapshot) {
  return {
    event: "stage.snapshot",
    data: snapshot,
  };
}

function liveStatusOf(agent, liveAgent) {
  if (liveAgent?.status === "needs_input" || liveAgent?.status === "blocked") return liveAgent.status;
  if (liveAgent?.online === true) return "working";
  if (liveAgent?.readonly === true) return "idle";
  return "offline";
}

/**
 * P3 投影：在 P0/P1 快照之上叠加真实 roster/theater。
 * - roster/theater = real（来自本地 server 的 tRPC 只读查询）
 * - Run/审批 = store 中的数据（P1 为显式模拟执行，逐项 dataMode=simulated）
 * live 失败时保留原投影并记录 live.error，不阻塞页面。
 */
export async function buildProjection({ repoRoot = resolveRepoRoot(), catalog = generateCatalog({ repoRoot }), store = null, liveSource = null, now = new Date().toISOString() } = {}) {
  const base = buildSnapshot({ repoRoot, catalog, store, now });
  if (!liveSource) return base;
  const live = await liveSource.load();
  base.live = { ok: live.ok, url: live.url, fetchedAt: live.fetchedAt, ...(live.ok ? {} : { error: live.error }) };
  if (!live.ok) return base;

  const rosterAgents = live.roster?.agents ?? [];
  const byPreset = new Map();
  for (const agent of rosterAgents) {
    const key = agent.presetKey ?? String(agent.id ?? "").replace(/^agt-/, "").replace(/-ws-[0-9a-z-]+$/i, "");
    if (key) byPreset.set(key, agent);
  }

  base.agents = base.agents.map((agent) => {
    const liveAgent = byPreset.get(agent.presetKey);
    if (!liveAgent) return agent;
    const liveStatus = liveStatusOf(agent, liveAgent);
    const status = agent.pendingApprovals?.length ? "needs_input" : agent.currentRunId ? liveStatus : liveStatus;
    return {
      ...agent,
      name: liveAgent.name ?? agent.name,
      alias: liveAgent.alias ?? agent.alias,
      status,
      online: Boolean(liveAgent.online),
      readonly: Boolean(liveAgent.readonly),
      fenceBindings: liveAgent.fenceBindings ?? agent.fenceBindings,
      highRisk: liveAgent.highRisk ?? agent.highRisk,
      nightShift: liveAgent.nightShift ?? agent.nightShift,
      skills: liveAgent.skills ?? agent.skills,
      stats: liveAgent.stats ? {
        actions30: liveAgent.stats.actions30 ?? liveAgent.stats.actions ?? 0,
        approvals30: liveAgent.stats.approvals30 ?? 0,
        receipts30: liveAgent.stats.receipts30 ?? 0,
      } : agent.stats,
      liveStatus: liveAgent.status ?? null,
      dataMode: "real",
    };
  });
  base.dataMode = "real";
  base.sources = {
    roster: "real",
    theater: "real",
    runs: base.runs.length ? (base.runs.every((run) => run.dataMode === "simulated") ? "simulated" : "mixed") : "none",
    approvals: base.approvals.length ? (base.approvals.every((approval) => approval.dataMode === "simulated") ? "simulated" : "mixed") : "none",
  };
  base.ticker = (live.theater?.ticker ?? []).slice(0, 20);
  base.theater = {
    mode: live.theater?.mode ?? null,
    ceoName: live.theater?.ceoName ?? null,
    pendingByTier: live.theater?.pendingByTier ?? null,
    pendingTotal: live.theater?.pendingByTier ? Object.values(live.theater.pendingByTier).reduce((sum, count) => sum + Number(count ?? 0), 0) : null,
  };
  base.note = "P3 实验：数字员工/在岗/ticker 来自真实 tRPC（roster/theater），执行中的 Run 与审批为 P1 显式模拟执行；两类数据逐项标注 dataMode。";
  base.counts = {
    ...base.counts,
    agents: base.agents.length,
    working: base.agents.filter((agent) => agent.status === "working").length,
    needsInput: base.agents.filter((agent) => agent.status === "needs_input").length,
    blocked: base.agents.filter((agent) => agent.status === "blocked").length,
    idle: base.agents.filter((agent) => agent.status === "idle").length,
    offline: base.agents.filter((agent) => agent.status === "offline").length,
    pendingApprovals: base.counts.pendingApprovals,
    pendingApprovalsSource: "gateway-store（P1 模拟执行）",
    theaterPending: base.theater.pendingTotal,
    theaterPendingSource: "real-tRPC（业务真实待决）",
  };
  return base;
}

export function demoEvent(snapshot, index) {
  const runs = snapshot.runs ?? [];
  if (!runs.length) {
    return { event: "stage.heartbeat", data: { at: new Date().toISOString(), dataMode: "mock" } };
  }
  const run = runs[index % runs.length];
  const progress = Math.min(1, Number(((run.progress ?? 0) + ((index % 7) + 1) * 0.02).toFixed(2)));
  const states = ["running", "waiting_approval", "running", "completed"];
  const state = states[index % states.length];
  return {
    event: state === "waiting_approval" ? "approval.asked" : "run.progress",
    data: {
      runId: run.runId,
      capabilityId: run.capabilityId,
      displayName: run.displayName,
      state,
      progress,
      simulated: true,
      dataMode: "mock",
      at: new Date().toISOString(),
    },
  };
}

export function shortContext(snapshot) {
  const pipelines = snapshot.capabilities?.pipelines ?? [];
  const topPipelines = pipelines.slice(0, 4).map((pipeline) => `${pipeline.displayName}(${pipeline.gates.join("/") || "无闸门"})`);
  return [
    `WorkLoom 实验仓：${snapshot.workspace.name}（${snapshot.workspace.id}）`,
    `能力：${snapshot.capabilities.summary.employees} 员工 / ${snapshot.capabilities.summary.skills} 技能 / ${snapshot.capabilities.summary.pipelines} 管线 / ${snapshot.capabilities.summary.fences} 围栏`,
    `管线：${topPipelines.join("、")}`,
    `当前模拟态：${snapshot.counts.working} 在岗 / ${snapshot.counts.needsInput} 待输入 / ${snapshot.counts.pendingApprovals} 待审批`,
    `数据模式：${snapshot.dataMode}（运行态为模拟夹具，能力为代码事实）`,
    "纪律：高风险动作必须由人在 Codex 或数字人工作台批准；无回执不得宣称完成。",
  ].join("\n");
}
