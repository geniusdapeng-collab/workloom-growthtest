import type {
  ExecutionStatus,
  StageDisposition,
  StageSideEffect,
  VerificationStatus,
} from "./contracts.js";

export class PipelineStateError extends Error {
  constructor(message: string) {
    super(`PIPELINE_STATE_CONFLICT: ${message}`);
    this.name = "PipelineStateError";
  }
}

const EXECUTION_TRANSITIONS: Readonly<Record<ExecutionStatus, readonly ExecutionStatus[]>> = {
  pending: ["ready", "running", "failed", "interrupted"],
  ready: ["running", "failed", "interrupted"],
  running: ["output_ready", "completed", "failed", "interrupted"],
  output_ready: ["completed", "failed", "interrupted"],
  completed: [],
  failed: [],
  interrupted: [],
};

const VERIFICATION_TRANSITIONS: Readonly<Record<VerificationStatus, readonly VerificationStatus[]>> = {
  not_run: ["pending", "passed", "rejected", "unverified", "not_applicable"],
  pending: ["passed", "rejected", "unverified", "not_applicable"],
  // 复合阶段可能承载多道独立门。后到的拒绝必须能把聚合状态降级，
  // 宁可从“已通过”回到“拒绝/未核实”，也不能继续消费陈旧通过结论。
  passed: ["rejected", "unverified", "not_applicable"],
  rejected: ["passed", "unverified", "not_applicable"],
  unverified: ["passed", "rejected", "not_applicable"],
  not_applicable: [],
};

export function assertExecutionTransition(from: ExecutionStatus, to: ExecutionStatus): void {
  if (from === to) return;
  if (!EXECUTION_TRANSITIONS[from].includes(to)) {
    throw new PipelineStateError(`executionStatus ${from} -> ${to} 不允许`);
  }
}

export function assertVerificationTransition(from: VerificationStatus, to: VerificationStatus): void {
  if (from === to) return;
  if (!VERIFICATION_TRANSITIONS[from].includes(to)) {
    throw new PipelineStateError(`verificationStatus ${from} -> ${to} 不允许`);
  }
}

export function deriveStageDisposition(input: {
  executionStatus: ExecutionStatus;
  verificationStatus: VerificationStatus;
  sideEffect: StageSideEffect;
  hasGate: boolean;
  errorClass?: string | null;
}): StageDisposition {
  const { executionStatus, verificationStatus, sideEffect, hasGate, errorClass } = input;
  if (executionStatus === "interrupted" || executionStatus === "failed") {
    if (/UNKNOWN|TIMEOUT|NETWORK|PROVIDER_TIMEOUT/iu.test(errorClass ?? "")) return "reconcile";
    return sideEffect === "public" || sideEffect === "paid" ? "blocked" : "repair";
  }
  if (verificationStatus === "rejected") return "repair";
  if (verificationStatus === "unverified") return "reconcile";
  if (verificationStatus === "pending") return hasGate ? "wait_human" : "reconcile";
  if (executionStatus === "output_ready" && hasGate && verificationStatus === "not_run") return "wait_human";
  if (executionStatus === "output_ready" && hasGate && ["passed", "not_applicable"].includes(verificationStatus)) return "continue";
  if (executionStatus === "output_ready" && hasGate) return "blocked";
  if (executionStatus === "completed") return "done";
  if (executionStatus === "ready" || executionStatus === "running") return "continue";
  if (executionStatus === "output_ready" && ["passed", "not_applicable"].includes(verificationStatus)) {
    return "continue";
  }
  return "blocked";
}

export function verificationFromDecision(decision: "passed" | "rejected" | "unverified"): VerificationStatus {
  return decision;
}

export function executionFromLegacy(status: "running" | "done" | "failed" | "skipped" | "interrupted"): ExecutionStatus {
  switch (status) {
    case "running":
      return "running";
    case "done":
      return "completed";
    case "failed":
      return "failed";
    case "skipped":
      return "completed";
    case "interrupted":
      return "interrupted";
  }
}

export function legacyFromExecution(status: ExecutionStatus): "running" | "done" | "failed" | "skipped" | "interrupted" {
  switch (status) {
    case "pending":
    case "ready":
    case "running":
      return "running";
    case "output_ready":
    case "completed":
      return "done";
    case "failed":
      return "failed";
    case "interrupted":
      return "interrupted";
  }
}
