/**
 * explainer/router.ts —— 口播解说片 tRPC 路由（video.explainer.*）· T-2026-0926-0008
 *
 * 与既有链路的接法（spec §7，**零平行实现**）：
 *   create    → 建 kind='explainer' 项目 + shotbook v1（draft，五元事件留痕）
 *   saveScript→ 改稿 = 新版本（版本链只增不改；上一版 approval 不继承）
 *   shotbook  → 规则/LLM 产数据 + 确定性校验 → 新版本（validated）
 *   submit    → 准备段（配音 → 对齐 → 语义 → 分镜 → 装配 → 素材体检）→ G8 围栏 + 额度预算
 *               → `submitGenJob(modelId='remotion-talkcraft')`；渲染与回填交给既有 render-poller
 *   finalize  → 渲染 done 后：机器闸六条 → 两遍 loudnorm → 媒资库 final_cut（registerLocalAsset）
 *   versions / engine → 版本链只读面 + 引擎体检
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { getAppPool, getGatewayPool } from "@workloom/db";
import { judge, type RuntimeRule } from "@workloom/base/fence-engine";
import { checkRenderBudget, planTierToPlanId } from "@workloom/base/model-router";
import { approve as approveRenderScript, create as createRenderScript } from "@workloom/base/asset-cms";
import { protectedProcedure, router, scopeOf, writeProcedure } from "../../trpc/context.js";
import { submitGenJob, type RenderScriptLike } from "../gen/submit.js";
import { submissionRequestHash } from "../gen/submission-ledger.js";
import { registerLocalAsset } from "../media/register-local.js";
import { loadActiveRules } from "../router.js";
import { buildCardRegistry } from "./card-registry.js";
import { engineDirOf, engineStatus } from "./engine.js";
import { runMachineGates } from "./qa-gates.js";
import { deliverFilm } from "./deliver.js";
import { runExplainerPipeline } from "./pipeline.js";
import { generateShotbook, validateShotbook } from "./shotbook.js";
import { annotateSemantics } from "./semantics.js";
import { templateDirOf } from "./project-builder.js";
import { textFingerprint } from "./voice-prep.js";
import {
  createExplainerProject, insertShotbook, latestShotbook, projectOf, renderJobOf, scopedQuery, updateShotbook,
  type ShotbookRow,
} from "./db.js";
import { ExplainerQualitySchema, explainerOutputSize, ExplainerScriptSchema, type ExplainerQuality, type ExplainerShotbook } from "./types.js";

function renderKey(shotbookId: string, version: number, quality: ExplainerQuality): string {
  const base = `explainer:${shotbookId}:v${version}`;
  return quality === "hd" ? base : `${base}:uhd`;
}

const explainerSavedParams = z.object({
  durationSec: z.number().int().positive(), aspectRatio: z.string().min(1), resolution: z.string().min(1),
  generateAudio: z.boolean(), extra: z.object({ jobDir: z.string().min(1), audioSeconds: z.number().positive(), scope: z.string().min(1) }),
});

const brandSchema = z.object({
  product: z.string().min(1).max(80),
  tone: z.string().min(1).max(120),
  accent: z.string().max(20).optional(),
  base: z.string().max(20).optional(),
  ink: z.string().max(20).optional(),
});

/** 口播稿文本 → 句子数组（空行分段，按句末标点切句；保留原标点） */
export function splitScript(text: string): { i: number; text: string }[] {
  const sentences: string[] = [];
  for (const paragraph of text.split(/\n+/)) {
    const clean = paragraph.trim();
    if (!clean) continue;
    const parts = clean.match(/[^。！？!?]+[。！？!?]?/g) ?? [clean];
    for (const part of parts) {
      const trimmed = part.trim();
      if (trimmed) sentences.push(trimmed);
    }
  }
  return sentences.map((sentence, index) => ({ i: index + 1, text: sentence }));
}

export const explainerRouter = router({
  /** 引擎体检（安装/运行时/许可口径/卡数）；不触库 */
  engine: protectedProcedure.query(() => {
    const status = engineStatus();
    return {
      engineDir: status.engineDir,
      installed: status.installed,
      ready: status.ready,
      reason: status.reason,
      cardCount: status.cardCount,
      runtimeInstalled: status.runtimeInstalled,
      runtimeReady: status.runtimeReady,
      license: status.license,
      pin: status.pin
        ? { commit: status.pin.commit, cards: status.pin.cards, runtimeVersion: status.pin.runtimeVersion, syncedAt: status.pin.syncedAt }
        : null,
    };
  }),

  /** 立项：建 kind='explainer' 项目 + shotbook v1（draft） */
  create: writeProcedure
    .input(z.object({
      intent: z.string().min(1).max(2000),
      scriptText: z.string().min(1).max(20000),
      aspect: z.enum(["9:16", "16:9"]).default("9:16"),
      brand: brandSchema.optional(),
    }))
    .mutation(async ({ ctx, input }) => {
      const scope = scopeOf(ctx.identity);
      const script = ExplainerScriptSchema.parse({ sentences: splitScript(input.scriptText) });
      const projectId = await createExplainerProject(scope, { intent: input.intent, by: ctx.identity.memberNo });
      const shotbookId = await insertShotbook(scope, {
        projectId,
        version: 1,
        status: "draft",
        scriptText: input.scriptText,
        scriptSha256: textFingerprint(input.scriptText),
        shotbook: emptyShotbook(input.brand?.product ?? input.intent.slice(0, 20), input.brand),
        by: ctx.identity.memberNo,
      });
      return { projectId, shotbookId, version: 1, sentences: script.sentences.length, aspect: input.aspect };
    }),

  /** 改稿：新版本（draft） */
  saveScript: writeProcedure
    .input(z.object({
      projectId: z.string().min(1).max(120),
      scriptText: z.string().min(1).max(20000),
      brand: brandSchema.optional(),
    }))
    .mutation(async ({ ctx, input }) => {
      const scope = scopeOf(ctx.identity);
      const project = await projectOf(scope, input.projectId);
      if (!project) throw new TRPCError({ code: "NOT_FOUND", message: `项目不存在：${input.projectId}` });
      if (project.kind !== "explainer") {
        throw new TRPCError({ code: "PRECONDITION_FAILED", message: `项目 ${input.projectId} 不是口播解说片（kind=${project.kind}）` });
      }
      const latest = await latestShotbook(scope, input.projectId);
      const version = (latest?.version ?? 0) + 1;
      const script = ExplainerScriptSchema.parse({ sentences: splitScript(input.scriptText) });
      const shotbookId = await insertShotbook(scope, {
        projectId: input.projectId,
        version,
        status: "draft",
        scriptText: input.scriptText,
        scriptSha256: textFingerprint(input.scriptText),
        shotbook: emptyShotbook(input.brand?.product ?? project.title.slice(0, 20), input.brand),
        by: ctx.identity.memberNo,
      });
      return { shotbookId, version, sentences: script.sentences.length };
    }),

  /**
   * 生成 SHOTBOOK（数据层）。
   *
   * 此阶段还没有配音：字级时间戳按"每字 0.22s"**估算**，只用于选卡与时长配额；
   * 真实时间戳在 submit 段由对齐器产出（beats/anchors 同样以真时间戳为准）。
   */
  shotbook: writeProcedure
    .input(z.object({
      projectId: z.string().min(1).max(120),
      scriptText: z.string().min(1).max(20000),
      aspect: z.enum(["9:16", "16:9"]).default("9:16"),
      brand: brandSchema.optional(),
      allowRuleFallback: z.boolean().default(true),
    }))
    .mutation(async ({ ctx, input }) => {
      const scope = scopeOf(ctx.identity);
      const engineDir = engineDirOf();
      const status = engineStatus(engineDir);
      if (!status.installed) {
        throw new TRPCError({ code: "PRECONDITION_FAILED", message: `talkcraft 引擎未安装：${status.reason}` });
      }
      const script = ExplainerScriptSchema.parse({ sentences: splitScript(input.scriptText) });
      const timestamps = estimateTimestamps(script);
      const semantics = await annotateSemantics({ script, timestamps });
      const registry = buildCardRegistry(engineDir, { whitelist: whitelistOf() });
      const latest = await latestShotbook(scope, input.projectId);
      const version = (latest?.version ?? 0) + 1;
      const generated = await generateShotbook({
        script, timestamps, semantics: semantics.semantics, registry, engineDir,
        aspect: input.aspect, brand: input.brand,
        fallback: input.allowRuleFallback ? "rule" : "error",
      });
      const check = validateShotbook({ shotbook: generated.shotbook, script, timestamps, registry, engineDir });
      if (!check.ok) {
        throw new TRPCError({
          code: "PRECONDITION_FAILED",
          message: `分镜校验失败：${check.errors.slice(0, 3).map((e) => e.message).join("；")}`,
        });
      }
      const shotbookId = await insertShotbook(scope, {
        projectId: input.projectId,
        version,
        status: "validated",
        scriptText: input.scriptText,
        scriptSha256: textFingerprint(input.scriptText),
        shotbook: generated.shotbook,
        enginePin: enginePinOf(),
        by: ctx.identity.memberNo,
      });
      return {
        shotbookId, version, via: generated.via, shots: generated.shotbook.shots.length,
        warnings: check.warnings.map((w) => `${w.shotId ?? "-"}:${w.message}`),
        estimatedSeconds: timestamps.total,
      };
    }),

  /** 提交渲染：准备段 + G8 + 生成任务（轮询由 render-poller 接管） */
  submit: writeProcedure
    .input(z.object({
      projectId: z.string().min(1).max(120),
      shotbookId: z.string().min(1).max(120).optional(),
      voiceSource: z.enum(["tts", "upload"]).default("tts"),
      voiceProfile: z.string().max(120).optional(),
      uploadPath: z.string().max(1024).optional(),
      uploadConfirmed: z.boolean().default(false),
      hostAssets: z.record(z.string(), z.string()).optional(),
      assets: z.array(z.object({ from: z.string().max(1024), to: z.string().max(512) })).optional(),
      renderScope: z.string().max(120).default("full"),
      quality: ExplainerQualitySchema.default("hd"),
      allowOverage: z.boolean().default(false),
    }))
    .mutation(async ({ ctx, input }) => {
      const scope = scopeOf(ctx.identity);
      const project = await projectOf(scope, input.projectId);
      if (!project) throw new TRPCError({ code: "NOT_FOUND", message: `项目不存在：${input.projectId}` });
      const row: ShotbookRow | null = input.shotbookId
        ? await shotbookById(scope, input.shotbookId)
        : await latestShotbook(scope, input.projectId);
      if (!row) throw new TRPCError({ code: "PRECONDITION_FAILED", message: "没有可用的分镜版本（先跑 video.explainer.shotbook）" });
      if (row.project_id !== input.projectId || project.kind !== "explainer") {
        throw new TRPCError({ code: "NOT_FOUND", message: "分镜不属于当前解说项目" });
      }
      if (row.shotbook.shots.some((s) => s.card === "placeholder")) {
        throw new TRPCError({ code: "PRECONDITION_FAILED", message: "该版本还是占位分镜（card=placeholder）——先生成 SHOTBOOK" });
      }
      const idempotencyKey = renderKey(row.id, row.version, input.quality);
      // HD retains its existing script identity; UHD has a separate immutable request.
      const scriptKey = `explainer-${row.id}${input.quality === "uhd" ? "-uhd" : ""}`;
      const md = `# 口播解说片 ${row.id} v${row.version}\n\n${row.script_text}`;
      const size = explainerOutputSize("9:16", input.quality);
      const resolution = `${size.width}x${size.height}`;
      // Keep the historical HD hash stable for an already accepted request.
      // Each quality still binds its own voice, assets, scope and prepared params.
      const submissionInputHash = submissionRequestHash({
        scope, projectId: input.projectId, shotbookId: row.id, version: row.version,
        scriptText: row.script_text, shotbook: row.shotbook,
        voiceSource: input.voiceSource, voiceProfile: input.voiceProfile ?? null,
        uploadPath: input.uploadPath ?? null, uploadConfirmed: input.uploadConfirmed,
        hostAssets: input.hostAssets ?? {}, assets: input.assets ?? [], renderScope: input.renderScope,
        ...(input.quality === "uhd" ? { quality: input.quality } : {}),
      });
      const otherQuality = input.quality === "hd" ? "uhd" : "hd";
      const otherJob = await renderJobOf(scope, renderKey(row.id, row.version, otherQuality));
      if (otherJob && !["done", "failed"].includes(otherJob.status)) {
        throw new TRPCError({ code: "PRECONDITION_FAILED", message: `同一分镜版本的 ${otherQuality} 渲染仍在运行，请先完成该任务` });
      }
      const existingScripts = await scopedQuery<RenderScriptLike>(
        `SELECT s.* FROM render_scripts s JOIN workspaces w ON w.id=s.workspace_id
          WHERE s.workspace_id=$1 AND s.script_key=$2 AND w.tenant_id=$3 AND s.project_id=$4
          ORDER BY s.version DESC LIMIT 1`,
        [scope.workspaceId, scriptKey, scope.tenantId, input.projectId], scope,
      );
      let scriptRow = existingScripts[0];
      let params: { durationSec: number; aspectRatio: string; resolution: string; generateAudio: boolean;
        extra: { jobDir: string; audioSeconds: number; scope: string } };
      let lowMatch: number[];
      if (scriptRow) {
        if (scriptRow.md !== md || scriptRow.fields?.submissionInputHash !== submissionInputHash) {
          throw new TRPCError({ code: "CONFLICT", message: "该分镜已绑定其他或未核实的生成请求；请核对原任务，不得重做准备段或重发" });
        }
        params = explainerSavedParams.parse(scriptRow.fields?.submissionParams);
        if (params.resolution !== resolution) {
          throw new TRPCError({ code: "CONFLICT", message: "已绑定渲染请求的画布尺寸与当前清晰度不符" });
        }
        lowMatch = z.array(z.number().int()).parse(scriptRow.fields?.lowMatch);
      } else {
        const script = ExplainerScriptSchema.parse({ sentences: splitScript(row.script_text) });

        /* ---- 准备段（配音 → 对齐 → 语义 → 装配 → 素材体检） ---- */
        let prepared: Awaited<ReturnType<typeof runExplainerPipeline>>;
        try {
          prepared = await runExplainerPipeline({
            taskId: `${row.id}-v${row.version}${input.quality === "uhd" ? "-uhd" : ""}`,
            script,
            shotbook: row.shotbook,
            quality: input.quality,
            voice: {
              source: input.voiceSource,
              profile: input.voiceProfile,
              uploadPath: input.uploadPath,
              confirmed: input.uploadConfirmed,
            },
            hostAssets: input.hostAssets,
            assets: input.assets,
            stopAfterAssemble: true,
            onLog: (line) => console.log(`[explainer:prepare] ${line}`),
          });
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          await updateShotbook(scope, row.id, { status: "failed" });
          throw new TRPCError({ code: "PRECONDITION_FAILED", message: `准备段失败：${message}` });
        }
        await updateShotbook(scope, row.id, {
          jobDir: prepared.jobDir,
          timestampsRef: "audio/timestamps.json",
          timingRef: "remotion/src/timing.json",
          audioRef: "audio/full.wav",
          voiceRef: { source: input.voiceSource, profile: input.voiceProfile ?? null, sha256: prepared.voice.sha256 },
        });

        params = {
          durationSec: Math.max(1, Math.round(prepared.timestamps.total)),
          aspectRatio: "9:16", resolution, generateAudio: false,
          extra: { jobDir: prepared.jobDir, audioSeconds: prepared.timestamps.total, scope: input.renderScope },
        };
        lowMatch = prepared.timestamps.sentences.filter((sentence) => !sentence.ok).map((sentence) => sentence.i);
      }
      const durationSec = params.durationSec;

      /* ---- G8 围栏 + 渲染额度预算（与 video.render.submit 同口径） ---- */
      const active = await loadActiveRules(getAppPool(), scope);
      const verdict = judge(
        {
          action: "render.submit",
          object: { type: "video_project", id: input.projectId },
          context: { render_auto: false, duration_sec: durationSec },
        },
        active.rules as RuntimeRule[],
        active.defaultLevel,
      );
      if (verdict.level === "block") {
        throw new TRPCError({
          code: "FORBIDDEN",
          message: `G8 围栏熔断：${verdict.triggeredBy.join("；") || "render.submit 命中 block 规则"}`,
        });
      }
      const budget = checkRenderBudget({
        plan: planTierToPlanId(ctx.identity.plan),
        usedSeconds: await usedSecondsThisMonth(scope),
        requestSeconds: durationSec,
        allowOverage: input.allowOverage,
      });
      if (!budget.allowed) throw new TRPCError({ code: "PRECONDITION_FAILED", message: budget.reason ?? "渲染额度不足" });

      /* ---- 每个清晰度绑定一个不可变渲染请求；重试复用原版本 ---- */
      if (!scriptRow) {
        scriptRow = await createRenderScript(getAppPool(), getGatewayPool(), scope, {
          scriptKey, projectId: input.projectId, shotId: "full", md,
          fields: { kind: "explainer", shotbookId: row.id, version: row.version,
            durationSec, aspect: "9:16", quality: input.quality, ...size,
            submissionInputHash, submissionParams: params, lowMatch },
          by: ctx.identity.memberNo,
        });
      }
      if (scriptRow.status === "draft") {
        const approved = await approveRenderScript(getAppPool(), getGatewayPool(), scope, scriptKey, scriptRow.version, { by: ctx.identity.memberNo });
        scriptRow = approved.script;
      }

      /* ---- 生成任务（provider=remotion-local；工程目录是唯一事实源） ---- */
      const submitted = await submitGenJob({
        app: getAppPool(), gateway: getGatewayPool(), scope,
        actor: ctx.identity.memberNo,
        script: { ...scriptRow, fields: scriptRow.fields },
        modelId: "remotion-talkcraft",
        params,
        mode: "manual",
        idempotencyKey,
        fenceLevel: verdict.level,
        fenceImpacts: verdict.impacts,
        env: process.env,
      });
      await updateShotbook(scope, row.id, {
        status: "rendered", jobDir: params.extra.jobDir,
        renderScope: { mode: input.renderScope, quality: input.quality },
      });
      return {
        ...submitted,
        shotbookId: row.id,
        version: row.version,
        jobDir: params.extra.jobDir,
        idempotencyKey,
        durationSec,
        lowMatch,
        quality: input.quality,
        resolution,
      };
    }),

  /** 收尾：渲染完成 → 机器闸 → 两遍 loudnorm → 媒资库 final_cut */
  finalize: writeProcedure
    .input(z.object({ projectId: z.string().min(1).max(120), shotbookId: z.string().min(1).max(120).optional() }))
    .mutation(async ({ ctx, input }) => {
      const scope = scopeOf(ctx.identity);
      const row = input.shotbookId ? await shotbookById(scope, input.shotbookId) : await latestShotbook(scope, input.projectId);
      if (!row || row.project_id !== input.projectId) throw new TRPCError({ code: "NOT_FOUND", message: "没有当前项目的分镜版本" });
      if (!row.job_dir || !existsSync(row.job_dir)) {
        throw new TRPCError({ code: "PRECONDITION_FAILED", message: "该版本还没跑过 submit（工程目录不在场）" });
      }
      const manifest = JSON.parse(readFileSync(join(row.job_dir, "job.json"), "utf8")) as { quality?: unknown; aspect?: "9:16" | "16:9" };
      const quality = ExplainerQualitySchema.parse(manifest.quality ?? "hd");
      const aspect = manifest.aspect ?? "9:16";
      const job = await renderJobOf(scope, renderKey(row.id, row.version, quality));
      if (!job) throw new TRPCError({ code: "PRECONDITION_FAILED", message: "找不到渲染任务（先 submit）" });
      if (job.status !== "done") {
        return {
          ready: false as const,
          status: job.status,
          jobId: job.id,
          hint: job.status === "failed"
            ? "渲染失败：看 render.failed 事件与 out/status.json"
            : "仍在渲染（render-poller 负责回填），稍后再调 finalize",
        };
      }
      const engineDir = engineDirOf();
      const cards = [...new Set(row.shotbook.shots.map((s) => s.card))];
      const cuesPath = join(row.job_dir, "remotion", "cues.json");
      const cueCount = existsSync(cuesPath) ? (JSON.parse(readFileSync(cuesPath, "utf8")) as unknown[]).length : 0;
      const { report } = await runMachineGates({
        jobDir: row.job_dir, cards, cueCount, engineDir,
        aspect,
        quality,
        shots: JSON.parse(readFileSync(join(row.job_dir, "remotion", "shots.json"), "utf8")) as Array<{ id: string; start: number; end: number }>,
        onLog: (line) => console.log(`[explainer:finalize] ${line}`),
      });
      await updateShotbook(scope, row.id, { qaReport: report });
      if (!report.pass) {
        throw new TRPCError({
          code: "PRECONDITION_FAILED",
          message: `机器闸未过（P0 禁止交付）：${report.gates.filter((g) => g.status === "fail").map((g) => `${g.gate}(${g.summary})`).join("；")}`,
        });
      }
      const delivery = await deliverFilm({ jobDir: row.job_dir });
      const registered = await registerLocalAsset(getAppPool(), getGatewayPool(), scope, {
        absPath: delivery.deliveryPath,
        kind: "final_cut",
        projectId: input.projectId,
        title: `${row.shotbook.style.domain} · 口播解说片 v${row.version}`,
        tags: ["口播", "解说", row.shotbook.style.domain],
        prompt: row.script_text.slice(0, 4000),
        pipelineKind: "explainer",
        provenance: {
          shotbookId: row.id, version: row.version, jobDir: row.job_dir,
          enginePin: row.engine_pin, loudnorm: delivery.measurement, qaPass: report.pass,
          quality, resolution: explainerOutputSize(aspect, quality),
        },
        by: ctx.identity.memberNo,
      });
      await updateShotbook(scope, row.id, { status: "delivered" });
      return {
        ready: true as const,
        status: "delivered" as const,
        assetId: registered.assetId,
        sha256: registered.sha256,
        bytes: registered.bytes,
        gates: report.gates.map((g) => ({ gate: g.gate, status: g.status, summary: g.summary })),
        loudnorm: delivery.measurement,
      };
    }),

  /** 分镜版本链（只读面） */
  versions: protectedProcedure
    .input(z.object({ projectId: z.string().min(1).max(120) }))
    .query(async ({ ctx, input }) => {
      const scope = scopeOf(ctx.identity);
      return await scopedQuery<{ id: string; version: number; status: string; job_dir: string | null; created_at: string }>(
        `SELECT id, version, status, job_dir, created_at FROM explainer_shotbooks
          WHERE workspace_id=$1 AND project_id=$2 ORDER BY version DESC`,
        [scope.workspaceId, input.projectId], scope,
      );
    }),
});

/* ================= 内部工具 ================= */

async function shotbookById(scope: { tenantId: string; workspaceId: string }, id: string): Promise<ShotbookRow | null> {
  const rows = await scopedQuery<ShotbookRow>(
    `SELECT id, project_id, version, status, script_text, script_sha256, shotbook,
            timestamps_ref, timing_ref, audio_ref, job_dir, engine_pin, render_scope, qa_report, voice_ref
       FROM explainer_shotbooks WHERE workspace_id=$1 AND id=$2`,
    [scope.workspaceId, id], scope,
  );
  return rows[0] ?? null;
}

/** 白名单事实源：模板目录里的 cards.whitelist.json（与 project-builder 同一份） */
export function whitelistOf(): string[] {
  const path = join(templateDirOf(), "cards.whitelist.json");
  if (!existsSync(path)) return [];
  return (JSON.parse(readFileSync(path, "utf8")) as { slugs: string[] }).slugs;
}

function enginePinOf(): Record<string, unknown> {
  const status = engineStatus();
  return {
    commit: status.pin?.commit ?? null,
    cards: status.cardCount,
    runtimeVersion: status.pin?.runtimeVersion ?? null,
    licenseScope: status.license.scope,
  };
}

async function usedSecondsThisMonth(scope: { tenantId: string; workspaceId: string }): Promise<number> {
  const monthStart = new Date();
  monthStart.setDate(1);
  monthStart.setHours(0, 0, 0, 0);
  const rows = await scopedQuery<{ total: string | null }>(
    `SELECT COALESCE(SUM((payload->'decision'->'after'->>'estimated_seconds')::numeric),0)::text AS total
       FROM biz_events
      WHERE workspace_id=$1 AND payload->'decision'->>'action'='render.submit'
        AND (payload->'context'->>'time')::timestamptz >= $2`,
    [scope.workspaceId, monthStart.toISOString()], scope,
  );
  return Number(rows[0]?.total ?? 0);
}

/** 空分镜（create/saveScript 的占位；真分镜由 video.explainer.shotbook 生成） */
function emptyShotbook(
  product: string,
  brand?: { accent?: string; base?: string; ink?: string },
): ExplainerShotbook {
  return {
    style: {
      domain: product,
      tone: "待生成",
      palette: { base: brand?.base ?? "#0B1020", accent: brand?.accent ?? "#7A5AF8", ink: brand?.ink ?? "#F5F7FF" },
      font: "PingFang SC / Noto Sans SC",
      energy: "中",
    },
    rhythmTable: [{ shotId: "s01", hostForm: "无人物", container: "装框", card: "placeholder" }],
    shots: [{
      id: "s01", start: 0, end: 2, text: "待生成", card: "placeholder",
      content: {}, replace: [], skin: {}, material: { kind: "文" }, sfx: [], notes: "占位：尚未生成分镜",
    }],
  };
}

/**
 * 估算时间戳（shotbook 阶段还没有配音）：每字 0.22s、句间不留缝。
 * 只服务分镜选卡与时长配额；真时间戳在 submit 段产出（beats/anchors 也以真时间戳为准）。
 */
export function estimateTimestamps(script: { sentences: Array<{ i: number; text: string }> }): {
  sr: number;
  total: number;
  sentences: Array<{
    i: number; text: string; start: number; end: number; asr: string; match: number; ok: boolean;
    words: Array<{ text: string; start: number; end: number }>;
  }>;
} {
  let cursor = 0;
  const sentences = script.sentences.map((sentence) => {
    const seconds = Math.max(0.8, sentence.text.replace(/\s/g, "").length * 0.22);
    const start = cursor;
    cursor += seconds;
    const chars = [...sentence.text];
    const words = chars.map((ch, index) => ({
      text: ch,
      start: Math.round((start + (seconds * index) / chars.length) * 1000) / 1000,
      end: Math.round((start + (seconds * (index + 1)) / chars.length) * 1000) / 1000,
    }));
    return {
      i: sentence.i,
      text: sentence.text,
      start: Math.round(start * 1000) / 1000,
      end: Math.round(cursor * 1000) / 1000,
      asr: "",
      match: 1,
      ok: true,
      words,
    };
  });
  return { sr: 16000, total: Math.round(cursor * 1000) / 1000, sentences };
}
