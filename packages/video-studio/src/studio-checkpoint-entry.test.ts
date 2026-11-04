import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expect, it } from "vitest";
import { videoRuntimeRoot } from "./runtime-root.js";

it("uses durable engine checkpoints through the normal VideoStudio entry while revisiting every approval", () => {
  const root = videoRuntimeRoot(import.meta.url);
  const directory = mkdtempSync(join(tmpdir(), "wl-checkpoint-entry-"));
  const file = join(directory, "entry.mts");
  writeFileSync(file, `
import { createRequire } from "node:module";
import { VideoStudio } from ${JSON.stringify(resolve(root, "packages/video-studio/src/studio.ts"))};
import { WorkloomLLMEngine } from ${JSON.stringify(resolve(root, "packages/video-studio/src/llm-adapter.ts"))};
const require = createRequire(${JSON.stringify(join(root, "package.json"))});
const entry = require("./vendor/supermickey/hyperreality-system/index.js");
const Original = entry.HyperrealitySystem;
const calls = [], gates = [], gateDocuments = [], records = new Map();
const key = request => [request.stage, request.inputSha256, request.dependencySha256].join("/");
const checkpoints = { load: async request => records.get(key(request)) ?? null,
 save: async checkpoint => { records.set(key(checkpoint), structuredClone(checkpoint)); } };
class NativeBoundaryFixture {
 creativeThemeGenerator = { generate: async intent => { calls.push("G2_THEME"); return { tasks: [{ theme: intent }] }; } };
 requirementDiscoveryEngine = { discover: async theme => { calls.push("G3_INSIGHT"); return { theme, scene: "本项目场景", confirmationStatus: { timestamp: "2026-11-04T00:00:00.000Z" } }; } };
 async _convertDiscoveryToRequirementList(discovery) { calls.push("G3_PROFILE"); discovery.boundProfile = "原生画像"; return { profile: "原生画像" }; }
 prdGenerator = { generate: async discovery => { calls.push("G4_PRD"); return { discovery, shotCount: 1 }; } };
 scriptEngine = { process: async (_intent, metadata) => { calls.push("SCRIPT"); metadata.scriptCompleted = true; return { adapted: { scenes: ["S1"] } }; } };
 productionEngine = { produce: async blueprint => { calls.push("PRODUCTION"); blueprint.produced = true; return { success: true, shots: [{ shotId: "S1", duration: 6, prompt: "原生产物" }] }; } };
 async _optimizeOpeningTitle(production) { calls.push("OPENING_TITLE"); production.shots[0].prompt += "，原生片头"; }
 async create(intent, metadata) {
  const approve = async (type, content) => { await globalThis.__HR_CONFIRMATION_HANDLER__({ type, content, runId: "native-fixture" }); };
  const theme = await this.creativeThemeGenerator.generate(intent);
  await approve("creative-theme", JSON.stringify(theme));
  const discovery = await this.requirementDiscoveryEngine.discover(theme);
  metadata.profile = (await this._convertDiscoveryToRequirementList(discovery)).profile;
  await approve("requirement-list", JSON.stringify(discovery));
  const prd = await this.prdGenerator.generate(discovery);
  await approve("prd", JSON.stringify(prd));
  const script = await this.scriptEngine.process(intent, metadata);
  const production = await this.productionEngine.produce(script.adapted);
  await this._optimizeOpeningTitle(production, { stages: {}, timing: Date.now() }, metadata);
  await approve("prompt", Original.prototype._generatePromptsReport.call(Original.prototype, production.shots));
  return { success: true, stages: {}, sideEffects: { scriptCompleted: metadata.scriptCompleted, produced: script.adapted.produced, profile: metadata.profile, prompt: production.shots[0].prompt } };
 }
}
entry.HyperrealitySystem = NativeBoundaryFixture;
try {
 const outputs = [];
 for (let run = 0; run < 2; run++) {
  const studio = new VideoStudio({ llm: new WorkloomLLMEngine({ baseUrl: "https://offline.invalid", apiKey: "fixture", model: "deepseek-flash" }),
   workDir: ${JSON.stringify(join(directory, "work"))}, checkpoints,
   onApproval: async request => { gates.push(request.gate); gateDocuments.push(request.contentMd); return { approved: true }; }, log: () => {} });
  outputs.push(await studio.runPreproduction({ projectId: "same-project", intent: "同一冻结需求", metadata: {} }));
 }
 console.log("RESULT " + JSON.stringify({ calls, gates, gateDocuments, outputs, records: records.size }));
} finally { entry.HyperrealitySystem = Original; }
`);
  try {
    const output = execFileSync(process.execPath, [resolve(root, "node_modules/tsx/dist/cli.mjs"), file], {
      cwd: root, encoding: "utf8", timeout: 30_000, maxBuffer: 3_000_000,
    });
    const line = output.split("\n").find(value => value.startsWith("RESULT "));
    expect(line).toBeDefined();
    const result = JSON.parse(line!.slice(7));
    expect(result.calls).toEqual(["G2_THEME", "G3_INSIGHT", "G3_PROFILE", "G4_PRD", "SCRIPT", "PRODUCTION", "OPENING_TITLE"]);
    expect(result.records).toBe(7);
    expect(result.gates).toEqual(["G2_THEME", "G3_INSIGHT", "G4_PRD", "G6_PROMPT",
      "G2_THEME", "G3_INSIGHT", "G4_PRD", "G6_PROMPT"]);
    expect(result.gateDocuments.slice(0, 4)).toEqual(result.gateDocuments.slice(4));
    expect(result.gateDocuments[3]).toContain("# 📝 提示词审核报告");
    expect(result.outputs).toEqual(Array.from({ length: 2 }, () => ({
      success: true, stages: {}, sideEffects: { scriptCompleted: true, produced: true, profile: "原生画像", prompt: "原生产物，原生片头" },
    })));
  } finally { rmSync(directory, { recursive: true, force: true }); }
}, 35_000);

it("keeps the real native G3 gate document byte-stable using the saved discovery timestamp", () => {
  const root = videoRuntimeRoot(import.meta.url);
  const directory = mkdtempSync(join(tmpdir(), "wl-checkpoint-markdown-"));
  const file = join(directory, "markdown.mts");
  writeFileSync(file, `
import { createRequire } from "node:module";
import { bindStudioEngineCheckpoints } from ${JSON.stringify(resolve(root, "packages/video-studio/src/studio-checkpoints.ts"))};
const require = createRequire(${JSON.stringify(join(root, "package.json"))});
const { RequirementDiscoveryEngine } = require("./vendor/supermickey/hyperreality-system/engines/requirement-discovery-engine.js");
const discovery = new RequirementDiscoveryEngine({ llmEngine: null });
const value = discovery._fastMode({ type: "纪录片", theme: "茶杯", duration_sec: 12, description: "杯沿渐亮", tone: "写实", visual_style: "自然光" });
value.confirmationStatus.timestamp = "2026-11-04T00:00:00.000Z";
const generate = async () => ({});
bindStudioEngineCheckpoints({ requirementDiscoveryEngine: discovery, creativeThemeGenerator: { generate },
 prdGenerator: { generate }, scriptEngine: { process: generate }, productionEngine: { produce: generate } },
 { load: async () => null, save: async () => {} }, "same frozen project", { assertActive() {}, onFailure(error) { throw error; } });
const first = discovery.generateMarkdown(value);
const NativeDate = Date;
globalThis.Date = class extends NativeDate { constructor(...args) { super(...(args.length ? args : ["2027-01-01T00:00:00.000Z"])); } };
try {
 const second = discovery.generateMarkdown(value);
 console.log("RESULT " + JSON.stringify({ equal: first === second, timestamp: second.includes("> 生成时间: 2026-11-04T00:00:00.000Z"), nextYear: second.includes("2027-01-01") }));
} finally { globalThis.Date = NativeDate; }
`);
  try {
    const output = execFileSync(process.execPath, [resolve(root, "node_modules/tsx/dist/cli.mjs"), file], {
      cwd: root, encoding: "utf8", timeout: 30_000, maxBuffer: 3_000_000,
    });
    const line = output.split("\n").find(value => value.startsWith("RESULT "));
    expect(JSON.parse(line!.slice(7))).toEqual({ equal: true, timestamp: true, nextYear: false });
  } finally { rmSync(directory, { recursive: true, force: true }); }
}, 35_000);
