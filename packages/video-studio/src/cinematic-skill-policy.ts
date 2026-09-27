/**
 * 宿主摄影技能准入：技能必须服务原镜头的主体、情绪和运镜。
 * vendor 索引与技法仍是内容来源；这里只修路由契约与可核验的文本边界。
 * 文本检查不代表生成画面通过摄影质量验收。
 */
import { createHash } from "node:crypto";

export type CinematicSkillStatus = "passed" | "failed" | "unverified" | "not_applicable";
type Card = Record<string, unknown>;

export class CinematicSkillError extends Error {
  constructor(readonly code: string, message: string, readonly status: CinematicSkillStatus = "failed") {
    super(`${code}: ${message}`);
    this.name = "CinematicSkillError";
  }
}

export interface SkillSubject {
  hasPerson: boolean;
  faceVisible: boolean;
  shotScale: "close" | "medium" | "wide" | "unknown";
}

export interface CinematicSkillEntry {
  file: string;
  domain: string;
  emotions: string[];
  camera_modes: string[];
  type?: string;
  director?: string;
  oneLiner?: string;
  [key: string]: unknown;
}

export interface RankedCinematicSkill {
  skill: CinematicSkillEntry;
  score: number;
  reasons?: string[];
  fallback?: boolean;
  excluded?: string;
}

export interface SkillQCEntry {
  file: string;
  qc: string[];
  forbidden: string[];
}

export interface CinematicSkillRouter {
  assignFilmDirector(blueprint: Card): { director: string; source: string };
  normalizeShotMeta(shot: Card, options: Card): Card;
  matchSkillsV2(meta: Card, options: Card): RankedCinematicSkill[];
  buildSkillContextText(matches: RankedCinematicSkill[], options: Card): string;
  getSkillQCBlocks(files: string[]): SkillQCEntry[];
}

export interface CinematicSkillPlan {
  shotId: string;
  status: CinematicSkillStatus;
  reason: string;
  sourceHash: string;
  contextHash: string;
  contextText: string;
  subject: SkillSubject;
  cameraMode: string;
  director: string;
  directorSource: string;
  router: "host-semantic" | "host-deterministic";
  matched: Array<{ file: string; score: number; reasons: string[]; domain: string; llmReason?: string }>;
  qcEntries: SkillQCEntry[];
}

function textOf(value: unknown): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map(textOf).filter(Boolean).join("；");
  if (value && typeof value === "object") {
    const record = value as Card;
    if (typeof record.string === "string") return record.string;
    return Object.entries(record).filter(([key]) => !key.startsWith("_")).map(([, item]) => textOf(item)).filter(Boolean).join("；");
  }
  return "";
}

/** 稳定哈希绑定本次源卡/蓝图/上下文；无法序列化的输入不是一个可复核镜头。 */
export function cinematicSkillHash(value: unknown): string {
  const serialized = JSON.stringify(value, (_key, item: unknown) => {
    if (item && typeof item === "object" && !Array.isArray(item)) {
      return Object.fromEntries(Object.entries(item as Card).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0));
    }
    return item;
  });
  if (serialized === undefined) throw new CinematicSkillError("SKILL_INPUT_INVALID", "输入不能序列化");
  return createHash("sha256").update(serialized).digest("hex");
}

/**
 * 只取肯定描述做匹配/禁词检查。负面字段整块排除；否定清单保留到句末，
 * “但/而是/but”恢复肯定语义，避免“禁止 X，但要 Y”把 Y 一并抹掉。
 */
export function affirmativeSkillText(raw: string): string {
  const withoutNegativeBlocks = raw.replace(
    /(?:\d{1,2}\.\s*)?【(?:负面(?:约束)?|禁止(?:项|词)?|negative(?: prompt)?)】[^【]*(?=【|$)/gi,
    "\n"
  );
  return withoutNegativeBlocks.split(/[。；;\n]+/).flatMap((sentence) => {
    const contrasts = sentence.split(/但是|然而|不过|而是|但|\bbut\b|\binstead\b/gi);
    return contrasts.map((clause) => {
      const match = /禁止|避免|不要|不得|不能|不许|无需|没有|未见|无(?:需|任何)?|不(?:要|再)?(?=[\u4e00-\u9fff])|\b(?:no|not|never|without|avoid)\b/i.exec(clause);
      return (match ? clause.slice(0, match.index) : clause).trim();
    });
  }).filter(Boolean).join("；");
}

export function normalizeCinematicSkillShot(shot: Card): { shot: Card; subject: SkillSubject } {
  const fields = shot.fields && typeof shot.fields === "object" && !Array.isArray(shot.fields) ? shot.fields as Card : {};
  const field = (key: string): unknown => shot[key] ?? fields[key];
  const subjectValue = field("subject");
  const explicit = subjectValue && typeof subjectValue === "object" && !Array.isArray(subjectValue) ? subjectValue as Card : {};
  const description = [field("description"), field("scene"), field("sceneDescription"), field("action"), field("composition"), subjectValue].map(textOf).join(" ");
  const character = textOf(field("character") ?? field("characters")).trim();
  const noPerson = explicit.hasPerson === false || explicit.count === 0
    || /^(?:none|object|product|environment|landscape)$/i.test(String(explicit.kind ?? ""))
    || /无人(?!机)(?:物|出镜)?|没有(?:人|人物)|不(?:出现|拍摄)(?:人|人物)|空镜|无(?:人像|角色)|\bno (?:people|person|human|character)s?\b|\bempty (?:room|office)\b/i.test(description)
    || /^(?:none|无|无人|无人物|无角色)$/i.test(character);
  const positive = affirmativeSkillText(description);
  const hasPerson = !noPerson && (explicit.hasPerson === true || /^(?:person|human)$/i.test(String(explicit.kind ?? ""))
    || Boolean(character)
    || /人物|主角|女主|男主|女人|男人|女性|男性|女孩|男孩|老人|儿童|孩子|演员|游客|工人|医生|护士|士兵|她|他(?!人)|\b(?:person|woman|man|girl|boy|actor|actress|people)\b/i.test(positive));
  const scaleText = [field("composition"), field("shotScale"), description].map(textOf).join(" ");
  const shotScale = /大特写|特写|近景|\bclose[ -]?up\b/i.test(scaleText) ? "close"
    : /远景|大全景|航拍|空镜|\bwide\b|\baerial\b/i.test(scaleText) ? "wide" : hasPerson ? "medium" : "unknown";
  const hiddenFace = explicit.faceVisible === false
    || /不露(?:脸|面部)|看不(?:到|见)(?:脸|面部)|背影|背对镜头|仅(?:拍|见|有)?(?:手部|双手|背部)|只有(?:双手|手部)|\b(?:back view|face hidden|hands only)\b/i.test(description);
  const faceVisible = hasPerson && !hiddenFace && (explicit.faceVisible === true || shotScale !== "wide");
  const camera = field("camera");
  const cameraRecord = camera && typeof camera === "object" && !Array.isArray(camera) ? camera as Card : {};
  const movement = affirmativeSkillText(textOf(field("camera_movement") ?? field("cameraMovement") ?? cameraRecord.movement ?? field("cameraString") ?? camera));
  const mood = affirmativeSkillText(textOf(field("mood") ?? field("emotion") ?? (field("emotional_target") as Card | undefined)?.emotion));
  return {
    subject: { hasPerson, faceVisible, shotScale },
    shot: {
      ...shot,
      description: affirmativeSkillText(description),
      scene: affirmativeSkillText(textOf(field("scene"))),
      sceneDesc: affirmativeSkillText(textOf(field("sceneDesc"))),
      // vendor 的 || 回退会重读 emotion/emotional_target/prompt；所有支路使用同一肯定文本。
      mood, emotion: mood, emotional_target: { emotion: mood }, prompt: "",
      camera: { ...cameraRecord, movement },
      cameraMovement: movement,
    },
  };
}

/** 完整行取舍，长单条舍弃，不把“禁止”或动作截成半句话。 */
export function boundCinematicSkillContext(context: string, budget = 1800): string {
  if (!Number.isInteger(budget) || budget <= 0) throw new CinematicSkillError("SKILL_CONTEXT_BUDGET_INVALID", "上下文预算必须为正整数");
  const lines: string[] = [];
  let length = 0;
  for (const raw of context.split("\n")) {
    const line = raw.trim();
    if (!line || length + line.length + (lines.length ? 1 : 0) > budget) continue;
    lines.push(line);
    length += line.length + (lines.length > 1 ? 1 : 0);
  }
  return lines.join("\n");
}

function validCandidate(candidate: RankedCinematicSkill, meta: Card, subject: SkillSubject): boolean {
  const skill = candidate?.skill;
  if (!skill || !skill.file || !Number.isFinite(candidate.score) || candidate.excluded || candidate.fallback) return false;
  if (!Array.isArray(skill.emotions) || !Array.isArray(skill.camera_modes)) throw new CinematicSkillError("SKILL_INDEX_INVALID", "技能索引缺情绪或运镜数组", "unverified");
  if (skill.domain === "acting" && !subject.faceVisible) return false;
  const reasons = candidate.reasons ?? [];
  if (!reasons.includes("emotion") && !reasons.includes("camera")) return false;
  // 摄影库中的情绪专属条目不能仅凭导演/运镜命中：战争史诗不能成为商品微距的默认风格。
  if (skill.emotions.length && !skill.emotions.includes(String(meta.emotion ?? ""))) return false;
  const cameraMode = String(meta.cameraMode ?? "any");
  if (cameraMode !== "any" && skill.camera_modes.length && !skill.camera_modes.includes("any") && !skill.camera_modes.includes(cameraMode)) return false;
  return true;
}

function parseSelection(raw: unknown, candidates: RankedCinematicSkill[]): Array<{ file: string; reason: string }> {
  let value = raw;
  if (typeof raw === "string") {
    const json = raw.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
    try { value = JSON.parse(json); } catch { throw new CinematicSkillError("SKILL_SELECTION_INVALID", "技能精选没有返回合法 JSON", "unverified"); }
  }
  if (!value || typeof value !== "object" || !Array.isArray((value as Card).picks)) {
    throw new CinematicSkillError("SKILL_SELECTION_INVALID", "技能精选缺 picks 数组", "unverified");
  }
  const picks = (value as { picks: unknown[] }).picks;
  if (picks.length > 2) throw new CinematicSkillError("SKILL_SELECTION_INVALID", "每镜最多选择两个技能", "unverified");
  const allowed = new Set(candidates.map(({ skill }) => skill.file));
  const seen = new Set<string>();
  return picks.map((pick) => {
    if (!pick || typeof pick !== "object") throw new CinematicSkillError("SKILL_SELECTION_INVALID", "技能选择条目无效", "unverified");
    const { file, reason } = pick as Card;
    if (typeof file !== "string" || !allowed.has(file) || seen.has(file) || typeof reason !== "string" || !reason.trim()) {
      throw new CinematicSkillError("SKILL_SELECTION_INVALID", "技能选择包含未知/重复技能或缺依据", "unverified");
    }
    seen.add(file);
    return { file, reason: reason.trim().slice(0, 240) };
  });
}

export async function planCinematicSkills(
  shots: Card[], blueprint: Card, router: CinematicSkillRouter,
  options: { llmCaller?: (prompt: string) => Promise<unknown>; beforeExternalCall?: () => void; registryHash?: string } = {}
): Promise<Map<string, CinematicSkillPlan>> {
  const assignment = router.assignFilmDirector(blueprint);
  const director = assignment.source === "default" ? "" : assignment.director;
  const plan = new Map<string, CinematicSkillPlan>();
  for (const shot of shots) {
    const shotId = String(shot.shotId ?? shot.shot_id ?? "").trim();
    if (!shotId || plan.has(shotId)) throw new CinematicSkillError("SKILL_SHOT_ID_INVALID", "镜头 id 必须非空且唯一");
    const normalized = normalizeCinematicSkillShot(shot);
    const meta: Card = {
      ...router.normalizeShotMeta(normalized.shot, { assignedDirector: director, filmGenre: blueprint.genre ?? blueprint.type ?? "" }),
      subject: normalized.subject,
    };
    const candidates = router.matchSkillsV2(meta, { limit: Number.MAX_SAFE_INTEGER, minScore: 5 })
      .filter((candidate) => validCandidate(candidate, meta, normalized.subject)).slice(0, 8);
    let selected = candidates.slice(0, 2).map((candidate) => ({ file: candidate.skill.file, reason: "" }));
    if (candidates.length && options.llmCaller) {
      options.beforeExternalCall?.();
      selected = parseSelection(await options.llmCaller([
        "为原镜头选择最多两个摄影/表演技能。只选与主体、景别、动作、情绪、运镜相容的技法；不能新增人物、动作、道具、光源或场景。",
        "如果没有合适项，返回 {\"picks\":[]}，这表示不适用；不得为凑数选择。每个选择须含 file 和 reason。",
        `原镜头：${JSON.stringify(shot)}`,
        `候选：${JSON.stringify(candidates.map(({ skill, reasons }) => ({ file: skill.file, domain: skill.domain, summary: skill.oneLiner ?? "", reasons })))}`,
        '输出格式：{"picks":[{"file":"候选完整文件名","reason":"具体适用依据"}]}',
      ].join("\n")), candidates);
    }
    const matches = selected.map(({ file }) => candidates.find(({ skill }) => skill.file === file)!);
    // vendor 会整块舍弃超预算的第二技能；逐项取正文，确保每个 matched 真正进入融合输入。
    const perSkillBudget = matches.length ? Math.floor((1560 - (matches.length - 1) * 2) / matches.length) : 0;
    const content = matches.map((candidate) => {
      const label = `技能来源：${candidate.skill.file}\n`;
      const body = boundCinematicSkillContext(router.buildSkillContextText([candidate], {
        shotScale: normalized.subject.shotScale, duration: Number(shot.duration ?? 0),
      }), perSkillBudget - label.length);
      if (!body) throw new CinematicSkillError("SKILL_CONTEXT_MISSING", `${shotId} 的 ${candidate.skill.file} 没有可用上下文`, "unverified");
      return label + body;
    }).join("\n\n");
    const contextText = content ? "适用边界：原镜头的主体、人数、动作、时段、光源、构图和运镜优先。技能中的情节示例不得新增为镜头内容；只融合相容技法。\n" + content : "";
    const qcEntries = router.getSkillQCBlocks(matches.map(({ skill }) => skill.file));
    if (matches.some(({ skill }) => !qcEntries.some(({ file }) => file === skill.file))) {
      throw new CinematicSkillError("SKILL_QC_MISSING", `${shotId} 已选择技能缺质检条目`, "unverified");
    }
    plan.set(shotId, {
      shotId,
      status: matches.length ? "passed" : "not_applicable",
      reason: matches.length ? "技能通过主体、情绪、运镜适用性选择；尚不代表画面通过" : "没有适用于原镜头的技能，保留镜头意图",
      sourceHash: cinematicSkillHash({ shot, blueprint, registryHash: options.registryHash ?? null }),
      contextHash: cinematicSkillHash(contextText), contextText,
      subject: normalized.subject, cameraMode: String(meta.cameraMode ?? "any"),
      director: String(meta.director ?? director), directorSource: director ? assignment.source : "none",
      router: options.llmCaller ? "host-semantic" : "host-deterministic",
      matched: matches.map((candidate) => ({
        file: candidate.skill.file, score: candidate.score, reasons: candidate.reasons ?? [], domain: candidate.skill.domain,
        ...(selected.find(({ file }) => file === candidate.skill.file)?.reason ? { llmReason: selected.find(({ file }) => file === candidate.skill.file)!.reason } : {}),
      })),
      qcEntries,
    });
  }
  return plan;
}

/** 机械禁词检查只针对肯定描述；画面/物理/表演检查仍需独立视觉证据。 */
export function checkCinematicSkillCompliance(text: string, entries: SkillQCEntry[]): Array<{ skill: string; term: string }> {
  const positive = affirmativeSkillText(text);
  const violations: Array<{ skill: string; term: string }> = [];
  for (const entry of entries) {
    if (!Array.isArray(entry.forbidden)) throw new CinematicSkillError("SKILL_QC_INVALID", "质检禁词数组无效", "unverified");
    for (const raw of entry.forbidden) {
      const term = String(raw).split(/[：:]/)[0]!.replace(/^[\s*\-\[\]]+|[\s*]+$/g, "").trim();
      if (term.length >= 2 && positive.toLowerCase().includes(term.toLowerCase())) violations.push({ skill: entry.file, term });
    }
  }
  return violations;
}
