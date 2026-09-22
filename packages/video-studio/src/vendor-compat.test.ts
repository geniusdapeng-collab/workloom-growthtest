import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { promptFieldText, rebuildPromptsFromFields } from "./vendor-compat.js";

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
