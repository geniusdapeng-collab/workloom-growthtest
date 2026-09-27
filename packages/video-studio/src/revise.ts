/**
 * 返修影响分析（G-DLV4）：明确改哪一层、哪些镜头及哪些后继产物失效。
 * 规划器只判断技术可执行性，不授予 G8 花费权限；未知意见或不完整证据不生成执行步骤。
 */
import type { PipelineGateStepKey } from "./gate-ledger.js";

export type RevisionKind = "shot-level" | "layer-level" | "mixed" | "unclassified";

export interface RevisionLayer {
  id: "compose" | "color" | "subtitle" | "danmaku" | "bgm" | "cover" | "mux" | "master" | "deliver";
  pattern: RegExp;
  note: string;
}

/** 直接归因层；后继层由依赖图展开，不靠重复命中关键词。 */
export const REVISION_LAYERS: RevisionLayer[] = [
  { id: "compose", pattern: /转场|拼接|剪辑|镜头顺序|镜头排序/i, note: "拼接层：顺序/转场" },
  { id: "subtitle", pattern: /字幕|错字|断句|关键词|挡字|字号/i, note: "字幕层：文案/版式/时间轴" },
  { id: "bgm", pattern: /配乐|BGM|音乐|卡点/i, note: "配乐层：选曲/让位/卡点" },
  { id: "color", pattern: /调色|色调|饱和|偏色|冷调|暖调|滤镜/i, note: "调色层：影调/肤色" },
  { id: "cover", pattern: /封面|标题|钩子/i, note: "封面层：标题/版式" },
  { id: "danmaku", pattern: /弹幕|评论/i, note: "弹幕层（平台支持时）" },
  { id: "mux", pattern: /软字幕轨|字幕轨|封装/i, note: "字幕轨封装" },
  { id: "master", pattern: /终审|母版复核/i, note: "母版终审" },
  { id: "deliver", pattern: /交付包|交付清单|多版本|导出/i, note: "交付包" },
];

/** “换”及单独的“镜头/手/人物”不能证明需要重新生成画面。 */
export const SHOT_LEVEL_PATTERN = /重拍|重渲|重新(?:生成|渲染)(?:画面|镜头|视频)|穿帮|畸变|崩脸|穿模|画面内容|(?:人物|角色|脸|面部|表情|肢体|手指|动作|构图|场景|建筑|桥).{0,12}(?:僵硬|异常|错误|不自然|不对|变形|扭曲|缺失|崩坏|失真)|(?:替换|更换|换掉|修改|调整).{0,4}(?:人物|角色|场景|建筑|画面|镜头(?!顺序|排序))|(?:人物|角色|场景|建筑|画面内容).{0,4}(?:换掉|替换)|(?:替换|更换|换掉|换)\s*[A-Z]{1,16}-\d+|[A-Z]{1,16}-\d+\s*(?:换掉|替换|更换)/i;

const LAYER_ORDER: RevisionLayer["id"][] = ["compose", "color", "subtitle", "danmaku", "bgm", "cover", "mux", "master", "deliver"];
/** 对齐 full-chain 的产物流：raw→graded→字幕/弹幕→配乐→软轨→终审→交付；封面另从 graded 分叉。 */
const DEPENDENTS: Record<RevisionLayer["id"], RevisionLayer["id"][]> = {
  compose: ["color"],
  color: ["subtitle", "cover"],
  subtitle: ["danmaku", "mux"],
  danmaku: ["bgm"],
  bgm: ["mux", "master"],
  cover: ["mux", "master"],
  mux: ["master"],
  master: ["deliver"],
  deliver: [],
};
const SHOT_STAGES = ["cine-kb", "continuity", "micromotion", "spec", "plates", "material-gen", "videos", "voice"];

export interface RevisionBlocker {
  code: "unclassified" | "invalid_shot_registry" | "unknown_shot" | "shot_scope_required" | "reuse_evidence_unavailable";
  detail: string;
}

export interface RevisionPlan {
  kind: RevisionKind;
  /** 仅代表归因、范围和复用证据完整；不代表付费动作已获批准。 */
  executable: boolean;
  blockers: RevisionBlocker[];
  requestedLayers: RevisionLayer["id"][];
  rerunShots: string[];
  layers: RevisionLayer["id"][];
  reuseEvidence: Array<{ shotId: string; path: string; sha256: string }>;
  /** 阶段并集供展示；执行必须使用 executionSteps，不能给整个并集加 --only。 */
  stages: string[];
  executionSteps: Array<{ scope: "selected-shots" | "project"; shotIds: string[]; stages: string[] }>;
  requiresRenderSubmitGate: boolean;
  rationale: string;
}

function normalizeText(value: string): string {
  return value.normalize("NFKC").replace(/[‐‑‒–—−]/g, "-");
}

function feedbackClauses(note: string): string[] {
  return normalizeText(note).split(/[，,。；;！!？?\n]|另外|同时|并且|但是|而且|以及|但|且/u)
    .map((clause) => clause.trim()).filter(Boolean)
    .filter((clause) => !/(?:不要|不用|无需|不必|不再|不|别)(?:再)?(?:全部|全片|所有镜头)?(?:改|动|换|重拍|重渲|重新(?:生成|渲染))|(?:保持|保留).*(?:不变|原样)|(?:没问题|无需修改|不用改)/u.test(clause));
}

function attribution(note: string): { kind: RevisionKind; layers: RevisionLayer["id"][]; clauses: string[]; shotClauses: string[] } {
  const clauses = feedbackClauses(note);
  const layers = REVISION_LAYERS.filter((layer) => clauses.some((clause) => layer.pattern.test(clause))).map((layer) => layer.id);
  // 封面里的角色或字幕文字中的动作属于后期层；画面问题先于层说明时仍保留画面归因。
  const shotClauses = clauses.filter((clause) => {
    const shot = SHOT_LEVEL_PATTERN.exec(clause);
    if (!shot) return false;
    if (/^(?:(?:替换|更换|换掉|换)\s*[A-Z]{1,16}-\d+|[A-Z]{1,16}-\d+\s*(?:换掉|替换|更换))$/i.test(shot[0])
      && /^\s*(?:的)?\s*(?:字幕|弹幕|封面|标题|钩子|配乐|音乐|BGM|调色|转场|顺序|排序)/iu.test(clause.slice(shot.index + shot[0].length))) return false;
    const post = /封面|标题|钩子|字幕|弹幕/u.exec(clause);
    if (/^(?:替换|更换|换掉|修改|调整).{0,4}(?:封面|标题|钩子|字幕|弹幕)/u.test(shot[0])) return false;
    return !post || shot.index < post.index;
  });
  const hitsShot = shotClauses.length > 0;
  const kind = hitsShot ? (layers.length ? "mixed" : "shot-level") : layers.length ? "layer-level" : "unclassified";
  return { kind, layers, clauses, shotClauses };
}

export function classifyRevision(note: string): RevisionKind {
  return attribution(note).kind;
}

function dependentLayers(requested: RevisionLayer["id"][]): RevisionLayer["id"][] {
  const pending = [...requested];
  const affected = new Set<RevisionLayer["id"]>();
  while (pending.length) {
    const layer = pending.pop()!;
    if (affected.has(layer)) continue;
    affected.add(layer);
    pending.push(...DEPENDENTS[layer]);
  }
  return LAYER_ORDER.filter((layer) => affected.has(layer));
}

/** 以项目登记的镜号为唯一映射，不把未知编号或未点名意见扩成全片重生成。 */
export function buildRevisionPlan(options: {
  note: string;
  shots: Array<{ shotId: string; clipPath: string }>;
  hasher: (path: string) => string;
  namedShots?: string[];
}): RevisionPlan {
  const { kind, layers: requestedLayers, clauses, shotClauses } = attribution(options.note);
  const blockers: RevisionBlocker[] = [];
  const known = new Map<string, string>();
  const key = (id: string) => normalizeText(id).trim().toUpperCase();
  for (const shot of options.shots) {
    const id = key(shot.shotId);
    if (!id || !shot.clipPath.trim() || known.has(id)) {
      blockers.push({ code: "invalid_shot_registry", detail: `镜头登记为空、路径缺失或编号重复：${shot.shotId}` });
    } else known.set(id, shot.shotId);
  }
  if (known.size === 0) blockers.push({ code: "invalid_shot_registry", detail: "项目没有可核对的镜头登记" });
  if (kind === "unclassified") blockers.push({ code: "unclassified", detail: "意见没有明确点名可修改的画面问题或后期层" });

  const references = (text: string): string[] => {
    const result: string[] = [];
    for (const [id, original] of known) {
      const escaped = id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      if (new RegExp(`(?<![A-Za-z0-9_-])${escaped}(?![A-Za-z0-9_-])`, "i").test(text)) result.push(original);
    }
    result.push(...[...text.matchAll(/(?<![A-Za-z0-9_-])[A-Z]{1,16}-\d+[A-Z0-9]*(?![A-Za-z0-9_-])/gi)].map((match) => match[0]));
    return [...new Set(result.map(key))];
  };
  // 先匹配项目的实际编号，支持自定义命名；再检出未知标准镜号，防止拼错后落到全片。
  const referencesInActiveClauses = references(clauses.join("；"));
  const explicit = (options.namedShots ?? []).map(key);
  const unknown = [...new Set([...referencesInActiveClauses, ...explicit])].filter((id) => !known.has(id));
  if (unknown.length) blockers.push({ code: "unknown_shot", detail: `意见包含未登记镜号：${unknown.join("、")}` });
  const needsShots = kind === "shot-level" || kind === "mixed";
  const visualNote = shotClauses.join("；");
  const named = [...new Set([...references(visualNote), ...explicit])];
  const allShotsPattern = /全部(?:的)?镜头|所有(?:的)?镜头|全片(?:的)?(?:画面|镜头)|全部重拍|全片重拍|重拍全部/u;
  const scopeClauses: string[] = [];
  // “NC-02，重拍”允许独立镜号分句；字幕分句里的镜号不能变成重生成范围。
  for (const clause of clauses) {
    const ids = references(clause);
    if (ids.length && !REVISION_LAYERS.some((layer) => layer.pattern.test(clause))) named.push(...ids);
    if (attribution(clause).kind !== "unclassified") continue;
    let remainder = clause;
    for (const id of ids) {
      const escaped = id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      remainder = remainder.replace(new RegExp(escaped, "gi"), "");
    }
    remainder = remainder.replace(/(?:全部|所有)(?:的)?镜头|全片(?:的)?(?:画面|镜头)/gu, "");
    if (/^[\s、和与及]*$/u.test(remainder)) scopeClauses.push(clause);
    else if (!/^(?:请|麻烦|帮忙)?(?:改一下|修改一下|调整一下|修一下|处理一下|谢谢|即可|就好)$/u.test(remainder)) {
      if (kind !== "unclassified") blockers.push({ code: "unclassified", detail: `部分意见无法归因，禁止只执行其中已识别部分：${clause}` });
    }
  }
  const explicitAll = allShotsPattern.test([visualNote, ...scopeClauses].join("；"));
  const selected = needsShots
    ? options.shots.filter((shot) => explicitAll || named.includes(key(shot.shotId))).map((shot) => shot.shotId)
    : [];
  if (needsShots && selected.length === 0) blockers.push({ code: "shot_scope_required", detail: "画面返修未明确点名镜头；请给出登记镜号，或明确指定全部镜头" });

  const reuseEvidence: RevisionPlan["reuseEvidence"] = [];
  for (const shot of options.shots.filter((entry) => !selected.includes(entry.shotId))) {
    try {
      const sha256 = options.hasher(shot.clipPath);
      if (!/^[a-f0-9]{64}$/i.test(sha256)) throw new Error("未返回有效 SHA-256");
      reuseEvidence.push({ shotId: shot.shotId, path: shot.clipPath, sha256: sha256.toLowerCase() });
    } catch (error) {
      blockers.push({ code: "reuse_evidence_unavailable", detail: `无法核实复用镜头 ${shot.shotId}：${error instanceof Error ? error.message : String(error)}` });
    }
  }
  const executable = blockers.length === 0;
  // 不可执行时不暴露可被旧调用方误跑的部分 stages/layers/rerunShots。
  const rerunShots = executable ? selected : [];
  const layers = executable ? dependentLayers([...requestedLayers, ...(rerunShots.length ? ["compose" as const] : [])]) : [];
  const executionSteps: RevisionPlan["executionSteps"] = executable ? [
    ...(rerunShots.length ? [{ scope: "selected-shots" as const, shotIds: [...rerunShots], stages: [...SHOT_STAGES] }] : []),
    { scope: "project", shotIds: options.shots.map((shot) => shot.shotId), stages: [...layers] },
  ] : [];
  const requiresRenderSubmitGate = needsShots;
  const rationale = executable
    ? `${rerunShots.length ? `重跑 ${rerunShots.join("/")}（待 G8 提交审批）` : "镜头全部复用（零渲染）"}；`
      + `重做层 ${layers.join(" → ")}；复用证据：${reuseEvidence.map((entry) => `${entry.shotId}:${entry.sha256.slice(0, 12)}`).join("、") || "无复用镜头"}`
    : `返修计划不可执行：${blockers.map((blocker) => blocker.detail).join("；")}`;
  return {
    kind, executable, blockers, requestedLayers, rerunShots, layers, reuseEvidence,
    stages: executionSteps.flatMap((step) => step.stages), executionSteps, requiresRenderSubmitGate, rationale,
  };
}

export interface RevisionReport extends RevisionPlan {
  note: string;
  gate: { stepKey: PipelineGateStepKey; approved: boolean; detail: string };
  /** 规划器没有花费授权能力；收费渲染的真实审批由 G8 另行验证。 */
  renderSubmitApproval: { stepKey: "g8-render-submit"; required: boolean; status: "unverified" | "not_applicable" };
  generatedAt: string;
}

export function buildRevisionReport(plan: RevisionPlan, note: string, at?: string): RevisionReport {
  const approved = plan.executable && plan.blockers.length === 0 && plan.stages.length > 0 && !plan.requiresRenderSubmitGate;
  return {
    ...plan, note,
    gate: {
      stepKey: "revise", approved,
      detail: !plan.executable
        ? plan.rationale
        : plan.requiresRenderSubmitGate
          ? `返修计划技术可执行，付费渲染尚未获 G8 批准：${plan.rationale}`
          : `后期返修可执行（无需重新生成镜头）：${plan.rationale}`,
    },
    renderSubmitApproval: {
      stepKey: "g8-render-submit", required: plan.requiresRenderSubmitGate,
      status: plan.requiresRenderSubmitGate ? "unverified" : "not_applicable",
    },
    generatedAt: at ?? new Date().toISOString(),
  };
}
