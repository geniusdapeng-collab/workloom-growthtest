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
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import YAML from "yaml";

import { evalCondition } from "../fence-engine/expr.js";
import { bundlesRoot } from "./assembly.js";
import {
  BGM_TOOLS, LICENSE_TABLE, alignBeatGrid, deriveDuckParams, deriveTempoFromCuts,
  findRecipes, findTracks, licenseInfo,
} from "../../../bundles/ai-video/connectors/bgm-bridge/core.mjs";
import { CHORDS, SCALES, planComposition, renderCompositionToWav } from "../../../bundles/ai-video/connectors/bgm-bridge/synth.mjs";

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

describe("配乐围栏（G-BGM0..G-BGM5）语义", () => {
  it("六条规则齐备，级别与基线口径正确", () => {
    expect(fencePack.version).toBe("ai-video-bgm/v1");
    expect(fencePack.rules.map((rule) => rule.rule_id)).toEqual([
      "G-BGM0", "G-BGM1", "G-BGM2", "G-BGM3", "G-BGM4", "G-BGM5",
    ]);
    expect(fencePack.rules.every((rule) => rule.is_baseline === true)).toBe(true);
    const levels = Object.fromEntries(fencePack.rules.map((rule) => [rule.rule_id, rule.level]));
    expect(levels).toEqual({
      "G-BGM0": "auto", "G-BGM1": "review", "G-BGM2": "block",
      "G-BGM3": "block", "G-BGM4": "block", "G-BGM5": "block",
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
  });
});

describe("配乐配方库", () => {
  const doc = findRecipes({ list: true });

  it("16 条题材配方，字段取值全部落在作曲内核可执行的集合内", () => {
    expect(doc.items).toHaveLength(16);
    const ids = doc.items.map((item) => item.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const item of doc.items) {
      expect(SCALES[item.mode], `${item.id} 调式 ${item.mode}`).toBeDefined();
      for (const chord of item.chords) expect(CHORDS[chord], `${item.id} 和弦 ${chord}`).toBeDefined();
      expect(item.instrumentation.length).toBeGreaterThan(0);
      for (const name of item.instrumentation) {
        expect(["pad", "bass", "pluck", "kick", "hat", "bell"], `${item.id} 配器 ${name}`).toContain(name);
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

  it("岗位卡：5 技能 / 9 工具 / 6 围栏 / 事件域 bgm.", () => {
    expect(preset.preset_key).toBe("bgm-composer");
    expect(preset.name).toBe("BGM配乐师");
    expect(preset.kind).toBe("operator");
    expect(preset.readonly).toBe(false);
    expect(preset.high_risk).toBe(false);
    expect(preset.fence_bindings).toEqual(["G-BGM0", "G-BGM1", "G-BGM2", "G-BGM3", "G-BGM4", "G-BGM5"]);
    expect(preset.skills).toEqual([
      "bgm-score-design", "bgm-audio-layering", "bgm-vocal-separation", "bgm-library-license", "bgm-delivery-spec",
    ]);
    expect(preset.tools.map((tool) => tool.name)).toEqual([...BGM_TOOLS]);
    expect(preset.tools.some((tool) => tool.access === "write")).toBe(true);
    expect(preset.tools.filter((tool) => tool.access === "write").map((tool) => tool.name)).toEqual([
      "bgmwrite.compose", "bgmwrite.mix", "bgmwrite.separate", "bgmwrite.best",
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
      expect(commercial.total).toBe(2);
      expect(commercial.matched).toBe(1);
      expect(commercial.items[0]!.id).toBe("ok-by");
      expect(commercial.items[0]!.licenseLabel).toContain("CC BY 4.0");

      // 缺省即商用口径（fail-safe）：不显式声明 commercial_use=false 时，NC 曲目不进候选
      const defaultQuery = findTracks({}, { WORKLOOM_BGM_LIBRARY_DIR: dir });
      expect(defaultQuery.matched).toBe(1);
      expect(defaultQuery.items.map((item) => item.id)).toEqual(["ok-by"]);

      const all = findTracks({ commercialUse: false }, { WORKLOOM_BGM_LIBRARY_DIR: dir });
      expect(all.matched).toBe(2);
      const nc = all.items.find((item) => item.id === "blocked-nc")!;
      expect(nc.commercialOk).toBe(false);
      expect(nc.attribution.required).toBe(true);
      expect(nc.attribution.text).toContain("Night");

      const byMood = findTracks({ mood: "诱人温暖", genre: "美食", commercialUse: true }, { WORKLOOM_BGM_LIBRARY_DIR: dir });
      expect(byMood.matched).toBe(1);
      const noHit = findTracks({ genre: "科技 / SaaS" }, { WORKLOOM_BGM_LIBRARY_DIR: dir });
      expect(noHit.matched).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("未接入曲库时如实返回 libraryPresent=false，不伪造可交付", () => {
    const dir = mkdtempSync(join(tmpdir(), "bgm-lib-empty-"));
    try {
      const result = findTracks({}, { WORKLOOM_BGM_LIBRARY_DIR: dir });
      expect(result.libraryPresent).toBe(false);
      expect(result.total).toBe(0);
      expect(result.note).toContain("未接入");
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
  });

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
