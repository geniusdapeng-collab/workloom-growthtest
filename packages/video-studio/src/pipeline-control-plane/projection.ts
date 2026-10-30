import type {
  ExecutionStatus,
  PipelineEvent,
  PipelineRun,
  StageDisposition,
  VerificationStatus,
} from "./contracts.js";

export interface StageProjection {
  nodeKey: string;
  itemKey: string;
  attempt: number;
  stageRunId: string | null;
  executionStatus: ExecutionStatus;
  verificationStatus: VerificationStatus;
  disposition: StageDisposition;
  artifactIds: string[];
  artifactManifestHash: string | null;
  gateDecisionIds: string[];
  errorClass: string | null;
  updatedAt: string | null;
}

export type PipelineNextAction =
  | "run_node"
  | "wait_approval"
  | "repair"
  | "reconcile"
  | "wait_resource"
  | "manual_fix"
  | "done";

export interface PipelineBlocker {
  nodeKey: string;
  kind: "gate" | "approval" | "repair" | "unknown_operation" | "budget";
  reason: string;
  gateDecisionId?: string;
}

export interface PipelineProjection {
  pipelineRunId: string;
  status: PipelineRun["status"];
  revision: number;
  currentFrontier: string[];
  nextAction: PipelineNextAction;
  blocker: PipelineBlocker | null;
  stages: StageProjection[];
  lastEventAt: string | null;
}

/**
 * 从 append-only 事件重建读模型。投影落后时只能由事件追平，不能反向覆盖权威表。
 * 未知事件保留在原始事件流中，投影器忽略但不会删除。
 */
export function rebuildPipelineProjection(
  run: PipelineRun,
  events: readonly PipelineEvent[],
): PipelineProjection {
  const stages = new Map<string, StageProjection>();
  let status = run.status;
  let frontier = [...run.currentFrontier];
  let lastEventAt: string | null = null;

  for (const event of [...events].sort((left, right) => left.createdAt.localeCompare(right.createdAt))) {
    lastEventAt = event.createdAt;
    const payload = event.payload;
    if (event.kind === "stage.created" && event.stageRunId) {
      const nodeKey = String(payload.nodeKey ?? "");
      if (!nodeKey) continue;
      const itemKey = String(payload.itemKey ?? "");
      const projectionKey = `${nodeKey}\u0000${itemKey}`;
      const previous = stages.get(projectionKey);
      const attempt = Number(payload.attempt ?? 0);
      if (previous && previous.attempt >= attempt) continue;
      stages.set(projectionKey, {
        nodeKey,
        itemKey,
        attempt,
        stageRunId: event.stageRunId,
        executionStatus: "pending",
        verificationStatus: "not_run",
        disposition: "stop",
        artifactIds: [],
        artifactManifestHash: null,
        gateDecisionIds: [],
        errorClass: null,
        updatedAt: event.createdAt,
      });
      continue;
    }
    if (!event.stageRunId) {
      if (event.kind === "pipeline.frontier_changed") {
        if (Array.isArray(payload.currentFrontier)) frontier = payload.currentFrontier.map(String);
        if (typeof payload.status === "string") status = payload.status as PipelineRun["status"];
      }
      continue;
    }
    const stage = [...stages.values()].find((candidate) => candidate.stageRunId === event.stageRunId);
    if (!stage) continue;
    stage.updatedAt = event.createdAt;
    if (event.kind === "stage.started") {
      stage.executionStatus = "running";
      stage.disposition = "continue";
    } else if (event.kind === "artifact.recorded") {
      const id = String(payload.artifactId ?? "");
      if (id && !stage.artifactIds.includes(id)) stage.artifactIds.push(id);
    } else if (event.kind === "stage.output_ready") {
      stage.executionStatus = "output_ready";
      if (typeof payload.artifactManifestHash === "string") {
        stage.artifactManifestHash = payload.artifactManifestHash;
      }
    } else if (event.kind === "gate.requested") {
      stage.verificationStatus = "pending";
      stage.disposition = "wait_human";
    } else if (event.kind === "gate.decided") {
      const id = String(payload.gateDecisionId ?? "");
      if (id && !stage.gateDecisionIds.includes(id)) stage.gateDecisionIds.push(id);
      const decision = payload.decision;
      if (decision === "passed" || decision === "rejected" || decision === "unverified") {
        stage.verificationStatus = decision;
        stage.disposition = decision === "passed" ? "continue" : decision === "rejected" ? "repair" : "reconcile";
      }
    } else if (event.kind === "stage.completed") {
      stage.executionStatus = "completed";
      stage.disposition = "continue";
    } else if (event.kind === "stage.failed") {
      stage.executionStatus = "failed";
      stage.errorClass = typeof payload.errorClass === "string" ? payload.errorClass : null;
      stage.disposition = "repair";
    } else if (event.kind === "stage.interrupted") {
      stage.executionStatus = "interrupted";
      stage.errorClass = typeof payload.errorClass === "string" ? payload.errorClass : null;
      stage.disposition = "reconcile";
    }
  }

  let nextAction: PipelineNextAction;
  let blocker: PipelineBlocker | null = null;
  const frontierStages = [...stages.values()].filter((stage) => frontier.includes(stage.nodeKey));
  const waiting = frontierStages.find((stage) => {
    if (["pending", "ready"].includes(stage.executionStatus) && stage.disposition === "stop") return false;
    return stage.disposition !== "continue";
  });
  if (status === "completed") {
    nextAction = "done";
  } else if (status === "interrupted" || status === "failed" || status === "partial") {
    nextAction = "manual_fix";
  } else if (waiting) {
    if (waiting.disposition === "wait_human") nextAction = "wait_approval";
    else if (waiting.disposition === "repair") nextAction = "repair";
    else if (waiting.disposition === "reconcile") nextAction = "reconcile";
    else nextAction = "manual_fix";
    blocker = {
      nodeKey: waiting.nodeKey,
      kind: waiting.verificationStatus === "rejected"
        ? "repair"
        : waiting.disposition === "wait_human"
          ? "approval"
          : waiting.disposition === "reconcile"
            ? "unknown_operation"
            : "gate",
      reason: waiting.errorClass
        ?? `stage ${waiting.nodeKey} disposition=${waiting.disposition}`,
      ...(waiting.gateDecisionIds.at(-1) ? { gateDecisionId: waiting.gateDecisionIds.at(-1)! } : {}),
    };
  } else if (frontier.length) {
    nextAction = "run_node";
  } else {
    nextAction = status === "running" ? "wait_resource" : "manual_fix";
  }

  return {
    pipelineRunId: run.id,
    status,
    revision: run.revision,
    currentFrontier: frontier,
    nextAction,
    blocker,
    stages: [...stages.values()].sort((left, right) =>
      left.attempt - right.attempt
      || left.nodeKey.localeCompare(right.nodeKey)
      || left.itemKey.localeCompare(right.itemKey)),
    lastEventAt,
  };
}
