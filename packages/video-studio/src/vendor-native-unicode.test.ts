import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const require = createRequire(import.meta.url);
const { PromptFusionAgent } = require(resolve(root,
  "vendor/supermickey/hyperreality-system/engines/production-engine/agents/prompt-fusion-agent.js"));
const unicodeLength = (value: string) => Array.from(value).length;
const unpairedSurrogate = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u;

describe("native PromptFusion Unicode character limits", () => {
  it.each([
    ["3000 supplementary Han", "𠮷".repeat(3000)],
    ["one complete field", `【场景】${"𠮷".repeat(2600)}`],
    ["multiple complete fields", `【场景】${"𠮷".repeat(1400)} | 【动作】${"𠮷".repeat(1400)}`],
    ["mixed text exactly at the limit", "汉𠮷A，\n".repeat(600)],
    ["emoji and supplementary Han", "🎬𠮷汉".repeat(1000)],
  ])("retains %s unchanged below or at 3000 characters", (_label, input) => {
    const agent = new PromptFusionAgent({ semanticRefinement: false });
    expect(unicodeLength(input)).toBeLessThanOrEqual(3000);
    expect(agent._countChars(input)).toBe(unicodeLength(input));
    expect(agent._truncateStandardPrompt(input)).toBe(input);
  });

  it.each([
    [3000, "𠮷".repeat(3001)],
    [3000, `【场景】${"𠮷".repeat(3500)}`],
    [64, "𠮷".repeat(65)],
    [1200, `【场景】${"汉𠮷🎬".repeat(500)}`],
  ])("truncates a single field to the configured %i Unicode characters", (limit, input) => {
    const agent = new PromptFusionAgent({ maxPromptLength: limit, semanticRefinement: false });
    const result = agent._truncateStandardPrompt(input);
    expect(unicodeLength(result)).toBe(limit);
    expect(result).not.toMatch(unpairedSurrogate);
    expect(input.startsWith(result)).toBe(true);
  });

  it("retains a complete multi-field prompt below a custom limit", () => {
    const agent = new PromptFusionAgent({ maxPromptLength: 1000, semanticRefinement: false });
    const input = `【场景】${"𠮷".repeat(450)} | 【动作】${"🎬".repeat(450)}`;
    expect(agent._truncateStandardPrompt(input)).toBe(input);
  });

  it.each([3000, 800])("keeps field labels and weights within the full %i character budget", limit => {
    const agent = new PromptFusionAgent({ maxPromptLength: limit, semanticRefinement: false });
    const input = `【场景】${"𠮷".repeat(1800)} | 【动作】${"🎬".repeat(1800)}`;
    const output = agent._truncateStandardPrompt(input);
    expect(unicodeLength(output)).toBeLessThanOrEqual(limit);
    expect(output).toContain("【场景】");
    expect(output).toContain("【动作】");
    expect(output).not.toMatch(unpairedSurrogate);
  });

  it("preserves protected dialogue while compressing other fields", () => {
    const agent = new PromptFusionAgent({ maxPromptLength: 500, semanticRefinement: false });
    const dialogue = `【台词】${"𠮷".repeat(100)}`;
    const output = agent._truncateStandardPrompt(`${dialogue} | 【场景】${"🎬".repeat(1000)}`);
    expect(output).toContain(dialogue);
    expect(unicodeLength(output)).toBeLessThanOrEqual(500);
    expect(output).not.toMatch(unpairedSurrogate);
  });

  it.each([`【台词】${"𠮷".repeat(50)} | 【场景】实景`, `【台词】${"𠮷".repeat(50)}`])("rejects a cap that cannot contain protected content", input => {
    const agent = new PromptFusionAgent({ maxPromptLength: 50, semanticRefinement: false });
    expect(() => agent._truncateStandardPrompt(input)).toThrow("PROMPT_PROTECTED_FIELDS_EXCEED_LIMIT");
  });

  it("prefers a closed sentence using its Unicode position", () => {
    const agent = new PromptFusionAgent({ semanticRefinement: false });
    const sentence = `${"𠮷".repeat(70)}。`;
    expect(agent._safeTruncateSentence(sentence + "汉".repeat(70), 100)).toBe(sentence);
  });

  it("removes an unclosed parenthesis without splitting the preceding supplementary text", () => {
    const agent = new PromptFusionAgent({ semanticRefinement: false });
    const prefix = "𠮷".repeat(50);
    const result = agent._safeTruncateSentence(`${prefix}（${"汉".repeat(100)}）`, 80);
    expect(result).toBe(prefix);
    expect(result).not.toMatch(unpairedSurrogate);
  });

  it.each([[2600, "transition"], [2900, "transition"], [2600, "opening"]] as const)(
    "enforces numbered final text after %i scene characters in native %s process", async (length, sceneType) => {
    const agent = new PromptFusionAgent({ semanticRefinement: false });
    const source = "𠮷".repeat(length);
    const fields = Object.fromEntries([
      "director_instruction", "constraint", "baseline", "scene", "lighting", "composition", "color_palette",
      "depth_of_field", "camera_movement", "character", "costume", "makeup", "action", "props", "portraits",
      "dialogue", "timeline", "mood", "pacing", "transition", "audio", "negative", "bright_constraint",
      "character_constraint", "consistency",
    ].map(key => [key, key === "scene" ? source : "真实"]));
    // Control the model transport and unrelated consistency verdict. The native
    // process, field completion, refiner, assembly and truncation all execute.
    agent._callLLM = vi.fn(async (prompt: string) => ({ degraded: false,
      result: prompt.includes("镜头补齐任务") ? { fields: {} } : { shots: [{ shotId: "S1", fields }] } }));
    agent.consistencyChecker = { check: () => ({ valid: true, warningCount: 0 }) };
    const opening = sceneType === "opening" ? Object.fromEntries([
      "title_content", "subtitle_content", "title_animation", "title_font_design", "opening_audio_design",
    ].map(key => [key, "片头设计".repeat(40)])) : {};
    const result = await agent.process([{ shotId: "S1", sceneType, scene: source, duration: 5, ...opening }],
      { config: { aspectRatio: "9:16" }, character_system: { characters: [] } });
    const output = result.shots[0];
    expect(unicodeLength(output.prompt)).toBeLessThanOrEqual(3000);
    if (length === 2600 && sceneType !== "opening") expect(output.prompt).toContain(source);
    if (sceneType === "opening") {
      for (const label of ["主标题内容", "副标题内容", "标题动画设计", "标题字体设计", "开场音频设计"]) {
        expect(output.prompt).toContain(`【${label}】`);
      }
    }
    expect(output.prompt.length).toBeGreaterThan(3000);
    expect(output.promptCharCount).toBe(unicodeLength(output.prompt));
    expect(output.prompt).not.toMatch(unpairedSurrogate);
    expect(result.degraded).toBe(false);
    expect(agent._callLLM).toHaveBeenCalledTimes(2);
  });
});
