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
