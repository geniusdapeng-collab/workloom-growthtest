/**
 * video/router.ts —— 视频经理 tRPC 子路由（融合设计 §3/§6/§7 服务端接线）
 *
 * 六组过程：
 *  - studio：预生产流水线启动/状态（异步工作器，G1–G7 门走 approvals 原生消息）
 *  - cms：渲染脚本 CMS（asset-cms render-scripts 服务：版本链 + G8 审批联动）
 *  - render：Seedance 提交（G8 围栏预检；无 VOLCENGINE_ARK_API_KEY 走 mock 并标注 mock:true）
 *  - publish：全平台 RPA 发布任务入队（G9 围栏预检，publish-rpa runner 执行时复核）
 *  - metrics：近 7 天 account_metrics 聚合投影
 *  - comments：待处理评论队列（G10 分流级别随行返回）
 *
 * 纪律：全部带 workspace 作用域（scopeOf + 事务级 RLS 双 GUC）；
 *      一切写入与事件留痕同一事务同一 COMMIT（D16，gatewayAppendOnClient）；
 *      越权查询返回空而非 403（L7.1）。
 */
import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { getAppPool, getGatewayPool } from "@workloom/db";
import { gatewayAppendOnClient, MockEmbedder, upsertMemoryInTx } from "@workloom/base/workdata";
import {
  approve as approveRenderScript,
  create as createRenderScript,
  listByProject as listRenderScripts,
  newVersion as newRenderScriptVersion,
  RenderScriptError,
  type RenderScriptRow,
} from "@workloom/base/asset-cms";
import { judge, type RuntimeRule } from "@workloom/base/fence-engine";
import { checkRenderBudget, planTierToPlanId } from "@workloom/base/model-router";
import { PlatformSchema } from "@workloom/base/publish-rpa";
import { protectedProcedure, router, scopeOf, writeProcedure } from "../trpc/context.js";
import { accountingRouter } from "./accounting.js";
import { pollRenderJobs } from "./render-poller.js";
import { defaultVideoModelId, getModel, listModels } from "./gen/catalog.js";
import { checkCostCaps, costCaps, estimateCost, renderSpendCny, usdCnyRate } from "./gen/cost.js";
import { serviceTierRejectionReason } from "./gen/params.js";
import { submitGenJob } from "./gen/submit.js";
import { createPublishTask, executePublishTask, fenceOverrideEnabled } from "./gen/publish.js";
import { mediaUrl } from "./gen/ingest.js";
/** PollReport 类型再导出（web 端 AppRouter 类型可移植性，TS2883） */
export type { PollReport } from "./render-poller.js";
import { dealRouter } from "./deal.js";
import { getRun, startRun, startVideoProjectRun, StudioWorkerError } from "./studio-worker.js";
import { applyRouteToMetadata, buildPipelineIntent, routeVideoPipeline } from "@hyperreality/video-studio";
import { routedLlmCall } from "../service/llm.js";
import {
  DeliveryError, buildVariantPreferenceContent, deliveryJobStatus, deliveryPreferenceConfidence,
  deliveryPreferenceMemoryId, listDeliveryJobs, listDeliveryPackages, readDeliveryArtifact,
  readDeliveryPackage, recordRevisionRequest, selectDeliveryVariant, startDeliveryRevision, triageDeliveryFeedback,
} from "./delivery.js";

interface Scope { tenantId: string; workspaceId: string }

/**
 * 分流用 LLM 调用面（T-2026-0925-0002）：只在规则判不准时被调用，
 * 场景走 `pipeline-route`（L1 轻量档 + 规则兜底；模型不可用即纯规则 → 不确定则澄清）。
 */
function routeLlmCall(scope: Scope): ((prompt: string) => Promise<string>) | undefined {
  return routedLlmCall({ gateway: getGatewayPool(), scope, scene: "pipeline-route" });
}

/** pg.Pool 结构类型（server 不直接依赖 @types/pg，从 db 包入口推导） */
export type AppPool = ReturnType<typeof getAppPool>;

/** 装载生效围栏规则（与 packages/runtime/src/loop.ts loadActiveRules 同口径：工作区 + '*' 基线） */
export async function loadActiveRules(
  app: AppPool,
  scope: Scope,
): Promise<{ rules: RuntimeRule[]; defaultLevel: "auto" | "review" | "block" }> {
  const client = await app.connect();
  try {
    // 事务级 RLS 上下文必须在显式事务内设置：autocommit 下 set_config(...,true) 语句结束即失效
    await client.query("BEGIN");
    await client.query("SELECT set_config('app.workspace_id', $1, true)", [scope.workspaceId]);
    const r = await client.query<{
      rule_id: string; version: string; name: string; level: "auto" | "review" | "block";
      is_baseline: boolean; match_spec: { object_types: string[]; actions: string[]; when: string };
    }>(
      `SELECT rule_id, version, name, level, is_baseline, match_spec
       FROM fence_rules WHERE (workspace_id=$1 OR workspace_id='*') AND status='active'`,
      [scope.workspaceId],
    );
    await client.query("COMMIT");
    return {
      rules: r.rows.map((row) => ({
        rule_id: row.rule_id, version: row.version, name: row.name, level: row.level,
        is_baseline: row.is_baseline, objectTypes: row.match_spec.object_types,
        actions: row.match_spec.actions, when: row.match_spec.when,
      })),
      defaultLevel: "review", // §3 门矩阵默认级别（写类动作无命中按 review，宁可错挂）
    };
  } catch (err) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}

/** pg QueryResultRow 同形约束（server 不直接依赖 @types/pg；any 值位与 pg 原生一致） */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type QueryRow = { [column: string]: any };

/** scoped 只读（L7.1：RLS + workspace 谓词双保险，越权返回空） */
export async function scopedQuery<T extends QueryRow>(
  app: AppPool,
  scope: Scope,
  sql: string,
  params: unknown[],
): Promise<T[]> {
  const client = await app.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT set_config('app.workspace_id', $1, true)", [scope.workspaceId]);
    const r = await client.query<T>(sql, params);
    await client.query("COMMIT");
    return r.rows;
  } catch (err) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}

function renderScriptRethrow(err: unknown): never {
  if (err instanceof RenderScriptError) {
    throw new TRPCError({
      code: err.code === "NOT_FOUND" ? "NOT_FOUND" : "BAD_REQUEST",
      message: err.message,
    });
  }
  throw err;
}

/* ================= delivery：交付包 / 选变体 / 提返修（T-2026-0924-0071） ================= */

/** 交付域错误 → tRPC 错误码（路径越界按 FORBIDDEN，缺件按 NOT_FOUND，其余按业务拒绝） */
function deliveryRethrow(err: unknown): never {
  if (err instanceof DeliveryError) {
    const code = err.code === "not_found" ? "NOT_FOUND"
      : err.code === "path_not_allowed" ? "FORBIDDEN"
        : err.code === "idempotency_conflict" || err.code === "shot_regeneration_required" || err.code === "artifact_too_large"
          ? "PRECONDITION_FAILED"
          : "BAD_REQUEST";
    throw new TRPCError({ code, message: err.message });
  }
  throw err;
}

/**
 * 交付域事件留痕（D16：与文件写入同一工作区作用域，事件进五元账本）。
 * 文件（selection.json / revision 单 / 作业日志）在工位侧落盘，事件在服务端补——两者都留痕才算完成。
 */
async function appendDeliveryEvent(
  ctx: { identity: { memberNo: string } },
  scope: Scope,
  event: {
    objectType: string; objectId: string; action: string;
    after: Record<string, unknown>; basis: string[];
    /**
     * 可选：同一事务内把这次动作沉淀成组织偏好记忆（evolve M3 偏好的写入侧）。
     * 与事件同一 COMMIT（D16）：要么"动作 + 偏好"都留下，要么都不留。
     */
    preference?: { memoryId: string; content: string; confidence: number } | null;
  },
): Promise<void> {
  const client = await getGatewayPool().connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT set_config('app.workspace_id', $1, true)", [scope.workspaceId]);
    await client.query("SELECT set_config('app.tenant_id', $1, true)", [scope.tenantId]);
    const appended = await gatewayAppendOnClient(client, { ...scope, actor: { id: ctx.identity.memberNo, type: "human" } }, {
      who: { type: "human", id: ctx.identity.memberNo },
      context: {
        tenant_id: scope.tenantId, workspace_id: scope.workspaceId,
        time: new Date().toISOString(), channel: "inapp",
      },
      object: { type: event.objectType, id: event.objectId },
      decision: { action: event.action, after: event.after, basis: event.basis },
      rule_impact: [],
    });
    if (event.preference) {
      /**
       * 先取旧来源（`FOR UPDATE` 锁行）再写：`upsertMemoryInTx` 的 ON CONFLICT 是**覆盖**语义，
       * 直接写会把历史归因冲掉（真机实测：第二次选择后 source_events 只剩最新一条）。
       * 合并去重后最多留 20 条，偏好要能回答"这条口味是从哪几次选择长出来的"。
       */
      const prior = await client.query<{ source_events: string[] | null }>(
        `SELECT source_events FROM org_memory WHERE memory_id = $1 FOR UPDATE`,
        [event.preference.memoryId],
      );
      const mergedEvents = [...new Set([...(prior.rows[0]?.source_events ?? []), appended.eventId])]
        .sort()
        .slice(-20);
      // 偏好内容经 workdata 的 maskText 脱敏后落库（与董事长反馈同一条路径）
      await upsertMemoryInTx(client, scope, {
        memoryId: event.preference.memoryId,
        scope: "workspace",
        kind: "preference",
        content: event.preference.content,
        sourceEvents: mergedEvents,
        confidence: event.preference.confidence,
      }, new MockEmbedder());
      /**
       * 置信度单调上调：`upsertMemoryInTx` 的 ON CONFLICT 只更新内容/来源，不动 confidence，
       * 这里显式按"选择次数"抬到目标值（只升不降，避免一次误点把长期口味打下去）。
       */
      await client.query(
        `UPDATE org_memory SET confidence = GREATEST(confidence, $2) WHERE memory_id = $1`,
        [event.preference.memoryId, event.preference.confidence],
      );
    }
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}

/**
 * 交付包与返修：读（列表/详情/作业）+ 写（选变体/分诊落单/启动本地重合成）。
 *
 * 纪律：交付根由 `WORKLOOM_DELIVERY_DIR` 指定（默认 `<repo>/var/delivery`），只读交付根内的包；
 * 重合成不在请求内执行（spawn 作业 + 轮询）；命中画面内容的返修一律拒绝并指向 G8 人审。
 */
const deliveryRouter = router({
  /** 交付包列表（按创建时间倒序；无交付根时返回空列表） */
  list: protectedProcedure
    .input(z.object({ limit: z.number().int().min(1).max(100).default(20) }))
    .query(({ input }) => listDeliveryPackages({ limit: input.limit })),

  /** 单个交付包详情（母版/旁挂字幕/变体/差异实测/检查/返修历史/选择记录；媒体给签名 URL） */
  get: protectedProcedure
    .input(z.object({ dir: z.string().min(1).max(200) }))
    .query(({ input }) => {
      try {
        return readDeliveryPackage(input.dir);
      } catch (err) {
        deliveryRethrow(err);
      }
    }),

  /**
   * 交付物取件（封面 / 成片 / 旁挂字幕文件）。
   *
   * 为什么不走独立 HTTP 路由：`apps/server/src/index.ts` 是舰队同步 PR 的常改文件（协议 §4 同文件后到者拒），
   * 交付界面不该为此常年排队；走行业域 tRPC 同时天然拿到 workspace 作用域与统一错误规约。
   * 体积上限内联返回 base64（默认 8MB），超出则报错并提示用本地播放器打开。
   */
  artifact: protectedProcedure
    .input(z.object({
      dir: z.string().min(1).max(200),
      ref: z.string().min(1).max(400),
      maxBytes: z.number().int().min(1024).max(64 * 1024 * 1024).optional(),
    }))
    .query(({ input }) => {
      try {
        return readDeliveryArtifact({ dir: input.dir, ref: input.ref, maxBytes: input.maxBytes });
      } catch (err) {
        deliveryRethrow(err);
      }
    }),

  /** 选变体：落选择记录 + 五元事件（用户最终选了哪个，这是变体默认集合的长期依据） */
  selectVariant: writeProcedure
    .input(z.object({
      dir: z.string().min(1).max(200),
      variantId: z.string().min(1).max(80),
      note: z.string().max(500).optional(),
    }))
    .mutation(async ({ ctx, input }) => {
      const scope = scopeOf(ctx.identity);
      let selection;
      try {
        selection = selectDeliveryVariant({
          dir: input.dir, variantId: input.variantId,
          note: input.note ?? null, by: ctx.identity.memberNo,
        });
      } catch (err) {
        deliveryRethrow(err);
      }
      await appendDeliveryEvent(ctx, scope, {
        objectType: "delivery_package", objectId: input.dir,
        action: "delivery.variant.selected",
        after: { variantId: selection.variantId, note: selection.note, at: selection.at },
        basis: ["用户在交付包里选择了风格变体（一个包多版本，选择即交付结论）"],
        /**
         * 选择结果回流组织偏好池：同一事务写入 preference 记忆，
         * 之后每次 ask/agent/quest 执行前都会被注入（见 packages/runtime/src/loop.ts），
         * 于是"用户爱暖调慢剪"这类口味会自然影响下一轮出片的变体默认值。
         */
        preference: {
          memoryId: deliveryPreferenceMemoryId(scope.workspaceId, selection.variantId),
          content: buildVariantPreferenceContent({
            projectId: selection.projectId,
            variantId: selection.variantId,
            variantName: selection.variant?.name ?? null,
            positioning: selection.variant?.positioning ?? null,
            style: selection.variant?.style ?? null,
            note: selection.note,
          }),
          confidence: deliveryPreferenceConfidence(selection.selectionCount),
        },
      });
      return {
        ...selection,
        preference: {
          memoryId: deliveryPreferenceMemoryId(scope.workspaceId, selection.variantId),
          confidence: deliveryPreferenceConfidence(selection.selectionCount),
          scope: "workspace" as const,
          note: "已写入组织偏好池（下一次 ask/agent/quest 执行前注入；反复选择同一风格会逐步抬高置信度）",
        },
      };
    }),

  /** 反馈分诊：规则表判归因/受影响层/是否需重生成镜头；同时落返修单（可选关闭落单） */
  triage: writeProcedure
    .input(z.object({
      dir: z.string().min(1).max(200),
      feedback: z.string().min(1).max(4000),
      record: z.boolean().default(true),
    }))
    .mutation(async ({ ctx, input }) => {
      const scope = scopeOf(ctx.identity);
      let outcome;
      try {
        outcome = await triageDeliveryFeedback(input.dir, input.feedback);
      } catch (err) {
        deliveryRethrow(err);
      }
      let requestPath: string | null = null;
      if (input.record) {
        try {
          const recorded = recordRevisionRequest({
            dir: input.dir, feedback: input.feedback,
            triage: outcome.triage, patchHint: outcome.patchHint, by: ctx.identity.memberNo,
          });
          requestPath = recorded.requestPath;
        } catch (err) {
          deliveryRethrow(err);
        }
        await appendDeliveryEvent(ctx, scope, {
          objectType: "delivery_package", objectId: input.dir,
          action: "delivery.revision.triaged",
          after: {
            feedback: input.feedback.slice(0, 500),
            kinds: outcome.triage.kinds ?? null,
            attributions: outcome.triage.attributions ?? null,
            layers: outcome.triage.layers ?? null,
            requiresShotRegeneration: outcome.triage.requiresShotRegeneration ?? null,
            requestPath: requestPath ? requestPath.split("/").slice(-3).join("/") : null,
          },
          basis: ["用户反馈经确定性规则表分诊：先判『后期能解决』还是『必须重生成画面』，再决定走本地重合成还是人审"],
        });
      }
      return { ...outcome, requestPath };
    }),

  /** 启动本地层增量重合成（spawn 工位 CLI；立刻返回 jobId，前端轮询 video.delivery.job） */
  startRevision: writeProcedure
    .input(z.object({
      dir: z.string().min(1).max(200),
      patch: z.record(z.string(), z.unknown()),
    }))
    .mutation(async ({ ctx, input }) => {
      const scope = scopeOf(ctx.identity);
      let job;
      try {
        job = await startDeliveryRevision({ dir: input.dir, patch: input.patch, by: ctx.identity.memberNo });
      } catch (err) {
        deliveryRethrow(err);
      }
      await appendDeliveryEvent(ctx, scope, {
        objectType: "delivery_package", objectId: input.dir,
        action: "delivery.revision.started",
        after: {
          jobId: job.jobId, patch: input.patch,
          layers: (job.impact?.layers as unknown) ?? null,
          localOnly: (job.impact?.localOnly as unknown) ?? null,
        },
        basis: ["返修走本地层增量重合成：镜头不重新生成，复用层带哈希证据（G-DLV4/G-DLV7）"],
      });
      return job;
    }),

  /** 重合成作业状态（内存注册表；日志同时落盘 `<包>/revision-jobs/<jobId>.log`） */
  job: protectedProcedure
    .input(z.object({ jobId: z.string().min(1).max(120) }))
    .query(({ input }) => deliveryJobStatus(input.jobId)),

  /** 某交付包（或缺省全部）的作业列表 */
  jobs: protectedProcedure
    .input(z.object({ dir: z.string().min(1).max(200).optional() }))
    .query(({ input }) => listDeliveryJobs(input.dir)),
});

/* ================= studio：预生产流水线 ================= */

const studioRouter = router({
  /**
   * 启动预生产（异步；projectId 缺省按 VID-nnn 口径生成；LLM 未配置明确拒绝）。
   *
   * T-2026-0925-0002：新增**自动化分流**。`route="auto"`（默认）时按意图判定走营销片
   * 还是叙事片；判不准返回 `{ kind: "clarify" }`（把选择交回用户，不立项、不花钱）。
   * `route="marketing"|"narrative"` 表示调用方已确认（例如用户在澄清后重提）。
   */
  start: writeProcedure
    .input(z.object({
      projectId: z.string().min(1).optional(),
      intent: z.string().min(1).max(2000),
      metadata: z.record(z.string(), z.unknown()).optional(),
      /** 兼容旧字段：显式指定营销/叙事；与 route 同时给出时以 route 为准 */
      isMarketing: z.boolean().optional(),
      /** 管线选择：auto=按意图自动分流（默认） */
      route: z.enum(["auto", "marketing", "narrative"]).default("auto"),
    }))
    .mutation(async ({ ctx, input }) => {
      const scope = scopeOf(ctx.identity);
      const explicitRoute = input.route !== "auto"
        ? input.route
        : input.isMarketing === undefined
          ? undefined
          : input.isMarketing
            ? "marketing"
            : "narrative";

      if (input.projectId) {
        // 指定 projectId 的补跑：项目行已存在，仅重启管线（kind 以项目行为准，避免改写立项语义）
        const rows = await scopedQuery<{ kind: string | null }>(
          getAppPool(), scope,
          `SELECT kind FROM video_projects WHERE id=$1 AND workspace_id=$2`,
          [input.projectId, scope.workspaceId],
        );
        const projectKind = rows[0]?.kind === "marketing" ? "marketing" : "narrative";
        const decision = await routeVideoPipeline({
          text: input.intent,
          metadata: input.metadata,
          explicit: explicitRoute ?? projectKind,
        }, { llmCall: routeLlmCall(scope) });
        if (decision.route === "clarify") {
          return {
            kind: "clarify" as const,
            question: decision.clarify?.question ?? "补跑前请确认商品信息：商品名（必填）/品牌/品类。",
            missing: decision.clarify?.missing ?? ["product"],
            signals: decision.signals,
            via: decision.via,
          };
        }
        const runId = startRun(scope, {
          projectId: input.projectId,
          intent: buildPipelineIntent(input.intent, {
            durationSec: 30,
            aspectRatio: decision.route === "marketing" ? "9:16" : undefined,
          }),
          metadata: applyRouteToMetadata(input.metadata, decision),
          isMarketing: decision.route === "marketing",
        });
        return { kind: "routed" as const, runId, projectId: input.projectId, pipeline: decision.route };
      }

      const decision = await routeVideoPipeline({
        text: input.intent,
        metadata: input.metadata,
        explicit: explicitRoute,
      }, { llmCall: routeLlmCall(scope) });
      if (decision.route === "clarify") {
        return {
          kind: "clarify" as const,
          question: decision.clarify?.question ?? "这条片子走营销片还是叙事片？",
          missing: decision.clarify?.missing ?? ["route"],
          signals: decision.signals,
          via: decision.via,
        };
      }
      try {
        // 与「右栏派活识别出视频目标」共用同一条标准管线入口（studio-worker#startVideoProjectRun）
        const started = await startVideoProjectRun(scope, {
          intent: buildPipelineIntent(input.intent, {
            durationSec: 30,
            aspectRatio: decision.route === "marketing" ? "9:16" : undefined,
          }),
          metadata: applyRouteToMetadata(input.metadata, decision),
          isMarketing: decision.route === "marketing",
          by: { id: ctx.identity.memberNo, type: "human" },
        });
        return {
          kind: "routed" as const,
          runId: started.runId,
          projectId: started.projectId,
          pipeline: decision.route,
          product: decision.product?.name ?? null,
          via: decision.via,
        };
      } catch (err) {
        if (err instanceof StudioWorkerError && err.code === "LLM_MISSING") {
          throw new TRPCError({ code: "PRECONDITION_FAILED", message: err.message });
        }
        throw err;
      }
    }),

  /** 运行状态投影（run 注册表 + 当前待审批门；L7.1 跨工作区返回 null） */
  status: protectedProcedure
    .input(z.object({ runId: z.string().min(1) }))
    .query(({ ctx, input }) => {
      const entry = getRun(input.runId, scopeOf(ctx.identity).workspaceId);
      if (!entry) return null;
      return {
        runId: entry.runId,
        projectId: entry.projectId,
        status: entry.status,
        currentGate: entry.currentGate,
        pendingApprovalId: entry.pendingApprovalId,
        startedAt: entry.startedAt,
        finishedAt: entry.finishedAt,
        error: entry.error,
        resultSummary: entry.resultSummary,
      };
    }),
});

/* ================= cms：渲染脚本 CMS（§6） ================= */

const cmsRouter = router({
  /**
   * 创建初版脚本（v1，draft）：预生产镜头卡 → 渲染脚本的第一步。
   *
   * 为什么必须有：`saveScriptVersion` 只做"新版本"（`新版本需已有 v1`），此前没有任何
   * tRPC 入口能建 v1 —— 真机 2026-09-21 实测出片链路止步于
   * `渲染脚本 <key> 不存在，须先 create`，只能直连数据库插行。此入口补上"镜头卡进管线"的正门。
   * 已存在的 key 明确拒绝（避免覆盖他人版本链），改版本请用 video.cms.saveScriptVersion。
   */
  createScript: writeProcedure
    .input(z.object({
      scriptKey: z.string().min(1).max(120),
      projectId: z.string().min(1).max(120),
      shotId: z.string().min(1).max(80),
      md: z.string().min(1),
      fields: z.record(z.string(), z.unknown()).optional(),
      charCheck: z.record(z.string(), z.unknown()).optional(),
    }))
    .mutation(async ({ ctx, input }) => {
      const scope = scopeOf(ctx.identity);
      const existing = await scopedQuery<{ id: string; version: number }>(
        getAppPool(), scope,
        `SELECT id, version FROM render_scripts WHERE workspace_id=$1 AND script_key=$2 ORDER BY version DESC LIMIT 1`,
        [scope.workspaceId, input.scriptKey],
      );
      if (existing[0]) {
        throw new TRPCError({
          code: "PRECONDITION_FAILED",
          message: `渲染脚本 ${input.scriptKey} 已存在（v${existing[0].version}）：新版本请用 video.cms.saveScriptVersion`,
        });
      }
      try {
        return await createRenderScript(getAppPool(), getGatewayPool(), scope, {
          scriptKey: input.scriptKey,
          projectId: input.projectId,
          shotId: input.shotId,
          md: input.md,
          fields: input.fields,
          charCheck: input.charCheck,
          by: ctx.identity.memberNo,
        });
      } catch (err) {
        renderScriptRethrow(err);
      }
    }),

  /** 按项目列出全部脚本版本（片库·脚本页数据源） */
  listScripts: protectedProcedure
    .input(z.object({ projectId: z.string().min(1) }))
    .query(async ({ ctx, input }) => {
      return listRenderScripts(getAppPool(), scopeOf(ctx.identity), input.projectId);
    }),

  /** 单版本详情（MD 正文 + 字段 JSON + 字符数校验快照；L7.1 越权返回 null） */
  getScript: protectedProcedure
    .input(z.object({ scriptId: z.string().min(1) }))
    .query(async ({ ctx, input }) => {
      const scope = scopeOf(ctx.identity);
      const rows = await scopedQuery<RenderScriptRow>(
        getAppPool(), scope,
        `SELECT * FROM render_scripts WHERE workspace_id=$1 AND id=$2`,
        [scope.workspaceId, input.scriptId],
      );
      return rows[0] ?? null;
    }),

  /** 保存即新版本（§6 本地编辑纪律：parent_version 链 + diff 摘要；事件随版本行同一 COMMIT） */
  saveScriptVersion: writeProcedure
    .input(z.object({
      scriptKey: z.string().min(1),
      md: z.string().min(1),
      fields: z.record(z.string(), z.unknown()).optional(),
      charCheck: z.record(z.string(), z.unknown()).optional(),
      diffSummary: z.string().default("工作台手工编辑"),
    }))
    .mutation(async ({ ctx, input }) => {
      try {
        return await newRenderScriptVersion(getAppPool(), getGatewayPool(), scopeOf(ctx.identity), input.scriptKey, {
          md: input.md,
          fields: input.fields,
          charCheck: input.charCheck,
          diffSummary: input.diffSummary,
          by: ctx.identity.memberNo,
        });
      } catch (err) {
        renderScriptRethrow(err);
      }
    }),

  /** G8 审批联动（版本即审批对象：draft → approved + approvals 行，服务内同一 COMMIT） */
  approveScript: writeProcedure
    .input(z.object({ scriptKey: z.string().min(1), version: z.number().int().min(1) }))
    .mutation(async ({ ctx, input }) => {
      try {
        return await approveRenderScript(
          getAppPool(), getGatewayPool(), scopeOf(ctx.identity),
          input.scriptKey, input.version, { by: ctx.identity.memberNo },
        );
      } catch (err) {
        renderScriptRethrow(err);
      }
    }),
});

/* ================= render：Seedance 提交（G8 围栏） ================= */

/**
 * 从渲染脚本解出**计划时长**（T-2026-0925-0001）。
 *
 * 背景：`render_scripts.fields` 此前恒为 `{}`，时长只写在人读的 md 行（`render-scripts.ts:63-68`），
 * 提交侧因此只能拿到调用方手填值，缺省时回落 `estimatedSeconds=30` —— 于是"计划 8–12s 的镜头
 * 按 30s 烧额度"（2.5–3.75×）且与镜头卡完全脱钩。
 * 取值优先级：`fields.durationSec` → md 的「时长: Ns」→ null（由调用方决定是否拒绝）。
 */
export function plannedDurationOf(script: { fields?: unknown; md?: string }): {
  seconds: number | null;
  source: "script-fields" | "script-md" | null;
} {
  const fields = (script.fields ?? {}) as Record<string, unknown>;
  const direct = Number(fields.durationSec ?? fields.duration_sec ?? fields["时长"]);
  if (Number.isFinite(direct) && direct > 0) return { seconds: Math.round(direct), source: "script-fields" };
  const md = String(script.md ?? "");
  const matched = /(?:时长|duration)\s*[:：]\s*([0-9]+(?:\.[0-9]+)?)\s*s?/i.exec(md);
  if (matched) {
    const value = Number(matched[1]);
    if (Number.isFinite(value) && value > 0) return { seconds: Math.round(value), source: "script-md" };
  }
  return { seconds: null, source: null };
}

const renderRouter = router({
  /**
   * 渲染提交（§6 三档模式 manual/batch/auto；G8 烧额度门）：
   * 围栏 block → 403；review → 须脚本已过 cms.approveScript（approved）；auto → 放行
   * 无 VOLCENGINE_ARK_API_KEY → mock 提交（task_id 前缀 mock-，返回 mock:true 明确标注）
   */
  submit: writeProcedure
    .input(z.object({
      scriptId: z.string().min(1),
      mode: z.enum(["manual", "batch", "auto"]),
      /** 模型目录 id（缺省取 WORKLOOM_VIDEO_DEFAULT_MODEL 或目录首个可用视频模型） */
      modelId: z.string().min(1).optional(),
      /** 成片时长（秒）；缺省回退 estimatedSeconds，并夹紧到模型 limits（回报 clamped） */
      durationSec: z.number().int().min(1).max(120).optional(),
      aspectRatio: z.string().max(16).optional(),
      resolution: z.string().max(16).optional(),
      generateAudio: z.boolean().optional(),
      /**
       * 图生视频首帧（URL）。
       * 真人肖像不接受直传图片（平台审核拦截 `InputImageSensitiveContentDetected.PrivacyInformation`），
       * 必须走方舟「已授权真人素材」：`asset://asset-2026...`（见《录入真人形象素材》）。
       */
      firstFrameUrl: z.union([z.string().url(), z.string().regex(/^asset:\/\/[A-Za-z0-9._-]{6,}$/, "asset://<asset ID>")]).optional(),
      /** 参考图（定妆照等，最多 4 张；支持 https URL 或方舟 asset:// 授权素材） */
      referenceImageUrls: z.array(
        z.union([z.string().url(), z.string().regex(/^asset:\/\/[A-Za-z0-9._-]{6,}$/, "asset://<asset ID>")])
      ).max(4).optional(),
      /** 视频参考（官方 SDK 的 video_url content；最多 2 条） */
      referenceVideoUrls: z.array(z.string().url()).max(2).optional(),
      /** 音频参考（音频驱动口播；最多 1 条） */
      referenceAudioUrls: z.array(z.string().url()).max(1).optional(),
      /** 复现种子（写入 render_jobs 便于对比与复盘） */
      seed: z.number().int().optional(),
      /** 平台水印开关（默认关闭） */
      watermark: z.boolean().optional(),
      /** 固定机位（口播/棚拍） */
      cameraFixed: z.boolean().optional(),
      /** 返回尾帧（供下一镜 first_frame 接力） */
      returnLastFrame: z.boolean().optional(),
      /** 服务档位：default（终稿）| flex（草稿，成本更低） */
      serviceTier: z.enum(["default", "flex"]).optional(),
      /** 幂等键（缺省按脚本+模型+时长+模式生成，防重复点击重复扣费） */
      idempotencyKey: z.string().max(200).optional(),
      /** 预计渲染秒数（额度台账计量基准；兼容旧调用，默认 30s） */
      estimatedSeconds: z.number().int().min(1).max(600).default(30),
      /** 超套餐额度时显式确认按量实扣（v3.0 渲染台账 G8 前置预算闸） */
      allowOverage: z.boolean().default(false),
    }))
    .mutation(async ({ ctx, input }) => {
      const scope = scopeOf(ctx.identity);
      const app = getAppPool();
      const scripts = await scopedQuery<RenderScriptRow>(
        app, scope,
        `SELECT * FROM render_scripts WHERE workspace_id=$1 AND id=$2`,
        [scope.workspaceId, input.scriptId],
      );
      const script = scripts[0];
      if (!script) throw new TRPCError({ code: "NOT_FOUND", message: `渲染脚本 ${input.scriptId} 不存在` });

      // G8 围栏预检（纯函数判定；impacts 随事件落库）
      const { rules, defaultLevel } = await loadActiveRules(app, scope);
      /**
       * 素材制作默认全自动（2026-09-21 产品所有者口径）：
       * 「制作投放素材」（图片 / 视频 / 渲染脚本）不设人审卡点；需要人审的是**投放领域**
       * （加投 G12）与**改价**场景，以及算力**超预算**（G11：project_compute_used ≥ cap）时暂停提交。
       * 这里显式给判定器上下文：render_auto=true ⇒ G8（渲染提交必审）自动放行；
       * 预算上限可由 WORKLOOM_PROJECT_COMPUTE_CAP（秒）配置，未配置视为不设上限。
       * 注意：缺失路径的数值比较会触发求值异常→block，所以两个数值必须显式给出。
       */
      const computeCap = Number(process.env.WORKLOOM_PROJECT_COMPUTE_CAP ?? 0);
      const verdict = judge({
        object: { type: "render_script", id: script.id },
        action: "render.submit",
        params: { mode: input.mode, scriptKey: script.script_key, version: script.version },
        context: {
          render_auto: (process.env.WORKLOOM_RENDER_AUTO ?? "1") !== "0" || input.mode === "auto",
          project_compute_used: 0,
          project_compute_cap: Number.isFinite(computeCap) && computeCap > 0 ? computeCap : Number.MAX_SAFE_INTEGER,
        },
      }, rules, defaultLevel);
      if (verdict.level === "block") {
        throw new TRPCError({
          code: "FORBIDDEN",
          message: `G8 围栏熔断：${verdict.triggeredBy.join("；") || "render.submit 命中 block 规则"}`,
        });
      }
      if (verdict.level === "review" && script.status !== "approved") {
        throw new TRPCError({
          code: "PRECONDITION_FAILED",
          message: `G8：渲染提交烧额度前置门——脚本 ${script.script_key} v${script.version} 须先经 video.cms.approveScript 审批（当前 ${script.status}；版本即审批对象）`,
        });
      }

      // v3.0 渲染额度台账：套餐秒数配额 G8 前置预算闸（用量=render.submit 事件投影，不重算）
      // ── 模型与时长解析（T-2026-0921-0002）：目录取模 + 时长夹紧到模型上限（回报 clamped，不静默） ──
      const modelId = input.modelId?.trim() || process.env.WORKLOOM_VIDEO_DEFAULT_MODEL?.trim() || defaultVideoModelId();
      const chosen = getModel(modelId);
      if (!chosen) {
        throw new TRPCError({ code: "BAD_REQUEST", message: `模型目录中不存在「${modelId}」（video.gen.catalog 可查可用清单）` });
      }
    /**
     * 计划 = 执行（T-2026-0925-0001）：
     * 优先用调用方显式值；否则用**镜头卡/渲染脚本的计划时长**；最后才回落 estimatedSeconds。
     * `WORKLOOM_DURATION_SUBMIT_STRICT=1` 时：缺计划时长或与计划偏差 >1s 一律拒绝（先告警灰度后可切）。
     */
    /** 回滚开关：WORKLOOM_DURATION_SUBMIT_DERIVE=off 时退回"调用方给值 / estimatedSeconds"的旧行为 */
    const deriveFromScript = (process.env.WORKLOOM_DURATION_SUBMIT_DERIVE ?? "on") !== "off";
    const planned = deriveFromScript ? plannedDurationOf(script) : { seconds: null, source: null };
    const strictDuration = (process.env.WORKLOOM_DURATION_SUBMIT_STRICT ?? "0") === "1";
    if (strictDuration && planned.seconds === null) {
      throw new TRPCError({
        code: "PRECONDITION_FAILED",
        message: "渲染脚本缺少计划时长：请在 fields.durationSec 或正文写上「时长: Ns」后再提交（不允许回落默认 30s）"
      });
    }
    const requestedSeconds = input.durationSec ?? planned.seconds ?? input.estimatedSeconds;
    if (strictDuration && planned.seconds !== null && input.durationSec !== undefined) {
      const mismatch = Math.round(input.durationSec) - planned.seconds;
      if (Math.abs(mismatch) > 1) {
        throw new TRPCError({
          code: "PRECONDITION_FAILED",
          message: `提交时长 ${input.durationSec}s 与镜头卡计划 ${planned.seconds}s 偏差 ${mismatch}s（>1s）：请改用计划时长或先改脚本`
        });
      }
    }
      /**
       * 真机 2026-09-23：`service_tier: flex` 不支持视频生成（400），前置拒绝。
       * 判定收在 gen/params.ts（纯函数，带单测），避免各入口各写一遍口径。
       */
      const tierRejection = serviceTierRejectionReason(input.serviceTier);
      if (tierRejection) {
        throw new TRPCError({ code: "BAD_REQUEST", message: tierRejection });
      }
      const maxSeconds = chosen.limits?.durationSec?.max ?? 15;
      const minSeconds = chosen.limits?.durationSec?.min ?? 4;
    const durationSec = Math.min(maxSeconds, Math.max(minSeconds, Math.round(requestedSeconds)));
    const clamped = durationSec !== Math.round(requestedSeconds);
    const durationProvenance = {
      source:
        input.durationSec !== undefined
          ? ("request" as const)
          : planned.seconds === null
            ? ("estimate-fallback" as const)
            : planned.source!,
      planSeconds: planned.seconds,
      requestedSeconds: Number.isFinite(requestedSeconds) ? Math.round(requestedSeconds) : null,
      mismatchSeconds: planned.seconds === null ? null : Math.round(requestedSeconds) - planned.seconds,
      strict: strictDuration
    };

      const monthStart = new Date();
      monthStart.setDate(1); monthStart.setHours(0, 0, 0, 0);
      const usageRows = await scopedQuery<{ total: string | null }>(
        app, scope,
        `SELECT COALESCE(SUM((payload->'decision'->'after'->>'estimated_seconds')::numeric),0)::text AS total
         FROM biz_events
         WHERE workspace_id=$1 AND payload->'decision'->>'action'='render.submit'
           AND (payload->'context'->>'time')::timestamptz >= $2`,
        [scope.workspaceId, monthStart.toISOString()],
      );
      const usedSeconds = Number(usageRows[0]?.total ?? 0);
      const budget = checkRenderBudget({
        plan: planTierToPlanId(ctx.identity.plan),
        usedSeconds,
        requestSeconds: durationSec,
        allowOverage: input.allowOverage,
      });
      if (!budget.allowed) {
        throw new TRPCError({ code: "PRECONDITION_FAILED", message: budget.reason ?? "渲染额度不足" });
      }

      // ── 成本上限闸（T-2026-0921-0002）：秒数配额之外再压一道"真金白银"闸（USD/CNY） ──
      const est = estimateCost(chosen, { seconds: durationSec });
      const spend = await renderSpendCny(app, scope);
      const capCheck = checkCostCaps({
        spentDayCny: spend.day, spentMonthCny: spend.month, estCny: est.cny, caps: costCaps(),
      });
      if (!capCheck.allowed) {
        throw new TRPCError({ code: "PRECONDITION_FAILED", message: capCheck.reason ?? "渲染成本超出上限" });
      }

      // ── 提交（唯一写入口 submitGenJob）：幂等键去重 + 供应商降级链 + 参数 + 报价 + D16 同事务 ──
      const submitted = await submitGenJob({
        app,
        gateway: getGatewayPool(),
        scope,
        actor: ctx.identity.memberNo,
        script: {
          id: script.id, project_id: script.project_id, shot_id: script.shot_id,
          script_key: script.script_key, version: script.version, status: script.status,
          md: script.md, fields: script.fields as Record<string, unknown> | null,
        },
        modelId,
        mode: input.mode,
        params: {
          durationSec,
          aspectRatio: input.aspectRatio,
          resolution: input.resolution,
          generateAudio: input.generateAudio,
          firstFrameUrl: input.firstFrameUrl,
          referenceImageUrls: input.referenceImageUrls,
          referenceVideoUrls: input.referenceVideoUrls,
          referenceAudioUrls: input.referenceAudioUrls,
          seed: input.seed,
          watermark: input.watermark,
          cameraFixed: input.cameraFixed,
          returnLastFrame: input.returnLastFrame,
          serviceTier: input.serviceTier,
        },
        /** 幂等键：同脚本 + 同模型 + 同时长 + 同模式重复点击不会重复扣费 */
        idempotencyKey: input.idempotencyKey?.trim() || `render:${script.id}:${chosen.id}:${durationSec}:${input.mode}`,
      fenceLevel: verdict.level,
      fenceImpacts: verdict.impacts,
      budgetOverageSeconds: budget.overageSeconds,
      durationProvenance
    });

      return {
        jobId: submitted.jobId,
        taskId: submitted.taskId,
        mock: submitted.mock,
        provider: submitted.provider,
        providerModel: submitted.providerModel,
        estUsd: submitted.estUsd,
        estCny: submitted.estCny,
        deduped: submitted.deduped,
      durationSec,
      clamped,
      durationProvenance,
        level: verdict.level,
        budget: { usedSeconds, overageSeconds: budget.overageSeconds },
      };
    }),

  /** 渲染轮询回填（v3.0 异步任务制第二步）：submitted/rendering → done/failed + render.complete/failed 事件 */
  poll: writeProcedure
    .input(z.object({ limit: z.number().int().min(1).max(100).default(20) }).optional())
    .mutation(async ({ ctx, input }) => {
      return pollRenderJobs(getAppPool(), getGatewayPool(), scopeOf(ctx.identity), { limit: input?.limit });
    }),
});

/* ================= publish：全平台 RPA 发布（§7，G9） ================= */

/**
 * G9 围栏上下文（T-2026-0921-0002 修复）：
 * 基线规则 G9a 读 `context.platform_first_use`、G9b 读 `context.account_daily_published`；
 * 旧实现未提供这两个值 → 求值异常 → fail-closed（block），发布任务永远建不出来。
 * 这里按"该账号当日已成功发布数"和"该账号在该平台是否已成功发布过"补齐上下文。
 */
async function publishFenceContext(
  app: AppPool, scope: Scope, accountId: string, platform: string,
): Promise<{ account_daily_published: number; platform_first_use: boolean }> {
  const rows = await scopedQuery<{ day: string; ever: string }>(
    app, scope,
    `SELECT
       (SELECT count(*) FROM publish_tasks
         WHERE workspace_id=$1 AND account_id=$2 AND status='succeeded'
           AND executed_at >= (date_trunc('day', now() AT TIME ZONE 'Asia/Shanghai') AT TIME ZONE 'Asia/Shanghai'))::text AS day,
       (SELECT count(*) FROM publish_tasks
         WHERE workspace_id=$1 AND account_id=$2 AND platform=$3 AND status='succeeded')::text AS ever`,
    [scope.workspaceId, accountId, platform],
  );
  return {
    account_daily_published: Number(rows[0]?.day ?? 0),
    platform_first_use: Number(rows[0]?.ever ?? 0) === 0,
  };
}

const publishRouter = router({
  /**
   * 发布任务入队（G9 围栏预检：block 直接 403 不入队；auto/review 入队 pending——
   * 执行时由 publish-rpa runner 复核 G9，非 auto 挂起 pending_review 待审，适配器不执行）
   */
  createTask: writeProcedure
    .input(z.object({
      platform: PlatformSchema,
      accountId: z.string().min(1),
      assetId: z.string().min(1).optional(),
      videoPath: z.string().min(1),
      coverPath: z.string().min(1).optional(),
      caption: z.string().max(2000).default(""),
      tags: z.array(z.string()).default([]),
      scheduleAt: z.iso.datetime({ offset: true }).optional(),
    }))
    .mutation(async ({ ctx, input }) => {
      const scope = scopeOf(ctx.identity);
      const app = getAppPool();
      const { rules, defaultLevel } = await loadActiveRules(app, scope);
      const fenceContext = await publishFenceContext(app, scope, input.accountId, input.platform);
      const verdict = judge({
        object: { type: "publish_task", id: "PT-new" },
        action: "publish.execute",
        params: { platform: input.platform, accountId: input.accountId, scheduleAt: input.scheduleAt ?? null },
        context: fenceContext,
      }, rules, defaultLevel);
      if (verdict.level === "block") {
        throw new TRPCError({
          code: "FORBIDDEN",
          message: `G9 围栏熔断：${verdict.triggeredBy.join("；") || "publish.execute 命中 block 规则"}（公网发布必审基线）`,
        });
      }
      // 唯一写入点（gen/publish.createPublishTask）：行与事件同一事务
      const created = await createPublishTask(app, getGatewayPool(), scope, {
        platform: input.platform,
        accountId: input.accountId,
        assetId: input.assetId ?? null,
        videoPath: input.videoPath,
        coverPath: input.coverPath ?? null,
        caption: input.caption,
        tags: input.tags,
        scheduleAt: input.scheduleAt ?? null,
        origin: "manual",
        by: ctx.identity.memberNo,
      });
      return { taskId: created.taskId, level: verdict.level };
    }),

  /**
   * 发布执行（T-2026-0921-0002）：G9 复核 → 日上限 → 适配器（本进程为 dry-run 驱动）。
   * 真实平台上传需桌面端 Playwright 驱动 + 用户本人登录态；本接口只把"执行机制"跑通并留痕，
   * 回执固定 synced:false + driver:"dry-run"（不冒充真实发布，不变量 9）。
   * 测试开关 PUBLISH_TEST_FENCE_OVERRIDE=1（仅非 production + dry-run 生效）用于把机制跑通，
   * 生效力时后续追加 publish.test_override 事件留痕。
   */
  run: writeProcedure
    .input(z.object({ taskId: z.string().min(1), dailyLimit: z.number().int().min(1).max(20).optional() }))
    .mutation(async ({ ctx, input }) => {
      const scope = scopeOf(ctx.identity);
      const app = getAppPool();
      const { rules, defaultLevel } = await loadActiveRules(app, scope);
      const taskRows = await scopedQuery<{ account_id: string; platform: string }>(
        app, scope,
        `SELECT account_id, platform FROM publish_tasks WHERE workspace_id=$1 AND id=$2`,
        [scope.workspaceId, input.taskId],
      );
      const task = taskRows[0];
      const fenceContext = task
        ? await publishFenceContext(app, scope, task.account_id, task.platform)
        : { account_daily_published: 0, platform_first_use: true };
      let overrideUsed = false;
      const fencePrecheck = (judgeInput: Parameters<typeof judge>[0]) => {
        const verdict = judge({ ...judgeInput, context: { ...(judgeInput.context ?? {}), ...fenceContext } }, rules, defaultLevel);
        if (verdict.level !== "auto" && fenceOverrideEnabled()) {
          overrideUsed = true;
          return { ...verdict, level: "auto" as const };
        }
        return verdict;
      };
      const outcome = await executePublishTask(app, getGatewayPool(), scope, input.taskId, {
        fencePrecheck, dailyLimit: input.dailyLimit,
      });
      if (overrideUsed && outcome.kind === "executed") {
        const client = await getGatewayPool().connect();
        try {
          await client.query("BEGIN");
          await client.query("SELECT set_config('app.workspace_id', $1, true)", [scope.workspaceId]);
          await client.query("SELECT set_config('app.tenant_id', $1, true)", [scope.tenantId]);
          await gatewayAppendOnClient(client, { ...scope, actor: { id: ctx.identity.memberNo, type: "human" } }, {
            who: { type: "human", id: ctx.identity.memberNo },
            context: { tenant_id: scope.tenantId, workspace_id: scope.workspaceId, time: new Date().toISOString(), channel: "inapp" },
            object: { type: "publish_task", id: input.taskId },
            decision: {
              action: "publish.test_override",
              after: { taskId: input.taskId, driver: outcome.driver, override: true, calls: outcome.calls?.slice(0, 12) ?? [] },
              basis: ["测试专用围栏放行（PUBLISH_TEST_FENCE_OVERRIDE=1，非 production）：仅用于验证发布执行机制，dry-run 回执已标 synced:false"],
            },
            rule_impact: [],
          });
          await client.query("COMMIT");
        } catch (err) {
          await client.query("ROLLBACK").catch(() => undefined);
          throw err;
        } finally {
          client.release();
        }
      }
      return { ...outcome, overrideUsed };
    }),
});

/* ================= metrics：近 7 天指标聚合 ================= */

const metricsRouter = router({
  /** 近 7 天 account_metrics 聚合（按平台+账号分组；越权返回空 L7.1） */
  overview: protectedProcedure.query(async ({ ctx }) => {
    const scope = scopeOf(ctx.identity);
    const rows = await scopedQuery<{
      platform: string; account_id: string;
      plays: string; likes: string; comments: string; shares: string; conversions: string;
      samples: string; last_captured_at: string;
    }>(
      getAppPool(), scope,
      `SELECT platform, account_id,
              SUM(plays)::text AS plays, SUM(likes)::text AS likes, SUM(comments)::text AS comments,
              SUM(shares)::text AS shares, SUM(conversions)::text AS conversions,
              COUNT(*)::text AS samples, MAX(captured_at) AS last_captured_at
       FROM account_metrics
       WHERE workspace_id=$1 AND captured_at >= now() - interval '7 days'
       GROUP BY platform, account_id
       ORDER BY platform, account_id`,
      [scope.workspaceId],
    );
    return { windowDays: 7, rows };
  }),
});

/* ================= comments：待处理评论队列（G10） ================= */

const commentsRouter = router({
  /** 待处理评论队列（new/pending_review）+ G10 分流级别随行（route_level） */
  pending: protectedProcedure
    .input(z.object({ limit: z.number().int().min(1).max(200).default(100) }))
    .query(async ({ ctx, input }) => {
      const scope = scopeOf(ctx.identity);
      return scopedQuery<{
        id: string; platform: string; account_id: string; video_id: string | null;
        author: string | null; text: string; intent: string | null;
        route_level: string | null; status: string; collected_at: string;
      }>(
        getAppPool(), scope,
        `SELECT id, platform, account_id, video_id, author, text, intent, route_level, status, collected_at
         FROM comments
         WHERE workspace_id=$1 AND status IN ('new','pending_review')
         ORDER BY collected_at DESC
         LIMIT $2`,
        [scope.workspaceId, input.limit],
      );
    }),
});

/* ================= gen：模型目录 / 报价 / 任务 / 成片（T-2026-0921-0002） ================= */

const genRouter = router({
  /**
   * 模型目录：默认只列"运行时可提交"的模型（wired + 密钥就绪）；
   * includeUnavailable=true 可看全量（含 catalog-only，UI 明确标注"未接入"）。
   */
  catalog: protectedProcedure
    .input(z.object({
      kind: z.enum(["video", "image", "audio"]).optional(),
      mode: z.enum(["t2v", "i2v", "r2v", "v2v", "t2i", "i2i", "lipsync", "audio"]).optional(),
      includeUnavailable: z.boolean().default(false),
      limit: z.number().int().min(1).max(200).default(60),
    }).optional())
    .query(({ input }) => ({
      models: listModels({
        kind: input?.kind,
        mode: input?.mode,
        onlyAvailable: !(input?.includeUnavailable ?? false),
      }).slice(0, input?.limit ?? 60),
      usdCnyRate: usdCnyRate(),
      caps: costCaps(),
    })),

  /** 报价 + 上限闸预览（提交前看钱；不写库） */
  estimate: protectedProcedure
    .input(z.object({
      modelId: z.string().min(1),
      seconds: z.number().int().min(1).max(120).optional(),
      images: z.number().int().min(1).max(20).optional(),
    }))
    .query(async ({ ctx, input }) => {
      const model = getModel(input.modelId);
      if (!model) throw new TRPCError({ code: "BAD_REQUEST", message: `模型目录中不存在「${input.modelId}」` });
      const estimate = estimateCost(model, { seconds: input.seconds, images: input.images });
      const scope = scopeOf(ctx.identity);
      const spend = await renderSpendCny(getAppPool(), scope);
      const caps = costCaps();
      const gate = checkCostCaps({
        spentDayCny: spend.day, spentMonthCny: spend.month, estCny: estimate.cny, caps,
      });
      return {
        model: {
          id: model.id, name: model.name, provider: model.provider, tier: model.tier,
          modes: model.modes, limits: model.limits ?? null,
          available: model.availability === "wired", notes: model.notes ?? null,
        },
        estimate,
        spend: { dayCny: spend.day, monthCny: spend.month, caps },
        allowed: gate.allowed,
        reason: gate.reason ?? null,
      };
    }),

  /** 任务队列（工作室页数据源）：模型/成本/状态/成片播放地址 */
  jobs: protectedProcedure
    .input(z.object({
      projectId: z.string().min(1).optional(),
      limit: z.number().int().min(1).max(100).default(30),
    }))
    .query(async ({ ctx, input }) => {
      const scope = scopeOf(ctx.identity);
      const rows = await scopedQuery<{
        id: string; project_id: string; script_id: string; script_version: number;
        task_id: string | null; status: string; provider: string | null; provider_model: string | null;
        est_usd: string | null; est_cny: string | null; actual_usd: string | null; actual_cny: string | null;
        est_seconds: number | null; actual_seconds: number | null; mock: boolean; asset_id: string | null;
        result_url: string | null; idempotency_key: string | null; created_at: string; updated_at: string;
        script_key: string | null; local_path: string | null; asset_kind: string | null;
      }>(
        getAppPool(), scope,
        `SELECT j.id, j.project_id, j.script_id, j.script_version, j.task_id, j.status,
                j.provider, j.provider_model, j.est_usd, j.est_cny, j.actual_usd, j.actual_cny,
                j.est_seconds, j.actual_seconds, j.mock, j.asset_id, j.result_url, j.idempotency_key,
                j.created_at, j.updated_at,
                s.script_key, a.meta->>'localPath' AS local_path, a.kind AS asset_kind
           FROM render_jobs j
           LEFT JOIN render_scripts s ON s.id = j.script_id AND s.workspace_id = j.workspace_id
           LEFT JOIN video_assets a ON a.id = j.asset_id AND a.workspace_id = j.workspace_id
          WHERE j.workspace_id = $1 AND ($2::text IS NULL OR j.project_id = $2)
          ORDER BY j.created_at DESC
          LIMIT $3`,
        [scope.workspaceId, input.projectId ?? null, input.limit],
      );
      return rows.map((r) => ({
        ...r,
        est_usd: r.est_usd === null ? null : Number(r.est_usd),
        est_cny: r.est_cny === null ? null : Number(r.est_cny),
        actual_usd: r.actual_usd === null ? null : Number(r.actual_usd),
        actual_cny: r.actual_cny === null ? null : Number(r.actual_cny),
        /** 已入库成片 → 签名播放入口；未入库 → 供应商原始 URL（7 天内有效，UI 标注） */
        playUrl: r.local_path ? mediaUrl(r.local_path) : (r.result_url ?? null),
        playUrlKind: r.local_path ? "library" as const : (r.result_url ? "provider" as const : null),
      }));
    }),

  /** 成片播放/下载签名 URL（仅已入库成片；TTL 可调） */
  mediaUrl: protectedProcedure
    .input(z.object({ jobId: z.string().min(1), ttlSec: z.number().int().min(60).max(86_400).default(3600) }))
    .query(async ({ ctx, input }) => {
      const scope = scopeOf(ctx.identity);
      const rows = await scopedQuery<{ local_path: string | null; asset_id: string | null }>(
        getAppPool(), scope,
        `SELECT a.meta->>'localPath' AS local_path, j.asset_id
           FROM render_jobs j
           LEFT JOIN video_assets a ON a.id = j.asset_id AND a.workspace_id = j.workspace_id
          WHERE j.workspace_id = $1 AND j.id = $2`,
        [scope.workspaceId, input.jobId],
      );
      const localPath = rows[0]?.local_path ?? null;
      if (!localPath) {
        throw new TRPCError({ code: "NOT_FOUND", message: `任务 ${input.jobId} 的成片尚未入库（先跑 video.render.poll 完成回填与入库）` });
      }
      return { url: mediaUrl(localPath, input.ttlSec), expiresInSec: input.ttlSec };
    }),
});

export const videoRouter = router({
  studio: studioRouter,
  cms: cmsRouter,
  render: renderRouter,
  gen: genRouter,
  publish: publishRouter,
  metrics: metricsRouter,
  comments: commentsRouter,
  deal: dealRouter,
  accounting: accountingRouter,
  delivery: deliveryRouter,
});
