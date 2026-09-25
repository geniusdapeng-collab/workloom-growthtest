/**
 * video/gen/submit.ts —— 生成任务提交（唯一写入口：render.submit 与 gen.submit 共用）
 *
 * 步骤：幂等键去重 → 目录取模（wired 校验）→ 报价预估 → 供应商提交（降级链留痕）
 *      → render_jobs 行 + 脚本状态推进 + render.submit 事件（D16：同一事务同一 COMMIT）。
 * 与旧实现的差异：携带脚本正文（而非占位编号）、携带模型与参数、记录预估成本与幂等键、
 * 失败按类分类（AUTH/并发/模型不可用/可重试），不静默换档。
 */
import type { getAppPool, getGatewayPool } from "@workloom/db";
import { gatewayAppendOnClient } from "@workloom/base/workdata";
import { GatewayEventSink, currentWindow, type GenProvider } from "@workloom/base/model-router";
import type { RuleImpact } from "@workloom/base/fence-engine";
import { newId } from "@workloom/shared";
import { getModel, findFallbackModels, resolveProviderModel } from "./catalog.js";
import { estimateCost } from "./cost.js";
import { videoGenPool } from "./providers.js";
import type { MediaModel, VideoGenParams } from "./types.js";
import { ProviderError } from "./types.js";
import type { Scope } from "./db.js";

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
}

function buildPrompt(script: RenderScriptLike, model: MediaModel): string {
  const maxChars = model.limits?.maxPromptChars ?? 4000;
  const body = String(script.md ?? "").trim();
  const trimmed = body.length > maxChars ? body.slice(0, maxChars) : body;
  return `${trimmed}\n\n（脚本 ${script.script_key} v${script.version}）`;
}

/** 可切换供应商的失败类别（换链）；并发/参数/合规类不换（换档必须留痕并重新算钱） */
function switchable(err: unknown): boolean {
  if (!(err instanceof ProviderError)) return true;
  return err.kind === "AUTH" || err.kind === "MODEL_UNAVAILABLE" || err.kind === "RETRYABLE" || err.kind === "PROVIDER_FAILED";
}

export async function submitGenJob(input: SubmitGenJobInput): Promise<SubmitGenJobResult> {
  const { app, gateway, scope, script } = input;
  const env = input.env ?? process.env;

  /* ---------- ① 幂等：同键重复提交直接返回既有任务（不重复扣费） ---------- */
  if (input.idempotencyKey) {
    const rows = await (async () => {
      const client = await app.connect();
      try {
        await client.query("BEGIN");
        await client.query("SELECT set_config('app.workspace_id', $1, true)", [scope.workspaceId]);
        const r = await client.query<{
          id: string; task_id: string | null; provider: string | null; provider_model: string | null;
          est_usd: string | null; est_cny: string | null; mock: boolean;
        }>(
          `SELECT id, task_id, provider, provider_model, est_usd, est_cny, mock
             FROM render_jobs WHERE workspace_id=$1 AND idempotency_key=$2`,
          [scope.workspaceId, input.idempotencyKey],
        );
        await client.query("COMMIT");
        return r.rows;
      } catch (err) {
        await client.query("ROLLBACK").catch(() => undefined);
        throw err;
      } finally {
        client.release();
      }
    })();
    const hit = rows[0];
    if (hit) {
      return {
        jobId: hit.id, taskId: hit.task_id ?? "", provider: hit.provider ?? "seedance",
        providerModel: hit.provider_model ?? "", mock: Boolean(hit.mock),
        estUsd: hit.est_usd === null ? null : Number(hit.est_usd),
        estCny: hit.est_cny === null ? null : Number(hit.est_cny),
        deduped: true, degraded: [],
      };
    }
  }

  /* ---------- ② 目录取模：必须 wired 且供应商已配置（否则明确拒绝，不 mock 冒充） ---------- */
  const model = getModel(input.modelId);
  if (!model) throw new Error(`模型目录中不存在：${input.modelId}`);
  if (model.availability !== "wired") {
    throw new Error(`模型 ${model.id} 为目录登记（未接入适配器）：${model.notes ?? "请换已接入模型"}`);
  }
  const pool = videoGenPool();
  const providerModel = resolveProviderModel(model, env);
  const primary = pool.get(model.provider);
  const mock = pool.size === 0; // 全无密钥 → mock（数据与界面明确标注，不烧额度）

  /* ---------- ③ 报价预估（目录价；USD→CNY 折算） ---------- */
  const est = estimateCost(model, { seconds: input.params.durationSec ?? model.limits?.durationSec?.default ?? 5 });

  /* ---------- ④ 供应商提交（降级链 = 显式选中的模型 → 同档备援；失败分类留痕） ---------- */
  let taskId: string;
  let usedProvider = model.provider;
  let usedProviderModel = providerModel;
  const degraded: Array<{ from: string; to: string | null; reason: string }> = [];
  const sink = new GatewayEventSink(gateway, scope, { id: "render-operator" });
  const prompt = buildPrompt(script, model);
  const neutralParams = {
    providerModel,
    ...input.params,
  } as Record<string, unknown>;

  if (mock) {
    taskId = `mock-${newId("seedance")}`;
  } else {
    const chain: Array<{ provider: string; providerModel: string }> = [{ provider: model.provider, providerModel }];
    for (const fb of findFallbackModels(model, 2, env)) {
      chain.push({ provider: fb.provider, providerModel: fb.effectiveProviderModel });
    }
    let submitted: { taskId: string } | null = null;
    for (let i = 0; i < chain.length; i++) {
      const step = chain[i]!;
      const provider: GenProvider | undefined = pool.get(step.provider);
      const to = chain[i + 1]?.provider ?? null;
      if (!provider || !(await provider.healthy())) {
        degraded.push({ from: step.provider, to, reason: "unhealthy" });
        await sink.recordDegradation({ from: step.provider, to, reason: "unhealthy", action: "gen.submit" });
        continue;
      }
      try {
        submitted = await provider.submit({
          prompt,
          estimatedUnits: input.params.durationSec ?? 5,
          refId: script.id,
          params: { ...neutralParams, providerModel: step.providerModel },
        });
        usedProvider = step.provider;
        usedProviderModel = step.providerModel;
        await sink.recordModelTrace({
          model_id: `gen:${step.provider}:${step.providerModel}`,
          tier: `gen-${model.tier}`,
          window: currentWindow(new Date()),
          credits: Math.max(0.01, (input.params.durationSec ?? 5) * 0.1),
          action: "gen.submit",
          scene: "video-gen",
          bill_to: "tenant",
        });
        break;
      } catch (err) {
        const reason = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
        degraded.push({ from: step.provider, to, reason });
        await sink.recordDegradation({ from: step.provider, to, reason, action: "gen.submit" });
        if (!switchable(err)) throw err; // 并发满/参数错/合规：不换链，交调用方处理
      }
    }
    if (!submitted) throw new Error("生成供应商全链不可用（gen.degraded 已留痕），请稍后重试");
    taskId = submitted.taskId;
  }

  /* ---------- ⑤ 落库：行 + 脚本状态 + 事件（同一事务同一 COMMIT） ---------- */
  const jobId = newId("RJ");
  const client = await app.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT set_config('app.workspace_id', $1, true)", [scope.workspaceId]);
    await client.query("SELECT set_config('app.tenant_id', $1, true)", [scope.tenantId]);
    await client.query(
      `INSERT INTO render_jobs
         (id, workspace_id, project_id, script_id, script_version, task_id, status,
          provider, provider_model, est_usd, est_cny, est_seconds, idempotency_key, mock, attempt)
       VALUES ($1,$2,$3,$4,$5,$6,'submitted',$7,$8,$9,$10,$11,$12,$13,1)`,
      [
        jobId, scope.workspaceId, script.project_id, script.id, script.version, taskId,
        usedProvider, usedProviderModel, est.usd, est.cny,
        input.params.durationSec ?? null, input.idempotencyKey ?? null, mock,
      ],
    );
    await client.query(
      `UPDATE render_scripts SET status='submitted' WHERE workspace_id=$1 AND id=$2`,
      [scope.workspaceId, script.id],
    );
    await gatewayAppendOnClient(client, { ...scope, actor: { id: input.actor, type: "human" } }, {
      who: { type: "human", id: input.actor },
      context: {
        tenant_id: scope.tenantId, workspace_id: scope.workspaceId,
        time: new Date().toISOString(), channel: "inapp",
      },
      object: { type: "render_script", id: script.id },
      decision: {
        action: "render.submit",
        after: {
          jobId, taskId, mock, mode: input.mode,
          scriptKey: script.script_key, version: script.version, projectId: script.project_id,
	estimated_seconds: input.params.durationSec ?? null,
	duration_provenance: input.durationProvenance ?? null,
          est_usd: est.usd, est_cny: est.cny,
          provider: usedProvider, provider_model: usedProviderModel,
          idempotency_key: input.idempotencyKey ?? null,
          budget_overage_seconds: input.budgetOverageSeconds ?? 0,
          fence_level: input.fenceLevel,
          request: {
            durationSec: input.params.durationSec ?? null,
            aspectRatio: input.params.aspectRatio ?? null,
            resolution: input.params.resolution ?? null,
            generateAudio: input.params.generateAudio ?? null,
            firstFrame: Boolean(input.params.firstFrameUrl),
            referenceCount: input.params.referenceImageUrls?.length ?? 0,
          },
          degraded: degraded.length > 0 ? degraded : undefined,
        },
        basis: [
          mock
            ? "G8 已过，生成提交（mock：无供应商密钥，不触真实渲染不烧额度）"
            : `G8 已过，生成提交：模型 ${model.id} → 供应商 ${usedProvider}`,
          `报价口径：${est.usd === null ? "未核价（以供应商账单为准）" : `$${est.usd} ≈ ¥${est.cny}`}`,
        ],
      },
      rule_impact: input.fenceImpacts as never,
      receipt: { synced: false }, // 提交成功≠成片；真实回执由 poller 写
    });
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }

  return {
    jobId, taskId, provider: usedProvider, providerModel: usedProviderModel, mock,
    estUsd: est.usd, estCny: est.cny, deduped: false, degraded,
  };
}
