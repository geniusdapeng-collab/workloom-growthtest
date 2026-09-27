/**
 * producer-gate —— AI 监制（制片人）门：把"人工确认"换成"机器评审 + 打回重跑"
 *
 * 背景（T-2026-0924-0001）：
 *   视频链路上原有 G1–G7 七个确认门。早先实现是两道极端：要么挂人工审批卡等人点（停线），
 *   要么用 `HR_AUTO_GATES` 一律 `approved:true`（等于没有质量门，坏产物直接往下流）。
 *   产品口径是**全自动预生产 + 人类只在花钱/对外时介入**，所以中间门需要的是"AI 监制"：
 *   看产物、按纪律打分、不合格就打回重跑，并把裁决写进日志与事件。
 *
 * 本模块提供三件事：
 *   1. `PRODUCER_RUBRICS` —— 逐环节评审要点（与 bundles/ai-video/skills 的纪律同源）；
 *   2. 确定性硬闸（调用方传入 ffprobe/文件校验结果）—— 硬失败直接打回，不消耗模型额度；
 *   3. 可选的 LLM 评审（含图像）—— 打分 + 问题清单 + 修改建议；模型不可用时**如实降级**并标注。
 *
 * 纪律：默认 fail-closed —— 硬闸失败必打回；LLM 不可用且无硬闸结论时**不放行**（返回 rerun），
 * 模型/证据不可用时保持 unverified；旧 allowFallbackApprove 参数不再授予正式通过资格。
 */

export type ProducerStage =
  | "script"
  | "continuity"
  | "micromotion"
  | "prompt"
  | "keyframe"
  | "shot"
  | "compose"
  | "color"
  | "subtitle"
  | "mux"
  | "danmaku"
  | "bgm"
  | "cover"
  | "master";

import { existsSync, readFileSync, rmSync, statSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID, createHash } from "node:crypto";
import { spawnSync } from "node:child_process";

import type { QualityStatus } from "./quality-evidence.js";
import { normalizeShotIntent, shotIntentHash, type ShotIntentStatus } from "./shot-intent.js";
import { devicePolicyPromptLines } from "./device-policy.js";
import { environmentDefects, expandShotWithBible, environmentProfilePromptLines, propInteractionPromptLines, type SceneBible } from "./scene-bible.js";
import { resolveEraProfile, type EraProfile } from "./era-profile.js";

export interface DeterministicCheck {
  status?: QualityStatus;
  id: string;
  pass: boolean;
  detail: string;
  /** 硬闸：失败即打回（LLM 无权推翻）。缺省 = 软信号（只进问题清单，不影响放行判定） */
  hard?: boolean;
}

export interface ProducerArtifact {
  path: string;
  kind: "image" | "video" | "audio" | "text" | "json";
  bytes?: number;
  /** ffprobe 摘要（video/audio）：width/height/duration/loudness 等 */
  probe?: Record<string, unknown>;
  note?: string;
}

export interface ProducerVerdict {
  status: QualityStatus;
  /** Binds the exact supplied source contracts; absent means no structured contract was supplied. */
  contractHash?: string;
  evidence?: Array<{ path: string; sha256: string; scope: string }>;
  stage: ProducerStage;
  approved: boolean;
  /** 0–100；硬闸失败为 0 */
  score: number;
  hardFailures: string[];
  issues: string[];
  suggestions: string[];
  /** 建议重跑本环节（approved=false 时恒为 true） */
  rerun: boolean;
  via: "deterministic" | "llm" | "fallback";
  model?: string;
  ms: number;
  reason: string;
  /** 证据或模型不可用；degraded 不具备放行资格。 */
  degraded: boolean;
}

/**
 * 逐环节评审要点（与 bundles/ai-video/skills 的纪律同源；中文，便于直接落日志/审批卡）。
 * 注意：这里是"监制看什么"，不是确定性断言——确定性断言由调用方按产物实测传入。
 */
export const PRODUCER_RUBRICS: Record<ProducerStage, string[]> = {
  script: [
    "台词速率和时长符合明确交付合同，无台词镜头不添加对白；总时长与目标一致",
    "动作、静止、情绪与每镜叙事目的相符，不强迫空镜或克制表演产生动作变化",
    "开场、推进和收尾服务当前 brief；年代、主体、人数与原镜头合同一致"
  ],
  prompt: [
    "所用生成器要求的字段齐备、含义明确；不以字数或模板堆叠代替实际可拍摄内容",
    "光源、画幅、主体人数、动作、台词及清晰范围符合当前镜头合同，不含退化对象字符串",
    "没有添加原卡禁止的意象；题材词是否适用按本片 brief 判断；定妆照背景不带入场景"
  ],
  continuity: [
    "逐角色身份与本镜服装妆造合同一致；明确换装、多人和角色不出镜均按原卡处理",
    "同一 sceneId 的空间锚点连续；不同空间、转场和闪回按剧本明确关系处理",
    "时段、光源、运动方向、视线与道具状态的变化有叙事或动作依据",
    "总时长、节奏和情绪符合当前 brief，不要求固定镜头数量或单调时序"
  ],
  micromotion: [
    "只检查主体与可见部位适用的微动作；空镜、产品无需人体通道，睡眠不加眨眼，无对白不加口语融合",
    "实际写入的微动作有可核对的当前源和输出证据，不用通道数量或标记替代成功",
    "保持原姿态、动作、表情禁令、台词与时长；完整句增量不超过200字"
  ],
  keyframe: [
    "主体种类、人数、可见部位、身份和本镜服装符合原卡；空镜不加人，多人不按单人标准删除",
    "构图、画幅、视线、光源方向、时段、白平衡和景深服从原镜头，不套固定5600K或题材景深",
    "可见结构的尺度、透视、光影、接触和承重自洽，无畸变穿模；桥头在画外或特写时不强求两岸可见",
    "按环境档案检查材质工艺和状态；used保留所声明痕迹，new/sterile不编磨损，studio/product允许已声明棚光",
    "道具按operate/present/shared-view/rest的用途核对朝向与接触；展示给观众不因朝外被拒",
    "设备外观与具体型号、冻结故事日期和显式devicePolicy一致；未提供的年代或型号保持未验证",
    "写实效果与交付风格相符，无未要求的文字或水印；可见皮肤和肢体自然"
  ],
  shot: [
    "人物动作、静止或克制表情按当前合同执行，重心和接触自然；不要求每镜微笑或表情丰富",
    "有可见说话人时核对口型证据；无对白或背影不冒称口型已验证，抽帧不能替代连续视听检查",
    "同一镜头的结构、材质、光源与设备外观保持时序一致；明确动作导致的朝向变化允许",
    "屏幕朝向服从操作/展示/共享合同，位移由动作衔接，无道具跳变、穿模或身份漂移"
  ],
  compose: ["拼接与转场符合剪辑合同，无花屏、丢帧或未经授权的音画变化", "时长、画幅、帧率与像素格式符合明确交付规格"],
  color: ["光源色温和创作色彩按本片合同保留；肤色、暗部和高光的变化须有照明依据", "镜间影调与叙事相符；调色方案和原片分别评审，不能用失败调色证明原片通过"],
  subtitle: ["字幕位于安全区，字体、字号与对比度在实际画面可读", "逐条对照原台词和时间轴核对内容、断句、同步与遮挡；无对白按明确字幕策略处理"],
  mux: ["软字幕版可播放且字幕轨可开关，视频和音频与审核母版保持一致", "旁挂字幕及语言清单齐备，软轨内容与旁挂文件一致，时长符合合同"],
  danmaku: ["按本片明确启用的弹幕规格检查内容、密度、分层和遮挡", "未启用或不适用时不为了凑后期能力添加弹幕"],
  bgm: ["响度、真峰值及音乐与人声的关系符合明确音频交付合同", "曲风、节拍、唱词适用性与本片brief一致；实际听音证据独立提供，图像模型不冒充听音"],
  cover: ["文案与成片一致并在平台安全区内可读，避免遮挡本片关键主体", "封面风格和色彩符合成片与平台规格；主体不必是人脸"],
  master: [
    "整片播放、时长、画幅、帧率、字幕和音轨符合交付合同，无黑帧或编码事故",
    "已要求的后期能力逐项有真实产物和证据；不适用项必须有明确依据，不强制五项全部启用",
    "按sceneId、角色身份、道具和转场合同核对跨镜一致性，允许明确换装、多空间与闪回",
    "环境状态、道具朝向和设备年代按逐镜合同复核，不套全磨损、全屏幕朝内或全Apple模板",
    "听音、连续时序、来源与最终交付检查由对应证据支持，抽帧通过不替代缺失证据"
  ]
};

export interface ProducerReviewContracts {
  shots: Array<Record<string, unknown>>;
  eraProfile?: EraProfile;
  sceneBible?: SceneBible;
}
export interface ProducerReviewContract {
  schemaVersion: "workloom.producer-contract/v1";
  contractHash: string;
  sourceHash: string;
  shots: Array<{ shotId: string; intent: ReturnType<typeof normalizeShotIntent>; constraints: string[] }>;
}
/** Shared author contracts are compiled before any paid review; this does not prove image quality. */
export function buildProducerReviewContract(input: ProducerReviewContracts): ProducerReviewContract {
  if (!input || !Array.isArray(input.shots) || !input.shots.length) throw new Error("PRODUCER_CONTRACT_INVALID: shots必须为非空数组");
  const sourceHash = shotIntentHash(input);
  if (input.eraProfile !== undefined) resolveEraProfile(input.eraProfile);
  const seen = new Set<string>();
  const shots = input.shots.map((original) => {
    const shot = input.sceneBible === undefined ? original : expandShotWithBible(original, input.sceneBible);
    const intent = normalizeShotIntent(shot);
    if (!intent.shotId.trim() || seen.has(intent.shotId)) throw new Error("PRODUCER_CONTRACT_INVALID: shotId缺失或重复");
    seen.add(intent.shotId);
    if (intent.subject.kind === "unknown") throw new Error(`PRODUCER_CONTRACT_UNVERIFIED: ${intent.shotId} 主体未明确`);
    const defects = environmentDefects([shot], input.sceneBible).filter((entry) => entry.hard);
    if (defects.length) {
      const error = new Error(defects.map((entry) => entry.detail).join("；"));
      Object.assign(error, { status: defects.some((entry) => entry.status === "failed") ? "failed" : "unverified" });
      throw error;
    }
    return { shotId: intent.shotId, intent, constraints: [
      ...environmentProfilePromptLines(shot.environmentProfile as import("./scene-bible.js").EnvironmentProfile | undefined),
      ...propInteractionPromptLines(shot),
      ...devicePolicyPromptLines(shot, { eraProfile: input.eraProfile }),
    ] };
  });
  const facts = { schemaVersion: "workloom.producer-contract/v1" as const, sourceHash, shots };
  return { ...facts, contractHash: shotIntentHash(facts) };
}

export interface ProducerGateOptions {
  stage: ProducerStage;
  projectId: string;
  artifacts: ProducerArtifact[];
  deterministic: DeterministicCheck[];
  /** Required measured checks cannot be omitted or represented by a soft score. */
  requiredCheckIds?: string[];
  minScore?: number;
  /** 覆盖默认评审要点 */
  rubric?: string[];
  /** 画面类环节可附视觉基准（如定妆照）做一致性比对 */
  referenceImages?: string[];
  context?: Record<string, unknown>;
  contracts?: ProducerReviewContracts;
  /** @deprecated 仅为旧调用方保留；不会授予正式通过资格。 */
  allowFallbackApprove?: boolean;
  env?: Record<string, string | undefined>;
  fetchImpl?: typeof fetch;
  log?: (line: string) => void;
  /**
   * 评审图压缩器（2026-09-24 三轮审计）：送审图大于预算时调用，返回压缩后的图片路径（失败返回 null）。
   * 默认实现用 ffmpeg 缩到 720 宽 JPEG；测试注入替身，避免单测依赖 ffmpeg。
   */
  shrinkImage?: (path: string) => string | null;
}

interface LlmConfig {
  baseUrl: string;
  apiKey: string;
  model: string;
}

/** 解析评审模型（与 model-router 的 LLM_* 口径一致，兼容 DEEPSEEK_* 秘密文件） */
export function resolveProducerLlm(env: Record<string, string | undefined> = process.env): LlmConfig | null {
  const baseUrl = env.LLM_BASE_URL ?? env.DEEPSEEK_BASE_URL ?? "";
  const apiKey = env.LLM_API_KEY ?? env.DEEPSEEK_API_KEY ?? "";
  const model = env.LLM_MODEL ?? env.DEEPSEEK_MODEL ?? "";
  if (!baseUrl || !apiKey || !model) return null;
  return { baseUrl: baseUrl.replace(/\/$/, ""), apiKey, model };
}

function summarizeArtifacts(artifacts: ProducerArtifact[]): string {
  return artifacts.map((a) => {
    const probe = a.probe ? ` ${JSON.stringify(a.probe)}` : "";
    const bytes = typeof a.bytes === "number" ? ` ${(a.bytes / 1024).toFixed(0)}KB` : "";
    return `- [${a.kind}] ${a.path}${bytes}${probe}${a.note ? ` — ${a.note}` : ""}`;
  }).join("\n");
}

/**
 * 单张送审图预算（2026-09-24 三轮审计，真机事故复现）：
 * 视频抽帧是 1080×1920 的 PNG，单张 ≈10MB；4 张产物帧 + 2 张基准图一起 base64 后 **≈53MB**，
 * 评审模型的网关直接返回 `HTTP 413 Request Entity Too Large` → 监制判为"不可用"、镜头悬空（既没通过也没真打回）。
 * 超预算先缩到720宽JPEG；压缩不可用或仍超预算时返回未验证，不静默丢图或赌超大请求。
 */
const JUDGE_IMAGE_BUDGET_BYTES = 900_000;

/** 默认压缩器：ffmpeg 缩到 720 宽 JPEG（失败返回 null，由调用方如实降级） */
function shrinkImageWithFfmpeg(path: string): string | null {
  const bin = process.env.WL_FFMPEG ?? "ffmpeg";
  const out = join(tmpdir(), `producer-judge-${randomUUID()}.jpg`);
  const res = spawnSync(bin, [
    "-hide_banner", "-v", "error", "-y", "-i", path,
    "-frames:v", "1", "-vf", "scale=720:-2", "-q:v", "3", out
  ], { timeout: 30_000 });
  if (res.status !== 0 || !existsSync(out) || statSync(out).size >= statSync(path).size) {
    rmSync(out, { force: true });
    return null;
  }
  return out;
}

/**
 * 解析评审模型输出的 JSON：
 *   ① 直接解析（剥掉可能的 ``` 包裹）；
 *   ② 取第一个 `{` 到最后一个 `}` 的片段再解析（裁掉解释性前后缀）；
 *   ③ 仍失败 → 让模型"只重发合法 JSON"自修复一次；
 *   ④ 还失败 → 抛错（调用方按"评审不可用"fail-closed 处理）。
 */
async function parseJudgeJson(
  raw: string,
  llm: LlmConfig,
  fetchImpl: typeof fetch,
  log: (line: string) => void,
  stage: ProducerStage
): Promise<Record<string, unknown>> {
  const stripped = raw.replace(/^```(?:json)?/m, "").replace(/```\s*$/m, "").trim();
  const tryParse = (text: string): Record<string, unknown> | null => {
    try {
      return JSON.parse(text) as Record<string, unknown>;
    } catch {
      return null;
    }
  };
  const direct = tryParse(stripped);
  if (direct) return direct;
  const start = stripped.indexOf("{");
  const end = stripped.lastIndexOf("}");
  if (start >= 0 && end > start) {
    const sliced = tryParse(stripped.slice(start, end + 1));
    if (sliced) return sliced;
  }
  log(`[producer][${stage}] 评审输出不是合法 JSON，要求模型自修复一次`);
  const repair = await fetchImpl(`${llm.baseUrl}/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${llm.apiKey}` },
    body: JSON.stringify({
      model: llm.model,
      messages: [
        { role: "user", content: "把下面这段内容整理成**严格合法**的 JSON（只输出 JSON，不要任何解释、不要 markdown）：\n\n" + raw.slice(0, 4000) }
      ],
      temperature: 0,
      response_format: { type: "json_object" }
    }),
    signal: AbortSignal.timeout(120_000)
  });
  const repairText = await repair.text();
  if (!repair.ok) throw new Error(`评审 JSON 修复失败：HTTP ${repair.status} ${repairText.slice(0, 160)}`);
  const repaired = (JSON.parse(repairText) as { choices?: Array<{ message?: { content?: string } }> }).choices?.[0]?.message?.content ?? "";
  const fixed = tryParse(repaired.replace(/^```(?:json)?/m, "").replace(/```\s*$/m, "").trim());
  if (!fixed) throw new Error(`评审 JSON 修复后仍非法：${repaired.slice(0, 160)}`);
  return fixed;
}

type JudgeResult = { approved: boolean; score: number; issues: string[]; suggestions: string[]; reason: string };

/**
 * 评审结果结构归一（2026-09-28 T1 真机：10 镜逐镜监制有 2 镜返回"结构非法"）。
 *
 * 真机现象：模型返回的是**合法 JSON**，只是形状有偏差（score 写成字符串、issues 写成一条字符串、
 * 用 summary/conclusion 代替 reason、approved 写成 "true"）——旧实现直接判"结构非法"并要求重跑，
 * 一镜重跑 12–24 秒且随时可能再次失败。这里只做**无歧义**的归一（不新增事实、不改语义），
 * 归一不了的仍然走 schema 自修复、再不行 fail-closed 判 unverified。
 */
export function coerceJudgeResult(json: unknown): JudgeResult | null {
  if (!json || typeof json !== "object" || Array.isArray(json)) return null;
  const record = json as Record<string, unknown>;
  const list = (value: unknown): string[] | null => {
    if (value === undefined || value === null) return [];
    if (typeof value === "string") return value.trim() ? [value.trim()] : [];
    if (Array.isArray(value) && value.every((item) => typeof item === "string")) return value as string[];
    return null;
  };
  const approved = typeof record.approved === "boolean"
    ? record.approved
    : typeof record.approved === "string" && /^(?:true|false)$/i.test(record.approved.trim())
      ? record.approved.trim().toLowerCase() === "true"
      : null;
  const score = typeof record.score === "number" && Number.isFinite(record.score)
    ? record.score
    : typeof record.score === "string" && record.score.trim() !== "" && Number.isFinite(Number(record.score))
      ? Number(record.score)
      : null;
  const issues = list(record.issues);
  const suggestions = list(record.suggestions);
  const reasonRaw = record.reason ?? record.summary ?? record.conclusion;
  const reason = typeof reasonRaw === "string" ? reasonRaw : "";
  if (approved === null || score === null || score < 0 || score > 100 || !issues || !suggestions) return null;
  return { approved, score, issues, suggestions, reason };
}

/** 结构自修复：把形状不对的 JSON 交给模型按 schema 重排（只整理结构，不得新增事实）。 */
async function repairJudgeShape(
  parsed: Record<string, unknown>,
  llm: LlmConfig,
  fetchImpl: typeof fetch,
  log: (line: string) => void,
  stage: ProducerStage
): Promise<JudgeResult | null> {
  log(`[producer][${stage}] 评审结果结构不合规，要求模型按 schema 自修复一次`);
  const res = await fetchImpl(`${llm.baseUrl}/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${llm.apiKey}` },
    body: JSON.stringify({
      model: llm.model,
      messages: [{
        role: "user",
        content: "把下面这份评审结论**只整理成结构**，不得新增或改变任何事实、分数与结论：\n"
          + '只输出 JSON：{"approved":true|false,"score":0-100,"issues":["..."],"suggestions":["..."],"reason":"结论"}\n\n'
          + JSON.stringify(parsed)
      }],
      temperature: 0,
      response_format: { type: "json_object" }
    }),
    signal: AbortSignal.timeout(120_000)
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`评审结构修复失败：HTTP ${res.status} ${text.slice(0, 160)}`);
  const content = (JSON.parse(text) as { choices?: Array<{ message?: { content?: string } }> }).choices?.[0]?.message?.content ?? "";
  const stripped = content.replace(/^```(?:json)?/m, "").replace(/```\s*$/m, "").trim();
  try {
    return coerceJudgeResult(JSON.parse(stripped));
  } catch {
    return null;
  }
}

/**
 * 评审一个环节。返回裁决；调用方按 `approved` 决定放行或重跑。
 */
export async function reviewStage(options: ProducerGateOptions): Promise<ProducerVerdict> {
  const started = Date.now();
  const log = options.log ?? (() => undefined);
  const stage = options.stage;
  const rubric = options.rubric ?? PRODUCER_RUBRICS[stage];
  const hardFailures = options.deterministic.filter((c) => c.hard === true && (c.status === "failed" || (c.status === undefined && c.pass === false))).map((c) => `${c.id}：${c.detail}`);
  const softFailures = options.deterministic.filter((c) => c.pass === false).map((c) => `${c.id}：${c.detail}`);

  /** ① 硬闸：任一失败直接打回 */
  if (hardFailures.length > 0) {
    log(`[producer][${stage}] 硬闸失败，打回重跑：${hardFailures.join("；")}`);
    return {
      stage,
      status: "failed",
      approved: false,
      score: 0,
      hardFailures,
      issues: softFailures,
      suggestions: [`按硬闸失败项修复后重跑本环节：${hardFailures[0]}`],
      rerun: true,
      via: "deterministic",
      ms: Date.now() - started,
      reason: `确定性硬闸未通过（${hardFailures.length} 项）`,
      degraded: false
    };
  }

  const evidence: NonNullable<ProducerVerdict["evidence"]> = [];
  let contract: ProducerReviewContract | undefined;
  const reject = (reason: string, via: ProducerVerdict["via"] = "deterministic", model?: string): ProducerVerdict => ({
    stage, status: "unverified", approved: false, score: 0, hardFailures: [], contractHash: contract?.contractHash,
    issues: [...softFailures, reason], suggestions: ["补齐有效证据或修复评审组件后重跑本环节"],
    rerun: true, via, model, ms: Date.now() - started, reason, degraded: true, evidence
  });
  try { if (options.contracts !== undefined) contract = buildProducerReviewContract(options.contracts); }
  catch (error) {
    const verdict = reject(error instanceof Error ? error.message : String(error));
    if ((error as { status?: ShotIntentStatus })?.status === "failed") return { ...verdict, status: "failed", degraded: false, hardFailures: [verdict.reason] };
    return verdict;
  }
  const required = new Set(options.requiredCheckIds ?? []);
  // This visual/text adapter cannot listen. Acoustic quality requires a component receipt.
  if (stage === "bgm" || stage === "master") required.add("audio-review");
  for (const id of required) {
    const checks = options.deterministic.filter((c) => c.id === id);
    if (checks.length !== 1 || (checks[0]?.status !== undefined && checks[0]?.status !== "passed") || checks[0]?.pass !== true) return reject(`缺少已通过的必需证据：${id}`);
  }
  if (options.deterministic.some((c) => c.hard && (c.status === "unverified" || (c.status !== "not_applicable" && c.pass !== true)))) return reject("必需质量检查未验证");
  const llm = resolveProducerLlm(options.env ?? process.env);
  if (!llm) return reject("无可用评审模型；降级只能预览，不能作为合格交付", "fallback");
  const minScore = options.minScore ?? 70;
  if (!Number.isFinite(minScore) || minScore < 0 || minScore > 100) return reject("评审分数阈值非法");
  const tempPaths: string[] = [];
  const textContent: Array<Record<string, unknown>> = [];
  const images: Array<{ path: string; label: string }> = [];
  let totalText = 0;
  try {
    if (options.artifacts.length === 0) throw new Error("缺少待评审产物");
    for (const artifact of options.artifacts) {
      const stat = statSync(artifact.path);
      if (!stat.isFile() || stat.size === 0) throw new Error(`产物为空或不是文件：${artifact.path}`);
      if (stat.size > 1_000_000_000) throw new Error(`产物超过单次评审资源上限：${artifact.path}`);
      const bytes = readFileSync(artifact.path);
      const sha256 = createHash("sha256").update(bytes).digest("hex");
      if (artifact.kind === "audio") throw new Error(`当前评审适配器不支持音频内容：${artifact.path}；需要音频评审组件`);
      if (artifact.kind === "text" || artifact.kind === "json") {
        const raw = bytes.toString("utf8");
        if (artifact.kind === "json") JSON.parse(raw);
        totalText += raw.length;
        if (totalText > 100_000) throw new Error("文本证据超出本次完整评审预算；需拆分评审，禁止截断后通过");
        textContent.push({ type: "text", text: `以下是产物正文（完整）：${artifact.path}\n${raw}` });
        evidence.push({ path: artifact.path, sha256, scope: "complete-text" });
      } else if (artifact.kind === "image") {
        images.push({ path: artifact.path, label: "待评审产物" });
        evidence.push({ path: artifact.path, sha256, scope: "image" });
      } else if (artifact.kind === "video") {
        const probe = spawnSync(process.env.WL_FFPROBE ?? "ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "json", artifact.path], { encoding: "utf8", timeout: 30_000 });
        if (probe.status !== 0) throw new Error(`视频探测失败：${artifact.path}`);
        const duration = Number(JSON.parse(probe.stdout).format?.duration);
        if (!Number.isFinite(duration) || duration <= 0) throw new Error(`视频时长无效：${artifact.path}`);
        const dir = mkdtempSync(join(tmpdir(), "producer-frames-")); tempPaths.push(dir);
        const timestamps = [0, 0.2, 0.4, 0.6, 0.8].map((r) => duration * r);
        for (const [index, at] of timestamps.entries()) {
          const path = join(dir, `${index}.jpg`);
          const result = spawnSync(process.env.WL_FFMPEG ?? "ffmpeg", ["-v", "error", "-y", "-ss", String(at), "-i", artifact.path, "-frames:v", "1", "-vf", "scale=720:-2", "-q:v", "3", path], { timeout: 30_000 });
          if (result.status !== 0 || !existsSync(path)) throw new Error(`视频时序抽帧失败：${artifact.path}@${at}`);
          images.push({ path, label: `视频 ${artifact.path} 时间 ${at.toFixed(3)}s，按序比较` });
        }
        evidence.push({ path: artifact.path, sha256, scope: `temporal-sample:${timestamps.map((t) => t.toFixed(3)).join(",")}; audio-not-reviewed` });
      }
    }
    const artifactImages = images.length;
    if ((options.referenceImages?.length ?? 0) > 6) throw new Error("基准图超过单次对比预算，需按角色拆分评审");
    for (const path of options.referenceImages ?? []) {
      const bytes = readFileSync(path);
      evidence.push({ path, sha256: createHash("sha256").update(bytes).digest("hex"), scope: "reference-image" });
      images.push({ path, label: "基准图" });
    }
    if (images.length > 60) throw new Error("图像证据超过完整评审预算，需按镜头拆分；禁止静默丢图");
    const visualStages = ["keyframe", "shot", "compose", "color", "subtitle", "mux", "danmaku", "cover", "master"];
    if (visualStages.includes(stage) && !artifactImages) throw new Error("画面评审缺少实际图像或可抽帧视频");
    const encoded: Array<Record<string, unknown>[]> = [];
    for (const image of images) {
      let path = image.path;
      let bytes = readFileSync(path);
      if (bytes.length > JUDGE_IMAGE_BUDGET_BYTES) {
        const shrunk = (options.shrinkImage ?? shrinkImageWithFfmpeg)(path);
        if (!shrunk) throw new Error(`送审图压缩失败：${path}`);
        if (shrunk !== path) tempPaths.push(shrunk);
        path = shrunk; bytes = readFileSync(path);
      }
      const png = bytes.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]));
      const jpeg = bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255;
      const webp = bytes.toString("ascii", 0, 4) === "RIFF" && bytes.toString("ascii", 8, 12) === "WEBP";
      if (!(png || jpeg || webp) || bytes.length > JUDGE_IMAGE_BUDGET_BYTES) throw new Error(`图像内容无效或仍超预算：${image.path}`);
      encoded.push([{ type: "text", text: image.label }, { type: "image_url", image_url: { url: `data:${png ? "image/png" : jpeg ? "image/jpeg" : "image/webp"};base64,${bytes.toString("base64")}` } }]);
    }
    const context = options.context ? JSON.stringify(options.context) : "";
    const contractText = contract ? JSON.stringify(contract) : "未提供结构化镜头合同；不得宣称已核实年代、人数、空间或设备型号。";
    if (context.length + contractText.length > 30_000) throw new Error("评审上下文超预算，禁止截断事实");
    const batches = Math.max(1, Math.ceil(artifactImages / 6));
    const answers: Array<{ approved: boolean; score: number; issues: string[]; suggestions: string[]; reason: string }> = [];
    for (let batch = 0; batch < batches; batch += 1) {
      const content = [{ type: "text", text: [
        `你是视频监制。项目 ${options.projectId}，环节 ${stage}，证据批次 ${batch + 1}/${batches}。`,
        ...rubric.map((r, i) => `${i + 1}. ${r}`),
        "只评审实际收到的证据，视频为带时间戳抽帧，不代表逐帧、口型或听音验证。缺证据必须拒绝，不能猜测。",
        summarizeArtifacts(options.artifacts),
        "确定性检查（含失败与不适用）：", ...options.deterministic.map((c) => `${c.id}: ${c.status ?? (c.pass ? "passed" : "failed")} ${c.detail}`),
        context,
        "结构化原镜头合同优先于通用rubric；只对实际适用项目评审，不得把合同当产物质量证明。", contractText,
        '只输出 JSON: {"approved":true|false,"score":0-100,"issues":[],"suggestions":[],"reason":"结论"}'
      ].join("\n") }, ...textContent, ...encoded.slice(batch * 6, Math.min(artifactImages, (batch + 1) * 6)).flat(), ...encoded.slice(artifactImages).flat()];
      const res = await (options.fetchImpl ?? fetch)(`${llm.baseUrl}/chat/completions`, {
        method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${llm.apiKey}` },
        body: JSON.stringify({ model: llm.model, messages: [{ role: "user", content }], temperature: 0.2, response_format: { type: "json_object" } }),
        signal: AbortSignal.timeout(180_000)
      });
      const rawBody = await res.text();
      if (!res.ok) throw new Error(`HTTP ${res.status} ${rawBody.slice(0, 160)}`);
      const raw = JSON.parse(rawBody).choices?.[0]?.message?.content;
      if (typeof raw !== "string") throw new Error("评审模型缺少文本结果");
      const json = await parseJudgeJson(raw, llm, options.fetchImpl ?? fetch, log, stage);
      /**
       * 结构归一 → 仍不合规则按 schema 自修复一次 → 还不行才判"结构非法"。
       * 2026-09-28 T1 真机：旧实现在这一步直接判死，10 镜里有 2 镜因形状偏差被要求整环节重跑。
       */
      const normalizedResult = coerceJudgeResult(json)
        ?? await repairJudgeShape(json, llm, options.fetchImpl ?? fetch, log, stage);
      if (!normalizedResult) throw new Error("评审结果结构非法");
      answers.push(normalizedResult);
    }
    for (const item of evidence) {
      const currentHash = createHash("sha256").update(readFileSync(item.path)).digest("hex");
      if (currentHash !== item.sha256) throw new Error(`评审期间产物发生变化：${item.path}`);
    }
    if (contract && options.contracts && shotIntentHash(options.contracts) !== contract.sourceHash) throw new Error("评审期间原镜头合同发生变化");
    const approved = answers.every((a) => a.approved && a.score >= minScore);
    return { stage, status: approved ? "passed" : "failed", approved, contractHash: contract?.contractHash, score: Math.min(...answers.map((a) => a.score)),
      hardFailures: [], issues: [...softFailures, ...answers.flatMap((a) => a.issues)], suggestions: answers.flatMap((a) => a.suggestions),
      rerun: !approved, via: "llm", model: llm.model, ms: Date.now() - started,
      reason: answers.map((a) => a.reason).join("；") + (approved ? "" : `（所有证据批次需通过且评分≥${minScore}）`), degraded: false, evidence };
  } catch (err) {
    return reject(err instanceof Error ? err.message : String(err), "fallback", llm.model);
  } finally {
    for (const path of tempPaths) {
      try { rmSync(path, { recursive: true, force: true }); }
      catch (err) { log(`[producer] 临时证据清理失败：${path}：${String(err)}`); }
    }
  }
}
