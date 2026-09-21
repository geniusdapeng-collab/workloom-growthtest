/**
 * Run / Approval 服务（P1 治理闭环）。
 *
 * 链路：run_start → 真实围栏判定（策略桥）→
 *   auto   → 执行（P1 为显式模拟执行器）→ 五元事件 + 回执 → completed
 *   review → 生成审批卡 → 挂起 → 人在 Codex/工作台三手势 → 执行/驳回
 *   block  → 直接熔断，不生成审批、不执行
 *
 * 纪律：
 *  - 判定失败 fail-closed（按 block 处理并留痕）；
 *  - 无回执不算完成：completed 必须带 receipt.synced=true；
 *  - 只增不改：状态变化 append revision；幂等键去重；
 *  - 执行器是显式模拟（dataMode=simulated，receipt URI 为 workloom-sim://），
 *    真实连接器接入见计划 P3；禁止把模拟回执伪装成真实平台成功。
 */
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { findCapability } from "./catalog.mjs";
import { createPolicyClient } from "./policy-client.mjs";
import { createStore } from "./store.mjs";
import { resolveRepoRoot } from "./paths.mjs";

export const RUN_STATES = ["queued", "running", "waiting_approval", "completed", "blocked", "failed", "cancelled", "paused"];
const TERMINAL = new Set(["completed", "blocked", "failed", "cancelled"]);

export class RunServiceError extends Error {
  constructor(code, message, detail) {
    super(message);
    this.name = "RunServiceError";
    this.code = code;
    this.detail = detail;
  }
}

export function defaultDataDir(repoRoot) {
  return process.env.WORKLOOM_GATEWAY_DATA_DIR || join(repoRoot, "data", "codex-gateway");
}

function deriveObjectType(action, fallback) {
  const parts = String(action ?? "").split(".").filter(Boolean);
  if (parts.length >= 2) return parts.slice(0, -1).join("_");
  return fallback;
}

function resolveTarget(capability, input) {
  if (input.action) {
    return {
      action: input.action,
      objectType: input.objectType ?? deriveObjectType(input.action, capability.kind === "pipeline" ? "pipeline" : "task"),
      objectId: input.objectId ?? `${capability.id}`,
      effect: input.effect ?? "write",
    };
  }
  const writeTool = (capability.tools ?? []).find((tool) => tool.access === "write");
  const tool = writeTool ?? (capability.tools ?? [])[0];
  if (tool) {
    return {
      action: tool.name,
      objectType: input.objectType ?? deriveObjectType(tool.name, "task"),
      objectId: input.objectId ?? `${capability.id}`,
      effect: input.effect ?? (tool.access === "read" ? "read" : "write"),
    };
  }
  if (capability.kind === "pipeline") {
    return { action: "run.execute", objectType: input.objectType ?? "pipeline", objectId: input.objectId ?? capability.id, effect: input.effect ?? "write" };
  }
  return { action: `${capability.kind}.invoke`, objectType: input.objectType ?? capability.kind, objectId: input.objectId ?? capability.id, effect: input.effect ?? "write" };
}

function stepsOf(capability) {
  if (capability.kind === "pipeline" && Array.isArray(capability.steps) && capability.steps.length) {
    return capability.steps.map((step) => ({ stepId: step.stepKey, label: step.name, gate: step.gate || "" }));
  }
  const writeTools = (capability.tools ?? []).filter((tool) => tool.access === "write");
  if (writeTools.length) return writeTools.map((tool) => ({ stepId: tool.name, label: tool.desc || tool.name, gate: "" }));
  return [{ stepId: "execute", label: `${capability.displayName} 执行`, gate: "" }];
}

function ownerAgentIdOf(capability, catalog) {
  if (capability.kind === "employee") return capability.id;
  if (capability.kind === "pipeline" && capability.steps?.length) {
    const ownerKey = capability.steps.find((step) => step.owner)?.owner;
    if (!ownerKey) return null;
    return catalog.capabilities.find((item) => item.kind === "employee" && item.presetKey === ownerKey)?.id ?? null;
  }
  return null;
}

export function createRunService({
  repoRoot = resolveRepoRoot(),
  catalog,
  policy = createPolicyClient({ repoRoot }),
  store = createStore({ dataDir: defaultDataDir(repoRoot) }),
  now = () => new Date(),
  approvalTtlMs = 2 * 60 * 60 * 1000,
} = {}) {
  if (!catalog) throw new RunServiceError("CATALOG_REQUIRED", "createRunService 需要 catalog");

  const workspaceId = catalog.repo.defaultBundle || "geo-growth";
  const tenantId = "growthtest";

  function contextOf(input) {
    return {
      tenant_id: input.context?.tenant_id ?? tenantId,
      workspace_id: input.context?.workspace_id ?? workspaceId,
      time: now().toISOString(),
      channel: input.context?.channel ?? "codex",
      ...input.context,
    };
  }

  function ledgerBase(run, action, extra = {}) {
    return {
      who: run.actor,
      context: contextOf({ context: run.context }),
      object: { type: run.objectType, id: run.objectId },
      decision: { action, after: extra.after, before: extra.before, basis: extra.basis },
      rule_impact: extra.rule_impact ?? [],
      ...(extra.receipt ? { receipt: extra.receipt } : {}),
      links: [run.runId, ...(extra.links ?? [])],
    };
  }

  function append(record) {
    return store.appendRun({ ...record, updatedAt: now().toISOString() });
  }

  function executeSimulated(run, { editedAfter } = {}) {
    let current = append({ ...run, state: "running", progress: 0.05, currentStep: null });
    for (const [index, step] of run.steps.entries()) {
      const progress = Math.min(0.95, (index + 1) / (run.steps.length + 1));
      current = append({ ...current, state: "running", progress, currentStep: step.stepId, steps: current.steps.map((item) => (item.stepId === step.stepId ? { ...item, state: "done", doneAt: now().toISOString() } : item)) });
      store.appendLedger(ledgerBase(current, `run.step.${step.stepId}`, {
        after: { progress, gate: step.gate || undefined, editedAfter: editedAfter ?? undefined },
        basis: step.gate ? [`gate:${step.gate}`] : ["execution:simulated"],
      }));
    }
    const receipt = {
      synced: true,
      snapshot_uri: `workloom-sim://receipt/${current.runId}`,
      verified_at: now().toISOString(),
    };
    const completed = append({
      ...current,
      state: "completed",
      progress: 1,
      currentStep: null,
      receipts: [...current.receipts, { eventId: store.lastEventId ?? "", synced: true, verifiedAt: receipt.verified_at, snapshotUri: receipt.snapshot_uri }],
      artifacts: [...current.artifacts, { kind: "simulated", uri: `workloom-sim://artifact/${current.runId}`, dataMode: "simulated" }],
      receipt,
      finishedAt: now().toISOString(),
    });
    store.appendLedger(ledgerBase(completed, "run.completed", { receipt, after: { state: "completed", dataMode: "simulated" }, basis: ["receipt:synced", "execution:simulated"] }));
    return store.getRun(completed.runId);
  }

  function blockRun(run, verdict, reason) {
    const blocked = append({ ...run, state: "blocked", blockReason: reason, fence: verdict });
    store.appendLedger(ledgerBase(blocked, "run.blocked", { after: { reason }, rule_impact: verdict?.impacts ?? [] }));
    return blocked;
  }

  function createApproval(run, capability, verdict) {
    const createdAt = now();
    const expiresAt = new Date(createdAt.getTime() + approvalTtlMs).toISOString();
    const approval = store.appendApproval({
      approvalId: `APR-${createdAt.getTime().toString(36)}-${randomUUID().slice(0, 6)}`,
      runId: run.runId,
      capabilityId: run.capabilityId,
      risk: capability.highRisk || verdict.level === "block" ? "high" : "review",
      gate: verdict.triggeredBy?.[0] ?? verdict.impacts?.[0]?.rule_id ?? "",
      summary: `${capability.displayName}：${run.action}`,
      objectRef: `${run.objectType}:${run.objectId}`,
      requestedBy: run.actor,
      ownerAgentId: run.ownerAgentId ?? null,
      snapshot: { before: run.before, after: run.params, expires_at: expiresAt, high_risk: Boolean(capability.highRisk) },
      status: "pending",
      gesture: null,
      decidedBy: null,
      decidedAt: null,
      createdAt: createdAt.toISOString(),
      expiresAt,
      dataMode: "simulated",
    });
    const waiting = append({ ...run, state: "waiting_approval", approvals: [...run.approvals, approval.approvalId], fence: verdict });
    store.appendLedger(ledgerBase(waiting, "approval.asked", {
      after: { approvalId: approval.approvalId, gate: approval.gate, risk: approval.risk },
      links: [approval.approvalId],
      rule_impact: verdict.impacts ?? [],
    }));
    return { approval, run: waiting };
  }

  async function startRun(input = {}) {
    const capability = findCapability(catalog, input.capabilityId);
    if (!capability) throw new RunServiceError("CAPABILITY_NOT_FOUND", `未找到能力：${input.capabilityId ?? "(空)"}`);
    if (input.idempotencyKey) {
      const existing = store.findByIdempotencyKey(input.idempotencyKey);
      if (existing) return { run: existing, approval: existing.approvals.length ? store.getApproval(existing.approvals[0]) : null, deduped: true };
    }
    const target = resolveTarget(capability, input);
    const actor = input.actor ?? { type: "codex", id: "codex", version: "p1" };
    const runId = `RUN-${now().getTime().toString(36)}-${randomUUID().slice(0, 6)}`;
    const baseRun = {
      runId,
      capabilityId: capability.id,
      displayName: capability.displayName,
      kind: capability.kind,
      state: "queued",
      progress: 0,
      steps: stepsOf(capability).map((step) => ({ ...step, state: "queued" })),
      currentStep: null,
      cost: { unit: "积分", amount: 0 },
      approvals: [],
      artifacts: [],
      receipts: [],
      fence: null,
      actor,
      ownerAgentId: ownerAgentIdOf(capability, catalog),
      action: target.action,
      objectType: target.objectType,
      objectId: target.objectId,
      effect: target.effect,
      params: input.params ?? {},
      before: input.before,
      after: input.after,
      context: input.context ?? {},
      idempotencyKey: input.idempotencyKey ?? null,
      dataMode: "simulated",
      executionAdapter: "simulated-v1",
      createdAt: now().toISOString(),
      updatedAt: now().toISOString(),
      revision: 0,
    };
    append(baseRun);

    let verdict;
    try {
      verdict = await policy.judge({
        object: { type: target.objectType, id: target.objectId },
        action: target.action,
        effect: target.effect,
        params: input.params ?? {},
        before: input.before,
        after: input.after,
        context: { ...contextOf(input), ...(input.context ?? {}) },
      });
    } catch (error) {
      const failed = blockRun(store.getRun(runId), { level: "block", impacts: [], triggeredBy: [`策略桥不可用：${error.message}`], evalErrors: [error.message] }, "POLICY_UNAVAILABLE");
      return { run: failed, approval: null, fence: failed.fence };
    }

    store.appendLedger(ledgerBase(store.getRun(runId), "run.started", {
      after: { capabilityId: capability.id, action: target.action, objectType: target.objectType, effect: target.effect },
      rule_impact: verdict.impacts ?? [],
    }));

    if (verdict.level === "block") {
      return { run: blockRun(store.getRun(runId), verdict, "FENCE_BLOCK"), approval: null, fence: verdict };
    }
    if (verdict.level === "review") {
      const { approval, run } = createApproval(store.getRun(runId), capability, verdict);
      return { run, approval, fence: verdict };
    }
    const run = executeSimulated(append({ ...store.getRun(runId), fence: verdict }));
    return { run, approval: null, fence: verdict };
  }

  async function decideApproval(input = {}) {
    const approvalId = input.approvalId;
    const approval = store.getApproval(approvalId);
    if (!approval) throw new RunServiceError("APPROVAL_NOT_FOUND", `未找到审批：${approvalId ?? "(空)"}`);
    if (approval.status !== "pending") {
      const run = store.getRun(approval.runId);
      return { approval, run, deduped: true };
    }
    if (approval.expiresAt && new Date(approval.expiresAt).getTime() < now().getTime()) {
      const expired = store.appendApproval({ ...approval, status: "expired", decidedAt: now().toISOString(), decidedBy: input.actor ?? { type: "human", id: "unknown" } });
      const run = store.getRun(approval.runId);
      if (run) store.appendLedger(ledgerBase(run, "approval.expired", { after: { approvalId }, links: [approvalId] }));
      throw new RunServiceError("APPROVAL_EXPIRED", `审批已过期：${approvalId}`, { approval: expired });
    }
    // 兼容两种调用：MCP schema 使用对象 {type:...}；旧调用可能传字符串 "approve"。
    const rawGesture = input.gesture ?? (input.type ? { type: input.type } : undefined);
    const gesture = typeof rawGesture === "string" ? { type: rawGesture } : rawGesture ?? { type: undefined };
    try {
      await policy.validateGesture(gesture, input.role ?? "owner");
    } catch (error) {
      throw new RunServiceError("INVALID_GESTURE", error instanceof Error ? error.message : String(error));
    }
    const decidedBy = input.actor ?? { type: "human", id: "operator" };
    const decided = store.appendApproval({
      ...approval,
      status: gesture.type === "reject" ? "rejected" : "approved",
      gesture,
      decidedBy,
      decidedAt: now().toISOString(),
    });
    const run = store.getRun(approval.runId);
    store.appendLedger(ledgerBase(run ?? decided, "approval.decided", {
      after: { approvalId, gesture: gesture.type, reasonEnum: gesture.reasonEnum, reasonText: gesture.reasonText, editedAfter: gesture.editedAfter },
      links: [approvalId],
    }));
    if (!run) return { approval: decided, run: null };
    if (gesture.type === "reject") {
      const cancelled = append({ ...run, state: "cancelled", cancelReason: gesture.reasonText ?? gesture.reasonEnum ?? "rejected", finishedAt: now().toISOString() });
      store.appendLedger(ledgerBase(cancelled, "run.cancelled", { after: { reason: "approval_rejected" }, links: [approvalId] }));
      return { approval: decided, run: cancelled };
    }
    const executed = executeSimulated(append({ ...run, fence: run.fence, editedAfter: gesture.editedAfter }), { editedAfter: gesture.editedAfter });
    return { approval: decided, run: executed };
  }

  function cancelRun(input = {}) {
    const run = store.getRun(input.runId);
    if (!run) throw new RunServiceError("RUN_NOT_FOUND", `未找到 Run：${input.runId ?? "(空)"}`);
    if (TERMINAL.has(run.state)) return { run, deduped: true };
    const cancelled = append({ ...run, state: "cancelled", cancelReason: input.reason ?? "cancelled_by_user", finishedAt: now().toISOString() });
    store.appendLedger(ledgerBase(cancelled, "run.cancelled", { after: { reason: cancelled.cancelReason } }));
    return { run: cancelled };
  }

  return {
    repoRoot,
    store,
    policy,
    startRun,
    decideApproval,
    cancelRun,
    getRun: (runId) => store.getRun(runId),
    listRuns: () => store.listRuns(),
    listApprovals: (options) => store.listApprovals(options),
    getApproval: (approvalId) => store.getApproval(approvalId),
    tailRun: (runId, limit = 20) => store.listLedger().filter((event) => (event.links ?? []).includes(runId)).slice(-limit),
    verifyLedger: () => store.verifyLedger(),
    close: () => policy.close?.(),
  };
}
