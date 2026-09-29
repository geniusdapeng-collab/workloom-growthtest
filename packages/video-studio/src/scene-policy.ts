/**
 * 出镜短视频片型知识库。知识条目决定自动选型、分镜配比、生成提示和视觉监制口径。
 * 文本闸只证明分镜方案符合约束；画面是否真正合格仍由关键帧/镜头/母版监制复核。
 */
import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { affirmativeSkillText } from "./cinematic-skill-policy.js";

export interface ScenePolicy {
  schemaVersion: "workloom.scene-policy/v1";
  id: string;
  version: string;
  title: string;
  priority: number;
  autoSignals: string[];
  requiresPerson: boolean;
  primaryTags: string[];
  ratios: Record<string, { min?: number; max?: number }>;
  tagEvidence: Record<string, string[]>;
  movingEvidence: string[];
  speechScenes: Record<string, string[]>;
  formalCostumeEvidence: string[];
  restrictedLocations: string[];
  restrictedCostumeTerms?: string[];
  qualityFloorTerms: string[];
  /** 每镜必须在客户写下的方案中看得到的证据类别；提示词注入不能充数。 */
  requiredShotCues?: Record<string, string[]>;
  /** 实际口播中的禁用承诺；只检查台词文本，避免把负面提示误判为已说出口。 */
  speechProhibitionTerms?: string[];
  /** 片级必备画面/叙事证据；每组至少有一镜在肯定描述中命中一个词。 */
  requiredPlanCues?: Record<string, string[]>;
  prompt: { scene: string; speech: string; visualReview: string; byTag: Record<string, string> };
  sourceSha256?: string;
}

export interface ScenePolicyShot {
  shotId: string;
  duration?: number;
  policyTags?: string[];
  speechMode?: "on-camera" | "voice-over";
  speechScene?: string;
  camera_movement?: string;
  cameraMovement?: string;
  scene?: string;
  sceneDescription?: string;
  prompt?: string;
  composition?: string;
  action?: string;
  props?: string;
  lighting?: string;
  costume?: string;
  character?: unknown;
  dialogue?: unknown;
  [key: string]: unknown;
}

export interface ScenePolicyException {
  rule: "restricted-location" | "restricted-costume";
  shotId: string;
  term: string;
  customerRequest: string;
  source: string;
}

export interface ScenePolicyInput {
  title?: string;
  logline?: string;
  videoType?: string;
  character?: unknown;
  scenePolicy?: { id?: string; exceptions?: ScenePolicyException[] };
  shots: ScenePolicyShot[];
}

export interface ScenePolicyDefect {
  rule: string;
  shotId: string | null;
  detail: string;
  hard: true;
}

export interface ScenePolicyReport {
  schemaVersion: "workloom.scene-policy-report/v1";
  policy: { id: string; version: string; title: string; sourceSha256: string | null; selection: string };
  totalSeconds: number;
  ratios: Record<string, { seconds: number; share: number; min?: number; max?: number }>;
  planCues: Record<string, { found: boolean; shotIds: string[] }>;
  exceptionsApplied: ScenePolicyException[];
  defects: ScenePolicyDefect[];
  passed: boolean;
}

const own = (value: unknown): value is Record<string, unknown> => Boolean(value && typeof value === "object" && !Array.isArray(value));
const text = (value: unknown): string => typeof value === "string" ? value : "";
const includesAny = (value: string, terms: readonly string[]): boolean => terms.some((term) => term && value.includes(term));

function validatePolicy(raw: unknown, file: string): ScenePolicy {
  if (!own(raw) || raw.schemaVersion !== "workloom.scene-policy/v1") throw new Error(`${file}: scene-policy schemaVersion 无效`);
  const policy = raw as unknown as ScenePolicy;
  if (!policy.id || !/^[a-z][a-z0-9-]*$/.test(policy.id) || !policy.version || !policy.title
    || !Number.isFinite(policy.priority) || !Array.isArray(policy.autoSignals) || !Array.isArray(policy.primaryTags)
    || !policy.primaryTags.length || !own(policy.ratios) || !own(policy.tagEvidence) || !Array.isArray(policy.movingEvidence)
    || !own(policy.speechScenes) || !Array.isArray(policy.formalCostumeEvidence)
    || !Array.isArray(policy.restrictedLocations) || !Array.isArray(policy.qualityFloorTerms)
    || !own(policy.prompt) || !policy.prompt.scene || !policy.prompt.speech || !policy.prompt.visualReview || !own(policy.prompt.byTag)) {
    throw new Error(`${file}: scene-policy 必填字段缺失`);
  }
  if (policy.requiredPlanCues && (!own(policy.requiredPlanCues)
    || Object.values(policy.requiredPlanCues).some((terms) => !Array.isArray(terms) || !terms.length || terms.some((term) => typeof term !== "string" || !term.trim())))) {
    throw new Error(`${file}: requiredPlanCues 无效`);
  }
  if (policy.requiredShotCues && (!own(policy.requiredShotCues)
    || Object.values(policy.requiredShotCues).some((terms) => !Array.isArray(terms) || !terms.length || terms.some((term) => typeof term !== "string" || !term.trim())))) {
    throw new Error(`${file}: requiredShotCues 无效`);
  }
  if (policy.restrictedCostumeTerms && (!Array.isArray(policy.restrictedCostumeTerms)
    || policy.restrictedCostumeTerms.some((term) => typeof term !== "string" || !term.trim()))) {
    throw new Error(`${file}: restrictedCostumeTerms 无效`);
  }
  if (policy.speechProhibitionTerms && (!Array.isArray(policy.speechProhibitionTerms)
    || policy.speechProhibitionTerms.some((term) => typeof term !== "string" || !term.trim()))) {
    throw new Error(`${file}: speechProhibitionTerms 无效`);
  }
  for (const [tag, bound] of Object.entries(policy.ratios)) {
    if (!own(bound) || !Array.isArray(policy.tagEvidence[tag]) || !policy.tagEvidence[tag]?.length) throw new Error(`${file}: ${tag} 缺配比或取证词`);
    if (bound.min !== undefined && (!Number.isFinite(bound.min) || bound.min < 0 || bound.min > 1)) throw new Error(`${file}: ${tag}.min 无效`);
    if (bound.max !== undefined && (!Number.isFinite(bound.max) || bound.max < 0 || bound.max > 1)) throw new Error(`${file}: ${tag}.max 无效`);
    if (bound.min !== undefined && bound.max !== undefined && bound.min > bound.max) throw new Error(`${file}: ${tag} 上下界倒置`);
  }
  /**
   * 品质底线词必须能被**肯定描述**命中（2026-09-28，T2 入库时发现的机制陷阱）：
   * 审计跑在 `affirmativeSkillText` 抽出的肯定文本上，"无…/没有…/不…" 开头的词会在归一里被截掉，
   * 写进 qualityFloorTerms 永远不会命中——必须在加载期就拦住，而不是留一个"看起来在管、其实永不触发"的条目。
   */
  const ineffective = policy.qualityFloorTerms.filter((term) => /^(?:无|没有|不|避免|禁止)/.test(term));
  if (ineffective.length > 0) {
    throw new Error(`${file}: qualityFloorTerms 不能以"无/没有/不/避免/禁止"开头（肯定文本归一后会失效）：${ineffective.join("、")}；请改写成可被正向描述命中的缺陷名词`);
  }
  for (const tag of policy.primaryTags) if (!policy.ratios[tag] || !policy.prompt.byTag[tag]) throw new Error(`${file}: 主景别 ${tag} 缺配比或提示`);
  return policy;
}

/** 读取仓内可版本化知识条目。重复 ID、坏 JSON 或坏 schema 一律阻断。 */
export function loadScenePolicies(directory: string): ScenePolicy[] {
  const files = readdirSync(directory).filter((name) => name.endsWith(".json")).sort();
  const seen = new Set<string>();
  return files.map((name) => {
    const path = join(directory, name);
    const bytes = readFileSync(path);
    const policy = validatePolicy(JSON.parse(bytes.toString("utf8")), path);
    if (seen.has(policy.id)) throw new Error(`scene-policy ID 重复：${policy.id}`);
    seen.add(policy.id);
    return { ...policy, sourceSha256: createHash("sha256").update(bytes).digest("hex") };
  });
}

/** 原始 brief 可以是嵌套表单；只取文本证据，不把整段客户原话写进报告或日志。 */
function demandFields(input: ScenePolicyInput, brief: Record<string, unknown> | null): Array<{ source: string; value: string }> {
  const result: Array<{ source: string; value: string }> = [];
  const collect = (value: unknown, source: string, depth: number): void => {
    if (depth > 4 || result.length >= 100) return;
    if (typeof value === "string" && value.trim()) { result.push({ source, value: value.slice(0, 20_000) }); return; }
    if (Array.isArray(value)) { value.slice(0, 30).forEach((item, index) => collect(item, `${source}[${index}]`, depth + 1)); return; }
    if (own(value)) for (const [key, item] of Object.entries(value)) {
      if (/token|secret|password|credential|authorization/i.test(key)) continue;
      collect(item, `${source}.${key}`, depth + 1);
    }
  };
  collect(input.title, "title", 0);
  collect(input.logline, "logline", 0);
  collect(input.videoType, "videoType", 0);
  collect(brief, "brief", 0);
  return result;
}

/** 显式片型优先；否则从客户原始需求自动选型，多类命中时必须澄清，不能按优先级悄悄压掉另一类。 */
export function selectScenePolicy(input: ScenePolicyInput, brief: Record<string, unknown> | null, policies: readonly ScenePolicy[]): { policy: ScenePolicy | null; reason: string; evidence: string[] } {
  const explicit = text(input.scenePolicy?.id || brief?.scenePolicyId || (own(brief?.scenePolicy) ? brief.scenePolicy.id : "")).trim();
  if (explicit) {
    const policy = policies.find((item) => item.id === explicit);
    if (!policy) throw new Error(`未知片型知识条目：${explicit}`);
    return { policy, reason: `显式片型 ${explicit}`, evidence: [`scenePolicy.id=${explicit}`] };
  }
  const fields = demandFields(input, brief);
  const demand = fields.map((item) => item.value).join(" ");
  const person = Boolean(input.character) || input.shots.some((shot) => Boolean(shot.character))
    || /真人|人物|出镜|口播|主持|模特|采访|访谈|演讲|负责人|总监|老总|主讲|肖像|主播|律师|医生|医师|会计师|咨询师|工程师|设计师|建筑师|理财顾问/.test(demand);
  const matched = policies.filter((policy) => (!policy.requiresPerson || person) && includesAny(demand, policy.autoSignals));
  if (!matched.length) {
    const categoryCue = /商业真人|企业宣传|品牌宣传|专业服务|科技数码|电商|带货|种草|知识口播|知识分享|美妆|美食|房产|家居|母婴|亲子|活动会议|品牌故事|企业负责人|商务短片/.exec(demand)?.[0];
    if (categoryCue) throw new Error(`客户需求含「${categoryCue}」，但没有可核实的已安装片型知识条目；请提供 scenePolicy.id 或安装对应条目`);
    return { policy: null, reason: "需求未命中已安装的片型知识条目", evidence: [] };
  }
  /**
   * 多条目命中时的判优（2026-09-28，T2 起需要）：
   *   · 人物主线优先：`requiresPerson` 为真、且客户需求里确实点了人/出镜的条目优先（T2 规范自己也写"人物部分套用 T1"）；
   *   · 再按 `priority` 取最高（同优先级仍冲突 → fail-closed 要求显式 scenePolicy.id）。
   * 判优结论写进 reason，便于审计看到"为什么选它而不是另一个"。
   */
  let candidates = matched;
  let precedence = "";
  const personLed = candidates.filter((policy) => policy.requiresPerson);
  if (personLed.length > 0 && personLed.length < candidates.length) {
    candidates = personLed;
    precedence = "人物主线优先";
  }
  const top = Math.max(...candidates.map((policy) => policy.priority));
  const highest = candidates.filter((policy) => policy.priority === top);
  if (highest.length > 1) throw new Error(`片型自动选择冲突：${highest.map((item) => item.id).join("、")}（priority=${top}）；请明确 scenePolicy.id`);
  const policy = highest[0]!;
  const evidence = fields.flatMap((field) => policy.autoSignals.filter((term) => field.value.includes(term)).map((term) => `${field.source}: ${term}`));
  const skipped = matched.filter((item) => item.id !== policy.id).map((item) => `${item.id}(priority=${item.priority}${item.requiresPerson ? "·需出镜" : ""})`);
  return {
    policy,
    reason: `需求自动命中：${[...new Set(evidence.map((item) => item.split(": ").slice(1).join(": ")))].join("、")}`
      + (skipped.length ? `；判优胜出（${precedence || `priority=${top}`}；未选 ${skipped.join("、")}）` : ""),
    evidence
  };
}

/** 注入关键帧和视频各自消费的字段；原台词、景别、机位、时长与角色绑定保持原样。 */
export function applyScenePolicy<T extends ScenePolicyShot>(shot: T, policy: ScenePolicy): T {
  const primary = (shot.policyTags ?? []).find((tag) => policy.primaryTags.includes(tag));
  const instruction = [policy.prompt.scene, primary ? policy.prompt.byTag[primary] : "", shot.speechMode === "on-camera" ? policy.prompt.speech : ""]
    .filter(Boolean).join("；");
  const inject = (old: string): string => old.includes(policy.prompt.scene) ? old : `${instruction}${old ? `；${old}` : ""}`;
  const oldPrompt = text(shot.prompt);
  return {
    ...shot,
    scene: inject(text(shot.scene)),
    sceneDescription: inject(text(shot.sceneDescription)),
    ...(oldPrompt ? { prompt: inject(oldPrompt) } : {}),
  };
}

/** 注入文本只负责生成指令，不能反过来充当原始分镜的合规证据。 */
function authoredEvidence(value: unknown, policy: ScenePolicy): string {
  let original = text(value);
  for (const injected of [policy.prompt.scene, policy.prompt.speech, ...Object.values(policy.prompt.byTag)]) {
    original = original.replaceAll(injected, "");
  }
  return affirmativeSkillText(original);
}

/** 全片时长加权配比与逐镜文本闸；必须用完整 shotlist 调用，局部 --only 渲染也不能绕过比例。 */
export function auditScenePolicy(input: ScenePolicyInput, policy: ScenePolicy): ScenePolicyReport {
  const defects: ScenePolicyDefect[] = [];
  const applied: ScenePolicyException[] = [];
  const push = (rule: string, shotId: string | null, detail: string): void => { defects.push({ rule, shotId, detail, hard: true }); };
  const exceptions = input.scenePolicy?.exceptions ?? [];
  const validExceptions = new Set<ScenePolicyException>();
  for (const entry of exceptions) {
    if (!(["restricted-location", "restricted-costume"] as const).includes(entry.rule) || !entry.shotId || !entry.term || !entry.customerRequest?.trim()
      || !entry.customerRequest.includes(entry.term) || !entry.source?.trim()) {
      push("exception-invalid", entry.shotId || null, "例外需写明镜头、受限地点或服饰、包含该词的客户原话与来源");
      continue;
    }
    validExceptions.add(entry);
  }
  const totals = Object.fromEntries(Object.keys(policy.ratios).map((tag) => [tag, 0])) as Record<string, number>;
  const planCues = Object.fromEntries(Object.keys(policy.requiredPlanCues ?? {}).map((cue) => [cue, { found: false, shotIds: [] as string[] }])) as ScenePolicyReport["planCues"];
  let totalSeconds = 0;
  const seenIds = new Set<string>();
  for (const shot of input.shots) {
    const id = text(shot.shotId).trim();
    if (!id || seenIds.has(id)) { push("shot-id", id || null, "镜头 ID 必须非空且唯一"); continue; }
    seenIds.add(id);
    const duration = Number(shot.duration);
    if (!Number.isFinite(duration) || duration <= 0) { push("duration", id, "片型配比要求每镜有正数时长"); continue; }
    totalSeconds += duration;
    const tags = shot.policyTags;
    if (!Array.isArray(tags) || !tags.length || tags.some((tag) => typeof tag !== "string" || !policy.ratios[tag]) || new Set(tags).size !== tags.length) {
      push("policy-tags", id, "须声明且仅声明知识条目定义的 policyTags，不能重复或使用未知标签");
      continue;
    }
    const primary = tags.filter((tag) => policy.primaryTags.includes(tag));
    if (primary.length !== 1) push("primary-shot-type", id, `须恰好声明一个主景别：${policy.primaryTags.join("/")}`);
    const positive = [shot.scene, shot.sceneDescription, shot.composition, shot.action, shot.props, shot.lighting, shot.costume]
      .map((value) => authoredEvidence(value, policy)).join("；");
    for (const [cue, terms] of Object.entries(policy.requiredShotCues ?? {})) {
      if (!includesAny(positive, terms)) push("required-shot-cue", id, `本镜缺少必备可见证据：${cue}`);
    }
    for (const [cue, terms] of Object.entries(policy.requiredPlanCues ?? {})) if (includesAny(positive, terms)) {
      planCues[cue]!.found = true;
      planCues[cue]!.shotIds.push(id);
    }
    const composition = affirmativeSkillText(text(shot.composition));
    const movement = affirmativeSkillText(text(shot.camera_movement || shot.cameraMovement));
    for (const tag of tags) {
      totals[tag] = (totals[tag] ?? 0) + duration;
      const evidence = tag === "moving" ? movement : policy.primaryTags.includes(tag) ? composition : positive;
      if (!includesAny(evidence, policy.tagEvidence[tag] ?? [])) push("tag-evidence", id, `${tag} 标签在分镜肯定描述中缺取证词`);
    }
    if (policy.ratios.moving && includesAny(movement, policy.movingEvidence) !== tags.includes("moving"))
      push("motion-consistency", id, "运动镜头标签与 camera_movement 的实际正向描述不一致");
    for (const term of policy.qualityFloorTerms) if (positive.includes(term)) push("quality-floor", id, `触及不可豁免的品质底线：${term}`);
    for (const term of policy.restrictedLocations) if (positive.includes(term)) {
      const exception = [...validExceptions].find((entry) => entry.rule === "restricted-location" && entry.shotId === id && entry.term === term);
      if (exception) { applied.push(exception); validExceptions.delete(exception); }
      else push("restricted-location", id, `默认受限场景「${term}」须提供客户明确要求与来源；品质底线仍适用`);
    }
    const costume = authoredEvidence(shot.costume, policy);
    for (const term of policy.restrictedCostumeTerms ?? []) if (costume.includes(term)) {
      const exception = [...validExceptions].find((entry) => entry.rule === "restricted-costume" && entry.shotId === id && entry.term === term);
      if (exception) { applied.push(exception); validExceptions.delete(exception); }
      else push("restricted-costume", id, `默认受限服饰「${term}」须提供客户明确要求与来源`);
    }
    const dialogueLines = Array.isArray(shot.dialogue)
      ? shot.dialogue.map((row) => typeof row === "string" ? row : own(row) ? text(row.text) : "").filter((line) => line.trim())
      : text(shot.dialogue).trim() ? [text(shot.dialogue)] : [];
    const dialogue = dialogueLines.length > 0;
    for (const term of policy.speechProhibitionTerms ?? []) {
      if (dialogueLines.some((line) => line.includes(term))) push("speech-prohibition", id, `台词含片型禁止承诺：${term}`);
    }
    if (dialogue && shot.speechMode !== "on-camera" && shot.speechMode !== "voice-over") push("speech-mode", id, "有台词的镜头须声明 on-camera 或 voice-over");
    if (dialogue && shot.speechMode === "on-camera") {
      const cues = policy.speechScenes[text(shot.speechScene)];
      if (!cues || !includesAny(positive, cues)) push("speech-scene", id, "出镜口播须声明正式场景，并在场景描述中给出可见证据");
    }
    if (shot.speechMode === "on-camera" && !includesAny(affirmativeSkillText(text(shot.costume)), policy.formalCostumeEvidence))
      push("formal-costume", id, "出镜人物服装未写明合体的正式商务服饰");
  }
  for (const entry of validExceptions) push("exception-unused", entry.shotId, `例外未命中本镜受限地点「${entry.term}」，不得预先空白授权`);
  for (const [cue, result] of Object.entries(planCues)) if (!result.found) push("required-plan-cue", null, `全片缺少必备画面/叙事证据：${cue}`);
  const ratios: ScenePolicyReport["ratios"] = {};
  for (const [tag, bound] of Object.entries(policy.ratios)) {
    const seconds = totals[tag] ?? 0;
    const share = totalSeconds > 0 ? seconds / totalSeconds : 0;
    ratios[tag] = { seconds: Number(seconds.toFixed(3)), share: Number(share.toFixed(6)), ...bound };
    if (bound.min !== undefined && share + 1e-9 < bound.min) push("ratio-min", null, `${tag} ${Math.round(share * 100)}% < ${Math.round(bound.min * 100)}%`);
    if (bound.max !== undefined && share - 1e-9 > bound.max) push("ratio-max", null, `${tag} ${Math.round(share * 100)}% > ${Math.round(bound.max * 100)}%`);
  }
  return {
    schemaVersion: "workloom.scene-policy-report/v1",
    policy: { id: policy.id, version: policy.version, title: policy.title, sourceSha256: policy.sourceSha256 ?? null, selection: "" },
    totalSeconds: Number(totalSeconds.toFixed(3)), ratios, planCues, exceptionsApplied: applied, defects, passed: defects.length === 0,
  };
}
