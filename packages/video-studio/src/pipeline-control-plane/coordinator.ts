import { createHash, randomUUID } from "node:crypto";
import {
  ArtifactEnvelopeSchema,
  CompiledPipelinePlanSchema,
  GateDecisionSchema,
  PipelineScopeSchema,
  PipelineStartInputSchema,
  StageDispositionSchema,
  type ArtifactEnvelope,
  type ArtifactVersion,
  type CompiledPipelinePlan,
  type ExecutionStatus,
  type GateFinding,
  type GateDecision,
  type PipelineCommandReceipt,
  type PipelineEvent,
  type PipelineRun,
  type PipelineRunStatus,
  type PipelineScope,
  type PipelineStartInput,
  type StageRun,
  type VerificationStatus,
} from "./contracts.js";
import {
  canonicalPipelineJson,
  initialFrontier,
  pipelineSha256,
  stageContractHash,
} from "./compiler.js";
import type { PipelineRepository, PipelineTransaction } from "./repository.js";
import { rebuildPipelineProjection, type PipelineProjection } from "./projection.js";
import {
  PipelineStateError,
  assertExecutionTransition,
  assertVerificationTransition,
  deriveStageDisposition,
} from "./state.js";

export class PipelineCommandError extends Error {
  constructor(readonly code: string, message: string) {
    super(`${code}: ${message}`);
    this.name = "PipelineCommandError";
  }
}

export interface PipelineRuntimeIds {
  runId(): string;
  stageRunId(): string;
  artifactId(): string;
  gateDecisionId(): string;
  eventId(): string;
}

export interface GateAutoApprovalInput {
  gateKey: string;
  checkSetVersion: string;
  artifactHashes: string[];
  artifactManifestHash: string;
  artifacts: ArtifactVersion[];
  run: PipelineRun;
  stage: StageRun;
}

export interface GateAutoApprovalResult {
  decision: "passed" | "rejected" | "unverified";
  actor: string;
  policyVersion: string;
  reason: string;
  issues?: string[];
  suggestions?: string[];
  findings?: GateFinding[];
  evidenceHashes?: string[];
}

export interface PipelineCoordinatorOptions {
  now?: () => string;
  ids?: Partial<PipelineRuntimeIds>;
  resolvePlan?: (planKey: string) => CompiledPipelinePlan | Promise<CompiledPipelinePlan>;
  /**
   * 产品所有者授权的系统审批策略。返回 null 时保持兼容的持久化待审批状态；
   * 返回结果时立即落 GateDecision，不创建 wait_human 状态。
   */
  autoApproveGate?: (
    input: GateAutoApprovalInput,
  ) => Promise<GateAutoApprovalResult | null> | GateAutoApprovalResult | null;
}

function defaultIds(prefix: string): string {
  return `${prefix}-${randomUUID().replace(/-/gu, "").slice(0, 16).toUpperCase()}`;
}

function newStableRequestHash(value: unknown): string {
  return createHash("sha256").update(canonicalPipelineJson(value), "utf8").digest("hex");
}

function stageSatisfied(stage: StageRun): boolean {
  return stage.executionStatus === "completed"
    && !["rejected", "unverified"].includes(stage.verificationStatus);
}

function latestStageItems(stages: readonly StageRun[]): Map<string, Map<string, StageRun>> {
  const grouped = new Map<string, Map<string, StageRun>>();
  for (const stage of stages) {
    const items = grouped.get(stage.nodeKey) ?? new Map<string, StageRun>();
    const previous = items.get(stage.itemKey);
    if (!previous || previous.attempt < stage.attempt) items.set(stage.itemKey, stage);
    grouped.set(stage.nodeKey, items);
  }
  return grouped;
}

function nodeSatisfied(items: Map<string, StageRun> | undefined): boolean {
  return Boolean(items?.size) && [...items!.values()].every(stageSatisfied);
}

function artifactManifestHash(artifacts: readonly ArtifactVersion[]): string {
  return pipelineSha256(artifacts
    .map((artifact) => ({
      id: artifact.id,
      role: artifact.role,
      schemaVersion: artifact.schemaVersion,
      sha256: artifact.sha256,
      logicalHash: artifact.logicalHash,
    }))
    .sort((left, right) => left.id.localeCompare(right.id)));
}

function currentFrontier(plan: CompiledPipelinePlan, stages: readonly StageRun[]): string[] {
  const latest = latestStageItems(stages);
  return plan.topologicalOrder.filter((nodeKey) => {
    if (nodeSatisfied(latest.get(nodeKey))) return false;
    return plan.steps.find((step) => step.stageKey === nodeKey)?.dependencies
      .every((dependency) => nodeSatisfied(latest.get(dependency))) ?? false;
  });
}

function runStatus(stages: readonly StageRun[], hasFailure: boolean, hasInterruption: boolean): PipelineRunStatus {
  if (hasInterruption) return "interrupted";
  if (hasFailure && stages.some(stage => stage.executionStatus === "completed")) return "partial";
  if (hasFailure) return "failed";
  return "running";
}

export class PipelineCoordinator {
  private readonly now: () => string;
  private readonly ids: PipelineRuntimeIds;
  private readonly resolvePlan?: PipelineCoordinatorOptions["resolvePlan"];
  private readonly autoApproveGate?: PipelineCoordinatorOptions["autoApproveGate"];

  constructor(
    private readonly repository: PipelineRepository,
    options: PipelineCoordinatorOptions = {},
  ) {
    this.now = options.now ?? (() => new Date().toISOString());
    this.resolvePlan = options.resolvePlan;
    this.autoApproveGate = options.autoApproveGate;
    this.ids = {
      runId: options.ids?.runId ?? (() => defaultIds("PR")),
      stageRunId: options.ids?.stageRunId ?? (() => defaultIds("SR")),
      artifactId: options.ids?.artifactId ?? (() => defaultIds("AV")),
      gateDecisionId: options.ids?.gateDecisionId ?? (() => defaultIds("GD")),
      eventId: options.ids?.eventId ?? (() => defaultIds("EV")),
    };
  }

  async getRun(scope: PipelineScope, pipelineRunId: string): Promise<PipelineRun | null> {
    return this.repository.transaction(scope, async (tx) => tx.getRun(scope, pipelineRunId));
  }

  async getRunBySource(scope: PipelineScope, sourceSystem: string, sourceRunId: string): Promise<PipelineRun | null> {
    return this.repository.transaction(scope, async (tx) => tx.getRunBySource(scope, sourceSystem, sourceRunId));
  }

  async getProjectRevision(scope: PipelineScope, projectId: string): Promise<number> {
    return this.repository.transaction(scope, async (tx) =>
      (await tx.getLatestProjectRun(scope, projectId))?.revision ?? 0);
  }

  async readProjection(scope: PipelineScope, pipelineRunId: string): Promise<PipelineProjection | null> {
    return this.repository.transaction(scope, async (tx) => {
      const run = await tx.getRun(scope, pipelineRunId);
      if (!run) return null;
      const events = await tx.listEvents(scope, pipelineRunId);
      return rebuildPipelineProjection(run, events);
    });
  }

  async readEvents(scope: PipelineScope, pipelineRunId: string, afterSequence = 0): Promise<PipelineEvent[]> {
    return this.repository.transaction(scope, (tx) => tx.listEvents(scope, pipelineRunId, afterSequence));
  }

  async readArtifacts(scope: PipelineScope, stageRunId: string): Promise<ArtifactVersion[]> {
    return this.repository.transaction(scope, (tx) => tx.listArtifacts(scope, stageRunId));
  }

  async readGateDecisions(scope: PipelineScope, stageRunId: string): Promise<GateDecision[]> {
    return this.repository.transaction(scope, (tx) => tx.listGateDecisions(scope, stageRunId));
  }

  async appendAuditEvent(scope: PipelineScope, input: {
    pipelineRunId: string;
    stageRunId?: string | null;
    kind: string;
    idempotencyKey: string;
    payload: Record<string, unknown>;
  }): Promise<PipelineEvent> {
    return this.repository.transaction(scope, async (tx) => {
      const run = await tx.getRun(scope, input.pipelineRunId);
      if (!run) throw new PipelineCommandError("RUN_NOT_FOUND", input.pipelineRunId);
      if (input.stageRunId) {
        const stage = await tx.getStage(scope, input.stageRunId);
        if (!stage || stage.pipelineRunId !== input.pipelineRunId) {
          throw new PipelineCommandError("STAGE_NOT_FOUND", input.stageRunId);
        }
      }
      return tx.appendEvent(this.event({
        pipelineRunId: input.pipelineRunId,
        stageRunId: input.stageRunId ?? null,
        kind: input.kind,
        idempotencyKey: input.idempotencyKey,
        payload: input.payload,
      }));
    });
  }

  private async idempotent<T>(
    scopeInput: PipelineScope,
    idempotencyKey: string,
    request: unknown,
    fn: (tx: PipelineTransaction) => Promise<T>,
  ): Promise<T> {
    const scope = PipelineScopeSchema.parse(scopeInput);
    if (!idempotencyKey.trim()) throw new PipelineCommandError("IDEMPOTENCY_KEY_REQUIRED", "命令必须提供幂等键");
    const requestHash = newStableRequestHash(request);
    return this.repository.transaction(scope, async (tx) => {
      const prior = await tx.getCommandReceipt<T>(scope, idempotencyKey);
      if (prior) {
        if (prior.requestHash !== requestHash) {
          throw new PipelineCommandError("IDEMPOTENCY_MISMATCH", `幂等键 ${idempotencyKey} 已绑定不同请求`);
        }
        return prior.result;
      }
      const result = await fn(tx);
      await tx.insertCommandReceipt<T>({
        scope,
        idempotencyKey,
        requestHash,
        result,
        createdAt: this.now(),
      });
      return result;
    });
  }

  private event(input: {
    pipelineRunId: string | null;
    stageRunId: string | null;
    kind: string;
    idempotencyKey: string;
    payload: Record<string, unknown>;
  }): PipelineEvent {
    return {
      id: this.ids.eventId(),
      ...input,
      createdAt: this.now(),
    };
  }

  private artifact(pipelineRunId: string, stageRunId: string, envelope: ArtifactEnvelope): ArtifactVersion {
    return {
      id: this.ids.artifactId(),
      pipelineRunId,
      stageRunId,
      ...ArtifactEnvelopeSchema.parse(envelope),
      createdAt: this.now(),
    };
  }

  private async refreshRun(
    tx: PipelineTransaction,
    scope: PipelineScope,
    run: PipelineRun,
  ): Promise<PipelineRun> {
    const stages = await tx.listStages(scope, run.id);
    const frontier = currentFrontier(run.plan, stages);
    const latest = latestStageItems(stages);
    const allTerminal = run.plan.topologicalOrder.every((nodeKey) => {
      const items = latest.get(nodeKey);
      return Boolean(items?.size) && [...items!.values()]
        .every((stage) => ["completed", "failed", "interrupted"].includes(stage.executionStatus));
    });
    const hasFailure = stages.some((stage) => stage.executionStatus === "failed");
    const hasInterruption = stages.some((stage) => stage.executionStatus === "interrupted");
    const status = allTerminal
      ? hasInterruption ? "interrupted" : hasFailure ? "partial" : "completed"
      : run.status === "running"
        ? runStatus(stages, hasFailure, hasInterruption)
        : run.status;
    const updated: PipelineRun = {
      ...run,
      status,
      currentFrontier: frontier,
      revision: run.revision + 1,
      updatedAt: this.now(),
    };
    return tx.updateRun(updated, run.revision);
  }

  async startPipeline(scopeInput: PipelineScope, input: PipelineStartInput): Promise<{
    pipelineRunId: string;
    revision: number;
    reusedSource: boolean;
  }> {
    const scope = PipelineScopeSchema.parse(scopeInput);
    const command = PipelineStartInputSchema.parse(input);
    if (!this.resolvePlan) {
      throw new PipelineCommandError(
        "PLAN_REQUIRED_ON_START",
        "未注入 plan resolver；请调用 startCompiledPipeline 或配置 resolvePlan",
      );
    }
    const plan = CompiledPipelinePlanSchema.parse(await this.resolvePlan(command.planKey));
    return this.startCompiledPipeline(scope, plan, command);
  }

  async startCompiledPipeline(scopeInput: PipelineScope, planInput: CompiledPipelinePlan, input: PipelineStartInput): Promise<{
    pipelineRunId: string;
    revision: number;
    reusedSource: boolean;
  }> {
    const scope = PipelineScopeSchema.parse(scopeInput);
    const plan = CompiledPipelinePlanSchema.parse(planInput);
    const { planHash, ...hashBody } = plan;
    const actualPlanHash = pipelineSha256(hashBody);
    if (actualPlanHash !== planHash) {
      throw new PipelineCommandError("PLAN_HASH_MISMATCH", `expected=${planHash} actual=${actualPlanHash}`);
    }
    const command = PipelineStartInputSchema.parse(input);
    if (command.planKey !== plan.pipelineKey) {
      throw new PipelineCommandError("PLAN_KEY_MISMATCH", `${command.planKey} != ${plan.pipelineKey}`);
    }
    return this.idempotent(scope, command.idempotencyKey, { command, planHash }, async (tx) => {
      await tx.lockProject(scope, command.projectId);
      const existingSource = await tx.getRunBySource(scope, command.sourceSystem, command.sourceRunId);
      if (existingSource) {
        if (existingSource.projectId !== command.projectId || existingSource.planHash !== plan.planHash) {
          throw new PipelineCommandError("SOURCE_RUN_SCOPE_MISMATCH", `${command.sourceSystem}/${command.sourceRunId}`);
        }
        return {
          pipelineRunId: existingSource.id,
          revision: existingSource.revision,
          reusedSource: true,
        };
      }
      const latest = await tx.getLatestProjectRun(scope, command.projectId);
      const actualRevision = latest?.revision ?? 0;
      if (actualRevision !== command.expectedProjectRevision) {
        throw new PipelineCommandError(
          "PROJECT_REVISION_CONFLICT",
          `expected=${command.expectedProjectRevision} actual=${actualRevision}`,
        );
      }
      const now = this.now();
      const runId = this.ids.runId();
      const run: PipelineRun = {
        id: runId,
        tenantId: scope.tenantId,
        workspaceId: scope.workspaceId,
        projectId: command.projectId,
        planKey: plan.pipelineKey,
        planVersion: plan.version,
        planHash: plan.planHash,
        plan,
        sourceDigest: plan.sourceDigest,
        factsSnapshotHash: command.factsSnapshotHash,
        status: "running",
        revision: 1,
        currentFrontier: initialFrontier(plan),
        budgetGrantId: command.budgetGrantId,
        sourceSystem: command.sourceSystem,
        sourceRunId: command.sourceRunId,
        createdBy: command.createdBy,
        createdAt: now,
        updatedAt: now,
      };
      await tx.insertRun(run);
      const stageByNode = new Map<string, StageRun>();
      for (const contract of plan.steps) {
        const attempt = await tx.nextStageAttempt(scope, command.projectId, contract.stageKey, "");
        const stage: StageRun = {
          id: this.ids.stageRunId(),
          pipelineRunId: run.id,
          projectId: command.projectId,
          nodeKey: contract.stageKey,
          itemKey: "",
          attempt,
          stageContractVersion: contract.version,
          planHash: plan.planHash,
          factsSnapshotHash: command.factsSnapshotHash,
          executionStatus: "pending",
          verificationStatus: "not_run",
          disposition: "stop",
          idempotencyKey: `${command.idempotencyKey}:stage:${contract.stageKey}`,
          workerTokenHash: null,
          inputSha256: null,
          contractHash: stageContractHash(contract),
          repairOfStageRunId: null,
          outputRef: null,
          outputSha256: null,
          errorClass: null,
          errorMessage: null,
          startedAt: null,
          finishedAt: null,
          revision: 1,
          createdAt: now,
          updatedAt: now,
        };
        stageByNode.set(contract.stageKey, await tx.insertStage(stage));
        await tx.appendEvent(this.event({
          pipelineRunId: run.id,
          stageRunId: stage.id,
          kind: "stage.created",
          idempotencyKey: `${command.idempotencyKey}:event:stage-created:${contract.stageKey}`,
          payload: { nodeKey: contract.stageKey, itemKey: "", attempt, adapterId: contract.adapterId },
        }));
      }
      for (const edge of plan.edges) {
        const parent = stageByNode.get(edge.parent);
        const child = stageByNode.get(edge.child);
        if (!parent || !child) throw new PipelineCommandError("PLAN_EDGE_NODE_MISSING", `${edge.parent}->${edge.child}`);
        await tx.insertEdge(scope, {
          pipelineRunId: run.id,
          parentStageRunId: parent.id,
          childStageRunId: child.id,
          inputRole: edge.inputRole,
        });
      }
      await tx.appendEvent(this.event({
        pipelineRunId: run.id,
        stageRunId: null,
        kind: "pipeline.started",
        idempotencyKey: `${command.idempotencyKey}:event:pipeline-started`,
        payload: {
          projectId: command.projectId,
          planKey: plan.pipelineKey,
          planHash: plan.planHash,
          sourceSystem: command.sourceSystem,
          sourceRunId: command.sourceRunId,
        },
      }));
      return { pipelineRunId: run.id, revision: run.revision, reusedSource: false };
    });
  }

  async beginStage(scope: PipelineScope, input: {
    pipelineRunId: string;
    nodeKey: string;
    itemKey?: string;
    idempotencyKey: string;
    expectedStageRevision?: number;
    workerTokenHash?: string | null;
    allowUnmetDependencies?: boolean;
  }): Promise<StageRun> {
    return this.idempotent(scope, input.idempotencyKey, { operation: "beginStage", ...input }, async (tx) => {
      let run = await tx.getRun(scope, input.pipelineRunId);
      if (!run) throw new PipelineCommandError("RUN_NOT_FOUND", input.pipelineRunId);
      await tx.lockProject(scope, run.projectId);
      run = await tx.getRun(scope, input.pipelineRunId);
      if (!run) throw new PipelineCommandError("RUN_NOT_FOUND", input.pipelineRunId);
      if (!input.allowUnmetDependencies) {
        const contract = run.plan.steps.find((entry) => entry.stageKey === input.nodeKey);
        if (!contract) throw new PipelineCommandError("STAGE_CONTRACT_NOT_FOUND", input.nodeKey);
        const latest = latestStageItems(await tx.listStages(scope, run.id));
        for (const dependency of contract.dependencies) {
          if (!nodeSatisfied(latest.get(dependency))) {
            throw new PipelineCommandError(
              "STAGE_DEPENDENCY_NOT_READY",
              `${input.nodeKey} 的依赖 ${dependency} 尚未 completed/passed`,
            );
          }
        }
      }
      let stage = await tx.getLatestStage(scope, run.id, input.nodeKey, input.itemKey ?? "");
      if (!stage) throw new PipelineCommandError("STAGE_NOT_FOUND", `${run.id}/${input.nodeKey}`);
      if (input.expectedStageRevision !== undefined && stage.revision !== input.expectedStageRevision) {
        throw new PipelineCommandError("STAGE_REVISION_CONFLICT", `expected=${input.expectedStageRevision} actual=${stage.revision}`);
      }
      if (["running", "output_ready", "completed"].includes(stage.executionStatus)) return stage;
      assertExecutionTransition(stage.executionStatus, "running");
      const now = this.now();
      const updated: StageRun = {
        ...stage,
        executionStatus: "running",
        disposition: "continue",
        workerTokenHash: input.workerTokenHash ?? stage.workerTokenHash,
        startedAt: stage.startedAt ?? now,
        revision: stage.revision + 1,
        updatedAt: now,
      };
      stage = await tx.updateStage(updated, stage.revision);
      await tx.appendEvent(this.event({
        pipelineRunId: run.id,
        stageRunId: stage.id,
        kind: "stage.started",
        idempotencyKey: `${input.idempotencyKey}:event`,
        payload: { nodeKey: stage.nodeKey, itemKey: stage.itemKey, attempt: stage.attempt },
      }));
      return stage;
    });
  }

  async recordStageOutput(scope: PipelineScope, input: {
    pipelineRunId: string;
    nodeKey: string;
    itemKey?: string;
    idempotencyKey: string;
    artifacts: ArtifactEnvelope[];
    inputSha256?: string | null;
  }): Promise<{ stage: StageRun; artifacts: ArtifactVersion[] }> {
    if (!input.artifacts.length) throw new PipelineCommandError("ARTIFACT_REQUIRED", "stage output 至少需要一个产物");
    return this.idempotent(scope, input.idempotencyKey, { operation: "recordStageOutput", ...input }, async (tx) => {
      let run = await tx.getRun(scope, input.pipelineRunId);
      if (!run) throw new PipelineCommandError("RUN_NOT_FOUND", input.pipelineRunId);
      await tx.lockProject(scope, run.projectId);
      run = await tx.getRun(scope, input.pipelineRunId);
      if (!run) throw new PipelineCommandError("RUN_NOT_FOUND", input.pipelineRunId);
      let stage = await tx.getLatestStage(scope, run.id, input.nodeKey, input.itemKey ?? "");
      if (!stage) throw new PipelineCommandError("STAGE_NOT_FOUND", `${run.id}/${input.nodeKey}`);
      if (!["running", "output_ready", "completed"].includes(stage.executionStatus)) {
        throw new PipelineCommandError("STAGE_NOT_RUNNING", `${stage.nodeKey} 当前为 ${stage.executionStatus}`);
      }
      const artifacts = [];
      for (const [index, envelope] of input.artifacts.entries()) {
        const artifact = this.artifact(run.id, stage.id, envelope);
        artifacts.push(await tx.insertArtifact(artifact));
        await tx.appendEvent(this.event({
          pipelineRunId: run.id,
          stageRunId: stage.id,
          kind: "artifact.recorded",
          idempotencyKey: `${input.idempotencyKey}:event:${index}`,
          payload: {
            artifactId: artifact.id,
            role: artifact.role,
            ref: artifact.ref,
            sha256: artifact.sha256,
          },
        }));
      }
      if (stage.executionStatus !== "output_ready" && stage.executionStatus !== "completed") {
        assertExecutionTransition(stage.executionStatus, "output_ready");
        const contract = run.plan.steps.find((entry) => entry.stageKey === stage!.nodeKey);
        if (!contract) throw new PipelineCommandError("STAGE_CONTRACT_NOT_FOUND", stage.nodeKey);
        const updated: StageRun = {
          ...stage,
          executionStatus: "output_ready",
          disposition: deriveStageDisposition({
            executionStatus: "output_ready",
            verificationStatus: stage.verificationStatus,
            sideEffect: contract.sideEffect,
            hasGate: Boolean(contract.verify.gate),
          }),
          inputSha256: input.inputSha256 ?? stage.inputSha256,
          outputRef: artifacts[0]!.ref,
          outputSha256: artifacts[0]!.sha256,
          revision: stage.revision + 1,
          updatedAt: this.now(),
        };
        stage = await tx.updateStage(updated, stage.revision);
      }
      await tx.appendEvent(this.event({
        pipelineRunId: run.id,
        stageRunId: stage.id,
        kind: "stage.output_ready",
        idempotencyKey: `${input.idempotencyKey}:event:output-ready`,
        payload: {
          nodeKey: stage.nodeKey,
          itemKey: stage.itemKey,
          artifacts: artifacts.map((entry) => entry.id),
          artifactManifestHash: artifactManifestHash(await tx.listArtifacts(scope, stage.id)),
        },
      }));
      return { stage, artifacts };
    });
  }

  async recordGateDecision(scope: PipelineScope, input: {
    pipelineRunId: string;
    nodeKey: string;
    itemKey?: string;
    idempotencyKey: string;
    gateKey: string;
    checkSetVersion: string;
    decision: "passed" | "rejected" | "unverified";
    actor: string;
    artifactHashes: string[];
    issues?: string[];
    suggestions?: string[];
    evidenceHashes?: string[];
    findings?: GateFinding[];
    artifactManifestHash?: string;
    approvalId?: string | null;
    expiresAt?: string | null;
  }): Promise<GateDecision> {
    return this.idempotent(scope, input.idempotencyKey, { operation: "recordGateDecision", ...input }, async (tx) => {
      let run = await tx.getRun(scope, input.pipelineRunId);
      if (!run) throw new PipelineCommandError("RUN_NOT_FOUND", input.pipelineRunId);
      await tx.lockProject(scope, run.projectId);
      run = await tx.getRun(scope, input.pipelineRunId);
      if (!run) throw new PipelineCommandError("RUN_NOT_FOUND", input.pipelineRunId);
      const stage = await tx.getLatestStage(scope, run.id, input.nodeKey, input.itemKey ?? "");
      if (!stage) throw new PipelineCommandError("STAGE_NOT_FOUND", `${run.id}/${input.nodeKey}`);
      if (!["output_ready", "completed"].includes(stage.executionStatus)) {
        throw new PipelineCommandError("STAGE_OUTPUT_NOT_READY", `${stage.nodeKey} 当前为 ${stage.executionStatus}`);
      }
      const artifacts = await tx.listArtifacts(scope, stage.id);
      if (!input.artifactHashes.length || input.artifactHashes.some(hash => !artifacts.some(entry => entry.sha256 === hash))) {
        throw new PipelineCommandError("GATE_ARTIFACT_MISMATCH", "门裁决必须绑定当前 StageRun 已登记的产物摘要");
      }
      const boundArtifacts = artifacts.filter((artifact) => input.artifactHashes.includes(artifact.sha256));
      const manifestHash = artifactManifestHash(boundArtifacts);
      if (input.artifactManifestHash && input.artifactManifestHash !== manifestHash) {
        throw new PipelineCommandError(
          "GATE_MANIFEST_MISMATCH",
          `artifact manifest 已变化：expected=${input.artifactManifestHash} actual=${manifestHash}`,
        );
      }
      const verification: VerificationStatus = input.decision;
      assertVerificationTransition(stage.verificationStatus, verification);
      const contract = run.plan.steps.find((entry) => entry.stageKey === stage.nodeKey);
      if (!contract) throw new PipelineCommandError("STAGE_CONTRACT_NOT_FOUND", stage.nodeKey);
      const now = this.now();
      const gate: GateDecision = GateDecisionSchema.parse({
        id: this.ids.gateDecisionId(),
        pipelineRunId: run.id,
        stageRunId: stage.id,
        gateKey: input.gateKey,
        checkSetVersion: input.checkSetVersion,
        artifactManifestHash: manifestHash,
        decision: input.decision,
        actor: input.actor,
        artifactHashes: input.artifactHashes,
        issues: input.issues ?? [],
        suggestions: input.suggestions ?? [],
        findings: input.findings ?? [],
        evidenceHashes: input.evidenceHashes ?? [],
        approvalId: input.approvalId ?? null,
        expiresAt: input.expiresAt ?? null,
        createdAt: now,
      });
      await tx.insertGateDecision(gate);
      const updated: StageRun = {
        ...stage,
        verificationStatus: verification,
        disposition: deriveStageDisposition({
          executionStatus: stage.executionStatus,
          verificationStatus: verification,
          sideEffect: contract.sideEffect,
          hasGate: Boolean(contract.verify.gate),
        }),
        revision: stage.revision + 1,
        updatedAt: now,
      };
      await tx.updateStage(updated, stage.revision);
      await tx.appendEvent(this.event({
        pipelineRunId: run.id,
        stageRunId: stage.id,
        kind: "gate.decided",
        idempotencyKey: `${input.idempotencyKey}:event`,
        payload: { gateDecisionId: gate.id, gateKey: gate.gateKey, decision: gate.decision },
      }));
      return gate;
    });
  }

  async requestGate(scope: PipelineScope, input: {
    pipelineRunId: string;
    nodeKey: string;
    itemKey?: string;
    idempotencyKey: string;
    gateKey: string;
    checkSetVersion: string;
    artifactHashes: string[];
  }): Promise<StageRun> {
    return this.idempotent(scope, input.idempotencyKey, { operation: "requestGate", ...input }, async (tx) => {
      let run = await tx.getRun(scope, input.pipelineRunId);
      if (!run) throw new PipelineCommandError("RUN_NOT_FOUND", input.pipelineRunId);
      await tx.lockProject(scope, run.projectId);
      run = await tx.getRun(scope, input.pipelineRunId);
      if (!run) throw new PipelineCommandError("RUN_NOT_FOUND", input.pipelineRunId);
      const stage = await tx.getLatestStage(scope, run.id, input.nodeKey, input.itemKey ?? "");
      if (!stage) throw new PipelineCommandError("STAGE_NOT_FOUND", `${run.id}/${input.nodeKey}`);
      if (!["output_ready", "completed"].includes(stage.executionStatus)) {
        throw new PipelineCommandError("STAGE_OUTPUT_NOT_READY", `${stage.nodeKey} 当前为 ${stage.executionStatus}`);
      }
      const artifacts = await tx.listArtifacts(scope, stage.id);
      if (!input.artifactHashes.length || input.artifactHashes.some(hash => !artifacts.some(entry => entry.sha256 === hash))) {
        throw new PipelineCommandError("GATE_ARTIFACT_MISMATCH", "门请求必须绑定当前 StageRun 已登记的产物摘要");
      }
      const boundArtifacts = artifacts.filter((artifact) => input.artifactHashes.includes(artifact.sha256));
      const manifestHash = artifactManifestHash(boundArtifacts);
      const autoApproval = this.autoApproveGate
        ? await this.autoApproveGate({
            gateKey: input.gateKey,
            checkSetVersion: input.checkSetVersion,
            artifactHashes: input.artifactHashes,
            artifactManifestHash: manifestHash,
            artifacts: boundArtifacts,
            run,
            stage,
          })
        : null;
      if (autoApproval) {
        const contract = run.plan.steps.find((entry) => entry.stageKey === stage.nodeKey);
        if (!contract) throw new PipelineCommandError("STAGE_CONTRACT_NOT_FOUND", stage.nodeKey);
        assertVerificationTransition(stage.verificationStatus, autoApproval.decision);
        const now = this.now();
        const gate: GateDecision = GateDecisionSchema.parse({
          id: this.ids.gateDecisionId(),
          pipelineRunId: run.id,
          stageRunId: stage.id,
          gateKey: input.gateKey,
          checkSetVersion: input.checkSetVersion,
          artifactManifestHash: manifestHash,
          decision: autoApproval.decision,
          actor: autoApproval.actor,
          artifactHashes: input.artifactHashes,
          issues: autoApproval.issues ?? [],
          suggestions: autoApproval.suggestions ?? [],
          findings: autoApproval.findings ?? [],
          evidenceHashes: autoApproval.evidenceHashes ?? input.artifactHashes,
          approvalId: null,
          expiresAt: null,
          createdAt: now,
        });
        await tx.insertGateDecision(gate);
        const updated: StageRun = {
          ...stage,
          verificationStatus: autoApproval.decision,
          disposition: deriveStageDisposition({
            executionStatus: stage.executionStatus,
            verificationStatus: autoApproval.decision,
            sideEffect: contract.sideEffect,
            hasGate: Boolean(contract.verify.gate),
          }),
          revision: stage.revision + 1,
          updatedAt: now,
        };
        const saved = await tx.updateStage(updated, stage.revision);
        await tx.appendEvent(this.event({
          pipelineRunId: run.id,
          stageRunId: stage.id,
          kind: "gate.auto_approved",
          idempotencyKey: `${input.idempotencyKey}:event`,
          payload: {
            gateDecisionId: gate.id,
            gateKey: gate.gateKey,
            decision: gate.decision,
            actor: gate.actor,
            policyVersion: autoApproval.policyVersion,
            reason: autoApproval.reason,
            artifactManifestHash: manifestHash,
          },
        }));
        return saved;
      }
      if (stage.verificationStatus === "pending") {
        const priorRequest = (await tx.listEvents(scope, run.id)).find((event) =>
          event.stageRunId === stage.id
          && event.kind === "gate.requested"
          && event.payload.gateKey === input.gateKey);
        if (priorRequest?.payload.artifactManifestHash === manifestHash) return stage;
      }
      assertVerificationTransition(stage.verificationStatus, "pending");
      const now = this.now();
      const updated: StageRun = {
        ...stage,
        verificationStatus: "pending",
        disposition: "wait_human",
        revision: stage.revision + 1,
        updatedAt: now,
      };
      const saved = await tx.updateStage(updated, stage.revision);
      await tx.appendEvent(this.event({
        pipelineRunId: run.id,
        stageRunId: stage.id,
        kind: "gate.requested",
        idempotencyKey: `${input.idempotencyKey}:event`,
        payload: {
          gateKey: input.gateKey,
          checkSetVersion: input.checkSetVersion,
          artifactManifestHash: manifestHash,
          artifactHashes: input.artifactHashes,
        },
      }));
      return saved;
    });
  }

  async finishStage(scope: PipelineScope, input: {
    pipelineRunId: string;
    nodeKey: string;
    itemKey?: string;
    idempotencyKey: string;
    status: "completed" | "failed" | "interrupted";
    errorClass?: string | null;
    errorMessage?: string | null;
    skipped?: boolean;
  }): Promise<StageRun> {
    return this.idempotent(scope, input.idempotencyKey, { operation: "finishStage", ...input }, async (tx) => {
      let run = await tx.getRun(scope, input.pipelineRunId);
      if (!run) throw new PipelineCommandError("RUN_NOT_FOUND", input.pipelineRunId);
      await tx.lockProject(scope, run.projectId);
      run = await tx.getRun(scope, input.pipelineRunId);
      if (!run) throw new PipelineCommandError("RUN_NOT_FOUND", input.pipelineRunId);
      let stage = await tx.getLatestStage(scope, run.id, input.nodeKey, input.itemKey ?? "");
      if (!stage) throw new PipelineCommandError("STAGE_NOT_FOUND", `${run.id}/${input.nodeKey}`);
      const stageNodeKey = stage.nodeKey;
      if (["completed", "failed", "interrupted"].includes(stage.executionStatus)) return stage;
      if (input.status === "completed" && !input.skipped && stage.executionStatus !== "output_ready") {
        throw new PipelineCommandError(
          "STAGE_OUTPUT_REQUIRED",
          `${stageNodeKey} 必须先提交 ArtifactVersion 并进入 output_ready，才能 completed`,
        );
      }
      if (!input.skipped) assertExecutionTransition(stage.executionStatus, input.status);
      const contract = run.plan.steps.find((entry) => entry.stageKey === stageNodeKey);
      if (!contract) throw new PipelineCommandError("STAGE_CONTRACT_NOT_FOUND", stageNodeKey);
      const verificationStatus: VerificationStatus = input.skipped
        ? "not_applicable"
        : stage.verificationStatus;
      if (verificationStatus !== stage.verificationStatus) {
        assertVerificationTransition(stage.verificationStatus, verificationStatus);
      }
      const now = this.now();
      const updated: StageRun = {
        ...stage,
        executionStatus: input.status,
        verificationStatus,
        disposition: deriveStageDisposition({
          executionStatus: input.status,
          verificationStatus,
          sideEffect: contract.sideEffect,
          hasGate: Boolean(contract.verify.gate),
          errorClass: input.errorClass,
        }),
        errorClass: input.errorClass ?? null,
        errorMessage: input.errorMessage?.slice(0, 2_000) ?? null,
        finishedAt: now,
        revision: stage.revision + 1,
        updatedAt: now,
      };
      stage = await tx.updateStage(updated, stage.revision);
      await tx.appendEvent(this.event({
        pipelineRunId: run.id,
        stageRunId: stage.id,
        kind: `stage.${input.status}`,
        idempotencyKey: `${input.idempotencyKey}:event`,
        payload: {
          nodeKey: stage.nodeKey,
          itemKey: stage.itemKey,
          attempt: stage.attempt,
          errorClass: stage.errorClass,
        },
      }));
      const refreshed = await this.refreshRun(tx, scope, run);
      await tx.appendEvent(this.event({
        pipelineRunId: run.id,
        stageRunId: stage.id,
        kind: "pipeline.frontier_changed",
        idempotencyKey: `${input.idempotencyKey}:event:frontier`,
        payload: { revision: refreshed.revision, currentFrontier: refreshed.currentFrontier, status: refreshed.status },
      }));
      return stage;
    });
  }

  async resumePipeline(scope: PipelineScope, input: {
    pipelineRunId: string;
    expectedRevision: number;
    idempotencyKey: string;
  }): Promise<PipelineRun> {
    return this.idempotent(scope, input.idempotencyKey, { operation: "resumePipeline", ...input }, async (tx) => {
      let run = await tx.getRun(scope, input.pipelineRunId);
      if (!run) throw new PipelineCommandError("RUN_NOT_FOUND", input.pipelineRunId);
      await tx.lockProject(scope, run.projectId);
      run = await tx.getRun(scope, input.pipelineRunId);
      if (!run) throw new PipelineCommandError("RUN_NOT_FOUND", input.pipelineRunId);
      if (run.revision !== input.expectedRevision) {
        throw new PipelineCommandError("RUN_REVISION_CONFLICT", `expected=${input.expectedRevision} actual=${run.revision}`);
      }
      if (["completed", "partial", "failed", "interrupted"].includes(run.status)) return run;
      const stages = await tx.listStages(scope, run.id);
      const frontier = currentFrontier(run.plan, stages);
      if (!frontier.length) {
        const hasFailure = stages.some((stage) => stage.executionStatus === "failed");
        const hasInterruption = stages.some((stage) => stage.executionStatus === "interrupted");
        const latest = latestStageItems(stages);
        const allTerminal = run.plan.topologicalOrder.every((nodeKey) => {
          const items = latest.get(nodeKey);
          return Boolean(items?.size) && [...items!.values()]
            .every((stage) => ["completed", "failed", "interrupted"].includes(stage.executionStatus));
        });
        if (allTerminal) {
          const status: PipelineRunStatus = hasInterruption ? "interrupted" : hasFailure ? "partial" : "completed";
          const next: PipelineRun = {
            ...run,
            status,
            currentFrontier: [],
            revision: run.revision + 1,
            updatedAt: this.now(),
          };
          return tx.updateRun(next, run.revision);
        }
      }
      const next: PipelineRun = {
        ...run,
        currentFrontier: frontier,
        revision: run.revision + 1,
        updatedAt: this.now(),
      };
      await tx.updateRun(next, run.revision);
      await tx.appendEvent(this.event({
        pipelineRunId: run.id,
        stageRunId: null,
        kind: "pipeline.resumed",
        idempotencyKey: `${input.idempotencyKey}:event`,
        payload: { currentFrontier: frontier, revision: next.revision },
      }));
      return next;
    });
  }

  async interruptPipeline(scope: PipelineScope, input: {
    pipelineRunId: string;
    expectedRevision: number;
    idempotencyKey: string;
    reason: string;
  }): Promise<PipelineRun> {
    return this.idempotent(scope, input.idempotencyKey, { operation: "interruptPipeline", ...input }, async (tx) => {
      let run = await tx.getRun(scope, input.pipelineRunId);
      if (!run) throw new PipelineCommandError("RUN_NOT_FOUND", input.pipelineRunId);
      await tx.lockProject(scope, run.projectId);
      run = await tx.getRun(scope, input.pipelineRunId);
      if (!run) throw new PipelineCommandError("RUN_NOT_FOUND", input.pipelineRunId);
      if (run.revision !== input.expectedRevision) {
        throw new PipelineCommandError("RUN_REVISION_CONFLICT", `expected=${input.expectedRevision} actual=${run.revision}`);
      }
      if (["completed", "partial", "failed", "interrupted"].includes(run.status)) return run;
      const stages = await tx.listStages(scope, run.id);
      const latest = new Map<string, StageRun>();
      for (const stage of stages) {
        const previous = latest.get(stage.nodeKey);
        if (!previous || previous.attempt < stage.attempt) latest.set(stage.nodeKey, stage);
      }
      const now = this.now();
      for (const stage of latest.values()) {
        if (!["running", "ready", "pending"].includes(stage.executionStatus)) continue;
        const updated: StageRun = {
          ...stage,
          executionStatus: "interrupted",
          disposition: "stop",
          errorClass: "PIPELINE_HOST_INTERRUPTED",
          errorMessage: input.reason.slice(0, 2_000),
          finishedAt: now,
          revision: stage.revision + 1,
          updatedAt: now,
        };
        await tx.updateStage(updated, stage.revision);
        await tx.appendEvent(this.event({
          pipelineRunId: run.id,
          stageRunId: stage.id,
          kind: "stage.interrupted",
          idempotencyKey: `${input.idempotencyKey}:stage:${stage.nodeKey}:${stage.id}`,
          payload: {
            nodeKey: stage.nodeKey,
            itemKey: stage.itemKey,
            attempt: stage.attempt,
            reason: input.reason.slice(0, 2_000),
          },
        }));
      }
      const refreshed = await this.refreshRun(tx, scope, run);
      await tx.appendEvent(this.event({
        pipelineRunId: run.id,
        stageRunId: null,
        kind: "pipeline.interrupted",
        idempotencyKey: `${input.idempotencyKey}:event`,
        payload: { reason: input.reason.slice(0, 2_000), revision: refreshed.revision },
      }));
      return refreshed;
    });
  }
}
