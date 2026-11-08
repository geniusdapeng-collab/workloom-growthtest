import type { GateFinding } from "./pipeline-control-plane/contracts.js";

export const PROMPT_FINDING_SCHEMA = "workloom.prompt-finding/v1" as const;

export type PromptFindingSeverity = "blocking" | "major" | "minor" | "advisory";
export type PromptRepairClass =
  | "schema"
  | "deterministic"
  | "semantic"
  | "evidence"
  | "human_input"
  | "replan";

export interface PromptFinding {
  schemaVersion: typeof PROMPT_FINDING_SCHEMA;
  code: string;
  severity: PromptFindingSeverity;
  shotId: string | null;
  fieldPath: string | null;
  expected?: unknown;
  actual?: unknown;
  issue: string;
  suggestion: string | null;
  evidenceRefs: string[];
  repairClass: PromptRepairClass;
}

const SHOT_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/u;
const SHOT_ID_TEXT = /\b(?:S|SC|SHOT)[-_ ]?\d+\b/iu;
const FIELD_ALIASES: ReadonlyArray<readonly [RegExp, string]> = [
  [/场景|scene/iu, "fields.scene"],
  [/灯光|照明|lighting/iu, "fields.lighting"],
  [/构图|composition/iu, "fields.composition"],
  [/色彩|色调|color[_ ]?palette/iu, "fields.color_palette"],
  [/景深|depth[_ ]?of[_ ]?field/iu, "fields.depth_of_field"],
  [/运镜|camera[_ ]?movement|镜别|景别/iu, "fields.camera_movement"],
  [/角色|character/iu, "fields.character"],
  [/服装|costume/iu, "fields.costume"],
  [/妆容|妆造|makeup/iu, "fields.makeup"],
  [/动作|action/iu, "fields.action"],
  [/道具|props?/iu, "fields.props"],
  [/定妆照|portraits?/iu, "fields.portraits"],
  [/台词|对白|dialogue/iu, "fields.dialogue"],
  [/时间轴|timeline/iu, "fields.timeline"],
  [/情绪|mood/iu, "fields.mood"],
  [/节奏|pacing/iu, "fields.pacing"],
  [/转场|transition/iu, "fields.transition"],
  [/声音|音频|audio/iu, "fields.audio"],
  [/负面|negative/iu, "fields.negative"],
  [/一致性|continuity|consistency/iu, "fields.consistency"],
];

function text(value: unknown): string {
  if (typeof value === "string") return value.trim();
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return "";
}

function record(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function severity(value: unknown): PromptFindingSeverity {
  const normalized = text(value).toLowerCase();
  if (["p0", "fatal", "critical", "blocking", "block"].includes(normalized)) return "blocking";
  if (["p1", "major", "error"].includes(normalized)) return "major";
  if (["minor", "warning", "warn", "p2"].includes(normalized)) return "minor";
  return "major";
}

function repairClass(value: unknown): PromptRepairClass {
  const normalized = text(value).toLowerCase();
  if (["schema", "deterministic", "semantic", "evidence", "human_input", "replan"].includes(normalized)) {
    return normalized as PromptRepairClass;
  }
  if (normalized === "no_repair") return "human_input";
  return "semantic";
}

export function inferPromptFindingShotId(value: unknown): string | null {
  const explicit = text(value).trim();
  if (SHOT_ID.test(explicit)) return explicit;
  return SHOT_ID_TEXT.exec(text(value))?.[0]?.replace(/\s+/gu, "") ?? null;
}

export function inferPromptFindingFieldPath(value: unknown): string | null {
  const body = text(value);
  const explicit = /(?:fieldPath|field_path|field)\s*[:=]\s*([A-Za-z0-9_.:-]+)/iu.exec(body)?.[1];
  if (explicit) return explicit.includes(".") ? explicit : `fields.${explicit}`;
  return FIELD_ALIASES.find(([pattern]) => pattern.test(body))?.[1] ?? null;
}

function normalizeFindingCode(value: unknown, index: number): string {
  const raw = text(value).toUpperCase().replace(/[^A-Z0-9_]+/gu, "_").replace(/^_+|_+$/gu, "");
  return (raw || `PROMPT_REVIEW_${index + 1}`).slice(0, 120);
}

/**
 * Normalize one model/checker finding. Unknown fields are ignored rather than copied into
 * the repair plan, so model-authored controls cannot become executable host metadata.
 */
export function normalizePromptFinding(
  value: unknown,
  index = 0,
  fallbackSuggestion: unknown = null,
): PromptFinding | null {
  const item = record(value) ? value : { issue: text(value) };
  const issue = text(item.issue ?? item.message ?? item.description ?? item.problem ?? item.reason ?? value);
  if (!issue) return null;
  const shotId = inferPromptFindingShotId(item.shotId ?? item.shot_id ?? item.targetId ?? issue);
  const fieldPath = text(item.fieldPath ?? item.field_path ?? item.field)
    || inferPromptFindingFieldPath(issue);
  const evidenceRefs = Array.isArray(item.evidenceRefs)
    ? item.evidenceRefs.map(text).filter(Boolean).slice(0, 50)
    : [];
  return {
    schemaVersion: PROMPT_FINDING_SCHEMA,
    code: normalizeFindingCode(item.code ?? item.issueType ?? item.issue_type ?? "PROMPT_REVIEW", index),
    severity: severity(item.severity ?? item.level),
    shotId,
    fieldPath: fieldPath || null,
    ...(item.expected !== undefined ? { expected: item.expected } : {}),
    ...(item.actual !== undefined ? { actual: item.actual } : { actual: issue }),
    issue,
    suggestion: text(item.suggestion ?? item.suggestedAction ?? fallbackSuggestion) || null,
    evidenceRefs,
    repairClass: repairClass(item.repairClass ?? item.repair_class),
  };
}

/** Backward-compatible bridge from legacy string-only `issues/suggestions` verdicts. */
export function derivePromptFindings(
  issues: readonly unknown[],
  suggestions: readonly unknown[] = [],
  reason?: unknown,
): PromptFinding[] {
  const findings = issues
    .map((issue, index) => normalizePromptFinding(issue, index, suggestions[index]))
    .filter((item): item is PromptFinding => Boolean(item));
  if (findings.length > 0) return findings;
  const fallback = normalizePromptFinding(reason, 0);
  return fallback ? [fallback] : [];
}

export function promptFindingKey(finding: PromptFinding): string {
  return [
    finding.code,
    finding.shotId ?? "package",
    finding.fieldPath ?? "package",
    finding.repairClass,
  ].join("|");
}

export function promptFindingIsBlocking(finding: PromptFinding): boolean {
  return finding.severity === "blocking" || finding.severity === "major";
}

export function promptFindingToGateFinding(finding: PromptFinding): GateFinding {
  return {
    code: finding.code,
    severity: finding.severity === "blocking"
      ? "P0"
      : finding.severity === "major"
        ? "P1"
        : finding.severity === "minor"
          ? "P2"
          : "advisory",
    targetType: finding.shotId ? (finding.fieldPath ? "field" : "item") : (finding.fieldPath ? "field" : "run"),
    targetId: finding.shotId,
    fieldPath: finding.fieldPath,
    ...(finding.expected !== undefined ? { expected: finding.expected } : {}),
    ...(finding.actual !== undefined ? { actual: finding.actual } : {}),
    evidenceRefs: finding.evidenceRefs.slice(0, 200),
    repairClass: finding.repairClass,
    blocking: promptFindingIsBlocking(finding),
  };
}
