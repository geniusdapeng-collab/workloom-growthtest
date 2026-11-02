import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  healPromptContract,
  deriveNarrativeShotDirection,
  extractNarrativeActions,
  inferNarrativeCharacters,
  inferNarrativeProps,
  pairRiskMitigations,
  normalizeNarrativePrdContract,
  normalizeNarrativeRequirementMarkdown,
  normalizeNarrativeDiscovery,
  repairPhase3FusionRows,
  renderPrdContractMarkdown,
  applyNarrativeFinalPromptContract,
  normalizeNarrativePromptsForReview,
  projectNarrativeActionSequence,
  renderPreproductionAuditReport,
  promptFieldText,
  rebuildPromptsFromFields,
} from "./vendor-compat.js";
import { inspectFinalShotContract } from "./final-shot-contract.js";

/**
 * 定妆照绑定桥的端到端断言必须在**真实 node 进程**里跑：
 * vendor 是 CJS（vitest 的 ESM 转换会误处理），桥本身也用 createRequire 加载 vendor 原型。
 * 子进程内断言三件事：
 *   1. 桥把索引里四角度齐备的角色回填成 `characterRef`（渲染引擎认得的形状）；
 *   2. 空 `portraits: []` 不再抢占 characterRef（真机 2026-09-21 的 0 提交根因）；
 *   3. vendor 自己的绑定清单校验（render-submitter-core.validateManifest）因此通过。
 */
const here = resolve(fileURLToPath(import.meta.url), "..");
const repoRoot = resolve(here, "../../..");

/** tsx CLI（pnpm 隔离布局下按实际安装版本解析，不写死版本号） */
function resolveTsxCli(): string {
  const pnpmDir = join(repoRoot, "node_modules/.pnpm");
  const candidates = readdirSync(pnpmDir)
    .filter((name) => name.startsWith("tsx@"))
    .map((name) => join(pnpmDir, name, "node_modules/tsx/dist/cli.mjs"))
    .filter((file) => existsSync(file));
  if (candidates.length === 0) throw new Error("未找到 tsx CLI（node_modules/.pnpm/tsx@*）");
  return candidates.sort().pop()!;
}

function runInChild(script: string): Record<string, unknown> {
  const dir = mkdtempSync(join(tmpdir(), "wl-bridge-"));
  const file = join(dir, "probe.mts");
  writeFileSync(file, script, "utf8");
  const out = execFileSync(
    process.execPath,
    [resolveTsxCli(), file],
    { encoding: "utf8", timeout: 90_000, cwd: repoRoot }
  );
  const line = out.trim().split("\n").filter((l) => l.startsWith("RESULT ")).pop();
  if (!line) throw new Error(`子进程未输出结果：${out.slice(-400)}`);
  return JSON.parse(line.slice("RESULT ".length)) as Record<string, unknown>;
}

const exactPortraitFixture = `
import { createRequire } from "node:module";
import { mkdtempSync, writeFileSync, readFileSync, symlinkSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { createHash } from "node:crypto";
import { createPortraitRuntime, REQUIRED_ANGLES } from ${JSON.stringify(resolve(here, "portrait-runtime.ts"))};
import { installVendorPortraitBindingBridge } from ${JSON.stringify(resolve(here, "vendor-compat.ts"))};
const require = createRequire(${JSON.stringify(join(repoRoot, "package.json"))});
const { RenderingEngine } = require(${JSON.stringify(join(repoRoot, "vendor/supermickey/hyperreality-system/engines/rendering-engine/rendering-engine.js"))});
const { RenderSubmitterCore } = require(${JSON.stringify(join(repoRoot, "vendor/supermickey/scripts/render-submitter-core.js"))});
const root = mkdtempSync(join(tmpdir(), "wl-exact-portrait-"));
// Keep the real guardian and its persistence logic; relocate only its fixed vendor output path.
const { PromptGuardian } = require(${JSON.stringify(join(repoRoot, "vendor/supermickey/scripts/prompt-guardian.js"))});
const guardianSave = PromptGuardian.prototype._saveLog;
PromptGuardian.prototype._saveLog = function(...args) { this.logPath = join(root, "guardian-log.json"); return guardianSave.apply(this, args); };
const charactersDir = join(root, "characters", "PROJECT");
let calls = 0;
const runtime = createPortraitRuntime({ workDir: root, projectId: "PROJECT", apiKey: "test-only-key", model: "test-model", retries: 0, fetchImpl: async (url) => {
  if (String(url).includes("/images/generations")) { calls++; return new Response(JSON.stringify({ data: [{ url: "https://cdn.example.invalid/out" }] })); }
  return new Response(new Uint8Array(4096).fill(calls));
} });
for (const version of ["旧蓝色长裙", "新红色外套"]) for (const angle of ["front_full", "three_quarter", "face_closeup", "side_full"]) {
  await runtime.apiRender({ characterId: "guest", characterName: "住客", characterDescription: "三十岁女性，齐肩黑发，" + version, angle, prompt: version });
}
let index = runtime.snapshot();
const baseline = structuredClone(index);
const originalManifest = RenderingEngine.prototype._generateBindingManifest;
const originalPayload = RenderSubmitterCore.prototype.buildPayload;
const uninstall = installVendorPortraitBindingBridge({ resolveIndex: () => index, log: () => undefined });
const engine = new RenderingEngine({ charactersDir, outputDir: root, apiKey: "test-only-key", endpoint: "test-model" });
const core = new RenderSubmitterCore({ charactersDir, endpoint: "test-model" });
const prompt = () => ({ shotId: "SC-01", prompt: "guest 住客穿红色外套，站在有光照的房间中央，保持自然站姿，镜头平稳拍摄人物正面，背景清晰，没有额外角色，台词：今天我们来到这里。", duration: 6, portraits: [], characterRef: "" });
const errorOf = async (fn) => { try { await fn(); return "MISSED"; } catch (error) { return String(error.message); } };
`;

describe("当前定妆照版本的真实消费链", () => {
  it("真实runtime两版四角度→manifest→provider payload只消费索引最新字节，历史目录顺序无效", () => {
    const result = runInChild(exactPortraitFixture + `
for (const angle of REQUIRED_ANGLES) writeFileSync(join(index.characters.guest.dir, "portraits", "000-old-" + angle + ".png"), Buffer.alloc(4096, 99));
const card = prompt();
await engine.render([card], { dryRun: true });
const shot = engine._convertToShotFormat(card);
const manifest = await engine._generateBindingManifest([card]);
const check = core.validateManifest(manifest);
const payload = core.buildPayload(shot, manifest);
const actual = payload.content.filter(item => item.type === "image_url").map(item => createHash("sha256").update(Buffer.from(item.image_url.url.split(",")[1], "base64")).digest("hex"));
const expected = REQUIRED_ANGLES.map(angle => index.characters.guest.receipts[angle].output.sha256);
const paths = REQUIRED_ANGLES.map(angle => manifest.characters.guest.portraits[angle]);
const expectedPaths = REQUIRED_ANGLES.map(angle => relative(charactersDir, index.characters.guest.files[angle]));
uninstall();
console.log("RESULT " + JSON.stringify({ calls, valid: check.valid, actual, expected, paths, expectedPaths, selection: manifest.selection, restored: RenderingEngine.prototype._generateBindingManifest === originalManifest && RenderSubmitterCore.prototype.buildPayload === originalPayload }));
`);
    expect(result.calls).toBe(8); expect(result.valid).toBe(true);
    expect(result.actual).toEqual(result.expected); expect(result.paths).toEqual(result.expectedPaths);
    expect(result.selection).toBe("exact-current-index-files"); expect(result.restored).toBe(true);
  }, 90_000);

  it("篡改、缺收据、symlink、越界和重复角度均不能进入vendor提交", () => {
    const result = runInChild(exactPortraitFixture + `
const rejected = [];
const front = index.characters.guest.files.front; const originalBytes = readFileSync(front);
writeFileSync(front, Buffer.alloc(originalBytes.length, 99)); rejected.push(await errorOf(() => engine.render([prompt()], { dryRun: true }))); writeFileSync(front, originalBytes);
delete index.characters.guest.receipts.front; rejected.push(await errorOf(() => engine._generateBindingManifest([prompt()]))); index = structuredClone(baseline);
const external = join(root, "external.png"); writeFileSync(external, originalBytes); unlinkSync(front); symlinkSync(external, front); rejected.push(await errorOf(() => engine._generateBindingManifest([prompt()]))); unlinkSync(front); writeFileSync(front, originalBytes);
index.characters.guest.files.front = external; rejected.push(await errorOf(() => engine._generateBindingManifest([prompt()]))); index = structuredClone(baseline);
index.characters.guest.files.side = front; index.characters.guest.receipts.side = { ...index.characters.guest.receipts.front, angle: "side" }; rejected.push(await errorOf(() => engine._generateBindingManifest([prompt()]))); index = structuredClone(baseline);
index.characters.guest.receipts.front.kind = "product"; rejected.push(await errorOf(() => engine._generateBindingManifest([prompt()]))); index = structuredClone(baseline);
rejected.push(await errorOf(() => engine._generateBindingManifest([prompt(), prompt()])));
uninstall(); console.log("RESULT " + JSON.stringify({ rejected }));
`);
    expect(result.rejected).toHaveLength(7);
    for (const error of result.rejected as string[]) expect(error).toMatch(/PORTRAIT_BINDING_(INVALID|RECEIPT_INVALID)/);
  }, 90_000);

  it("清单生成后改索引/产物/清单均阻断，最终payload字节也再次核对", () => {
    const result = runInChild(exactPortraitFixture + `
const card = prompt(); const manifest = await engine._generateBindingManifest([card]); const shot = engine._convertToShotFormat(card);
const front = index.characters.guest.files.front; const bytes = readFileSync(front);
writeFileSync(front, Buffer.alloc(bytes.length, 99));
const tampered = await errorOf(() => core.buildPayload(shot, manifest)); writeFileSync(front, bytes);
index.characters.guest.name = "新角色版本";
const changedIndex = await errorOf(() => engine._generateBindingManifest([card]));
const stalePayload = await errorOf(() => core.buildPayload(shot, manifest)); index = structuredClone(baseline);
const forged = structuredClone(manifest); forged.characters.guest.portraits.front = "changed.png";
const changedManifest = await errorOf(() => core.buildPayload(shot, forged));
// Inject a downstream body mutation after the real vendor builder's reads; the bridge must catch actual data bytes.
const originalRead = require("fs").readFileSync; let changedRead = false;
require("fs").readFileSync = function(file, ...args) {
  const value = originalRead.call(this, file, ...args);
  if (file === front && new Error().stack.includes("render-submitter-core.js")) { changedRead = true; return Buffer.alloc(bytes.length, 99); }
  return value;
};
const changedBody = await errorOf(() => core.buildPayload(shot, manifest)); require("fs").readFileSync = originalRead;
uninstall(); console.log("RESULT " + JSON.stringify({ tampered, changedIndex, stalePayload, changedManifest, changedBody, changedRead }));
`);
    expect(result.tampered).toMatch(/PORTRAIT_BINDING_RECEIPT_INVALID/);
    for (const key of ["changedIndex", "stalePayload", "changedManifest", "changedBody"]) expect(result[key]).toMatch(/PORTRAIT_BINDING_CHANGED/);
    expect(result.changedRead).toBe(true);
  }, 90_000);
});

describe("定妆照绑定桥（真机故障复现 → 修复）", () => {
  it("角色四角度齐备后，vendor 绑定清单校验通过（不再 BINDING_MANIFEST_INVALID）", () => {
    const workDir = mkdtempSync(join(tmpdir(), "wl-chars-"));
    const key = "guest";
    const portraitsDir = join(workDir, key, "portraits");
    mkdirSync(portraitsDir, { recursive: true });
    const files: Record<string, string> = {};
    for (const angle of ["front", "threeQuarter", "closeup", "side"]) {
      const file = join(portraitsDir, `${key}-${angle}.png`);
      writeFileSync(file, Buffer.alloc(2048, 9));
      files[angle] = file;
    }

    const script = `
import { createRequire } from "node:module";
import { installVendorPortraitBindingBridge } from ${JSON.stringify(resolve(here, "vendor-compat.ts"))};

const require = createRequire(${JSON.stringify(join(repoRoot, "package.json"))});
const engineMod = require(${JSON.stringify(join(repoRoot, "vendor/supermickey/hyperreality-system/engines/rendering-engine/rendering-engine.js"))});
const { RenderSubmitterCore } = require(${JSON.stringify(join(repoRoot, "vendor/supermickey/scripts/render-submitter-core.js"))});

const index = {
  schemaVersion: "workloom.portrait-index/v1",
  projectId: "VID-9999",
  generatedAt: new Date().toISOString(),
  characters: {
    ${key}: {
      kind: "character", id: "住客", name: "住客", dir: ${JSON.stringify(join(workDir, key))},
      files: ${JSON.stringify(files)}
    }
  },
  products: {}
};

const uninstall = installVendorPortraitBindingBridge({ index, maxCharactersPerShot: 1, log: () => undefined });
const engine = new engineMod.RenderingEngine({
  charactersDir: ${JSON.stringify(workDir)},
  outputDir: ${JSON.stringify(workDir)},
  apiKey: "test-key",
  endpoint: "test-model"
});

// 真机形状：镜头卡 portraits 为空数组（真值），characterRef 为空
const prompt = { shotId: "SC-01", prompt: "住客 走进园林夜色", portraits: [], characterRef: "" };
await engine.render([prompt], { dryRun: true });

const shot = engine._convertToShotFormat(prompt);
const manifest = await engine._generateBindingManifest([prompt]);
const check = new RenderSubmitterCore({ charactersDir: ${JSON.stringify(workDir)} })
  .validateManifest(manifest);
uninstall();

console.log("RESULT " + JSON.stringify({
  characterRef: prompt.characterRef,
  portraitsStillEmptyArray: Array.isArray(prompt.portraits),
  shotCharacters: shot.characters ?? null,
  manifestCharacters: Object.keys(manifest.characters ?? {}),
  valid: check.valid,
  errors: check.errors,
  totalAngles: check.totalAngles
}));
`;

    const result = runInChild(script);
    expect(result.characterRef).toContain(`image://characters/${key}/portraits/`);
    expect(result.portraitsStillEmptyArray).toBe(false);
    expect(result.shotCharacters).toEqual([key]);
    expect(result.manifestCharacters).toEqual([key]);
    expect(result.errors).toEqual([]);
    expect(result.valid).toBe(true);
    expect(result.totalAngles).toBe(4);
  }, 90_000);

  it("索引里没有四角度齐备角色时不注入（渲染门照常报错，不伪造绑定）", () => {
    const script = `
import { installVendorPortraitBindingBridge } from ${JSON.stringify(resolve(here, "vendor-compat.ts"))};
const uninstall = installVendorPortraitBindingBridge({
  index: { schemaVersion: "workloom.portrait-index/v1", projectId: "p", generatedAt: "", characters: {}, products: {} },
  log: () => undefined
});
const prompt = { shotId: "SC-01", prompt: "风景空镜", portraits: [], characterRef: "" };
console.log("RESULT " + JSON.stringify({ characterRef: prompt.characterRef, portraitsStillEmptyArray: Array.isArray(prompt.portraits) }));
uninstall();
`;
    const result = runInChild(script);
    expect(result.characterRef).toBe("");
  }, 60_000);

  /**
   * 真机根因回归（2026-09-22）：`ConfigIsolator.isolate(options)` 把宿主注入的 LLM 引擎
   * 摊平成普通对象 → 创意主题生成器报「LLM 引擎无可用调用方法」→ 主题静默降级成艺术实验。
   */
  it("配置隔离保活注入的类实例（LLM 引擎方法不再丢失）", () => {
    const script = `
import { createRequire } from "node:module";
import { installVendorConfigIsolatorBridge } from ${JSON.stringify(resolve(here, "vendor-compat.ts"))};
const require = createRequire(${JSON.stringify(join(repoRoot, "package.json"))});
const { ConfigIsolator } = require(${JSON.stringify(join(repoRoot, "vendor/supermickey/hyperreality-system/utils/config-isolator.js"))});

class FakeEngine {
  constructor() { this.tag = "engine"; }
  async reason() { return { success: true, content: "{}" }; }
  async chat() { return "{}"; }
}
const engine = new FakeEngine();
const before = ConfigIsolator.isolate({ llmEngine: engine, nested: { a: 1, list: [1, 2] } });
const uninstall = installVendorConfigIsolatorBridge();
const after = ConfigIsolator.isolate({ llmEngine: engine, nested: { a: 1, list: [1, 2] } });
uninstall();
console.log("RESULT " + JSON.stringify({
  beforeEngineMethods: [typeof before.llmEngine?.reason, typeof before.llmEngine?.chat],
  afterEngineSameRef: after.llmEngine === engine,
  afterEngineMethods: [typeof after.llmEngine?.reason, typeof after.llmEngine?.chat],
  nestedCloned: after.nested !== undefined && after.nested !== null,
  nestedValue: after.nested?.a,
  listIsArray: Array.isArray(after.nested?.list)
}));
`;
    const result = runInChild(script);
    expect(result.beforeEngineMethods).toEqual(["undefined", "undefined"]);
    expect(result.afterEngineSameRef).toBe(true);
    expect(result.afterEngineMethods).toEqual(["function", "function"]);
    expect(result.nestedValue).toBe(1);
    expect(result.listIsArray).toBe(true);
  }, 60_000);

  /**
   * 真机回归（2026-09-22）：Phase 3.5 字段质检因结构化 timeline 崩 `tl.match`，
   * 且单镜异常导致 `result.reports` 缺失 → 整套质检失败 → FieldGuard 默认模板覆盖 6 镜。
   */
  it("字段质检桥：结构化 timeline 不再崩，单镜异常也有 reports 数组", () => {
    const script = `
import { createRequire } from "node:module";
import { installVendorFieldQualityBridge } from ${JSON.stringify(resolve(here, "vendor-compat.ts"))};
const require = createRequire(${JSON.stringify(join(repoRoot, "package.json"))});
const { RuleChecker } = require(${JSON.stringify(join(repoRoot, "vendor/supermickey/hyperreality-system/engines/field-quality/field-check-agent.js"))});

const agent = new RuleChecker();
const shot = {
  shotId: "S1", sceneType: "opening", duration: 5,
  timeline: [
    { object: { start: "T00:00", end: "T00:02" }, string: "T00:00-T00:02 / 建立空间" },
    { object: { start: "T00:02", end: "T00:04" }, string: "T00:02-T00:04 / 推进" },
    { object: { start: "T00:04", end: "T00:05" }, string: "T00:04-T00:05 / 收束" }
  ],
  lighting: { key_light: "主光" }, camera_movement: { timeline: [] }
};
let beforeError = null;
try { agent._checkStructure(shot); } catch (e) { beforeError = e.message; }

const uninstall = installVendorFieldQualityBridge({ log: () => undefined });
let afterError = null;
let afterIssues = null;
try { afterIssues = agent._checkStructure(shot).length; } catch (e) { afterError = e.message; }
uninstall();
console.log("RESULT " + JSON.stringify({ beforeError, afterError, afterIssues, timelineIsArray: Array.isArray(shot.timeline) }));
`;
    const result = runInChild(script);
    expect(result.beforeError).toContain("match is not a function");
    expect(result.afterError).toBeNull();
    expect(result.timelineIsArray).toBe(true);
  }, 60_000);

  it("字段质检桥不重写完整编号合同（有策略和无策略镜头都覆盖），并明确记录 skipped", () => {
    const script = `
import { createRequire } from "node:module";
import { installVendorFieldQualityBridge } from ${JSON.stringify(resolve(here, "vendor-compat.ts"))};
const require = createRequire(${JSON.stringify(join(repoRoot, "package.json"))});
const { FieldQualityPipeline } = require(${JSON.stringify(join(repoRoot, "vendor/supermickey/hyperreality-system/engines/field-quality/field-quality-pipeline.js"))});
const prompt = Array.from({ length: 26 }, (_, index) => String(index + 1).padStart(2, "0") + ".【字段" + (index + 1) + "】" + "完整可执行内容。".repeat(8)).join("\\n");
const shots = [
  { shotId: "S1", duration: 3, prompt, _workloomPromptReviewPolicy: { noDialogue: true, noTitles: true } },
  { shotId: "S2", duration: 3, prompt }
];
const uninstall = installVendorFieldQualityBridge({ log: () => undefined });
const output = await new FieldQualityPipeline({ maxRounds: 2 }).runAll(shots);
uninstall();
console.log("RESULT " + JSON.stringify({
  skipped: output.summary.skipped,
  reason: output.summary.reason,
  samePrompt: output.finalShots[0].prompt === prompt,
  samePromptWithoutPolicy: output.finalShots[1].prompt === prompt,
  reports: output.allReports.length,
  logs: output.allLogs.length
}));
`;
    const result = runInChild(script);
    expect(result.skipped).toBe(true);
    expect(String(result.reason)).toContain("frozen");
    expect(result.samePrompt).toBe(true);
    expect(result.samePromptWithoutPolicy).toBe(true);
    expect(result.reports).toBe(0);
    expect(result.logs).toBe(0);
  }, 60_000);

  /**
   * 真机回归（2026-09-22）：微动作环节两次 run 都是 0/6——
   * 字段名不匹配（camera vs camera_movement）+ 模板缺 neutral。
   */
  it("微动作桥：camera_movement 参与距离推断，neutral 模板补齐（不再 0/6）", () => {
    const script = `
import { createRequire } from "node:module";
import { installVendorMicroMotionBridge } from ${JSON.stringify(resolve(here, "vendor-compat.ts"))};
const require = createRequire(${JSON.stringify(join(repoRoot, "package.json"))});
const { MicroMotionAdapter } = require(${JSON.stringify(join(repoRoot, "vendor/supermickey/hyperreality-system/engines/enhancers/micro-motion-adapter.js"))});

const prompts = [
  { shotId: "S1", prompt: "园林晨雾空镜", camera_movement: "近景推进", mood: "calm" },
  { shotId: "S2", prompt: "人物回廊缓步", camera_movement: "中景横移", mood: "calm" }
];
const before = new MicroMotionAdapter().enhance(prompts, {});
const uninstall = installVendorMicroMotionBridge({ log: () => undefined });
const after = new MicroMotionAdapter().enhance(prompts, {});
uninstall();
console.log("RESULT " + JSON.stringify({
  beforeCount: before.enhancedCount,
  afterCount: after.enhancedCount,
  afterHasMicro: Boolean(after.prompts?.[0]?._microMotion)
}));
`;
    const result = runInChild(script);
    expect(Number(result.beforeCount)).toBe(0);
    expect(Number(result.afterCount)).toBeGreaterThan(0);
    expect(result.afterHasMicro).toBe(true);
  }, 60_000);

  /**
   * 真机回归（VID-1022）：Phase 3 失败后 prompt 全空 → PipelineGuard 严格模式拦下、run 无产物。
   * 重建桥用 vendor 组装器把字段复原成 prompt（非静默兜底，带 promptRebuilt 标记）。
   */
  it("prompt 重建：空 prompt 镜头按字段复原，并保留结构化原值", () => {
    const shots: Array<Record<string, unknown>> = [
      {
        shotId: "SC-01",
        duration: 5,
        prompt: "",
        lighting: { key_light: "主光5600K", fill_light: "反光板" },
        timeline: [{ object: { start: "T00:00" }, string: "T00:00 / 建立空间" }],
        camera_movement: { composition: "竖版居中" },
        scene: "园林清晨薄雾",
        action: "讲述人抬手示意"
      },
      { shotId: "SC-02", prompt: "已有足够长度的提示词".repeat(30) }
    ];
    const rebuilt = rebuildPromptsFromFields(shots, "9:16", (shot, fields) => {
      expect(Object.keys(fields).length).toBeGreaterThan(0);
      return `ASSEMBLED(${String(shot.shotId)}):${Object.keys(fields).length}`;
    });
    expect(rebuilt).toEqual(["SC-01"]);
    expect(String(shots[0]!.prompt)).toContain("ASSEMBLED(SC-01)");
    expect(shots[0]!.promptRebuilt).toBe(true);
    expect(typeof shots[0]!.lighting).toBe("string");
    expect(shots[0]!._rawLighting).toBeDefined();
    expect(String(shots[1]!.prompt)).toContain("已有足够长度的提示词");
    expect(shots[1]!.promptRebuilt).toBeUndefined();
  });

  it("promptFieldText：对象与数组转可读文本，不产生 [object Object]", () => {
    expect(promptFieldText(["A", "B"])).toBe("A；B");
    expect(promptFieldText({ key_light: "主光", fill_light: "补光" })).toContain("主光");
    expect(promptFieldText({ string: "原样" })).toBe("原样");
    expect(promptFieldText(null)).toBe("");
  });

  /**
   * 契约自愈（T-2026-0926-0007 / #165）：重建产物缺【服装】字段 + 台词竖杠，
   * 会被 vendor `render-pipeline-guard` 的 COSTUME_LOCK / DIALOGUE_FORMAT 稳定拦下。
   */
  describe("healPromptContract（重建产物契约自愈）", () => {
    const basePrompt = [
      "01.【场景】明亮工作室，工作台与显示器。",
      "02.【角色】陈卓，与定妆照同一人，深栗棕及肩锁骨发。",
      "03.【台词】[00s-05s] 陈卓 抬手后开口, 笃定地 说:\"别再买工具 | 你缺的是一支班组。\"",
      "04.【动作】她走到中景停住。",
      "05.【负面约束】无文字、无水印。"
    ].join("\n");

    it("台词竖杠归一：只改【台词】字段，其它字段不动", () => {
      const result = healPromptContract(basePrompt);
      const dialogueLine = result.prompt.split("\n").find((line) => line.includes("【台词】"))!;
      expect(dialogueLine).not.toContain("|");
      expect(dialogueLine).toContain("别再买工具，你缺的是一支班组。");
      expect(result.fixes.some((fix) => fix.includes("台词竖杠归一"))).toBe(true);
    });

    it("缺【服装】字段：有卡片服装短语 → 补字段并重排编号，判为已锁定", () => {
      const result = healPromptContract(basePrompt, { costumeHint: "月白色苏式改良旗袍，配珍珠耳饰" });
      expect(result.costumeLocked).toBe(true);
      expect(result.prompt).toMatch(/【服装】月白色苏式改良旗袍/);
      const numbers = result.prompt.split("\n").map((line) => Number(/^(\d{2})\./.exec(line)?.[1] ?? 0));
      expect(numbers).toEqual([1, 2, 3, 4, 5, 6]);
    });

    it("缺【服装】字段且无提示：补「未锁定」声明并判 costumeLocked=false（不得静默放行）", () => {
      const result = healPromptContract(basePrompt);
      expect(result.costumeLocked).toBe(false);
      expect(result.prompt).toContain("【服装】未锁定");
      expect(result.fixes.some((fix) => fix.includes("未锁定"))).toBe(true);
    });

    it("已有【服装】字段：不重复补字段", () => {
      const withCostume = basePrompt.replace(
        "02.【角色】陈卓，与定妆照同一人，深栗棕及肩锁骨发。",
        "02.【角色】陈卓，与定妆照同一人，深栗棕及肩锁骨发。\n02b.【服装】月白色苏式改良旗袍，配素色绣花鞋"
      );
      const result = healPromptContract(withCostume);
      expect(result.prompt.match(/【服装】/g)?.length).toBe(1);
      expect(result.fixes.some((fix) => fix.includes("补【服装】"))).toBe(false);
    });

    it("重建链路：空 prompt 镜头重建后自带【服装】补全与台词归一留痕", () => {
      const shots: Array<Record<string, unknown>> = [
        {
          shotId: "SC-09",
          duration: 5,
          prompt: "",
          scene: "明亮工作室",
          character: "陈卓，与定妆照同一人",
          costume: "月白色苏式改良旗袍，配珍珠耳饰",
          action: "她抬手示意"
        }
      ];
      const rebuilt = rebuildPromptsFromFields(shots, "9:16", () =>
        "01.【场景】明亮工作室。\n02.【角色】陈卓。\n03.【台词】[00s-05s] 陈卓 抬手, 笃定地 说:\"A | B。\""
      );
      expect(rebuilt).toEqual(["SC-09"]);
      const prompt = String(shots[0]!.prompt);
      expect(prompt).toContain("【服装】月白色苏式改良旗袍");
      expect(prompt).not.toContain("A | B");
      expect(Array.isArray(shots[0]!.promptContractHealed)).toBe(true);
      expect(shots[0]!.costumeLock).toBeUndefined();
    });
  });

  /** 契约桥：autoFix 的 `String(value)` 会把对象变成 [object Object]；validate 前先用可读文本归一 */
  it("契约桥：对象型字段不再产生 [object Object]，并输出契约账本行", () => {
    const script = `
import { createRequire } from "node:module";
import { installVendorContractBridge } from ${JSON.stringify(resolve(here, "vendor-compat.ts"))};
const require = createRequire(${JSON.stringify(join(repoRoot, "package.json"))});
const { AgentContractValidator } = require(${JSON.stringify(join(repoRoot, "vendor/supermickey/hyperreality-system/engines/production-engine/utils/agent-contract-validator.js"))});

const lines = [];
const uninstall = installVendorContractBridge({ log: (line) => lines.push(line) });
const validator = new AgentContractValidator({ strict: false, autoFix: true });
const shots = [{
  shotId: "S-01", scene: "园林清晨薄雾中的明轩与水面倒影", action: "讲述人抬手示意",
  lighting: { key_light: "主光5600K", fill_light: "反光板" },
  timeline: [{ object: { start: "T00:00" }, string: "T00:00 / 建立空间" }],
  cameraMovement: { composition: "竖版居中" }
}];
const result = validator.validate("phase2-phase3", { shots });
uninstall();
const typeErrors = (result.errors || []).filter(e => /类型不匹配/.test(e));
const structuralErrors = (result.errors || []).filter(e => /lighting|timeline|cameraMovement/.test(e));
console.log("RESULT " + JSON.stringify({
  valid: result.valid,
  typeErrors,
  structuralErrors,
  lightingIsString: typeof result.fixed?.shots?.[0]?.lighting === "string",
  reportLines: lines.filter(l => l.includes("CONTRACT-REPORT")).length
}));
`;
    const result = runInChild(script);
    expect(result.typeErrors).toEqual([]);
    expect(result.structuralErrors).toEqual([]);
    expect(result.valid).toBe(true);
    expect(Number(result.reportLines)).toBeGreaterThan(0);
  }, 60_000);

  /**
   * 静态审计命中（全仓唯一 const 重赋值）：requirement-discovery `_fillDefaults` 的
   * `const filled` + `{...result}` 会把数组展平成对象（该分支不可达但数组已损坏）。
   * 修复桥要求：数组保持数组、对象保持对象，且不再抛 const 赋值错误。
   */
  it("需求洞察字段填充桥：数组保形（原实现会 {0:…} 展平且 const 重赋值）", () => {
    const script = `
import { createRequire } from "node:module";
import { installVendorDiscoveryFixBridge } from ${JSON.stringify(resolve(here, "vendor-compat.ts"))};
const require = createRequire(${JSON.stringify(join(repoRoot, "package.json"))});
const mod = require(${JSON.stringify(join(repoRoot, "vendor/supermickey/hyperreality-system/engines/requirement-discovery-engine.js"))});
const engine = new mod.RequirementDiscoveryEngine({ llmEngine: null });
const agent = engine.agents.scene;
const schema = { type: 'array', items: { type: 'object', properties: { title: { type: 'string' } } } };
const input = [{ title: 'A' }, { title: 'B' }];
const before = agent._fillDefaults(input, schema);
const uninstall = installVendorDiscoveryFixBridge({ log: () => undefined });
const after = agent._fillDefaults(input, schema);
uninstall();
console.log("RESULT " + JSON.stringify({
  beforeIsArray: Array.isArray(before),
  beforeKeys: Object.keys(before || {}),
  afterIsArray: Array.isArray(after),
  afterLength: Array.isArray(after) ? after.length : -1,
  afterFirst: Array.isArray(after) ? after[0] : null
}));
`;
    const result = runInChild(script);
    expect(result.beforeIsArray).toBe(false);
    expect(result.afterIsArray).toBe(true);
    expect(Number(result.afterLength)).toBe(2);
    expect((result.afterFirst as { title?: string } | null)?.title).toBe("A");
  }, 60_000);

  it("叙事角色推断只补明确人物，纯商品/空镜不虚构角色", () => {
    expect(inferNarrativeCharacters({
      intent: "雨夜归家的年轻人使用内置默认模特，主题是陪伴",
      discovery: {
        sceneStructure: {
          opening: { purpose: "年轻人冒雨走到家门口", keyElements: ["湿透的年轻人"] },
          scenes: [{ purpose: "他按下台灯开关" }],
          ending: { purpose: "他坐进暖光里" },
        },
      },
    })).toEqual([expect.objectContaining({ name: "年轻人", role: "protagonist" })]);
    expect(inferNarrativeCharacters({
      intent: "纯商品展示，商品为主体，不出现人物",
      discovery: { sceneStructure: { opening: { purpose: "商品静物空镜" } } },
    })).toEqual([]);
    expect(inferNarrativeCharacters({
      intent: "清晨湖面空镜，无动物，仅保留环境声",
      discovery: { sceneStructure: { opening: { purpose: "一只飞鸟掠过，但硬性要求无动物" } } },
      upstream: { special_notes: "禁止动物、飞鸟、船只和人物" },
    })).toEqual([]);
  });

  it("叙事角色推断识别厨师等职业主体，避免双人作业片被误判为空镜", () => {
    expect(inferNarrativeCharacters({
      intent: "两位厨师连续配合，一人拉面、一人看火并递碗，最后同时把两碗面放到窗口。允许简短对白。",
      discovery: {
        sceneStructure: {
          opening: { purpose: "两位厨师在面馆后厨连续配合" },
          scenes: [{ purpose: "一人拉面，另一人看火并递碗" }],
        },
      },
    })).toEqual([
      expect.objectContaining({
        name: "厨师 A",
        role: "protagonist",
        description: expect.stringContaining("两位"),
      }),
      expect.objectContaining({
        name: "厨师 B",
        role: "protagonist",
        description: expect.stringContaining("两位"),
      }),
    ]);
  });

  it("叙事确认单归一：时间不越过总时长、场景计数含开场结尾、动作短语可执行", () => {
    const discovery: Record<string, unknown> = {
      sceneStructure: {
        opening: { purpose: "年轻人冒雨走到门口" },
        scenes: [{ purpose: "手指贴上旧灯罩" }, { purpose: "他按下开关，暖光亮起" }],
        ending: { purpose: "年轻人坐进暖光里" },
        sceneCount: 2,
      },
      riskAssessment: {
        technicalRisks: [{ risk: "完整风险描述", level: "high" }],
        mitigationSuggestions: ["拆成两个连续特写"],
      },
    };
    const input = [
      "**总场景数**: 2个",
      "情绪触发点：第50秒前后",
      "- **场景**（2）：被截断的内容",
      "- **动作**（2）：对比、贴上",
      "- **风险结论**：被截断的风险",
    ].join("\n");
    const output = normalizeNarrativeRequirementMarkdown(input, discovery, 30);
    expect(output).toContain("主体场景 2 个；加开场与结尾共 4 段");
    expect(output).toContain("片尾（30秒内）");
    expect(output).not.toContain("对比、贴上");
    expect(output).toContain("手指贴上旧灯罩");
    expect(output).toContain("完整风险描述");
    expect(extractNarrativeActions(discovery).length).toBeGreaterThan(0);
  });

  it("叙事归一不按单个样片替换业务道具，并使用真实场景数组计算段数", () => {
    const discovery = {
      sceneStructure: {
        opening: { purpose: "旧纸条被风吹开" },
        scenes: [
          { purpose: "人物拾起旧纸条" },
          { purpose: "人物把旧纸条收好" },
        ],
        ending: { purpose: "镜头落在桌面" },
        sceneCount: 9,
      },
      riskAssessment: { technicalRisks: [], mitigationSuggestions: [] },
    };
    const input = [
      "**总场景数**: 9个",
      "旧纸条是第一幕的关键道具。",
      "情绪触发点：第50秒前后",
    ].join("\n");
    const output = normalizeNarrativeRequirementMarkdown(input, discovery, 30);
    expect(output).toContain("旧纸条是第一幕的关键道具。");
    expect(output).not.toContain("旧灯罩磨痕");
    expect(output).toContain("主体场景 2 个；加开场与结尾共 4 段");
    expect(output).toContain("片尾（30秒内）");
  });

  it("PRD 契约继承默认模特、机器平台和可验证交付口径", () => {
    const discovery = {
      upstreamFields: {
        duration_sec: 30,
        platform_id: "douyin",
        aspect_ratio: "9:16",
        dialogue_requirement: "无台词、无字幕",
        _originalStoryText: "雨夜通勤归家，出租屋里的旧台灯",
      },
      audienceProfile: {
        contentExpectations: ["钉子台词在50秒前后以字幕或旁白出现"],
      },
      _canonicalCharacters: [{
        id: "chen-zhuo",
        name: "陈卓",
        role: "protagonist",
        portraitRef: "bundles/ai-video/library/characters/model-01-chen-zhuo/portraits/v3/平江路讲述人-front.png",
        authorization: "real-authorized",
      }],
    };
    const prd = normalizeNarrativePrdContract({
      projectDefinition: { projectName: "雨夜旧灯", sourceIntent: "雨夜他回到出租屋" },
      productPositioning: {
        targetPlatform: "通用",
        targetDuration: 30,
        aspectRatio: "9:16",
        resolution: "1080p",
        frameRate: 24,
      },
      characterSystem: { characters: [{ name: "年轻人", role: "protagonist" }] },
      creativeCore: {
        creativeHook: "他推开房门",
        keyMessages: ["灯亮着，就是有人在等——必须出现在拧亮台灯同一拍"],
      },
      scenePlan: {
        scenes: [
          { sceneId: "SC01", sequence: 1, duration: 14, purpose: "归家", keyProps: ["旧台灯"] },
          { sceneId: "SC02", sequence: 2, duration: 16, purpose: "落座", keyProps: ["旧台灯"] },
        ],
        shotMapping: [
          { sceneId: "SC01", estimatedShots: 4, shotBreakdownHint: ["wide", "medium", "close", "detail"] },
          { sceneId: "SC02", estimatedShots: 4, shotBreakdownHint: ["wide", "medium", "close", "detail"] },
        ],
      },
      productionConstraints: {
        technicalConstraints: [],
        qualityThresholds: { visual: 0.8, audio: 0.75, narrative: 0.85, consistency: 0.75 },
      },
      deliveryStandard: {
        deliverables: [{ item: "video_master", spec: "MP4/H.264, 1080p", priority: "required" }],
        acceptanceCriteria: { visual: 0.75, audio: 0.7, narrative: 0.75, consistency: 0.7 },
        outputFormat: { videoCodec: "H.264", audioCodec: "AAC", container: "MP4" },
      },
    }, discovery);
    const positioning = prd.productPositioning as Record<string, unknown>;
    const characterSystem = prd.characterSystem as { characters: Array<Record<string, unknown>> };
    const deliveryStandard = prd.deliveryStandard as Record<string, unknown>;
    expect(positioning.targetPlatform).toBe("douyin");
    expect(characterSystem.characters[0]).toMatchObject({
      characterId: "chen-zhuo",
      name: "陈卓",
      portraitPath: "bundles/ai-video/library/characters/model-01-chen-zhuo/portraits/v3/平江路讲述人-front.png",
    });
    expect(String(characterSystem.characters[0]!.appearance)).toContain("女性");
    expect(deliveryStandard.outputFormat).toMatchObject({
      width: 1080,
      height: 1920,
      durationSeconds: 30,
      durationToleranceSeconds: 0.3,
      frameRate: 24,
      audioSampleRate: 48000,
      audioChannels: 2,
      audioLoudnessLufs: -14,
    });
    expect(deliveryStandard.subtitles).toEqual({ mode: "none", burned: false, sidecar: false });
    expect(prd.shotContract).toHaveLength(8);
    expect(JSON.stringify(prd.audienceProfile)).not.toContain("50秒");
    expect(JSON.stringify(prd.audienceProfile)).not.toContain("字幕或旁白");
    expect(String(characterSystem.characters[0]!.costume)).toContain("针织");
    expect(characterSystem.characters[0]!.portraitEvidence).toMatchObject({
      exists: true,
      sha256: expect.stringMatching(/^[a-f0-9]{64}$/),
      width: expect.any(Number),
      height: expect.any(Number),
    });
    const creative = prd.creativeCore as Record<string, unknown>;
    expect(String(creative.creativeHook)).toContain("她");
    expect(JSON.stringify(creative.keyMessages)).not.toContain("同一拍");
    expect(String((prd.projectDefinition as Record<string, unknown>).sourceIntent)).toContain("他");
  });

  it("PRD 镜头合同总时长守恒到交付口径，并补齐字幕、运镜、光位和音频锚点", () => {
    const discovery = {
      upstreamFields: {
        duration_sec: 30,
        platform_id: "douyin",
        aspect_ratio: "9:16",
        dialogue_requirement: "无对白；仅保留雨声和旋钮声",
      },
      _canonicalCharacters: [{
        id: "chen-zhuo",
        name: "陈卓",
        role: "protagonist",
        portraitRef: "bundles/ai-video/library/characters/model-01-chen-zhuo/portraits/v3/平江路讲述人-front.png",
        authorization: "real-authorized",
      }],
    };
    const prd = normalizeNarrativePrdContract({
      projectDefinition: { projectName: "旧灯" },
      productPositioning: {
        targetPlatform: "douyin",
        targetDuration: 30,
        aspectRatio: "9:16",
        resolution: "1080x1920",
        frameRate: 24,
      },
      characterSystem: { characters: [{ name: "陈卓" }] },
      visualSpecification: {
        lightingDirection: "2700K 台灯作唯一暖源，冷蓝环境光包围",
      },
      scenePlan: {
        scenes: [
          {
            sceneId: "SC01", sequence: 1, duration: 6, purpose: "摸黑进门",
            keyProps: ["钥匙"], audioRequirements: ["雨声", "钥匙碰撞"],
            visualRequirements: ["第一次对准锁孔，楼道近乎全暗，雨光冷蓝勾边", "第二次对准锁孔，冷蓝雨光", "钥匙终于插入，冷蓝雨光"],
          },
          {
            sceneId: "SC02", sequence: 2, duration: 12, purpose: "拧亮旧灯",
            keyProps: ["台灯"], audioRequirements: ["旋钮咔响", "钨丝电流"],
            visualRequirements: ["手指靠近开关", "第一次按压失败", "第二次按压成功", "灯光铺满墙面", "静物收尾"],
          },
        ],
        shotMapping: [
          { sceneId: "SC01", estimatedShots: 3, shotBreakdownHint: ["establishing", "medium", "close-up"] },
          { sceneId: "SC02", estimatedShots: 5, shotBreakdownHint: ["close-up", "medium", "close-up", "static"] },
        ],
      },
      productionConstraints: {
        technicalConstraints: ["暖区面积不超过画面三分之一"],
        qualityThresholds: { visual: 0.8, audio: 0.75, narrative: 0.85, consistency: 0.75 },
      },
      deliveryStandard: {
        deliverables: [{ item: "video_master", spec: "MP4", priority: "required" }],
        acceptanceCriteria: {},
        outputFormat: { videoCodec: "H.264", audioCodec: "AAC", container: "MP4" },
      },
    }, discovery);
    const shots = prd.shotContract as Array<Record<string, unknown>>;
    expect(Number(shots.at(-1)?.endSeconds)).toBe(30);
    expect(shots.every((shot) => typeof shot.cameraMovement === "string")).toBe(true);
    expect(shots.every((shot) => Array.isArray(shot.audioAnchors))).toBe(true);
    expect(String(shots[0]!.purpose)).toContain("第一次对准锁孔");
    expect(String(shots[3]!.purpose)).toContain("手指靠近开关");
    expect(String(shots[7]!.purpose)).toContain("静物收尾");
    expect(shots[0]!.shotSize).toBe("establishing");
    expect(String(shots[0]!.lighting)).toContain("楼道近乎全暗");
    expect(String(shots[0]!.colorTemperature)).toContain("5600K");
    expect(String(shots[3]!.colorTemperature)).toContain("2700K");
    expect(shots).toEqual(expect.arrayContaining([
      expect.objectContaining({ shotSize: "medium", cameraMovement: "static" }),
    ]));
    const delivery = prd.deliveryStandard as Record<string, unknown>;
    expect(delivery.subtitles).toEqual({ mode: "none", burned: false, sidecar: false });
    expect(delivery.platformConstraints).toMatchObject({
      safeArea: true,
      safeAreaInsets: { topPercent: 6, bottomPercent: 12, rightRailPercent: 11 },
    });
    expect(String((delivery.acceptanceCriteria as Record<string, unknown>).technical)).toContain("ebur128");
    expect(delivery.audioVerification).toMatchObject({
      measurementTool: "ffmpeg-ebur128",
      integratedLoudnessMeasured: false,
      truePeakMeasured: false,
    });
    expect(String((delivery.fallbackPlan as Record<string, unknown>).trigger)).not.toMatch(/0\.7|0\.8|数值/u);
    expect(delivery.listeningVerification).toMatchObject({ verified: false });
    expect(prd.shotContract as unknown).toBeTruthy();
  });

  it("PRD 删除未进入镜头合同的模型高潮，并给出可测音频、安全区和反馈式重试口径", () => {
    const source = "雨夜，一个年轻人收伞回到出租屋，开门、换鞋、拧亮旧台灯，随后坐在灯下安静地听雨。全片无台词、无旁白、无字幕，仅保留动作与环境声。";
    const prd = normalizeNarrativePrdContract({
      projectDefinition: { sourceIntent: source },
      productPositioning: { targetDuration: 15, aspectRatio: "9:16", targetPlatform: "douyin" },
      creativeCore: {
        creativeHook: "她站在空屋中央，手里攥着伞和包，视线无处安放",
        keyMessages: ["P0：她站在空屋中央，手里攥着伞和包"],
        twistPoint: "她突然听见门外有人叫她",
      },
      scenePlan: {
        scenes: [
          { sceneId: "SC01", duration: 5, purpose: "收伞回到出租屋、开门", keyProps: ["雨伞", "门"] },
          { sceneId: "SC02", duration: 5, purpose: "换鞋", keyProps: ["鞋"] },
          { sceneId: "SC03", duration: 5, purpose: "拧亮旧台灯、坐下听雨", keyProps: ["台灯"] },
        ],
        shotMapping: [
          { sceneId: "SC01", estimatedShots: 2, shotBreakdownHint: ["wide", "close-up"] },
          { sceneId: "SC02", estimatedShots: 1, shotBreakdownHint: ["close-up"] },
          { sceneId: "SC03", estimatedShots: 2, shotBreakdownHint: ["close-up", "medium"] },
        ],
      },
      deliveryStandard: {
        deliverables: [{ item: "video_master" }],
        outputFormat: {},
        fallbackPlan: { trigger: "视觉质量低于 0.75", action: "整片重新生成" },
      },
    }, {
      upstreamFields: {
        duration_sec: 15,
        aspect_ratio: "9:16",
        platform_id: "douyin",
        dialogue_requirement: "全片无台词、无旁白、无字幕，仅保留动作与环境声。",
        _originalStoryText: source,
      },
    });
    const creative = prd.creativeCore as Record<string, unknown>;
    expect(String(creative.creativeHook)).toContain("收伞");
    expect(JSON.stringify(creative.keyMessages)).toMatch(/开门|换鞋|拧亮|坐下/u);
    expect(JSON.stringify(creative)).not.toMatch(/空屋中央|突然听见门外/u);
    const delivery = prd.deliveryStandard as Record<string, unknown>;
    expect(String((delivery.fallbackPlan as Record<string, unknown>).trigger)).not.toMatch(/0\.75|低于/u);
    const markdown = renderPrdContractMarkdown(prd);
    expect(markdown).toContain("ffmpeg ebur128/loudnorm");
    expect(markdown).toContain("顶部 6%");
    expect(markdown).toContain("底部 12%");
    expect(markdown).toContain("右侧栏 11%");
  });

  it("Phase3 单镜降级只做一次真实重试，重试仍降级则失败关闭", async () => {
    const expected = ["S1", "S2"];
    const rows = [
      { shotId: "S1", prompt: "", degraded: true },
      { shotId: "S2", prompt: "完整镜头二", degraded: false },
    ];
    const attempts: string[] = [];
    const repaired = await repairPhase3FusionRows({
      rows,
      expectedIds: expected,
      repair: async (id) => {
        attempts.push(id);
        return { shotId: id, prompt: "重试后的完整镜头一", degraded: false };
      },
    });
    expect(attempts).toEqual(["S1"]);
    expect(repaired.rows[0]).toMatchObject({ shotId: "S1", prompt: "重试后的完整镜头一", degraded: false });
    await expect(repairPhase3FusionRows({
      rows: [{ shotId: "S1", prompt: "", degraded: true }],
      expectedIds: ["S1"],
      repair: async () => ({ shotId: "S1", prompt: "", degraded: true }),
    })).rejects.toThrow(/重试后仍未通过/);
  });

  it("Phase3 单镜重试仍返回降级时，从已审核源镜头合同重建提示词并保留恢复证据", async () => {
    const sourceShot = {
      shotId: "S1",
      duration: 3,
      promptBase: "出租屋门外楼道，雨夜，陈卓收伞",
      action: "陈卓在门外收伞，伞骨滴水",
      lightingString: "楼道冷光，旧台灯尚未点亮",
    };
    const recovered = await repairPhase3FusionRows({
      rows: [{ shotId: "S1", prompt: "", degraded: true }],
      expectedIds: ["S1"],
      repair: async () => ({ shotId: "S1", prompt: "", degraded: true }),
      recover: async () => ({
        ...sourceShot,
        prompt: "01.【场景】出租屋门外楼道\n02.【动作】陈卓在门外收伞，伞骨滴水",
        degraded: false,
        _workloomLocalRecovery: { mode: "contract-source-reprojection" },
      }),
    });
    expect(recovered.repaired).toEqual(["S1"]);
    expect(recovered.recovered).toEqual(["S1"]);
    expect(recovered.rows[0]).toMatchObject({
      shotId: "S1",
      degraded: false,
      _workloomLocalRecovery: { mode: "contract-source-reprojection" },
    });
    expect(String(recovered.rows[0]!.prompt)).toContain("陈卓在门外收伞");
  });

  it("无台词最终镜头清除台词字段，并把超长 prompt 收敛到硬上限", () => {
    const longField = "完整画面描述。".repeat(700);
    const shot = applyNarrativeFinalPromptContract({
      shotId: "S1",
      dialogue: "你还在啊。",
      dialogueText: "你还在啊。",
      dialogueBlocks: [{ line: "你还在啊。" }],
      fields: { dialogue: "你还在啊。", scene: longField, audio: "雨声" },
      prompt: [
        "01.【语言约束】全部字段必须使用中文。",
        "02.【场景】" + longField,
        "18.【台词】你还在啊。",
        "19.【音频】雨声",
      ].join("\n"),
    }, { noDialogue: true, maxLength: 3000 });
    expect(shot.dialogue).toBe("");
    expect(shot.dialogueText).toBe("");
    expect(shot.dialogueBlocks).toEqual([]);
    expect(String(shot.prompt)).toContain("【台词】不适用：本片无台词、无旁白、无口播。");
    expect(String(shot.prompt)).not.toContain("你还在啊");
    expect(String(shot.prompt).length).toBeLessThanOrEqual(3000);
    expect(String(shot.prompt)).toContain("【场景】");
    expect(String(shot.prompt)).toContain("【音频】");
  });

  it("缺少编号字段的超长 prompt 失败关闭，不硬截断业务锚点", () => {
    expect(() => applyNarrativeFinalPromptContract({
      shotId: "S1",
      prompt: "无结构长文".repeat(1000),
    }, { noDialogue: true, maxLength: 3000 })).toThrow("FINAL_PROMPT_UNCOMPRESSIBLE");
  });

  it("允许台词的营销片也会清洗台词中的 |，避免被误判为字段分隔符", () => {
    const shot = applyNarrativeFinalPromptContract({
      shotId: "S1",
      dialogue: "这张纸|比机器还小",
      prompt: "01.【场景】产品对比\n18.【台词】这张纸|比机器还小\n24.【负面约束】no text",
    }, { noDialogue: false, maxLength: 3000 });
    expect(String(shot.dialogue)).toBe("这张纸|比机器还小");
    expect(String(shot.prompt)).toContain("这张纸，比机器还小");
    expect(String(shot.prompt)).not.toContain("这张纸|比机器还小");
  });

  it("最终交付约束覆盖模型自拟画幅，同时保留约束字段标签", () => {
    const shot = applyNarrativeFinalPromptContract({
      shotId: "S1",
      prompt: "03.【基础】8K\n04.【约束】16:9画幅，4K分辨率，24fps，MP4格式。\n05.【场景】室内",
    }, {
      noDialogue: false,
      maxLength: 3000,
      deliveryConstraint: "9:16画幅，1080x1920分辨率，30fps，MP4格式。",
    });
    expect(String(shot.prompt)).toContain("02.【约束】9:16画幅，1080x1920分辨率，30fps，MP4格式。");
    expect(String(shot.prompt)).not.toContain("02.【约束】16:9画幅");
    expect(String(shot.prompt)).toContain("03.【场景】");
  });

  it("无角色空镜最终提示词清除人物模板、人声与配乐，并保持编号连续", () => {
    const shot = applyNarrativeFinalPromptContract({
      shotId: "SC-1",
      duration: 5,
      audio: "人声对话清晰可辨；风声；音乐为极简弦乐长音铺底，BPM约50；no bgm",
      prompt: [
        "01.【语言约束】全部字段必须使用中文输出,禁止出现英文单词、英文短语、英文描述。",
        "04.【约束】16:9画幅，8K分辨率，24fps，MP4格式。",
        "07.【明亮约束】主体面部明亮清晰，阴影保留层次不死黑。",
        "12.【角色】无人物出场，不适用。",
        "13.【服装】无角色出场，本字段不适用。",
        "18.【台词】无。",
        "19.【时间轴】T00:00-T00:20 建立场景。",
        "20.【情绪】quiet, 站立姿态，微笑或点头。",
        "23.【音频】人声对话清晰可辨；音乐为极简弦乐长音铺底，BPM约50。",
        "24.【负面约束】no text, no watermark, no people。",
        "25.【角色约束】画面无人物，禁止任何人物入镜。",
        "26.【角色一致性】本镜头无角色。 | 【音频纪律】允许台词人声与配乐 | no bgm",
      ].join("\n"),
    }, {
      noDialogue: true,
      maxLength: 3000,
      noCharacters: true,
      noAnimals: true,
      noMusic: true,
      chineseOnly: true,
      durationSeconds: 5,
      aspectRatio: "9:16",
      resolution: "1080x1920",
    });
    const prompt = String(shot.prompt);
    expect(prompt).toContain("09:16画幅".replace("09:16", "9:16"));
    expect(prompt).toContain("1080x1920");
    expect(prompt).toContain("无人物");
    expect(prompt).toContain("不要求人物表情");
    expect(prompt).toContain("【台词】不适用");
    expect(prompt).toContain("无人物声、无旁白、无音乐");
    expect(prompt).toContain("无文字、无字幕、无水印");
    expect(prompt).not.toMatch(/面部明亮|站立姿态|微笑或点头|人声对话|弦乐|BPM|no text|no bgm/u);
    const numbers = prompt.split("\n").map((line) => Number(/^(\d{2})\.【/u.exec(line)?.[1] ?? 0)).filter(Boolean);
    expect(numbers).toEqual(numbers.map((_, index) => index + 1));
  });

  it("人物片最终提示词锁定真实角色并移除片头与英文技能残留", () => {
    const shot = applyNarrativeFinalPromptContract({
      shotId: "SC-1",
      duration: 3,
      prompt: [
        "01.【语言约束】全部字段必须使用中文。",
        "02.【基础】cinematic，photorealistic 电影级写实质感。",
        "03.【角色】站立姿态，缓慢走动，张开双臂或自然下垂。",
        "04.【微动作】眼神闪烁，微微后退。",
        "05.【主标题内容】雨声落进旧灯：那晚谁在门外",
        "06.【标题动画设计】全程3.5秒，低频铺底进入。",
        "07.【开场音频设计】2.4-3.5秒低频撤走。",
        "08.【音频】雨声与动作声。 | [CINEMATIC_SKILL] Camera增强 / Mood增强 | no background music, no bgm",
      ].join("\n"),
    }, {
      noDialogue: true,
      maxLength: 3000,
      noCharacters: false,
      noAnimals: true,
      noMusic: true,
      chineseOnly: true,
      noTitles: true,
      characterNames: ["陈卓"],
      durationSeconds: 3,
      aspectRatio: "9:16",
      resolution: "1080x1920",
    });
    const prompt = String(shot.prompt);
    expect(prompt).toContain("【角色】陈卓");
    expect(prompt).toContain("电影级写实质感");
    expect(prompt).toContain("【主标题内容】不适用");
    expect(prompt).toContain("【标题动画设计】不适用");
    expect(prompt).not.toMatch(/站立姿态|微微后退|3\.5秒|cinematic|photorealistic|CINEMATIC_SKILL|Camera增强|Mood增强|no background music|no bgm/iu);
  });

  it("canonical 最终合同从可信字段重建固定26栏，不继承模型字段漂移", () => {
    const shot = applyNarrativeFinalPromptContract({
      shotId: "SC-7",
      duration: 3,
      scene: "雨夜出租屋玄关，湿伞、门框与旧台灯形成同一空间",
      lighting: "玄关冷蓝雨光与台灯2800K局部暖光分区锁定",
      composition: "9:16竖构图，人物半身靠门框，前景留湿伞",
      color_palette: "冷青蓝环境色，局部暖黄",
      depth_of_field: "人物与门框清晰，窗外雨幕轻微虚化",
      camera_movement: "固定机位",
      action: "陈卓收伞、关门，目光短暂落在旧台灯上",
      props: "湿伞、旧木门、旧台灯",
      character: "陈卓，保持授权外观与当前服装一致",
      costume: "深灰连帽外套、深色长裤与湿鞋",
      makeup: "雨夜自然裸妆，保持同一肤色",
      mood: "疲惫后的安静",
      prompt: "01.【角色】站立姿态，张开双臂\n02.【化妆】地面积水反光\n03.【主标题】无关标题\n04.【音频】弦乐BPM50",
      fields: {},
    }, {
      noDialogue: true,
      maxLength: 3000,
      noCharacters: false,
      noAnimals: true,
      noMusic: true,
      chineseOnly: true,
      noTitles: true,
      canonicalize: true,
      characterNames: ["陈卓"],
      characterPortraits: [{
        name: "陈卓",
        path: "bundles/ai-video/library/characters/model-01-chen-zhuo/portraits/v3/平江路讲述人-front.png",
      }],
      durationSeconds: 3,
      aspectRatio: "9:16",
      resolution: "1080x1920",
      colorTemperature: "2800K / 5600K",
    });
    const prompt = String(shot.prompt);
    const fields = prompt.split("\n").map((line) => /^(\d{2})\.【([^】]+)】/u.exec(line)).filter(Boolean) as RegExpExecArray[];
    expect(fields.map((field) => Number(field[1]))).toEqual(Array.from({ length: 26 }, (_, index) => index + 1));
    expect(prompt).toContain("【角色】陈卓入画");
    expect(prompt).toContain("【化妆】自然写实妆");
    expect(prompt).toContain("【动作】陈卓收伞、关门");
    expect(prompt).toContain("平江路讲述人-front.png");
    expect(prompt).not.toMatch(/站立姿态|地面积水反光|无关标题|弦乐|BPM|张开双臂/u);
  });

  it("叙事道具从场景证据抽取，关键道具不会因窄词表遗漏", () => {
    const props = inferNarrativeProps({
      intent: "人物使用内置默认模特，不出现商品参数或价格",
      discovery: {
        sceneStructure: {
          opening: { purpose: "雨夜摸黑上楼，手机屏幕碎光熄灭", keyElements: ["湿漉漉的手在黑暗中摸索扶手", "手机屏幕碎裂的微光"] },
          scenes: [{
            purpose: "陈卓将钥匙插入锁孔，门缝下透出暖光，走近老旧台灯",
            keyElements: ["钥匙插入锁孔的特写", "门缝下透出一线暖光", "老旧灯罩轻微晃动"],
          }],
          ending: { purpose: "镜头落在灯罩缺口", keyElements: ["灯罩上的缺口"] },
        },
      },
    });
    expect(props).toEqual(expect.arrayContaining(["钥匙", "门", "台灯", "手机"]));
    expect(new Set(props).size).toBe(props.length);
    expect(props).not.toEqual(expect.arrayContaining(["老旧台灯", "旧台灯", "灯罩", "旧灯罩"]));
  });

  it("风险与缓解按语义特征配对，不按数组下标硬绑定", () => {
    const pairs = pairRiskMitigations({
      technicalRisks: [
        { risk: "手部触碰开关时容易穿模", level: "high" },
        { risk: "台灯跨镜头纹理漂移", level: "high" },
        { risk: "低照度曝光、色温与胶片颗粒不稳定", level: "medium" },
        { risk: "雨伞、雨珠和发梢滴水物理不一致", level: "medium" },
        { risk: "人物身份和面部在近景中漂移", level: "medium" },
      ],
      mitigationSuggestions: [
        "手部动作拆成三个固定插入镜头",
        "旧台灯锁定英雄道具三视图和纹理",
        "雨具不全身入画，用伞沿、湿布和发梢三点组接",
        "固定低照度曝光、暖冷光比和胶片颗粒，并绑定角色定妆照作面部锚点",
      ],
    });
    expect(pairs[0]).toContain("手部动作");
    expect(pairs[1]).toContain("英雄道具");
    expect(pairs[2]).toContain("低照度曝光");
    expect(pairs[3]).toContain("雨具");
    expect(pairs[4]).toContain("定妆照");
  });

  it("G3 修复开场空间光位、截断结尾、重复动作、道具缺口和风险错配", () => {
    const upstream = {
      _originalStoryText: "雨夜，一个年轻人收伞回到出租屋，开门、换鞋、拧亮旧台灯，随后坐在灯下安静地听雨。全片无台词、无旁白、无字幕，仅保留动作与环境声。",
      dialogue_requirement: "全片无台词、无旁白、无字幕，仅保留动作与环境声。",
      visual_style: "雨夜外景冷蓝，室内旧台灯钨丝暖黄，固定机位与手部/侧脸特写交替",
      special_notes: "视觉锚点：雨夜收伞滴水、出租屋门锁与门缝光、换鞋旧鞋与地面水痕、拧亮旧台灯的旋钮与钨丝暖光、灯下静坐听雨侧脸。",
    };
    const discovery: Record<string, unknown> = {
      sceneStructure: {
        opening: {
          duration: 3,
          purpose: "黑伞在冷白路灯下收拢，水珠砸进积水；陈卓半张脸被伞影压暗；收伞回到出租屋；开门；坐下听雨；拧亮旧台灯",
          keyElements: ["钥匙", "雨伞", "积水", "水滴"],
        },
        scenes: [
          { duration: 3, purpose: "镜头从伞骨滴水下摇到湿鞋踩过门槛", keyElements: ["门", "雨伞", "鞋", "台灯"] },
          { duration: 4.5, purpose: "门咔哒合上后，他拧亮台灯；换鞋旧鞋与地面水痕", keyElements: ["台灯", "门", "桌面", "雨伞"] },
        ],
        ending: {
          duration: 4.5,
          purpose: "”——冷湿被留门外，疲惫有地方落下，这口气让",
          keyElements: ["门", "台灯", "雨伞", "鞋"],
        },
      },
      riskAssessment: {
        technicalRisks: [
          { risk: "旧台灯旋钮拧亮时手指穿模", level: "high" },
          { risk: "雨夜收伞滴水与换鞋水痕不连续", level: "high" },
          { risk: "钥匙插入锁孔时金属反光漂移", level: "medium" },
          { risk: "同一角色跨镜头侧脸一致性不足", level: "medium" },
          { risk: "固定长镜头出现纹理蠕动和雨丝不连贯", level: "low" },
        ],
        mitigationSuggestions: [
          "把拧台灯拆成三个连续手部特写",
          "锁定同一角色参考帧、服装与场景平面图",
          "门锁镜头降级为声音与局部剪影",
          "侧脸一致性采用参考立绘、半脸浅景深和同批次首帧图生视频",
          "长镜头控制单镜时长并硬切拼接，逐镜检查噪点与雨丝连续性",
        ],
      },
    };
    normalizeNarrativeDiscovery(discovery, 15, upstream);
    const scene = discovery.sceneStructure as any;
    expect(String(scene.ending.purpose)).toContain("坐下听雨");
    expect(String(scene.ending.purpose)).not.toMatch(/”——|这口气让/u);
    const actions = extractNarrativeActions(discovery, upstream);
    expect(actions).toEqual(expect.arrayContaining(["收伞回到出租屋", "换鞋", "拧亮旧台灯", "坐下听雨"]));
    expect(actions).not.toContain("拧亮旧台灯的旋钮与钨丝暖光");
    expect(actions).not.toContain("换鞋旧鞋与地面水痕");
    const pairs = pairRiskMitigations(discovery.riskAssessment as Record<string, unknown>);
    expect(pairs[1]).toMatch(/雨珠|雨伞|伞骨|伞尖|水痕/u);
    expect(pairs[2]).toMatch(/钥匙|锁孔|门锁|锁舌/u);
    expect(pairs[3]).toMatch(/侧脸|参考立绘|半脸/u);
    expect(pairs[4]).toMatch(/长镜头|单镜时长|雨丝|纹理蠕动/u);
    expect(pairs[3]).not.toContain("固定门、桌面和主光位置");
    const markdown = normalizeNarrativeRequirementMarkdown([
      "### 2.2 场景结构建议",
      "**叙事结构**: 主体场景 2 个；加开场与结尾共 4 段",
      "**开场** (3秒)",
      "**场景 1** (3秒)",
      "**场景 2** (4.5秒)",
      "**结尾** (4.5秒)",
      "---",
      "### 2.3 技术难点预判",
      "- **场景**（4）：旧契约",
      "- **道具**（1）：台灯",
      "- **动作**（1）：打开",
      "- **风险结论**：旧结论",
      "### 2.4 对标参考",
      "- 旧参考",
    ].join("\r\n"), discovery, 15, upstream);
    const openingLine = markdown.split("\n").find((line) => line.includes("开场：目的="))!;
    const openDoorLine = markdown.split("\n").find((line) => line.includes("主体场景 1：目的=开门"))!;
    const endingLine = markdown.split("\n").find((line) => line.includes("结尾：目的="))!;
    expect(openingLine).toMatch(/空间=(?:楼道|室外|门口)/u);
    expect(openingLine).toMatch(/光位=(?:冷|路灯)/u);
    expect(openDoorLine).toContain("光位=室内未开灯");
    expect(openDoorLine).toContain("空间=出租屋门口");
    expect(endingLine).toContain("坐下听雨");
    expect(endingLine).toMatch(/关键元素=.*台灯/u);
    expect(markdown).toContain("- **道具**（");
    expect(markdown).toContain("钥匙");
    expect(markdown).toContain("积水");
    expect(markdown).toContain("水滴");
    expect(markdown).toContain("**叙事结构**: 主体场景 3 个；加开场与结尾共 5 段");
    expect(markdown).toContain("**场景 3** (3秒)");
    expect(markdown).toContain("- **声音锚点**（");
    expect(markdown).toContain("门锁与开门声");
    expect(markdown).toContain("钥匙开锁");
    expect(markdown).toContain("坐具");
    const endingNode = (discovery.sceneStructure as any).ending;
    expect(endingNode.keyElements).toEqual(expect.arrayContaining(["坐具"]));
    const lampNode = (discovery.sceneStructure as any).scenes.find((node: any) => String(node.purpose).includes("拧亮"));
    expect(lampNode.keyElements).toEqual(expect.arrayContaining(["旧台灯", "台灯开关/旋钮"]));
    expect(JSON.stringify(lampNode.keyElements)).not.toMatch(/未亮|黑着|暖光下/u);
    expect(endingLine).toMatch(/机位=中景/u);
  });

  it("G3 不把手持风格改成三脚架，也不把手部缓解错配给静止微表情", () => {
    const pairs = pairRiskMitigations({
      technicalRisks: [
        { risk: "浅景深手持微晃与焦点转移的时序稳定性", level: "medium" },
        { risk: "坐下听雨的静止微表情与情绪停顿", level: "medium" },
        { risk: "台灯开关的手指微距动作与灯光由暗到亮渐变", level: "medium" },
        { risk: "灯下静坐侧脸在低照度长镜中出现面部纹理漂移", level: "medium" },
        { risk: "换鞋时鞋跟脱落、脚掌落在凉地板的接触形变", level: "high" },
      ],
      mitigationSuggestions: [
        "将本镜改为三脚架固定机位",
        "将手部动作拆成固定机位短特写",
        "先按场景建立硬时间预算并写入镜头合同",
      ],
    });
    expect(pairs[0]).toMatch(/保留.*手持|呼吸级/u);
    expect(pairs[0]).toContain("机位高度");
    expect(pairs[0]).not.toContain("三脚架固定机位");
    expect(pairs[1]).toMatch(/背影|侧影|肩线/u);
    expect(pairs[1]).not.toContain("手部动作拆成固定机位短特写");
    expect(pairs[2]).toMatch(/台灯|旋钮|钨丝|灯光/u);
    expect(pairs[2]).not.toContain("硬时间预算");
    expect(pairs[3]).toMatch(/侧脸|侧逆光|参考帧|缩短单镜/u);
    expect(pairs[3]).not.toContain("硬时间预算");
    expect(pairs[4]).toMatch(/鞋跟|脚掌|换鞋/u);
    expect(pairs[4]).not.toContain("低照度长镜");
  });

  it("G3 将低照度与雨滴物理拆成不同缓解，不让雨幕方案互相复制", () => {
    const pairs = pairRiskMitigations({
      technicalRisks: [
        { risk: "低照度暖钨丝台灯与冷蓝雨光造成色偏和噪点闪烁", level: "medium" },
        { risk: "雨滴方向不连贯、滴水悬空、雨帘循环重复", level: "medium" },
        { risk: "固定机位长镜头中人物姿态、湿痕和道具状态漂移", level: "medium" },
      ],
      mitigationSuggestions: [
        "把窗外雨幕设为独立背景板并锁定反射",
        "固定曝光、白平衡、主辅光比与 LUT",
        "把雨珠改为静态挂珠并用声音承接",
      ],
    });
    expect(pairs[0]).toContain("曝光");
    expect(pairs[0]).not.toContain("把窗外雨幕设为独立背景板");
    expect(pairs[1]).toMatch(/雨珠|挂珠|滴水/u);
    expect(pairs[1]).not.toBe(pairs[0]);
    expect(pairs[2]).toMatch(/姿态|湿痕|道具|首帧|参考帧/u);
  });

  it("真实低照度与静坐微表情风险不会互相串用台灯或人物拆镜模板", () => {
    const pairs = pairRiskMitigations({
      technicalRisks: [
        { risk: "低照度雨夜与湿润反光：雨丝、墙面颗粒、水洼反光、暖黄台灯与冷蓝轮廓光需在多镜头间保持一致", level: "medium" },
        { risk: "灯下静坐听雨的微表情长镜头：人物呼吸、眼神、肩颈微动和面部光影需长时间稳定", level: "high" },
      ],
      mitigationSuggestions: [
        "把台灯开关拆成暗态静帧、指节接触旋钮、钨丝起亮三个短特写",
        "静坐结尾拆为手部、肩颈、侧脸剪影、灯下影子4个短静态特写",
      ],
    });
    expect(pairs[0]).toMatch(/曝光|白平衡|噪点|色温/u);
    expect(pairs[0]).not.toMatch(/台灯开关拆成|静坐结尾拆为/u);
    expect(pairs[1]).toMatch(/背影|侧影|肩线/u);
    expect(pairs[1]).not.toMatch(/台灯开关拆成|曝光|白平衡/u);
  });

  it("真实换鞋接触、钨丝灯噪点和雨滴涟漪风险各自使用专属缓解", () => {
    const pairs = pairRiskMitigations({
      technicalRisks: [
        { risk: "换鞋动作中的鞋带/鞋口与脚部交互，以及湿鞋在地面留下的水渍反光，脚-鞋-地面接触不一致", level: "high" },
        { risk: "低照度钨丝暖光作为唯一主光源下的皮肤与金属材质表现，模型易产生噪点堆积、色温漂移、台灯钨丝高光溢出", level: "high" },
        { risk: "雨滴与伞面、地面水渍的物理反射连续性，雨丝密度与落地涟漪的因果匹配失效", level: "medium" },
      ],
      mitigationSuggestions: [
        "把微质感锚点拆成固定机位微距短镜头",
        "把窗外雨幕设为独立背景板，锁定雨线方向与反射",
        "静坐结尾拆为手部、肩颈、侧脸剪影与灯下影子四个短镜",
      ],
    });
    expect(pairs[0]).toMatch(/鞋跟|脚掌|脚踝/u);
    expect(pairs[0]).not.toMatch(/雨珠|微距/u);
    expect(pairs[1]).toMatch(/低照度曝光|白平衡|噪点|色温/u);
    expect(pairs[1]).not.toMatch(/微质感|鞋跟/u);
    expect(pairs[2]).toMatch(/雨滴|雨丝|涟漪|水层/u);
    expect(pairs[2]).not.toMatch(/芦苇|水面参考帧/u);
  });

  it("G3 清除评审指令、拆分过载主体场景、去重内容期望并过滤空动作", () => {
    const discovery: Record<string, unknown> = {
      audienceProfile: {
        contentExpectations: [
          "只记录自然环境与环境声的缓慢变化",
          "只记录自然环境与环境声的缓慢变化",
          "声音层次要经得起耳机",
        ],
      },
      sceneStructure: {
        opening: {
          duration: 2.5,
          purpose: "雨夜楼道高处俯拍，陈卓收拢黑伞，伞尖滴水；坐下听雨",
          keyElements: ["黑伞", "鞋"],
        },
        scenes: [{
          duration: 2.5,
          purpose: "开门、换鞋、拧亮旧台灯",
          keyElements: ["门", "台灯"],
        }, {
          duration: 5,
          purpose: "删掉这镜，全片只剩收伞没有静下来，主题落空。观众看到陈卓换鞋后拧亮旧台灯，感到疲惫被慢慢放下，并愿意陪他多听一会儿雨。",
          keyElements: ["旧台灯", "窗"],
        }],
        ending: {
          duration: 5,
          purpose: "外部喧嚣被门关住，内部安静被旧灯确认。",
          keyElements: ["台灯"],
        },
      },
    };
    normalizeNarrativeDiscovery(discovery, 15, {
      _originalStoryText: "雨夜，陈卓收伞回到出租屋，开门、换鞋、拧亮旧台灯，随后坐在灯下安静地听雨。全片无台词、无旁白、无字幕，仅保留动作与环境声。",
      dialogue_requirement: "全片无台词、无旁白、无字幕，仅保留动作与环境声。",
    });
    const scene = discovery.sceneStructure as any;
    const nodes = [scene.opening, ...scene.scenes, scene.ending];
    expect(nodes).toHaveLength(5);
    expect(nodes.every((node: any) => node.duration === 3)).toBe(true);
    expect(JSON.stringify(scene)).not.toMatch(/删掉这镜|主题落空|观众看到/u);
    expect(extractNarrativeActions(discovery, {})).not.toContain("放下");
    const expectations = (discovery.audienceProfile as any).contentExpectations as string[];
    expect(new Set(expectations).size).toBe(expectations.length);
    const markdown = normalizeNarrativeRequirementMarkdown([
      "**内容期望**",
      "1. 只记录自然环境与环境声的缓慢变化",
      "2. 只记录自然环境与环境声的缓慢变化",
      "3. 声音层次要经得起耳机",
      "---",
      "- **动作**（1）：打开",
    ].join("\n"), discovery, 15, { dialogue_requirement: "全片无台词、无旁白、无字幕，仅保留动作与环境声。" });
    expect((markdown.match(/只记录自然环境与环境声的缓慢变化/gu) ?? []).length).toBe(1);
  });

  it("通用占位式缓解会被按风险类别替换为可执行方案", () => {
    const pairs = pairRiskMitigations({
      technicalRisks: [
        { risk: "指腹按压开关时手指容易穿模", level: "high" },
        { risk: "雨珠沿发梢滴落的液体物理不稳定", level: "high" },
        { risk: "低照度曝光和色温漂移", level: "medium" },
      ],
      mitigationSuggestions: ["预留重试时间", "准备备选方案"],
    });
    expect(pairs[0]).toContain("手部");
    expect(pairs[1]).toContain("雨珠");
    expect(pairs[2]).toContain("曝光");
    expect(pairs.join("")).not.toContain("预留重试时间");
    expect(pairs.join("")).not.toContain("准备备选方案");
  });

  it("钥匙反光和道具一致性风险不会误用其他高风险的手部缓解", () => {
    const pairs = pairRiskMitigations({
      technicalRisks: [
        { risk: "手指贴灯罩容易穿模", level: "high" },
        { risk: "钥匙串金属反光和手指拨动不稳定", level: "high" },
        { risk: "老旧台灯跨镜头一致性不足，灯罩和开关旧痕漂移", level: "medium" },
      ],
      mitigationSuggestions: [
        "手指动作拆成三个固定特写",
        "钥匙串只做局部反光，手指捏住单把钥匙",
      ],
    });
    expect(pairs[1]).toContain("钥匙串");
    expect(pairs[2]).toContain("参考帧");
    expect(pairs[2]).not.toContain("手指动作");
  });

  it("微质感和钨丝起亮风险只接受对应缓解，缺失时使用专属兜底", () => {
    const pairs = pairRiskMitigations({
      technicalRisks: [
        { risk: "指纹印、磨白按键和发黄塑料的微质感容易糊成噪点", level: "high" },
        { risk: "钨丝由暗转亮的起亮过程容易闪烁和形状漂移", level: "medium" },
      ],
      mitigationSuggestions: [
        "把手部动作拆成三个短特写",
        "用门扇遮挡完成冷暖切换并锁定色温",
      ],
    });
    expect(pairs[0]).toContain("微距");
    expect(pairs[0]).toContain("固定机位");
    expect(pairs[1]).toContain("钨丝");
    expect(pairs[1]).toContain("暗态");
  });

  it("爪心空接与结尾收束风险按语义配对，不串用缓解", () => {
    const pairs = pairRiskMitigations({
      technicalRisks: [
        { risk: "橘猫爪心空接雨滴并溅起水花，指甲和肉垫容易穿模", level: "high" },
        { risk: "橘猫缩回箱内盘成一团，尾巴穿模且尾尖无法贴合鼻头", level: "high" },
      ],
      mitigationSuggestions: [
        "把爪心空接、溅花和缩爪拆成三个微距镜头，真实水花用高速实拍插入",
        "把结尾收束拆成低头、尾尖扫入遮鼻、固定中近景静止三镜",
      ],
    });
    expect(pairs[0]).toMatch(/爪心空接|爪部动作/u);
    expect(pairs[0]).not.toContain("结尾收束");
    expect(pairs[1]).toMatch(/结尾收束|蜷缩|尾巴/u);
  });

  it("无台词口径与场景动作冲突时，保留旁白的画外属性并移除口型台词", () => {
    const discovery = {
      sceneStructure: {
        opening: { purpose: "人物推开房门", keyElements: ["钥匙", "门"] },
        scenes: [{ purpose: "删掉这镜，观众会失去悬念；人物拧动台灯旋钮", keyElements: ["台灯旋钮"] }],
        ending: { purpose: "镜头靠近灯罩，陈卓轻声说：“我回来了”。", keyElements: ["台灯"] },
        sceneCount: 8,
      },
    };
    normalizeNarrativeDiscovery(discovery, 30, {
      dialogue_requirement: "全片无对白；音效保留一声“咔哒”，结尾可加一句气声旁白“原来你还在”",
    });
    const sceneStructure = discovery.sceneStructure as unknown as {
      ending: { purpose: string };
      scenes: Array<{ purpose: string }>;
      sceneCount: number;
      totalDuration: number;
    };
    const ending = sceneStructure.ending.purpose;
    expect(ending).not.toContain("轻声说");
    expect(ending).toContain("画外旁白");
    expect(ending).toContain("原来你还在");
    expect(sceneStructure.sceneCount).toBe(1);
    expect(sceneStructure.totalDuration).toBe(30);
    expect(sceneStructure.scenes[0]!.purpose).not.toContain("删掉这镜");
    expect(sceneStructure.scenes[0]!.purpose).not.toContain("观众会失去");
  });

  it("不加字幕不会误删明确保留的画外旁白", () => {
    const discovery: Record<string, unknown> = {
      sceneStructure: {
        opening: { purpose: "陈卓收起雨伞，走进昏暗的客厅", duration: 14 },
        scenes: [],
        ending: { purpose: "画外旁白：“雨停了，该回家了。”陈卓按下台灯开关", duration: 16 },
      },
    };
    normalizeNarrativeDiscovery(discovery, 30, {
      dialogue_requirement: "不加字幕，保留一句画外旁白：“雨停了，该回家了。”",
    });
    const ending = String((discovery.sceneStructure as any).ending.purpose);
    expect(ending).toContain("画外旁白");
    expect(ending).toContain("雨停了，该回家了");
    expect(discovery._contractRepairs ?? []).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "DISALLOWED_VOICEOVER_REMOVED" }),
    ]));
  });

  it("无台词合同删除长句中部“轻声说”引语并修复残缺结尾", () => {
    const discovery: Record<string, unknown> = {
      sceneStructure: {
        opening: { purpose: "陈卓收伞进门", duration: 5, keyElements: ["雨伞", "门"] },
        scenes: [{
          purpose: "陈卓拧亮旧台灯，暖黄光圈把雨窗收进室内，他坐下后肩线松下来，指腹摩挲杯壁，雨声从街道噪音变成室内底噪。最后切到杯壁反光里的雨痕特写，他轻声说「雨声，先别停。」",
          duration: 5,
          keyElements: ["台灯", "杯", "窗"],
        }],
        ending: { purpose: "」不是讲道理，而是让‘收留’落在指尖和雨声里。", duration: 5, keyElements: ["台灯", "杯"] },
      },
    };
    normalizeNarrativeDiscovery(discovery, 15, {
      _originalStoryText: "雨夜，陈卓收伞回到出租屋，开门、换鞋、拧亮旧台灯，随后坐在灯下安静地听雨。全片无台词、无旁白、无字幕，仅保留动作与环境声。",
      dialogue_requirement: "全片无台词、无旁白、无字幕，仅保留动作与环境声。",
    });
    const scene = discovery.sceneStructure as any;
    expect(String(scene.scenes[0].purpose)).not.toContain("雨声，先别停");
    expect(String(scene.scenes[0].purpose)).not.toContain("轻声说");
    expect(String(scene.ending.purpose)).not.toMatch(/^」|不是讲道理/u);
  });

  it("无台词合同删除未引号的“一句台词”元话语", () => {
    const discovery: Record<string, unknown> = {
      sceneStructure: {
        opening: { purpose: "陈卓收伞进门", duration: 5, keyElements: ["雨伞"] },
        scenes: [],
        ending: {
          purpose: "陈卓坐下听雨，一个特写收住整夜的雨，一句台词让孤独有了归处。",
          duration: 10,
          keyElements: ["台灯"],
        },
      },
    };
    normalizeNarrativeDiscovery(discovery, 15, {
      _originalStoryText: "陈卓收伞回到出租屋，坐下听雨。全片无台词、无旁白、无字幕，仅保留动作与环境声。",
      dialogue_requirement: "全片无台词、无旁白、无字幕，仅保留动作与环境声。",
    });
    const ending = String((discovery.sceneStructure as any).ending.purpose);
    expect(ending).toContain("坐下听雨");
    expect(ending).not.toContain("一句台词");
  });

  it("无台词且明确无旁白时删除画外句，并把超时分镜按目标时长重投影", () => {
    const discovery: Record<string, unknown> = {
      audienceProfile: { contentExpectations: ["钉子台词在第50秒以旁白出现"] },
      sceneStructure: {
        opening: { purpose: "雨夜街口，橘猫从纸箱探头", duration: 6, keyElements: ["纸箱"] },
        scenes: [
          { purpose: "橘猫伸爪接屋檐滴水", duration: 6, keyElements: ["屋檐", "水滴"] },
          { purpose: "橘猫缩回纸箱", duration: 9, keyElements: ["纸箱"] },
        ],
        ending: { purpose: "画外极轻一句“最后一滴，也算等过。”它盘成一团。", duration: 9, keyElements: ["橘猫"] },
      },
    };
    normalizeNarrativeDiscovery(discovery, 15, {
      _originalStoryText: "雨后夜晚，一只橘猫从纸箱探头，伸爪接水，最后坐回纸箱。无人物，无品牌，无字幕，无旁白。",
      dialogue_requirement: "无台词、无旁白、无字幕，仅保留环境声。",
    });
    const scene = discovery.sceneStructure as any;
    expect(scene.opening.duration + scene.scenes[0].duration + scene.scenes[1].duration + scene.ending.duration).toBeCloseTo(15, 3);
    expect(scene.ending.purpose).not.toContain("画外");
    expect(scene.ending.purpose).not.toContain("最后一滴");
    expect((discovery.audienceProfile as any).contentExpectations[0]).toContain("站外转发文案");
    expect(discovery._contractRepairs).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "DISALLOWED_SPEECH_REMOVED" }),
      expect.objectContaining({ code: "SCENE_DURATION_REBALANCED" }),
      expect.objectContaining({ code: "EXTERNAL_COPY_SEPARATED" }),
    ]));
  });

  it("无台词且未声明旁白时仍按全语音禁止处理", () => {
    const discovery: Record<string, unknown> = {
      sceneStructure: {
        opening: { purpose: "人物推门", duration: 5 },
        scenes: [],
        ending: { purpose: "人物轻声说：“我回来了”", duration: 5 },
      },
    };
    normalizeNarrativeDiscovery(discovery, 10, { dialogue_requirement: "无台词" });
    expect(String((discovery.sceneStructure as any).ending.purpose)).not.toContain("我回来了");
    expect(discovery._contractRepairs).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "DISALLOWED_SPEECH_REMOVED" }),
    ]));
    const markdown = normalizeNarrativeRequirementMarkdown(
      "01.【结尾】人物轻声说：“我回来了”",
      discovery,
      10,
      { dialogue_requirement: "无台词" },
    );
    expect(markdown).not.toContain("我回来了");
  });

  it("允许简短对白但禁止旁白时不会把合法对白当成全语音禁止", () => {
    const upstream = {
      _originalStoryText: "两位厨师连续配合，一人拉面、一人看火并递碗，最后同时把两碗面放到窗口。允许简短对白，但不得添加字幕和旁白。",
      dialogue_requirement: "允许简短对白，但不得添加字幕和旁白。",
    };
    const discovery: Record<string, unknown> = {
      sceneStructure: {
        opening: { purpose: "两位厨师同时说：“面好了。”然后把碗放到窗口", keyElements: ["碗"] },
        scenes: [{ purpose: "画外旁白：“面再煮一会儿。”镜头观察蒸汽", keyElements: ["蒸汽"] }],
        ending: { purpose: "两人相视点头，环境声收束", keyElements: ["窗口"] },
      },
    };
    normalizeNarrativeDiscovery(discovery, 30, upstream);
    expect(String((discovery.sceneStructure as any).opening.purpose)).toContain("面好了");
    expect(String((discovery.sceneStructure as any).scenes[0].purpose)).not.toContain("面再煮一会儿");
    expect(normalizeNarrativeRequirementMarkdown(
      "- **台词/字幕口径**：允许简短对白，但不得添加字幕和旁白",
      discovery,
      30,
      upstream,
    )).toContain("允许简短对白");
    const prd = normalizeNarrativePrdContract({
      projectDefinition: { sourceIntent: upstream._originalStoryText },
      productPositioning: { targetDuration: 30, aspectRatio: "9:16", targetPlatform: "douyin" },
      scenePlan: {
        scenes: [{ sceneId: "SC01", duration: 30, purpose: "两位厨师配合出餐", dialogue: "面好了", audioRequirements: ["简短对白", "厨房环境声"] }],
        shotMapping: [{ sceneId: "SC01", estimatedShots: 2, shotBreakdownHint: ["medium", "close"] }],
      },
      characterSystem: { characters: [{ name: "两位厨师", role: "protagonist" }] },
      deliveryStandard: { deliverables: [{ item: "video_master" }], outputFormat: {} },
    }, { upstreamFields: upstream, _canonicalCharacters: [{ id: "char_1", name: "两位厨师", role: "protagonist" }] });
    const scene = (prd.scenePlan as any).scenes[0];
    expect(scene.dialogue).toBe("面好了");
    expect(scene.audioRequirements).toContain("简短对白");
  });

  it("无动物不等于无人物，人物片仍保留角色与镜头主体绑定", () => {
    const upstream = {
      _originalStoryText: "陈卓在雨夜归家，发现旧台灯依然温暖；无动物，保留简短对白。",
      dialogue_requirement: "保留简短对白，无动物。",
    };
    const prd = normalizeNarrativePrdContract({
      projectDefinition: { sourceIntent: upstream._originalStoryText },
      productPositioning: { targetDuration: 15, aspectRatio: "9:16", targetPlatform: "douyin" },
      characterSystem: { characters: [{ characterId: "char_1", name: "陈卓", role: "protagonist" }] },
      scenePlan: {
        scenes: [{ sceneId: "SC01", duration: 15, purpose: "陈卓推门回家并拧亮台灯" }],
        shotMapping: [{ sceneId: "SC01", estimatedShots: 3, shotBreakdownHint: ["medium", "close-up", "wide"] }],
      },
      deliveryStandard: { deliverables: [{ item: "video_master" }], outputFormat: {} },
    }, {
      upstreamFields: upstream,
      _canonicalCharacters: [{ id: "char_1", name: "陈卓", role: "protagonist" }],
    });
    expect((prd.characterSystem as any).characters).toEqual([
      expect.objectContaining({ characterId: "char_1", name: "陈卓" }),
    ]);
    expect((prd.shotContract as any[]).every((shot) => shot.subjectIds.includes("char_1"))).toBe(true);
  });

  it("G6 前重新投影被标题、画幅和音频增强污染的最终提示词", () => {
    const policy = {
      noDialogue: true,
      maxLength: 3000,
      noCharacters: false,
      noAnimals: true,
      noMusic: true,
      noTitles: true,
      durationSeconds: 5,
      aspectRatio: "9:16",
      resolution: "1080x1920",
      characterNames: ["陈卓"],
      characterPortraits: [{ name: "陈卓", path: "bundles/ai-video/library/characters/model-01-chen-zhuo/portraits/v3/平江路讲述人-front.png" }],
      projectScene: "雨夜出租屋",
      projectLighting: "旧台灯2800K暖光",
      projectColor: "冷蓝与暖黄",
      projectProps: ["旧台灯"],
      projectActions: ["陈卓拧亮旧台灯"],
    };
    const clean = applyNarrativeFinalPromptContract({
      shotId: "S1",
      duration: 5,
      dialogue: "",
      dialogueText: "",
      dialogueBlocks: [],
      fields: {},
    }, {
      ...policy,
      chineseOnly: true,
      canonicalize: true,
      shotIndex: 0,
      isLastShot: true,
    });
    const contaminated = {
      ...clean,
      prompt: `${String(clean.prompt).replace("04.【约束】9:16画幅，1080x1920", "04.【约束】16:9画幅，1920x1080")}
27.【主标题内容】雨夜那盏旧灯
28.【副标题内容】他擦亮钨丝灯
29.【标题动画设计】出现短暂过曝半档
30.【开场音频设计】加入大提琴泛音`,
    };
    const [normalized] = normalizeNarrativePromptsForReview([contaminated], policy);
    expect(String(normalized!.prompt)).toContain("04.【约束】9:16画幅，1080x1920");
    expect(String(normalized!.prompt)).toContain("18.【台词】不适用：本片无台词、无旁白、无口播。");
    expect(String(normalized!.prompt)).not.toContain("【主标题内容】");
    expect(String(normalized!.prompt)).not.toContain("大提琴");
    expect(inspectFinalShotContract([normalized!], { maxPromptLength: 3000, noDialogue: true }).pass).toBe(true);
  });

  it("G6 逐镜使用各自冻结场景，并删除无标题合同的片头附加字段和旧长度", () => {
    const base = {
      noDialogue: true,
      maxLength: 3000,
      noCharacters: false,
      noAnimals: true,
      noMusic: true,
      noTitles: true,
      durationSeconds: 3,
      aspectRatio: "9:16",
      resolution: "1080x1920",
      characterNames: ["陈卓"],
      characterPortraits: [{ name: "陈卓", path: "bundles/ai-video/library/characters/model-01-chen-zhuo/portraits/v3/平江路讲述人-front.png" }],
      projectScene: "错误的全片场景合集",
      projectLighting: "冷蓝雨光",
      projectColor: "冷蓝与暖黄",
      projectProps: ["雨伞", "台灯"],
      projectActions: ["收伞回到出租屋", "开门", "坐下听雨"],
    };
    const shots = [
      {
        shotId: "S1", duration: 3, sceneType: "opening", promptCharCount: 100,
        title_content: "错误标题", subtitle_content: "错误副标题", title_animation: "4秒越界",
        opening_audio_design: "大提琴长音", fields: { title_content: "错误标题" },
        prompt: "01.【场景】错误场景", _workloomPromptReviewPolicy: { ...base, projectScene: "雨夜楼道门外", projectActions: ["收伞回到出租屋"] },
      },
      {
        shotId: "S2", duration: 3,
        prompt: "01.【场景】错误场景", _workloomPromptReviewPolicy: { ...base, projectScene: "出租屋玄关", projectActions: ["开门"] },
      },
      {
        shotId: "S3", duration: 3,
        prompt: "01.【场景】错误场景", _workloomPromptReviewPolicy: { ...base, projectScene: "出租屋窗边", projectActions: ["坐下听雨"] },
      },
    ];
    const normalized = normalizeNarrativePromptsForReview(shots, base);
    expect(String(normalized[0]!.prompt)).toContain("【场景】雨夜楼道门外");
    expect(String(normalized[1]!.prompt)).toContain("【场景】出租屋玄关");
    expect(String(normalized[2]!.prompt)).toContain("【场景】出租屋窗边");
    for (const shot of normalized) {
      expect(shot.promptCharCount).toBe(String(shot.prompt).length);
      expect(shot.title_content).toBeUndefined();
      expect(shot.subtitle_content).toBeUndefined();
      expect(shot.title_animation).toBeUndefined();
      expect(shot.title_font_design).toBeUndefined();
      expect(shot.opening_audio_design).toBeUndefined();
      expect(shot.fields).not.toHaveProperty("title_content");
    }
  });

  it("归家动作逐镜约束门外、开门、换鞋、开灯与落座的场景灯态和道具", () => {
    expect(deriveNarrativeShotDirection({ action: "收伞回到出租屋" })).toMatchObject({
      scene: expect.stringContaining("人物尚未进入出租屋"),
      lighting: expect.stringContaining("旧台灯关闭"),
      color: expect.stringContaining("冷蓝"),
      props: expect.arrayContaining(["雨伞"]),
    });
    expect(deriveNarrativeShotDirection({ action: "开门" })).toMatchObject({
      scene: expect.stringContaining("由门外进入玄关"),
      props: expect.arrayContaining(["门"]),
    });
    expect(deriveNarrativeShotDirection({ action: "换鞋" })).toMatchObject({
      scene: expect.stringContaining("玄关内侧"),
      props: expect.arrayContaining(["白色湿便鞋", "室内拖鞋"]),
    });
    expect(deriveNarrativeShotDirection({
      action: "陈卓脱下白色湿便鞋，换穿室内拖鞋",
      fallbackColor: "2700K",
    })).toMatchObject({
      scene: expect.stringContaining("门已关上"),
      color: expect.stringContaining("冷蓝灰"),
      props: expect.arrayContaining(["鞋架", "白色湿便鞋", "室内拖鞋"]),
    });
    expect(deriveNarrativeShotDirection({ action: "拧亮旧台灯" })).toMatchObject({
      scene: expect.stringContaining("台灯"),
      lighting: expect.stringMatching(/起幅.*关闭.*2700K/),
      color: expect.stringContaining("2700K"),
      props: expect.arrayContaining(["旧台灯", "旋钮"]),
    });
    expect(deriveNarrativeShotDirection({ action: "坐下听雨" })).toMatchObject({
      scene: expect.stringContaining("灯下窗边"),
      lighting: expect.stringMatching(/2700K.*冷蓝/),
      color: expect.stringContaining("2700K"),
      props: expect.arrayContaining(["台灯", "窗", "坐具"]),
    });
  });

  it("六镜归家合同补齐关门状态，并逐镜区分鞋态、情绪、时间轴和场景", () => {
    const actions = projectNarrativeActionSequence([
      "收伞回到出租屋",
      "开门",
      "换鞋",
      "拧亮旧台灯",
      "坐下听雨",
    ], 6);
    expect(actions).toEqual([
      "陈卓收伞走到出租屋门前",
      "陈卓用钥匙开门并跨进玄关",
      "陈卓回身把门关好，确认门锁落位",
      "陈卓在玄关弯腰脱下白色湿便鞋，换穿室内拖鞋",
      "陈卓伸手拧亮旧台灯",
      "陈卓在灯下坐下，抬头安静听雨",
    ]);
    const sevenShots = projectNarrativeActionSequence([
      "收伞回到出租屋",
      "开门",
      "换鞋",
      "拧亮旧台灯",
      "坐下听雨",
    ], 7);
    expect(sevenShots).toHaveLength(7);
    expect(sevenShots[3]).toContain("脱下一只白色湿便鞋");
    expect(sevenShots[4]).toContain("换穿室内拖鞋");
    const policy = {
      noDialogue: true,
      maxLength: 3000,
      noCharacters: false,
      noAnimals: false,
      noMusic: true,
      noTitles: true,
      durationSeconds: 15,
      aspectRatio: "9:16",
      resolution: "1080x1920",
      characterNames: ["陈卓"],
      characterPortraits: [{
        name: "陈卓",
        path: "bundles/ai-video/library/characters/model-01-chen-zhuo/portraits/v3/平江路讲述人-front.png",
        appearance: "东亚女性，深栗棕发，自然通勤外观",
        costume: "米白针织开衫、深色直筒长裤，配小白鞋",
        authorization: "real-authorized",
        sha256: "3d177401ed014376992489da04d2e35977ca282c205edc43bc8f6dca2f9a8184",
        bytes: 190978,
      }],
      projectScene: "雨夜出租屋",
      projectLighting: "台灯冷暖分区",
      projectColor: "冷蓝与暖黄",
      projectProps: ["旧台灯", "旧帆布鞋", "湿鞋"],
      projectActions: actions,
    };
    const durations = [2, 3, 2, 2, 4, 2];
    const shotSizes = ["extreme-close-up", "medium", "medium", "medium", "close-up", "close-up"];
    const prompts = normalizeNarrativePromptsForReview(
      durations.map((duration, index) => ({
        shotId: `S${index + 1}`,
        duration,
        shotSize: shotSizes[index],
        prompt: "01.【场景】错误模板",
        fields: {},
      })),
      policy,
    );
    const contracts = prompts.map((row) => row._workloomShotContract as Record<string, unknown>);
    expect(contracts.map((contract) => contract.action)).toEqual(actions);
    expect(((prompts[0]!.fields as Record<string, unknown>)._workloomShotContract as Record<string, unknown>).shotId).toBe("S1");
    expect(((prompts[0]!._workloomPromptReviewPolicy as Record<string, unknown>).shotContract as Record<string, unknown>).shotId).toBe("S1");
    expect(String(contracts[2]!.space)).toContain("门扇正从开启位置合拢");
    expect(String(contracts[2]!.timeline)).toContain("湿伞靠到门边");
    expect(String(contracts[0]!.costume)).toMatch(/白色便鞋.*雨水打湿/u);
    expect(String(contracts[3]!.costume)).toMatch(/起幅双脚仍穿.*前段第一只脚.*末段第二只脚.*双脚/u);
    expect(String(contracts[3]!.shotSize)).toBe("full");
    expect(String(contracts[5]!.costume)).toContain("室内拖鞋");
    expect(prompts.map((prompt) => prompt.duration)).toEqual([3, 2, 2, 4, 2, 2]);
    expect(String(contracts[3]!.timeline)).toMatch(/第一只脚离开湿鞋.*第二只鞋跟松脱.*双脚站稳/u);
    expect(String(prompts[3]!.prompt)).toContain("两只鞋都换好、双脚站稳后硬切到开灯镜");
    expect(new Set(contracts.map((contract) => String(contract.emotion))).size).toBe(6);
    for (const contract of contracts) {
      expect(String(contract.timeline)).toMatch(/T00:00.*T00:.*T00:/u);
      expect((contract.portraitAssets as Array<Record<string, unknown>>)[0]).toMatchObject({
        authorization: "real-authorized",
        sha256: "3d177401ed014376992489da04d2e35977ca282c205edc43bc8f6dca2f9a8184",
      });
    }
    expect(String(prompts[0]!.prompt)).not.toMatch(/旧帆布鞋|湿鞋、拖鞋/u);
    expect(String(prompts[5]!.prompt)).toContain("脚穿室内拖鞋");
  });

  it("七镜归家合同把两只湿便鞋拆成不同时间轴、情绪和鞋态", () => {
    const actions = projectNarrativeActionSequence(["收伞回到出租屋", "开门", "换鞋", "拧亮旧台灯", "坐下听雨"], 7);
    const options = {
      noDialogue: true,
      maxLength: 3000,
      noCharacters: false,
      noAnimals: false,
      noMusic: true,
      chineseOnly: true,
      canonicalize: true,
      noTitles: true,
      durationSeconds: 2,
      aspectRatio: "9:16",
      resolution: "1080x1920",
      characterNames: ["陈卓"],
      characterPortraits: [{
        name: "陈卓",
        path: "bundles/ai-video/library/characters/model-01-chen-zhuo/portraits/v3/平江路讲述人-front.png",
        costume: "米白针织开衫、深色直筒长裤，配小白鞋",
        authorization: "real-authorized",
      }],
      projectScene: "出租屋玄关内侧，门已关上，旧台灯关闭",
      projectLighting: "旧台灯关闭，仅窗外与门缝冷光",
      projectColor: "冷蓝灰环境色",
      projectProps: ["黑色折叠伞", "鞋架", "地垫", "白色湿便鞋", "室内拖鞋"],
      projectActions: actions,
    };
    const first = applyNarrativeFinalPromptContract({ shotId: "SC-4", duration: 2 }, { ...options, shotIndex: 3 });
    const second = applyNarrativeFinalPromptContract({ shotId: "SC-5", duration: 2 }, { ...options, shotIndex: 4 });
    const firstPrompt = String(first.prompt);
    const secondPrompt = String(second.prompt);
    expect(firstPrompt).toContain("第一只鞋跟松脱");
    expect(secondPrompt).toContain("第二只鞋跟松脱");
    expect(firstPrompt).not.toBe(secondPrompt);
    expect(firstPrompt).toMatch(/另一只脚仍穿(?:白色)?湿便鞋/u);
    expect(secondPrompt).toMatch(/另一脚仍穿白色湿便鞋/u);
    expect(secondPrompt).toContain("白色湿便鞋");
    expect(secondPrompt).toContain("鞋架");
    expect(firstPrompt).toMatch(/【情绪】[^\n]*第一只湿便鞋/u);
    expect(secondPrompt).toMatch(/【情绪】[^\n]*另一只湿便鞋/u);
    expect(firstPrompt).toMatch(/【情绪】[^\n]*鞋跟、脚踝和支撑脚/u);
    expect(secondPrompt).toMatch(/【情绪】[^\n]*鞋跟、脚踝和拖鞋入口/u);
    expect(firstPrompt).not.toMatch(/【情绪】[^\n]*(?:眼睫|瞳孔)/u);
    expect(secondPrompt).not.toMatch(/【情绪】[^\n]*(?:眼睫|瞳孔)/u);
    expect(firstPrompt).toMatch(/【转场】[^\n]*另一只鞋/u);
    expect(secondPrompt).toMatch(/【转场】[^\n]*两只室内拖鞋/u);
  });

  it("G6 最终归一删除开灯与听雨场景中的或式二义", () => {
    const base = {
      noDialogue: true,
      maxLength: 3000,
      noCharacters: false,
      noAnimals: false,
      noMusic: true,
      noTitles: true,
      durationSeconds: 4,
      aspectRatio: "9:16",
      resolution: "1080x1920",
      characterNames: ["陈卓"],
      characterPortraits: [{
        name: "陈卓",
        path: "bundles/ai-video/library/characters/model-01-chen-zhuo/portraits/v3/平江路讲述人-front.png",
        authorization: "real-authorized",
      }],
      projectScene: "出租屋室内",
      projectLighting: "窗外冷光",
      projectColor: "冷蓝灰",
      projectProps: ["旧台灯", "窗"],
      projectActions: [],
    };
    const normalized = normalizeNarrativePromptsForReview([
      {
        shotId: "S1",
        duration: 2,
        prompt: "01.【场景】错误模板",
        _workloomPromptReviewPolicy: {
          ...base,
          projectScene: "出租屋室内灯旁：台灯、开关或旋钮与操作手部同框",
          projectActions: ["陈卓伸手拧亮旧台灯"],
        },
      },
      {
        shotId: "S2",
        duration: 2,
        prompt: "01.【场景】错误模板",
        _workloomPromptReviewPolicy: {
          ...base,
          projectScene: "出租屋室内窗边或灯下：坐具、旧台灯、窗与雨痕在同一空间",
          projectActions: ["陈卓在灯下坐下，抬头安静听雨"],
        },
      },
    ], base);
    expect(String(normalized[0]!.prompt)).toContain("旧台灯旋钮、灯罩与操作手部同框");
    expect(String(normalized[0]!.prompt)).not.toContain("开关或旋钮");
    expect(String(normalized[1]!.prompt)).toContain("灯下窗边");
    expect(String(normalized[1]!.prompt)).not.toContain("窗边或灯下");
  });

  it("G7 收口报告内联完整三件套、哈希、时间轴与未提交的 G8 边界", () => {
    const fullScene = "雨夜出租屋玄关：门已经关上，湿伞靠墙，鞋架、地垫、门后挂钩与旧台灯处在同一可见空间，人物正从门外进入。";
    const portraitPath = "bundles/ai-video/library/characters/model-01-chen-zhuo/portraits/v3/平江路讲述人-front.png";
    const portraitSha = "3d177401ed014376992489da04d2e35977ca282c205edc43bc8f6dca2f9a8184";
    const prompt = "01.【语言约束】全部字段使用中文。\n02.【场景】" + fullScene + "\n03.【动作】陈卓收伞后开门。\n04.【灯光设计】旧台灯关闭。";
    const promptContract = {
      schema: "workloom.prompt-shot-contract/v1",
      shotId: "S-1",
      durationSeconds: 3,
      space: fullScene,
      action: "陈卓收伞后开门",
      lighting: "旧台灯关闭；门外冷光进入",
      color: "冷蓝灰",
      shotSize: "medium",
      camera: "固定机位",
      props: ["黑色折叠伞", "旧防盗门", "钥匙"],
      portraitAssets: [{
        name: "陈卓",
        path: portraitPath,
        authorization: "real-authorized",
        sha256: portraitSha,
      }],
    };
    const report = renderPreproductionAuditReport({
      productionResult: {
        shots: [{
          shotId: "S-1",
          duration: 3,
          sceneType: "opening",
          scene: "错误：黎明山谷雾景",
          action: "错误：画面内没有人物动作",
          lighting: "错误：4200K山谷天光",
        }],
        prompts: [{
          shotId: "S-1",
          duration: 3,
          prompt,
          fields: { _workloomShotContract: promptContract },
          _workloomPromptReviewPolicy: { shotContract: promptContract },
        }],
      },
      scriptResult: {
        blueprint: {
          character_system: {
            characters: [
              { characterId: "chen-zhuo", name: "陈卓", authorization: "real-authorized" },
              { characterId: "陈卓", name: "陈卓", authorization: "unknown", _auto_stub: true },
            ],
          },
          structure: { scenes: [{ sceneId: "SC01", purpose: "错误旧脚本动作", duration: 3 }] },
        },
      },
      timing: {},
      confirmations: {
        portraitGeneration: { approved: true, reason: "audit-portrait-gate-not-applicable" },
      },
      effectiveMs: 126_000,
    });
    expect(report).toContain(fullScene);
    expect(report).toContain("陈卓收伞后开门");
    expect(report).toContain(prompt);
    expect(report).not.toContain("错误：黎明山谷雾景");
    expect(report).not.toContain("错误：画面内没有人物动作");
    expect(report).not.toContain("错误旧脚本动作");
    expect(report).toContain("脚本证据按最终提示词绑定的镜头合同重投影");
    expect(report).toContain("镜头 ID 与提示词 ID 一一对应：是");
    expect(report).toContain("有效处理时间：126000ms（2.1分钟）");
    expect(report).toContain("定妆照生成：not_applicable");
    expect(report).toContain("源角色资产：verified");
    expect(report).toContain(portraitSha);
    expect(report).toContain("角色数：1");
    expect(report).toContain("授权=real-authorized");
    expect(report).not.toContain("角色数：2");
    expect(report).not.toContain("授权=unknown");
    expect(report).toContain("本轮未生成新定妆照，仅复用已登记源资产");
    expect(report).toContain("workloom.preproduction-contract/v1");
    expect(report).toContain("镜头卡与提示词语义绑定：通过");
    expect(report).toContain("G8");
    expect(report).toContain("渲染提交：否");
    expect(report).toMatch(/镜头卡：1 镜，sha256=[a-f0-9]{64}/u);
    expect(report).toMatch(/提示词正文：1 条，sha256=[a-f0-9]{64}/u);
    expect(report).not.toContain("请回复");
    expect(report).not.toMatch(/场景描述[^\n]*\.\.\./u);
  });

  it("G6 审核报告不再追加无标题片头字段、旧长度和裸编号", () => {
    const script = `
import { createRequire } from "node:module";
import { installVendorNarrativePromptReviewBridge } from ${JSON.stringify(resolve(here, "vendor-compat.ts"))};
const require = createRequire(${JSON.stringify(join(repoRoot, "package.json"))});
const { HyperrealitySystem } = require(${JSON.stringify(join(repoRoot, "vendor/supermickey/hyperreality-system/index.js"))});
const originalFormat = HyperrealitySystem.prototype._formatPromptWithSequenceNumbers;
const originalReport = HyperrealitySystem.prototype._generatePromptsReport;
const uninstall = installVendorNarrativePromptReviewBridge({ log: () => undefined });
const prompt = [
  "01.【语言约束】全部字段使用中文。",
  "02.【场景】雨夜出租屋楼道。",
  "03.【动作】陈卓收伞。",
  "04.【台词】不适用：本片无台词。",
].join("\\n");
const row = { shotId: "S1", sceneType: "opening", duration: 3, prompt, promptCharCount: 100,
  title_content: "错误标题", title_animation: "4秒越界", opening_audio_design: "大提琴长音",
  _workloomPromptReviewPolicy: { noTitles: true },
  _workloomShotContract: { schema: "workloom.prompt-shot-contract/v1", shotId: "S1", durationSeconds: 3,
    space: "雨夜楼道门外", action: "陈卓收伞走到门前", era: "当代", equipment: "固定三脚架",
    portraitAssets: [{ name: "陈卓", path: "portrait.jpg", authorization: "real-authorized", sha256: "abc" }] } };
const instance = Object.create(HyperrealitySystem.prototype);
const report = instance._generatePromptsReport([row]);
uninstall();
console.log("RESULT " + JSON.stringify({
  report,
  headingOpening: report.includes("S1(片头·30字段)"),
  hasStaleLength: report.includes("S1 | 3s | 100"),
  hasTitle: report.includes("主标题内容") || report.includes("大提琴"),
  hasBareNumber: /^\\d{2}\\.$/mu.test(report),
  hasStructuredContract: report.includes("workloom.prompt-review-contract/v1")
    && report.includes("open_then_closed") === false
    && report.includes("real-authorized"),
  restored: originalFormat === HyperrealitySystem.prototype._formatPromptWithSequenceNumbers
    && originalReport === HyperrealitySystem.prototype._generatePromptsReport
}));
`;
    const result = runInChild(script);
    expect(result.headingOpening).toBe(false);
    expect(result.hasStaleLength).toBe(false);
    expect(result.hasTitle).toBe(false);
    expect(result.hasBareNumber).toBe(false);
    expect(result.hasStructuredContract).toBe(true);
    expect(result.restored).toBe(true);
    expect(String(result.report)).toMatch(/\| S1 \| 3s \| \d+ \| ❌ 4\/25 \|/u);
    expect(String(result.report)).not.toContain("| S1 | 3s | 100 |");
  }, 60_000);

  it("PRD 把真实模型的配乐、复合光位和主观阈值收敛成可执行合同", () => {
    const discovery = {
      upstreamFields: {
        duration_sec: 15,
        platform_id: "douyin",
        aspect_ratio: "9:16",
        dialogue_requirement: "全片无台词、无旁白、无字幕，仅保留动作与环境声。",
        _originalStoryText: "雨夜，一个年轻人收伞回到出租屋，开门、换鞋、拧亮旧台灯，随后坐在灯下安静地听雨。全片无台词、无旁白、无字幕，仅保留动作与环境声。",
      },
      _canonicalCharacters: [{
        id: "chen-zhuo",
        name: "陈卓",
        role: "protagonist",
        portraitRef: "bundles/ai-video/library/characters/model-01-chen-zhuo/portraits/v3/平江路讲述人-front.png",
        authorization: "real-authorized",
      }],
    };
    const prd = normalizeNarrativePrdContract({
      projectDefinition: { sourceIntent: discovery.upstreamFields._originalStoryText },
      productPositioning: { targetDuration: 15, aspectRatio: "9:16", targetPlatform: "douyin" },
      characterSystem: { characters: [{ name: "陈卓", role: "protagonist" }] },
      visualSpecification: { lightingDirection: "旧台灯2700K暖光与窗外6500K冷蓝雨光分区" },
      audioSpecification: {
        musicStyle: "极简氛围弦乐与低频脉冲",
        soundDesign: "雨声、门锁声、换鞋声、台灯开关声",
        voicePolicy: "无人物声",
        audioMood: "低频脉冲",
        audioReferences: ["大提琴泛音"],
      },
      scenePlan: {
        scenes: [{
          sceneId: "SC01",
          sequence: 1,
          duration: 15,
          purpose: "第一帧只拍伞尖水珠、鞋底湿印；随后陈卓开门、换鞋、坐下",
          setting: "雨夜出租屋玄关",
          keyProps: ["湿伞", "湿鞋印", "旧皮鞋", "门锁", "旧台灯"],
          visualRequirements: [
            "第一帧只拍伞尖水珠坠落地砖与鞋底湿印；窗外6500K冷蓝雨光勾边，台灯2700K从右侧门缝渗入",
            "陈卓换鞋；2700K钨丝台灯为唯一暖源，窗外6500K冷蓝雨光压暗",
            "陈卓坐下听雨；台灯2700K暖光从右侧照亮肩背，窗外6500K冷蓝光勾左侧轮廓",
          ],
          audioRequirements: ["雨声持续底噪", "门锁转动声", "换鞋声", "台灯开关声"],
          dialogue: "",
        }],
        shotMapping: [{ sceneId: "SC01", estimatedShots: 3, shotBreakdownHint: ["establishing", "close-up", "medium"] }],
      },
      productionConstraints: {
        technicalConstraints: ["不使用配乐，仅保留动作与环境声"],
        qualityThresholds: { visual: 0.8, audio: 0.75, narrative: 0.85, consistency: 0.75 },
      },
      deliveryStandard: {
        deliverables: [{ item: "video_master", spec: "MP4" }],
        acceptanceCriteria: { visual: 0.8, audio: 0.75, narrative: 0.85, consistency: 0.75 },
        outputFormat: {},
      },
    }, discovery);
    const serialized = JSON.stringify(prd);
    expect(serialized).not.toMatch(/弦乐|低频脉冲|大提琴泛音/u);
    expect(serialized).toContain("不使用配乐");
    const shots = prd.shotContract as Array<Record<string, unknown>>;
    expect(shots).toHaveLength(3);
    for (const shot of shots) {
      expect(String(shot.lighting).length).toBeLessThanOrEqual(160);
      expect(String(shot.colorTemperature).match(/\d{4}\s*K/gu)).toHaveLength(1);
    }
    expect(shots[0]).toMatchObject({
      subjectIds: [],
      subjectLabel: expect.stringMatching(/道具|局部/u),
    });
    expect(shots[1]!.subjectIds).toContain("chen-zhuo");
    const character = (prd.characterSystem as any).characters[0];
    expect(String(character.gender)).toMatch(/female|女性/iu);
    const delivery = prd.deliveryStandard as any;
    expect(typeof delivery.acceptanceCriteria.visual).not.toBe("number");
    expect(String(delivery.acceptanceCriteria.visual)).toContain("unverified");
    const markdown = renderPrdContractMarkdown(prd);
    expect(markdown).toContain("性别=");
    expect(markdown).toContain("道具/局部人体");
  });

  it("PRD 三场归家合同统一伞鞋灯态，补齐关门并删除单音和未开门悬念", () => {
    const story = "雨夜，一个年轻人收伞回到出租屋，开门、换鞋、拧亮旧台灯，随后坐在灯下安静地听雨。全片无台词、无旁白、无字幕，仅保留动作与环境声。";
    const prd = normalizeNarrativePrdContract({
      projectDefinition: { sourceIntent: story },
      productPositioning: { targetDuration: 15, aspectRatio: "9:16", targetPlatform: "douyin" },
      creativeCore: {
        creativeHook: "门前悬念",
        keyMessages: [],
        twistPoint: "突然出现反转",
        emotionalArc: "setup→rising→climax→resolution",
      },
      characterSystem: { characters: [{ name: "陈卓", role: "protagonist", costume: "米白开衫，配小白鞋" }] },
      visualSpecification: { lightingDirection: "旧台灯2700K暖光与窗外6500K冷蓝雨光分区" },
      audioSpecification: { musicStyle: "结尾单音极轻进入", soundDesign: "雨声、门锁声、换鞋声、台灯开关声" },
      scenePlan: {
        scenes: [
          {
            sceneId: "SC01", sequence: 1, duration: 5,
            purpose: "用伞尖滴水与门前停顿建立未开门悬念",
            setting: "楼道门口，门内未亮灯",
            keyProps: ["黑色长柄伞", "滴水伞尖", "防盗门", "钥匙"],
            visualRequirements: ["第一帧为伞尖水珠砸地", "门框前景遮挡，陈卓不掏钥匙"],
            audioRequirements: ["雨打窗棚与楼道滴水先行", "钥匙未插入前的短暂静默"],
            dialogue: "",
          },
          {
            sceneId: "SC02", sequence: 2, duration: 5,
            purpose: "通过换鞋把泥污留在门外",
            setting: "狭小玄关，门已半开，室内仅远处台灯余光",
            keyProps: ["沾泥皮鞋", "鞋柜", "地垫"],
            visualRequirements: ["低机位拍鞋底泥水蹭过地垫", "暖光只擦到玄关边缘"],
            audioRequirements: ["鞋底摩擦地垫声", "门锁转动声"],
            dialogue: "",
          },
          {
            sceneId: "SC03", sequence: 3, duration: 5,
            purpose: "拧亮旧台灯并坐下听雨",
            setting: "书桌一角，窗外冷蓝，旧台灯渐亮",
            keyProps: ["旧台灯", "旋钮开关", "书桌", "窗棂"],
            visualRequirements: ["特写手指拧动旋钮，暖光渐亮", "人物在灯下坐下听雨"],
            audioRequirements: ["台灯开关咔哒与电流微响", "结尾单音极轻进入"],
            dialogue: "",
          },
        ],
        shotMapping: [
          { sceneId: "SC01", estimatedShots: 3, shotBreakdownHint: ["extreme-close-up", "medium", "close-up"] },
          { sceneId: "SC02", estimatedShots: 2, shotBreakdownHint: ["close-up", "medium"] },
          { sceneId: "SC03", estimatedShots: 3, shotBreakdownHint: ["extreme-close-up", "medium", "static"] },
        ],
      },
      productionConstraints: { technicalConstraints: ["不使用配乐，仅保留动作与环境声"] },
      deliveryStandard: { deliverables: [{ item: "video_master", spec: "MP4" }], outputFormat: {} },
    }, {
      upstreamFields: {
        duration_sec: 15,
        platform_id: "douyin",
        aspect_ratio: "9:16",
        dialogue_requirement: "全片无台词、无旁白、无字幕，仅保留动作与环境声。",
        _originalStoryText: story,
      },
      _canonicalCharacters: [{
        id: "chen-zhuo",
        name: "陈卓",
        role: "protagonist",
        portraitRef: "bundles/ai-video/library/characters/model-01-chen-zhuo/portraits/v3/平江路讲述人-front.png",
        authorization: "real-authorized",
      }],
    });
    const serialized = JSON.stringify(prd);
    expect(serialized).not.toMatch(/黑色长柄伞|沾泥皮鞋|旧帆布鞋|小白鞋|未开门悬念|结尾单音|3000K/u);
    expect(serialized).toContain("黑色折叠伞");
    expect(serialized).toContain("白色湿便鞋");
    expect(serialized).toContain("室内拖鞋");
    expect((prd.creativeCore as any).emotionalArc).toBe("setup→rising→resolution");
    const scenes = (prd.scenePlan as any).scenes as Array<Record<string, unknown>>;
    expect(String(scenes[1]!.setting)).toMatch(/门已关闭.*旧台灯保持关闭/u);
    const shots = prd.shotContract as Array<Record<string, unknown>>;
    expect(shots).toHaveLength(7);
    expect(shots[0]).toMatchObject({
      faceVisible: true,
      subjectLabel: "陈卓",
      footwearState: "both_wet_shoes",
      lampState: "off",
    });
    expect(shots[1]).toMatchObject({ shotSize: "medium", faceVisible: true });
    expect(shots[2]).toMatchObject({ footwearState: "both_wet_shoes", lampState: "off" });
    expect(shots[3]).toMatchObject({ footwearState: "one_indoor_slipper_one_wet_shoe_on_support_foot", lampState: "off" });
    expect(shots[4]).toMatchObject({ footwearState: "one_indoor_slipper_one_wet_shoe_removing_second", lampState: "off" });
    expect(shots[5]).toMatchObject({ footwearState: "both_indoor_slippers", lampState: "off_to_on" });
    expect(shots[6]).toMatchObject({ footwearState: "both_indoor_slippers", lampState: "on" });
    expect(shots[3]!.keyProps).toContain("门后挂钩");
    expect(shots.map((shot) => shot.purpose)).toEqual([
      "陈卓收伞走到出租屋门前；第一帧为中近景，陈卓在楼道冷光中收伞，伞骨合拢且伞尖水珠落到楼道地砖，黑色折叠伞轮廓完整",
      "陈卓用钥匙开门并跨进玄关；陈卓手握钥匙停在门前，门框作前景遮挡，楼道冷光勾出人物轮廓，室内暗部无补光",
      "陈卓回身把门关好，确认门锁落位；先拍回身关门与门锁落位，固定机位保持门轴方向连续",
      "陈卓在玄关弯腰脱下一只白色湿便鞋；低机位拍第一只白色湿便鞋脱下并放到鞋架旁，脚掌离开湿鞋后保持单脚支撑，旧台灯始终关闭",
      "陈卓脱下另一只湿便鞋，换穿室内拖鞋并站稳；继续脱下另一只白色湿便鞋并换穿室内拖鞋，双脚站稳后切到开灯镜，旧台灯始终关闭",
      "陈卓伸手拧亮旧台灯；特写手指转动旧台灯旋钮，钨丝由暗转暖，暖光只覆盖桌面和人物面部暖侧",
      "陈卓在灯下坐下，抬头安静听雨；人物在灯下坐下并安静听雨，固定机位收束，窗外冷蓝只勾轮廓",
    ]);
    expect(shots.slice(2, 5).every((shot) => /(?:关闭.*旧台灯|旧台灯.*关闭)/u.test(String(shot.lighting)))).toBe(true);
    expect(JSON.stringify(prd)).not.toMatch(/"audio".*?单音/u);
    expect(String((prd.characterSystem as any).characters[0].costume)).toMatch(/白色湿便鞋.*室内拖鞋/u);
    expect(String((prd.prdSummary as any).keyHook)).not.toContain("为什么");
  });

  it("动物是角色而非道具；探头、伸爪、缩回等动作进入可执行契约", () => {
    const discovery: Record<string, unknown> = {
      sceneStructure: {
        opening: { purpose: "橘猫从纸箱探头", keyElements: ["纸箱"] },
        scenes: [{ purpose: "橘猫伸爪接屋檐滴水", keyElements: ["水滴"] }],
        ending: { purpose: "橘猫缩回纸箱盘成一团", keyElements: ["纸箱"] },
      },
      riskAssessment: { technicalRisks: [], mitigationSuggestions: [] },
    };
    const props = inferNarrativeProps({
      intent: "雨后夜晚，一只橘猫从纸箱探头，伸爪接水，最后坐回纸箱。无人物，无品牌，无字幕，无旁白。",
      discovery,
    });
    const actions = extractNarrativeActions(discovery);
    expect(props).toContain("纸箱");
    expect(props).not.toContain("动物");
    expect(actions.some(action => action.startsWith("探头"))).toBe(true);
    expect(actions.some(action => action.startsWith("伸爪"))).toBe(true);
    expect(actions.some(action => action.startsWith("缩回"))).toBe(true);
    const markdown = normalizeNarrativeRequirementMarkdown([
      "**总时长**: 片尾（15秒内）",
      "**开场** (6秒)",
      "**场景 1** (6秒)",
      "**场景 2** (9秒)",
      "**结尾** (9秒)",
      "- **动作**（1）：贴上骨上的绒毛",
      "- **道具**（2）：动物、门",
    ].join("\n"), discovery, 15, {
      _originalStoryText: "雨后夜晚，一只橘猫从纸箱探头，伸爪接水，最后坐回纸箱。无人物，无品牌，无字幕，无旁白。",
      dialogue_requirement: "无台词、无旁白、无字幕，仅保留环境声。",
    });
    expect(markdown).toContain("**总时长**: 15秒");
    expect(markdown).not.toContain("贴上骨上的绒毛");
    expect(markdown).not.toContain("- **道具**（2）：动物、门");
    expect(markdown).toContain("探头");
    expect(markdown).toContain("伸爪");
  });

  it("真实猫片 G3 不把视觉锚点切碎，并把角色、场景、台词与占位缓解收敛成可执行合同", () => {
    const discovery: Record<string, unknown> = {
      audienceProfile: {
        contentExpectations: [
          "无需字幕与六个连续动作完成完整情绪弧",
          "有一句关键台词，例如“它没接到那滴水，就把整个雨夜圈进了尾巴里”",
          "结尾留半秒静止空镜",
        ],
      },
      sceneStructure: {
        opening: {
          duration: 3,
          purpose: "第一帧是低机位雨夜：塌软纸箱里橘猫只探出半身，屋檐水珠胀大悬在它鼻尖前",
          keyElements: ["塌软纸箱", "橘猫半身", "屋檐将落水珠"],
        },
        scenes: [
          {
            duration: 4,
            purpose: "删掉这镜会失去第一次接空：猫爪抬起，水珠砸在爪垫边缘溅成细水花，猫耳后压。",
            keyElements: ["抬起的猫爪", "砸在爪边的水珠", "湿纸箱边缘"],
          },
          {
            duration: 6,
            purpose: "猫缩回箱内盘成一团，尾巴尖把最后一滴雨声圈在身侧。",
            keyElements: ["橘猫盘成团", "圈住身体的尾巴尖"],
          },
        ],
        ending: { duration: 2, purpose: "最后一帧停在尾巴尖与纸箱破口：一滴水沿檐角悬而未落", keyElements: ["纸箱破口"] },
      },
      riskAssessment: {
        technicalRisks: [{ risk: "猫爪接水时可能粘连", level: "high" }],
        mitigationSuggestions: ["预留重试时间", "准备备选方案"],
      },
    };
    const upstream = {
      _originalStoryText: "雨后夜晚，一只橘猫从纸箱探头，伸爪接屋檐滴水，最后缩回纸箱盘成一团。无人物、无品牌、无字幕、无旁白，仅保留环境声。",
      dialogue_requirement: "无台词、无旁白、无字幕，只保留环境声",
      visual_style: "低照度雨夜，单一暖黄钨丝光逆光，低机位贴近地面，浅景深",
      special_notes: "视觉锚点：①橘猫毛被打湿成缕、耳尖挂水珠；②伸爪接水的爪垫离水珠仅一寸的悬停瞬间；③缩回时尾巴一圈圈收拢压住身体的收束动作。",
    };
    normalizeNarrativeDiscovery(discovery, 15, upstream);
    const actions = extractNarrativeActions(discovery, upstream);
    expect(actions).toEqual(expect.arrayContaining(["探出半身", "抬起", "缩回箱内盘成一团"]));
    expect(actions.join("")).not.toContain("仅一");
    expect(actions).not.toContain("盘成一团");
    const inferredRoles = inferNarrativeCharacters({
      intent: upstream._originalStoryText,
      discovery,
      upstream,
    });
    expect(inferredRoles[0]).toMatchObject({ name: "猫", description: expect.stringContaining("被打湿成缕") });
    const markdown = normalizeNarrativeRequirementMarkdown([
      "2.1 内容期望：无需字幕与六个连续动作完成完整情绪弧",
      "有一句关键台词，例如“它没接到那滴水”。",
      "**开场** (3秒)",
      "**场景 1** (4秒)",
      "**场景 2** (6秒)",
      "**结尾** (2秒)",
      "**缓解建议**",
      "1. 预留重试时间",
      "2. 准备备选方案",
      "- **角色**（1）：猫（须登记肖像授权）",
      "- **场景**（1）：旧段落",
      "- **道具**（1）：动物",
      "- **动作**（1）：仅一",
      "- **风险结论**：待补",
    ].join("\n"), discovery, 15, upstream);
    expect(markdown).toContain("目的=");
    expect(markdown).toContain("时间=雨夜");
    expect(markdown).toContain("光位=单一暖黄钨丝光");
    expect(markdown).toContain("机位=低机位");
    expect(markdown).toContain("橘猫");
    expect(markdown).not.toContain("关键台词");
    expect(markdown).not.toContain("预留重试时间");
    expect(markdown).not.toContain("准备备选方案");
    expect(markdown).toContain(`${actions.length}个连续动作`);
    expect(markdown).toContain("主体动作与画外环境声");
    expect(markdown).toContain("### 视觉锚点定义");
    expect(markdown).toContain("片尾静止=0.5秒");
    discovery._canonicalCharacters = inferredRoles.map((role, index) => ({
      ...role,
      id: `char_${index + 1}`,
      characterId: `char_${index + 1}`,
    }));
    const prd = normalizeNarrativePrdContract({
      projectDefinition: { sourceIntent: "橘猫雨夜接水" },
      productPositioning: { targetDuration: 15, aspectRatio: "9:16", targetPlatform: "douyin" },
      characterSystem: {
        characters: [{
          characterId: "char_hallucinated",
          name: "未出镜的观者",
          role: "protagonist",
          appearance: "画面外一次呼吸声与衣料摩擦",
        }],
      },
      scenePlan: {
        scenes: [{ sceneId: "SC01", purpose: "橘猫探爪接水后缩回纸箱", duration: 15 }],
        shotMapping: [{ sceneId: "SC01", estimatedShots: 3, shotBreakdownHint: ["close-up", "close-up", "medium"] }],
      },
      productionConstraints: { technicalConstraints: ["仅保留人物动作与画外环境声"] },
      audienceProfile: { contentExpectations: ["仅保留人物动作与画外环境声"] },
      deliveryStandard: { deliverables: [{ item: "video_master", spec: "MP4" }], outputFormat: {} },
    }, discovery);
    const shots = prd.shotContract as Array<Record<string, unknown>>;
    expect(shots.every((shot) => (shot.subjectIds as string[]).includes("char_1"))).toBe(true);
    expect(JSON.stringify(prd)).not.toContain("人物动作");
  });

  it("真实猫片缺核心接水动作时补入场景，并清除尾声台词和跨物种缓解模板", () => {
    const upstream = {
      _originalStoryText: "雨后夜晚，一只橘猫从纸箱探头，伸爪接屋檐滴水，最后缩回纸箱盘成一团。无人物、无品牌、无字幕、无旁白，仅保留环境声。",
      dialogue_requirement: "无台词、无旁白、无字幕，仅保留环境声。",
      visual_style: "低照度雨夜，屋檐暖黄路灯逆光，低机位浅景深",
    };
    const discovery: Record<string, unknown> = {
      sceneStructure: {
        opening: { duration: 5, purpose: "橘猫从纸箱探头", keyElements: ["纸箱"] },
        scenes: [
          { duration: 5, purpose: "猫爪收回，水珠滑落", keyElements: ["水滴"] },
          { duration: 3, purpose: "猫缩回纸箱", keyElements: ["纸箱"] },
        ],
        ending: { duration: 2, purpose: "一句轻声台词「一滴接住了，整夜的冷还在」把冷暖写在脸上", keyElements: ["纸箱"] },
      },
      riskAssessment: {
        technicalRisks: [
          { risk: "猫爪多趾结构在小尺度微距下爪形粘连、趾数错误", level: "high" },
          { risk: "湿毛跨镜干湿状态跳变，水珠高光漂移", level: "high" },
          { risk: "猫头穿越纸箱边界时毛发穿模，暖光包边闪烁", level: "medium" },
          { risk: "蜷缩时肢体数量漂移，尾巴穿模", level: "medium" },
        ],
        mitigationSuggestions: [
          "把手指动作拆成固定机位短特写，用遮挡规避完整手指接触",
          "按场景建立硬时间预算并写入镜头合同",
        ],
      },
    };
    normalizeNarrativeDiscovery(discovery, 15, upstream);
    const renderedScenes = JSON.stringify(discovery.sceneStructure);
    expect(renderedScenes).toContain("伸爪接屋檐滴水");
    expect(renderedScenes).not.toContain("一滴接住了");
    expect(renderedScenes).not.toContain("轻声台词");
    const mitigations = pairRiskMitigations(discovery.riskAssessment as Record<string, unknown>);
    expect(mitigations[0]).toMatch(/猫爪|肉垫|爪形/u);
    expect(mitigations[1]).toMatch(/湿毛|干湿状态|水珠/u);
    expect(mitigations[2]).toMatch(/纸箱.*遮挡|箱沿/u);
    expect(mitigations[3]).toMatch(/蜷缩|尾巴|肢体/u);
    expect(mitigations.join("")).not.toContain("手指动作");
    expect(mitigations.join("")).not.toContain("硬时间预算");
  });

  it("无台词归家片从原始动作重建空间、道具与收束，不把说话幻觉或无关声音当成缓解", () => {
    const upstream = {
      _originalStoryText: "雨夜，一个年轻人收伞回到出租屋，开门、换鞋、拧亮旧台灯，随后坐在灯下安静地听雨。全片无台词、无旁白、无字幕，仅保留动作与环境声。",
      dialogue_requirement: "全片无台词、无旁白、无字幕，仅保留动作与环境声。",
      visual_style: "旧台灯单一暖光源与窗外冷蓝雨光对撞",
    };
    const discovery: Record<string, unknown> = {
      sceneStructure: {
        opening: { duration: 3, purpose: "湿伞尖顶到镜头前，水珠砸在门槛上", keyElements: ["台灯", "门"] },
        scenes: [
          { duration: 4, purpose: "他单脚蹭掉皮鞋，湿袜子在地板上留下半个脚印", keyElements: ["鞋"] },
          { duration: 4, purpose: "他拧亮旧台灯，坐下听雨", keyElements: ["门", "鞋"] },
        ],
        ending: { duration: 4, purpose: "全片的湿冷在这句几乎听不见的话里化开，收束在光和指尖上", keyElements: ["台灯"] },
      },
      riskAssessment: {
        technicalRisks: [
          { risk: "门锁开启、换鞋和台灯开关的精细手部动作容易穿模", level: "high" },
          { risk: "同一出租屋与湿外套在不同镜头间布局和造型漂移", level: "medium" },
        ],
        mitigationSuggestions: [
          "开门声先于画面出现，换鞋声配合脚踝局部构图，台灯开关声配钨丝特写",
          "固定曝光、白平衡、主辅光比与 LUT，按场景隔离冷暖光",
        ],
      },
    };
    normalizeNarrativeDiscovery(discovery, 15, upstream);
    const scene = discovery.sceneStructure as any;
    const actions = extractNarrativeActions(discovery, upstream);
    expect(actions).toEqual(expect.arrayContaining(["收伞回到出租屋", "开门", "换鞋", "拧亮旧台灯", "坐下听雨"]));
    expect(String(scene.ending.purpose)).not.toContain("这句话");
    const markdown = normalizeNarrativeRequirementMarkdown(
      "- **场景**（4）：错误空间\n- **动作**（1）：错误动作\n- **风险结论**：待补",
      discovery,
      15,
      upstream,
    );
    expect(markdown).toContain("空间=出租屋");
    expect(markdown).toContain("雨伞");
    expect(markdown).not.toContain("空间=台灯");
    expect(markdown).toContain("仅保留动作与环境声");
    const pairs = pairRiskMitigations(discovery.riskAssessment as Record<string, unknown>);
    expect(pairs[1]).toContain("参考帧");
    expect(pairs[1]).not.toContain("声音");
  });

  it("归家片开场过载时按源句拆成可执行场景，并把收伞归入雨伞道具", () => {
    const upstream = {
      _originalStoryText: "雨夜，一个年轻人收伞回到出租屋，开门、换鞋、拧亮旧台灯，随后坐在灯下安静地听雨。全片无台词、无旁白、无字幕，仅保留动作与环境声。",
      dialogue_requirement: "全片无台词、无旁白、无字幕，仅保留动作与环境声。",
    };
    const discovery: Record<string, unknown> = {
      sceneStructure: {
        opening: { duration: 3, purpose: "收伞回到出租屋、开门、换鞋、拧旧台灯旋钮、坐下听雨", keyElements: ["台灯", "门"] },
        scenes: [],
        ending: { duration: 12, purpose: "灯下听雨，紧接一句低声台词“雨再大，也有一盏灯接着。”", keyElements: ["台灯", "窗"] },
      },
      riskAssessment: {
        technicalRisks: [
          { risk: "手持微晃与9:16浅景深人物均稳", level: "low" },
          { risk: "旧台灯单一暖光源的跨镜头色温、灯罩旧痕位置和墙面暖光斑一致性", level: "high" },
        ],
        mitigationSuggestions: [
          "手部动作拆成固定机位短特写",
          "把窗外雨幕设为独立背景板，固定雨线方向与反射强度",
        ],
      },
    };
    normalizeNarrativeDiscovery(discovery, 15, upstream);
    const scene = discovery.sceneStructure as any;
    expect(scene.scenes.length).toBeGreaterThanOrEqual(1);
    const purposes = [scene.opening, ...scene.scenes, scene.ending].map((node: any) => node.purpose).join("；");
    expect(purposes).toContain("开门");
    expect(purposes).toContain("换鞋");
    expect(purposes).toContain("坐下");
    expect(purposes).not.toContain("片尾");
    expect(purposes).not.toContain("雨再大");
    expect(scene.ending.keyElements.length).toBeGreaterThan(0);
    expect(inferNarrativeProps({
      intent: upstream._originalStoryText,
      discovery,
      upstream,
    })).toContain("雨伞");
    const markdown = normalizeNarrativeRequirementMarkdown(
      "- **道具**（1）：台灯\n- **场景**（1）：错误\n- **动作**（1）：收伞/开门/换鞋/台灯开关等动作声与环境底噪",
      discovery,
      15,
      upstream,
    );
    expect(markdown).toContain("雨伞");
    expect(markdown).toContain("换鞋");
    expect(markdown).not.toContain("动作声与环境底噪");
    const pairs = pairRiskMitigations(discovery.riskAssessment as Record<string, unknown>);
    expect(pairs[0]).toMatch(/三脚架|机位|稳定/u);
    expect(pairs[0]).not.toContain("手部动作拆成");
    expect(pairs[1]).toMatch(/旧台灯|2700K|灯罩.*旧痕|暖光斑/u);
    expect(pairs[1]).not.toContain("窗外雨幕");
  });

  it("无人物但有动物的合同保留动物主体，不要求人像定妆照，并清除环境声合同中的配乐", () => {
    const discovery: Record<string, unknown> = {
      upstreamFields: {
        duration_sec: 15,
        platform_id: "douyin",
        aspect_ratio: "9:16",
        dialogue_requirement: "无台词、无旁白、无字幕，仅保留环境声。",
        _originalStoryText: "雨后夜晚，一只橘猫从纸箱探头，伸爪接屋檐滴水，最后缩回纸箱盘成一团。无人物、无品牌、无字幕、无旁白，仅保留环境声。",
      },
      _canonicalCharacters: [{ id: "char_1", name: "橘猫", role: "protagonist", appearance: "湿毛成缕，爪垫粉色", gender: null, ageRange: null }],
    };
    const prd = normalizeNarrativePrdContract({
      projectDefinition: { sourceIntent: "橘猫雨夜接水" },
      productPositioning: { targetDuration: 15, aspectRatio: "9:16", targetPlatform: "douyin" },
      characterSystem: { characters: [{ characterId: "char_1", name: "橘猫", role: "protagonist", appearance: "湿毛成缕，爪垫粉色" }] },
      visualSpecification: { lightingDirection: "屋檐暖黄路灯逆光，冷青蓝环境光" },
      scenePlan: {
        scenes: [{ sceneId: "SC01", purpose: "橘猫探头、伸爪接水、缩回纸箱", duration: 15, keyProps: ["纸箱", "屋檐", "水滴"] }],
        shotMapping: [{ sceneId: "SC01", estimatedShots: 3, shotBreakdownHint: ["close-up", "extreme-close-up", "medium"] }],
      },
      audioSpecification: { musicStyle: "极简钢琴单音，结尾进入", soundEffects: ["雨声", "结尾单一钢琴音"] },
      audienceProfile: { contentExpectations: ["仅保留人物动作与画外环境声"] },
      productionConstraints: { technicalConstraints: ["仅保留人物动作与画外环境声"] },
      deliveryStandard: {
        deliverables: [
          { item: "video_master", spec: "MP4" },
          { item: "character_portraits", spec: "定妆照全套" },
        ],
        outputFormat: {},
      },
    }, discovery);
    const characters = (prd.characterSystem as any).characters;
    const shots = prd.shotContract as any[];
    const delivery = prd.deliveryStandard as any;
    expect(characters).toHaveLength(1);
    expect(characters[0]).toMatchObject({ characterId: "char_1", name: "橘猫" });
    expect(String(characters[0].consistencyRequirements)).not.toContain("定妆照");
    expect(shots.every((shot) => shot.subjectIds.includes("char_1"))).toBe(true);
    expect(delivery.deliverables.map((item: Record<string, unknown>) => item.item)).toEqual(["video_master"]);
    expect(delivery.characterAssets).toMatchObject({ required: false });
    expect(JSON.stringify(prd)).not.toMatch(/钢琴|旋律|人物动作/);
    expect(JSON.stringify(prd)).not.toMatch(/null|undefined|NaN|\[object Object\]/u);
    expect(JSON.stringify(prd)).toContain("不使用配乐");
  });

  it("无角色空镜 PRD 删除定妆照硬要求，并收敛无配乐与色温冲突", () => {
    const discovery: Record<string, unknown> = {
      upstreamFields: {
        duration_sec: 30,
        platform_id: "douyin",
        aspect_ratio: "9:16",
        dialogue_requirement: "无人物、无动物、无旁白，仅保留环境声",
        visual_style: "青灰7000K冷调，远山与湖面保持同一白平衡",
        _originalStoryText: "清晨天鹅湖薄雾散开，无人物、无动物，仅保留环境声。",
      },
      _canonicalCharacters: [],
    };
    const prd = normalizeNarrativePrdContract({
      projectDefinition: { sourceIntent: "清晨天鹅湖薄雾散开，仅保留环境声" },
      productPositioning: { targetDuration: 30, aspectRatio: "9:16", targetPlatform: "douyin" },
      characterSystem: { characters: [] },
      visualSpecification: { lightingDirection: "暖光2700K作主光" },
      scenePlan: {
        scenes: [{ sceneId: "SC01", purpose: "薄雾散开", duration: 30 }],
        shotMapping: [{ sceneId: "SC01", estimatedShots: 1, shotBreakdownHint: ["tracking"] }],
      },
      productionConstraints: { technicalConstraints: ["仅保留主体动作与画外环境声", "仅保留人物动作"] },
      audienceProfile: { contentExpectations: ["仅保留主体动作与画外环境声"] },
      audioSpecification: {
        musicStyle: "片尾仅入低频持续音",
        soundEffects: ["水声", "芦苇摩擦声", "片尾旋律渐入", "片尾旋律渐入", "雾中远鸟与结尾一次呼吸声"],
      },
      deliveryStandard: {
        deliverables: [
          { item: "video_master", spec: "MP4" },
          { item: "character_portraits", spec: "定妆照全套" },
        ],
        outputFormat: {},
      },
    }, discovery);
    const delivery = prd.deliveryStandard as Record<string, unknown>;
    const deliverables = delivery.deliverables as Array<Record<string, unknown>>;
    expect(deliverables.map((item) => item.item)).toEqual(["video_master"]);
    expect(delivery.characterAssets).toMatchObject({ required: false });
    expect((prd.characterSystem as Record<string, unknown>).characters).toEqual([]);
    const shots = prd.shotContract as Array<Record<string, unknown>>;
    expect(shots[0]!.subjectIds).toEqual([]);
    expect(JSON.stringify(prd)).toContain("7000K");
    expect(JSON.stringify(prd)).not.toMatch(/2700K|低频持续音|旋律渐入|人物动作|主体动作与画外环境声|未出镜的观者|呼吸声|衣料摩擦|远鸟/u);
    expect(JSON.stringify(prd)).toContain("不使用配乐");
  });

  it("无角色空镜的模板场景、角色和风险缓解被源证据替换", () => {
    const discovery: Record<string, unknown> = {
      sceneStructure: {
        opening: { duration: 3, purpose: "清晨薄雾中的天鹅湖", keyElements: ["台灯", "手机"] },
        scenes: [
          { duration: 12, purpose: "手指从快门键移开，黑天鹅颈部与倒影重合", keyElements: ["黑天鹅", "快门键"] },
          { duration: 12, purpose: "场景2：推动叙事发展", keyElements: ["核心动作", "情绪表达"] },
        ],
        ending: { duration: 3, purpose: "删掉结尾，再把手伸进画面并叠低字幕", keyElements: ["情绪收束", "主题呼应"] },
      },
      audienceProfile: {
        emotionTriggers: [
          "手机取景框亮起，按下录制后手指离开快门",
          "观众先听见一声极轻的屏息",
          "黑天鹅从雾中游过，水鸟鸣叫",
        ],
        contentExpectations: ["仅保留环境声"],
      },
      riskAssessment: {
        technicalRisks: [
          { risk: "湖面倒影几何漂移", level: "high", impact: "远山倒影重复变形" },
          { risk: "薄雾时序闪烁", level: "high", impact: "雾层回卷或突然消失" },
          { risk: "低照度水面塑料高光", level: "medium", impact: "暗部色带和过曝" },
          { risk: "无主体空镜生成人物、动物、船只和水印", level: "high", impact: "违反硬约束" },
          { risk: "风与涟漪方向和频率不一致", level: "medium", impact: "无风自动波纹" },
        ],
        mitigationSuggestions: [
          "把雾散长镜拆成三个连续镜位，每段只承担一个运动",
          "用芦苇前景遮挡倒影复杂度，固定低机位和中轴构图",
          "雾的散开改为分层透明度递减，不做单镜体积模拟",
          "低照度只保留芦苇轮廓光和水面碎光，固定曝光与青灰白平衡",
        ],
      },
    };
    const upstream = {
      _originalStoryText: "清晨薄雾中的天鹅湖，湖面只倒映远山和芦苇，风吹起细小涟漪，薄雾缓慢散开。无人物、无动物、无品牌、无文字、无字幕、无旁白，仅保留环境声。",
      dialogue_requirement: "无人物、无动物，仅保留环境声",
      visual_style: "日出前蓝灰散射光，逆光雾层，浅景深远山，9:16竖幅",
      special_notes: "湖面倒映远山和芦苇；涟漪边缘见碎光；远山压在上三分之一，芦苇在下缘作前景。",
    };
    normalizeNarrativeDiscovery(discovery, 30, upstream);
    const scenes = discovery.sceneStructure as any;
    expect(scenes.opening.purpose).toContain("天鹅湖");
    expect(scenes.scenes[0].purpose).toContain("远山和芦苇");
    expect(scenes.scenes[1].purpose).toContain("涟漪");
    expect(scenes.ending.purpose).toContain("薄雾缓慢散开");
    expect(JSON.stringify(scenes)).toContain("远山");
    expect(JSON.stringify(scenes)).not.toMatch(/建立场景氛围|推动叙事发展|核心动作|情绪表达|主题暗示|黑天鹅|低字幕|台灯|手机|手指|快门|门/u);
    expect(JSON.stringify(discovery.audienceProfile)).not.toMatch(/手机|录制|手指|快门|屏息|黑天鹅|水鸟/u);
    const pairs = pairRiskMitigations(discovery.riskAssessment as Record<string, unknown>);
    expect(new Set(pairs).size).toBe(5);
    expect(pairs[0]).toContain("遮挡倒影");
    expect(pairs[1]).toContain("分层透明度");
    expect(pairs[2]).toContain("青灰");
    expect(pairs[3]).toContain("唯一负面清单");
    expect(pairs[4]).toContain("水面运动");
    const markdown = normalizeNarrativeRequirementMarkdown([
      "### 2.4 对标参考",
      "- 《星际穿越》《布达佩斯大饭店》",
      "---",
      "> 设备型号、光照参数与实拍可行性未在本轮核实；相关摄影参数仅为创作参考，正式执行以结构化镜头合同为准。",
      "> 设备型号、光照参数与实拍可行性未在本轮核实；相关摄影参数仅为创作参考，正式执行以结构化镜头合同为准。",
      "## 三、最终业务需求确认",
      "- **角色**（1）：无真人角色",
      "- **动作**（1）：压在上三分之一",
    ].join("\n"), discovery, 30, upstream);
    expect(markdown).toContain("- **角色**（0）：无角色");
    expect(markdown).toContain("- **动作**（0）：无角色动作");
    expect(markdown).not.toContain("《星际穿越》");
    expect(markdown).toContain("日出前蓝灰散射光");
    expect((markdown.match(/> 设备型号、光照参数与实拍可行性未在本轮核实/gu) ?? []).length).toBe(1);
  });

  it("无人物自然与静物案例从源证据生成空间、动作、道具和声音，不继承雨夜模板", () => {
    const cases = [
      {
        story: "秋日木栈道上，落叶被风分层推过栏杆缝隙，光斑随树叶晃动。无人物、无动物、无品牌、无文字、无字幕、无旁白，仅保留环境声。",
        visual: "自然侧逆光，浅景深，9:16竖构图",
        space: "木栈道",
        props: ["落叶", "栏杆"],
        sounds: ["风声", "落叶摩擦声"],
        action: "落叶",
      },
      {
        story: "清晨薄雾中的无名高原湖，湖面只倒映远山和芦苇，风吹起细小涟漪，薄雾缓慢散开。无人物、无动物、无品牌、无文字、无字幕、无旁白，仅保留环境声。",
        visual: "清晨侧逆光，薄雾体积光，低饱和青灰调",
        space: "高原湖",
        props: ["薄雾", "远山", "芦苇", "水面", "涟漪"],
        sounds: ["风声", "水面涟漪声"],
        action: "风吹起细小涟漪",
      },
      {
        story: "桌面上的一把白色陶瓷茶壶，晨光从窗边斜照，蒸汽缓慢升起，镜头只观察釉面、壶嘴水滴和光影变化。无人物、无动物、无品牌、无文字、无字幕、无旁白，仅保留环境声。",
        visual: "窗边晨光侧逆光，白瓷高光，9:16竖构图",
        space: "桌面上",
        props: ["茶壶", "蒸汽", "釉面", "壶嘴", "水滴"],
        sounds: ["蒸汽与陶瓷轻响声"],
        action: "蒸汽",
      },
    ];
    for (const item of cases) {
      const upstream = {
        _originalStoryText: item.story,
        dialogue_requirement: "无台词、无旁白、无字幕，仅保留环境声。",
        visual_style: item.visual,
      };
      const discovery: Record<string, unknown> = {
        sceneStructure: {
          opening: { duration: 5, purpose: item.story.split("。")[0], keyElements: [] },
          scenes: [],
          ending: item.space === "桌面上"
            ? { duration: 5, purpose: "低声一句“光走了，它还热着。”", keyElements: ["杯垫"] }
            : { duration: 5, purpose: "保持源场景的自然变化直到收束", keyElements: [] },
        },
        audienceProfile: {
          emotionTriggers: item.space === "桌面上" ? ["空桌与始终不出现的第二个人"] : [],
          contentExpectations: item.space === "桌面上"
            ? ["留一句可截图、可复述的固定台词“光走了，它还热着。”"]
            : ["只记录自然环境与环境声的缓慢变化"],
        },
        riskAssessment: { technicalRisks: [], mitigationSuggestions: [] },
      };
      normalizeNarrativeDiscovery(discovery, 10, upstream);
      const markdown = normalizeNarrativeRequirementMarkdown([
        "- **角色**（1）：错误角色",
        "- **动作**（1）：错误动作",
        "- **场景**（1）：错误空间",
        "- **道具**（1）：门",
        "- **台词/字幕口径**：无台词、无旁白、无字幕，仅保留环境声。",
      ].join("\n"), discovery, 10, upstream);
      expect(markdown).toContain("- **角色**（0）：无角色");
      expect(markdown).toMatch(new RegExp(`空间=${item.space}`, "u"));
      expect(markdown).toContain(item.action);
      for (const prop of item.props) expect(markdown).toContain(prop);
      for (const sound of item.sounds) expect(markdown).toContain(sound);
      expect(markdown).toContain("- **禁止项**");
      expect(markdown).toContain("无人物");
      expect(markdown).toContain("无品牌");
      if (item.space === "桌面上") {
        expect(markdown).not.toContain("低声一句");
        expect(markdown).not.toContain("光走了，它还热着");
        expect(markdown).not.toContain("杯垫");
        expect(markdown).not.toContain("第二个人");
      }
      expect(markdown).not.toContain("- **声音锚点**（1）：雨声");
      expect(markdown).not.toMatch(/动作.*以风、雾、光线和水面变化推进/u);
    }
  });

  it("橘猫动作保留完整收缩链，箱子、耳朵和悬停水滴的风险缓解各自配对", () => {
    const upstream = {
      _originalStoryText: "雨后夜晚，一只橘猫从纸箱探头，伸爪接屋檐滴水，最后缩回纸箱盘成一团。无人物、无品牌、无字幕、无旁白，仅保留环境声。",
      special_notes: "视觉锚点：①猫爪接水；②缩回时尾巴贴住皮肤；③耳朵最后收进去。",
      visual_style: "低照度雨夜，单一暖黄钨丝光逆光",
    };
    const discovery: Record<string, unknown> = {
      sceneStructure: {
        opening: { duration: 5, purpose: "湿冷大雨压在渺小橘猫上，橘猫从纸箱探头", keyElements: ["纸箱", "橘猫"] },
        scenes: [
          { duration: 5, purpose: "伸爪接屋檐将落未落的水滴", keyElements: ["猫爪", "水滴"] },
          { duration: 5, purpose: "缩回箱内盘成一团，耳朵最后收进去", keyElements: ["纸箱", "猫尾巴", "耳朵"] },
        ],
        ending: { duration: 0, purpose: "鼻尖抵住爪背", keyElements: ["纸箱"] },
      },
      riskAssessment: {
        technicalRisks: [
          { risk: "猫耳朵收拢时折叠方向抖动", level: "high" },
          { risk: "纸箱毛边吸水后箱沿塌陷穿模", level: "high" },
          { risk: "将落未落的水珠悬停时突然消失", level: "high" },
          { risk: "猫爪连续动作导致趾数与肉垫形变", level: "high" },
          { risk: "跨镜头纸箱花纹、水痕与街灯连续性漂移", level: "medium" },
        ],
        mitigationSuggestions: [
          "固定曝光与白平衡",
          "预留重试时间",
          "准备备选方案",
          "固定曝光",
          "调节色温",
        ],
      },
    };
    const actions = extractNarrativeActions(discovery, upstream);
    expect(actions.join("；")).toMatch(/缩回.*盘成/u);
    expect(actions.join("；")).not.toContain("贴住皮肤");
    expect(actions.join("；")).not.toContain("压在");
    const pairs = pairRiskMitigations(discovery.riskAssessment as Record<string, unknown>);
    expect(pairs[0]).toMatch(/耳朵/u);
    expect(pairs[1]).toMatch(/纸箱/u);
    expect(pairs[2]).toMatch(/悬停水滴/u);
    expect(pairs[3]).toMatch(/爪部动作/u);
    expect(pairs[4]).toMatch(/纸箱参考帧/u);
  });

  it("动作与禁止项抽取产出可执行短句，避免重复和整段原文", () => {
    const discovery = {
      sceneStructure: {
        opening: { purpose: "湿手反复对准锁孔", keyElements: [] },
        scenes: [{ purpose: "沿墙摸索，指尖拧动旋钮", keyElements: [] }],
        ending: { purpose: "镜头停在灯罩", keyElements: [] },
      },
      riskAssessment: { technicalRisks: [], mitigationSuggestions: [] },
    };
    const upstream = { special_notes: "手指拧灯罩，指腹压开关，指甲磕出咔哒，钥匙对准锁孔" };
    const actions = extractNarrativeActions(discovery, upstream);
    expect(actions).toEqual(expect.arrayContaining(["拧灯罩", "压开关", "磕出咔哒", "对准锁孔", "沿墙摸索", "拧动旋钮"]));
    expect(new Set(actions).size).toBe(actions.length);
    const markdown = normalizeNarrativeRequirementMarkdown([
      "- **动作**（1）：推开",
      "- **道具**（1）：窗",
    ].join("\n"), discovery, 30, {
      _originalStoryText: "做一条30秒品牌故事，不出现商品参数或价格",
      special_notes: "手指按下旧式翘板开关；全片不出现商品参数、价格、品牌logo特写",
      dialogue_requirement: "无台词",
    });
    expect(markdown).toContain("- **禁止项**（2）：");
    expect(markdown).not.toContain("做一条30秒品牌故事，不出现");
    expect(markdown).toContain("不出现商品参数、价格、品牌logo特写");
    expect(markdown).toContain("对准锁孔");
    expect(markdown).toContain("沿墙摸索");
    expect(markdown).toContain("拧动旋钮");
  });

  it("质感短语不进入动作契约，禁止出现的手机不进入道具契约", () => {
    const actions = extractNarrativeActions({}, {
      _originalStoryText: "旧台灯旋钮被拧动的阻尼感；雨夜收伞回到出租屋，换鞋后坐下听雨。全片不出现手机屏幕亮光。",
    });
    expect(actions).toContain("换鞋");
    expect(actions).not.toEqual(expect.arrayContaining([expect.stringContaining("阻尼感")]));
    const props = inferNarrativeProps({
      intent: "旧台灯旋钮被拧动的阻尼感；雨夜收伞回到出租屋。全片不出现手机屏幕亮光。",
      discovery: {
        sceneStructure: {
          opening: { purpose: "陈卓收伞进门，台灯开关有阻尼感", keyElements: ["旧台灯", "手机"] },
          scenes: [],
          ending: { purpose: "坐下听雨", keyElements: ["窗"] },
        },
      },
      upstream: {
        _originalStoryText: "旧台灯旋钮被拧动的阻尼感；雨夜收伞回到出租屋。全片不出现手机屏幕亮光。",
      },
    });
    expect(props).toContain("台灯");
    expect(props).not.toContain("手机");
  });

  it("场景正文被清理成碎片时用关键元素重建契约，且禁止项只出现一次", () => {
    const discovery = {
      sceneStructure: {
        opening: { purpose: "雨夜门口", keyElements: ["湿鞋", "门框"] },
        scenes: [{ purpose: "，", keyElements: ["陈卓拧灯罩的手指", "爆闪后熄灭的钨丝"] }],
        ending: { purpose: "灯罩被拧紧，暖光铺开", keyElements: ["暖黄台灯"] },
      },
      riskAssessment: { technicalRisks: [], mitigationSuggestions: [] },
    };
    const markdown = normalizeNarrativeRequirementMarkdown([
      "**总场景数**: 7个",
      "- **场景**（7）：损坏的场景",
      "- **动作**（1）：被拧紧",
      "- **道具**（1）：窗",
    ].join("\n"), discovery, 30, {
      _originalStoryText: "雨夜归家，不出现商品参数或价格",
      special_notes: "手指拧灯罩",
      dialogue_requirement: "无台词",
    });
    expect(markdown).toContain("主体场景 1：关键元素：陈卓拧灯罩的手指、爆闪后熄灭的钨丝");
    expect(markdown).toContain("**叙事结构**: 主体场景 1 个；加开场与结尾共 3 段");
    expect((markdown.match(/- \*\*禁止项\*\*/gu) ?? []).length).toBe(1);
    expect(markdown).toContain("拧灯罩");
  });

  it("清除场景元话语时保留句号后的可拍动作", () => {
    const discovery: Record<string, unknown> = {
      sceneStructure: {
        opening: { purpose: "删掉这镜，全片就只剩淋湿和进门，主题句无处落地。黑暗中陈卓摸到旧台灯旋钮，暖光亮起。", keyElements: ["旧台灯旋钮", "暖光"] },
        scenes: [],
        ending: { purpose: "灯保持亮着。", keyElements: ["暖光"] },
      },
    };
    normalizeNarrativeDiscovery(discovery, 30, { dialogue_requirement: "无台词" });
    const scene = discovery.sceneStructure as { opening: { purpose: string } };
    expect(scene.opening.purpose).not.toContain("删掉这镜");
    expect(scene.opening.purpose).not.toContain("全片就只剩");
    expect(scene.opening.purpose).toContain("黑暗中陈卓摸到旧台灯旋钮");
    expect(scene.opening.purpose).toContain("暖光亮起");
  });

  it("仅允许一句人声时，正文与契约统一使用该台词", () => {
    const discovery: Record<string, unknown> = {
      audienceProfile: {
        contentExpectations: ["钉子台词是‘原来陪伴一直没熄’"],
      },
      sceneStructure: {
        opening: { purpose: "雨夜归家", keyElements: ["钥匙"] },
        scenes: [{ purpose: "贴上灯罩", keyElements: ["台灯"] }],
        ending: { purpose: "他轻声说“原来你一直亮着”", keyElements: ["灯罩"] },
      },
    };
    normalizeNarrativeDiscovery(discovery, 30, {
      dialogue_requirement: "无原文指定台词；若需人声仅保留一句气声“还亮着”",
    });
    const expectation = ((discovery.audienceProfile as Record<string, unknown>).contentExpectations as string[])[0]!;
    const ending = ((discovery.sceneStructure as Record<string, unknown>).ending as Record<string, unknown>).purpose as string;
    expect(expectation).toContain("还亮着");
    expect(ending).toContain("还亮着");
    expect(`${expectation}${ending}`).not.toContain("原来陪伴一直没熄");
    expect(`${expectation}${ending}`).not.toContain("原来你一直亮着");
  });


  it("叙事兼容桥：阻断营销 Brief 污染、补人物契约，并容忍首个 JSON 后的尾随文本", () => {
    const script = `
import { createRequire } from "node:module";
import { installVendorDiscoveryNarrativeBridge } from ${JSON.stringify(resolve(here, "vendor-compat.ts"))};
const require = createRequire(${JSON.stringify(join(repoRoot, "package.json"))});
const systemMod = require(${JSON.stringify(join(repoRoot, "vendor/supermickey/hyperreality-system/index.js"))});
const discoveryMod = require(${JSON.stringify(join(repoRoot, "vendor/supermickey/hyperreality-system/engines/requirement-discovery-engine.js"))});
const system = Object.create(systemMod.HyperrealitySystem.prototype);
const discovery = new discoveryMod.RequirementDiscoveryEngine({ llmEngine: null });
const originalConvert = systemMod.HyperrealitySystem.prototype._convertDiscoveryToRequirementList;
const originalRender = systemMod.HyperrealitySystem.prototype._renderRequirementContract;
systemMod.HyperrealitySystem.prototype._convertDiscoveryToRequirementList = async function() { return { characters: [] }; };
systemMod.HyperrealitySystem.prototype._renderRequirementContract = function(_intent, _metadata, requirementList) { return JSON.stringify(requirementList); };
const uninstall = installVendorDiscoveryNarrativeBridge({ log: () => undefined });
const narrative = system._buildThemeInput("雨夜归家的故事", {
  pipelineRoute: { kind: "narrative" },
  brief: { platform: "douyin", goal: "seeding", duration: 30 },
});
const marketing = system._buildThemeInput("商品种草", {
  pipelineRoute: { kind: "marketing" },
  brief: { product: "台灯", platform: "douyin", goal: "seeding" },
});
discovery.agents.risk.llmEngine = {
  reasonStructured: async () => ({ success: true, content: '{\\"technicalRisks\\":[{\\"risk\\":\\"手部\\",\\"level\\":\\"medium\\",\\"impact\\":\\"重拍\\"}],\\"businessConstraints\\":[\\"无字幕\\"],\\"mitigationSuggestions\\":[\\"拆镜\\"]}\\n尾随文本' }),
};
const parsed = await discovery.agents.risk._callLLM({ type: "剧情短片", theme: "雨夜", visual_style: "写实", special_notes: "人物" }, {});
const converted = await system._convertDiscoveryToRequirementList({
  audienceProfile: {},
  sceneStructure: { opening: { purpose: "年轻人冒雨回家" }, scenes: [], ending: { purpose: "他开灯" } },
  riskAssessment: {},
  referenceCases: {},
}, { _originalStoryText: "雨夜归家的年轻人使用内置默认模特", description: "年轻人开灯" });
const rendered = JSON.parse(system._renderRequirementContract(
  "雨夜归家的年轻人使用内置默认模特",
  {},
  { characters: [] },
  { sceneStructure: { opening: { purpose: "年轻人冒雨回家" }, scenes: [], ending: { purpose: "他开灯" } } },
));
uninstall();
systemMod.HyperrealitySystem.prototype._convertDiscoveryToRequirementList = originalConvert;
systemMod.HyperrealitySystem.prototype._renderRequirementContract = originalRender;
console.log("RESULT " + JSON.stringify({
  narrativeContaminated: narrative.includes("营销 Brief") || narrative.includes("商业广告"),
  marketingHasBrief: marketing.includes("营销 Brief"),
  parsedRisks: parsed?.technicalRisks?.length,
  characters: converted.characters,
  renderedCharacters: rendered.characters
}));
`;
    const result = runInChild(script);
    expect(result.narrativeContaminated).toBe(false);
    expect(result.marketingHasBrief).toBe(true);
    expect(Number(result.parsedRisks)).toBe(1);
    expect(result.characters).toEqual([expect.objectContaining({ name: "年轻人", role: "protagonist" })]);
    expect(result.renderedCharacters).toEqual([expect.objectContaining({ name: "年轻人", role: "protagonist" })]);
  }, 60_000);

  it("无台词剧本在下游保持零口型台词，允许的旁白不被一并删除", () => {
    const script = `
import { createRequire } from "node:module";
import { installVendorDiscoveryNarrativeBridge } from ${JSON.stringify(resolve(here, "vendor-compat.ts"))};
const require = createRequire(${JSON.stringify(join(repoRoot, "package.json"))});
const generatorMod = require(${JSON.stringify(join(repoRoot, "vendor/supermickey/hyperreality-system/engines/script-engine/core/script-generator.js"))});
const validatorMod = require(${JSON.stringify(join(repoRoot, "vendor/supermickey/hyperreality-system/engines/script-engine/core/script-validator.js"))});
const contractMod = require(${JSON.stringify(join(repoRoot, "vendor/supermickey/hyperreality-system/engines/production-engine/utils/agent-contract-validator.js"))});
const uninstall = installVendorDiscoveryNarrativeBridge({ log: () => undefined });
const generator = new generatorMod.ScriptGenerator({ llmEngine: null });
generator._workloomNarrativePolicy = {
  dialogueAllowed: false,
  voiceoverAllowed: true,
  allSpeechForbidden: false,
  dialogueRequirement: "全片无对白；结尾可加一句气声旁白“原来你还在”"
};
const parsed = { structure: { scenes: [{ dialogue: { has_dialogue: true, lines: [{ speaker: "陈卓", text: "我回来了" }], blocks: [] }, narration: "画外旁白：“原来你还在”" }] } };
generator._normalizeScenesDialogue(parsed, true);
const checker = new validatorMod.ScriptValidator();
const checks = checker._checkDialogue({
  structure: { scenes: [{ dialogue: parsed.structure.scenes[0].dialogue }] },
  meta: { target_duration: 30, _metadata: { dialogueRequirement: "全片无对白；结尾可加一句气声旁白“原来你还在”" } }
});
const hasDialogueCheck = checks.find(item => item.name === "has_dialogue");
const contractCheck = new contractMod.AgentContractValidator().validate("phase1-phase2", {
  shots: [{ shotId: "S-01", scene: "完整场景描述内容", action: "完整动作描述", duration: 5, characters: ["陈卓"], dialogue: "陈卓|monologue|calmly|我回来了。" }],
  blueprint: { meta: { target_duration: 30 }, character_system: { characters: [] } }
});
uninstall();
console.log("RESULT " + JSON.stringify({
  dialogue: parsed.structure.scenes[0].dialogue,
  narration: parsed.structure.scenes[0].narration ?? null,
  hasDialoguePassed: hasDialogueCheck?.passed,
  hasDialogueMessage: hasDialogueCheck?.message,
  contractDialogueAccepted: contractCheck.valid,
  contractDialogueErrors: contractCheck.errors
}));
`;
    const result = runInChild(script);
    expect(result.dialogue).toMatchObject({
      has_dialogue: true,
      lines: [expect.objectContaining({ speaker: "旁白", text: expect.stringContaining("原来你还在") })],
      blocks: [expect.objectContaining({ speaker: "旁白", type: "narration" })],
    });
    expect(JSON.stringify(result.dialogue)).not.toContain("我回来了");
    expect(result.hasDialoguePassed).toBe(true);
    expect(String(result.hasDialogueMessage)).toContain("不适用");
    expect(result.contractDialogueAccepted).toBe(true);
    expect(result.contractDialogueErrors).toEqual([]);
  }, 60_000);

  it("嵌套无台词合同同时约束脚本提示、落盘字段与元数据，不再强制每场写台词", () => {
    const script = `
import { createRequire } from "node:module";
import { installVendorDiscoveryNarrativeBridge } from ${JSON.stringify(resolve(here, "vendor-compat.ts"))};
const require = createRequire(${JSON.stringify(join(repoRoot, "package.json"))});
const generatorMod = require(${JSON.stringify(join(repoRoot, "vendor/supermickey/hyperreality-system/engines/script-engine/core/script-generator.js"))});
const requirement = "全片无台词、无旁白、无字幕，仅保留动作与环境声。";
const userIntent = {
  metadata: {
    title: "无台词回归",
    target_duration: 15,
    _metadata: { dialogueRequirement: requirement },
    _originalStoryText: "雨夜收伞回到出租屋。全片无台词、无旁白、无字幕，仅保留动作与环境声。",
  },
  constraints: {},
  parsed: { primary_mode: "dramatic", hybrid_config: null, secondary_modes: [] },
};
const generator = new generatorMod.ScriptGenerator({ llmEngine: null });
const before = generator._resolveVoiceoverPolicy(userIntent);
const uninstall = installVendorDiscoveryNarrativeBridge({ log: () => undefined });
const after = generator._resolveVoiceoverPolicy(userIntent);
const prompt = generator._buildGenerationPrompt(userIntent, { structure: { acts: [] } });
const parsed = {
  meta: { target_duration: 15 },
  structure: {
    scenes: [{
      dialogue: {
        has_dialogue: true,
        lines: [{ speaker: "陈卓", text: "我回来了" }],
        blocks: [{ speaker: "陈卓", line: "我回来了" }],
      },
      narration: "画外旁白：“雨停了。”",
    }],
  },
};
generator._normalizeScenesDialogue(parsed, true);
uninstall();
console.log("RESULT " + JSON.stringify({
  beforeAllowed: before.allowed,
  beforeAllSpeechForbidden: before.allSpeechForbidden,
  afterAllowed: after.allowed,
  afterAllSpeechForbidden: after.allSpeechForbidden,
  dialogueRequirement: after.dialogueRequirement,
  promptStillRequiresDialogue: /^2\\. 每个场景必须有台词/mu.test(prompt),
  promptStillAllowsVoiceover: /本片允许旁白/u.test(prompt),
  promptHasOverride: /本片禁止所有台词、对白、旁白/u.test(prompt),
  dialogue: parsed.structure.scenes[0].dialogue,
  narration: parsed.structure.scenes[0].narration ?? null,
}));
`;
    const result = runInChild(script);
    expect(result.beforeAllowed).toBe(false);
    expect(result.beforeAllSpeechForbidden).toBeUndefined();
    expect(result.afterAllowed).toBe(false);
    expect(result.afterAllSpeechForbidden).toBe(true);
    expect(String(result.dialogueRequirement)).toContain("全片无台词、无旁白");
    expect(result.promptStillRequiresDialogue).toBe(false);
    expect(result.promptStillAllowsVoiceover).toBe(false);
    expect(result.promptHasOverride).toBe(true);
    expect(result.dialogue).toEqual({ has_dialogue: false, lines: [], blocks: [] });
    expect(result.narration).toBeNull();
  }, 60_000);

  it("十五秒五镜头按剪辑时间线投影到每镜3秒，不把供应商4秒下限当成业务不可行", () => {
    const script = `
import { createRequire } from "node:module";
import { installVendorDurationProjectionBridge } from ${JSON.stringify(resolve(here, "vendor-compat.ts"))};
const require = createRequire(${JSON.stringify(join(repoRoot, "package.json"))});
const generatorMod = require(${JSON.stringify(join(repoRoot, "vendor/supermickey/hyperreality-system/engines/script-engine/core/script-generator.js"))});
const events = [];
const uninstall = installVendorDurationProjectionBridge({
  minShotSeconds: 4,
  maxShotSeconds: 30,
  log: () => undefined,
  onEvent: event => events.push(event),
});
const parsed = {
  meta: { target_duration: 15 },
  structure: { scenes: Array.from({ length: 5 }, (_, index) => ({
    scene_id: "SC-" + (index + 1),
    duration: 3,
    dialogue: { has_dialogue: false, lines: [], blocks: [] },
  })) },
};
new generatorMod.ScriptGenerator({ llmEngine: null })._enforceTargetDuration(parsed, 15);
uninstall();
console.log("RESULT " + JSON.stringify({
  events,
  durations: parsed.structure.scenes.map(scene => scene.duration),
  total: parsed.structure.scenes.reduce((sum, scene) => sum + scene.duration, 0),
}));
`;
    const result = runInChild(script);
    expect(result.durations).toEqual([3, 3, 3, 3, 3]);
    expect(result.total).toBe(15);
    expect((result.events as Array<Record<string, unknown>>).map((event) => event.kind)).toEqual(["projected"]);
    expect((result.events as Array<Record<string, unknown>>)[0]).toMatchObject({
      source: "script-generator",
      totalSeconds: 15,
    });
  }, 60_000);
});

/**
 * T-2026-0923-0047：镜头内禁 BGM（音频纪律）+ 单镜 30s 口径统一。
 * 两条产品口径都由**运行期桥**落实（vendor 只读），因此断言必须在真实 node 进程里跑：
 * 桥用 createRequire 加载 vendor 原型，vitest 的 ESM 转换会误处理 CJS。
 */
describe("音频纪律桥与时长策略桥（真机口径 2026-09-23）", () => {
  it("音频纪律桥：组装器出口追加【音频纪律】+ 清洗 audio 字段里的音乐指令，摘除后复原", () => {
    const script = `
import { createRequire } from "node:module";
import { installVendorAudioDisciplineBridge } from ${JSON.stringify(resolve(here, "vendor-compat.ts"))};
const require = createRequire(${JSON.stringify(join(repoRoot, "package.json"))});
const mod = require(${JSON.stringify(join(repoRoot, "vendor/supermickey/hyperreality-system/engines/production-engine/agents/prompt-fusion-agent.js"))});
const CLAUSE = "【音频纪律】本镜头音频仅允许：台词人声、旁白、环境音效与动作音效；严禁出现任何背景音乐、BGM、配乐。";
const NEGATIVE = "no background music, no bgm, no soundtrack";
const agent = new mod.PromptFusionAgent({});
const build = () => {
  const fields = {
    scene: "苏州平江路的清晨，讲述人站在石桥边",
    baseline: "8K写实电影质感，自然光造型",
    constraint: "9:16画幅，480x853，24fps，MP4格式",
    audio: "背景音乐：钢琴长音铺底；环境声：水声与鸟鸣；配乐在1.5s进点"
  };
  const prompt = String(agent._assembleStandardPrompt(
    { shotId: "S1", duration: 5, scene: fields.scene, fields }, fields, "9:16"));
  return { prompt, fields };
};
const before = build();
const uninstall = installVendorAudioDisciplineBridge({ clause: CLAUSE, negativeTerms: NEGATIVE, log: () => undefined });
const after = build();
uninstall();
const restored = build();
console.log("RESULT " + JSON.stringify({
  beforeHasClause: before.prompt.includes("【音频纪律】"),
  beforeKeepsMusic: before.prompt.includes("钢琴长音铺底"),
  afterHasClause: after.prompt.includes("【音频纪律】"),
  afterHasNegative: /no background music/i.test(after.prompt),
  afterMusicRemoved: !after.prompt.includes("钢琴长音铺底") && !after.prompt.includes("配乐在1.5s进点"),
  afterFieldCleaned: String(after.fields.audio).includes("环境声") && !String(after.fields.audio).includes("钢琴"),
  restoredHasClause: restored.prompt.includes("【音频纪律】"),
  restoredKeepsMusic: restored.prompt.includes("钢琴长音铺底")
}));
`;
    const result = runInChild(script);
    /** 桥之前：vendor 原样照抄音乐指令，提示词里没有纪律子句（真机把 BGM 写进镜头的根因） */
    expect(result.beforeHasClause).toBe(false);
    expect(result.beforeKeepsMusic).toBe(true);
    /** 桥之后：子句 + 英文负面词齐备，音乐指令被剔除 */
    expect(result.afterHasClause).toBe(true);
    expect(result.afterHasNegative).toBe(true);
    expect(result.afterMusicRemoved).toBe(true);
    expect(result.afterFieldCleaned).toBe(true);
    /** 摘除后精确还原（桥不残留） */
    expect(result.restoredHasClause).toBe(false);
    expect(result.restoredKeepsMusic).toBe(true);
  }, 90_000);

  it("时长策略桥：5 处在用口径统一放宽到模型上限 30s，摘除后精确还原", () => {
    const script = `
import { createRequire } from "node:module";
import {
  installVendorDurationPolicyBridge,
  applyDurationPolicyToManager
} from ${JSON.stringify(resolve(here, "vendor-compat.ts"))};
const require = createRequire(${JSON.stringify(join(repoRoot, "package.json"))});
const theme = require(${JSON.stringify(join(repoRoot, "vendor/supermickey/hyperreality-system/config/theme-config.js"))});
const profiles = require(${JSON.stringify(join(repoRoot, "vendor/supermickey/hyperreality-system/config/platform-profiles.js"))});
const managerMod = require(${JSON.stringify(join(repoRoot, "vendor/supermickey/hyperreality-system/engines/duration-constraint/duration-constraint-manager.js"))});
const allocatorMod = require(${JSON.stringify(join(repoRoot, "vendor/supermickey/systems/shot-duration-allocator.js"))});
const builderMod = require(${JSON.stringify(join(repoRoot, "vendor/supermickey/hyperreality-system/engines/script-engine/core/requirement-list-builder.js"))});
const quotaOf = () => Object.values(theme.types || {}).map((t) => t.resourceQuota?.maxShotDuration).filter((v) => typeof v === "number");
const bandOf = () => Object.values(profiles.PROFILES || {}).map((p) => p.shotDuration?.max);
const buildRequirementList = () => new builderMod.RequirementListBuilder()
  ._buildRequirementList({ videoType: "tourism", style: { primary: "写实" }, duration: 30 }, "平江路三十秒宣传片", { title: "平江路", currentEpisode: 1, totalEpisodes: 1 });
const before = {
  quotaMin: Math.min(...quotaOf()),
  dcmDefault: new managerMod.DurationConstraintManager().maxSingleShot,
  allocatorMax: new allocatorMod.ShotDurationAllocator().config.maxDuration,
  builderParserRules: builderMod.ParserRules.constraints.maxShotDuration,
  builderResult: buildRequirementList().constraints.maxShotDuration
};
const uninstall = installVendorDurationPolicyBridge({ maxSingleShotSeconds: 30, minSingleShotSeconds: 4, log: () => undefined });
const manager = new managerMod.DurationConstraintManager();
applyDurationPolicyToManager(manager, 30, 4);
const allocator = new allocatorMod.ShotDurationAllocator();
const after = {
  quotaMin: Math.min(...quotaOf()),
  bandMaxMin: Math.min(...bandOf()),
  dcmDefault: new managerMod.DurationConstraintManager().maxSingleShot,
  dcmExplicitWins: new managerMod.DurationConstraintManager({ maxSingleShot: 12 }).maxSingleShot,
  dcmRhythmUpper: Math.max(...Object.values(manager.rhythmProfiles).map((p) => p.shotRange[1])),
  allocatorMax: allocator.config.maxDuration,
  allocatorRoleMaxMin: Math.min(...Object.values(allocator.roleConfig).map((r) => r.max)),
  builderParserRules: builderMod.ParserRules.constraints.maxShotDuration,
  builderResult: buildRequirementList().constraints.maxShotDuration
};
uninstall();
const restored = {
  quotaMin: Math.min(...quotaOf()),
  dcmDefault: new managerMod.DurationConstraintManager().maxSingleShot,
  allocatorMax: new allocatorMod.ShotDurationAllocator().config.maxDuration,
  builderParserRules: builderMod.ParserRules.constraints.maxShotDuration,
  builderResult: buildRequirementList().constraints.maxShotDuration
};
console.log("RESULT " + JSON.stringify({ before, after, restored }));
`;
    const result = runInChild(script);
    const before = result.before as Record<string, number>;
    const after = result.after as Record<string, number>;
    const restored = result.restored as Record<string, number>;
    /** 桥之前：各处默认仍是 15s（真实存在，不是猜的） */
    expect(before.dcmDefault).toBe(15);
    expect(before.allocatorMax).toBe(15);
    expect(before.builderParserRules).toBe(15);
    expect(before.builderResult).toBe(15);
    expect(before.quotaMin).toBe(10); // KIDS 题材
    /** 桥之后：全部抬到模型上限；显式传参仍然优先（不越权覆盖调用方） */
    expect(after.quotaMin).toBe(30);
    expect(after.bandMaxMin).toBe(30);
    expect(after.dcmDefault).toBe(30);
    expect(after.dcmExplicitWins).toBe(12);
    expect(after.dcmRhythmUpper).toBe(30);
    expect(after.allocatorMax).toBe(30);
    expect(after.allocatorRoleMaxMin).toBe(30);
    expect(after.builderParserRules).toBe(30);
    expect(after.builderResult).toBe(30);
    /** 摘除后精确还原 */
    expect(restored.quotaMin).toBe(before.quotaMin);
    expect(restored.dcmDefault).toBe(15);
    expect(restored.allocatorMax).toBe(15);
    expect(restored.builderParserRules).toBe(15);
    expect(restored.builderResult).toBe(15);
  }, 120_000);
});

/** 运行真实 vendor CJS 类；外部模型由可观察替身提供，绝不发网络请求。 */
function phase3Fixture(body: string): string {
  return `
import { createRequire } from "node:module";
import { installVendorPhase3FusionBridge, listSharedBridges } from ${JSON.stringify(resolve(here, "vendor-compat.ts"))};
const require = createRequire(${JSON.stringify(join(repoRoot, "package.json"))});
const { Phase3PromptFusion } = require(${JSON.stringify(join(repoRoot, "vendor/supermickey/hyperreality-system/engines/production-engine/phases/phase-3-prompt-fusion.js"))});
const { ProductionEngine } = require(${JSON.stringify(join(repoRoot, "vendor/supermickey/hyperreality-system/engines/production-engine/production-engine.js"))});
const { PromptFusionAgent } = require(${JSON.stringify(join(repoRoot, "vendor/supermickey/hyperreality-system/engines/production-engine/agents/prompt-fusion-agent.js"))});
const counters = { fusion: 0, checkpoints: 0, llm: 0, timing: 0 };
const makeState = (changes = {}) => ({
  shots: [{ shotId: "SC-01", scene: "手表商品微距", composition: "表盘特写", camera_movement: "固定机位", duration: 5, portraits: [], ...changes }],
  adaptedBlueprint: { title: "产品观察", config: { aspectRatio: "16:9" }, character_system: { characters: [] } },
  result: { stages: {}, llmStats: {} }
});
const merger = {
  log: () => {},
  _deepCloneShot: ProductionEngine.prototype._deepCloneShot,
  _deepCloneValue: ProductionEngine.prototype._deepCloneValue
};
const makePhase = (agentChanges = {}, phaseChanges = {}) => {
  const agent = {
    llmTimeout: 300000, llmMaxRetries: 5,
    _callLLM: async () => { counters.llm++; return { result: { picks: [] }, degraded: false }; },
    process: async (shots) => {
      counters.fusion++;
      return { shots: shots.map(s => ({ ...s, prompt: "【场景】手表商品表盘微距，固定机位观察材质。" })), degraded: false, stats: { failed: 0, total: shots.length } };
    },
    ...agentChanges
  };
  const phase = new Phase3PromptFusion({
    agents: { promptFusion: agent }, logFn: () => {},
    budgetRemaining: () => 120000, canAfford: () => true,
    cloneShots: structuredClone,
    mergeShots: (a, b, fields) => ProductionEngine.prototype._mergeShotsByShotId.call(merger, a, b, fields),
    saveCheckpoint: async () => { counters.checkpoints++; },
    ...phaseChanges
  });
  const timing = phase._checkDialogueTiming;
  phase._checkDialogueTiming = async function (...args) { counters.timing++; return timing.apply(this, args); };
  return phase;
};
${body}
`;
}

describe("Phase3 宿主融合桥（C1）", () => {
  it("原 const 重赋坏例被修复：真实 Phase3 完成融合、字段合并、台词检查与 checkpoint", () => {
    const result = runInChild(phase3Fixture(`
const before = await makePhase().execute(makeState());
const beforeCalls = counters.fusion;
const uninstall = installVendorPhase3FusionBridge();
const state = makeState();
const after = await makePhase().execute(state);
uninstall();
console.log("RESULT " + JSON.stringify({ beforeSuccess: before.success, beforeError: before.error, beforeCalls,
 afterSuccess: after.success, counters, status: after.result.stages.phase3Fusion.status,
 prompt: after.shots[0].prompt, stamp: after.shots[0]._workloomFusion,
 reviewPolicy: after.shots[0]._workloomPromptReviewPolicy,
 originalHasPrompt: Boolean(state.shots[0].prompt) }));
`));
    expect(result.beforeSuccess).toBe(false);
    expect(result.beforeError).toContain("Assignment to constant variable");
    expect(result.beforeCalls).toBe(0);
    expect(result.afterSuccess).toBe(true);
    expect(result.status).toBe("passed");
    expect(result.counters).toEqual(expect.objectContaining({ fusion: 1, checkpoints: 1, timing: 1 }));
    expect(result.originalHasPrompt).toBe(false);
    expect(result.reviewPolicy).toMatchObject({
      maxLength: expect.any(Number),
      aspectRatio: expect.any(String),
      characterNames: expect.any(Array),
    });
    expect((result.stamp as Record<string, unknown>).promptHash).toMatch(/^[a-f\d]{64}$/);
    expect((result.stamp as Record<string, unknown>).semanticSkillExecution).toBe("unverified");
  }, 90_000);

  it("模型 picks=[] 真正不匹配，清除旧 _skillContext 后仍按原镜头融合", () => {
    const result = runInChild(phase3Fixture(`
const uninstall = installVendorPhase3FusionBridge();
let received = null;
const phase = makePhase({ process: async shots => {
 received = shots[0]; counters.fusion++;
 return { shots: shots.map(s => ({ ...s, prompt: "【场景】女人坐在窗边。" })), stats: { failed: 0 } };
} });
const output = await phase.execute(makeState({ scene: "女人坐在窗边", composition: "面部近景", mood: "温情", camera_movement: "斯坦尼康慢移", _skillContext: "过期战场技能" }));
uninstall();
console.log("RESULT " + JSON.stringify({ counters, receivedContext: received._skillContext, matched: received._skillMatched,
 status: output.result.stages.skillPrematch[0].status, qc: output.shots[0]._skillQC.status }));
`));
    expect((result.counters as Record<string, unknown>).llm).toBe(1);
    expect(result.receivedContext).toBe("");
    expect(result.matched).toEqual([]);
    expect(result.status).toBe("not_applicable");
    expect(result.qc).toBe("not_applicable");
  }, 90_000);

  it("真实 vendor 的融合请求生成器收到实际技能正文，负面禁词不被误判", () => {
    const result = runInChild(phase3Fixture(`
const uninstall = installVendorPhase3FusionBridge();
const realAgent = new PromptFusionAgent({ semanticRefinement: false });
let fusionRequest = "";
let received = null;
const phase = makePhase({
 _callLLM: async prompt => {
  counters.llm++;
  const roster = JSON.parse(prompt.split("\\n").find(line => line.startsWith("候选：")).slice(3));
  return { result: { picks: [{ file: roster[0].file, reason: "原镜头是人物温情与缓慢稳定器运镜" }] }, degraded: false };
 },
 process: async (shots, blueprint) => {
  counters.fusion++; received = shots[0];
  fusionRequest = realAgent._buildBatchPrompt(shots, "16:9", [], blueprint);
  return { shots: shots.map(s => ({ ...s, prompt: "【场景】女人坐在窗边。\\n【运镜】斯坦尼康缓慢移动。\\n【负面约束】快速运镜、手持抖动" })), stats: { failed: 0 } };
 }
});
const output = await phase.execute(makeState({ scene: "女人坐在窗边", composition: "面部近景", mood: "温情", camera_movement: "斯坦尼康慢移" }));
uninstall();
console.log("RESULT " + JSON.stringify({ success: output.success, containsActualContext: fusionRequest.includes(received._skillContext),
 contextLength: received._skillContext.length, matched: received._skillMatched.length,
 qc: output.shots[0]._skillQC.status, promptHash: output.shots[0]._workloomFusion.promptHash, counters }));
`));
    expect(result.success).toBe(true);
    expect(result.containsActualContext).toBe(true);
    expect(Number(result.contextLength)).toBeGreaterThan(100);
    expect(Number(result.contextLength)).toBeLessThanOrEqual(1800);
    expect(Number(result.matched)).toBe(1);
    expect(result.qc).toBe("passed");
    expect(result.promptHash).toMatch(/^[a-f\d]{64}$/);
  }, 90_000);

  it("Phase3 首次 JSON 解析失败时在同一预算内重发一次严格 JSON 请求", () => {
    const result = runInChild(phase3Fixture(`
const uninstall = installVendorPhase3FusionBridge();
let calls = 0;
let retryPrompt = "";
const phase = makePhase({
 _callLLM: async (prompt) => {
  calls++;
  if (calls === 1) throw new Error("LLM引擎返回失败: JSON 解析失败: 未找到首个完整 JSON");
  retryPrompt = String(prompt);
  return { result: { picks: [] }, degraded: false };
 },
 process: async function (shots) {
  await this._callLLM("原始镜头请求", { required: [] }, () => null, { critical: true });
  return { shots: shots.map(s => ({ ...s, prompt: "【场景】湖面薄雾缓慢散开，固定机位连续记录水面涟漪与远山倒影。" })), degraded: false, stats: { failed: 0 } };
 }
});
const output = await phase.execute(makeState());
uninstall();
console.log("RESULT " + JSON.stringify({ success: output.success, calls, retryPrompt, counters }));
`));
    expect(result.success).toBe(true);
    expect(result.calls).toBe(2);
    expect(String(result.retryPrompt)).toContain("只输出一个完整合法 JSON 对象");
    expect(result.counters).toEqual(expect.objectContaining({ checkpoints: 1, timing: 1 }));
  }, 90_000);

  it("Phase3 单镜重试仍降级时用源合同恢复，并在最终评审投影后继续推进", () => {
    const result = runInChild(phase3Fixture(`
const uninstall = installVendorPhase3FusionBridge();
const state = makeState({
 scene: "出租屋门外楼道，雨夜，湿伞靠在门边",
 action: "陈卓在门外收伞，随后用钥匙开门",
 lightingString: "楼道冷光，室内旧台灯尚未点亮",
 camera_movement: "固定机位稳定拍摄"
});
const phase = makePhase({
 process: async shots => ({
  shots: shots.map(s => ({ ...s, prompt: "", fields: {}, degraded: true, degradeReason: "provider-empty-fields" })),
  degraded: true,
  stats: { failed: shots.length, total: shots.length }
 })
});
const output = await phase.execute(state);
uninstall();
console.log("RESULT " + JSON.stringify({
 success: output.success,
 degraded: output.shots[0].degraded,
 recovery: output.result.stages.phase3Recovery,
 retry: output.result.stages.phase3Retry,
 prompt: output.shots[0].prompt,
 policy: output.shots[0]._workloomPromptReviewPolicy
}));
`));
    expect(result.success).toBe(true);
    expect(result.degraded).toBe(false);
    expect(result.recovery).toMatchObject({
      recovered: ["SC-01"],
      mode: "contract-source-reprojection",
      requiresFinalReviewProjection: true,
    });
    expect(result.retry).toMatchObject({ repaired: ["SC-01"] });
    expect(String(result.prompt)).toContain("楼道/门外门口");
    expect(String(result.prompt)).toContain("陈卓在门外收伞");
    expect(result.policy).toMatchObject({ aspectRatio: expect.any(String), maxLength: expect.any(Number) });
  }, 90_000);

  it("预算拒绝或未知预算在任何路由模型/融合调用之前停止", () => {
    const result = runInChild(phase3Fixture(`
const uninstall = installVendorPhase3FusionBridge();
const errors = [];
for (const opts of [{ canAfford: () => false }, { budgetRemaining: () => Infinity }, { budgetRemaining: () => 0 }]) {
 const state = makeState();
 try { await makePhase({}, opts).execute(state); } catch (e) { errors.push({ code: e.code, status: state.result.stages.phase3Fusion.status }); }
}
uninstall();
console.log("RESULT " + JSON.stringify({ errors, counters }));
`));
    expect(result.errors).toEqual([
      { code: "PHASE3_BUDGET_EXHAUSTED", status: "failed" },
      { code: "PHASE3_BUDGET_UNVERIFIED", status: "unverified" },
      { code: "PHASE3_BUDGET_UNVERIFIED", status: "unverified" },
    ]);
    expect(result.counters).toEqual({ fusion: 0, checkpoints: 0, llm: 0, timing: 0 });
  }, 90_000);

  it("提供商边界再次核预算：第一次返回后耗尽，第二次绝不发出；原 agent 未被改写", () => {
    const result = runInChild(phase3Fixture(`
const uninstall = installVendorPhase3FusionBridge();
let left = 120000, providerCalls = 0, providerOptions = null;
const rawEngine = { reasonStructured: async (_prompt, _schema, opts) => { providerCalls++; providerOptions = opts; left = 100; return {}; } };
const phase = makePhase({
 _getLLMEngine: () => rawEngine,
 process: async function () {
  await this._getLLMEngine().reasonStructured("first", {}, { timeoutMs: 300000 });
  await this._getLLMEngine().reasonStructured("second", {}, { timeoutMs: 300000 });
  throw new Error("不应到达");
 }
}, { budgetRemaining: () => left });
const originalEngine = phase.agents.promptFusion._getLLMEngine;
const state = makeState();
let code = null;
try { await phase.execute(state); } catch (e) { code = e.code; }
uninstall();
console.log("RESULT " + JSON.stringify({ providerCalls, providerOptions, code, counters,
 unchanged: phase.agents.promptFusion._getLLMEngine === originalEngine,
 status: state.result.stages.phase3Fusion.status }));
`));
    expect(result.providerCalls).toBe(1);
    expect(result.code).toBe("PHASE3_BUDGET_EXHAUSTED");
    expect(result.status).toBe("failed");
    expect(Number((result.providerOptions as Record<string, unknown>).timeoutMs)).toBeLessThanOrEqual(120000);
    expect(result.unchanged).toBe(true);
    expect((result.counters as Record<string, unknown>).checkpoints).toBe(0);
  }, 90_000);

  it("运行中预算变未知与 health 清理失败不会落通过 checkpoint", () => {
    const result = runInChild(phase3Fixture(`
const uninstall = installVendorPhase3FusionBridge();
const errors = [];
let left = 120000;
const state = makeState();
try { await makePhase({ process: async shots => {
 left = NaN; return { shots: shots.map(s => ({ ...s, prompt: "表盘特写" })) };
} }, { budgetRemaining: () => left }).execute(state); }
catch (e) { errors.push({ code: e.code, status: state.result.stages.phase3Fusion.status }); }
const healthState = makeState();
try { await makePhase({}, { healthMonitor: { setLongTaskMode: (_name, active) => { if (!active) throw new Error("cleanup unavailable"); } } }).execute(healthState); }
catch (e) { errors.push({ code: e.code, status: healthState.result.stages.phase3Fusion.status }); }
uninstall();
console.log("RESULT " + JSON.stringify({ errors, counters }));
`));
    expect(result.errors).toEqual([
      { code: "PHASE3_BUDGET_UNVERIFIED", status: "unverified" },
      { code: "PHASE3_HEALTH_CLEANUP_FAILED", status: "unverified" },
    ]);
    expect((result.counters as Record<string, unknown>).checkpoints).toBe(0);
  }, 90_000);

  it("真实 BaseAgent 的 critical 备用模型与最终缩短重试也遵守外调预算", () => {
    const result = runInChild(phase3Fixture(`
const uninstall = installVendorPhase3FusionBridge();
let mainCalls = 0, altCalls = 0;
const errors = [];
for (const source of ["getter", "option"]) {
 let left = 120000;
 const real = new PromptFusionAgent({ semanticRefinement: false, llmMaxRetries: 1 });
 const alt = { reasonStructured: async () => { altCalls++; return { success: true, data: { picks: [] } }; } };
 real._getLLMEngine = () => ({ reasonStructured: async () => {
  mainCalls++; left = 0; return { success: false, error: "offline-budget-fixture", type: "NETWORK", retryable: false };
 } });
 if (source === "getter") real._getAltLLMEngine = () => alt;
 real.process = async function () {
  await this._callLLM("摄影技能的原始场景。".repeat(200), { required: ["picks"] }, () => null,
   { critical: true, ...(source === "option" ? { altModel: alt } : {}) });
  throw new Error("不能到达预算耗尽后的成功分支");
 };
 const phase = makePhase({}, { budgetRemaining: () => left });
 phase.agents.promptFusion = real;
 try { await phase.execute(makeState()); } catch (e) { errors.push(e.code); }
}
uninstall();
console.log("RESULT " + JSON.stringify({ mainCalls, altCalls, errors, checkpoints: counters.checkpoints }));
`));
    expect(result).toEqual({ mainCalls: 2, altCalls: 0, errors: ["PHASE3_BUDGET_EXHAUSTED", "PHASE3_BUDGET_EXHAUSTED"], checkpoints: 0 });
  }, 90_000);

  it("无源合同的融合异常仍失败关闭，空 prompt 和错 id 只能通过源合同恢复", () => {
    const result = runInChild(phase3Fixture(`
const uninstall = installVendorPhase3FusionBridge();
const failures = [];
const recoveries = [];
const cases = [
 { name: "provider", process: async () => { throw new Error("provider unavailable"); } },
 { name: "without-source", state: makeState({ scene: "", action: "", promptBase: "", sceneFunction: "" }),
   process: async shots => ({ shots: shots.map(s => ({ ...s, prompt: "规则兜底" })), degraded: true }) },
 { name: "empty", process: async shots => ({ shots: shots.map(s => ({ ...s, prompt: "" })) }) },
 { name: "wrong-id", process: async shots => ({ shots: shots.map(s => ({ ...s, shotId: "other", prompt: "内容" })) }) },
];
for (const candidate of cases) {
 const state = candidate.state || makeState();
 try {
  const output = await makePhase(candidate).execute(state);
  recoveries.push({ name: candidate.name, degraded: output.shots[0].degraded, recovery: output.result.stages.phase3Recovery });
 } catch (e) { failures.push({ name: candidate.name, code: e.code, status: state.result.stages.phase3Fusion.status }); }
}
const state = makeState();
try { await makePhase({}, { saveCheckpoint: async () => { throw new Error("disk unavailable"); } }).execute(state); }
catch (e) { failures.push({ name: "checkpoint", code: e.code, status: state.result.stages.phase3Fusion.status }); }
uninstall();
console.log("RESULT " + JSON.stringify({ failures, recoveries, counters }));
`));
    expect((result.failures as Array<{ name: string }>).map((item) => item.name)).toEqual(["provider", "without-source", "checkpoint"]);
    for (const failure of result.failures as Array<{ status: string }>) expect(failure.status).toBe("unverified");
    expect(result.recoveries).toEqual([
      { name: "empty", degraded: false, recovery: { recovered: ["SC-01"], mode: "contract-source-reprojection", requiresFinalReviewProjection: true } },
      { name: "wrong-id", degraded: false, recovery: { recovered: ["SC-01"], mode: "contract-source-reprojection", requiresFinalReviewProjection: true } },
    ]);
  }, 90_000);

  it("同一进程重复安装采用引用计数，最后卸载精确复原", () => {
    const result = runInChild(phase3Fixture(`
const original = Phase3PromptFusion.prototype.execute;
const produce = ProductionEngine.prototype.produce;
const releaseA = installVendorPhase3FusionBridge();
const installed = Phase3PromptFusion.prototype.execute;
const releaseB = installVendorPhase3FusionBridge();
const singlePatch = installed === Phase3PromptFusion.prototype.execute;
const refs = listSharedBridges().find(x => x.key === "phase3-fusion-policy-v1").refs;
releaseA(); releaseA();
const stillInstalled = installed === Phase3PromptFusion.prototype.execute;
releaseB();
console.log("RESULT " + JSON.stringify({ singlePatch, refs, stillInstalled,
 restored: original === Phase3PromptFusion.prototype.execute && produce === ProductionEngine.prototype.produce,
 absent: !listSharedBridges().some(x => x.key === "phase3-fusion-policy-v1") }));
`));
    expect(result).toEqual({ singlePatch: true, refs: 2, stillInstalled: true, restored: true, absent: true });
  }, 90_000);

  it("安装日志抛错也还原原型且不遗留共享引用", () => {
    const result = runInChild(phase3Fixture(`
const original = Phase3PromptFusion.prototype.execute, produce = ProductionEngine.prototype.produce;
let error = null;
try { installVendorPhase3FusionBridge({ log: () => { throw new Error("logger failed"); } }); } catch (e) { error = e.message; }
console.log("RESULT " + JSON.stringify({ error, restored: original === Phase3PromptFusion.prototype.execute && produce === ProductionEngine.prototype.produce,
 absent: !listSharedBridges().some(x => x.key === "phase3-fusion-policy-v1") }));
`));
    expect(result).toEqual({ error: "logger failed", restored: true, absent: true });
  }, 90_000);

  it("vendor RECOVERY 宣称成功也被外层拦下；未知旧断点不能伪过", () => {
    const result = runInChild(phase3Fixture(`
const original = ProductionEngine.prototype.produce;
let payload = { success: true, degraded: true, shots: [{ prompt: "兜底" }], stages: { phase3Fusion: { status: "failed", code: "PHASE3_BUDGET_EXHAUSTED" } } };
ProductionEngine.prototype.produce = async () => payload;
const uninstall = installVendorPhase3FusionBridge();
const errors = [];
try { await ProductionEngine.prototype.produce.call({}, makeState().adaptedBlueprint); } catch (e) { errors.push(e.code); }
payload = { success: true, resumed: true, shots: [{ prompt: "旧断点" }], stages: {} };
try { await ProductionEngine.prototype.produce.call({}, makeState().adaptedBlueprint); } catch (e) { errors.push(e.code); }
uninstall(); ProductionEngine.prototype.produce = original;
console.log("RESULT " + JSON.stringify({ errors }));
`));
    expect(result.errors).toEqual(["PHASE3_BUDGET_EXHAUSTED", "PHASE3_FUSION_UNVERIFIED"]);
  }, 90_000);
});

describe("VideoStudio 的 C1 实际安装入口", () => {
  it("runPreproduction 经现有兼容入口安装并消费 Phase3，失败与成功均卸载还原", () => {
    const workDir = mkdtempSync(join(tmpdir(), "wl-phase3-entry-"));
    const result = runInChild(phase3Fixture(`
const { VideoStudio } = await import(${JSON.stringify(resolve(here, "studio.ts"))});
const entry = require(${JSON.stringify(join(repoRoot, "vendor/supermickey/hyperreality-system/index.js"))});
const OriginalSystem = entry.HyperrealitySystem;
const originalExecute = Phase3PromptFusion.prototype.execute;
const events = [];
let installedAtCreate = false;
let fail = false;
entry.HyperrealitySystem = class OfflineSystem {
 async create() {
  installedAtCreate = installedAtCreate || listSharedBridges().some(x => x.key === "phase3-fusion-policy-v1");
  const output = await makePhase({}, fail ? { canAfford: () => false } : {}).execute(makeState());
  return { success: output.success, stages: { productionEngine: { ...output.result, shots: output.shots } } };
 }
};
let success = false, status = null, failure = null, restored = false;
try {
 const studio = new VideoStudio({ llm: { model: "offline", fastModel: "offline" }, workDir: ${JSON.stringify(workDir)},
  onApproval: async () => ({ approved: true }), onEvent: e => events.push(e.kind), log: () => {}, portraits: { enabled: false } });
 const output = await studio.runPreproduction({ projectId: "C1-offline-entry", intent: "观察表盘" });
 success = output.success;
 status = output.stages.productionEngine.stages.phase3Fusion.status;
 fail = true;
 try { await studio.runPreproduction({ projectId: "C1-offline-failure", intent: "观察表盘" }); } catch (e) { failure = e.code; }
 restored = originalExecute === Phase3PromptFusion.prototype.execute && !listSharedBridges().some(x => x.key === "phase3-fusion-policy-v1");
} finally { entry.HyperrealitySystem = OriginalSystem; }
console.log("RESULT " + JSON.stringify({ success, status, failure, installedAtCreate, restored, events }));
`));
    expect(result.success).toBe(true);
    expect(result.status).toBe("passed");
    expect(result.failure).toBe("PHASE3_BUDGET_EXHAUSTED");
    expect(result.installedAtCreate).toBe(true);
    expect(result.restored).toBe(true);
    expect(result.events).toEqual(expect.arrayContaining(["pipeline.started", "pipeline.finished", "pipeline.failed"]));
  }, 120_000);
});
