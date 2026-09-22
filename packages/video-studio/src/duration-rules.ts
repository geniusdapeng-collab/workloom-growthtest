/**
 * duration-rules.ts —— 镜头时长规则**唯一真源 + 全量口径清单**（2026-09-23 修订二版）
 *
 * 为什么需要这份清单：单镜时长在 vendor 与宿主两侧散落成多条口径，任何一条没对齐，
 * 都会表现成「计划能拍、提交被拒」或「节奏被悄悄夹紧」。第一版只登记了 5 处、且把
 * ThemeConfig 的层级写错（真实位置是 `types[*].resourceQuota.maxShotDuration`，不是
 * `types[*].maxShotDuration`）；本版按**实际源码逐个核对**重建清单，并区分三件事：
 *   ① `live`   —— 该文件是否真的被其它 vendor 源码引用（未接线的不算风险，只登记）；
 *   ② `bridge` —— 运行期是否由 `installVendorDurationPolicyBridge` 放宽到模型能力上限；
 *   ③ `value`  —— 源码里读到的默认上限（读不到就写 null，不臆造）。
 *
 * 判定规则：`blockers = live && !bridge && value < modelMax` —— blockers 为空即说明
 * 「能力上限 30s 不会被任何在用口径夹回去」；未接线/文档级口径进 `nonLive` 备查。
 *
 * 真机依据（2026-09-23，A 级）：Seedance 2.5 单镜 4–30s（20/25/30 → 200；31/45/60 → 400；
 * 3 → 400；i2v 30s → 200）。
 */
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, relative, resolve as resolvePath } from "node:path";
import { fileURLToPath } from "node:url";

export type DurationSourceKind =
  /** 供应商能力（媒体目录 = 唯一真源） */
  | "provider"
  /** 运行期夹紧（会把镜头时长改掉） */
  | "runtime-clamp"
  /** 规划/校验带（蓝图带、配速带；影响计划与作品级校验） */
  | "planning-band"
  /** 建议口径（写给 LLM / 需求清单，不直接夹紧） */
  | "advisory"
  /** 未接线（vendor 自述 legacy 或全仓无引用） */
  | "orphan";

export interface DurationSource {
  /** 稳定标识（报告与测试引用） */
  id: string;
  kind: DurationSourceKind;
  /** 仓库相对路径 */
  file: string;
  /** 具体字段位置 */
  where: string;
  /** 源码读到的单镜上限（null = 读不到/不适用） */
  value: number | null;
  /** 取值方式：runtime=实例化读运行时；source=源码解析（运行期不可用时的回退）；none=读不到 */
  valueSource: "runtime" | "source" | "none";
  /** 是否被其它源码引用（未接线=false） */
  live: boolean;
  /** 运行期是否有桥放宽到本模型上限 */
  bridge: boolean;
  /** live 时：引用它的文件（截断展示，证据可复核） */
  referencedBy: string[];
  note: string;
}

export interface DurationRules {
  /** 供应商侧能力（媒体目录） */
  modelId: string;
  modelMin: number;
  modelMax: number;
  modelDefault: number;
  /** 全量口径清单（含未接线） */
  sources: DurationSource[];
  /** 仍可能把模型上限夹回去的在用口径（应为空） */
  blockers: DurationSource[];
  /** 未接线/文档级、不构成风险的口径（如实列出，便于复核） */
  nonLive: DurationSource[];
  /** 一致性结论：blockers 为空即为对齐 */
  aligned: boolean;
  /** 兼容旧调用方：等价于旧版 vendorMaxSingleShot / themeMaxShotDuration / builderMaxShotDuration */
  vendorMaxSingleShot: number;
  themeMaxShotDuration: number;
  builderMaxShotDuration: number;
}

export interface DurationPlanEntry {
  shotId: string;
  seconds: number;
  source: number;
  clamped: boolean;
}

export interface DurationValidation {
  pass: boolean;
  targetTotalSeconds: number | null;
  actualTotalSeconds: number;
  entries: DurationPlanEntry[];
  issues: string[];
  warnings: string[];
}

export function repoRoot(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  return resolvePath(here, "../../..");
}

/* ============================ ① 供应商能力（唯一真源） ============================ */

/** 读取媒体目录里某模型的时长能力（唯一真源） */
export function loadModelDurationLimits(modelId: string): { min: number; max: number; default: number } {
  const path = process.env.WORKLOOM_MEDIA_CATALOG?.trim()
    || resolvePath(repoRoot(), "bundles/ai-video/library/media-catalog/media-catalog.json");
  const doc = JSON.parse(readFileSync(path, "utf8")) as {
    models: Array<{ id: string; limits?: { durationSec?: { min?: number; max?: number; default?: number } } }>;
  };
  const model = doc.models.find((m) => m.id === modelId);
  if (!model) throw new Error(`媒体目录里没有模型 ${modelId}（${path}）：请先登记供应商能力`);
  const limits = model.limits?.durationSec ?? {};
  return {
    min: limits.min ?? 4,
    max: limits.max ?? 15,
    default: limits.default ?? 5
  };
}

/* ============================ ② vendor 引用扫描（判定 live） ============================ */

let vendorFilesCache: Array<{ file: string; text: string }> | null = null;
const SCAN_EXT = new Set([".js", ".mjs", ".cjs", ".ts", ".mts", ".json"]);

/** 读入 vendor/supermickey 源码（跳过 node_modules 与超大文件），用于判定模块是否接线 */
function vendorFiles(): Array<{ file: string; text: string }> {
  if (vendorFilesCache) return vendorFilesCache;
  const root = resolvePath(repoRoot(), "vendor/supermickey");
  const out: Array<{ file: string; text: string }> = [];
  const walk = (dir: string, depth: number): void => {
    if (depth > 8) return;
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry === "node_modules" || entry.startsWith(".")) continue;
      const full = resolvePath(dir, entry);
      let stat;
      try {
        stat = statSync(full);
      } catch {
        continue;
      }
      if (stat.isDirectory()) {
        walk(full, depth + 1);
        continue;
      }
      const dot = entry.lastIndexOf(".");
      if (dot < 0 || !SCAN_EXT.has(entry.slice(dot))) continue;
      if (stat.size > 1_500_000) continue;
      try {
        out.push({ file: full, text: readFileSync(full, "utf8") });
      } catch {
        /* 读不到就跳过：live 判定会退化为 false，由 note 说明 */
      }
    }
  };
  walk(root, 0);
  vendorFilesCache = out;
  return out;
}

/** 谁引用了这个模块（按模块名匹配；排除自身） */
function referencedBy(relFile: string, token: string): string[] {
  const self = resolvePath(repoRoot(), relFile);
  return vendorFiles()
    .filter((f) => f.file !== self && f.text.includes(token))
    .map((f) => relative(repoRoot(), f.file))
    .sort()
    .slice(0, 6);
}

/* ============================ ③ 全量口径清单 ============================ */

const VENDOR = "vendor/supermickey";
const DCM_FILE = `${VENDOR}/hyperreality-system/engines/duration-constraint/duration-constraint-manager.js`;
const THEME_FILE = `${VENDOR}/hyperreality-system/config/theme-config.js`;
const PLATFORM_FILE = `${VENDOR}/hyperreality-system/config/platform-profiles.js`;
const ALLOCATOR_FILE = `${VENDOR}/systems/shot-duration-allocator.js`;
const BUILDER_FILE = `${VENDOR}/hyperreality-system/engines/script-engine/core/requirement-list-builder.js`;
const MEDIA_CATALOG = "bundles/ai-video/library/media-catalog/media-catalog.json";

/**
 * 取值结果：优先**实例化读运行时**（A 级），该环境 require 不可用时回退**源码解析**（B 级）。
 * 回退不是静默：`error` 会写进对应口径的 note，报告与测试都能看到取值方式。
 */
interface DurationProbe {
  value: number | null;
  via: "runtime" | "source" | "none";
  error?: string;
}

function vendorRequireFor(): NodeJS.Require {
  return createRequire(resolvePath(repoRoot(), "package.json"));
}

function fileText(relFile: string): string | null {
  const file = resolvePath(repoRoot(), relFile);
  if (!existsSync(file)) return null;
  try {
    return readFileSync(file, "utf8");
  } catch {
    return null;
  }
}

function probeValue(run: () => number | null, fallback: () => number | null): DurationProbe {
  try {
    const value = run();
    if (value !== null && Number.isFinite(value)) return { value, via: "runtime" };
  } catch (err) {
    const fallbackValue = fallback();
    return {
      value: fallbackValue,
      via: fallbackValue === null ? "none" : "source",
      error: err instanceof Error ? err.message : String(err)
    };
  }
  const fallbackValue = fallback();
  return { value: fallbackValue, via: fallbackValue === null ? "none" : "source" };
}

/** 把取值方式/失败原因写进口径备注（不吞异常） */
function withProbe(base: string, probe: DurationProbe): string {
  if (probe.via === "runtime") return base;
  if (probe.via === "source") {
    return `${base}；运行期实例化不可用（${probe.error ?? "该环境 require 被拦截"}），值来自源码解析`;
  }
  return `${base}；读取失败：${probe.error ?? "未找到字段"}`;
}

function readDurationConstraintDefaults(): { maxSingleShot: DurationProbe; maxRhythmUpper: DurationProbe } {
  const file = resolvePath(repoRoot(), DCM_FILE);
  const text = fileText(DCM_FILE) ?? "";
  return {
    maxSingleShot: probeValue(
      () => {
        const mod = vendorRequireFor()(file) as {
          DurationConstraintManager?: new (o?: Record<string, unknown>) => { maxSingleShot?: number };
        };
        const probe = mod.DurationConstraintManager ? new mod.DurationConstraintManager({}) : null;
        const value = Number(probe?.maxSingleShot);
        return Number.isFinite(value) ? value : null;
      },
      () => {
        const match = /this\.maxSingleShot\s*=\s*options\.maxSingleShot\s*\|\|\s*(\d+)/.exec(text);
        return match ? Number(match[1]) : null;
      }
    ),
    maxRhythmUpper: probeValue(
      () => {
        const mod = vendorRequireFor()(file) as {
          DurationConstraintManager?: new (o?: Record<string, unknown>) => {
            rhythmProfiles?: Record<string, { shotRange?: number[] }>;
          };
        };
        const probe = mod.DurationConstraintManager ? new mod.DurationConstraintManager({}) : null;
        const uppers = Object.values(probe?.rhythmProfiles ?? {})
          .map((p) => Number(p?.shotRange?.[1]))
          .filter((n) => Number.isFinite(n));
        return uppers.length > 0 ? Math.max(...uppers) : null;
      },
      () => {
        const uppers = [...text.matchAll(/shotRange:\s*\[\s*\d+\s*,\s*(\d+)\s*\]/g)].map((m) => Number(m[1]));
        return uppers.length > 0 ? Math.max(...uppers) : null;
      }
    )
  };
}

function readThemeQuotaMax(): DurationProbe {
  const file = resolvePath(repoRoot(), THEME_FILE);
  const text = fileText(THEME_FILE) ?? "";
  return probeValue(
    () => {
      const theme = vendorRequireFor()(file) as {
        types?: Record<string, { resourceQuota?: { maxShotDuration?: number } }>;
      };
      const values = Object.values(theme?.types ?? {})
        .map((t) => Number(t?.resourceQuota?.maxShotDuration))
        .filter((n) => Number.isFinite(n) && n > 0);
      return values.length > 0 ? Math.min(...values) : null;
    },
    () => {
      const values = [...text.matchAll(/maxShotDuration:\s*(\d+)/g)].map((m) => Number(m[1]));
      return values.length > 0 ? Math.min(...values) : null;
    }
  );
}

function readPlatformBandMax(): DurationProbe {
  const file = resolvePath(repoRoot(), PLATFORM_FILE);
  const text = fileText(PLATFORM_FILE) ?? "";
  return probeValue(
    () => {
      const mod = vendorRequireFor()(file) as { PROFILES?: Record<string, { shotDuration?: { max?: number } }> };
      const values = Object.values(mod?.PROFILES ?? {})
        .map((p) => Number(p?.shotDuration?.max))
        .filter((n) => Number.isFinite(n) && n > 0);
      return values.length > 0 ? Math.max(...values) : null;
    },
    () => {
      const values = [...text.matchAll(/shotDuration:\s*\{\s*min:\s*\d+,\s*max:\s*(\d+)/g)].map((m) => Number(m[1]));
      return values.length > 0 ? Math.max(...values) : null;
    }
  );
}

function readAllocatorMax(): DurationProbe {
  const file = resolvePath(repoRoot(), ALLOCATOR_FILE);
  const text = fileText(ALLOCATOR_FILE) ?? "";
  return probeValue(
    () => {
      const mod = vendorRequireFor()(file) as {
        ShotDurationAllocator?: new (o?: Record<string, unknown>) => { config?: { maxDuration?: number } };
      };
      const instance = mod.ShotDurationAllocator ? new mod.ShotDurationAllocator({}) : null;
      const value = Number(instance?.config?.maxDuration);
      return Number.isFinite(value) ? value : null;
    },
    () => {
      const match = /maxDuration:\s*(\d+)/.exec(text);
      return match ? Number(match[1]) : null;
    }
  );
}

function readRequirementBuilderMax(): DurationProbe {
  const file = resolvePath(repoRoot(), BUILDER_FILE);
  const text = fileText(BUILDER_FILE) ?? "";
  return probeValue(
    () => {
      const mod = vendorRequireFor()(file) as { ParserRules?: { constraints?: { maxShotDuration?: number } } };
      const value = Number(mod?.ParserRules?.constraints?.maxShotDuration);
      return Number.isFinite(value) ? value : null;
    },
    () => {
      const match = /constraints:\s*\{[\s\S]{0,80}?maxShotDuration:\s*(\d+)/.exec(text);
      return match ? Number(match[1]) : null;
    }
  );
}

/**
 * 全量口径清单（按源码逐个核对，2026-09-23）。
 * vendor 模块增删时，「清单与源码一致」单测会失败，提醒同步维护这份清单。
 */
export function loadDurationSources(modelId = "doubao-seedance-2-5"): DurationSource[] {
  const model = loadModelDurationLimits(modelId);
  const dcm = readDurationConstraintDefaults();
  const themeQuota = readThemeQuotaMax();
  const platformBand = readPlatformBandMax();
  const allocatorMax = readAllocatorMax();
  const builderMax = readRequirementBuilderMax();
  return [
    {
      id: "media-catalog",
      kind: "provider",
      file: MEDIA_CATALOG,
      where: `models[${modelId}].limits.durationSec.max`,
      value: model.max,
      valueSource: "runtime",
      live: true,
      bridge: false,
      referencedBy: ["apps/server/src/video/gen/catalog.ts（运行时读取）", "packages/video-studio/src/duration-rules.ts"],
      note: "供应商能力唯一真源；`bridge=false` 表示它就是被放宽到的目标值（无需桥）"
    },
    {
      id: "dcm-class-default",
      kind: "runtime-clamp",
      file: DCM_FILE,
      where: "DurationConstraintManager 构造函数默认 maxSingleShot",
      value: dcm.maxSingleShot.value,
      valueSource: dcm.maxSingleShot.via,
      live: referencedBy(DCM_FILE, "duration-constraint-manager").length > 0,
      bridge: true,
      referencedBy: referencedBy(DCM_FILE, "duration-constraint-manager"),
      note: withProbe(
        "由 hyperreality-system/index.js 构造；studio 另传 durationConstraint.maxSingleShot 双保险，桥再兜默认值",
        dcm.maxSingleShot
      )
    },
    {
      id: "dcm-rhythm-profiles",
      kind: "runtime-clamp",
      file: DCM_FILE,
      where: "rhythmProfiles.*.shotRange[1]（fast 8 / standard 12 / slow 15）",
      value: dcm.maxRhythmUpper.value,
      valueSource: dcm.maxRhythmUpper.via,
      live: true,
      bridge: true,
      referencedBy: [`${VENDOR}/hyperreality-system/index.js（constrain 调用点）`],
      note: withProbe("climax 镜按 shotRange[1]×climaxRatio 夹紧；桥把实例上界抬到模型上限", dcm.maxRhythmUpper)
    },
    {
      id: "theme-config-resource-quota",
      kind: "planning-band",
      file: THEME_FILE,
      where: "types[*].resourceQuota.maxShotDuration（11 个题材，KIDS=10）",
      value: themeQuota.value,
      valueSource: themeQuota.via,
      live: referencedBy(THEME_FILE, "theme-config").length > 0,
      bridge: true,
      referencedBy: referencedBy(THEME_FILE, "theme-config"),
      note: withProbe(
        "⚠️ 第一版把层级写成 types[*].maxShotDuration（不存在的字段）；真实位置在 resourceQuota 下。"
        + "当前无调用方消费该字段（checkResourceQuota 只比镜头数），属「已对齐但不阻断」",
        themeQuota
      )
    },
    {
      id: "platform-profiles-shot-band",
      kind: "planning-band",
      file: PLATFORM_FILE,
      where: "PROFILES[*].shotDuration.max（cinematic 12 / tiktok·douyin 5）",
      value: platformBand.value,
      valueSource: platformBand.via,
      live: referencedBy(PLATFORM_FILE, "platform-profiles").length > 0,
      bridge: true,
      referencedBy: referencedBy(PLATFORM_FILE, "platform-profiles"),
      note: withProbe(
        "被 PromptDeliveryGuard.verifyPackage 的作品级时长带消费（30s 单镜会判越带）；桥把 max 抬到模型上限，min 保留",
        platformBand
      )
    },
    {
      id: "shot-duration-allocator",
      kind: "planning-band",
      file: ALLOCATOR_FILE,
      where: "ShotDurationAllocator.config.maxDuration（15）+ roleConfig[*].max（6–12）",
      value: allocatorMax.value,
      valueSource: allocatorMax.via,
      live: referencedBy(ALLOCATOR_FILE, "shot-duration-allocator").length > 0,
      bridge: true,
      referencedBy: referencedBy(ALLOCATOR_FILE, "shot-duration-allocator"),
      note: withProbe(
        "production-engine 以 loadModule('shot-duration-allocator.js') 引入（标注「时长分配（在用）」），"
        + "但当前 _allocateDuration 只做存在性判断、未实例化（保留原始时长）；仍按在用口径放宽",
        allocatorMax
      )
    },
    {
      id: "requirement-list-defaults",
      kind: "advisory",
      file: BUILDER_FILE,
      where: "ParserRules.constraints.maxShotDuration（默认建议上限）",
      value: builderMax.value,
      valueSource: builderMax.via,
      live: referencedBy(BUILDER_FILE, "requirement-list-builder").length > 0,
      bridge: true,
      referencedBy: referencedBy(BUILDER_FILE, "requirement-list-builder"),
      note: withProbe(
        "需求清单里的建议上限（写给 LLM/规划）；桥改写为模型上限，避免规划端按 15s 拆镜",
        builderMax
      )
    },
    {
      id: "requirement-list-result",
      kind: "advisory",
      file: BUILDER_FILE,
      where: "RequirementListBuilder._buildRequirementList() 返回体的 constraints.maxShotDuration（字面量 15）",
      value: builderMax.value,
      valueSource: builderMax.via,
      live: true,
      bridge: true,
      referencedBy: [`${BUILDER_FILE}（返回体字面量）`],
      note: "返回体字面量，桥在方法出口覆写为模型上限"
    },
    {
      id: "duration-calculator",
      kind: "orphan",
      file: `${VENDOR}/systems/duration-calculator.js`,
      where: "config.maxDuration（15）",
      value: 15,
      valueSource: "source",
      live: referencedBy(`${VENDOR}/systems/duration-calculator.js`, "duration-calculator").length > 0,
      bridge: false,
      referencedBy: referencedBy(`${VENDOR}/systems/duration-calculator.js`, "duration-calculator"),
      note: "production-engine legacyModules 自述「durationCalculator: 未使用」；不接线则不改"
    },
    {
      id: "duration-narration-alignment",
      kind: "orphan",
      file: `${VENDOR}/systems/duration-narration-alignment.js`,
      where: "config.maxDuration（20）",
      value: 20,
      valueSource: "source",
      live: referencedBy(`${VENDOR}/systems/duration-narration-alignment.js`, "duration-narration-alignment").length > 0,
      bridge: false,
      referencedBy: referencedBy(`${VENDOR}/systems/duration-narration-alignment.js`, "duration-narration-alignment"),
      note: "全仓无 require；若将来接线需补桥（20s < 30s）"
    },
    {
      id: "pre-production-report-generator",
      kind: "orphan",
      file: `${VENDOR}/systems/pre-production-report-generator.js`,
      where: "config.maxDuration（默认 15）",
      value: 15,
      valueSource: "source",
      live: referencedBy(`${VENDOR}/systems/pre-production-report-generator.js`, "pre-production-report-generator").length > 0,
      bridge: false,
      referencedBy: referencedBy(`${VENDOR}/systems/pre-production-report-generator.js`, "pre-production-report-generator"),
      note: "全仓无 require（只做报告期告警）；不接线则不改"
    },
    {
      id: "host-render-allocator",
      kind: "provider",
      file: "scripts/tools/render-project.mts",
      where: "allocateShotDurations（共享 duration-rules，目录驱动）",
      value: model.max,
      valueSource: "runtime",
      live: true,
      bridge: false,
      referencedBy: ["scripts/tools/render-project.mts"],
      note: "宿主出片工具分配器：上限取自媒体目录（本轮从硬编码 4–15 改为目录驱动）"
    },
    {
      id: "host-server-clamp",
      kind: "runtime-clamp",
      file: "apps/server/src/video/router.ts",
      where: "renderRouter.submit 的 durationSec 夹紧（chosen.limits.durationSec）",
      value: model.max,
      valueSource: "runtime",
      live: true,
      bridge: false,
      referencedBy: ["apps/server/src/video/router.ts"],
      note: "平台提交侧夹紧：目录改完即生效（本轮从 15 默认值变为 30）"
    }
  ];
}

/** 汇总口径（含 blockers / nonLive 分类） */
export function loadDurationRules(modelId = "doubao-seedance-2-5"): DurationRules {
  const model = loadModelDurationLimits(modelId);
  const sources = loadDurationSources(modelId);
  const blockers = sources.filter((s) =>
    s.live && !s.bridge && s.value !== null && s.value < model.max && s.kind !== "provider");
  const nonLive = sources.filter((s) => !s.live && s.value !== null && s.value < model.max);
  const pick = (id: string): number => sources.find((s) => s.id === id)?.value ?? model.max;
  return {
    modelId,
    modelMin: model.min,
    modelMax: model.max,
    modelDefault: model.default,
    sources,
    blockers,
    nonLive,
    aligned: blockers.length === 0,
    vendorMaxSingleShot: pick("dcm-class-default"),
    themeMaxShotDuration: pick("theme-config-resource-quota"),
    builderMaxShotDuration: pick("requirement-list-defaults")
  };
}

/* ============================ ④ 分配与校验 ============================ */

/**
 * 按目标总时长分配逐镜时长（等比缩放 + 夹紧到模型能力区间 + 余量补给最长镜）。
 * 与 `render-project.mts` 此前实现语义一致，但上限改为**从媒体目录读取**。
 */
export function allocateShotDurations(
  shots: Array<{ shotId: string; duration?: number }>,
  options: { totalSeconds: number; modelId?: string; minSeconds?: number; maxSeconds?: number }
): { entries: DurationPlanEntry[]; map: Map<string, number> } {
  const limits = loadModelDurationLimits(options.modelId ?? "doubao-seedance-2-5");
  const min = options.minSeconds ?? limits.min;
  const max = options.maxSeconds ?? limits.max;
  const raw = shots.map((s) => Math.max(1, Number(s.duration) || min));
  const sum = raw.reduce((a, b) => a + b, 0) || 1;
  const scaled = raw.map((d) => Math.min(max, Math.max(min, Math.round((d * options.totalSeconds) / sum))));
  let drift = options.totalSeconds - scaled.reduce((a, b) => a + b, 0);
  let guard = 0;
  while (drift !== 0 && guard < 500) {
    const order = scaled.map((d, i) => ({ i, d })).sort((a, b) => b.d - a.d);
    let moved = false;
    for (const { i, d } of order) {
      if (drift > 0 && d < max) { scaled[i] = d + 1; drift -= 1; moved = true; }
      else if (drift < 0 && d > min) { scaled[i] = d - 1; drift += 1; moved = true; }
      if (drift === 0) break;
    }
    if (!moved) break;
    guard += 1;
  }
  const entries = shots.map((s, i) => ({
    shotId: s.shotId,
    seconds: scaled[i]!,
    source: raw[i]!,
    clamped: scaled[i] !== Math.round((raw[i]! * options.totalSeconds) / sum)
  }));
  return { entries, map: new Map(entries.map((e) => [e.shotId, e.seconds])) };
}

/** 统一校验：逐镜区间 + 总时长 + 与规则口径的一致性（blockers 为空才算对齐） */
export function validateShotDurations(
  shots: Array<{ shotId: string; duration?: number; sceneType?: string }>,
  options: { targetTotalSeconds?: number | null; modelId?: string; toleranceSeconds?: number } = {}
): DurationValidation {
  const rules = loadDurationRules(options.modelId ?? "doubao-seedance-2-5");
  const issues: string[] = [];
  const warnings: string[] = [];
  const entries: DurationPlanEntry[] = [];
  const tolerance = options.toleranceSeconds ?? 1;

  for (const shot of shots) {
    const source = Number(shot.duration ?? 0);
    let seconds = source;
    let clamped = false;
    if (seconds < rules.modelMin) {
      seconds = rules.modelMin;
      clamped = true;
      issues.push(`${shot.shotId}: 时长 ${source}s 低于模型下限 ${rules.modelMin}s（已夹紧）`);
    }
    if (seconds > rules.modelMax) {
      seconds = rules.modelMax;
      clamped = true;
      issues.push(`${shot.shotId}: 时长 ${source}s 超过模型上限 ${rules.modelMax}s（已夹紧）`);
    }
    entries.push({ shotId: shot.shotId, seconds, source, clamped });
  }

  const actual = entries.reduce((sum, e) => sum + e.seconds, 0);
  const target = options.targetTotalSeconds ?? null;
  if (target !== null && Math.abs(actual - target) > tolerance) {
    issues.push(`总时长 ${actual}s 与目标 ${target}s 偏差超过 ±${tolerance}s`);
  }
  if (actual > 300) {
    warnings.push(`总时长 ${actual}s 超过 vendor 单作品上限 300s`);
  }
  if (!rules.aligned) {
    warnings.push(
      `时长口径仍有 ${rules.blockers.length} 处在用上限低于模型 ${rules.modelMax}s：`
      + rules.blockers.map((b) => `${b.id}=${b.value}s`).join("；")
    );
  }
  if (rules.nonLive.length > 0) {
    warnings.push(
      "未接线口径（不阻断，登记备查）："
      + rules.nonLive.map((s) => `${s.id}=${s.value}s`).join("；")
    );
  }
  return {
    pass: issues.length === 0,
    targetTotalSeconds: target,
    actualTotalSeconds: actual,
    entries,
    issues,
    warnings
  };
}

/** 逐镜计划表 Markdown（出片报告用） */
export function durationValidationMarkdown(validation: DurationValidation): string {
  return [
    "| 镜头 | 计划(s) | 采用(s) | 夹紧 |",
    "|---|---:|---:|---|",
    ...validation.entries.map((e) => `| ${e.shotId} | ${e.source} | ${e.seconds} | ${e.clamped ? "是" : "—"} |`),
    "",
    `- 合计：${validation.actualTotalSeconds}s`
      + (validation.targetTotalSeconds !== null ? `（目标 ${validation.targetTotalSeconds}s，容差 ±1s）` : ""),
    `- 结论：${validation.pass ? "✅ 通过" : `❌ 不通过（${validation.issues.length} 项）`}`,
    ...validation.issues.map((i) => `  - ${i}`),
    ...validation.warnings.map((w) => `  - ⚠️ ${w}`)
  ].join("\n");
}

/** 口径清单 Markdown（审计/报告用：值 / 是否在用 / 是否有桥） */
export function durationRulesMarkdown(modelId = "doubao-seedance-2-5"): string {
  const rules = loadDurationRules(modelId);
  return [
    `## 单镜时长口径清单（模型 ${rules.modelId}：${rules.modelMin}–${rules.modelMax}s）`,
    "",
    "| 口径 | 类型 | 默认上限 | 取值方式 | 接线 | 运行期桥放宽 | 位置 |",
    "|---|---|---:|---|---|---|---|",
    ...rules.sources.map((s) =>
      `| \`${s.id}\` | ${s.kind} | ${s.value === null ? "—" : `${s.value}s`} | `
      + `${s.valueSource === "runtime" ? "实例化读取" : s.valueSource === "source" ? "源码解析" : "读不到"} | `
      + `${s.live ? "在用" : "未接线"} | ${s.bridge ? "是" : "—"} | ${s.file} |`),
    "",
    `- 结论：${rules.aligned
      ? "✅ 所有**在用**口径都已放宽到模型上限（或本就不构成夹紧）"
      : `❌ 仍有 ${rules.blockers.length} 处在用口径低于模型上限：${rules.blockers.map((b) => b.id).join("、")}`}`,
    `- 未接线口径：${rules.nonLive.length === 0 ? "无" : rules.nonLive.map((s) => `${s.id}=${s.value}s`).join("、")}`
  ].join("\n");
}
