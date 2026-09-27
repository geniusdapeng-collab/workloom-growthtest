/**
 * video/whiteboard/provider.ts —— 手绘白板渲染 provider（T-2026-0926-0020）
 *
 * 实现基座 `GenProvider`（healthy / submit → taskId / poll → 状态+产物），因此直接复用
 * `gen/submit.ts` 的落库与降级链、`video/render-poller.ts` 的轮询/入库/成本/档案，
 * **没有平行实现**（规格书 §2.10 验收 4）。
 *
 * 与规格书 §2.6 骨架的三处实施期修正：
 *   ① 骨架直接 `INSERT render_jobs`：不成立——`render_jobs.script_id` 是 NOT NULL 且外键指向
 *      `render_scripts`。本实现走 `gen/submit.ts#submitGenJob`（唯一写入口），白板片同样挂
 *      render_scripts 行（幕号即 shot_id），因此台账/事件/配额/降级链全部自动生效。
 *   ② 骨架把产物路径直接交给上层：不成立——`downloadToMediaStore` 只接受 http(s)，
 *      poller 拿本地路径无法入库。本实现对 `file://` 协议做了**同一函数内的本地拷贝分支**
 *      （见 `gen/ingest.ts`），于是 poller 的入库链路无需任何特判。
 *   ③ 骨架的 `status.json` 与 `render_jobs` 双写会漂移：这里明确分工——
 *      `render_jobs` + poller 是**状态权威**；job 目录的 `status.json` 只是断点续跑凭据。
 *
 * 任务参数（`req.params.extra.whiteboard`）：
 *   { scenes: [{ sceneNo, title, lineartPath, annotation, durationMs }], fps, capLongEdge, handPath, srtPath }
 * 其中 `lineartPath` 是**绝对路径**（渲染器直接读文件；入库由 poller 完成）。
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { GenKind, GenProvider, GenRequest } from "@workloom/base/model-router";
import { newId } from "@workloom/shared";
import { ProviderError } from "../gen/types.js";
import {
  WHITEBOARD_UHD_SIZE, WhiteboardEngineError, mergeWhiteboardScenes, probeWhiteboardVideoSize,
  renderWhiteboardScene, whiteboardEngineHint, whiteboardEngineReady, whiteboardEnv,
  type WhiteboardQuality,
} from "./engine.js";
import {
  readJobState, resumableScene, writeJobState,
  type SceneRunState, type WhiteboardJobState,
} from "./store.js";

export interface WhiteboardSceneParam {
  sceneNo: number;
  title: string;
  /** 线稿绝对路径 */
  lineartPath: string;
  /** annotation.json 全文（上游契约；此处以对象形式传入，落盘为文件后交给引擎） */
  annotation: unknown;
  /** 本幕渲染时长（= 该幕字幕跨度，毫秒） */
  durationMs: number;
}

export interface WhiteboardParams {
  projectId: string;
  scenes: WhiteboardSceneParam[];
  fps?: number;
  capLongEdge?: number;
  quality?: WhiteboardQuality;
  handPath?: string;
  inkPath?: "grid" | "skeleton";
  colorFill?: "contour-wipe" | "brush";
}

export function readWhiteboardParams(req: GenRequest): WhiteboardParams {
  const extra = (req.params?.extra ?? {}) as { whiteboard?: unknown };
  const params = extra.whiteboard as WhiteboardParams | undefined;
  if (!params || !Array.isArray(params.scenes) || params.scenes.length === 0) {
    throw new ProviderError(
      "BAD_REQUEST",
      "whiteboard-local 缺少任务参数：params.extra.whiteboard.scenes 不能为空（调用方应经 video.whiteboard.render 下发）",
    );
  }
  const quality = params.quality ?? "hd";
  if (quality !== "hd" && quality !== "uhd") {
    throw new ProviderError("BAD_REQUEST", `whiteboard-local quality 非法：${String(quality)}`);
  }
  const cap = params.capLongEdge ?? 1280;
  if (quality === "uhd" ? cap !== WHITEBOARD_UHD_SIZE.width : !Number.isInteger(cap) || cap < 640 || cap > 1920) {
    throw new ProviderError("BAD_REQUEST", `whiteboard-local ${quality} 长边参数非法：${cap}`);
  }
  return { ...params, quality, capLongEdge: cap };
}

/**
 * 进程内活跃任务集合——断点续跑的**判据**。
 *
 * 渲染跑在服务进程内（与其它 GenProvider 同构）。进程被 kill 之后，任务目录里
 * 仍留着一份 `status.json: running`，但**没有任何东西在推进它**：
 * 若只靠"磁盘上有 running 状态"就报 running，poller 会永远轮询下去（真机表现为任务悬死）。
 * 因此 `poll()` 增加一条：磁盘说 running、但本进程没有活跃任务 → **按任务目录接管**。
 */
const activeJobs = new Set<string>();
/** 接管竞态保护：同一拍内可能有多个调用方同时 poll，只允许一个真正接管 */
const resuming = new Set<string>();

export class WhiteboardProvider implements GenProvider {
  readonly providerId = "whiteboard-local";
  readonly kind: GenKind = "video";

  constructor(private readonly env: NodeJS.ProcessEnv = process.env) {}

  async healthy(): Promise<boolean> {
    return whiteboardEngineReady(this.env);
  }

  /**
   * 提交：同步落任务目录（含逐幕 annotation.json），异步逐幕渲染 → 合并。
   * 立即返回 taskId（任务制语义与其它供应商一致）。
   */
  async submit(req: GenRequest): Promise<{ taskId: string }> {
    if (!(await this.healthy())) {
      throw new ProviderError("MODEL_UNAVAILABLE", `白板引擎不可用：${whiteboardEngineHint(this.env)}`);
    }
    const params = readWhiteboardParams(req);
    const cfg = whiteboardEnv(this.env);
    const taskId = `wb-${newId("WB").toLowerCase()}`;
    const dir = join(cfg.jobsDir, taskId);
    mkdirSync(dir, { recursive: true });
    // 任务参数落盘：重启后接管时不需要调用方再传一遍（任务目录是唯一事实源）
    writeFileSync(join(dir, "job.json"), `${JSON.stringify(params, null, 2)}\n`, "utf8");

    const scenes: SceneRunState[] = params.scenes.map((scene) => {
      const annotationPath = join(dir, `scene-${String(scene.sceneNo).padStart(2, "0")}.annotation.json`);
      writeFileSync(annotationPath, `${JSON.stringify(scene.annotation, null, 2)}\n`, "utf8");
      return {
        sceneNo: scene.sceneNo,
        sceneId: `scene-${String(scene.sceneNo).padStart(2, "0")}`,
        status: "pending",
        annotationPath,
        outputPath: join(dir, `scene-${String(scene.sceneNo).padStart(2, "0")}.mp4`),
      };
    });
    const initial: WhiteboardJobState = {
      taskId,
      projectId: params.projectId,
      status: "running",
      progress: `0/${scenes.length}`,
      scenes,
      mergedPath: null,
      outputPath: null,
      durationMs: null,
      error: null,
      startedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    writeJobState(initial, this.env);

    // 异步跑：调用方拿 taskId 后由 poller 轮询（与其它供应商同构）
    activeJobs.add(taskId);
    void this.runJob(params, taskId, scenes).finally(() => activeJobs.delete(taskId));
    return { taskId };
  }

  /** 逐幕渲染 + 合并（断点续跑：已 rendered 且产物仍在的幕不重渲） */
  private async runJob(params: WhiteboardParams, taskId: string, scenes: SceneRunState[]): Promise<void> {
    const startedAt = Date.now();
    const total = scenes.length;
    const state = (): WhiteboardJobState => ({
      taskId,
      projectId: params.projectId,
      status: "running",
      progress: `${scenes.filter((s) => s.status === "rendered").length}/${total}`,
      scenes,
      mergedPath: null,
      outputPath: null,
      durationMs: null,
      error: null,
      startedAt: new Date(startedAt).toISOString(),
      updatedAt: new Date().toISOString(),
    });
    try {
      for (const [i, scene] of params.scenes.entries()) {
        const runState = scenes[i]!;
        if (resumableScene(runState)) {
          if (params.quality !== "uhd") continue;
          const size = await probeWhiteboardVideoSize(runState.outputPath, this.env).catch(() => null);
          if (size?.width === WHITEBOARD_UHD_SIZE.width && size.height === WHITEBOARD_UHD_SIZE.height) continue;
          runState.status = "pending";
        }
        runState.status = "rendering";
        writeJobState(state(), this.env);
        const result = await renderWhiteboardScene({
          imagePath: scene.lineartPath,
          annotationPath: runState.annotationPath,
          outputPath: runState.outputPath,
          handPath: params.handPath,
          fps: params.fps,
          capLongEdge: params.capLongEdge,
          quality: params.quality,
          inkPath: params.inkPath,
          colorFill: params.colorFill,
          totalMs: scene.durationMs,
          env: this.env,
        });
        runState.status = "rendered";
        runState.renderMs = result.durationMs;
        writeJobState(state(), this.env);
      }

      const clips = scenes.map((s) => s.outputPath);
      const merged = join(whiteboardEnv(this.env).jobsDir, taskId, "whiteboard-silent.mp4");
      const mergedPath = clips.length > 1
        ? await mergeWhiteboardScenes(clips, merged, { env: this.env })
        : clips[0]!;
      if (params.quality === "uhd") {
        const actual = await probeWhiteboardVideoSize(mergedPath, this.env);
        if (actual.width !== WHITEBOARD_UHD_SIZE.width || actual.height !== WHITEBOARD_UHD_SIZE.height) {
          throw new WhiteboardEngineError(`UHD 白板合并尺寸错误：实际 ${actual.width}×${actual.height}，要求 3840×2160`);
        }
      }
      const durationMs = params.scenes.reduce((sum, s) => sum + s.durationMs, 0);
      writeJobState({
        ...state(),
        status: "succeeded",
        progress: `${total}/${total}`,
        mergedPath,
        outputPath: mergedPath,
        durationMs,
      }, this.env);
    } catch (err) {
      /**
       * 错误必须**带细节**：白板渲染的失败原因全在子进程 stdout/stderr 尾部
       * （真机踩到：状态文件只留一句"白板脚本执行失败"，实际是上游 `_lay_ink` 参数不匹配的
       * TypeError，只能靠手工复现才能定位）。这里把 detail 一并落进任务目录。
       */
      const message = err instanceof WhiteboardEngineError
        ? `${err.message}${err.detail ? `｜${err.detail}` : ""}`.slice(0, 1500)
        : err instanceof Error ? err.message.slice(0, 500) : String(err);
      const failed = scenes.find((s) => s.status === "rendering");
      if (failed) { failed.status = "failed"; failed.error = message; }
      writeJobState({ ...state(), status: "failed", error: message }, this.env);
    }
  }

  /**
   * 轮询：以任务目录的 status.json 判定。
   * 产物以 `file://` 形态返回——poller 的下载器支持本地拷贝（见 gen/ingest.ts），
   * 因此入库、sha256 幂等、媒资登记与远端供应商**走同一条路**。
   */
  async poll(taskId: string): Promise<{
    status: "submitted" | "running" | "succeeded" | "failed";
    uri?: string;
    actualUnits?: number;
    error?: string;
  }> {
    const state = readJobState(taskId, this.env);
    if (!state) return { status: "running" };
    /**
     * 断点续跑接管（规格 §2.10 验收 6）：
     * 任务目录说还在跑、但本进程没有活跃任务 → 说明上一轮进程死了。
     * 这里**就地恢复**：读回 job.json 的参数 + status.json 的分幕进度，
     * 已 `rendered` 且产物仍在的幕会被 `resumableScene()` 跳过（不重复烧 CPU），
     * 从断点那一幕接着渲到合并完成。`_resume` 是竞态保护：同一拍内并发多次 poll 只接管一次。
     */
    if (state.status === "running" && !activeJobs.has(taskId) && !resuming.has(taskId)) {
      const jobFile = join(whiteboardEnv(this.env).jobsDir, taskId, "job.json");
      if (existsSync(jobFile)) {
        const params = JSON.parse(readFileSync(jobFile, "utf8")) as WhiteboardParams;
        const scenes = state.scenes.map((scene) => ({
          ...scene,
          // 上一轮死在渲染中的那一幕没有终结态：显式打回 pending 重跑该幕
          status: scene.status === "rendering" ? "pending" as const : scene.status,
        }));
        resuming.add(taskId);
        activeJobs.add(taskId);
        console.warn(
          `[whiteboard] 接管未完成的任务 ${taskId}：`
          + `${scenes.filter((s) => s.status === "rendered").length}/${scenes.length} 幕已完成，从断点续渲`,
        );
        void this.runJob(params, taskId, scenes)
          .finally(() => { activeJobs.delete(taskId); resuming.delete(taskId); });
      }
    }
    if (state.status === "succeeded" && state.outputPath) {
      return {
        status: "succeeded",
        uri: `file://${state.outputPath}`,
        actualUnits: state.durationMs ? Math.max(1, Math.round(state.durationMs / 1000)) : undefined,
      };
    }
    if (state.status === "failed") return { status: "failed", error: state.error ?? "白板渲染失败（无原因文本）" };
    return { status: "running" };
  }
}
