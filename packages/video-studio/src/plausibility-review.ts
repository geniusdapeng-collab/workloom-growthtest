/**
 * plausibility-review —— 实体与物理常识审核 agent（T-2026-1011-0001）
 *
 * 设计取向（产品所有者 2026-10-11 复盘口径）：
 *   **世界知识不枚举**。汽车、自行车、相机、牛肉馅饺子……世间万物无法穷举成规则表；
 *   正确的分工是：机械事实（台词逐字、语言、档案完整性）留给确定性判据，
 *   **"这个主体在真实世界里怎么存在、怎么被使用、比例/接触/动力/装备是否成立"交给模型的世界模型**——
 *   由本模块作为一个"监制 agent"逐镜推理，产出可执行结论（blocker/warning + 修法 + 提示词补丁）。
 *
 * 与既有评审设施的关系：
 *   · 复用 `resolveProducerLlm`（同一把评审模型钥匙）与 producer-gate 的 chat 协议；
 *   · 但本审核**不受 `--review-policy off` 影响**：它判的是"事实与常识是否成立"，
 *     不是渲后审美复审——这是花钱前必须过的事实闸（真机样本 820RR-RC 的 7 类缺陷都属这一类）。
 *
 * 两个调用点（都由 CLI 编排）：
 *   ① 前期（关键帧之前，卡片+提示词+商品档案）→ 拦"逻辑/常识/口径"缺陷；
 *   ② 出片前（关键帧之后、视频提交之前，带关键帧图像）→ 拦"比例/换人/CG 感/装备/品牌保真"视觉缺陷。
 */
import { existsSync, readFileSync, statSync } from "node:fs";
import { resolveProducerLlm } from "./producer-gate.js";
import {
  DEEPSEEK_IMAGE_LIMIT_BYTES,
  OpenAiCompatibleProvider,
  type ModelContentPart,
} from "@workloom/base/model-router";

export const PLAUSIBILITY_POLICY_VERSION = "workloom.plausibility-review/v1" as const;
/** @deprecated Character budgets are not a model context unit. */
export const PLAUSIBILITY_CONTEXT_BUDGET = 60_000;
export const PLAUSIBILITY_IMAGE_BUDGET_BYTES = DEEPSEEK_IMAGE_LIMIT_BYTES;

/**
 * 通用审核 rubric（品类无关）：
 * 不告诉模型"机车要头盔"，而是要求它**用自己的世界知识**逐镜回答下面这些问题并给证据与修法。
 */
export const PLAUSIBILITY_RUBRIC: string[] = [
  "主体是什么？它在真实世界里由谁使用、如何使用？把这句话写出来，再判断画面是否成立。",
  "任何运动都必须有可见动因：操作者（骑手/驾驶员/飞手/摄影者/食客/使用者）或明确外力；镜头里出现「自己会动」的主体即为 blocker。",
  "该主体真实使用时有哪些必备装备/配套物（用你自己的常识判断，不要依赖本案给出的清单）？缺失即 blocker 或 warning，并说明为什么。",
  "人与物、物与环境的真实尺度比例：主体相对人、家具、餐具、手掌的量级是否合理？出现玩具比例、微缩模型感或明显放大即 blocker。",
  "物理自洽：重力、支撑、接触、承重、动力、惯性、流体/热气/火花等是否符合常识？悬空、穿模、无支撑、凭空出现/消失即 blocker。",
  "主体的使用状态是否明确？既没有使用动作、也没有明确的停放/展示/静置状态时，模型会自由发挥出无意义静物或凭空动作——按严重度报 warning 或 blocker。",
  "商品保真：与给定商品档案（名称/品牌/类别/尺寸/角度照片/参数）相比，结构、比例、标识、配色是否被改写？改写即 blocker。",
  "真实感：画面是否像实拍摄影（真实光学、材质、使用痕迹），还是像 CG/游戏过场（超净表面、游戏式光照与镜头光晕）？像后者即 blocker，并给出实拍化修法。",
  "法规、安全与常识禁忌：这个主体在真实世界里有哪些「不能这样做」的硬边界（由你判断，并写明依据）？违反按严重度报 blocker/warning。",
  "镜头叙事逻辑：相邻镜的动作、视线、方向、时段与人物是否接得上？换人、断手断脚、人数突变、时间倒流即 blocker。",
  "输出必须可执行：每条 finding 给出 shotId、严重度（blocker|warning）、问题、为什么、最小修法；如可用提示词补丁修，给出 promptPatches（逐镜中文条款，直接追加进该镜提示词）。",
];

export interface PlausibilityShotInput {
  shotId: string;
  durationSec?: number;
  scene?: string;
  sceneDescription?: string;
  action?: string;
  props?: string;
  character?: string;
  dialogue?: unknown;
  dialogueFree?: boolean;
  product?: string;
  promptText?: string;
}
export interface PlausibilityProductFacts {
  id: string;
  displayName?: string;
  brand?: string;
  category?: string;
  sourceKind?: string;
  reviewStatus?: string;
  dimensions?: Record<string, unknown>;
  photoAngles?: string[];
  parameters?: Array<{ name: string; value: string }>;
  features?: string[];
  appearance?: string;
}
export interface PlausibilityContextInput {
  projectId: string;
  platform?: string;
  locale?: string;
  aspect?: string;
  resolution?: string;
  durationSeconds?: number;
  character?: { name?: string; height?: string; appearance?: string } | null;
  products?: PlausibilityProductFacts[];
  shots: PlausibilityShotInput[];
  /** 画面证据（第二遍：关键帧），标签→文件路径 */
  images?: Array<{ label: string; path: string }>;
  stage: "pre-render" | "pre-submit";
}

export interface PlausibilityFinding {
  id: string;
  severity: "blocker" | "warning";
  shotId: string | null;
  issue: string;
  why: string;
  fix: string;
}
export interface PlausibilityPromptPatch { shotId: string; clauses: string[] }
export interface PlausibilityResult {
  policy: typeof PLAUSIBILITY_POLICY_VERSION;
  stage: PlausibilityContextInput["stage"];
  verdict: "pass" | "block" | "unverified";
  findings: PlausibilityFinding[];
  promptPatches: PlausibilityPromptPatch[];
  reason: string;
  model: string | null;
  ms: number;
  /** 评审模型调用次数（T-2026-1013-0001：解析失败/5xx 时最多重试一次） */
  attempts?: number;
  receipt?: {
    inputTokens: number;
    outputTokens: number;
    reasoningTokens: number;
    outputCeiling: number;
    finishReason: string;
    requestHash: string;
    responseHash: string;
    responseId: string | null;
    policyVersion: string;
    registryVersion: string;
  };
}

/** 组装送审上下文：把"事实"给足（档案/角色/平台/卡片/提示词），不作任何品类规则注入。 */
export function buildPlausibilityContext(input: PlausibilityContextInput): Record<string, unknown> {
  const context = {
    policy: PLAUSIBILITY_POLICY_VERSION,
    stage: input.stage,
    project: {
      id: input.projectId, platform: input.platform ?? null, locale: input.locale ?? null,
      aspect: input.aspect ?? null, resolution: input.resolution ?? null, durationSeconds: input.durationSeconds ?? null,
    },
    character: input.character ?? null,
    products: (input.products ?? []).map((product) => ({
      id: product.id, displayName: product.displayName ?? null, brand: product.brand ?? null,
      category: product.category ?? null, sourceKind: product.sourceKind ?? null, reviewStatus: product.reviewStatus ?? null,
      dimensions: product.dimensions ?? null, photoAngles: product.photoAngles ?? [], appearance: product.appearance ?? null,
      features: product.features ?? [], parameters: product.parameters ?? [],
    })),
    shots: input.shots.map((shot) => ({
      shotId: shot.shotId, durationSec: shot.durationSec ?? null,
      scene: shot.scene ?? null, sceneDescription: shot.sceneDescription ?? null,
      action: shot.action ?? null, props: shot.props ?? null, character: shot.character ?? null,
      dialogue: shot.dialogue ?? null, dialogueFree: shot.dialogueFree === true,
      product: shot.product ?? null,
      promptText: shot.promptText ?? null,
    })),
  };
  const serialized = JSON.stringify(context);
  void serialized;
  return context;
}

const trim = (value: unknown): string => String(value ?? "").trim();

/**
 * 容错解析（T-2026-1013-0001）：评审模型常在 JSON 前后带说明文字或尾注，直接 JSON.parse 会把
 * "可用的判定"判成 unverified → 整轮白跑（真机 2026-10-12 run-25b / run-92 各一次）。
 * 这里只做**提取**：取第一个平衡的 {...}（跳过字符串内的括号与转义）；提取失败时保持原行为（上层仍 fail-closed）。
 */
export function parseJsonObjectLoose(text: string): unknown {
  const start = text.indexOf("{");
  if (start < 0) throw new Error("PLAUSIBILITY_JSON_MISSING: 输出中找不到 JSON 对象");
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = start; index < text.length; index += 1) {
    const char = text[index]!;
    if (inString) {
      if (escaped) { escaped = false; continue; }
      if (char === "\\") { escaped = true; continue; }
      if (char === '"') inString = false;
      continue;
    }
    if (char === '"') { inString = true; continue; }
    if (char === "{") depth += 1;
    else if (char === "}") {
      depth -= 1;
      if (depth === 0) return JSON.parse(text.slice(start, index + 1));
    }
  }
  return JSON.parse(text);
}


/** 解析模型输出（容错：去 markdown 围栏；结构非法即抛错→上层 fail-closed）。 */
export function parsePlausibilityAnswer(raw: string): { verdict: "pass" | "block"; findings: PlausibilityFinding[]; promptPatches: PlausibilityPromptPatch[]; reason: string } {
  const stripped = trim(raw).replace(/^```(?:json)?/i, "").replace(/```$/, "").trim();
  const value = parseJsonObjectLoose(stripped) as Record<string, unknown>;
  const verdict = value.verdict === "block" ? "block" : value.verdict === "pass" ? "pass" : null;
  if (!verdict) throw new Error("PLAUSIBILITY_VERDICT_INVALID: 缺少 verdict(pass|block)");
  const findingsRaw = Array.isArray(value.findings) ? value.findings : [];
  const findings: PlausibilityFinding[] = findingsRaw.map((item, index) => {
    const row = item && typeof item === "object" ? item as Record<string, unknown> : {};
    const severity = row.severity === "blocker" ? "blocker" : row.severity === "warning" ? "warning" : null;
    if (!severity) throw new Error(`PLAUSIBILITY_FINDING_INVALID: findings[${index}].severity`);
    const issue = trim(row.issue);
    if (!issue) throw new Error(`PLAUSIBILITY_FINDING_INVALID: findings[${index}].issue`);
    return {
      id: trim(row.id) || `plausibility-${index + 1}`,
      severity,
      shotId: trim(row.shotId) || null,
      issue,
      why: trim(row.why) || "模型未给出理由",
      fix: trim(row.fix) || "按问题修复后重跑本环节",
    };
  });
  const patches: PlausibilityPromptPatch[] = (Array.isArray(value.promptPatches) ? value.promptPatches : []).map((item) => {
    const row = item && typeof item === "object" ? item as Record<string, unknown> : {};
    const shotId = trim(row.shotId);
    const clauses = Array.isArray(row.clauses) ? row.clauses.map(trim).filter(Boolean) : [];
    if (!shotId || clauses.length === 0) throw new Error("PLAUSIBILITY_PATCH_INVALID: promptPatches 需 {shotId, clauses[]}");
    return { shotId, clauses };
  });
  if (verdict === "block" && !findings.some((finding) => finding.severity === "blocker")) {
    throw new Error("PLAUSIBILITY_VERDICT_INVALID: verdict=block 但没有 blocker finding");
  }
  return { verdict, findings, promptPatches: patches, reason: trim(value.reason) || (verdict === "block" ? "存在不成立的事实/常识" : "实体与物理常识通过") };
}

function encodeImages(images: Array<{ label: string; path: string }>): ModelContentPart[] {
  const parts: ModelContentPart[] = [];
  for (const image of images) {
    if (!existsSync(image.path) || !statSync(image.path).isFile()) throw new Error(`PLAUSIBILITY_IMAGE_MISSING: ${image.path}`);
    const bytes = readFileSync(image.path);
    if (bytes.length > PLAUSIBILITY_IMAGE_BUDGET_BYTES) throw new Error(`PLAUSIBILITY_IMAGE_TOO_LARGE: ${image.path}（${bytes.length}B）`);
    const png = bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
    const jpeg = bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255;
    const webp = bytes.toString("ascii", 0, 4) === "RIFF" && bytes.toString("ascii", 8, 12) === "WEBP";
    if (!(png || jpeg || webp)) throw new Error(`PLAUSIBILITY_IMAGE_INVALID: ${image.path}`);
    parts.push({ type: "text", text: `画面证据：${image.label}` });
    parts.push({ type: "image_url", image_url: { url: `data:${png ? "image/png" : jpeg ? "image/jpeg" : "image/webp"};base64,${bytes.toString("base64")}` } });
  }
  return parts;
}

/**
 * 调用评审模型做一次审核。
 * · 无模型 / HTTP 失败 / 结构非法 → `unverified`（**由调用方 fail-closed**：事实闸不允许静默放行）；
 * · 模型给出 blocker → `block`；只有 warning 或没有 finding → `pass`。
 */
export async function reviewPlausibility(
  input: PlausibilityContextInput,
  options: { env?: Record<string, string | undefined>; fetchImpl?: typeof fetch; log?: (line: string) => void } = {},
): Promise<PlausibilityResult> {
  const started = Date.now();
  const log = options.log ?? (() => undefined);
  const env = options.env ?? process.env;
  const base = {
    policy: PLAUSIBILITY_POLICY_VERSION, stage: input.stage,
    findings: [] as PlausibilityFinding[], promptPatches: [] as PlausibilityPromptPatch[], model: null as string | null,
  };
  let context: Record<string, unknown>;
  try {
    context = buildPlausibilityContext(input);
  } catch (error) {
    return { ...base, verdict: "unverified", reason: error instanceof Error ? error.message : String(error), ms: Date.now() - started };
  }
  const llm = resolveProducerLlm(env);
  if (!llm) {
    return { ...base, verdict: "unverified", reason: "无可用评审模型（需配置评审模型密钥）；实体与物理常识审核 fail-closed", ms: Date.now() - started };
  }
  let images: ModelContentPart[] = [];
  try {
    images = encodeImages(input.images ?? []);
  } catch (error) {
    return { ...base, verdict: "unverified", reason: error instanceof Error ? error.message : String(error), ms: Date.now() - started };
  }
  const content: ModelContentPart[] = [
    {
      type: "text",
      text: [
        "你是影视监制中的【实体与物理常识审核 agent】。用你自己的世界知识判断，不要假设观众或审查方已提供任何品类规则表。",
        "对每个镜头逐条回答下列问题；不能确定的写进 warning 并说明缺什么证据，不要编造。",
        ...PLAUSIBILITY_RUBRIC.map((line, index) => `${index + 1}. ${line}`),
        input.stage === "pre-submit"
          ? "本轮附有关键帧画面（逐镜）：比例、身份、装备、品牌保真与真实感必须结合画面判断；只凭文字看不到的缺陷要在本轮报出。"
          : "本轮只有卡片与提示词：请判断逻辑/常识/口径层面是否成立（无人驾驶、缺装备、比例无锚、台词与语言、叙事逻辑等）。",
        "送审事实（JSON，完整）：",
        JSON.stringify(context),
        '只输出 JSON：{"verdict":"pass|block","findings":[{"id":"","severity":"blocker|warning","shotId":"","issue":"","why":"","fix":""}],"promptPatches":[{"shotId":"","clauses":["中文提示词条款"]}],"reason":"一句话结论"}',
      ].join("\n"),
    },
    ...images,
  ];
  try {
    const provider = new OpenAiCompatibleProvider(llm.model, {
      baseUrl: llm.baseUrl,
      apiKey: llm.apiKey,
      fetchImpl: options.fetchImpl,
    });
    const result = await provider.chat([{ role: "user", content }], {
      scene: "video.quality.plausibility-review",
      timeoutMs: 600_000,
      temperature: 0.1,
      retries: 1,
    });
    const parsed = parsePlausibilityAnswer(result.text);
    const blockers = parsed.findings.filter((finding) => finding.severity === "blocker");
    const verdict = parsed.verdict === "block" && blockers.length > 0 ? "block" : "pass";
    log(`[plausibility][${input.stage}] ${verdict}：blocker ${blockers.length} · warning ${parsed.findings.length - blockers.length}`);
    return {
      ...base, verdict, findings: parsed.findings, promptPatches: parsed.promptPatches,
      reason: parsed.reason, model: result.modelId, ms: Date.now() - started,
      attempts: 1 + result.attempts.length,
      receipt: {
        inputTokens: result.promptTokens,
        outputTokens: result.completionTokens,
        reasoningTokens: result.reasoningTokens,
        outputCeiling: result.outputCeiling,
        finishReason: result.finishReason,
        requestHash: result.requestHash,
        responseHash: result.responseHash,
        responseId: result.responseId,
        policyVersion: result.policyVersion,
        registryVersion: result.registryVersion,
      },
    };
  } catch (error) {
    return { ...base, verdict: "unverified", reason: `评审调用/解析失败：${error instanceof Error ? error.message : String(error)}`, ms: Date.now() - started };
  }
}

/** 把模型给出的提示词补丁合并进对应镜头的提示词文本（追加，不改写原文）。 */
export function applyPromptPatches(
  patches: readonly PlausibilityPromptPatch[],
  prompts: Map<string, string>,
): Map<string, string> {
  const next = new Map(prompts);
  for (const patch of patches) {
    const current = next.get(patch.shotId);
    if (typeof current !== "string") continue;
    const addition = patch.clauses
      .map((clause) => clause.trim())
      .filter((clause) => clause && !current.includes(clause))
      .join(" | ");
    if (!addition) continue;
    next.set(patch.shotId, `${current} | 【常识审核补丁】${addition}`);
  }
  return next;
}
