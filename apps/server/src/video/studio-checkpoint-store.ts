import path from "node:path";
import { constants } from "node:fs";
import { open, realpath } from "node:fs/promises";
import { gatewayAppend } from "@workloom/base/workdata";
import { getGatewayPool } from "@workloom/db";
import type { ArchiveStore, ProducerVerdict, StudioCheckpointAdapter, StudioCheckpointRequest, StudioEngineCheckpoint } from "@hyperreality/video-studio";
import { scopedRows } from "./archive-host.js";
import { canonicalRenderJson, renderSha256 } from "./gen/compiled-request.js";

interface Scope { tenantId: string; workspaceId: string }
export interface StudioAttemptIdentity extends Scope {
  projectId: string;
  projectCreatedAt: string | null;
  stageId: "preproduction" | "prompt_review";
  runId: string;
  attempt: number;
  inputSha256: string;
  model: string;
}
interface CheckpointRecord {
  schemaVersion: "workloom.studio-checkpoint-store/v1";
  identity: StudioAttemptIdentity;
  kind: string;
  payload: unknown;
  originRunId: string;
}
interface CheckpointPointer { ref: string; sha256: string; kind: string; runId: string }
interface SavedGate {
  contentSha256: string;
  engineOutputSha256ByStage: Record<string, string>;
  verdict: ProducerVerdict;
  reviewEventId: string;
  originRunId: string;
}
export interface StudioProductionRejection<T = unknown> {
  key: string;
  review: T;
  gateContentSha256: string;
  engineOutputSha256ByStage: Record<string, string>;
  originRunId: string;
}
export interface StudioCheckpointRepository {
  readPointers(kind: string, runId: string): Promise<CheckpointPointer[]>;
  append(action: string, after: Record<string, unknown>): Promise<void>;
}

const sha = (value: unknown): value is string => typeof value === "string" && /^[a-f0-9]{64}$/u.test(value);
const stageGate: Record<string, string> = { G2_THEME: "G2_THEME", G3_INSIGHT: "G3_INSIGHT", G3_PROFILE: "G3_INSIGHT",
  G4_PRD: "G4_PRD", PRODUCTION: "G6_PROMPT", OPENING_TITLE: "G6_PROMPT",
  MARKETING: "G1_DOSSIER" };

export function studioCheckpointRepository(scope: Scope, projectId: string): StudioCheckpointRepository {
  return {
    readPointers: (kind, runId) => scopedRows<CheckpointPointer>(scope,
      `SELECT payload->'decision'->'after'->>'ref' AS ref,
        payload->'decision'->'after'->>'sha256' AS sha256,
        payload->'decision'->'after'->>'kind' AS kind,
        payload->'decision'->'after'->>'runId' AS "runId"
       FROM biz_events WHERE workspace_id=$1 AND tenant_id=$2
        AND payload->'object'->>'id'=$3
        AND payload->'decision'->>'action'='video.studio.checkpoint.saved'
        AND payload->'decision'->'after'->>'kind'=$4
        AND payload->'decision'->'after'->>'runId'=$5
       ORDER BY created_at DESC, event_id DESC`,
      [scope.workspaceId, scope.tenantId, projectId, kind, runId]),
    append: async (action, after) => {
      const actor = { type: "system" as const, id: "video-studio" };
      await gatewayAppend(getGatewayPool(), { ...scope, actor }, {
        who: actor,
        context: { tenant_id: scope.tenantId, workspace_id: scope.workspaceId, time: new Date().toISOString(), channel: "inapp" },
        object: { type: "video_project", id: projectId },
        decision: { action, after, basis: ["同一项目冻结输入、原始模型证据和已完成工位的持久接续"] },
        rule_impact: [],
      });
    },
  };
}

/** File bytes and their database event must agree before any cached model result is used. */
async function readRecord(archive: ArchiveStore, pointer: CheckpointPointer): Promise<CheckpointRecord> {
  const file = path.resolve(archive.root, pointer.ref);
  if (!pointer.ref || path.isAbsolute(pointer.ref) || !file.startsWith(archive.root + path.sep)
    || pointer.ref.split(/[\\/]/u).some(part => part === "." || part === "..") || !sha(pointer.sha256)
    || await realpath(file) !== file) throw new Error("STUDIO_CHECKPOINT_INVALID: 断点路径或文件身份不一致");
  const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size < 1 || stat.size > 32 * 1024 * 1024) throw new Error("STUDIO_CHECKPOINT_INVALID: 断点文件无效");
    const bytes = await handle.readFile();
    if (renderSha256(bytes) !== pointer.sha256) throw new Error("STUDIO_CHECKPOINT_INVALID: 断点字节与事件摘要不一致");
    return JSON.parse(bytes.toString("utf8")) as CheckpointRecord;
  } finally { await handle.close(); }
}

function sameTask(actual: StudioAttemptIdentity, expected: StudioAttemptIdentity): boolean {
  return actual.tenantId === expected.tenantId && actual.workspaceId === expected.workspaceId
    && actual.projectId === expected.projectId && actual.projectCreatedAt === expected.projectCreatedAt
    && actual.stageId === expected.stageId && actual.inputSha256 === expected.inputSha256 && actual.model === expected.model;
}

function reviewed(gate: SavedGate): boolean {
  const verdict = gate.verdict;
  return sha(gate.contentSha256) && verdict?.approved === true && verdict.status === "passed" && verdict.via === "llm" && verdict.unknownOutcome !== true
    && verdict.degraded === false && Boolean(verdict.model) && Boolean(gate.reviewEventId)
    && verdict.evidence?.some(item => item.scope === "complete-text" && item.sha256 === gate.contentSha256) === true;
}

export function createStudioCheckpointStore(options: {
  identity: StudioAttemptIdentity;
  archive: ArchiveStore;
  priorRunId?: string;
  repository: StudioCheckpointRepository;
  hasUnknownOutcome: () => boolean;
}) {
  const { identity, archive, repository } = options;
  const currentOutputs = new Map<string, string>();
  const currentGates = new Map<string, SavedGate>();
  const refPrefix = `stages/${identity.stageId}/attempt-${identity.attempt}.continuity`;
  let unknown = false;
  let receiptUnverified = false;
  const save = async (kind: string, payload: unknown, originRunId = identity.runId): Promise<void> => {
    if (options.hasUnknownOutcome() && kind !== "OUTCOME") throw new Error("VIDEO_MODEL_OUTCOME_UNKNOWN: 原模型调用结果待对账");
    const record: CheckpointRecord = { schemaVersion: "workloom.studio-checkpoint-store/v1", identity, kind, payload, originRunId };
    const payloadHash = renderSha256(canonicalRenderJson(record));
    const ref = `${refPrefix}/${kind}-${payloadHash}.json`;
    try {
      const saved = await archive.writeJsonAtomic(ref, record);
      await repository.append("video.studio.checkpoint.saved", {
        runId: identity.runId, attempt: identity.attempt, stageId: identity.stageId, kind,
        inputSha256: identity.inputSha256, ref, sha256: saved.sha256, originRunId,
      });
    } catch (error) {
      receiptUnverified = true;
      throw error;
    }
  };
  const load = async (kind: string): Promise<CheckpointRecord[]> => {
    if (!options.priorRunId) return [];
    const records: CheckpointRecord[] = [];
    for (const pointer of await repository.readPointers(kind, options.priorRunId)) {
      let record: CheckpointRecord;
      try { record = await readRecord(archive, pointer); }
      catch (error) { receiptUnverified = true; throw error; }
      if (record.schemaVersion !== "workloom.studio-checkpoint-store/v1" || record.kind !== kind
        || record.identity.runId !== options.priorRunId || pointer.runId !== options.priorRunId || pointer.kind !== kind) {
        throw new Error("STUDIO_CHECKPOINT_INVALID: 断点来源运行不一致");
      }
      if (sameTask(record.identity, identity)) records.push(record);
    }
    return records;
  };
  const loadApprovedGate = async (gate: string): Promise<SavedGate | null> => {
    for (const record of await load(`GATE_${gate}`)) {
      const saved = record.payload as SavedGate;
      if (!reviewed(saved)) continue;
      if (gate === "G6_PROMPT" && (await productionRejections()).some(rejection => rejection.gateContentSha256 === saved.contentSha256)) return null;
      return saved;
    }
    return null;
  };
  const productionRejections = async (): Promise<StudioProductionRejection[]> => {
    const rejected = new Map<string, StudioProductionRejection>();
    for (const record of await load("PRODUCTION_REJECTION")) {
      const payload = record.payload as StudioProductionRejection;
      if (!payload || !/^FACT_[a-f0-9]{64}$/u.test(payload.key) || !sha(payload.gateContentSha256)
        || !payload.engineOutputSha256ByStage || typeof payload.engineOutputSha256ByStage !== "object"
        || Object.values(payload.engineOutputSha256ByStage).some(value => !sha(value))
        || payload.originRunId !== record.originRunId) throw new Error("STUDIO_CHECKPOINT_INVALID: 生产语义拒绝回执未绑定原运行");
      if (!rejected.has(payload.key)) rejected.set(payload.key, payload);
    }
    return [...rejected.values()].sort((left, right) => left.key < right.key ? -1 : left.key > right.key ? 1 : 0);
  };
  const engine: StudioCheckpointAdapter = {
    async load(request: StudioCheckpointRequest) {
      for (const record of await load(`ENGINE_${request.stage}`)) {
        const checkpoint = record.payload as StudioEngineCheckpoint;
        if (checkpoint.schemaVersion !== request.schemaVersion || checkpoint.stage !== request.stage
          || checkpoint.inputSha256 !== request.inputSha256 || checkpoint.dependencySha256 !== request.dependencySha256) continue;
        const gate = stageGate[request.stage];
        if (gate && (await loadApprovedGate(gate))?.engineOutputSha256ByStage[request.stage] !== checkpoint.outputSha256) return null;
        await save(record.kind, checkpoint, record.originRunId);
        currentOutputs.set(request.stage, checkpoint.outputSha256);
        return checkpoint;
      }
      return null;
    },
    async save(checkpoint) {
      await save(`ENGINE_${checkpoint.stage}`, checkpoint);
      currentOutputs.set(checkpoint.stage, checkpoint.outputSha256);
    },
  };
  return {
    engine,
    async loadGate(gate: string, content: string): Promise<SavedGate | null> {
      const saved = await loadApprovedGate(gate);
      if (!saved || saved.contentSha256 !== renderSha256(content)) return null;
      for (const evidence of saved.verdict.evidence ?? []) {
        const bytes = await open(evidence.path, constants.O_RDONLY | constants.O_NOFOLLOW);
        try {
          if (renderSha256(await bytes.readFile()) !== evidence.sha256) throw new Error("STUDIO_CHECKPOINT_INVALID: 原审核证据已变化");
        } finally { await bytes.close(); }
      }
      return saved;
    },
    async saveGate(gate: string, content: string, verdict: ProducerVerdict, reviewEventId: string, originRunId = identity.runId) {
      if (verdict.unknownOutcome) unknown = true;
      if (!reviewed({ verdict, contentSha256: renderSha256(content), engineOutputSha256ByStage: {}, reviewEventId, originRunId })) return;
      const saved = { contentSha256: renderSha256(content), verdict, reviewEventId, originRunId,
        engineOutputSha256ByStage: Object.fromEntries(currentOutputs) } satisfies SavedGate;
      await save(`GATE_${gate}`, saved, originRunId);
      currentGates.set(gate, saved);
    },
    async rejectProduction(key: string, review: unknown) {
      const gate = currentGates.get("G6_PROMPT");
      if (!/^FACT_[a-f0-9]{64}$/u.test(key) || !gate) {
        receiptUnverified = true;
        throw new Error("STUDIO_CHECKPOINT_INVALID: 生产语义拒绝缺少对应的完整G6审核");
      }
      const rejection: StudioProductionRejection = { key, review, gateContentSha256: gate.contentSha256,
        engineOutputSha256ByStage: gate.engineOutputSha256ByStage, originRunId: identity.runId };
      await save("PRODUCTION_REJECTION", rejection);
    },
    loadProductionRejections: productionRejections,
    async adoptProductionRejection(rejection: StudioProductionRejection) {
      await save("PRODUCTION_REJECTION", rejection, rejection.originRunId);
    },
    async loadValue<T>(kind: string): Promise<T | null> {
      const record = (await load(kind))[0];
      if (!record) return null;
      if (stageGate[kind] && !await loadApprovedGate(stageGate[kind]!)) return null;
      return record.payload as T;
    },
    saveValue: save,
    markUnknown() { unknown = true; },
    markReceiptUnverified() { receiptUnverified = true; },
    async finishOutcome() {
      const state = unknown || options.hasUnknownOutcome() ? "unknown" : receiptUnverified ? "receipt_unverified" : "known";
      await save("OUTCOME", { state });
    },
    async begin() { await save("OUTCOME", { state: "dispatching" }); },
  };
}

export async function readStudioAttemptOutcome(options: {
  scope: Scope; projectId: string; projectCreatedAt: string | null; stageId: string; runId: string; attempt: number;
  archive: ArchiveStore; repository?: StudioCheckpointRepository;
}): Promise<"known" | "unknown" | "dispatching" | "receipt_unverified" | null> {
  const repository = options.repository ?? studioCheckpointRepository(options.scope, options.projectId);
  for (const pointer of await repository.readPointers("OUTCOME", options.runId)) {
    const record = await readRecord(options.archive, pointer);
    const identity = record.identity;
    if (record.schemaVersion !== "workloom.studio-checkpoint-store/v1" || record.kind !== "OUTCOME"
      || identity.tenantId !== options.scope.tenantId || identity.workspaceId !== options.scope.workspaceId
      || identity.projectId !== options.projectId || identity.projectCreatedAt !== options.projectCreatedAt
      || identity.stageId !== options.stageId || identity.runId !== options.runId) {
      throw new Error("STUDIO_CHECKPOINT_INVALID: 运行结算标记不属于当前项目");
    }
    if (identity.attempt !== options.attempt) continue;
    const state = (record.payload as { state?: unknown })?.state;
    if (state !== "known" && state !== "unknown" && state !== "dispatching" && state !== "receipt_unverified") {
      throw new Error("STUDIO_CHECKPOINT_INVALID: 运行结算状态无效");
    }
    return state;
  }
  return null;
}
