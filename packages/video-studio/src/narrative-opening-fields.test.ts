import { createRequire } from "node:module";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { videoRuntimeRoot } from "./runtime-root.js";
import { applyNarrativeFinalPromptContract, installVendorNarrativePromptReviewBridge, normalizeNarrativePromptsForReview,
  type NarrativePromptReviewPolicy } from "./vendor-compat.js";
import { unicodeLength } from "./unicode-text.mjs";

// T-2026-1105-9003: portable synthetic fixture; no customer request or local archive dependency.
const fixture: Record<string, unknown> = {
  "shotId": "S1",
  "sceneType": "opening",
  "duration": 4,
  "prompt": "01.【场景】工作室内展示器物成形\n02.【动作】演员甲转动器物",
  "camera_movement": "固定机位，三脚架锁死，全镜零推拉零横移零变焦",
  "shotSize": "中景",
  "character": "演员甲",
  "makeup": "自然写实妆",
  "action": "演员甲转动器物",
  "dialogue": "无",
  "title_content": "器物成形",
  "subtitle_content": "材料与工序",
  "title_animation": "主标题从画面下方向上进入后停稳，副标题稍后淡入，末段共同静止。",
  "title_font_design": "深灰色无衬线字体，保留清晰字距，不添加其他图形。",
  "opening_audio_design": "器物接触工作台的轻响与标题进入同步，结尾保留工作室环境声。",
  "_workloomPromptReviewPolicy": {
    "noDialogue": true,
    "noMusic": true,
    "noCharacters": false,
    "noAnimals": true,
    "noTitles": false,
    "maxLength": 3000,
    "durationSeconds": 4,
    "aspectRatio": "9:16",
    "resolution": "1080x1920",
    "characterNames": [
      "演员甲"
    ],
    "characterPortraits": [],
    "projectScene": "白天工作室的成形工作台",
    "projectLighting": "窗边自然柔光",
    "projectProps": [
      "器物",
      "工作台"
    ],
    "projectActions": [
      "演员甲转动器物"
    ]
  }
};
const openingFields = [
  ["title_content", "主标题内容"], ["subtitle_content", "副标题内容"],
  ["title_animation", "标题动画设计"], ["title_font_design", "标题字体设计"],
  ["opening_audio_design", "开场音频设计"],
] as const;
const labels = (text: string) => [...text.matchAll(/^\s*\d+\.【([^】]+)】/gmu)].map(match => match[1]);
function project(source = structuredClone(fixture), overrides: Partial<NarrativePromptReviewPolicy> = {}) {
  const policy = { ...(source._workloomPromptReviewPolicy as NarrativePromptReviewPolicy), ...overrides };
  source._workloomPromptReviewPolicy = policy;
  return normalizeNarrativePromptsForReview([source], policy)[0]!;
}
function report(row: Record<string, unknown>) {
  const root = videoRuntimeRoot(import.meta.url);
  const require = createRequire(join(root, "package.json"));
  const { HyperrealitySystem } = require(join(root, "vendor/supermickey/hyperreality-system/index.js"));
  const system = Object.create(HyperrealitySystem.prototype);
  const release = installVendorNarrativePromptReviewBridge();
  try { return system._generatePromptsReport([row]) as string; } finally { release(); }
}
function reportedCount(body: string, id: string) {
  const row = body.split("\n").find(line => line.startsWith(`| ${id} |`));
  return Number(row?.split("|")[4]?.match(/(\d+)\//u)?.[1]);
}

describe("T-2026-1105-9003 native opening fields at G6", () => {
  it("keeps all five native opening values in consecutive fields and counts that same report body", () => {
    const source = structuredClone(fixture);
    source.prompt = String(source.prompt) + openingFields.map(([key, label], index) =>
      `\n${String(index + 3).padStart(2, "0")}.【${label}】${source[key]}`).join("");
    const before = JSON.stringify(source);
    const row = project(source);
    const prompt = String(row.prompt);
    expect(labels(prompt).length).toBeGreaterThanOrEqual(30);
    expect(unicodeLength(prompt)).toBeLessThanOrEqual(3000);
    expect([...prompt.matchAll(/^\s*(\d+)\.【/gmu)].map(match => Number(match[1])))
      .toEqual(Array.from({ length: labels(prompt).length }, (_, index) => index + 1));
    for (const [key, label] of openingFields) expect(prompt).toContain(`【${label}】${fixture[key]}`);
    expect(JSON.stringify(source)).toBe(before);
    const body = report(row);
    const rendered = /```markdown\n([\s\S]*?)\n```/u.exec(body)?.[1] ?? "";
    expect(rendered).toBe(prompt);
    expect(reportedCount(body, "S1")).toBe(labels(rendered).length);
  });

  it("preserves native values supplied in fields without counting absent top-level metadata", () => {
    const source = structuredClone(fixture);
    source.fields = Object.fromEntries(openingFields.map(([key]) => [key, source[key]]));
    for (const [key] of openingFields) delete source[key];
    const row = project(source);
    for (const [key, label] of openingFields) expect(String(row.prompt)).toContain(`【${label}】${fixture[key]}`);
    expect(reportedCount(report(row), "S1")).toBe(labels(String(row.prompt)).length);
  });

  it("does not count title metadata or append opening fields on a content shot", () => {
    const row = project({ ...structuredClone(fixture), shotId: "S2", sceneType: "content" });
    expect(labels(String(row.prompt)).length).toBeGreaterThanOrEqual(25);
    for (const [, label] of openingFields) expect(String(row.prompt)).not.toContain(`【${label}】`);
    expect(reportedCount(report(row), "S2")).toBe(labels(String(row.prompt)).length);
  });

  it("keeps noTitles output free of opening fields and metadata", () => {
    const row = project(structuredClone(fixture), { noTitles: true });
    for (const [key, label] of openingFields) {
      expect(row[key]).toBeUndefined();
      expect(String(row.prompt)).not.toContain(`【${label}】`);
    }
    expect(reportedCount(report(row), "S1")).toBe(labels(String(row.prompt)).length);
  });

  it("allows Phase3 before native title generation and fails only at the final G6 projection", () => {
    const source = structuredClone(fixture);
    for (const [key] of openingFields) delete source[key];
    const policy = source._workloomPromptReviewPolicy as NarrativePromptReviewPolicy;
    const phase3 = applyNarrativeFinalPromptContract(source, { ...policy, canonicalize: true });
    for (const [, label] of openingFields) expect(String(phase3.prompt)).not.toContain(`【${label}】`);
    expect(() => normalizeNarrativePromptsForReview([phase3], policy))
      .toThrow(/FINAL_PROMPT_OPENING_FIELDS_MISSING/u);
  });

  it.each(openingFields)("fails on a missing real native %s rather than inventing a value", (key) => {
    const source = structuredClone(fixture);
    delete source[key];
    expect(() => project(source)).toThrow(/FINAL_PROMPT_OPENING_FIELDS_MISSING/u);
  });

  it("retains the hard Unicode limit when a real opening field cannot fit", () => {
    const source = { ...structuredClone(fixture), title_animation: "𠮷".repeat(3000) };
    expect(() => project(source)).toThrow(/FINAL_PROMPT_SOURCE_CAPACITY_EXCEEDED/u);
  });
});
