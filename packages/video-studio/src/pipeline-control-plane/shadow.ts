import {
  PipelineRunStatusSchema,
  type ArtifactEnvelope,
  type ArtifactVersion,
  type CompiledPipelinePlan,
  type GateFinding,
  type PipelineRun,
  type PipelineScope,
  type StageRun,
} from "./contracts.js";
import { pipelineSha256 } from "./compiler.js";
import { PipelineCoordinator, PipelineCommandError } from "./coordinator.js";

export interface ShadowPipelineStart {
  scope: PipelineScope;
  projectId: string;
  plan: CompiledPipelinePlan;
  factsSnapshotHash: string;
  sourceSystem: string;
  sourceRunId: string;
  createdBy: string;
  idempotencyKey: string;
}

export interface ShadowStageObservation {
  observationId: string;
  nodeKey: string;
  itemKey?: string;
}

export interface ShadowStageOutput extends ShadowStageObservation {
  artifacts: ArtifactEnvelope[];
  inputSha256?: string | null;
}

export interface ShadowGateResult {
  observationId: string;
  nodeKey?: string;
  itemKey?: string;
  gateKey: string;
  decision: "passed" | "rejected" | "unverified";
  actor: string;
  checkSetVersion: string;
  content: string;
  issues?: string[];
  suggestions?: string[];
  findings?: GateFinding[];
  evidenceHashes?: string[];
  approvalId?: string | null;
  expiresAt?: string | null;
}

export interface ShadowStageFinish extends ShadowStageObservation {
  status: "completed" | "failed" | "interrupted";
  skipped?: boolean;
  errorClass?: string | null;
  errorMessage?: string | null;
}

function contentArtifact(content: string, factsSnapshotHash: string): ArtifactEnvelope {
  const sha256 = pipelineSha256(content);
  return {
    role: "gate-content",
    schemaVersion: "workloom.gate-content/v1",
    ref: `gate-content/sha256/${sha256}.txt`,
    sha256,
    logicalHash: sha256,
    factsSnapshotHash,
    contentType: "text/plain; charset=utf-8",
  };
}

/**
 * 影子会话只观察现有执行器，不启动或停止媒体任务。
 *
 * - 第一个观察事件惰性建立 PipelineRun；
 * - 每个事件使用自身幂等键；
 * - gate 内容作为内容寻址证据绑定 GateDecision；
 * - 所有状态由 Coordinator 推进，调用方不得直接写状态。
 */
export class PipelineShadowSession {
  private runPromise: Promise<PipelineRun> | null = null;

  constructor(
    private readonly coordinator: PipelineCoordinator,
    private readonly input: ShadowPipelineStart,
  ) {
    const keys = input.plan.steps.map((step) => step.stageKey);
    if (new Set(keys).size !== keys.length) throw new PipelineCommandError("PLAN_STEP_DUPLICATE", "影子计划步骤重复");
  }

  private async ensureRun(): Promise<PipelineRun> {
    if (!this.runPromise) {
      this.runPromise = (async () => {
        const existing = await this.coordinator.getRunBySource(
          this.input.scope,
          this.input.sourceSystem,
          this.input.sourceRunId,
        );
        if (existing) return existing;
        const expected = await this.coordinator.getProjectRevision(this.input.scope, this.input.projectId);
        try {
          const result = await this.coordinator.startCompiledPipeline(this.input.scope, this.input.plan, {
            projectId: this.input.projectId,
            planKey: this.input.plan.pipelineKey,
            factsSnapshotHash: this.input.factsSnapshotHash,
            budgetGrantId: null,
            expectedProjectRevision: expected,
            idempotencyKey: `${this.input.idempotencyKey}:start`,
            createdBy: this.input.createdBy,
            sourceSystem: this.input.sourceSystem,
            sourceRunId: this.input.sourceRunId,
          });
          const run = await this.coordinator.getRun(this.input.scope, result.pipelineRunId);
          if (!run) throw new PipelineCommandError("RUN_NOT_FOUND_AFTER_START", result.pipelineRunId);
          return run;
        } catch (error) {
          if (!(error instanceof PipelineCommandError) || error.code !== "PROJECT_REVISION_CONFLICT") throw error;
          const latest = await this.coordinator.getProjectRevision(this.input.scope, this.input.projectId);
          const result = await this.coordinator.startCompiledPipeline(this.input.scope, this.input.plan, {
            projectId: this.input.projectId,
            planKey: this.input.plan.pipelineKey,
            factsSnapshotHash: this.input.factsSnapshotHash,
            budgetGrantId: null,
            expectedProjectRevision: latest,
            idempotencyKey: `${this.input.idempotencyKey}:start:retry`,
            createdBy: this.input.createdBy,
            sourceSystem: this.input.sourceSystem,
            sourceRunId: this.input.sourceRunId,
          });
          const run = await this.coordinator.getRun(this.input.scope, result.pipelineRunId);
          if (!run) throw new PipelineCommandError("RUN_NOT_FOUND_AFTER_START", result.pipelineRunId);
          return run;
        }
      })();
    }
    return this.runPromise;
  }

  async start(): Promise<PipelineRun> {
    return this.ensureRun();
  }

  nodeForGate(gateKey: string): string | null {
    const declared = this.input.plan.steps.find((step) => step.verify.gate === gateKey)?.stageKey;
    if (declared) return declared;
    // marketing-film 把 narrative 后半段折叠为 production/render 两个复合节点；
    // 内部发生的 G5/G6/G7/G8 仍必须绑定到这两个真实复合阶段，不能丢失门证据。
    if (this.input.plan.pipelineKey === "marketing-film") {
      if (["G5", "G6", "G7"].includes(gateKey)) return "production";
      if (gateKey === "G8") return "render";
    }
    return null;
  }

  private nodeExists(nodeKey: string): boolean {
    return this.input.plan.steps.some((step) => step.stageKey === nodeKey);
  }

  async stageStarted(observation: ShadowStageObservation): Promise<StageRun> {
    if (!this.nodeExists(observation.nodeKey)) {
      throw new PipelineCommandError("SHADOW_NODE_UNKNOWN", `${this.input.plan.pipelineKey}/${observation.nodeKey}`);
    }
    const run = await this.ensureRun();
    return this.coordinator.beginStage(this.input.scope, {
      pipelineRunId: run.id,
      nodeKey: observation.nodeKey,
      itemKey: observation.itemKey ?? "",
      idempotencyKey: `${this.input.idempotencyKey}:begin:${observation.observationId}`,
      allowUnmetDependencies: true,
    });
  }

  async stageOutput(observation: ShadowStageOutput): Promise<{ stage: StageRun; artifacts: ArtifactVersion[] }> {
    if (!this.nodeExists(observation.nodeKey)) {
      throw new PipelineCommandError("SHADOW_NODE_UNKNOWN", `${this.input.plan.pipelineKey}/${observation.nodeKey}`);
    }
    const run = await this.ensureRun();
    const result = await this.coordinator.recordStageOutput(this.input.scope, {
      pipelineRunId: run.id,
      nodeKey: observation.nodeKey,
      itemKey: observation.itemKey ?? "",
      idempotencyKey: `${this.input.idempotencyKey}:output:${observation.observationId}`,
      artifacts: observation.artifacts,
      inputSha256: observation.inputSha256 ?? null,
    });
    return result;
  }

  async gateResolved(observation: ShadowGateResult): Promise<void> {
    const declared = this.input.plan.steps.find((step) => step.verify.gate === observation.gateKey)?.stageKey ?? null;
    const nodeKey = observation.nodeKey ?? declared ?? this.nodeForGate(observation.gateKey);
    if (!nodeKey) {
      throw new PipelineCommandError("SHADOW_GATE_UNKNOWN", `${this.input.plan.pipelineKey}/${observation.gateKey}`);
    }
    const run = await this.ensureRun();
    const artifact = contentArtifact(observation.content, this.input.factsSnapshotHash);
    await this.coordinator.beginStage(this.input.scope, {
      pipelineRunId: run.id,
      nodeKey,
      itemKey: observation.itemKey ?? "",
      idempotencyKey: `${this.input.idempotencyKey}:gate-begin:${observation.observationId}`,
      allowUnmetDependencies: true,
    });
    await this.coordinator.recordStageOutput(this.input.scope, {
      pipelineRunId: run.id,
      nodeKey,
      itemKey: observation.itemKey ?? "",
      idempotencyKey: `${this.input.idempotencyKey}:gate-evidence:${observation.observationId}`,
      artifacts: [artifact],
    });
    await this.coordinator.recordGateDecision(this.input.scope, {
      pipelineRunId: run.id,
      nodeKey,
      itemKey: observation.itemKey ?? "",
      idempotencyKey: `${this.input.idempotencyKey}:gate-decision:${observation.observationId}`,
      gateKey: observation.gateKey,
      checkSetVersion: observation.checkSetVersion,
      decision: observation.decision,
      actor: observation.actor,
      artifactHashes: [artifact.sha256],
      issues: observation.issues,
      suggestions: observation.suggestions,
      findings: observation.findings,
      evidenceHashes: observation.evidenceHashes,
      approvalId: observation.approvalId,
      expiresAt: observation.expiresAt,
    });
    const compositeMarketingGate = this.input.plan.pipelineKey === "marketing-film"
      && !declared
      && ["G5", "G6", "G7"].includes(observation.gateKey);
    const shouldFinish = !compositeMarketingGate || observation.gateKey === "G7" || observation.decision !== "passed";
    if (observation.decision === "passed" && shouldFinish) {
      await this.coordinator.finishStage(this.input.scope, {
        pipelineRunId: run.id,
        nodeKey,
        itemKey: observation.itemKey ?? "",
        idempotencyKey: `${this.input.idempotencyKey}:gate-finish:${observation.observationId}`,
        status: "completed",
      });
    } else if (observation.decision === "rejected") {
      await this.coordinator.finishStage(this.input.scope, {
        pipelineRunId: run.id,
        nodeKey,
        itemKey: observation.itemKey ?? "",
        idempotencyKey: `${this.input.idempotencyKey}:gate-finish:${observation.observationId}`,
        status: "failed",
        errorClass: "GATE_REJECTED",
        errorMessage: observation.issues?.join("; ") ?? "gate rejected",
      });
    }
  }

  async stageFinished(observation: ShadowStageFinish): Promise<StageRun> {
    if (!this.nodeExists(observation.nodeKey)) {
      throw new PipelineCommandError("SHADOW_NODE_UNKNOWN", `${this.input.plan.pipelineKey}/${observation.nodeKey}`);
    }
    const run = await this.ensureRun();
    const current = await this.coordinator.getRun(this.input.scope, run.id);
    if (!current) throw new PipelineCommandError("RUN_NOT_FOUND", run.id);
    return this.coordinator.finishStage(this.input.scope, {
      pipelineRunId: run.id,
      nodeKey: observation.nodeKey,
      itemKey: observation.itemKey ?? "",
      idempotencyKey: `${this.input.idempotencyKey}:finish:${observation.observationId}`,
      status: observation.status,
      skipped: observation.skipped,
      errorClass: observation.errorClass,
      errorMessage: observation.errorMessage,
    });
  }

  async runEvent(input: {
    observationId: string;
    kind: string;
    payload: Record<string, unknown>;
  }): Promise<void> {
    const run = await this.ensureRun();
    await this.coordinator.appendAuditEvent(this.input.scope, {
      pipelineRunId: run.id,
      kind: input.kind,
      idempotencyKey: `${this.input.idempotencyKey}:run-event:${input.observationId}`,
      payload: input.payload,
    });
  }

  async runState(): Promise<PipelineRun> {
    const run = await this.ensureRun();
    const current = await this.coordinator.getRun(this.input.scope, run.id);
    if (!current) throw new PipelineCommandError("RUN_NOT_FOUND", run.id);
    PipelineRunStatusSchema.parse(current.status);
    return current;
  }
}

export interface StageAdapterDescriptor {
  id: string;
  pipelineKeys: readonly string[];
  sourceSystems: readonly string[];
}

export const PRODUCTION_STAGE_ADAPTERS: readonly StageAdapterDescriptor[] = [
  {
    id: "vendor-preproduction",
    pipelineKeys: ["narrative-film", "marketing-film"],
    sourceSystems: ["studio-worker"],
  },
  {
    id: "render-post",
    pipelineKeys: ["narrative-film", "marketing-film"],
    sourceSystems: ["film-worker", "render-poller", "delivery-revision"],
  },
  {
    id: "explainer",
    pipelineKeys: ["explainer-film"],
    sourceSystems: ["explainer-pipeline"],
  },
  {
    id: "whiteboard",
    pipelineKeys: ["whiteboard"],
    sourceSystems: ["whiteboard"],
  },
  {
    id: "operations",
    pipelineKeys: ["account-ops", "ads-creative-factory", "settlement-recon"],
    sourceSystems: ["account-ops", "ads-creative-factory", "settlement-recon"],
  },
];
