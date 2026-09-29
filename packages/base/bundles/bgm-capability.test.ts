/**
 * BGM 配乐能力（岗位 / 技能 / 配方 / 围栏 / 管线 / 工位桥）交叉引用与语义回归测试。
 *
 * 为什么单独一组：配乐这条链路的失败模式是**静默**的——
 *  · 围栏 when 表达式写错 → 要么放行不该放行的、要么把所有合法配乐都熔断（DSL 求值异常按 block）；
 *  · 配方引用了不存在的和弦/调式 → 作曲内核在真机才炸；
 *  · 岗位/技能/管线/对象四层断链 → 运行时"某一步没人执行"；
 *  · 曲库许可判定写松 → 商用交付踩版权红线。
 * 这些都能在磁盘上静态验出来，所以本组测试不触 DB、不依赖 ffmpeg。
 */
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import YAML from "yaml";

import { evalCondition } from "../fence-engine/expr.js";
import { bundlesRoot } from "./assembly.js";
import {
  BGM_TOOLS, LICENSE_TABLE, SECTION_MODES, alignBeatGrid, chooseSection, deriveDuckParams,
  deriveTempoFromCuts, filmClimaxTime, findRecipes, findTracks, licenseInfo, loadAllLocalTracks,
} from "../../../bundles/ai-video/connectors/bgm-bridge/core.mjs";
import {
  classifySegments, energyEnvelope, estimateBpmFromOnsets, onsetStrength, scoreSegments,
} from "../../../bundles/ai-video/connectors/bgm-bridge/measure.mjs";
import { CHORDS, SCALES, STYLE_PACKS, planComposition, renderCompositionToWav } from "../../../bundles/ai-video/connectors/bgm-bridge/synth.mjs";
import { analyzePromptBrief, energyCurveFor, scoreTrackAgainstBrief } from "../../../bundles/ai-video/connectors/bgm-bridge/brief.mjs";
import { normalizeLicense, listSources, SOURCE_ENV } from "../../../bundles/ai-video/connectors/bgm-bridge/sources.mjs";

const ROOT = bundlesRoot();
const REPO_ROOT = dirname(ROOT);
const BUNDLE_DIR = join(ROOT, "ai-video");

interface FenceRule {
  rule_id: string;
  name: string;
  level: "auto" | "review" | "block";
  is_baseline: boolean;
  match: { object_types: string[]; actions: string[] };
  when: string;
  note?: string;
}

const fencePack = YAML.parse(readFileSync(join(BUNDLE_DIR, "fences/ai-video-bgm.yml"), "utf8")) as {
  version: string;
  default_level: string;
  rules: FenceRule[];
};
const when = (ruleId: string): string => fencePack.rules.find((rule) => rule.rule_id === ruleId)!.when;
const evaluate = (ruleId: string, params: Record<string, unknown> = {}, context: Record<string, unknown> = {}): boolean =>
  evalCondition(when(ruleId), { params, context } as never);

describe("配乐围栏（G-BGM0..G-BGM9）语义", () => {
  it("十条规则齐备，级别与基线口径正确", () => {
    expect(fencePack.version).toBe("ai-video-bgm/v1");
    expect(fencePack.rules.map((rule) => rule.rule_id)).toEqual([
      "G-BGM0", "G-BGM1", "G-BGM2", "G-BGM3", "G-BGM4", "G-BGM5", "G-BGM6", "G-BGM7", "G-BGM8", "G-BGM9",
    ]);
    expect(fencePack.rules.every((rule) => rule.is_baseline === true)).toBe(true);
    const levels = Object.fromEntries(fencePack.rules.map((rule) => [rule.rule_id, rule.level]));
    expect(levels).toEqual({
      "G-BGM0": "auto", "G-BGM1": "review", "G-BGM2": "block",
      "G-BGM3": "block", "G-BGM4": "block", "G-BGM5": "block",
      "G-BGM6": "review", "G-BGM7": "block", "G-BGM8": "block", "G-BGM9": "review",
    });
  });

  it("常规配乐直通；四类红线各自命中；表达式不产生求值异常（异常=全量熔断）", () => {
    // G-BGM0：恒直通
    expect(evaluate("G-BGM0")).toBe(true);

    // G-BGM1：曲库首次入片 / 品牌主题曲变更 → review
    expect(evaluate("G-BGM1", { license_reviewed: false })).toBe(true);
    expect(evaluate("G-BGM1", { theme_change: true })).toBe(true);
    expect(evaluate("G-BGM1", { license_reviewed: true })).toBe(false);
    expect(evaluate("G-BGM1")).toBe(false);

    // G-BGM2：覆盖原片 → block
    expect(evaluate("G-BGM2", { overwrite_source: true })).toBe(true);
    expect(evaluate("G-BGM2", { output_path: "/a.mp4", input_path: "/a.mp4" })).toBe(true);
    expect(evaluate("G-BGM2", { output_path: "/b.mp4", input_path: "/a.mp4" })).toBe(false);

    // G-BGM3：关闭复检 / 丢弃原声 → block
    expect(evaluate("G-BGM3", { skip_verify: true })).toBe(true);
    expect(evaluate("G-BGM3", { verify: false })).toBe(true);
    expect(evaluate("G-BGM3", { mute_dialogue: true })).toBe(true);
    expect(evaluate("G-BGM3", { policy: "music-only" })).toBe(true);
    expect(evaluate("G-BGM3", { policy: "music-only", allow_discard_original: true })).toBe(false);
    expect(evaluate("G-BGM3", { policy: "keep-dialogue" })).toBe(false);

    // G-BGM4：日配额熔断（缺字段按求值异常 → block，属 fail-closed，故运行时必须带值）
    expect(evaluate("G-BGM4", {}, { tenant_daily_bgm: 40 })).toBe(true);
    expect(evaluate("G-BGM4", {}, { tenant_daily_bgm: 39 })).toBe(false);
    expect(() => evalCondition(when("G-BGM4"), { params: {}, context: {} } as never)).toThrow();

    // G-BGM5：版权白名单（缺许可 / NC / ND → 阻断；白名单 → 放行）
    expect(evaluate("G-BGM5", { commercial_use: true })).toBe(true);
    expect(evaluate("G-BGM5", { commercial_use: true, track_license: "unknown" })).toBe(true);
    expect(evaluate("G-BGM5", { commercial_use: true, track_license: "cc-by-nc-4.0" })).toBe(true);
    expect(evaluate("G-BGM5", { commercial_use: true, track_license: "cc-by-nd-4.0" })).toBe(true);
    expect(evaluate("G-BGM5", { commercial_use: true, track_license: "cc0-1.0" })).toBe(false);
    expect(evaluate("G-BGM5", { commercial_use: true, track_license: "cc-by-4.0" })).toBe(false);
    expect(evaluate("G-BGM5", { commercial_use: true, track_license: "cc-by-sa-4.0" })).toBe(false);
    expect(evaluate("G-BGM5", { commercial_use: true, track_license: "royalty-free" })).toBe(false);
    expect(evaluate("G-BGM5", { commercial_use: true, track_license: "workloom-self-generated" })).toBe(false);
    // 非商用场景不拦（但仍受"别把 NC 当商用交付"的技能纪律约束）
    expect(evaluate("G-BGM5", { commercial_use: false, track_license: "cc-by-nc-4.0" })).toBe(false);

    // G-BGM6：新曲源/未核验 provider → review；已核验复用放行
    expect(evaluate("G-BGM6", { new_provider: true })).toBe(true);
    expect(evaluate("G-BGM6", { provider_reviewed: false })).toBe(true);
    expect(evaluate("G-BGM6", { provider_reviewed: true })).toBe(false);
    expect(evaluate("G-BGM6")).toBe(false);

    // G-BGM7：未登记曲源 / 允许未授权源 / 非 http(s) → block
    expect(evaluate("G-BGM7", { unregistered_source: true })).toBe(true);
    expect(evaluate("G-BGM7", { allow_unlicensed_source: true })).toBe(true);
    expect(evaluate("G-BGM7", { url_scheme_ok: false })).toBe(true);
    expect(evaluate("G-BGM7", { url_scheme_ok: true, unregistered_source: false })).toBe(false);

    // G-BGM8：曲库打标必须声明许可 / 不许覆盖既有曲库 / 不许把索引写进素材目录 → block
    expect(evaluate("G-BGM8", { license_declared: false })).toBe(true);
    expect(evaluate("G-BGM8", { license_ok: false })).toBe(true);
    expect(evaluate("G-BGM8", { overwrite_existing: true })).toBe(true);
    expect(evaluate("G-BGM8", { out_dir_inside_source: true })).toBe(true);
    expect(evaluate("G-BGM8", {})).toBe(false);
    expect(evaluate("G-BGM8", { license_declared: true, license_ok: true, overwrite_existing: false })).toBe(false);

    // G-BGM9：低置信标签入册 → review（允许入册，但交付前人耳复核）
    expect(evaluate("G-BGM9", { low_confidence_count: 1 })).toBe(true);
    expect(evaluate("G-BGM9", { low_confidence_count: 0 })).toBe(false);
    // 缺字段按 fail-closed：求值异常 → 运行时按 block 处理，故调用方必须带上该计数
    expect(() => evalCondition(when("G-BGM9"), { params: {}, context: {} } as never)).toThrow();
  });
});

describe("配乐配方库", () => {
  const doc = findRecipes({ list: true });

  // T-15 扩库（2026-09-27）：16 既有 + 16 新增 = 32；本口径与 bundles/ai-video/library/bgm-recipes 同步。
  it("32 条题材配方（16 既有 + T-15 新增 16），字段取值全部落在作曲内核可执行的集合内", () => {
    expect(doc.items).toHaveLength(32);
    const ids = doc.items.map((item) => item.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const item of doc.items) {
      expect(SCALES[item.mode], `${item.id} 调式 ${item.mode}`).toBeDefined();
      for (const chord of item.chords) expect(CHORDS[chord], `${item.id} 和弦 ${chord}`).toBeDefined();
      expect(item.instrumentation.length).toBeGreaterThan(0);
      // 声部白名单以 synth.mjs 的真实音色为准（renderPlan 实现 sub/arp/lead/snare/riser/impact 六个扩展声部；
      // T-15 新配方按风格包使用它们——旧白名单只有六个基础声部，属过期口径）。
      const allowedInstruments = new Set([
        "pad", "bass", "pluck", "kick", "hat", "bell",
        "sub", "arp", "lead", "snare", "riser", "impact",
      ]);
      for (const pack of Object.values(STYLE_PACKS)) {
        for (const name of (pack as { instrumentation: string[] }).instrumentation) allowedInstruments.add(name);
      }
      for (const name of item.instrumentation) {
        expect(allowedInstruments.has(name), `${item.id} 配器 ${name} 不在 synth.mjs 声部表内`).toBe(true);
      }
      expect(item.bpm).toBeGreaterThanOrEqual(40);
      expect(item.bpm).toBeLessThanOrEqual(200);
      expect(item.musicLevelDb).toBeLessThanOrEqual(-16);
      expect(item.musicLevelDb).toBeGreaterThanOrEqual(-30);
      expect(item.duckingDb).toBeGreaterThanOrEqual(8);
      expect(item.duckingDb).toBeLessThanOrEqual(16);
      expect(item.platforms.length).toBeGreaterThan(0);
    }
  });

  it("口播类配方的让位更深、电平更低（人声优先是可执行的口径，不是口号）", () => {
    const interview = findRecipes({ recipeId: "interview" }).recipe!;
    const promo = findRecipes({ recipeId: "festival-promo" }).recipe!;
    expect(interview.duckingDb).toBeGreaterThan(promo.duckingDb);
    expect(interview.musicLevelDb).toBeLessThan(promo.musicLevelDb);
    expect(interview.avoid.join(" ")).toContain("打击");
  });

  it("交付目标值齐备（响度/真峰值/余量/让位/可闻度/卡点）", () => {
    const targets = doc.targets as Record<string, unknown>;
    expect(targets.lufsTarget).toBe(-14);
    expect(targets.truePeakDbtpMax).toBe(-1);
    expect(targets.dialogueToMusicMarginDb).toBe(6);
    expect(targets.musicPresenceDb).toBe(3);
    expect(targets.alignmentMeanAbsErrorMs).toBe(60);
  });
});

describe("岗位 / 技能 / 管线 / 对象四层引用", () => {
  const preset = YAML.parse(readFileSync(join(BUNDLE_DIR, "presets/bgm-composer.yml"), "utf8")) as {
    preset_key: string; name: string; kind: string; readonly: boolean; night_shift: boolean;
    high_risk: boolean; fence_bindings: string[]; skills: string[];
    tools: Array<{ name: string; access: "read" | "write" }>;
    coverage: Array<{ eventPrefix: string }>; write_back: string[];
  };

  it("岗位卡：5 技能 / 14 工具 / 10 围栏 / 事件域 bgm.", () => {
    expect(preset.preset_key).toBe("bgm-composer");
    expect(preset.name).toBe("BGM配乐师");
    expect(preset.kind).toBe("operator");
    expect(preset.readonly).toBe(false);
    expect(preset.high_risk).toBe(false);
    expect(preset.fence_bindings).toEqual(["G-BGM0", "G-BGM1", "G-BGM2", "G-BGM3", "G-BGM4", "G-BGM5", "G-BGM6", "G-BGM7", "G-BGM8", "G-BGM9"]);
    expect(preset.skills).toEqual([
      "bgm-score-design", "bgm-audio-layering", "bgm-vocal-separation", "bgm-library-license", "bgm-delivery-spec",
    ]);
    expect(preset.tools.map((tool) => tool.name)).toEqual([...BGM_TOOLS]);
    expect(preset.tools.some((tool) => tool.access === "write")).toBe(true);
    expect(preset.tools.filter((tool) => tool.access === "write").map((tool) => tool.name)).toEqual([
      "bgmwrite.compose", "bgmwrite.fetch", "bgmwrite.mix", "bgmwrite.separate", "bgmwrite.best", "bgmwrite.tag", "bgmwrite.library",
    ]);
    expect(preset.write_back).toEqual(["bgmwrite.compose", "bgmwrite.mix"]);
    expect(preset.coverage.map((coverage) => coverage.eventPrefix)).toEqual(["bgm."]);
  });

  it("事件前缀 bgm. 在本包内未被其它岗位占用", () => {
    const clashes: string[] = [];
    for (const file of readFiles(join(BUNDLE_DIR, "presets"))) {
      const doc = YAML.parse(readFileSync(file, "utf8")) as { preset_key?: string; coverage?: Array<{ eventPrefix?: string }> };
      if (doc.preset_key === "bgm-composer") continue;
      for (const coverage of doc.coverage ?? []) {
        if (coverage.eventPrefix === "bgm.") clashes.push(String(doc.preset_key));
      }
    }
    expect(clashes).toEqual([]);
  });

  it("五个技能目录都有 SKILL.md，且 frontmatter name 与目录一致", () => {
    for (const skill of preset.skills) {
      const file = join(BUNDLE_DIR, "skills", skill, "SKILL.md");
      expect(existsSync(file), `${skill} 缺 SKILL.md`).toBe(true);
      const raw = readFileSync(file, "utf8");
      const front = YAML.parse(/^---\n([\s\S]*?)\n---/.exec(raw)?.[1] ?? "{}") as { name?: string; description?: string };
      expect(front.name).toBe(skill);
      expect((front.description ?? "").length).toBeGreaterThan(40);
    }
  });

  it("叙事片管线在调色之后、入库之前插入配乐步，且 owner/产物齐备", () => {
    const pipeline = YAML.parse(readFileSync(join(BUNDLE_DIR, "pipelines/narrative-film.yml"), "utf8")) as {
      steps: Array<{ step_key: string; owner?: string; outputs?: string[] }>;
    };
    const keys = pipeline.steps.map((step) => step.step_key);
    const bgm = pipeline.steps.find((step) => step.step_key === "bgm")!;
    expect(bgm).toBeDefined();
    expect(bgm.owner).toBe("bgm-composer");
    expect(bgm.outputs).toEqual(["bgm_track", "bgm_report", "final_video"]);
    expect(keys.indexOf("bgm")).toBeGreaterThan(keys.indexOf("color"));
    expect(keys.indexOf("bgm")).toBeLessThan(keys.indexOf("archive"));
  });

  it("对象类型 bgm_track / bgm_report 已登记（下游按对象类型挂事件与投影）", () => {
    const objects = JSON.parse(readFileSync(join(BUNDLE_DIR, "schemas/objects.json"), "utf8")) as {
      objects: Array<{ type: string; note?: string }>;
    };
    const types = objects.objects.map((entry) => entry.type);
    expect(types).toContain("bgm_track");
    expect(types).toContain("bgm_report");
    expect(objects.objects.find((entry) => entry.type === "bgm_report")!.note).toContain("sha256");
  });

  it("bundle.json 登记了岗位/围栏/技能/配方/曲库资产与配乐工位连接器，且完整性索引覆盖它们", () => {
    const bundle = JSON.parse(readFileSync(join(BUNDLE_DIR, "bundle.json"), "utf8")) as {
      workloom: { provides: Record<string, string[] | string> };
      integrity: { assets: Record<string, string> };
    };
    const provides = bundle.workloom.provides as Record<string, string[]>;
    expect(provides.presets).toContain("presets/bgm-composer.yml");
    expect(provides.fences).toContain("fences/ai-video-bgm.yml");
    expect(provides.skills).toContain("skills/bgm-score-design/SKILL.md");
    expect(provides.library).toContain("library/bgm-recipes/recipes.json");
    expect(provides.library).toContain("library/bgm-library/README.md");
    expect(provides.connectors).toContain("connectors/bgm-bridge/core.mjs");
    expect(provides.connectors).toContain("connectors/bgm-bridge/synth.mjs");
    for (const asset of provides.connectors) {
      const sha = bundle.integrity.assets[asset];
      expect(sha, `${asset} 未进完整性索引`).toMatch(/^[a-f0-9]{64}$/);
      expect(existsSync(join(BUNDLE_DIR, asset)), `${asset} 在磁盘不存在`).toBe(true);
    }
  });

  it("配乐连接器不依赖仓库外代码（工位自包含：只用 node 内置模块 + 相对导入）", () => {
    for (const file of ["core.mjs", "measure.mjs", "synth.mjs"]) {
      const source = readFileSync(join(BUNDLE_DIR, "connectors/bgm-bridge", file), "utf8");
      const imports = [...source.matchAll(/from\s+"([^"]+)"/g)].map((match) => match[1]!);
      for (const specifier of imports) {
        expect(
          specifier.startsWith("node:") || specifier.startsWith("./"),
          `${file} 引入了非自包含依赖：${specifier}`,
        ).toBe(true);
      }
    }
  });
});

describe("配乐内核纯函数（对齐 / 定速 / 让位换算 / 许可）", () => {
  it("卡点对齐：剪辑点能被节拍网格吃掉，达标率与采用偏移写进回执", () => {
    // 7s 一处剪辑点，BPM 94.3 → 每拍 0.6363s，7s ≈ 11 拍
    const grid = alignBeatGrid({ bpm: 94.3, cuts: [{ at: 7, score: 1 }, { at: 14, score: 1 }] });
    expect(grid.verdict).toBe("aligned");
    expect(grid.alignedRatio).toBe(1);
    expect(grid.meanAbsErrorMs).toBeLessThanOrEqual(5);
    expect(grid.offsetSec).toBeGreaterThanOrEqual(0);
    expect(grid.offsetSec).toBeLessThan(grid.beatSec);

    // 无剪辑点 → 如实报告"没有可对齐的依据"，不假装对齐
    const none = alignBeatGrid({ bpm: 100, cuts: [] });
    expect(none.verdict).toBe("no_cuts");
    expect(none.meanAbsErrorMs).toBeNull();
    expect(none.cuts).toEqual([]);
  });

  it("按剪辑点反推 BPM：落在 ±25% 内采用，超出则沿用配方速度并说明冲突", () => {
    const adopted = deriveTempoFromCuts({ cuts: [{ at: 7 }, { at: 14 }], baseBpm: 96 });
    expect(adopted.source).toBe("cut-driven");
    expect(adopted.bpm).toBeCloseTo(94.3, 1);
    expect(adopted.note).toContain("剪辑点间距");

    // 间距 1.4s、基准 60BPM（一拍 1s）→ 最短 2 拍口径下反推 85.7BPM，与配方差 43% → 冲突，沿用配方并说明原因
    const kept = deriveTempoFromCuts({ cuts: [{ at: 1.4 }, { at: 2.8 }], baseBpm: 60 });
    expect(kept.source).toBe("recipe");
    expect(kept.bpm).toBe(60);
    expect(kept.candidateBpm).toBeCloseTo(85.7, 1);
    expect(kept.note).toContain("沿用配方 BPM");

    // 间距 4s、基准 60BPM（一拍 1s）→ 正好 4 拍，反推 = 配方值，采用反推来源但速度不变
    const exact = deriveTempoFromCuts({ cuts: [{ at: 4 }, { at: 8 }], baseBpm: 60 });
    expect(exact.source).toBe("cut-driven");
    expect(exact.bpm).toBe(60);

    const empty = deriveTempoFromCuts({ cuts: [], baseBpm: 100 });
    expect(empty.source).toBe("recipe");
    expect(empty.bpm).toBe(100);
  });

  it("让位换算：目标深度越大，阈值越低（侧链压缩量越大）", () => {
    const shallow = deriveDuckParams({ speechLevelDb: -21, duckingDb: 8 });
    const deep = deriveDuckParams({ speechLevelDb: -21, duckingDb: 14 });
    expect(shallow.threshold).toBeGreaterThan(deep.threshold);
    expect(shallow.source).toBe("measured-voice-level");
    // 阈值必须落在人声电平之下，否则人声一出现就压（会把整条 BGM 压死）
    expect(20 * Math.log10(deep.threshold)).toBeLessThan(-21);
    const missing = deriveDuckParams({ speechLevelDb: null, duckingDb: 12 });
    expect(missing.source).toBe("fallback-default");
  });

  it("许可表：白名单可商用、NC/未知不可商用（未知按不合规处理）", () => {
    expect(LICENSE_TABLE["cc0-1.0"].commercial).toBe(true);
    expect(LICENSE_TABLE["cc-by-4.0"].attributionRequired).toBe(true);
    expect(LICENSE_TABLE["cc-by-nc-4.0"].commercial).toBe(false);
    expect(licenseInfo("cc-by-nc-4.0").commercial).toBe(false);
    expect(licenseInfo("").commercial).toBeNull();
    expect(licenseInfo("weird-license").known).toBe(false);
  });

  it("曲库检索：商用场景自动过滤 NC 曲目，并给出 TASL 署名", () => {
    const dir = mkdtempSync(join(tmpdir(), "bgm-lib-"));
    try {
      writeFileSync(join(dir, "tracks.json"), JSON.stringify({
        schemaVersion: "workloom.bgm-library/v1",
        tracks: [
          { id: "ok-by", title: "Warm Bed", artist: "A", source: "https://example.com/a", license: "cc-by-4.0", path: "a.wav", mood: "诱人温暖", genre: "美食", bpm: 96, durationSec: 40 },
          { id: "blocked-nc", title: "Night", artist: "B", source: "https://example.com/b", license: "cc-by-nc-4.0", path: "b.wav", mood: "诱人温暖", genre: "美食", bpm: 92, durationSec: 60 },
        ],
      }, null, 2));
      const commercial = findTracks({ commercialUse: true }, { WORKLOOM_BGM_LIBRARY_DIR: dir });
      /**
       * 2026-09-24 修正：`libraryRoots` 现在**总会**带上随仓兜底曲库（`library/bgm-library-curated`，50 首）
       * 与工位/自动发现的曲库根，因此 `total/matched` 不再等于"本次自建库的条数"。
       * 这里把断言收敛到**本次夹具曲目**上：既保留"NC 被过滤"的语义，又不会因为随仓曲库增删而假红。
       */
      const customIds = new Set(["ok-by", "blocked-nc"]);
      const customCommercial = commercial.items.filter((item) => customIds.has(item.id));
      expect(commercial.sources.some((source) => source.dir === dir && source.present === true)).toBe(true);
      expect(customCommercial.map((item) => item.id)).toEqual(["ok-by"]);
      expect(customCommercial[0]!.licenseLabel).toContain("CC BY 4.0");

      // 缺省即商用口径（fail-safe）：不显式声明 commercial_use=false 时，NC 曲目不进候选
      const defaultQuery = findTracks({}, { WORKLOOM_BGM_LIBRARY_DIR: dir });
      expect(defaultQuery.items.filter((item) => customIds.has(item.id)).map((item) => item.id)).toEqual(["ok-by"]);

      const all = findTracks({ commercialUse: false }, { WORKLOOM_BGM_LIBRARY_DIR: dir });
      const nc = all.items.find((item) => item.id === "blocked-nc")!;
      expect(nc.commercialOk).toBe(false);
      expect(nc.attribution.required).toBe(true);
      expect(nc.attribution.text).toContain("Night");

      const byMood = findTracks({ mood: "诱人温暖", genre: "美食", commercialUse: true }, { WORKLOOM_BGM_LIBRARY_DIR: dir });
      expect(byMood.items.filter((item) => customIds.has(item.id)).map((item) => item.id)).toEqual(["ok-by"]);
      const noHit = findTracks({ genre: "科技 / SaaS" }, { WORKLOOM_BGM_LIBRARY_DIR: dir });
      expect(noHit.items.filter((item) => customIds.has(item.id))).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("findTracks 返回条数上限可配（默认 20；显式 limit 可拿全量候选池）", () => {
    /**
     * 返回条数上限（2026-09-26 真机修复）：
     * 早先硬编码 `items.slice(0, 20)` 且**切片发生在排序之前**——1034 首的曲库在选曲侧只能看到前 20 首。
     * 现在上限可配：默认 20（保持既有调用行为），`limit` 放大即可拿到全量候选池（选曲/回填/审计用）。
     */
    const withDefaultLimit = findTracks({ commercialUse: true });
    expect(withDefaultLimit.limit).toBe(20);
    expect(withDefaultLimit.items.length).toBeLessThanOrEqual(20);
    expect(withDefaultLimit.matched).toBeGreaterThanOrEqual(withDefaultLimit.items.length);

    const full = findTracks({ commercialUse: true, limit: 2000 });
    expect(full.limit).toBe(2000);
    expect(full.items.length).toBe(full.matched);

    /** 非法上限回落到默认值（不抛错、不静默返回全库） */
    expect(findTracks({ limit: -5 }).limit).toBe(20);
    expect(findTracks({ limit: 0 }).limit).toBe(20);
  });

  it("自建曲库目录为空时如实登记（随仓兜底曲库仍在，不谎称「未接入」）", () => {
    const dir = mkdtempSync(join(tmpdir(), "bgm-lib-empty-"));
    try {
      const result = findTracks({}, { WORKLOOM_BGM_LIBRARY_DIR: dir });
      /**
       * 产品口径已变（2026-09-23 起）：随仓自带 50 首兜底曲库，因此"客户目录为空"不等于"没有曲库可用"。
       * 断言随之收敛为事实：① 该自定义根被登记为 present=false；② 兜底曲库真实在位；
       * ③ 不再向用户谎称"曲库未接入"。
       */
      expect(result.sources.some((source) => source.dir === dir && source.present === false)).toBe(true);
      expect(result.libraryPresent).toBe(true);
      expect(result.total).toBeGreaterThan(0);
      expect(result.note).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("自算作曲内核", () => {
  const recipe = findRecipes({ recipeId: "interview" }).recipe! as Record<string, unknown>;

  it("结构三段之和等于总小节数，且结构比例落在配方口径内", () => {
    const plan = planComposition({ recipe, durationSec: 26 });
    expect(plan.introBars + plan.bodyBars + plan.outroBars).toBe(plan.bars);
    expect(plan.bars).toBeGreaterThanOrEqual(4);
    expect(plan.durationSec).toBeGreaterThanOrEqual(26);
    expect(plan.bars_).toHaveLength(plan.bars);
    expect(plan.bars_[0]!.section).toBe("intro");
    expect(plan.bars_[plan.bars - 1]!.section).toBe("outro");
  });

  it("确定性合成：同配方 + 同种子 → 同 sha256（可复现、可核验）", async () => {
    const dir = mkdtempSync(join(tmpdir(), "bgm-synth-"));
    try {
      const first = await renderCompositionToWav({ plan: planComposition({ recipe, durationSec: 6, seed: 7 }), output: join(dir, "a.wav") });
      const second = await renderCompositionToWav({ plan: planComposition({ recipe, durationSec: 6, seed: 7 }), output: join(dir, "b.wav") });
      const third = await renderCompositionToWav({ plan: planComposition({ recipe, durationSec: 6, seed: 8 }), output: join(dir, "c.wav") });
      expect(first.sha256).toBe(second.sha256);
      expect(first.sha256).not.toBe(third.sha256);
      expect(first.peakDbfs).toBeLessThanOrEqual(-5.5);
      expect(first.peakDbfs).toBeGreaterThanOrEqual(-6.5);

      const wav = readFileSync(first.output);
      expect(wav.subarray(0, 4).toString("ascii")).toBe("RIFF");
      expect(wav.subarray(8, 12).toString("ascii")).toBe("WAVE");
      expect(wav.readUInt16LE(22)).toBe(2);       // 立体声
      expect(wav.readUInt32LE(24)).toBe(44100);   // 44.1kHz
      expect(wav.readUInt16LE(34)).toBe(16);      // 16-bit
      // 渲染保留 0.5s 尾音（给 release 用），时长换算与 synth 内一致（ceil 到样本）
      const expectedFrames = Math.ceil(first.durationSeconds * 44100) + Math.ceil(0.5 * 44100);
      expect(wav.length).toBe(44 + expectedFrames * 4);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 120_000);

  it("非法配方显式失败（不静默兜底）", () => {
    expect(() => planComposition({ recipe: { ...recipe, bpm: 500 }, durationSec: 10 })).toThrow(/BPM/);
    expect(() => planComposition({ recipe: { ...recipe, chords: ["I", "??"] }, durationSec: 10 })).toThrow(/和弦/);
    expect(() => planComposition({ recipe: { ...recipe, mode: "made-up" }, durationSec: 10 })).toThrow(/调式/);
    expect(() => planComposition({ recipe, durationSec: 0 })).toThrow(/片长/);
  });
});

function readFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".yml"))
    .map((entry) => join(dir, entry.name));
}

describe("渲染提示词 → 配乐简报（brief）", () => {
  const cases: Array<{ text: string; recipe: string | null; energy?: string; climax?: string; noMusic?: boolean; policy?: string; avoid?: string[] }> = [
    { text: "夜幕下的城市霓虹，主角在雨中奔跑，结尾反转揭晓真相，快剪高能", recipe: "night-city", energy: "high", climax: "end" },
    { text: "美食探店：热气腾腾的火锅特写，温柔治愈，保留现场声", recipe: "food", energy: "low", policy: "keep-all" },
    { text: "口播讲解：三分钟说清 AI 芯片架构，不要鼓点", recipe: "tech", avoid: ["kick", "hat"] },
    { text: "产品广告：旗舰新品开箱，黄金三秒钩子，卡点快节奏", recipe: "product-ad", energy: "high", climax: "start" },
    { text: "随手拍的家庭日常，不要背景音乐", recipe: "family", noMusic: true, policy: "none" },
    { text: "一段没有任何题材线索的空镜合集", recipe: null },
  ];

  it("六个真实提示词全部按预期解析（题材/能量/高潮/禁忌/无配乐）", () => {
    for (const item of cases) {
      const { brief } = analyzePromptBrief({ promptText: item.text, durationSec: 30 });
      expect(brief.recipeId, item.text).toBe(item.recipe);
      if (item.energy) expect(brief.energyLevel, item.text).toBe(item.energy);
      if (item.climax) expect(brief.climax.position, item.text).toBe(item.climax);
      if (item.noMusic) expect(brief.noMusic, item.text).toBe(true);
      if (item.policy) expect(brief.audioPolicy, item.text).toBe(item.policy);
      if (item.avoid) expect(brief.instrumentation.avoid, item.text).toEqual(expect.arrayContaining(item.avoid));
    }
  });

  it("高潮落点会被换算成秒（用于选段对齐），并按提示词调整配乐电平", () => {
    const end = analyzePromptBrief({ promptText: "结尾反转，全片紧张", durationSec: 40 }).brief;
    expect(end.climax.atSec).toBeCloseTo(34, 1);
    const quiet = analyzePromptBrief({ promptText: "产品广告：音乐要轻，别太满", durationSec: 20 }).brief;
    expect(quiet.musicLevelDeltaDb).toBeLessThan(0);
    const loud = analyzePromptBrief({ promptText: "运动燃向快剪，音乐要突出", durationSec: 20 }).brief;
    expect(loud.musicLevelDeltaDb).toBeGreaterThan(0);
  });

  it("能量弧线形状：结尾高潮=rise-to-climax / 开场钩子=hook-first / 无配乐=none", () => {
    const mk = (text: string) => analyzePromptBrief({ promptText: text, durationSec: 30 }).brief;
    expect(energyCurveFor({ brief: mk("结尾反转揭晓"), durationSec: 30 }).shape).toBe("rise-to-climax");
    expect(energyCurveFor({ brief: mk("黄金三秒钩子，开场就炸"), durationSec: 30 }).shape).toBe("hook-first");
    expect(energyCurveFor({ brief: mk("不要背景音乐"), durationSec: 30 }).shape).toBe("none");
    expect(energyCurveFor({ brief: mk("中段爆发"), durationSec: 30 }).shape).toBe("peak-middle");
  });

  it("曲目打分与提示词一致：题材命中得高分、违反禁忌直接否决", () => {
    const { brief } = analyzePromptBrief({ promptText: "美食探店，温柔治愈", durationSec: 30 });
    const good = scoreTrackAgainstBrief({
      track: { id: "t1", genre: "美食 / 餐饮", mood: "诱人温暖", bpm: 96, durationSec: 60, energyScore: 0.3, structure: { segments: [] } },
      brief, recipeCatalog: findRecipes({ list: true }).items,
    });
    const off = scoreTrackAgainstBrief({
      track: { id: "t2", genre: "夜景 / 都市", mood: "戏剧现代", bpm: 92, durationSec: 180, energyScore: 0.9 },
      brief, recipeCatalog: findRecipes({ list: true }).items,
    });
    expect(good.score).toBeGreaterThan(off.score);
    expect(good.verdict).toBe("ok");

    const drums = analyzePromptBrief({ promptText: "口播讲解，不要鼓点", durationSec: 30 }).brief;
    const rejected = scoreTrackAgainstBrief({
      track: { id: "t3", genre: "科技 / SaaS", mood: "冷静精密", bpm: 100, durationSec: 60, instrumentation: ["kick", "pad"] },
      brief: drums, recipeCatalog: findRecipes({ list: true }).items,
    });
    expect(rejected.verdict).toBe("rejected");
    expect(rejected.reasons.join(" ")).toContain("违反提示词禁忌");
  });
});

describe("在线曲源层（登记表与许可归一）", () => {
  it("四个登记源各自的必需环境变量齐备（未配置时如实报告 missingEnv）", () => {
    expect(Object.keys(SOURCE_ENV).sort()).toEqual(["freesound", "generic-http", "jamendo", "mubert"]);
    const configured = listSources({
      JAMENDO_CLIENT_ID: "x", FREESOUND_API_TOKEN: "y", MUBERT_CUSTOMER_ID: "c", MUBERT_ACCESS_TOKEN: "t",
      WORKLOOM_BGM_ONLINE_ENDPOINT: "https://music.example.com/index",
    });
    expect(configured.every((entry) => entry.configured)).toBe(true);
    const none = listSources({});
    expect(none.every((entry) => entry.configured === false)).toBe(true);
    expect(none.find((entry) => entry.name === "mubert")!.missingEnv).toEqual(["MUBERT_CUSTOMER_ID", "MUBERT_ACCESS_TOKEN"]);
  });

  it("许可归一覆盖 CC 全家族与未知（未知按不可商用处理）", () => {
    expect(normalizeLicense("http://creativecommons.org/licenses/by/4.0/")).toBe("cc-by-4.0");
    expect(normalizeLicense("http://creativecommons.org/licenses/by-sa/3.0/")).toBe("cc-by-sa-4.0");
    expect(normalizeLicense("http://creativecommons.org/licenses/by-nc-nd/4.0/")).toBe("cc-by-nc-nd-4.0");
    expect(normalizeLicense("https://creativecommons.org/publicdomain/zero/1.0/")).toBe("cc0-1.0");
    expect(normalizeLicense("免版税（Mubert）")).toBe("royalty-free");
    expect(normalizeLicense("all rights reserved")).toBe("unknown");
    expect(licenseInfo(normalizeLicense("all rights reserved")).commercial).toBeNull();
  });
});

/** 用合成包络（不碰真实音频文件）验证结构分段与选段决策——纯函数，CI 里也能跑。 */
function envelopeOf(dbBySecond: number[][], windowSec = 0.25) {
  const db: number[] = [];
  for (const entry of dbBySecond) {
    const levels = Array.isArray(entry) ? entry : [entry];
    const perSecond = Math.round(1 / windowSec);
    for (let index = 0; index < perSecond; index += 1) db.push(levels[index % levels.length]!);
  }
  const rd = (value: number) => Math.round(value * 100) / 100;
  return {
    windowSec,
    windows: db.length,
    durationSec: Math.round(db.length * windowSec * 1000) / 1000,
    db: db.map(rd),
    rms: db.map((value) => 10 ** (value / 20)),
    peakDb: rd(Math.max(...db)),
    avgDb: rd(db.reduce((a, b) => a + b, 0) / db.length),
    quantiles: {
      p10: rd([...db].sort((a, b) => a - b)[Math.floor(db.length * 0.1)] ?? -60),
      p25: rd([...db].sort((a, b) => a - b)[Math.floor(db.length * 0.25)] ?? -60),
      p50: rd([...db].sort((a, b) => a - b)[Math.floor(db.length * 0.5)] ?? -60),
      p75: rd([...db].sort((a, b) => a - b)[Math.floor(db.length * 0.75)] ?? -60),
      p90: rd([...db].sort((a, b) => a - b)[Math.floor(db.length * 0.9)] ?? -60),
    },
  };
}

describe("本地曲库：随仓精选（50 首可商用纯音乐选段）+ 缺失根目录如实上报", () => {
  const curatedDir = join(BUNDLE_DIR, "library/bgm-library-curated");
  const manifestPath = join(curatedDir, "tracks.json");

  it("客户自建曲库目录缺失时如实报告（该根 present=false），随仓精选仍可兜底", () => {
    const loaded = loadAllLocalTracks({ WORKLOOM_BGM_LIBRARY_DIR: "/tmp/definitely-missing-bgm-library" });
    expect(loaded.sources.find((entry) => entry.kind === "local-custom")?.present).toBe(false);
    expect(loaded.sources.find((entry) => entry.kind === "local-curated")?.present).toBe(true);
    expect(loaded.tracks.filter((track) => track.libraryKind === "local-curated").length).toBe(50);
  });

  it("随仓精选曲库清单齐备：50 首 / 11 种风格族 / 可商用许可 / 字段完整", () => {
    expect(existsSync(manifestPath), "缺少 tracks.json（用 scripts/bgm-curate-library.mjs 生成）").toBe(true);
    const doc = JSON.parse(readFileSync(manifestPath, "utf8")) as {
      library: { tracks: number; provider: string; selection: { byStyle: Record<string, number> } };
      tracks: Array<Record<string, unknown>>;
    };
    expect(doc.tracks).toHaveLength(50);
    expect(doc.library.tracks).toBe(50);
    expect(doc.library.provider).toBe("owner-provided-pack");
    expect(Object.keys(doc.library.selection.byStyle).length).toBeGreaterThanOrEqual(10); // 不同风格都要有货
    for (const track of doc.tracks) {
      expect(track.license).toBe("royalty-free");
      expect(existsSync(join(curatedDir, String(track.file))), `缺文件 ${track.file}`).toBe(true);
      expect(String(track.file)).toMatch(/\.m4a$/);
      expect(Number(track.bpm)).toBeGreaterThan(40);
      expect(Number(track.durationSec)).toBeGreaterThan(30);
      const loudness = track.loudness as { integratedLufs: number; truePeakDbtp: number };
      const deviation = Math.abs(loudness.integratedLufs + 14);
      expect(deviation, `${track.id} 响度偏离 -14`).toBeLessThan(6); // 峰值贴顶的选段走"峰值保护优先"，允许低于 -14
      if (deviation > 2) {
        expect((track.excerpt as { peakProtected?: boolean }).peakProtected, `${track.id} 偏低必须标明是峰值保护所致`).toBe(true);
      }
      expect(loudness.truePeakDbtp, `${track.id} 真峰值越界`).toBeLessThanOrEqual(-0.4); // 目标 -1 dBTP；AAC 交调过冲实测最差 -0.33，逐首实测值登记在索引里
      const structure = track.structure as { hasDrop: boolean; segments: unknown[] };
      expect(structure.segments.length).toBeGreaterThanOrEqual(1);
      const excerpt = track.excerpt as { startSec: number; durationSec: number; reason: string };
      expect(excerpt.durationSec).toBeGreaterThan(30);
      expect(excerpt.reason.length).toBeGreaterThan(0);
    }
  });

  it("每首选段的 sha256 与磁盘文件一致，且能按三级合并被加载器读到", () => {
    const doc = JSON.parse(readFileSync(manifestPath, "utf8")) as { tracks: Array<{ id: string; file: string; sha256: string }> };
    for (const track of doc.tracks) {
      const bytes = readFileSync(join(curatedDir, track.file));
      const actual = createHash("sha256").update(bytes).digest("hex");
      expect(actual, `${track.file} 摘要不一致`).toBe(track.sha256);
    }
    const loaded = loadAllLocalTracks({ WORKLOOM_BGM_LIBRARY_DIR: "/tmp/definitely-missing-bgm-library" });
    const curated = loaded.tracks.filter((track) => track.libraryKind === "local-curated");
    expect(curated.length).toBe(50);
    expect(curated.every((track) => track.localPath && existsSync(track.localPath))).toBe(true);
    expect(loaded.sources.some((entry) => entry.kind === "local-curated" && entry.present && entry.tracks === 50)).toBe(true);
  }, 60_000);
});

describe("曲目结构识别与自动选段（规则式，纯函数）", () => {
  it("安静→渐强→高潮→回落 的能量曲线被正确分段（intro/build/drop/breakdown/outro）", () => {
    const envelope = envelopeOf([
      ...Array(8).fill([-46]),          // intro 8s
      ...Array(4).fill([-40, -36, -32, -28]), // build 4s（上行）
      ...Array(10).fill([-22]),         // drop 10s
      ...Array(4).fill([-42]),          // breakdown 4s
      ...Array(4).fill([-48]),          // outro 4s
    ]);
    const onsets = onsetStrength(envelope.db);
    const structure = classifySegments({ envelope, onsets });
    const types = structure.segments.map((segment) => segment.type);
    expect(types[0]).toBe("intro");
    expect(types).toContain("drop");
    expect(types[types.length - 1]).toBe("outro");
    const drop = structure.segments.find((segment) => segment.type === "drop")!;
    // 渐强段会被并进高潮段（段短于 minSegmentSec 或属于中能档时并段），因此均值略低于纯高潮平台值
    expect(drop.avgDb).toBeGreaterThan(-30);
    expect(drop.durationSec).toBeGreaterThanOrEqual(8);
    expect(drop.startSec).toBeGreaterThanOrEqual(8);
    expect(drop.endSec).toBeLessThanOrEqual(28);
    // 语义校验：drop 是全场平均能量最高的段
    expect(Math.max(...structure.segments.map((segment) => segment.avgDb!))).toBe(drop.avgDb);
  });

  it("全曲能量平坦时如实标 flat 并说明「没有高潮可言」，不硬编一个 drop", () => {
    const envelope = envelopeOf(Array(20).fill([-30, -29.5, -30.5, -30]));
    const structure = classifySegments({ envelope, onsets: onsetStrength(envelope.db) });
    expect(structure.segments).toHaveLength(1);
    expect(structure.segments[0]!.type).toBe("flat");
    expect(structure.note).toContain("没有明显高潮段");
  });

  it("高潮候选按段平均能量排序（不是按单帧峰值——带切点的安静段不该赢）", () => {
    const envelope = envelopeOf([
      ...Array(6).fill([-44]),   // 安静段（构造一个孤立尖峰）
      ...Array(6).fill([-20]),   // 高能段
      ...Array(6).fill([-46]),
    ]);
    // 人为制造尖峰：安静段里有一帧 -18
    envelope.db[20] = -18;
    const structure = classifySegments({ envelope, onsets: onsetStrength(envelope.db) });
    const scored = scoreSegments({ segments: structure.segments, prefer: "climax", durationSec: envelope.durationSec });
    expect(scored.candidates[0]!.avgDb).toBeGreaterThan(-24);
    expect(scored.candidates[0]!.type).toBe("drop");
  });

  it("边界吸附受时长约束：不吸到曲外（此前 bug：段落终点被吸到 28.75s > 实际 28.25s）", () => {
    const envelope = envelopeOf([[-46], [-44], [-30], [-22], [-24], [-46]], 0.25);
    const structure = classifySegments({ envelope, onsets: onsetStrength(envelope.db) });
    const scored = scoreSegments({ segments: structure.segments, bpm: 48, prefer: "climax", durationSec: envelope.durationSec });
    for (const candidate of scored.candidates) {
      expect(candidate.startSec).toBeGreaterThanOrEqual(0);
      expect(candidate.endSec).toBeLessThanOrEqual(envelope.durationSec);
    }
  });

  it("BPM 估计：周期性起音给出可信拍速；无周期时如实返回 null", () => {
    const periodic: number[] = [];
    for (let index = 0; index < 80; index += 1) periodic.push(index % 4 === 0 ? 6 : 0.2);
    const bpm = estimateBpmFromOnsets(periodic, { windowSec: 0.25 });
    expect(bpm.bpm).not.toBeNull();
    expect(bpm.candidates.length).toBeGreaterThan(0);

    const flat = new Array(80).fill(0.05);
    expect(estimateBpmFromOnsets(flat, { windowSec: 0.25 }).bpm).toBeNull();
    expect(estimateBpmFromOnsets([1, 2, 3], { windowSec: 0.25 }).reason).toContain("包络太短");
  });

  it("片子高潮判据三级降级：剪辑成簇 → 非对白能量峰 → 无（口播片不拿台词峰值当高潮）", () => {
    const arc = { windowSec: 0.25, durationSec: 40, db: new Array(160).fill(-40), peakTimeSec: 10, dynamicsDb: 20, avgDb: -40 };

    // ① 剪辑成簇（±2s 内 3 个剪辑点）
    const clustered = filmClimaxTime({ arc, cuts: [{ at: 18 }, { at: 19 }, { at: 20.5 }, { at: 34 }], voice: { activeRatio: 0.6, silences: [] }, durationSec: 40 });
    expect(clustered.basis).toBe("cut-density");
    expect(clustered.timeSec).toBeGreaterThanOrEqual(18);
    expect(clustered.timeSec).toBeLessThanOrEqual(20.5);

    // ② 非对白段能量峰（比非对白中位数高 6dB）
    const db = new Array(160).fill(-50);
    for (let index = 60; index < 80; index += 1) db[index] = -42;
    const nonDialogue = filmClimaxTime({
      arc: { ...arc, db },
      cuts: [{ at: 5 }],
      voice: { activeRatio: 0.5, silences: [{ start: 14, end: 24 }, { start: 30, end: 40 }] },
      durationSec: 40,
    });
    expect(nonDialogue.basis).toBe("non-dialogue-energy");
    expect(nonDialogue.timeSec).toBeGreaterThanOrEqual(15);
    expect(nonDialogue.timeSec).toBeLessThan(20);

    // ③ 口播片 + 均匀环境声 + 无剪辑成簇 → 不硬给高潮点
    const flatArc = { windowSec: 0.25, durationSec: 40, db: new Array(160).fill(-38), peakTimeSec: 9, dynamicsDb: 24, avgDb: -38 };
    const none = filmClimaxTime({
      arc: flatArc,
      cuts: [{ at: 7 }, { at: 14 }, { at: 20 }],
      voice: { activeRatio: 0.55, silences: [{ start: 12.9, end: 20.4 }] },
      durationSec: 40,
    });
    expect(none.basis).toBe("none");
    expect(none.timeSec).toBeNull();
    expect(none.reason).toContain("未识别到明确高潮点");
  });

  it("选段决策：片子有高潮点→取曲子高潮段并声明峰值对齐；没有→取代表段且不做对齐", () => {
    const envelope = envelopeOf([
      ...Array(6).fill([-46]),
      ...Array(6).fill([-22]),
      ...Array(6).fill([-46]),
    ]);
    const structure = {
      durationSec: envelope.durationSec,
      windowSec: envelope.windowSec,
      envelope,
      structure: classifySegments({ envelope, onsets: onsetStrength(envelope.db) }),
      climax: scoreSegments({ segments: classifySegments({ envelope, onsets: onsetStrength(envelope.db) }).segments, prefer: "climax", durationSec: envelope.durationSec }),
      calm: scoreSegments({ segments: classifySegments({ envelope, onsets: onsetStrength(envelope.db) }).segments, prefer: "calm", durationSec: envelope.durationSec }),
      tempo: { bpm: 100, confidence: "medium" },
    };
    const withPeak = chooseSection({
      structure,
      filmArc: { peakTimeSec: 14, dynamicsDb: 18, climaxBasis: "cut-density" },
      mode: "auto",
      filmDurationSec: 20,
    });
    expect(withPeak.alignFilmPeak).toBe(true);
    expect(withPeak.chosen!.type).toBe("drop");

    const withoutPeak = chooseSection({
      structure,
      filmArc: { peakTimeSec: null, dynamicsDb: 25, climaxBasis: "none", climaxDetails: { audio: { speechRatio: 0.6 } } },
      mode: "auto",
      filmDurationSec: 20,
    });
    expect(withoutPeak.alignFilmPeak).toBe(false);
    expect(withoutPeak.reason).toContain("未识别到可用的高潮点");

    expect(SECTION_MODES).toEqual(["full", "auto", "climax", "calm"]);
    expect(() => chooseSection({ structure, mode: "made-up" })).toThrow(/未知选段模式/);
  });
});
