import { z } from "zod";

export const PIPELINE_CONTROL_SCHEMA_VERSION = "workloom.pipeline-control/v1" as const;
export const COMPILED_PIPELINE_SCHEMA_VERSION = "workloom.compiled-pipeline/v1" as const;

export const EXECUTION_STATUSES = [
  "pending",
  "ready",
  "running",
  "output_ready",
  "completed",
  "failed",
  "interrupted",
] as const;
export const VERIFICATION_STATUSES = [
  "not_run",
  "pending",
  "passed",
  "rejected",
  "unverified",
  "not_applicable",
] as const;
export const STAGE_DISPOSITIONS = [
  "continue",
  "repair",
  "reconcile",
  "wait_human",
  "blocked",
  "done",
  "stop",
] as const;
export const STAGE_SIDE_EFFECTS = ["none", "local", "paid", "public"] as const;
export const PIPELINE_RUN_STATUSES = ["running", "completed", "partial", "failed", "interrupted"] as const;

export type ExecutionStatus = (typeof EXECUTION_STATUSES)[number];
export type VerificationStatus = (typeof VERIFICATION_STATUSES)[number];
export type StageDisposition = (typeof STAGE_DISPOSITIONS)[number];
export type StageSideEffect = (typeof STAGE_SIDE_EFFECTS)[number];
export type PipelineRunStatus = (typeof PIPELINE_RUN_STATUSES)[number];

const NonEmptyText = z.string().trim().min(1).max(300);
const Sha256 = z.string().regex(/^[a-f0-9]{64}$/, "必须是 64 位小写 SHA-256");

export const ExecutionStatusSchema = z.enum(EXECUTION_STATUSES);
export const VerificationStatusSchema = z.enum(VERIFICATION_STATUSES);
export const StageDispositionSchema = z.enum(STAGE_DISPOSITIONS);
export const StageSideEffectSchema = z.enum(STAGE_SIDE_EFFECTS);
export const PipelineRunStatusSchema = z.enum(PIPELINE_RUN_STATUSES);

export const StageInputContractSchema = z.object({
  role: NonEmptyText,
  schema: NonEmptyText,
  requiredChecks: z.array(NonEmptyText).max(100).default([]),
}).strict();

export const StageOutputContractSchema = z.object({
  role: NonEmptyText,
  schema: NonEmptyText,
  requiredFields: z.array(NonEmptyText).max(500).default([]),
}).strict();

export const StageRepairPolicySchema = z.object({
  classes: z.array(NonEmptyText).max(100).default([]),
  ownerStage: NonEmptyText.nullable().default(null),
  maxAttempts: z.number().int().min(0).max(20).default(0),
  requiresNewInputHash: z.boolean().default(true),
  forbiddenChanges: z.array(NonEmptyText).max(100).default([]),
  onSuccess: z.literal("continue-from-dirty-frontier").default("continue-from-dirty-frontier"),
}).strict();

export const StageVerificationContractSchema = z.object({
  deterministic: z.array(NonEmptyText).max(100).default(["schema"]),
  gate: NonEmptyText.nullable().default(null),
}).strict();

/**
 * 运行期只消费编译后的 StageContract。
 *
 * 旧 YAML 保持兼容：缺少的新字段由 compiler 生成保守、可审计的默认值；
 * adapterId 不允许默认，必须由注册表明确解析，否则编译失败。
 */
export const StageContractSchema = z.object({
  stageKey: NonEmptyText,
  version: z.number().int().positive(),
  owner: NonEmptyText,
  sideEffect: StageSideEffectSchema,
  reversible: z.boolean(),
  inputContract: z.array(StageInputContractSchema).min(1),
  outputContract: z.array(StageOutputContractSchema).min(1),
  verify: StageVerificationContractSchema,
  dependencies: z.array(NonEmptyText),
  invalidates: z.array(NonEmptyText),
  repairPolicy: StageRepairPolicySchema,
  adapterId: NonEmptyText,
  executionStatus: ExecutionStatusSchema.default("pending"),
  verificationStatus: VerificationStatusSchema.default("not_run"),
  disposition: StageDispositionSchema.default("stop"),
}).strict();

export const PipelineEdgeSchema = z.object({
  parent: NonEmptyText,
  child: NonEmptyText,
  inputRole: NonEmptyText,
}).strict();

export const CompiledPipelinePlanSchema = z.object({
  schemaVersion: z.literal(COMPILED_PIPELINE_SCHEMA_VERSION),
  pipelineKey: NonEmptyText,
  name: NonEmptyText,
  version: z.number().int().positive(),
  planHash: Sha256,
  steps: z.array(StageContractSchema).min(1),
  edges: z.array(PipelineEdgeSchema),
  topologicalOrder: z.array(NonEmptyText).min(1),
  sourceDigest: Sha256,
}).strict();

export type StageInputContract = z.infer<typeof StageInputContractSchema>;
export type StageOutputContract = z.infer<typeof StageOutputContractSchema>;
export type StageRepairPolicy = z.infer<typeof StageRepairPolicySchema>;
export type StageContract = z.infer<typeof StageContractSchema>;
export type PipelineEdge = z.infer<typeof PipelineEdgeSchema>;
export type CompiledPipelinePlan = z.infer<typeof CompiledPipelinePlanSchema>;

export const PipelineScopeSchema = z.object({
  tenantId: NonEmptyText,
  workspaceId: NonEmptyText,
}).strict();

export const PipelineStartInputSchema = z.object({
  projectId: NonEmptyText,
  planKey: NonEmptyText,
  factsSnapshotHash: Sha256,
  budgetGrantId: NonEmptyText.nullable().default(null),
  expectedProjectRevision: z.number().int().nonnegative(),
  idempotencyKey: NonEmptyText,
  createdBy: NonEmptyText,
  sourceSystem: NonEmptyText,
  sourceRunId: NonEmptyText,
}).strict();

export const ArtifactEnvelopeSchema = z.object({
  role: NonEmptyText,
  schemaVersion: NonEmptyText,
  ref: NonEmptyText,
  sha256: Sha256,
  logicalHash: Sha256,
  factsSnapshotHash: Sha256,
  contentType: NonEmptyText.default("application/octet-stream"),
}).strict();

export const ArtifactVersionSchema = ArtifactEnvelopeSchema.extend({
  id: NonEmptyText,
  pipelineRunId: NonEmptyText,
  stageRunId: NonEmptyText,
  createdAt: NonEmptyText,
}).strict();

export const GateFindingSchema = z.object({
  code: NonEmptyText,
  severity: z.enum(["P0", "P1", "P2", "advisory"]),
  targetType: z.enum(["run", "stage", "field", "item", "artifact"]),
  targetId: NonEmptyText.nullable().default(null),
  fieldPath: NonEmptyText.nullable().default(null),
  expected: z.unknown().optional(),
  actual: z.unknown().optional(),
  evidenceRefs: z.array(NonEmptyText).max(200).default([]),
  repairClass: z.enum(["schema", "deterministic", "semantic", "human_input", "no_repair"]),
  blocking: z.boolean(),
}).strict();

export const GateDecisionSchema = z.object({
  id: NonEmptyText,
  pipelineRunId: NonEmptyText,
  stageRunId: NonEmptyText,
  gateKey: NonEmptyText,
  checkSetVersion: NonEmptyText,
  artifactManifestHash: Sha256,
  decision: z.enum(["passed", "rejected", "unverified"]),
  actor: NonEmptyText,
  artifactHashes: z.array(Sha256).min(1),
  issues: z.array(NonEmptyText).max(500).default([]),
  suggestions: z.array(NonEmptyText).max(500).default([]),
  findings: z.array(GateFindingSchema).max(500).default([]),
  evidenceHashes: z.array(Sha256).default([]),
  approvalId: NonEmptyText.nullable().default(null),
  expiresAt: NonEmptyText.nullable().default(null),
  createdAt: NonEmptyText,
}).strict();

export type PipelineScope = z.infer<typeof PipelineScopeSchema>;
export type PipelineStartInput = z.infer<typeof PipelineStartInputSchema>;
export type ArtifactEnvelope = z.infer<typeof ArtifactEnvelopeSchema>;
export type ArtifactVersion = z.infer<typeof ArtifactVersionSchema>;
export type GateFinding = z.infer<typeof GateFindingSchema>;
export type GateDecision = z.infer<typeof GateDecisionSchema>;

export interface PipelineRun {
  id: string;
  tenantId: string;
  workspaceId: string;
  projectId: string;
  planKey: string;
  planVersion: number;
  planHash: string;
  plan: CompiledPipelinePlan;
  sourceDigest: string;
  factsSnapshotHash: string;
  status: PipelineRunStatus;
  revision: number;
  currentFrontier: string[];
  budgetGrantId: string | null;
  sourceSystem: string;
  sourceRunId: string;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}

export interface StageRun {
  id: string;
  pipelineRunId: string;
  projectId: string;
  nodeKey: string;
  itemKey: string;
  attempt: number;
  stageContractVersion: number;
  planHash: string;
  factsSnapshotHash: string;
  executionStatus: ExecutionStatus;
  verificationStatus: VerificationStatus;
  disposition: StageDisposition;
  idempotencyKey: string;
  workerTokenHash: string | null;
  inputSha256: string | null;
  contractHash: string | null;
  repairOfStageRunId: string | null;
  outputRef: string | null;
  outputSha256: string | null;
  errorClass: string | null;
  errorMessage: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  revision: number;
  createdAt: string;
  updatedAt: string;
}

export interface PipelineEvent {
  id: string;
  pipelineRunId: string | null;
  stageRunId: string | null;
  kind: string;
  idempotencyKey: string;
  payload: Record<string, unknown>;
  createdAt: string;
}

export interface PipelineCommandReceipt<T = unknown> {
  scope: PipelineScope;
  idempotencyKey: string;
  requestHash: string;
  result: T;
  createdAt: string;
}
