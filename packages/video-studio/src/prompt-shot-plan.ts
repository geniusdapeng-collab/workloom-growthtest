import { createHash } from "node:crypto";
import type { PromptRepairRow } from "./prompt-repair-plan.js";

export const PROMPT_CONSTRAINT_SET_SCHEMA = "workloom.video-constraints/v1" as const;
export const PROMPT_STORY_PLAN_SCHEMA = "workloom.video-story/v1" as const;
export const PROMPT_SHOT_PLAN_SCHEMA = "workloom.video-shot/v1" as const;
export const PROMPT_ARTIFACT_SCHEMA = "workloom.video-prompt-artifact/v1" as const;

export const STANDARD_PROMPT_FIELD_KEYS = [
  "director_instruction",
  "constraint",
  "baseline",
  "scene",
  "lighting",
  "composition",
  "color_palette",
  "depth_of_field",
  "camera_movement",
  "character",
  "costume",
  "makeup",
  "action",
  "props",
  "portraits",
  "dialogue",
  "timeline",
  "mood",
  "pacing",
  "transition",
  "audio",
  "negative",
  "bright_constraint",
  "character_constraint",
  "consistency",
] as const;

export type StandardPromptFieldKey = (typeof STANDARD_PROMPT_FIELD_KEYS)[number];

export interface PromptConstraint {
  constraintId: string;
  dimension: string;
  scope: "package" | "shot" | "subject";
  value: unknown;
  origin: string;
  priority: "hard" | "preference";
  verification: "deterministic" | "semantic" | "human";
}

export interface PromptConstraintSet {
  schemaVersion: typeof PROMPT_CONSTRAINT_SET_SCHEMA;
  projectId: string;
  revision: number;
  constraints: PromptConstraint[];
  hash: string;
}

export interface PromptStoryPlan {
  schemaVersion: typeof PROMPT_STORY_PLAN_SCHEMA;
  projectId: string;
  revision: number;
  title: string | null;
  orderedShotIds: string[];
  hash: string;
}

export interface PromptShotPlan {
  schemaVersion: typeof PROMPT_SHOT_PLAN_SCHEMA;
  projectId: string;
  revision: number;
  shotId: string;
  durationSeconds: number | null;
  objective: string | null;
  visibleAction: string | null;
  participants: string[];
  products: string[];
  props: string[];
  continuityIn: string | null;
  continuityOut: string | null;
  audioEvents: string[];
  evidenceRefs: string[];
  nativeFields: Record<StandardPromptFieldKey, unknown>;
  hash: string;
}

export interface PromptArtifact {
  schemaVersion: typeof PROMPT_ARTIFACT_SCHEMA;
  projectId: string;
  revision: number;
  shotId: string;
  prompt: string;
  fields: Record<string, unknown>;
  fieldKeys: string[];
  shotPlanHash: string;
  hash: string;
}

export function buildPromptConstraintSet(input: {
  projectId: string;
  revision: number;
  rawIntent: string;
  metadata?: Record<string, unknown>;
  targetSeconds?: number;
}): PromptConstraintSet {
  const metadata = input.metadata ?? {};
  const constraints: PromptConstraint[] = [{
    constraintId: "raw-intent",
    dimension: "creative_contract",
    scope: "package",
    value: input.rawIntent,
    origin: "user",
    priority: "hard",
    verification: "semantic",
  }];
  const add = (constraintId: string, dimension: string, value: unknown, verification: PromptConstraint["verification"]) => {
    if (value === undefined || value === null || value === "") return;
    constraints.push({ constraintId, dimension, scope: "package", value, origin: "metadata", priority: "hard", verification });
  };
  add("target-seconds", "duration", input.targetSeconds ?? metadata.targetSeconds, "deterministic");
  add("platform", "platform", metadata.platform, "deterministic");
  add("aspect-ratio", "aspect_ratio", metadata.aspectRatio, "deterministic");
  add("no-dialogue", "audio", metadata.dialogueRequirement, "semantic");
  const base = {
    schemaVersion: PROMPT_CONSTRAINT_SET_SCHEMA,
    projectId: input.projectId,
    revision: input.revision,
    constraints,
  } satisfies Omit<PromptConstraintSet, "hash">;
  return { ...base, hash: stableHash(base) };
}

export function buildPromptStoryPlan(input: {
  projectId: string;
  revision: number;
  title?: string | null;
  rows: readonly PromptRepairRow[];
}): PromptStoryPlan {
  const base = {
    schemaVersion: PROMPT_STORY_PLAN_SCHEMA,
    projectId: input.projectId,
    revision: input.revision,
    title: input.title?.trim() || null,
    orderedShotIds: input.rows.map(row => row.shotId),
  } satisfies Omit<PromptStoryPlan, "hash">;
  return { ...base, hash: stableHash(base) };
}

export function derivePromptShotPlan(
  projectId: string,
  revision: number,
  row: PromptRepairRow,
  evidenceRefs: readonly string[] = [],
): PromptShotPlan {
  const fields = row.fields;
  const fieldText = (key: string): string | null => {
    const value = fields[key] ?? row[key];
    return typeof value === "string" && value.trim() ? value.trim() : null;
  };
  const rowList = (key: string): string[] => {
    const value = row[key];
    if (Array.isArray(value)) return [...new Set(value.map(item => String(item).trim()).filter(Boolean))];
    return textualList(typeof value === "string" ? value.trim() : null);
  };
  const textualList = (value: string | null): string[] => value
    ? [...new Set(value.split(/[、,，；;]/u).map(item => item.trim()).filter(Boolean))]
    : [];
  const audioEvents = textualList(fieldText("audio"));
  const base = {
    schemaVersion: PROMPT_SHOT_PLAN_SCHEMA,
    projectId,
    revision,
    shotId: row.shotId,
    durationSeconds: Number.isFinite(Number(row.duration)) ? Number(row.duration) : null,
    objective: fieldText("director_instruction"),
    visibleAction: fieldText("action"),
    participants: textualList(fieldText("character")),
    products: rowList("products"),
    props: textualList(fieldText("props")),
    continuityIn: fieldText("transition"),
    continuityOut: fieldText("consistency"),
    audioEvents,
    evidenceRefs: [...new Set(evidenceRefs.map(String).filter(Boolean))],
    nativeFields: Object.fromEntries(STANDARD_PROMPT_FIELD_KEYS.map(key => [key, fields[key]])) as Record<StandardPromptFieldKey, unknown>,
  } satisfies Omit<PromptShotPlan, "hash">;
  return { ...base, hash: stableHash(base) };
}

export function compilePromptArtifact(plan: PromptShotPlan, row: PromptRepairRow): PromptArtifact {
  const fields = Object.fromEntries(Object.entries(row.fields));
  const keys = Object.keys(fields);
  const base = {
    schemaVersion: PROMPT_ARTIFACT_SCHEMA,
    projectId: plan.projectId,
    revision: plan.revision,
    shotId: row.shotId,
    prompt: row.prompt,
    fields,
    fieldKeys: keys,
    shotPlanHash: plan.hash,
  } satisfies Omit<PromptArtifact, "hash">;
  return { ...base, hash: stableHash(base) };
}

export function assertStandardPromptFields(fields: Record<string, unknown>): void {
  const keys = Object.keys(fields);
  const unknown = keys.filter(key => !(STANDARD_PROMPT_FIELD_KEYS as readonly string[]).includes(key));
  if (unknown.length > 0) throw new Error(`PROMPT_STANDARD_FIELDS_CHANGED: 出现非标准字段 ${unknown.join(",")}`);
}

function stableHash(value: unknown): string {
  const text = JSON.stringify(value, (_key, item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) return item;
    return Object.fromEntries(Object.keys(item as Record<string, unknown>).sort()
      .map(key => [key, (item as Record<string, unknown>)[key]]));
  });
  return createHash("sha256").update(text).digest("hex");
}
