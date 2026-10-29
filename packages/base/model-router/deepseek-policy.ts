import {
  DEEPSEEK_FLASH_MODEL_ID,
  TEXT_PRIMARY_POLICY_VERSION,
} from "./token-budget.js";

export type TextTaskType =
  | "deterministic"
  | "structured_generation"
  | "reasoning_review"
  | "critical_decision";

export type ThinkingMode = "enabled" | "disabled";
export type ThinkingEffort = "low" | "high" | "max";

export interface TextScenePolicy {
  type: TextTaskType;
  thinking: {
    type: ThinkingMode;
    effort?: ThinkingEffort;
  };
  responseFormat: "json_object" | "text";
  outputBudget: "maximum";
  generationReviewGroup: string;
  sameModelAs?: string;
  temperature?: number;
}

export interface TextScenePolicyOverride {
  type?: TextTaskType;
  thinking?: Partial<TextScenePolicy["thinking"]>;
  responseFormat?: TextScenePolicy["responseFormat"];
  outputBudget?: TextScenePolicy["outputBudget"];
  generationReviewGroup?: string;
  sameModelAs?: string;
  temperature?: number;
}

const DISABLED = Object.freeze({ type: "disabled" as const });
const LOW = Object.freeze({ type: "enabled" as const, effort: "low" as const });
const HIGH = Object.freeze({ type: "enabled" as const, effort: "high" as const });
const MAX = Object.freeze({ type: "enabled" as const, effort: "max" as const });

const deterministic = (responseFormat: TextScenePolicy["responseFormat"] = "text"): TextScenePolicy => ({
  type: "deterministic",
  thinking: DISABLED,
  responseFormat,
  outputBudget: "maximum",
  generationReviewGroup: "deterministic",
  temperature: 0.2,
});

const generation = (
  group: string,
  responseFormat: TextScenePolicy["responseFormat"] = "json_object",
  effort: ThinkingEffort = "high",
): TextScenePolicy => ({
  type: "structured_generation",
  thinking: { type: "enabled", effort },
  responseFormat,
  outputBudget: "maximum",
  generationReviewGroup: group,
});

const review = (
  group: string,
  generationScene: string,
  responseFormat: TextScenePolicy["responseFormat"] = "json_object",
  effort: ThinkingEffort = "high",
): TextScenePolicy => ({
  type: effort === "max" ? "critical_decision" : "reasoning_review",
  thinking: { type: "enabled", effort },
  responseFormat,
  outputBudget: "maximum",
  generationReviewGroup: group,
  sameModelAs: generationScene,
});

/**
 * Scene policy is the only source of thinking and output-format decisions.
 * Model identity is always `text.primary` -> `deepseek-flash`.
 */
export const TEXT_SCENE_POLICIES = Object.freeze({
  generic: generation("generic", "text", "high"),
  "intent-classify": deterministic("json_object"),
  "nl-translate": deterministic("text"),
  "comment-classify": deterministic("json_object"),
  "kb-extract": deterministic("json_object"),
  "schema-repair": deterministic("json_object"),
  "pipeline-route": deterministic("json_object"),
  "workloom.evaluation": {
    ...review("workloom.evaluation", "generic", "json_object", "high"),
    temperature: undefined,
  },

  "ask-synthesize": generation("ask", "text", "high"),
  "quest-plan": generation("quest", "json_object", "high"),
  "briefing": generation("briefing", "text", "high"),
  "review-reply": generation("reply", "text", "high"),
  "content-generate": generation("content", "text", "high"),
  "ceo-decision": generation("decision", "text", "high"),
  "ceo-deep-analysis": review("decision", "ceo-decision", "text", "high"),
  "fast-scan-report": review("scan", "quest-plan", "json_object", "high"),
  "geo-content": generation("geo", "json_object", "high"),
  "campaign-strategy": generation("campaign", "json_object", "high"),
  "lead-qualify": generation("lead", "json_object", "high"),
  "funnel-analyze": review("funnel", "generic", "json_object", "high"),

  preproduction: generation("video.preproduction", "json_object", "high"),
  "video.preproduction.plan": generation("video.preproduction", "json_object", "high"),
  "video.preproduction.structured": generation("video.preproduction", "json_object", "high"),
  "video.requirement.discovery": generation("video.preproduction", "json_object", "high"),
  "video.story.plan": generation("video.preproduction", "json_object", "high"),
  "video.prompt.synthesis": generation("video.preproduction", "json_object", "high"),
  "video.explainer.plan": generation("video.explainer", "json_object", "high"),
  "video.cover.design": generation("video.preproduction", "json_object", "high"),
  "video.pipeline.route": deterministic("json_object"),
  "video.deterministic": deterministic("json_object"),
  "video.data.extract": deterministic("json_object"),
  "video.schema.repair": deterministic("json_object"),
  "video.quality.producer-review": review(
    "video.preproduction",
    "video.preproduction.plan",
    "json_object",
    "high",
  ),
  "video.quality.plausibility-review": review(
    "video.preproduction",
    "video.preproduction.plan",
    "json_object",
    "high",
  ),
  "video.quality.continuity-review": review(
    "video.preproduction",
    "video.preproduction.plan",
    "json_object",
    "high",
  ),
  "video.quality.final-review": review(
    "video.preproduction",
    "video.preproduction.plan",
    "json_object",
    "max",
  ),
  "video.jev.evaluate": review(
    "video.preproduction",
    "video.preproduction.plan",
    "json_object",
    "high",
  ),

  "edit-probe": deterministic("json_object"),
  "edit-highlight-score": deterministic("json_object"),
  "edit-cutcheck": review("edit", "edit-script", "json_object", "high"),
  "edit-shot-understand": generation("edit", "json_object", "high"),
  "edit-media-index": deterministic("json_object"),
  "edit-intent-parse": deterministic("json_object"),
  "edit-ideate": generation("edit", "json_object", "high"),
  "edit-story-review": review("edit", "edit-ideate", "json_object", "high"),
  "edit-script": generation("edit", "json_object", "high"),
  "edit-caption": generation("edit", "json_object", "high"),
  "talk-emotion": deterministic("json_object"),
  "talk-cut": deterministic("json_object"),
  "talk-cut-ambiguous": review("talk-cut", "talk-cut", "json_object", "high"),
  "talk-annotate": generation("talk-annotate", "json_object", "high"),
} as const satisfies Record<string, TextScenePolicy>);

export type TextScene = keyof typeof TEXT_SCENE_POLICIES;

const SCENE_ALIASES: Readonly<Record<string, TextScene>> = Object.freeze({
  "director-review": "video.quality.producer-review",
  "prompt-fusion": "video.prompt.synthesis",
  "producer-review": "video.quality.producer-review",
  "pipeline-route": "video.pipeline.route",
  "edit-copy": "edit-script",
  "edit-post": "edit-caption",
  "edit-retention": "edit-story-review",
});

export function resolveTextScenePolicy(
  scene: string,
  override: TextScenePolicyOverride = {},
): TextScenePolicy & { scene: string; modelKey: "text.primary"; modelId: typeof DEEPSEEK_FLASH_MODEL_ID } {
  const mapped = (SCENE_ALIASES[scene] ?? (scene in TEXT_SCENE_POLICIES ? scene : "generic")) as TextScene;
  const base = TEXT_SCENE_POLICIES[mapped] as TextScenePolicy;
  const policy: TextScenePolicy = {
    ...base,
    ...override,
    thinking: { ...base.thinking, ...(override.thinking ?? {}) },
    outputBudget: "maximum",
  };
  if (!["enabled", "disabled"].includes(policy.thinking.type)) {
    throw new Error(`MODEL_THINKING_POLICY_INVALID: ${scene}`);
  }
  if (policy.thinking.type === "enabled"
    && !["low", "high", "max"].includes(policy.thinking.effort ?? "")) {
    throw new Error(`MODEL_THINKING_POLICY_INVALID: ${scene}`);
  }
  if (policy.sameModelAs && policy.generationReviewGroup
    && TEXT_SCENE_POLICIES[policy.sameModelAs as TextScene]?.generationReviewGroup
    && TEXT_SCENE_POLICIES[policy.sameModelAs as TextScene].generationReviewGroup
      !== policy.generationReviewGroup) {
    throw new Error("MODEL_REVIEW_MODEL_MISMATCH");
  }
  return {
    ...policy,
    scene,
    modelKey: "text.primary",
    modelId: DEEPSEEK_FLASH_MODEL_ID,
  };
}

export function textScenePolicyReceipt(policy: ReturnType<typeof resolveTextScenePolicy>) {
  return {
    schemaVersion: "workloom.model-policy/v1",
    policyVersion: TEXT_PRIMARY_POLICY_VERSION,
    scene: policy.scene,
    type: policy.type,
    thinking: { ...policy.thinking },
    responseFormat: policy.responseFormat,
    outputBudget: policy.outputBudget,
    fallback: "same-model-only",
    generationReviewGroup: policy.generationReviewGroup,
    sameModelAs: policy.sameModelAs ?? null,
    modelKey: policy.modelKey,
    modelId: policy.modelId,
  };
}
