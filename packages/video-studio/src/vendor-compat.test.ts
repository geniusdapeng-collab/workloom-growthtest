import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { healPromptContract, promptFieldText, rebuildPromptsFromFields } from "./vendor-compat.js";

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
 originalHasPrompt: Boolean(state.shots[0].prompt) }));
`));
    expect(result.beforeSuccess).toBe(false);
    expect(result.beforeError).toContain("Assignment to constant variable");
    expect(result.beforeCalls).toBe(0);
    expect(result.afterSuccess).toBe(true);
    expect(result.status).toBe("passed");
    expect(result.counters).toEqual(expect.objectContaining({ fusion: 1, checkpoints: 1, timing: 1 }));
    expect(result.originalHasPrompt).toBe(false);
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

  it("融合异常/降级/空 prompt/错 id/checkpoint 失败都不能成功返回", () => {
    const result = runInChild(phase3Fixture(`
const uninstall = installVendorPhase3FusionBridge();
const failures = [];
const cases = [
 { process: async () => { throw new Error("provider unavailable"); } },
 { process: async shots => ({ shots: shots.map(s => ({ ...s, prompt: "规则兜底" })), degraded: true }) },
 { process: async shots => ({ shots: shots.map(s => ({ ...s, prompt: "" })) }) },
 { process: async shots => ({ shots: shots.map(s => ({ ...s, shotId: "other", prompt: "内容" })) }) },
];
for (const candidate of cases) {
 const state = makeState();
 try { await makePhase(candidate).execute(state); } catch (e) { failures.push({ code: e.code, status: state.result.stages.phase3Fusion.status }); }
}
const state = makeState();
try { await makePhase({}, { saveCheckpoint: async () => { throw new Error("disk unavailable"); } }).execute(state); }
catch (e) { failures.push({ code: e.code, status: state.result.stages.phase3Fusion.status }); }
uninstall();
console.log("RESULT " + JSON.stringify({ failures, counters }));
`));
    expect(result.failures).toHaveLength(5);
    for (const failure of result.failures as Array<{ status: string }>) expect(failure.status).toBe("unverified");
    expect((result.counters as Record<string, unknown>).checkpoints).toBe(0);
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
