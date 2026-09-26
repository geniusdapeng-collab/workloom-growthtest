/**
 * video/whiteboard/lineart.ts —— 逐幕线稿（T-2026-0926-0020）
 *
 * 两条来源（上游 SKILL.md 规定"线稿不在仓内生成"，本仓库把它工程化成两条确定性路径）：
 *
 *   A. `seedream`（默认）：复用成片链路的方舟图像接缝（同 ARK_API_KEY / 同一目录条目），
 *      提示词固化为上游「统一出图视觉规范」；出图后过**风格机检三道**（纸底颜色 / 深色块 / 连通域数），
 *      不过则带上失败原因重出，最多 `WHITEBOARD_LINEART_RETRY` 次——重出不是重采样碰运气，
 *      而是把机检读数写回提示词。
 *   B. `sketch`：媒资库/本地实拍图 → cv2 素描化（零模型成本，老素材复用，
 *      对应规格 §2.4 路径 B）。
 *
 * 与规格书 §2.4 的一条**实施期修正**：规格书写"路径 A 让模型同时输出 elements 清单 + 大致方位"。
 * 实测方舟 `images/generations` 只回图像 URL，**没有任何结构化 bbox/元素清单**（见
 * `gen/providers.ts#ArkImageProvider.submit`：payload 仅 prompt/size/seed，响应仅取 `data[0].url`）。
 * 因此元素方位不在出图阶段索取，而是出图后由 `lineart_tools.py analyze` 从**像素**反推
 * （连通域 + 确定性聚合），这也让两条路径共用同一套区域来源，标注阶段不再分叉。
 */
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { downloadToMediaStore } from "../gen/ingest.js";
import { getModel, resolveProviderModel } from "../gen/catalog.js";
import { videoGenPool } from "../gen/providers.js";
import { WhiteboardEngineError, readImageSize, runLineartTool, whiteboardEnv } from "./engine.js";

/** 上游 SKILL.md 的「统一出图视觉规范」逐条固化（禁止改动措辞：风格漂移会直接毁掉系列一致性） */
export const LINEART_STYLE_PROMPT = [
  "极简手绘线稿插画，纯素描草图风格，类似 Notion 的克制涂鸦美学。",
  "暖米黄色旧纸张背景（#F5EBD7），深灰色素描线条（#3A3E46），干净背景、大量留白。",
  "对象以简洁轮廓与少量线条表达，强调关系、变化与核心概念，不追求写实比例与细节。",
  "红、橙、蓝仅允许极少量概念性点缀。",
  "禁止：画面中的任何文字、词语、字母、数字、标签；写实感、摄影细节、3D 效果、绘画质感；",
  "复杂场景、密集背景、繁复装饰、高饱和度配色。",
  "画面主体之间必须互不重叠、彼此留出清晰空隙，便于后续分区绘制。",
].join("");

export interface LineartCheck {
  ok: boolean;
  checks: Array<{ id: string; pass: boolean; detail: string }>;
  metrics: Record<string, unknown>;
}

export interface LineartResult {
  /** 媒体仓相对路径（入库口径，与 video_assets.meta.localPath 对齐） */
  relPath: string;
  absPath: string;
  source: "seedream" | "sketch" | "upload";
  prompt: string | null;
  check: LineartCheck;
  /** 出图重试次数（0 = 一次过） */
  attempts: number;
}

export interface LineartOptions {
  workspaceId: string;
  sceneNo: number;
  jobDir: string;
  /** 这一幕要表达的核心意思（进提示词的"画面内容"位） */
  coreIdea: string;
  /** 这一幕字幕里出现的具体对象/动作（进提示词的"必须出现的元素"位） */
  elements: string[];
  env?: NodeJS.ProcessEnv;
  fetchImpl?: typeof fetch;
}

/** 出图提示词：规范 + 本幕内容 + 本幕元素（元素清单是"看得见什么"的唯一来源） */
export function buildLineartPrompt(coreIdea: string, elements: string[]): string {
  const items = elements.map((e) => e.trim()).filter(Boolean);
  return [
    LINEART_STYLE_PROMPT,
    `画面内容：${coreIdea.trim()}。`,
    items.length > 0 ? `必须出现的元素：${items.join("、")}。` : "",
    "16:9 横向构图，主体居中偏上，四边保留充足留白。",
  ].filter(Boolean).join("\n");
}

/** 风格机检（调 lineart_tools.py check；非 0 退出码代表"不过"，其 JSON 仍要读出来做重出依据） */
export async function checkLineart(absPath: string, env: NodeJS.ProcessEnv = process.env): Promise<LineartCheck> {
  const res = await runLineartTool<{ checks: LineartCheck["checks"]; metrics: Record<string, unknown> }>(
    ["check", "--in", absPath],
    { env, allowNonZero: true, timeoutMs: 120_000 },
  );
  if (!res.ok) {
    // 工具本身报错（读不了图等）：当成"机检不过"，原因带进重出提示词
    return { ok: false, checks: [{ id: "tool", pass: false, detail: res.error }], metrics: {} };
  }
  return { ok: true, checks: res.checks, metrics: res.metrics };
}

/**
 * 路径 A：Seedream 出图（含机检重出）。
 *
 * 重出的正确姿势（对齐全仓"反复重跑烧额度"根因修复的口径）：把**上一轮的机检失败项**
 * 显式写进下一轮提示词，而不是只换 seed 重采样。
 */
async function generateSeedream(opts: LineartOptions): Promise<{ bytes: Buffer; prompt: string; attempts: number; check: LineartCheck }> {
  const env = opts.env ?? process.env;
  if (!env.VOLCENGINE_ARK_API_KEY?.trim()) {
    throw new WhiteboardEngineError(
      "Seedream 线稿需要 VOLCENGINE_ARK_API_KEY（ARK_API_KEY 亦可）",
      "要么配置方舟密钥，要么把线稿路径改为 sketch（WHITEBOARD_LINEART=sketch，用媒资库实拍图素描化）",
    );
  }
  const modelId = env.WHITEBOARD_LINEART_MODEL?.trim() || "doubao-seedream-5-0-pro";
  const model = getModel(modelId);
  if (!model) throw new WhiteboardEngineError(`媒体目录中不存在图像模型：${modelId}`);
  const provider = videoGenPool().get(model.provider);
  if (!provider) {
    throw new WhiteboardEngineError(
      `图像供应商 ${model.provider} 未装配（缺密钥或被禁用）`,
      "检查 provider 装配：gen/providers.ts#buildVideoGenPool",
    );
  }
  const providerModel = resolveProviderModel(model, env);
  const maxAttempts = Math.max(1, Number(env.WHITEBOARD_LINEART_RETRY ?? "3"));
  let lastCheck: LineartCheck = { ok: false, checks: [], metrics: {} };
  let prompt = buildLineartPrompt(opts.coreIdea, opts.elements);
  let bytes: Buffer | null = null;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const { taskId } = await provider.submit({
      prompt,
      estimatedUnits: 1,
      refId: `whiteboard-scene-${opts.sceneNo}`,
      params: { providerModel, resolution: env.WHITEBOARD_LINEART_SIZE?.trim() || "2K" },
    });
    const snapshot = await provider.poll(taskId);
    if (snapshot.status !== "succeeded" || !snapshot.uri) {
      throw new WhiteboardEngineError(
        `Seedream 出图失败（第 ${attempt} 次）：${snapshot.error ?? "无产物 URL"}`,
      );
    }
    const res = await fetch(snapshot.uri);
    if (!res.ok) throw new WhiteboardEngineError(`线稿下载失败：HTTP ${res.status}`);
    bytes = Buffer.from(await res.arrayBuffer());

    const probe = join(opts.jobDir, `scene-${pad(opts.sceneNo)}.lineart.probe.png`);
    writeFileSync(probe, bytes);
    lastCheck = await checkLineart(probe, env);
    if (lastCheck.ok) {
      return { bytes, prompt, attempts: attempt, check: lastCheck };
    }
    const failed = lastCheck.checks.filter((c) => !c.pass)
      .map((c) => `${c.detail}`).join("；");
    prompt = [
      buildLineartPrompt(opts.coreIdea, opts.elements),
      `【上一版被机检打回，本轮必须修复】${failed}`,
      "特别注意：背景必须是干净的暖米黄旧纸色，不要出现大面积深色块；画面不要杂乱，主体控制在 2–8 个。",
    ].join("\n");
  }
  if (!bytes) throw new WhiteboardEngineError("Seedream 出图未拿到图像字节");
  return { bytes, prompt, attempts: maxAttempts, check: lastCheck };
}

function pad(n: number): string {
  return String(n).padStart(2, "0");
}

/**
 * 逐幕线稿（对外唯一入口）。
 *
 * @param sourcePath 路径 B 的输入实拍图（`sketch` 时必填；`upload` 时即该图本身）
 */
export async function buildSceneLineart(
  input: LineartOptions & { mode: "seedream" | "sketch" | "upload"; sourcePath?: string },
): Promise<LineartResult> {
  const env = input.env ?? process.env;
  mkdirSync(input.jobDir, { recursive: true });
  const name = `scene-${pad(input.sceneNo)}.lineart.png`;
  const outPath = join(input.jobDir, name);

  if (input.mode === "seedream") {
    const { bytes, prompt, attempts, check } = await generateSeedream(input);
    writeFileSync(outPath, bytes);
    return { relPath: outPath, absPath: outPath, source: "seedream", prompt, check, attempts };
  }

  if (!input.sourcePath) {
    throw new WhiteboardEngineError(
      `线稿路径 ${input.mode} 需要一张输入图（媒资库选图或上传的实拍图）`,
      "在 whiteboard.lineart 调用里显式传 sourcePath，或把 WHITEBOARD_LINEART 改回 seedream",
    );
  }
  if (input.mode === "upload") {
    const buf = (await import("node:fs")).readFileSync(input.sourcePath);
    writeFileSync(outPath, buf);
  } else {
    const res = await runLineartTool<{ output: string }>(
      ["sketch", "--in", input.sourcePath, "--out", outPath],
      { env, timeoutMs: 300_000 },
    );
    if (!res.ok) throw new WhiteboardEngineError(`素描化失败：${res.error}`);
  }
  if (!existsSync(outPath)) throw new WhiteboardEngineError(`线稿未产出：${outPath}`);
  const check = await checkLineart(outPath, env);
  return { relPath: outPath, absPath: outPath, source: input.mode, prompt: null, check, attempts: 1 };
}

/**
 * 线稿入库媒资库（kind='upload_image'）——白板线稿是可复用资产：
 * 同一条线稿改标注即可重出另一种节奏的片子（上游 SKILL.md 的"预览台调整后重渲"工作流）。
 */
export async function storeLineart(
  absPath: string,
  opts: { workspaceId: string; fetchImpl?: typeof fetch },
): Promise<{ relPath: string; sha256: string; bytes: number }> {
  const size = readImageSize(absPath);
  if (!size) throw new WhiteboardEngineError(`线稿不是可解析的 PNG/JPEG：${absPath}`);
  const stored = await downloadToMediaStore(`file://${absPath}`, {
    workspaceId: opts.workspaceId,
    fetchImpl: opts.fetchImpl,
  });
  return { relPath: stored.relPath, sha256: stored.sha256, bytes: stored.bytes };
}

/** 线稿产物名（排障时按幕号直接找文件） */
export function lineartFileName(sceneNo: number): string {
  return `scene-${pad(sceneNo)}.lineart.png`;
}

/** 线稿检查图的旁证文件名（保留在 job 目录，便于复核机检读数） */
export function lineartProbeName(sceneNo: number): string {
  return basename(`${lineartFileName(sceneNo)}.probe`);
}
