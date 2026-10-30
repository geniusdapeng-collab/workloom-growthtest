import type {
  ArtifactVersion,
  GateDecision,
  PipelineCommandReceipt,
  PipelineEvent,
  PipelineRun,
  PipelineScope,
  StageRun,
} from "./contracts.js";

export class PipelineRepositoryError extends Error {
  constructor(readonly code: string, message: string) {
    super(`${code}: ${message}`);
    this.name = "PipelineRepositoryError";
  }
}

/**
 * 事务内部的窄仓储接口。Coordinator 只能调用这些方法，不接触 SQL、连接池或任意表。
 */
export interface PipelineTransaction {
  lockProject(scope: PipelineScope, projectId: string): Promise<void>;
  getRun(scope: PipelineScope, id: string): Promise<PipelineRun | null>;
  getRunBySource(scope: PipelineScope, sourceSystem: string, sourceRunId: string): Promise<PipelineRun | null>;
  getLatestProjectRun(scope: PipelineScope, projectId: string): Promise<PipelineRun | null>;
  insertRun(run: PipelineRun): Promise<PipelineRun>;
  updateRun(run: PipelineRun, expectedRevision: number): Promise<PipelineRun>;

  getStage(scope: PipelineScope, id: string): Promise<StageRun | null>;
  getLatestStage(scope: PipelineScope, pipelineRunId: string, nodeKey: string, itemKey?: string): Promise<StageRun | null>;
  nextStageAttempt(scope: PipelineScope, projectId: string, nodeKey: string, itemKey?: string): Promise<number>;
  insertStage(stage: StageRun): Promise<StageRun>;
  updateStage(stage: StageRun, expectedRevision: number): Promise<StageRun>;
  listStages(scope: PipelineScope, pipelineRunId: string): Promise<StageRun[]>;

  insertArtifact(artifact: ArtifactVersion): Promise<ArtifactVersion>;
  listArtifacts(scope: PipelineScope, stageRunId: string): Promise<ArtifactVersion[]>;
  insertGateDecision(decision: GateDecision): Promise<GateDecision>;
  listGateDecisions(scope: PipelineScope, stageRunId: string): Promise<GateDecision[]>;
  insertEdge(scope: PipelineScope, edge: {
    pipelineRunId: string;
    parentStageRunId: string;
    childStageRunId: string;
    inputRole: string;
  }): Promise<void>;

  appendEvent(event: PipelineEvent): Promise<PipelineEvent>;
  listEvents(scope: PipelineScope, pipelineRunId: string, afterSequence?: number): Promise<PipelineEvent[]>;

  getCommandReceipt<T = unknown>(
    scope: PipelineScope,
    idempotencyKey: string,
  ): Promise<PipelineCommandReceipt<T> | null>;
  insertCommandReceipt<T = unknown>(receipt: PipelineCommandReceipt<T>): Promise<PipelineCommandReceipt<T>>;
}

/**
 * PostgreSQL 仓储在宿主层实现。所有回调必须在同一个带 RLS 上下文的事务内执行；
 * 任何异常整体回滚，调用方不得把半写状态当成成功。
 */
export interface PipelineRepository {
  transaction<T>(scope: PipelineScope, fn: (tx: PipelineTransaction) => Promise<T>): Promise<T>;
}
