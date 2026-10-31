/**
 * video/whiteboard/router.ts —— 手绘白板片编排路由（T-2026-0926-0020）
 *
 * 全链路（与规格书 §2.3 的环节链一致，差异逐条标注）：
 *
 *   口播稿 ──narrate──▶ 配音（本机工位，逐句真实时长）──▶ SRT ──plan──▶ 分幕
 *        ──lineart──▶ 逐幕线稿（seedream / sketch）──annotate──▶ 逐幕标注
 *        ──preview（确认关）──▶ 编号检查图 ──render──▶ 逐幕渲染 + 合并
 *        （经 submitGenJob + render-poller：台账 / 事件 / 成本 / 媒资 / 档案全部复用）
 *        ──deliver──▶ 两遍 loudnorm 混流 + 软字幕轨 ──▶ 媒资库 kind='final_cut'
 *
 * 与规格书 §2.3 的三处实施期修正：
 *   ① 规格书的三步链没有"配音"的落点，而 SRT 是从配音时长派生的——本实现把 `narrate`
 *      显式成第一环节（否则 SRT 无源）；
 *   ② 规格书把 loudnorm 写成链路最后一句话；实测白板引擎产物**无音轨**，混流是必需环节，
 *      因此显式化为 `deliver`（含软字幕轨），并登记 `final_cut` 资产；
 *   ③ 规格书的 `annotate` 依赖"线稿生成阶段给出的元素方位"，实测不可得（见 lineart.ts 头注）——
 *      本实现改为 `analyze` 从像素反推，并在 `annotate` 里过 Zod 契约校验 + 自愈重生成。
 *
 * 纪律：全部 workspace 作用域 + 事务级 RLS；渲染烧算力前置门沿用 G8
 * （T-2026-1031-9003 起默认由视频系统自动审批；`VIDEO_AUTO_APPROVAL=0` 才回滚旧的 approved 人审路径）。
 */
import { z } from "zod";
import { createHash } from "node:crypto";
import { TRPCError } from "@trpc/server";
import { getAppPool, getGatewayPool } from "@workloom/db";
import { gatewayAppendOnClient } from "@workloom/base/workdata";
import { judge, loadActiveRulesInTx, type RuntimeRule } from "@workloom/base/fence-engine";
import { approve as approveRenderScript, create as createRenderScript } from "@workloom/base/asset-cms";
import { newId } from "@workloom/shared";
import { renderSubmitAutoAllowed } from "../gate-policy.js";
import { VIDEO_AUTO_APPROVAL_ACTOR_ID, VIDEO_AUTO_APPROVAL_POLICY_VERSION, autoApproveVideoFence, videoAutoApprovalEnabled } from "../auto-approval.js";
import { writeFileSync } from "node:fs";
import { protectedProcedure, router, scopeOf, writeProcedure } from "../../trpc/context.js";
import { scopedQuery, type Scope } from "../gen/db.js";
import { submitGenJob, type RenderScriptLike } from "../gen/submit.js";
import { pollRenderJobs } from "../render-poller.js";
import { downloadToMediaStore, mediaUrl, registerRenderedClip, resolveMediaPath } from "../gen/ingest.js";
import {
  WHITEBOARD_UHD_SIZE, WhiteboardEngineError, projectedWhiteboardSize, readImageSize,
  probeWhiteboardVideoSize, renderAnnotationPreview, renderWhiteboardScene, runLineartTool, whiteboardEngineHint,
  whiteboardEngineReady, whiteboardEnv, whiteboardQualityOf,
} from "./engine.js";
import { buildSrt, groupScenes, parseSrt, tileScenes } from "./srt.js";
import { narrationConfig, splitSentences, synthesizeNarration, verifyNarration } from "./narration.js";
import { buildSceneLineart } from "./lineart.js";
import { AnnotationSchema, buildAnnotation, validateAnnotation, writeAnnotation, type WhiteboardAnnotation } from "./annotate.js";
import { muxWhiteboardFilm } from "./mux.js";
import { jobDir } from "./store.js";

/** 白板模型目录 id（媒体目录里 provider=whiteboard-local 的那一条） */
const WHITEBOARD_MODEL_ID = "whiteboard-stream";

// 用 type 而非 interface：`scopedQuery<T extends {[k: string]: unknown}>` 只对类型别名
// 推导隐式索引签名，interface 会报 TS2344（本仓 scopedQuery 的既有约束）
type FilmRow = {
  id: string; project_id: string; script_md: string; narration_path: string | null;
  narration_profile: string | null; srt: string; lineart_mode: "seedream" | "sketch" | "upload";
  render_fps: number; cap_long_edge: number; voice_lufs: string;
  narration_done: number; narration_total: number; narration_note: string | null;
  final_asset_id: string | null; final_path: string | null; status: string; error_msg: string | null;
};

type SceneRow = {
  id: string; scene_no: number; title: string; core_idea: string;
  cue_start_ms: number; cue_end_ms: number; lineart_path: string | null;
  lineart_source: string | null; lineart_prompt: string | null; lineart_check: Record<string, unknown>;
  annotation: WhiteboardAnnotation | Record<string, never>; subtitle_srt: string;
  duration_ms: number | null; clip_path: string | null; status: string; error_msg: string | null;
};

/** 片子级工作目录（配音/线稿/标注/预览/渲染产物都落这里，便于整片搬移与排障） */
function filmDir(projectId: string, env: NodeJS.ProcessEnv = process.env): string {
  return jobDir(`film-${projectId}`, env);
}

async function loadFilm(app: ReturnType<typeof getAppPool>, scope: Scope, filmId: string): Promise<FilmRow> {
  const rows = await scopedQuery<FilmRow>(
    app, scope,
    `SELECT id, project_id, script_md, narration_path, narration_profile, srt, lineart_mode,
            render_fps, cap_long_edge, voice_lufs::text AS voice_lufs,
            narration_done, narration_total, narration_note,
            final_asset_id, final_path, status, error_msg
       FROM whiteboard_films WHERE workspace_id=$1 AND id=$2`,
    [scope.workspaceId, filmId],
  );
  if (!rows[0]) throw new TRPCError({ code: "NOT_FOUND", message: `白板片 ${filmId} 不存在` });
  return rows[0];
}

async function loadScenes(app: ReturnType<typeof getAppPool>, scope: Scope, film: FilmRow): Promise<SceneRow[]> {
  return scopedQuery<SceneRow>(
    app, scope,
    `SELECT id, scene_no, title, core_idea, cue_start_ms, cue_end_ms, lineart_path, lineart_source,
            lineart_prompt, lineart_check, annotation, subtitle_srt, duration_ms, clip_path, status, error_msg
       FROM whiteboard_scenes WHERE workspace_id=$1 AND project_id=$2 ORDER BY scene_no`,
    [scope.workspaceId, film.project_id],
  );
}

/** 白板引擎错误 → 可见的 tRPC 错误（带上可执行修复建议，不吞） */
function rethrow(err: unknown): never {
  if (err instanceof WhiteboardEngineError) {
    throw new TRPCError({
      code: "PRECONDITION_FAILED",
      message: `${err.message}${err.detail ? `｜${err.detail}` : ""}`,
    });
  }
  throw err;
}

/** 本地产物落进媒体仓（相对路径 + 绝对路径同源，渲染器与播放共用同一份文件） */
async function storeLocal(absPath: string, workspaceId: string): Promise<{ relPath: string; absPath: string }> {
  const stored = await downloadToMediaStore(`file://${absPath}`, { workspaceId });
  return { relPath: stored.relPath, absPath: resolveMediaPath(stored.relPath) };
}

/** 幕内字幕句（从 SRT 段里取正文，供线稿提示词的"必须出现的元素"位使用） */
function cuesOf(subtitleSrt: string): string[] {
  return subtitleSrt.split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !/^\d+$/.test(line) && !line.includes("-->"));
}

export const whiteboardRouter = router({
  /** 引擎可用性自检（UI 与出片工具据此决定是否显示白板入口） */
  health: protectedProcedure.query(() => {
    const ready = whiteboardEngineReady();
    return { ready, hint: whiteboardEngineHint(), engineDir: whiteboardEnv().engineDir };
  }),

  /** 片子全景：film + 幕 + 渲染任务（工作室页与出片工具的数据源） */
  status: protectedProcedure
    .input(z.object({ filmId: z.string().min(1) }))
    .query(async ({ ctx, input }) => {
      const scope = scopeOf(ctx.identity);
      const app = getAppPool();
      const film = await loadFilm(app, scope, input.filmId);
      const scenes = await loadScenes(app, scope, film);
      const jobs = await scopedQuery<{
        id: string; task_id: string | null; status: string; provider: string | null;
        provider_model: string | null; est_cny: string | null; actual_seconds: number | null;
        asset_id: string | null; created_at: string;
      }>(
        app, scope,
        `SELECT id, task_id, status, provider, provider_model, est_cny::text AS est_cny, actual_seconds,
                asset_id, created_at
           FROM render_jobs WHERE workspace_id=$1 AND project_id=$2 ORDER BY created_at DESC LIMIT 20`,
        [scope.workspaceId, film.project_id],
      );
      return {
        film: { ...film, quality: whiteboardQualityOf(film.cap_long_edge), playUrl: film.final_path ? mediaUrl(film.final_path) : null },
        scenes: scenes.map((s) => ({
          ...s,
          previewUrl: s.lineart_path ? mediaUrl(s.lineart_path) : null,
          clipUrl: s.clip_path ? mediaUrl(s.clip_path) : null,
        })),
        jobs,
      };
    }),

  /** 建片：explainer 项目 + whiteboard_films 行。口播稿是入参——白板片的时间轴完全由它派生 */
  create: writeProcedure
    .input(z.object({
      title: z.string().min(1).max(120),
      script: z.string().min(10).max(20000),
      lineartMode: z.enum(["seedream", "sketch", "upload"]).default("seedream"),
      narrationProfile: z.string().max(64).optional(),
      fps: z.number().int().min(12).max(60).default(30),
      quality: z.enum(["hd", "uhd"]).default("hd"),
      /** HD 自定义长边；UHD 固定为原生 3840×2160。 */
      capLongEdge: z.number().int().min(640).max(1920).optional(),
      voiceLufs: z.number().min(-30).max(-6).default(-16),
    }))
    .mutation(async ({ ctx, input }) => {
      if (input.quality === "uhd" && input.capLongEdge !== undefined) {
        throw new TRPCError({ code: "BAD_REQUEST", message: "UHD 画质固定为 3840×2160，不接受自定义 capLongEdge" });
      }
      const scope = scopeOf(ctx.identity);
      const projectId = newId("VP");
      const filmId = newId("WF");
      const actor = ctx.identity?.memberId ?? "whiteboard-operator";
      const client = await getAppPool().connect();
      try {
        await client.query("BEGIN");
        await client.query("SELECT set_config('app.workspace_id', $1, true)", [scope.workspaceId]);
        await client.query(
          `INSERT INTO video_projects (id, workspace_id, title, kind, prd, status, created_by)
           VALUES ($1,$2,$3,'explainer','{}'::jsonb,'production',$4)`,
          [projectId, scope.workspaceId, input.title, actor],
        );
        await client.query(
          `INSERT INTO whiteboard_films
             (id, workspace_id, project_id, script_md, lineart_mode, render_fps, cap_long_edge,
              voice_lufs, narration_profile, status, created_by)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'draft',$10)`,
          [filmId, scope.workspaceId, projectId, input.script, input.lineartMode, input.fps,
            input.quality === "uhd" ? WHITEBOARD_UHD_SIZE.width : (input.capLongEdge ?? 1280),
            input.voiceLufs, input.narrationProfile ?? narrationConfig().profile, actor],
        );
        await client.query("COMMIT");
      } catch (err) {
        await client.query("ROLLBACK").catch(() => undefined);
        throw err;
      } finally {
        client.release();
      }
      return { filmId, projectId, modelId: WHITEBOARD_MODEL_ID, quality: input.quality };
    }),

  /**
   * 环节 ①：配音 + SRT（全片时间权威）——**异步任务**。
   *
   * 为什么不是同步 mutation：本机克隆音色引擎单句 80–220s，30 句要几十分钟；
   * 同步 HTTP 会被 undici 的 300s 头超时打断（真机实测 fetch failed，服务端其实还在跑）。
   * 因此这里只**投递**任务并立刻返回，进度写进 `whiteboard_films.narration_done/total/note`，
   * 用 `whiteboard.narrateStatus` 或 `whiteboard.status` 观察。
   *
   * 断点续跑：逐句音频按 `<jobs>/film-<projectId>/seg-NN.wav` 落盘，重跑时已存在的句子直接复用，
   * 因此"关了窗口明天接着做"不会重烧算力（同一条口播稿的幂等重入）。
   */
  narrate: writeProcedure
    .input(z.object({ filmId: z.string().min(1), verify: z.boolean().default(true) }))
    .mutation(async ({ ctx, input }) => {
      const scope = scopeOf(ctx.identity);
      const app = getAppPool();
      const film = await loadFilm(app, scope, input.filmId);
      const sentences = narrationSentences(film);
      await scopedQuery(
        app, scope,
        `UPDATE whiteboard_films
            SET status='narrating', narration_total=$3, narration_done=0, narration_note=$4, error_msg=NULL
          WHERE workspace_id=$1 AND id=$2`,
        [scope.workspaceId, film.id, sentences.length, sentences[0] ?? ""],
      );
      void runNarrationJob({ app, scope, film, sentences, verify: input.verify });
      return {
        started: true,
        total: sentences.length,
        profile: narrationConfig().profile,
        concurrency: narrationConfig().concurrency,
        hint: "配音是长任务（本机单句 80–220s）：用 video.whiteboard.narrateStatus 看进度",
      };
    }),

  /** 配音进度（长任务的观察面；前端与出片工具都读它） */
  narrateStatus: protectedProcedure
    .input(z.object({ filmId: z.string().min(1) }))
    .query(async ({ ctx, input }) => {
      const scope = scopeOf(ctx.identity);
      const film = await loadFilm(getAppPool(), scope, input.filmId);
      return {
        status: film.status,
        done: film.narration_done,
        total: film.narration_total,
        note: film.narration_note,
        srt: film.status === "narrated" || film.status === "planned" ? film.srt : "",
        narrationPath: film.narration_path,
        narrationUrl: film.narration_path ? mediaUrl(film.narration_path) : null,
        error: film.error_msg,
      };
    }),

  /** 环节 ②：分幕（确定性；与上游 parse_srt.py 同构，单测比对）；幕长铺满音频 */
  plan: writeProcedure
    .input(z.object({
      filmId: z.string().min(1),
      targetSec: z.number().min(8).max(120).default(30),
      minSec: z.number().min(4).max(120).default(25),
      maxSec: z.number().min(6).max(180).default(35),
    }))
    .mutation(async ({ ctx, input }) => {
      const scope = scopeOf(ctx.identity);
      const app = getAppPool();
      const film = await loadFilm(app, scope, input.filmId);
      const cues = parseSrt(film.srt);
      if (cues.length === 0) {
        throw new TRPCError({ code: "PRECONDITION_FAILED", message: "片子还没有 SRT：请先跑 whiteboard.narrate" });
      }
      const totalMs = cues[cues.length - 1]!.endMs;
      const scenes = tileScenes(groupScenes(cues, {
        targetSec: input.targetSec, minSec: input.minSec, maxSec: input.maxSec,
      }), totalMs);
      const client = await app.connect();
      try {
        await client.query("BEGIN");
        await client.query("SELECT set_config('app.workspace_id', $1, true)", [scope.workspaceId]);
        // 分幕重排后旧幕作废：幕是派生产物（历史留在事件链与 render_jobs 里）
        await client.query(
          `DELETE FROM whiteboard_scenes WHERE workspace_id=$1 AND project_id=$2`,
          [scope.workspaceId, film.project_id],
        );
        for (const scene of scenes) {
          const sceneCues = cues.filter((c) => c.index >= scene.cueRange[0] && c.index <= scene.cueRange[1]);
          await client.query(
            `INSERT INTO whiteboard_scenes
               (id, workspace_id, project_id, scene_no, title, core_idea, cue_start_ms, cue_end_ms,
                subtitle_srt, duration_ms, status)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'draft')`,
            [
              newId("WS"), scope.workspaceId, film.project_id, scene.sceneIndex,
              `第 ${scene.sceneIndex} 幕`, scene.text.slice(0, 200),
              scene.startMs, scene.endMs, buildSrt(sceneCues), scene.sceneDurationMs,
            ],
          );
        }
        await client.query(
          `UPDATE whiteboard_films SET status='planned', error_msg=NULL WHERE workspace_id=$1 AND id=$2`,
          [scope.workspaceId, film.id],
        );
        await client.query("COMMIT");
      } catch (err) {
        await client.query("ROLLBACK").catch(() => undefined);
        throw err;
      } finally {
        client.release();
      }
      return {
        totalMs,
        cueCount: cues.length,
        scenes: scenes.map((s) => ({
          sceneIndex: s.sceneIndex, startMs: s.startMs, endMs: s.endMs,
          sceneDurationMs: s.sceneDurationMs, cueRange: s.cueRange, text: s.text,
        })),
      };
    }),

  /** 环节 ③：逐幕线稿（seedream 出图 / sketch 素描化 / upload 直接采用） */
  lineart: writeProcedure
    .input(z.object({
      filmId: z.string().min(1),
      sceneNo: z.number().int().min(1).optional(),
      /** sketch / upload 路径的输入图（媒体仓相对路径，或仓库内绝对路径） */
      sourcePath: z.string().min(1).optional(),
      /**
       * 重出已有线稿。
       *
       * 默认 false = **跳过已经有线稿的幕**：线稿走方舟出图，是要花钱的；
       * 一轮里有一幕失败、重跑时不该把前面已出好的幕再出一次（真机踩到过 Seedream 白烧）。
       */
      force: z.boolean().default(false),
    }))
    .mutation(async ({ ctx, input }) => {
      const scope = scopeOf(ctx.identity);
      const app = getAppPool();
      const film = await loadFilm(app, scope, input.filmId);
      const scenes = await loadScenes(app, scope, film);
      const targets = input.sceneNo ? scenes.filter((s) => s.scene_no === input.sceneNo) : scenes;
      if (targets.length === 0) {
        throw new TRPCError({ code: "NOT_FOUND", message: "没有匹配的幕（先跑 whiteboard.plan）" });
      }
      const source = input.sourcePath
        ? (input.sourcePath.startsWith("/") ? input.sourcePath : resolveMediaPath(input.sourcePath))
        : undefined;
      const results: Array<Record<string, unknown>> = [];
      for (const scene of targets) {
        if (scene.lineart_path && !input.force) {
          results.push({ sceneNo: scene.scene_no, ok: true, skipped: true, path: scene.lineart_path });
          continue;
        }
        try {
          const lineart = await buildSceneLineart({
            mode: film.lineart_mode,
            sourcePath: source,
            workspaceId: scope.workspaceId,
            sceneNo: scene.scene_no,
            jobDir: filmDir(film.project_id),
            coreIdea: scene.core_idea,
            elements: cuesOf(scene.subtitle_srt),
            env: process.env,
          });
          const stored = await storeLocal(lineart.absPath, scope.workspaceId);
          await scopedQuery(
            app, scope,
            `UPDATE whiteboard_scenes
                SET lineart_path=$4, lineart_source=$5, lineart_prompt=$6, lineart_check=$7::jsonb,
                    status='lineart', error_msg=NULL
              WHERE workspace_id=$1 AND project_id=$2 AND scene_no=$3`,
            [scope.workspaceId, film.project_id, scene.scene_no, stored.relPath,
              lineart.source, lineart.prompt, JSON.stringify(lineart.check)],
          );
          results.push({
            sceneNo: scene.scene_no, ok: true, source: lineart.source, attempts: lineart.attempts,
            check: lineart.check, path: stored.relPath, url: mediaUrl(stored.relPath),
          });
        } catch (err) {
          await scopedQuery(
            app, scope,
            `UPDATE whiteboard_scenes SET status='failed', error_msg=$4
              WHERE workspace_id=$1 AND project_id=$2 AND scene_no=$3`,
            [scope.workspaceId, film.project_id, scene.scene_no, String((err as Error).message).slice(0, 500)],
          ).catch(() => undefined);
          results.push({ sceneNo: scene.scene_no, ok: false, error: (err as Error).message });
        }
      }
      await scopedQuery(
        app, scope,
        `UPDATE whiteboard_films SET status='lineart', error_msg=NULL WHERE workspace_id=$1 AND id=$2`,
        [scope.workspaceId, film.id],
      );
      return { results };
    }),

  /**
   * 环节 ④：逐幕语义标注（区域由像素反推；顺序 = 字幕叙事顺序；Zod 契约校验 + 自愈）。
   * `strict=true` 时校验不过直接拒绝（用于门禁/CI 口径）。
   */
  annotate: writeProcedure
    .input(z.object({
      filmId: z.string().min(1),
      sceneNo: z.number().int().min(1).optional(),
      strict: z.boolean().default(false),
    }))
    .mutation(async ({ ctx, input }) => {
      const scope = scopeOf(ctx.identity);
      const app = getAppPool();
      const film = await loadFilm(app, scope, input.filmId);
      const scenes = await loadScenes(app, scope, film);
      const targets = input.sceneNo ? scenes.filter((s) => s.scene_no === input.sceneNo) : scenes;
      const results: Array<Record<string, unknown>> = [];
      for (const scene of targets) {
        if (!scene.lineart_path) {
          results.push({ sceneNo: scene.scene_no, ok: false, error: "该幕还没有线稿（先跑 whiteboard.lineart）" });
          continue;
        }
        const imagePath = resolveMediaPath(scene.lineart_path);
        if (!readImageSize(imagePath)) {
          results.push({ sceneNo: scene.scene_no, ok: false, error: `线稿不可解析：${scene.lineart_path}` });
          continue;
        }
        const cues = parseSrt(scene.subtitle_srt);
        const durationMs = scene.duration_ms ?? (scene.cue_end_ms - scene.cue_start_ms);
        try {
          const built = await buildAnnotation({
            sceneNo: scene.scene_no,
            sceneTitle: scene.title,
            cues,
            lineartAbsPath: imagePath,
            sceneDurationMs: durationMs,
          });
          const annotationPath = writeAnnotation(filmDir(film.project_id), scene.scene_no, built.annotation);
          await scopedQuery(
            app, scope,
            `UPDATE whiteboard_scenes
                SET annotation=$4::jsonb, status='annotated', error_msg=NULL
              WHERE workspace_id=$1 AND project_id=$2 AND scene_no=$3`,
            [scope.workspaceId, film.project_id, scene.scene_no, JSON.stringify(built.annotation)],
          );
          results.push({
            sceneNo: scene.scene_no, ok: built.problems.length === 0, attempts: built.attempts,
            problems: built.problems, elements: built.annotation.elements.length,
            sceneDurationMs: built.annotation.sceneDurationMs, annotationPath,
          });
        } catch (err) {
          results.push({ sceneNo: scene.scene_no, ok: false, error: (err as Error).message });
        }
      }
      const failed = results.filter((r) => r.ok === false);
      if (input.strict && failed.length > 0) {
        throw new TRPCError({
          code: "PRECONDITION_FAILED",
          message: `标注校验未过（strict 模式拒入渲染）：${JSON.stringify(failed).slice(0, 600)}`,
        });
      }
      await scopedQuery(
        app, scope,
        `UPDATE whiteboard_films SET status='annotated', error_msg=NULL WHERE workspace_id=$1 AND id=$2`,
        [scope.workspaceId, film.id],
      );
      return { results };
    }),

  /** 单幕标注手改（确认关的"我要改这一笔"入口；改完只重渲该幕） */
  updateAnnotation: writeProcedure
    .input(z.object({
      filmId: z.string().min(1),
      sceneNo: z.number().int().min(1),
      annotation: AnnotationSchema,
    }))
    .mutation(async ({ ctx, input }) => {
      const scope = scopeOf(ctx.identity);
      const app = getAppPool();
      const film = await loadFilm(app, scope, input.filmId);
      const scenes = await loadScenes(app, scope, film);
      const scene = scenes.find((s) => s.scene_no === input.sceneNo);
      if (!scene?.lineart_path) {
        throw new TRPCError({ code: "NOT_FOUND", message: `第 ${input.sceneNo} 幕或其次线稿不存在` });
      }
      const size = readImageSize(resolveMediaPath(scene.lineart_path));
      if (!size) throw new TRPCError({ code: "PRECONDITION_FAILED", message: "线稿不可解析，无法校验标注" });
      const problems = validateAnnotation(input.annotation, size);
      if (problems.length > 0) {
        throw new TRPCError({ code: "BAD_REQUEST", message: `标注不合契约：${problems.join("；")}` });
      }
      writeAnnotation(filmDir(film.project_id), input.sceneNo, input.annotation);
      await scopedQuery(
        app, scope,
        `UPDATE whiteboard_scenes SET annotation=$4::jsonb, status='annotated', error_msg=NULL
          WHERE workspace_id=$1 AND project_id=$2 AND scene_no=$3`,
        [scope.workspaceId, film.project_id, input.sceneNo, JSON.stringify(input.annotation)],
      );
      return { ok: true, sceneNo: input.sceneNo };
    }),

  /**
   * 确认关：标注编号检查图（上游 `render_annotation_preview.py`；本仓已打跨平台字体补丁）。
   * 自动模式下可跳过，但"跳过了"这个事实要在返回值里可见（供上层留痕）。
   */
  preview: writeProcedure
    .input(z.object({ filmId: z.string().min(1), sceneNo: z.number().int().min(1) }))
    .mutation(async ({ ctx, input }) => {
      const scope = scopeOf(ctx.identity);
      const app = getAppPool();
      const film = await loadFilm(app, scope, input.filmId);
      const scenes = await loadScenes(app, scope, film);
      const scene = scenes.find((s) => s.scene_no === input.sceneNo);
      if (!scene?.lineart_path) {
        throw new TRPCError({ code: "NOT_FOUND", message: `第 ${input.sceneNo} 幕还没有线稿` });
      }
      const entry = scene.annotation as WhiteboardAnnotation;
      if (!entry || !Array.isArray(entry.elements) || entry.elements.length === 0) {
        throw new TRPCError({ code: "PRECONDITION_FAILED", message: `第 ${input.sceneNo} 幕还没有标注（先跑 whiteboard.annotate）` });
      }
      const dir = filmDir(film.project_id);
      const annotationPath = writeAnnotation(dir, input.sceneNo, entry);
      const output = `${dir}/scene-${String(input.sceneNo).padStart(2, "0")}.preview.png`;
      const lineartAbs = resolveMediaPath(scene.lineart_path);
      await renderAnnotationPreview(lineartAbs, annotationPath, output);
      const stored = await storeLocal(output, scope.workspaceId);
      const problems = validateAnnotation(entry, readImageSize(lineartAbs) ?? { width: 0, height: 0 });
      // 确认关留痕（规格 §2.10 验收 7）：三处确认点进事件账本，append-only、可审计
      await recordGateEvent(scope, {
        filmId: film.id,
        projectId: film.project_id,
        gate: "annotation-preview",
        outcome: "presented",
        sceneNo: input.sceneNo,
        detail: problems.length === 0 ? "标注契约校验通过" : `校验问题 ${problems.length} 项`,
        actor: ctx.identity?.memberId ?? "whiteboard-operator",
      });
      return {
        sceneNo: input.sceneNo,
        path: stored.relPath,
        url: mediaUrl(stored.relPath),
        problems,
      };
    }),

  /**
   * 确认关"跳过"（自动模式的合法路径）——**跳过必须留痕**（规格 §2.10 验收 7）。
   *
   * 为什么单独一个 procedure 而不是"什么都不做"：自动模式下不调 preview 就是跳过，
   * 但这种"缺席"无法与"忘了"区分。显式调用本接口会往事件账本写一条 `skipped` 事件
   * （含原因与操作者），于是"跳过"成为一个**可审计的动作**，而不是一段空白。
   */
  skipConfirmation: writeProcedure
    .input(z.object({
      filmId: z.string().min(1),
      gate: z.enum(["storyboard", "lineart", "annotation-preview"]),
      reason: z.string().min(2).max(300),
    }))
    .mutation(async ({ ctx, input }) => {
      const scope = scopeOf(ctx.identity);
      const app = getAppPool();
      const film = await loadFilm(app, scope, input.filmId);
      await recordGateEvent(scope, {
        filmId: film.id,
        projectId: film.project_id,
        gate: input.gate,
        outcome: "skipped",
        sceneNo: null,
        detail: input.reason,
        actor: ctx.identity?.memberId ?? "whiteboard-operator",
      });
      return { ok: true, gate: input.gate, reason: input.reason };
    }),

  /**
   * 环节 ⑤：渲染（经 `submitGenJob` → `render_jobs` → poller）。
   * 白板片挂一条 render_scripts 行（整片一条，shot_id=WHITEBOARD），
   * 因此台账 / 事件 / 配额 / 降级链全部复用，无平行实现。
   */
  render: writeProcedure
    .input(z.object({
      filmId: z.string().min(1),
      /** 省略时沿用 create 时存下的档位；旧片默认 HD。 */
      quality: z.enum(["hd", "uhd"]).optional(),
      allowOverage: z.boolean().default(true),
      idempotencyKey: z.string().max(200).optional(),
    }))
    .mutation(async ({ ctx, input }) => {
      const scope = scopeOf(ctx.identity);
      const app = getAppPool();
      const gateway = getGatewayPool();
      const film = await loadFilm(app, scope, input.filmId);
      const quality = input.quality ?? whiteboardQualityOf(film.cap_long_edge);
      const capLongEdge = quality === "uhd" ? WHITEBOARD_UHD_SIZE.width
        : film.cap_long_edge <= 1920 ? film.cap_long_edge : 1280;
      const scenes = await loadScenes(app, scope, film);
      const ready = scenes.filter((s) => s.lineart_path && (s.annotation as WhiteboardAnnotation)?.elements?.length > 0);
      if (scenes.length === 0 || ready.length !== scenes.length) {
        throw new TRPCError({
          code: "PRECONDITION_FAILED",
          message: `还有 ${scenes.length - ready.length} 幕缺少线稿或标注（整片渲染要求全幕就绪）`,
        });
      }
      if (!whiteboardEngineReady()) {
        throw new TRPCError({ code: "PRECONDITION_FAILED", message: `白板引擎不可用：${whiteboardEngineHint()}` });
      }
      if (quality === "uhd") {
        for (const scene of scenes) {
          const image = readImageSize(resolveMediaPath(scene.lineart_path!));
          if (!image) throw new TRPCError({ code: "PRECONDITION_FAILED", message: `第 ${scene.scene_no} 幕线稿尺寸无法解析` });
          const projected = projectedWhiteboardSize(image, capLongEdge);
          if (projected.width !== WHITEBOARD_UHD_SIZE.width || projected.height !== WHITEBOARD_UHD_SIZE.height) {
            throw new TRPCError({
              code: "PRECONDITION_FAILED",
              message: `第 ${scene.scene_no} 幕线稿 ${image.width}×${image.height} 将渲为 ${projected.width}×${projected.height}；UHD 要求 16:9，输出 3840×2160`,
            });
          }
        }
      }
      const actor = ctx.identity?.memberId ?? "whiteboard-operator";

      /* ---- G8 前置门：渲染提交烧算力，围栏判定与 renderRouter.submit 同口径 ---- */
      const fenceClient = await app.connect();
      let rules: RuntimeRule[];
      try {
        await fenceClient.query("BEGIN");
        await fenceClient.query("SELECT set_config('app.workspace_id', $1, true)", [scope.workspaceId]);
        rules = await loadActiveRulesInTx(fenceClient, scope);
        await fenceClient.query("COMMIT");
      } catch (err) {
        await fenceClient.query("ROLLBACK").catch(() => undefined);
        throw err;
      } finally {
        fenceClient.release();
      }
      const rawVerdict = judge({
        object: { type: "render_script", id: `whiteboard:${film.project_id}` },
        action: "render.submit",
        params: { engine: "whiteboard-local", scenes: scenes.length, quality,
          capLongEdge, resolution: quality === "uhd" ? "3840x2160" : null },
        context: { render_auto: renderSubmitAutoAllowed() },
      }, rules, "review");
      const autoReview = autoApproveVideoFence(rawVerdict, {
        scope: "ai-video",
        allowDefaultReview: true,
      });
      const verdict = autoReview.verdict;
      if (verdict.level === "block") {
        throw new TRPCError({
          code: "FORBIDDEN",
          message: `G8 围栏熔断：${verdict.triggeredBy.join("；") || "whiteboard render.submit 命中 block 规则"}`,
        });
      }

      /* ---- 渲染脚本行（白板片同样走"版本即审批对象"口径） ---- */
      const scriptKey = `whiteboard-${film.project_id}`;
      const existing = await scopedQuery<RenderScriptLike & Record<string, unknown>>(
        app, scope,
        `SELECT s.* FROM render_scripts s JOIN workspaces w ON w.id=s.workspace_id
          WHERE s.workspace_id=$1 AND s.script_key=$2 AND w.tenant_id=$3 AND s.project_id=$4
          ORDER BY s.version DESC LIMIT 1`,
        [scope.workspaceId, scriptKey, scope.tenantId, film.project_id],
      );
      let scriptRow: RenderScriptLike | undefined = existing[0];
      if (!scriptRow) {
        scriptRow = await createRenderScript(app, gateway, scope, {
          scriptKey,
          projectId: film.project_id,
          shotId: "WHITEBOARD",
          md: `${film.script_md}\n\n（手绘白板片：${scenes.length} 幕，逐幕线稿 + 标注驱动流式笔迹）`,
          fields: {
            engine: "whiteboard-local",
            scenes: scenes.length,
            durationMs: scenes.reduce((s, x) => s + (x.duration_ms ?? 0), 0),
            ...(quality === "uhd" ? { quality, resolution: "3840x2160" } : {}),
          },
          by: actor,
        });
      }
      if (videoAutoApprovalEnabled() && scriptRow.status === "draft") {
        const autoApproved = await approveRenderScript(app, gateway, scope, scriptRow.script_key, scriptRow.version, {
          by: VIDEO_AUTO_APPROVAL_ACTOR_ID,
          policyVersion: VIDEO_AUTO_APPROVAL_POLICY_VERSION,
        });
        scriptRow = autoApproved.script;
      }
      if (verdict.level === "review") {
        const cur = await scopedQuery<{ status: string }>(
          app, scope, `SELECT status FROM render_scripts WHERE workspace_id=$1 AND id=$2`,
          [scope.workspaceId, scriptRow.id],
        );
        if (cur[0]?.status !== "approved") {
          throw new TRPCError({
            code: "PRECONDITION_FAILED",
            message: `G8：渲染提交烧算力前置门——脚本 ${scriptKey} 须先经 video.cms.approveScript 审批（当前 ${cur[0]?.status ?? "未知"}）`,
          });
        }
      }

      const totalDurationMs = scenes.reduce((sum, s) => sum + (s.duration_ms ?? 0), 0);
      /**
       * 幂等键必须**含渲染输入的内容指纹**，不能只用"幕数 + 总时长"。
       *
       * 真机踩到：改完标注重渲时，幕数与总时长都没变 → 幂等键命中上一次那条
       * **失败**的任务，`submitGenJob` 直接把旧 taskId 返回来，新标注根本没渲。
       * 这里把"每幕线稿路径 + 标注全文 + 时长"一起哈希，内容一变就是新任务；
       * 内容没变时才是真正的重复提交（幂等保护仍然有效）。
       */
      const fingerprint = createHash("sha256")
        .update(scenes.map((s) => JSON.stringify({
          no: s.scene_no, lineart: s.lineart_path, ms: s.duration_ms, annotation: s.annotation,
        })).join("\n") + `\nquality=${quality};cap=${capLongEdge}`)
        .digest("hex")
        .slice(0, 16);
      const customKey = input.idempotencyKey
        ? `${createHash("sha256").update(input.idempotencyKey).digest("hex").slice(0, 16)}:`
        : "";
      const submit = await submitGenJob({
        app, gateway, scope, actor,
        script: scriptRow,
        modelId: WHITEBOARD_MODEL_ID,
        params: {
          durationSec: Math.max(1, Math.round(totalDurationMs / 1000)),
          aspectRatio: "16:9",
          resolution: quality === "uhd" ? "3840x2160" : undefined,
          extra: {
            whiteboard: {
              projectId: film.project_id,
              fps: film.render_fps,
              capLongEdge,
              quality,
              scenes: scenes.map((s) => ({
                sceneNo: s.scene_no,
                title: s.title,
                lineartPath: resolveMediaPath(s.lineart_path!),
                annotation: s.annotation,
                durationMs: s.duration_ms ?? (s.cue_end_ms - s.cue_start_ms),
              })),
            },
          },
        },
        mode: "manual",
        idempotencyKey: `whiteboard:${film.id}:${customKey}${fingerprint}`,
        fenceLevel: verdict.level,
        qualityFenceLevel: rawVerdict.level,
        ...(autoReview.autoApproved ? { autoApprovalPolicyVersion: VIDEO_AUTO_APPROVAL_POLICY_VERSION } : {}),
        fenceImpacts: verdict.impacts as never,
        budgetOverageSeconds: input.allowOverage ? Math.max(0, Math.round(totalDurationMs / 1000)) : 0,
      });
      if (input.quality && film.cap_long_edge !== capLongEdge) {
        await scopedQuery(app, scope,
          `UPDATE whiteboard_films SET cap_long_edge=$3 WHERE workspace_id=$1 AND id=$2`,
          [scope.workspaceId, film.id, capLongEdge]);
      }
      return { ...submit, modelId: WHITEBOARD_MODEL_ID, totalDurationMs, scenes: scenes.length, quality,
        resolution: quality === "uhd" ? "3840x2160" : null };
    }),

  /** 渲染轮询（复用 render-poller：回填 + 入库 + 成本 + 档案；白板产物经 file:// 本地入库） */
  poll: writeProcedure
    .input(z.object({ filmId: z.string().min(1), limit: z.number().int().min(1).max(50).default(10) }))
    .mutation(async ({ ctx, input }) => {
      const scope = scopeOf(ctx.identity);
      const app = getAppPool();
      const film = await loadFilm(app, scope, input.filmId);
      const report = await pollRenderJobs(app, getGatewayPool(), scope, { limit: input.limit });
      /**
       * C-02 修复：rendered 判定必须是"本 film 所属项目的渲染任务已完成且产物已入库"，
       * 此前用全工作区聚合计数 report.done>0——同批次里他项目/mock 任务完成就会把
       * 本影片误标 rendered（界面显示渲染完成但没有任何成片字节，假交付）。
       */
      const own = await scopedQuery<{ c: string }>(
        app, scope,
        `SELECT count(*) AS c FROM render_jobs
          WHERE workspace_id=$1 AND project_id=$2 AND status='done' AND asset_id IS NOT NULL`,
        [scope.workspaceId, film.project_id],
      );
      if (Number(own[0]?.c ?? 0) > 0) {
        await scopedQuery(
          app, scope,
          `UPDATE whiteboard_films SET status='rendered' WHERE workspace_id=$1 AND id=$2`,
          [scope.workspaceId, film.id],
        );
      }
      return report;
    }),

  /**
   * 环节 ⑥：交付 —— 两遍 loudnorm 混流 + 软字幕轨 + 媒资库 final_cut。
   *
   * 取片顺序：job 目录里的 `whiteboard-silent.mp4`（分幕合并产物）→ 找不到则回退 poller
   * 已入库的本地副本。混流后**重新入库**为 final_cut（clip 是素材，final_cut 是交付物）。
   */
  deliver: writeProcedure
    .input(z.object({
      filmId: z.string().min(1),
      withSubtitle: z.boolean().default(true),
      title: z.string().max(120).optional(),
    }))
    .mutation(async ({ ctx, input }) => {
      const scope = scopeOf(ctx.identity);
      const app = getAppPool();
      const film = await loadFilm(app, scope, input.filmId);
      if (!film.narration_path) {
        throw new TRPCError({ code: "PRECONDITION_FAILED", message: "还没有配音轨：先跑 whiteboard.narrate" });
      }
      const scenes = await loadScenes(app, scope, film);
      const jobs = await scopedQuery<{ id: string; asset_id: string | null; status: string }>(
        app, scope,
        `SELECT id, asset_id, status FROM render_jobs
          WHERE workspace_id=$1 AND project_id=$2 ORDER BY created_at DESC LIMIT 1`,
        [scope.workspaceId, film.project_id],
      );
      const job = jobs[0];
      if (!job || job.status !== "done") {
        throw new TRPCError({
          code: "PRECONDITION_FAILED",
          message: `最近一次渲染未完成（${job?.status ?? "无任务"}）：先跑 whiteboard.poll`,
        });
      }
      const silent = await resolveSilentVideo(app, scope, film, job);
      const dir = filmDir(film.project_id);
      const srtPath = input.withSubtitle ? `${dir}/film.srt` : undefined;
      if (srtPath) writeFileSync(srtPath, film.srt, "utf8");
      const output = `${dir}/whiteboard-final.mp4`;
      const mux = await muxWhiteboardFilm({
        silentVideo: silent,
        narrationWav: resolveMediaPath(film.narration_path),
        output,
        srtPath,
        targetLufs: Number(film.voice_lufs),
        env: process.env,
      });
      if (whiteboardQualityOf(film.cap_long_edge) === "uhd") {
        const actual = await probeWhiteboardVideoSize(output);
        if (actual.width !== WHITEBOARD_UHD_SIZE.width || actual.height !== WHITEBOARD_UHD_SIZE.height) {
          throw new TRPCError({ code: "PRECONDITION_FAILED",
            message: `UHD 白板交付尺寸错误：实际 ${actual.width}×${actual.height}，要求 3840×2160` });
        }
      }
      const stored = await downloadToMediaStore(`file://${output}`, { workspaceId: scope.workspaceId });

      /* ---- 登记 final_cut：片型如实为 explainer；prompt 存口播稿摘要（可检索） ---- */
      const assetId = newId("VA");
      await registerRenderedClip(app, getGatewayPool(), scope, {
        assetId,
        kind: "final_cut",
        projectId: film.project_id,
        sha256: stored.sha256,
        sourceUrl: `file://${output}`,
        localRelPath: stored.relPath,
        provider: "whiteboard-local",
        providerModel: WHITEBOARD_MODEL_ID,
        jobId: job.id,
        scriptId: `whiteboard-${film.project_id}`,
        seconds: Math.round(mux.videoSeconds),
        title: input.title ?? `手绘白板解说片 · ${film.project_id}`,
        prompt: film.script_md.replace(/\s+/g, " ").slice(0, 800),
        pipelineKind: "explainer",
        aspectRatio: "16:9",
        by: ctx.identity?.memberId ?? "whiteboard-operator",
      });
      await scopedQuery(
        app, scope,
        `UPDATE video_assets SET tags=$3::jsonb WHERE workspace_id=$1 AND id=$2`,
        [scope.workspaceId, assetId, JSON.stringify(["口播", "白板手绘", "explainer"])],
      );
      await scopedQuery(
        app, scope,
        `UPDATE whiteboard_films
            SET final_asset_id=$3, final_path=$4, status='delivered', error_msg=NULL
          WHERE workspace_id=$1 AND id=$2`,
        [scope.workspaceId, film.id, assetId, stored.relPath],
      );
      await scopedQuery(
        app, scope,
        `UPDATE whiteboard_scenes SET clip_path=$3, status='rendered'
          WHERE workspace_id=$1 AND project_id=$2 AND clip_path IS NULL`,
        [scope.workspaceId, film.project_id, stored.relPath],
      );
      return {
        assetId,
        path: stored.relPath,
        url: mediaUrl(stored.relPath),
        mux,
        sceneCount: scenes.length,
        subtitleTrack: Boolean(srtPath),
      };
    }),

  /**
   * 验收 1「官方样例复现」：用 vendor 内置 examples 素材直渲一版，
   * 证明引擎在本机真的能出片（而不是"接上了但没跑过"）。
   */
  verifyExample: writeProcedure
    .input(z.object({
      quality: z.enum(["hd", "uhd"]).default("hd"),
      capLongEdge: z.number().int().min(640).max(1920).optional(),
      fps: z.number().int().min(12).max(60).default(30),
    }))
    .mutation(async ({ ctx, input }) => {
      if (input.quality === "uhd" && input.capLongEdge !== undefined) {
        throw new TRPCError({ code: "BAD_REQUEST", message: "UHD 样例固定为 3840×2160，不接受自定义 capLongEdge" });
      }
      const scope = scopeOf(ctx.identity);
      const cfg = whiteboardEnv();
      try {
        const rendered = await renderWhiteboardScene({
          imagePath: cfg.exampleImage,
          annotationPath: cfg.exampleAnnotation,
          outputPath: `${filmDir("engine-example")}/monkey-banana-${input.quality}.mp4`,
          fps: input.fps,
          capLongEdge: input.quality === "uhd" ? WHITEBOARD_UHD_SIZE.width : (input.capLongEdge ?? 1280),
          quality: input.quality,
          env: process.env,
        });
        const styleCheck = await runLineartTool<{ checks: unknown[]; metrics: unknown }>(
          ["check", "--in", cfg.exampleImage],
          { env: process.env, allowNonZero: true, timeoutMs: 120_000 },
        );
        const stored = await storeLocal(rendered.outputPath, scope.workspaceId);
        return {
          ok: true,
          output: stored.relPath,
          url: mediaUrl(stored.relPath),
          renderMs: rendered.durationMs,
          quality: input.quality,
          resolution: input.quality === "uhd" ? "3840x2160" : null,
          styleCheck,
        };
      } catch (err) {
        rethrow(err);
      }
    }),
});

/** 找（或重建）无声成片：优先 job 目录产物，其次 poller 入库的本地副本 */
async function resolveSilentVideo(
  app: ReturnType<typeof getAppPool>,
  scope: Scope,
  film: FilmRow,
  job: { id: string; asset_id: string | null },
): Promise<string> {
  const direct = `${filmDir(film.project_id)}/whiteboard-silent.mp4`;
  const { existsSync } = await import("node:fs");
  if (existsSync(direct)) return direct;
  if (job.asset_id) {
    const rows = await scopedQuery<{ local_path: string | null }>(
      app, scope,
      `SELECT meta->>'localPath' AS local_path FROM video_assets WHERE workspace_id=$1 AND id=$2`,
      [scope.workspaceId, job.asset_id],
    );
    const rel = rows[0]?.local_path;
    if (rel) return resolveMediaPath(rel);
  }
  throw new TRPCError({
    code: "PRECONDITION_FAILED",
    message: `找不到无声成片（既没有 ${direct}，也没有已入库的渲染产物）：请确认 poller 已把该任务回填为 done`,
  });
}

/** 口播稿分句（进度与任务投递共用同一口径，避免两处各算一遍） */
function narrationSentences(film: FilmRow): string[] {
  return splitSentences(film.script_md);
}

/**
 * 确认关留痕（写入五元事件账本；D16：与动作同一事务同一 COMMIT）。
 *
 * 为什么落在事件账本而不是新加一张表：仓内"留痕"的统一载体就是 append-only 的事件账本
 * （哈希链、可审计、租户隔离），确认关的"看过 / 跳过"属于同一类事实。
 * 这里刻意**不失败关闭**：确认关留痕失败不应阻断出片，但会打印警告（避免把审计装饰成闸门）。
 */
async function recordGateEvent(
  scope: Scope,
  input: {
    filmId: string; projectId: string;
    gate: "storyboard" | "lineart" | "annotation-preview";
    outcome: "presented" | "skipped";
    sceneNo: number | null;
    detail: string;
    actor: string;
  },
): Promise<void> {
  const gateway = getGatewayPool();
  const client = await gateway.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT set_config('app.workspace_id', $1, true)", [scope.workspaceId]);
    await client.query("SELECT set_config('app.tenant_id', $1, true)", [scope.tenantId]);
    await gatewayAppendOnClient(client, { ...scope, actor: { id: input.actor, type: "human" } }, {
      who: { type: "human", id: input.actor },
      context: {
        tenant_id: scope.tenantId, workspace_id: scope.workspaceId,
        time: new Date().toISOString(), channel: "inapp",
      },
      object: { type: "whiteboard_film", id: input.filmId },
      decision: {
        action: `whiteboard.gate.${input.outcome}`,
        after: { gate: input.gate, sceneNo: input.sceneNo, projectId: input.projectId, detail: input.detail },
        basis: [
          input.outcome === "presented"
            ? "确认关：呈阅编号检查图（人工可改标注后只重渲该幕）"
            : "确认关：自动模式跳过（显式留痕，避免「缺席」与「忘了」无法区分）",
        ],
      },
      rule_impact: [],
      receipt: { synced: false },
    });
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK").catch(() => undefined);
    console.warn(`[whiteboard] 确认关留痕失败（不阻断出片）：${(err as Error).message.slice(0, 200)}`);
  } finally {
    client.release();
  }
}

/**
 * 配音后台任务（异步 + 进度落库 + 结果落库）。
 *
 * 纪律：
 *   · 进度写库（`narration_done/total/note`）而不是只打日志——长任务必须能从 UI/工具观察到；
 *   · 进度写库失败**不影响配音本身**（best-effort），但最终结果写库失败要显式失败
 *     （否则会出现"音频在、片子状态还是 narrating"的静默不一致）；
 *   · 出错把原因写进 `error_msg` 并置 `status='failed'`，绝不静默。
 */
async function runNarrationJob(args: {
  app: ReturnType<typeof getAppPool>;
  scope: Scope;
  film: FilmRow;
  sentences: string[];
  verify: boolean;
}): Promise<void> {
  const { app, scope, film } = args;
  const progress = async (done: number, note: string) => {
    await scopedQuery(
      app, scope,
      `UPDATE whiteboard_films SET narration_done=$3, narration_note=$4 WHERE workspace_id=$1 AND id=$2`,
      [scope.workspaceId, film.id, done, note.slice(0, 200)],
    ).catch(() => undefined);
  };
  try {
    const narration = await synthesizeNarration({
      script: film.script_md,
      outDir: filmDir(film.project_id),
      onProgress: (p) => { void progress(p.done, p.current); },
    });
    const stored = await storeLocal(narration.wavPath, scope.workspaceId);
    const verification = args.verify
      ? await verifyNarration(narration.wavPath, film.script_md.replace(/\s+/g, " ").trim())
        .catch((err) => ({ matchRatio: null, detail: `核查不可用：${(err as Error).message.slice(0, 200)}` }))
      : null;
    await scopedQuery(
      app, scope,
      `UPDATE whiteboard_films
          SET narration_path=$3, narration_profile=$4, srt=$5, status='narrated',
              narration_done=$6, narration_total=$6, narration_note=$7, error_msg=NULL
        WHERE workspace_id=$1 AND id=$2`,
      [scope.workspaceId, film.id, stored.relPath, narration.profile, narration.srt,
        narration.segments.length,
        `${narration.reusedSegments > 0 ? `复用 ${narration.reusedSegments} 句，` : ""}`
        + `${verification?.detail?.slice(0, 160) ?? "合成完成"}`],
    );
  } catch (err) {
    const message = err instanceof WhiteboardEngineError
      ? `${err.message}${err.detail ? `｜${err.detail}` : ""}`
      : `${(err as NarrationLike).message ?? String(err)}`
        + `${(err as NarrationLike).detail ? `｜${(err as NarrationLike).detail}` : ""}`;
    await scopedQuery(
      app, scope,
      `UPDATE whiteboard_films SET status='failed', error_msg=$3 WHERE workspace_id=$1 AND id=$2`,
      [scope.workspaceId, film.id, message.slice(0, 500)],
    ).catch(() => undefined);
    console.error(`[whiteboard] 配音失败 film=${film.id}：${message.slice(0, 300)}`);
  }
}

/** NarrationError 的细节字段（跨模块只取用得到的两个字段，避免把类的实例判定写死在这里） */
interface NarrationLike { message?: string; detail?: string }
