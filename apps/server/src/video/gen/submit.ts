/**
 * 生成唯一写入口：完整请求指纹 → 持久预占/CAS → 外部提交 → 接受回执 → 原子记账。
 * 网络不在 PG 事务中；unknown/submitting 不按超时重发；accepted 只补记账。
 */
import type { getAppPool, getGatewayPool } from "@workloom/db";
import { gatewayAppendOnClient, type EventDraft } from "@workloom/base/workdata";
import { GenSubmissionError, GatewayEventSink, currentWindow } from "@workloom/base/model-router";
import type { RuleImpact } from "@workloom/base/fence-engine";
import { newId } from "@workloom/shared";
import { getModel, findFallbackModels, resolveProviderModel } from "./catalog.js";
import { estimateCost } from "./cost.js";
import { videoGenPool } from "./providers.js";
import type { VideoGenParams } from "./types.js";
import type { Scope } from "./db.js";
import { SubmissionError, SubmissionLedger, submissionRequestHash, type SubmissionReceipt, type SubmissionRow } from "./submission-ledger.js";
import { buildRenderPrompt } from "./compiled-request.js";
import { authorizeRenderSubmission } from "../production-authority.js";

export interface RenderScriptLike {
  id: string;
  project_id: string;
  shot_id: string;
  script_key: string;
  version: number;
  status: string;
  md: string;
  fields?: Record<string, unknown> | null;
}

export interface SubmitGenJobInput {
  app: ReturnType<typeof getAppPool>;
  gateway: ReturnType<typeof getGatewayPool>;
  scope: Scope;
  actor: string;
  script: RenderScriptLike;
  modelId: string;
  params: VideoGenParams;
  /** 时长来源（T-2026-0925-0001）：用于留痕"计划=执行"的派生链 */
  durationProvenance?: {
    source: "request" | "script-fields" | "script-md" | "estimate-fallback";
    planSeconds: number | null;
    requestedSeconds: number | null;
    mismatchSeconds: number | null;
    strict: boolean;
  };
  mode: "manual" | "batch" | "auto";
  idempotencyKey?: string | null;
  fenceLevel: string;
  fenceImpacts: RuleImpact[];
  budgetOverageSeconds?: number;
  env?: NodeJS.ProcessEnv;
  /** 正式远端生成必须来自服务当前预生产的不可变资格。 */
  qualificationToken?: string;
}

export interface SubmitGenJobResult {
  jobId: string;
  taskId: string;
  provider: string;
  providerModel: string;
  mock: boolean;
  estUsd: number | null;
  estCny: number | null;
  deduped: boolean;
  degraded: Array<{ from: string; to: string | null; reason: string }>;
  idempotencyKey: string;
  requestHash: string;
}

function publicResult(receipt: SubmissionReceipt, row: SubmissionRow, deduped: boolean): SubmitGenJobResult {
  const { events: _events, ...result } = receipt;
  return { ...result, deduped, idempotencyKey: row.idempotency_key, requestHash: row.request_hash };
}

function pending(row: SubmissionRow, code = "SUBMISSION_UNVERIFIED", taskId?: string, provider?: string): SubmissionError {
  return new SubmissionError(code,
    `生成提交 ${row.id} 处于 ${row.state}：须核对已有任务，不能换幂等键盲目重发`,
    { submissionId: row.id, key: row.idempotency_key, requestHash: row.request_hash,
      taskId: taskId ?? row.task_id ?? undefined, provider: provider ?? row.provider ?? undefined });
}

/** 只记录分类，避免供应商报错回显提示词、鉴权或引用素材 URL。 */
function failureReason(err: unknown): string {
  if (err instanceof GenSubmissionError) return `${err.name}:${err.acceptance}`;
  return "provider-receipt-unknown";
}

export async function submitGenJob(input: SubmitGenJobInput): Promise<SubmitGenJobResult> {
  submissionRequestHash({ script: input.script, params: input.params });
  const snapshot = { ...input, script: structuredClone(input.script), params: structuredClone(input.params),
    scope: { ...input.scope }, env: { ...(input.env ?? process.env) } };
  const model = getModel(snapshot.modelId);
  // 本地白板/解说有独立的结构化制作链，资格由对应管线后续接入，不能套用远端提示词证明。
  if (model && !["whiteboard-local", "remotion-local"].includes(model.provider)) {
    const authorization = await authorizeRenderSubmission(snapshot);
    try { return await submitWithLedger({ ...snapshot, app: authorization.leasedApp ?? snapshot.app }, authorization); }
    finally { await authorization.release(); }
  }
  return submitWithLedger(snapshot, null);
}

async function submitWithLedger(input: SubmitGenJobInput, authorization: Awaited<ReturnType<typeof authorizeRenderSubmission>> | null): Promise<SubmitGenJobResult> {
  // 快照与指纹来自同一份 JSON 数据，等待 DB/健康探针期间调用方修改对象不能改变实际请求。
  submissionRequestHash({ script: input.script, params: input.params });
  const script = structuredClone(input.script);
  const params = structuredClone(input.params);
  const scope = { ...input.scope };
  const env = { ...(input.env ?? process.env) };
  const model = getModel(input.modelId);
  if (!model || model.availability !== "wired") {
    throw new SubmissionError("MODEL_UNAVAILABLE", `模型 ${input.modelId} 不存在或未接入适配器`);
  }
  const primaryModel = authorization?.compiled.providerModel ?? resolveProviderModel(model, env);
  const chain = [{ model, provider: model.provider, providerModel: primaryModel },
    ...(authorization ? [] : findFallbackModels(model, 2, env)).map((fallback) => ({
      model: fallback, provider: fallback.provider, providerModel: fallback.effectiveProviderModel,
    }))];
  const pool = videoGenPool(env);
  const mock = authorization ? false : pool.size === 0;
  const prompt = authorization?.reconciliationOnly ? script.md : buildRenderPrompt(script, model);
  const requestHash = authorization?.requestHash ?? submissionRequestHash({
    version: 1, scope,
    script: { id: script.id, projectId: script.project_id, shotId: script.shot_id,
      key: script.script_key, version: script.version, md: script.md, fields: script.fields ?? {} },
    modelId: model.id, provider: model.provider, providerModel: primaryModel, prompt, params, mode: input.mode, mock,
  });
  const key = input.idempotencyKey?.trim() || `render:${requestHash}`;
  const ledger = new SubmissionLedger(input.app, scope);
  let row = await ledger.reserve({ projectId: script.project_id, scriptId: script.id,
    scriptVersion: script.version, key, requestHash,
    script: { shot_id: script.shot_id, script_key: script.script_key, md: script.md, fields: script.fields } });

  const finalize = async (existing: SubmissionRow, replay: boolean): Promise<SubmitGenJobResult> => {
    try {
      const result = await ledger.finalize(existing.id, async (client, locked, receipt) => {
        await client.query(
          `INSERT INTO render_jobs
             (id, workspace_id, project_id, script_id, script_version, task_id, status,
              provider, provider_model, est_usd, est_cny, est_seconds, idempotency_key, mock, attempt)
           VALUES ($1,$2,$3,$4,$5,$6,'submitted',$7,$8,$9,$10,$11,$12,$13,1)`,
          [receipt.jobId, scope.workspaceId, locked.project_id, locked.script_id, locked.script_version,
            receipt.taskId, receipt.provider, receipt.providerModel, receipt.estUsd, receipt.estCny,
            params.durationSec ?? null, locked.idempotency_key, receipt.mock],
        );
        const updated = await client.query(
          `UPDATE render_scripts SET status='submitted'
            WHERE workspace_id=$1 AND id=$2 AND project_id=$3 AND version=$4 RETURNING id`,
          [scope.workspaceId, locked.script_id, locked.project_id, locked.script_version],
        );
        if (updated.rowCount !== 1) throw new SubmissionError("SCRIPT_SCOPE_MISMATCH", "接受后脚本版本不可见，记账中止并保留回执");
        for (const event of receipt.events) {
          await gatewayAppendOnClient(client, { ...scope, actor: { id: event.who.id, type: event.who.type } }, event);
        }
      });
      return publicResult(result.receipt, existing, replay || result.deduped);
    } catch (err) {
      const reconciliation = new SubmissionError("SUBMISSION_FINALIZATION_PENDING",
        `供应商任务 ${existing.task_id ?? "已接受"} 已留回执，记账未核实；以原幂等键重试仅补记账`,
        { submissionId: existing.id, key, requestHash, taskId: existing.task_id ?? undefined, provider: existing.provider ?? undefined },
      );
      reconciliation.cause = err;
      throw reconciliation;
    }
  };
  if (row.state === "accepted" || row.state === "finalized") return finalize(row, true);
  if (row.state !== "reserved") throw pending(row);
  if (authorization?.reconciliationOnly) throw pending(row, "SUBMISSION_UNVERIFIED");

  const owner = newId("GSO");
  const claimed = await ledger.claim(row, owner);
  if (!claimed) {
    const raced = await ledger.read(row.id);
    if (raced?.state === "accepted" || raced?.state === "finalized") return finalize(raced, true);
    throw pending(raced ?? row, "SUBMISSION_IN_PROGRESS");
  }
  row = claimed;
  const degraded: SubmissionReceipt["degraded"] = [];
  const sink = new GatewayEventSink(input.gateway, scope, { id: "render-operator" });
  let selected = chain[0]!;
  let taskId: string | undefined;
  let dispatchUnresolved = false;
  try {
    if (mock) {
      await ledger.recordDispatch(row.id, owner, selected.provider, selected.providerModel);
      taskId = `mock-${newId("gen")}`;
    } else {
      for (let i = 0; i < chain.length; i++) {
        const step = chain[i]!;
        const provider = pool.get(step.provider);
        const to = chain[i + 1]?.provider ?? null;
        if (!provider || !(await provider.healthy())) {
          const degradation = { from: step.provider, to, reason: "unhealthy" };
          degraded.push(degradation);
          await sink.recordDegradation({ ...degradation, action: "gen.submit" });
          continue;
        }
        await ledger.recordDispatch(row.id, owner, step.provider, step.providerModel);
        dispatchUnresolved = true;
        try {
          const submitted = await provider.submit({ prompt,
            estimatedUnits: params.durationSec ?? 5, refId: script.id,
            params: { ...params, providerModel: step.providerModel },
          });
          if (typeof submitted?.taskId !== "string" || !submitted.taskId.trim()) {
            throw new GenSubmissionError("供应商未返回有效任务号", "unknown");
          }
          taskId = submitted.taskId;
          selected = step;
          break;
        } catch (err) {
          if (!(err instanceof GenSubmissionError) || err.acceptance !== "not-accepted") throw err;
          dispatchUnresolved = false;
          if (!err.fallbackAllowed) throw err;
          const degradation = { from: step.provider, to, reason: failureReason(err) };
          degraded.push(degradation);
          await sink.recordDegradation({ ...degradation, action: "gen.submit" });
        }
      }
    }
    if (!taskId) throw new SubmissionError("PROVIDERS_UNAVAILABLE", "生成供应商全链不可用；没有已接受任务");
  } catch (error) {
    try {
      await ledger.recordFailure(row.id, owner, dispatchUnresolved ? "unknown" : "rejected", failureReason(error));
    } catch (ledgerError) {
      throw new AggregateError([error, ledgerError], `生成提交 ${row.id} 状态未核实，禁止重新提交`);
    }
    if (dispatchUnresolved) throw pending({ ...row, state: "unknown" }, "SUBMISSION_UNKNOWN");
    throw error;
  }

  // 接受回执先持久化。即使此时进程崩溃/DB ack 丢失，预占行仍阻止后续 submit。
  const est = estimateCost(selected.model, { seconds: params.durationSec ?? selected.model.limits?.durationSec?.default ?? 5 });
  const time = new Date().toISOString();
  const context = { tenant_id: scope.tenantId, workspace_id: scope.workspaceId, time, channel: "inapp" };
  const events: EventDraft[] = [];
  if (!mock) {
    events.push({
      who: { type: "system", id: "model-router" }, context,
      object: { type: "store", id: scope.workspaceId },
      decision: { action: "model.call", after: { action: "gen.submit", model: `gen:${selected.provider}:${selected.providerModel}`,
        model_tier: selected.model.tier, jobId: row.job_id, submissionId: row.id, reused: false, scene: "video-gen", bill_to: "tenant" } },
      model_trace: { model_id: `gen:${selected.provider}:${selected.providerModel}`, tier: "gen",
        window: currentWindow(new Date(time)), credits: Math.max(0.01, (params.durationSec ?? 5) * 0.1) },
      rule_impact: [],
    });
  }
  events.push({
    who: { type: "human", id: input.actor }, context,
    object: { type: "render_script", id: script.id },
    decision: {
      action: "render.submit",
      after: {
        jobId: row.job_id, taskId, mock, mode: input.mode, submissionId: row.id,
        scriptKey: script.script_key, version: script.version, projectId: script.project_id,
        estimated_seconds: params.durationSec ?? null, duration_provenance: input.durationProvenance ?? null,
        est_usd: est.usd, est_cny: est.cny, provider: selected.provider, provider_model: selected.providerModel,
        idempotency_key: key, request_hash: requestHash,
        budget_overage_seconds: input.budgetOverageSeconds ?? 0, fence_level: input.fenceLevel,
        request: { durationSec: params.durationSec ?? null, aspectRatio: params.aspectRatio ?? null,
          resolution: params.resolution ?? null, generateAudio: params.generateAudio ?? null,
          firstFrame: Boolean(params.firstFrameUrl), referenceCount: params.referenceImageUrls?.length ?? 0 },
        degraded,
      },
      basis: [mock ? "G8 已过，mock 提交（无供应商密钥，不触真实生成）" : `G8 已过，供应商已接受：${selected.provider}`,
        `报价口径：${est.usd === null ? "未核价（以供应商账单为准）" : `$${est.usd} ≈ ¥${est.cny}`}`],
    },
    rule_impact: input.fenceImpacts as EventDraft["rule_impact"],
    receipt: { synced: false },
  });
  const receipt: SubmissionReceipt = {
    jobId: row.job_id, taskId, provider: selected.provider, providerModel: selected.providerModel,
    mock, estUsd: est.usd, estCny: est.cny, degraded, events,
  };
  try {
    await ledger.recordAccepted(row.id, owner, receipt);
  } catch (error) {
    // 保留已知任务号供对账；不把落账故障当成供应商拒绝，更不进入 fallback。
    const reconciliation = pending(row, "SUBMISSION_ACCEPTANCE_UNVERIFIED", taskId, selected.provider);
    reconciliation.cause = error;
    throw reconciliation;
  }
  return finalize({ ...row, state: "accepted", task_id: taskId, provider: selected.provider, receipt }, false);
}
