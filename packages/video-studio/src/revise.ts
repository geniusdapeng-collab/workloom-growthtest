/**
 * revise —— 返修闭环（管线 step_key `revise`，gate `G-DLV4`）
 *
 * 管线 yml 的口径：**变更影响分析 → 层增量重合成（不重新生成镜头）；点名到画面内容才走 G8 人审 +
 * 只重跑点名镜头；复用带 sha256 证据（G-DLV4/G-DLV5/G-DLV7）**。
 *
 * 本模块做"影响分析 + 复用证据"的纯逻辑（可单测）：
 *   · `classifyRevision()`：把一句返修意见分诊成三类——
 *       shot-level（点名画面内容：人物/动作/构图/场景 → 必须重跑点名镜头，走 G8）
 *       layer-level（字幕/配乐/调色/封面/文案 → 只重做后期层，镜头全部复用）
 *       mixed（两者都有 → 重跑点名镜头 + 重做受影响层）
 *   · `buildRevisionPlan()`：给出要跑的阶段、要重跑的镜头、以及**复用镜头的 sha256 证据**（未点名镜头一律复用）
 */

import type { PipelineGateStepKey } from "./gate-ledger.js";

export type RevisionKind = "shot-level" | "layer-level" | "mixed";

export interface RevisionLayer {
  id: "compose" | "color" | "subtitle" | "danmaku" | "bgm" | "cover" | "master" | "deliver";
  /** 触发该层的关键词（命中即认为意见点名了这一层） */
  pattern: RegExp;
  note: string;
}

/** 后期层的关键词表：与工位一一对应（新增后期能力时在这里登记，避免"意见提了没人管"） */
export const REVISION_LAYERS: RevisionLayer[] = [
  { id: "subtitle", pattern: /字幕|错字|断句|关键词|挡字|字号/i, note: "字幕层：文案/版式/时间轴" },
  { id: "bgm", pattern: /配乐|BGM|音乐|节奏|卡点/i, note: "配乐层：选曲/让位/卡点" },
  { id: "color", pattern: /调色|色调|饱和|偏色|冷调|暖调|滤镜/i, note: "调色层：影调/肤色" },
  { id: "cover", pattern: /封面|标题|钩子/i, note: "封面层：标题/版式" },
  { id: "danmaku", pattern: /弹幕|评论/i, note: "弹幕层（平台支持时）" }
];

/** 画面内容关键词：命中就要重跑镜头（不能靠后期补救） */
export const SHOT_LEVEL_PATTERN = /人物|脸|表情|动作|手|畸变|构图|场景|桥|建筑|穿帮|镜头|画面内容|换|重拍|重渲/i;

export interface RevisionPlan {
  kind: RevisionKind;
  /** 需要重跑的镜头（shot-level/mixed 才有） */
  rerunShots: string[];
  /** 需要重做的后期层（顺序执行） */
  layers: RevisionLayer["id"][];
  /** 复用镜头的 sha256 证据（G-DLV4：复用什么、凭什么复用） */
  reuseEvidence: Array<{ shotId: string; path: string; sha256: string }>;
  /** 建议舞台序列（交给 --stages） */
  stages: string[];
  /** G8 是否需要人审（点名画面内容时=真） */
  requiresRenderSubmitGate: boolean;
  rationale: string;
}

export function classifyRevision(note: string): RevisionKind {
  const hitsShot = SHOT_LEVEL_PATTERN.test(note);
  const hitsLayer = REVISION_LAYERS.some((layer) => layer.pattern.test(note));
  if (hitsShot && hitsLayer) return "mixed";
  if (hitsShot) return "shot-level";
  return "layer-level";
}

/**
 * 生成返修执行计划。
 * @param hasher 注入的哈希函数（测试里给替身；生产用 node:crypto 的 sha256）
 */
export function buildRevisionPlan(options: {
  note: string;
  shots: Array<{ shotId: string; clipPath: string }>;
  hasher: (path: string) => string;
  /** 本次返修点名的镜头（若意见里明确写了 SC-xx） */
  namedShots?: string[];
}): RevisionPlan {
  const kind = classifyRevision(options.note);
  const named = options.namedShots ?? [...options.note.matchAll(/SC-\d+/gi)].map((m) => m[0].toUpperCase());
  const rerunShots = kind === "layer-level" ? [] : (named.length > 0 ? named : options.shots.map((shot) => shot.shotId));
  const layers = REVISION_LAYERS
    .filter((layer) => layer.pattern.test(options.note))
    .map((layer) => layer.id);
  /** 层增量重合成的顺序：调色在合成之后、字幕/弹幕/配乐依次、封面与终审收尾 */
  const order: RevisionLayer["id"][] = ["compose", "color", "subtitle", "danmaku", "bgm", "cover", "master", "deliver"];
  const orderedLayers = order.filter((id) => layers.includes(id));
  const reuseEvidence = options.shots
    .filter((shot) => !rerunShots.includes(shot.shotId))
    .map((shot) => ({ shotId: shot.shotId, path: shot.clipPath, sha256: options.hasher(shot.clipPath) }));
  const stages = [
    ...(rerunShots.length > 0 ? ["cine-kb", "micromotion", "spec", "plates", "videos"] : []),
    ...orderedLayers
  ];
  const kindLabel = kind === "shot-level" ? "点名画面内容" : kind === "layer-level" ? "只涉及后期层" : "画面与后期层都有";
  return {
    kind,
    rerunShots,
    layers: orderedLayers,
    reuseEvidence,
    stages,
    requiresRenderSubmitGate: rerunShots.length > 0,
    rationale: `${kindLabel}：${rerunShots.length > 0 ? `重跑 ${rerunShots.join("/")}（走 G8 提交审批）` : "镜头全部复用（零渲染）"}；`
      + `${orderedLayers.length > 0 ? `重做层 ${orderedLayers.join(" → ")}` : "无后期层命中（请人工确认意见是否可执行）"}；`
      + `复用证据：${reuseEvidence.map((e) => `${e.shotId}:${e.sha256.slice(0, 12)}`).join("、") || "无复用镜头"}`
  };
}

/** 返修报告（落盘给发布方与审计） */
export interface RevisionReport extends RevisionPlan {
  note: string;
  gate: { stepKey: PipelineGateStepKey; approved: boolean; detail: string };
  generatedAt: string;
}

export function buildRevisionReport(plan: RevisionPlan, note: string, at?: string): RevisionReport {
  const approved = plan.kind === "layer-level" ? true : plan.rerunShots.length > 0;
  return {
    ...plan,
    note,
    gate: {
      stepKey: "revise",
      approved,
      detail: approved
        ? `返修可自动执行（${plan.kind}）：${plan.rationale}`
        : "返修意见无法归类（既没点名层也没点名镜头）：需要人工确认后再跑"
    },
    generatedAt: at ?? new Date().toISOString()
  };
}
