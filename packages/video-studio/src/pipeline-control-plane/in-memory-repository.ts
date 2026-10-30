import type {
  ArtifactVersion,
  GateDecision,
  PipelineCommandReceipt,
  PipelineEvent,
  PipelineRun,
  PipelineScope,
  StageRun,
} from "./contracts.js";
import {
  PipelineRepositoryError,
  type PipelineRepository,
  type PipelineTransaction,
} from "./repository.js";

interface MemoryState {
  runs: Map<string, PipelineRun>;
  stages: Map<string, StageRun>;
  artifacts: Map<string, ArtifactVersion>;
  gates: Map<string, GateDecision>;
  edges: Map<string, {
    scope: PipelineScope;
    pipelineRunId: string;
    parentStageRunId: string;
    childStageRunId: string;
    inputRole: string;
  }>;
  events: PipelineEvent[];
  receipts: Map<string, PipelineCommandReceipt>;
}

function emptyState(): MemoryState {
  return {
    runs: new Map(),
    stages: new Map(),
    artifacts: new Map(),
    gates: new Map(),
    edges: new Map(),
    events: [],
    receipts: new Map(),
  };
}

function cloneState(state: MemoryState): MemoryState {
  return {
    runs: new Map([...state.runs].map(([key, value]) => [key, structuredClone(value)])),
    stages: new Map([...state.stages].map(([key, value]) => [key, structuredClone(value)])),
    artifacts: new Map([...state.artifacts].map(([key, value]) => [key, structuredClone(value)])),
    gates: new Map([...state.gates].map(([key, value]) => [key, structuredClone(value)])),
    edges: new Map([...state.edges].map(([key, value]) => [key, structuredClone(value)])),
    events: structuredClone(state.events),
    receipts: new Map([...state.receipts].map(([key, value]) => [key, structuredClone(value)])),
  };
}

function sameScope(left: PipelineScope, right: PipelineScope): boolean {
  return left.tenantId === right.tenantId && left.workspaceId === right.workspaceId;
}

function receiptKey(scope: PipelineScope, idempotencyKey: string): string {
  return `${scope.tenantId}\u0000${scope.workspaceId}\u0000${idempotencyKey}`;
}

class MemoryTransaction implements PipelineTransaction {
  constructor(private readonly state: MemoryState) {}

  async lockProject(_scope: PipelineScope, _projectId: string): Promise<void> {}

  async getRun(scope: PipelineScope, id: string): Promise<PipelineRun | null> {
    const run = this.state.runs.get(id);
    return run && sameScope(run, scope) ? structuredClone(run) : null;
  }

  async getRunBySource(scope: PipelineScope, sourceSystem: string, sourceRunId: string): Promise<PipelineRun | null> {
    return structuredClone([...this.state.runs.values()].find((run) =>
      sameScope(run, scope) && run.sourceSystem === sourceSystem && run.sourceRunId === sourceRunId) ?? null);
  }

  async getLatestProjectRun(scope: PipelineScope, projectId: string): Promise<PipelineRun | null> {
    return structuredClone([...this.state.runs.values()]
      .filter((run) => sameScope(run, scope) && run.projectId === projectId)
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt))[0] ?? null);
  }

  async insertRun(run: PipelineRun): Promise<PipelineRun> {
    if (this.state.runs.has(run.id)) throw new PipelineRepositoryError("RUN_EXISTS", run.id);
    const sourceDuplicate = [...this.state.runs.values()].find((candidate) =>
      sameScope(candidate, run)
      && candidate.sourceSystem === run.sourceSystem
      && candidate.sourceRunId === run.sourceRunId);
    if (sourceDuplicate) throw new PipelineRepositoryError("RUN_SOURCE_EXISTS", `${run.sourceSystem}/${run.sourceRunId}`);
    this.state.runs.set(run.id, structuredClone(run));
    return structuredClone(run);
  }

  async updateRun(run: PipelineRun, expectedRevision: number): Promise<PipelineRun> {
    const current = this.state.runs.get(run.id);
    if (!current || !sameScope(current, run)) throw new PipelineRepositoryError("RUN_NOT_FOUND", run.id);
    if (current.revision !== expectedRevision || run.revision !== expectedRevision + 1) {
      throw new PipelineRepositoryError("RUN_REVISION_CONFLICT", `${run.id} expected=${expectedRevision} actual=${current.revision}`);
    }
    this.state.runs.set(run.id, structuredClone(run));
    return structuredClone(run);
  }

  async getStage(scope: PipelineScope, id: string): Promise<StageRun | null> {
    const stage = this.state.stages.get(id);
    if (!stage) return null;
    const run = this.state.runs.get(stage.pipelineRunId);
    return run && sameScope(run, scope) ? structuredClone(stage) : null;
  }

  async getLatestStage(scope: PipelineScope, pipelineRunId: string, nodeKey: string, itemKey = ""): Promise<StageRun | null> {
    const run = this.state.runs.get(pipelineRunId);
    if (!run || !sameScope(run, scope)) return null;
    return structuredClone([...this.state.stages.values()]
      .filter((stage) => stage.pipelineRunId === pipelineRunId && stage.nodeKey === nodeKey && stage.itemKey === itemKey)
      .sort((left, right) => right.attempt - left.attempt)[0] ?? null);
  }

  async nextStageAttempt(scope: PipelineScope, projectId: string, nodeKey: string, itemKey = ""): Promise<number> {
    const runIds = new Set([...this.state.runs.values()]
      .filter((run) => sameScope(run, scope) && run.projectId === projectId)
      .map((run) => run.id));
    const attempts = [...this.state.stages.values()]
      .filter((stage) => runIds.has(stage.pipelineRunId) && stage.nodeKey === nodeKey && stage.itemKey === itemKey)
      .map((stage) => stage.attempt);
    return attempts.length ? Math.max(...attempts) + 1 : 1;
  }

  async insertStage(stage: StageRun): Promise<StageRun> {
    const run = this.state.runs.get(stage.pipelineRunId);
    if (!run) throw new PipelineRepositoryError("RUN_NOT_FOUND", stage.pipelineRunId);
    const duplicate = [...this.state.stages.values()].find((candidate) =>
      candidate.pipelineRunId === stage.pipelineRunId
      && candidate.nodeKey === stage.nodeKey
      && candidate.itemKey === stage.itemKey
      && candidate.attempt === stage.attempt);
    if (duplicate) throw new PipelineRepositoryError("STAGE_ATTEMPT_EXISTS", `${stage.nodeKey}/${stage.attempt}`);
    this.state.stages.set(stage.id, structuredClone(stage));
    return structuredClone(stage);
  }

  async updateStage(stage: StageRun, expectedRevision: number): Promise<StageRun> {
    const current = this.state.stages.get(stage.id);
    if (!current) throw new PipelineRepositoryError("STAGE_NOT_FOUND", stage.id);
    if (current.revision !== expectedRevision || stage.revision !== expectedRevision + 1) {
      throw new PipelineRepositoryError("STAGE_REVISION_CONFLICT", `${stage.id} expected=${expectedRevision} actual=${current.revision}`);
    }
    this.state.stages.set(stage.id, structuredClone(stage));
    return structuredClone(stage);
  }

  async listStages(scope: PipelineScope, pipelineRunId: string): Promise<StageRun[]> {
    const run = this.state.runs.get(pipelineRunId);
    if (!run || !sameScope(run, scope)) return [];
    return structuredClone([...this.state.stages.values()]
      .filter((stage) => stage.pipelineRunId === pipelineRunId)
      .sort((left, right) => left.attempt - right.attempt || left.nodeKey.localeCompare(right.nodeKey)));
  }

  async insertArtifact(artifact: ArtifactVersion): Promise<ArtifactVersion> {
    if (this.state.artifacts.has(artifact.id)) throw new PipelineRepositoryError("ARTIFACT_EXISTS", artifact.id);
    this.state.artifacts.set(artifact.id, structuredClone(artifact));
    return structuredClone(artifact);
  }

  async listArtifacts(scope: PipelineScope, stageRunId: string): Promise<ArtifactVersion[]> {
    const stage = await this.getStage(scope, stageRunId);
    if (!stage) return [];
    return structuredClone([...this.state.artifacts.values()]
      .filter((artifact) => artifact.stageRunId === stageRunId)
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt)));
  }

  async insertGateDecision(decision: GateDecision): Promise<GateDecision> {
    if (this.state.gates.has(decision.id)) throw new PipelineRepositoryError("GATE_EXISTS", decision.id);
    this.state.gates.set(decision.id, structuredClone(decision));
    return structuredClone(decision);
  }

  async listGateDecisions(scope: PipelineScope, stageRunId: string): Promise<GateDecision[]> {
    const stage = await this.getStage(scope, stageRunId);
    if (!stage) return [];
    return structuredClone([...this.state.gates.values()]
      .filter((decision) => decision.stageRunId === stageRunId)
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt)));
  }

  async insertEdge(scope: PipelineScope, edge: {
    pipelineRunId: string;
    parentStageRunId: string;
    childStageRunId: string;
    inputRole: string;
  }): Promise<void> {
    const run = this.state.runs.get(edge.pipelineRunId);
    if (!run || !sameScope(run, scope)) throw new PipelineRepositoryError("RUN_NOT_FOUND", edge.pipelineRunId);
    const key = [edge.pipelineRunId, edge.parentStageRunId, edge.childStageRunId, edge.inputRole].join("\u0000");
    if (!this.state.edges.has(key)) this.state.edges.set(key, { scope, ...structuredClone(edge) });
  }

  async appendEvent(event: PipelineEvent): Promise<PipelineEvent> {
    const eventRun = event.pipelineRunId ? this.state.runs.get(event.pipelineRunId) : undefined;
    const existing = this.state.events.find((candidate) =>
      candidate.idempotencyKey === event.idempotencyKey
      && ((!eventRun && !candidate.pipelineRunId)
        || (eventRun && candidate.pipelineRunId
          && sameScope(eventRun, this.state.runs.get(candidate.pipelineRunId) ?? eventRun))));
    if (existing) {
      return structuredClone(existing);
    }
    this.state.events.push(structuredClone(event));
    return structuredClone(event);
  }

  async listEvents(scope: PipelineScope, pipelineRunId: string, afterSequence = 0): Promise<PipelineEvent[]> {
    const run = this.state.runs.get(pipelineRunId);
    if (!run || !sameScope(run, scope)) return [];
    return structuredClone(this.state.events
      .filter((event) => event.pipelineRunId === pipelineRunId)
      .slice(Math.max(0, afterSequence)));
  }

  async getCommandReceipt<T = unknown>(
    scope: PipelineScope,
    idempotencyKey: string,
  ): Promise<PipelineCommandReceipt<T> | null> {
    return structuredClone(
      this.state.receipts.get(receiptKey(scope, idempotencyKey)) as PipelineCommandReceipt<T> | undefined,
    ) ?? null;
  }

  async insertCommandReceipt<T = unknown>(receipt: PipelineCommandReceipt<T>): Promise<PipelineCommandReceipt<T>> {
    const key = receiptKey(receipt.scope, receipt.idempotencyKey);
    const existing = this.state.receipts.get(key);
    if (existing) {
      if (existing.requestHash !== receipt.requestHash) {
        throw new PipelineRepositoryError("IDEMPOTENCY_MISMATCH", receipt.idempotencyKey);
      }
      return structuredClone(existing as PipelineCommandReceipt<T>);
    }
    this.state.receipts.set(key, structuredClone(receipt) as PipelineCommandReceipt);
    return structuredClone(receipt);
  }
}

/**
 * 仅用于纯单元测试与本地装配验证。生产持久化必须使用宿主 PostgreSQL 仓储。
 */
export class InMemoryPipelineRepository implements PipelineRepository {
  private state = emptyState();

  async transaction<T>(_scope: PipelineScope, fn: (tx: PipelineTransaction) => Promise<T>): Promise<T> {
    const working = cloneState(this.state);
    try {
      const result = await fn(new MemoryTransaction(working));
      this.state = working;
      return result;
    } catch (error) {
      throw error;
    }
  }
}
