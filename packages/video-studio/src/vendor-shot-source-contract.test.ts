import { createRequire } from "node:module";
import { resolve } from "node:path";
import { expect, it, vi } from "vitest";
import { videoRuntimeRoot } from "./runtime-root.js";

type Row = Record<string, unknown>;
const require = createRequire(import.meta.url);
const { PromptFusionAgent } = require(resolve(videoRuntimeRoot(import.meta.url),
  "vendor/supermickey/hyperreality-system/engines/production-engine/agents/prompt-fusion-agent.js"));
const keys = ["director_instruction", "constraint", "baseline", "scene", "lighting", "composition", "color_palette",
  "depth_of_field", "camera_movement", "character", "costume", "makeup", "action", "props", "portraits", "dialogue",
  "timeline", "mood", "pacing", "transition", "audio", "negative", "bright_constraint", "character_constraint", "consistency"];

function source() {
  const blueprint: Row = { _originalStoryText: "演员甲与协作员乙在工作台完成可见交接，操作结束后收好帽子。",
    _workloomProductionRepairFeedback: "已核实诊断：保留交接顺序，具体动作仍由原生作者编写。" };
  blueprint.circular = blueprint; // Attached context must never enter the selected per-shot packet.
  return { shotId: "N2", sceneType: "action", duration: 6, scene: "室内工作台与两条并行通道。",
    sceneFunction: "交接必须完整可辨，演员甲先放稳箱子，协作员乙接住后再移开。",
    action: `演员甲和协作员乙按顺序操作，${"手部保持可辨𠮷。".repeat(300)}\n末段才取下帽子，原文标记$&保持完整。`,
    characters: ["actor-a", "collaborator-b"], character: "演员甲位于台前，协作员乙位于另一侧。",
    characterRef: "actor-a:registered/front.png", characterDescs: ["演员甲固定身份外观", "协作员乙为源场景已声明参与者"],
    costume: "灰色工作外套，结束后把帽子握在左手。", makeup: "自然肤色，保持原发型。",
    timeline: [{ time: "0-2", action: "箱子放稳" }, { time: "2-4", action: "对方接住" }, { time: "4-6", action: "取下帽子" }],
    visualDirection: { shot_type: "medium", camera_movement: "固定机位", lighting: "窗边柔光" },
    cameraString: "固定中景，机位全程不动。", lightingString: "左侧窗光5600K。", audio: "箱子接触台面的轻响。",
    _skillContext: "风格建议：以静止与克制表现等待。", _blueprint: blueprint };
}

function contract(prompt: string): Row {
  const text = /## 本镜源合同（原文字段）\n([^\n]+)/u.exec(prompt)?.[1];
  expect(text, "all native author paths must carry the source packet").toBeTruthy();
  return JSON.parse(text!);
}

it.each(["normal", "fill", "minimal"])("carries full per-shot action and role changes through the %s native author input", mode => {
  const shot = source(); const before = { ...shot, _blueprint: undefined };
  const agent = Object.create(PromptFusionAgent.prototype);
  const profiles = [{ name: "演员甲", description: "本项目登记外观。" }];
  const prompt = mode === "normal" ? agent._buildBatchPrompt([shot], "9:16", profiles, shot._blueprint)
    : mode === "fill" ? agent._buildFillPrompt(shot, ["action"], { action: "旧生成字段只供风格参考。" }, "9:16", profiles, shot._blueprint)
      : agent._buildMinimalContext(shot, "9:16", profiles, shot._blueprint);
  const packet = contract(prompt);
  for (const key of ["shotId", "duration", "scene", "sceneFunction", "action", "characters", "character", "characterRef",
    "characterDescs", "costume", "makeup", "timeline", "visualDirection", "cameraString", "lightingString", "audio"] as const) {
    expect(packet[key], key).toEqual(shot[key]);
  }
  expect(packet).not.toHaveProperty("_blueprint"); expect(packet).not.toHaveProperty("_skillContext");
  expect(prompt).toContain("原始叙事职责与动作顺序优先于技能示例");
  expect(prompt).toContain("不得将明确动作改成静止、已完成状态或画外完成");
  expect(prompt).toContain("身份锚点不等于本镜总人数上限");
  expect(prompt).toContain("已核实诊断：保留交接顺序");
  expect({ ...shot, _blueprint: undefined }).toEqual(before);
});

it("retains the original source during the real fill clone cleanup without treating it as newly authored output", async () => {
  const shot = source(); const beforeAction = shot.action;
  // Avoid serializing the deliberate circular blueprint in the legacy fill clone.
  shot._blueprint = { _workloomProductionRepairFeedback: "原有修复反馈保持完整。" };
  const existing = Object.fromEntries(keys.map(key => [key, key === "action" ? "" : "旧生成字段。".repeat(40)]));
  const original = { ...shot, fields: existing };
  const before = structuredClone(original);
  const agent = Object.create(PromptFusionAgent.prototype);
  const authoredAction = "这是本轮原生模型返回的交接动作。".repeat(12);
  const prompts: string[] = [];
  const author = vi.fn(async (prompt: string) => {
    prompts.push(prompt);
    return { result: { fields: Object.fromEntries(keys.map(key => [key,
      key === "action" ? authoredAction : "本轮模型独立输出的完整字段。".repeat(30)])) }, degraded: false };
  });
  const assemble = vi.fn(async (slim: Row, fields: Row, degraded: boolean) => ({ slim, fields, degraded }));
  Object.assign(agent, { _callLLM: author, _buildShotResult: assemble });
  const result = await agent._fillMissingFieldsWithRetry(original, "9:16", []);
  expect(author).toHaveBeenCalledOnce();
  expect(contract(prompts[0]!).action).toBe(beforeAction);
  expect(contract(prompts[0]!).sceneFunction).toBe(shot.sceneFunction);
  expect(result.slim).not.toHaveProperty("action");
  expect(result.fields.action).toBe(authoredAction);
  expect(result.fields.action).not.toBe(beforeAction);
  expect(original).toEqual(before);
});

it("keeps old source data out of completeness fallback when the independent author omits the requested action", async () => {
  const original = source(); original._blueprint = {};
  const fields: Row = Object.fromEntries(keys.map(key => [key, key === "action" ? "" : "完整现有字段。".repeat(50)]));
  const slim = { shotId: original.shotId, sceneType: "action", fields };
  const agent = Object.create(PromptFusionAgent.prototype);
  const fallback = vi.fn(async () => ({}));
  let prompt = "";
  Object.assign(agent, { _batchMinimalLLMDegradation: fallback, _defaultFieldValue: vi.fn(() => "未核实规则补齐") });
  agent._callLLM = vi.fn(async (text: string) => {
    prompt = text;
    return { result: { fields: {} }, degraded: false };
  });
  const result = await agent._ensureFieldCompleteness(slim, fields, "9:16", [], null, {}, original);
  expect(contract(prompt).action).toBe(original.action);
  expect(fallback).toHaveBeenCalledOnce();
  expect(result.usedRuleFallback).toBe(true);
  expect(result.fields.action).toBe("未核实规则补齐");
  expect(result.fields.action).not.toBe(original.action);
});
