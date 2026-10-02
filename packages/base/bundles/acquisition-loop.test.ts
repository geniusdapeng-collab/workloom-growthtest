/**
 * 获客五环闭环完整性（业务域回归测试，只读磁盘资产，不触 DB）。
 *
 * 为什么需要这组测试：`bundle:governance` 已覆盖契约/资产/兼容性/完整性签名，但
 * **管线步骤 owner ↔ 数字员工 preset ↔ 技能资产 ↔ 围栏规则** 这四层之间的交叉引用
 * 无人校验。一旦断链，运行时表现是"某一步没人执行"或"触发器挂空岗"，属于静默失败——
 * 正是 L9.2「不装出半个班子」要禁止的状态。
 */
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import YAML from "yaml";
import { loadOfficialSkills } from "../skills/official.js";
import { bundlesRoot, composeWorkforce } from "./assembly.js";

interface PresetDoc {
  preset_key?: string;
  skills?: string[];
  fence_bindings?: string[];
}

interface PipelineDoc {
  quest?: string;
  steps?: Array<{ step_key?: string; owner?: string; gates?: string[] }>;
}

const ROOT = bundlesRoot();
const REPO_ROOT = dirname(ROOT);
const BUNDLES = readdirSync(ROOT, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name);

function readYaml<T>(file: string): T {
  return YAML.parse(readFileSync(file, "utf8")) as T;
}

function listFiles(dir: string, predicate: (name: string) => boolean): string[] {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...listFiles(path, predicate));
    else if (predicate(entry.name)) out.push(path);
  }
  return out;
}

interface BundleView {
  id: string;
  dir: string;
  presets: Map<string, { file: string; doc: PresetDoc }>;
  pipelines: Array<{ file: string; doc: PipelineDoc }>;
  fenceRuleIds: Set<string>;
}

function loadBundle(id: string): BundleView {
  const dir = join(ROOT, id);
  const presets = new Map<string, { file: string; doc: PresetDoc }>();
  for (const file of listFiles(join(dir, "presets"), (n) => n.endsWith(".yml"))) {
    const doc = readYaml<PresetDoc>(file);
    if (doc.preset_key) presets.set(doc.preset_key, { file, doc });
  }
  const pipelines = listFiles(join(dir, "pipelines"), (n) => n.endsWith(".yml"))
    .map((file) => ({ file, doc: readYaml<PipelineDoc>(file) }));
  const fenceRuleIds = new Set<string>();
  for (const file of listFiles(join(dir, "fences"), (n) => /\.ya?ml$/.test(n))) {
    for (const match of readFileSync(file, "utf8").matchAll(/rule_id:\s*"?([A-Za-z0-9_-]+)"?/g)) {
      fenceRuleIds.add(match[1]!);
    }
  }
  return { id, dir, presets, pipelines, fenceRuleIds };
}

const VIEWS = BUNDLES.map(loadBundle);

/** 官方技能名（用生产加载器解析，测试与运行时同一口径） */
const OFFICIAL_SKILLS = new Set(loadOfficialSkills(REPO_ROOT).map((skill) => skill.name));

/** 注册表技能：skills/registry/<技能>/SKILL.md（平铺单技能） */
function registrySkillExists(skill: string): boolean {
  return existsSync(join(REPO_ROOT, "skills", "registry", skill, "SKILL.md"));
}

/** 技能资产可解析：行业包自带 skills/<name>/，或官方/注册表技能资产 */
function skillAssetExists(bundle: BundleView, skill: string): boolean {
  if (existsSync(join(bundle.dir, "skills", skill))) return true;
  return OFFICIAL_SKILLS.has(skill) || registrySkillExists(skill);
}

describe("获客五环管线：每一步都有人", () => {
  it("管线步骤 owner 必须是本行业包内已定义的数字员工 preset_key（不挂空岗）", () => {
    const broken: string[] = [];
    for (const bundle of VIEWS) {
      for (const { file, doc } of bundle.pipelines) {
        for (const step of doc.steps ?? []) {
          if (!step.owner || !bundle.presets.has(step.owner)) {
            broken.push(`${bundle.id}/${file.split("/").pop()} step=${step.step_key ?? "?"} owner=${step.owner ?? "未声明"}`);
          }
        }
      }
    }
    expect(broken).toEqual([]);
  });

  it("获客主链路（hotel 五环）步骤齐备且顺序覆盖五环", () => {
    const hotel = VIEWS.find((b) => b.id === "hotel")!;
    const loop = hotel.pipelines.find((p) => p.doc.quest === "hotel-acquisition-loop");
    expect(loop, "酒店获客主链路管线缺失").toBeDefined();
    const keys = (loop!.doc.steps ?? []).map((s) => s.step_key);
    expect(keys).toEqual([
      "intent-radar", "content-schedule", "dual-publish", "reception",
      "lead-grading", "coupon-convert", "attribution", "guest-retention", "funnel-review",
    ]);
  });
});

describe("围栏引用完整性：管线门与员工绑定都必须有规则定义", () => {
  it("管线 gates 引用的规则 id 必须在本行业包围栏资产中存在", () => {
    const broken: string[] = [];
    for (const bundle of VIEWS) {
      for (const { file, doc } of bundle.pipelines) {
        for (const step of doc.steps ?? []) {
          for (const gate of step.gates ?? []) {
            if (!bundle.fenceRuleIds.has(gate)) {
              broken.push(`${bundle.id}/${file.split("/").pop()} step=${step.step_key ?? "?"} gate=${gate}`);
            }
          }
        }
      }
    }
    expect(broken).toEqual([]);
  });

  /**
   * 口径是「组合内可解析」：融合产品把三域基线围栏一起装载（service 层 chooseSegment
   * 显式合并 hotel/ai-video/geo-growth 三份基线），因此组合权威岗位可以引用姐妹域的
   * 围栏（如 hotel CEO 引用 G17/G18、geo 复盘岗引用 G13）——这正是跨域融合要表达的语义。
   */
  const composedFenceIds = new Set(VIEWS.flatMap((bundle) => [...bundle.fenceRuleIds]));

  it("员工 fence_bindings 引用的规则 id 必须在组合围栏集中存在（未声明即禁写的前提是可解析）", () => {
    const broken: string[] = [];
    for (const bundle of VIEWS) {
      for (const [key, { file, doc }] of bundle.presets) {
        for (const fence of doc.fence_bindings ?? []) {
          if (!composedFenceIds.has(fence)) {
            broken.push(`${bundle.id}/${file.split("/").pop()} preset=${key} fence=${fence}`);
          }
        }
      }
    }
    expect(broken).toEqual([]);
  });

  it("跨域围栏引用必须落在已声明的组合内（主包依赖覆盖该包）", () => {
    const dependencyIds = new Set(["hotel", "ai-video"]);
    const crossBundleRefs: string[] = [];
    for (const bundle of VIEWS) {
      for (const [key, { doc }] of bundle.presets) {
        for (const fence of doc.fence_bindings ?? []) {
          if (bundle.fenceRuleIds.has(fence) || !composedFenceIds.has(fence)) continue;
          // 该围栏来自其它包：只有当两个包同属一个组合（主包依赖或反向依赖）时才允许
          const others = VIEWS.filter((other) => other.id !== bundle.id && other.fenceRuleIds.has(fence));
          const inComposition = others.some((other) =>
            bundle.id === "geo-growth" || other.id === "geo-growth" || (dependencyIds.has(bundle.id) && dependencyIds.has(other.id)));
          if (!inComposition) crossBundleRefs.push(`${bundle.id}/${key} → ${fence}`);
        }
      }
    }
    expect(crossBundleRefs).toEqual([]);
  });
});

describe("员工技能资产可解析", () => {
  it("preset.skills 的每一项都能解析到行业包技能或官方/注册表技能资产", () => {
    const broken: string[] = [];
    for (const bundle of VIEWS) {
      for (const [key, { file, doc }] of bundle.presets) {
        for (const skill of doc.skills ?? []) {
          if (!skillAssetExists(bundle, skill)) {
            broken.push(`${bundle.id}/${file.split("/").pop()} preset=${key} skill=${skill}`);
          }
        }
      }
    }
    expect(broken).toEqual([]);
  });
});

describe("多领域融合：组合岗位编制裁决", () => {
  /**
   * 组合装载（geo-growth 主包依赖 hotel + ai-video）把三个领域的编制装进同一工作区，
   * 而数字员工身份就是 preset_key（agents 幂等键 =(workspace_id, preset_key)）：
   * 同名不同义只能有一个权威定义，且裁决必须显式、可审计（不静默丢岗）。
   */
  const composed = composeWorkforce("geo-growth");

  it("组合编制内岗位标识唯一（每个 preset_key 只有一个权威定义）", () => {
    const keys = [...composed.presets.keys()];
    expect(new Set(keys).size).toBe(keys.length);
    /**
     * 先校验不变式：组合编制 = 各包编制之和 − 被遮蔽的同名定义数（每个 preset_key 只留一个权威定义）。
     * 再校验该不变式算出的数量与对外口径（README/装配测试的 76 岗）一致——口径漂移时同时暴露两侧。
     * 数量本身随各包编制演化（曾从 61 长到 70、72、73、74，再到 75 —— 2026-09-23 新增 ai-video「字幕师」，
     * 同日再新增 ai-video「配音师」，总数 76；2026-09-24 新增 ai-video「制片人／监制」（77）与「摄影指导」（78）），
     * 所以断言读的是算出来的值，而不是让维护者去猜。
     * 2026-09-25 新增 ai-video「封面设计师」（79）——封面由"抽帧 + 一行字"改成"设计稿 → 合成 → 机检 → 监制"。
     * 2026-09-27 新增 ai-video「口播解说片导演」（80）——解说片产品化（管线/岗位/技能/媒资目录）。
     * 2026-09-27 新增 ai-video「开场钩子设计师」（81）——短平台前 3 秒钩子（钩子卡/首镜模板/钩子音效）。
     */
    const declared = VIEWS.reduce((sum, bundle) => sum + bundle.presets.size, 0);
    const shadowed = composed.shadowed.length;
    expect(keys.length).toBe(declared - shadowed);
    expect(shadowed).toBe(4);
    expect(keys.length).toBe(81);
  });

  it("同名岗位按主包声明落到权威归属包", () => {
    const ownerOf = (key: string) => composed.presets.get(key)?.bundleId;
    expect(ownerOf("ads-optimizer")).toBe("geo-growth");
    expect(ownerOf("publish-operator")).toBe("geo-growth");
    expect(ownerOf("review-analyst")).toBe("geo-growth");
    // 酒店获客复合系统的 CEO 席位由行业包（hotel）持有：其职责覆盖酒店经营节拍与获客漏斗复盘
    expect(ownerOf("company-ceo")).toBe("hotel");
  });

  it("被遮蔽的岗位定义逐条留痕（不静默丢弃）", () => {
    const shadows = composed.shadowed.map((s) => `${s.bundleId}:${s.presetKey}→${s.winnerBundleId}`).sort();
    expect(shadows).toEqual([
      "ai-video:ads-optimizer→geo-growth",
      "ai-video:publish-operator→geo-growth",
      "ai-video:review-analyst→geo-growth",
      "geo-growth:company-ceo→hotel",
    ]);
  });

  it("权威岗位的有效围栏是组合并集（被遮蔽定义的边界不丢，且不改写包内文件）", () => {
    for (const key of ["ads-optimizer", "publish-operator", "review-analyst", "company-ceo"]) {
      const winner = composed.presets.get(key)!;
      const loserFences = VIEWS
        .filter((bundle) => bundle.id !== winner.bundleId)
        .flatMap((bundle) => bundle.presets.get(key)?.doc.fence_bindings ?? []);
      for (const fence of loserFences) {
        expect(winner.effectiveFenceBindings, `${key} 组合有效围栏缺 ${fence}`).toContain(fence);
      }
      expect(winner.shadowedBundleIds.length).toBeGreaterThan(0);
    }
    // 包内文件保持原样：单包装配校验（F2.10 围栏绑定完整）不被组合裁决污染
    const hotelCeo = VIEWS.find((b) => b.id === "hotel")!.presets.get("company-ceo")!.doc.fence_bindings!;
    expect(hotelCeo).toEqual(["R17", "R18", "R19"]);
    const geoReview = VIEWS.find((b) => b.id === "geo-growth")!.presets.get("review-analyst")!.doc.fence_bindings!;
    expect(geoReview).toEqual(["G18"]);
  });

  it("组合编制覆盖三条管线的全部岗位（跨领域闭环不断岗）", () => {
    const missing: string[] = [];
    for (const bundle of VIEWS) {
      for (const { file, doc } of bundle.pipelines) {
        for (const step of doc.steps ?? []) {
          if (!step.owner || !composed.presets.has(step.owner)) {
            missing.push(`${bundle.id}/${file.split("/").pop()} step=${step.step_key ?? "?"} owner=${step.owner ?? "未声明"}`);
          }
        }
      }
    }
    expect(missing).toEqual([]);
  });
});
