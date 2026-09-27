/**
 * 交付包 / 多风格变体 / 本地返修（岗位 / 技能 / 围栏 / 管线 / 变体配方 / 工位桥）交叉引用与语义回归测试。
 *
 * 为什么单独一组：这条链路的失败模式同样是**静默**的——
 *  · 围栏写错 → 要么放行"母版被烧字"这种不可逆动作，要么把每次正常交付都挂起；
 *  · 变体配方雷同 → 用户拿到三个几乎一样的版本，"多版本"白做；
 *  · 影响分析写错 → 改一句字幕却去重生成镜头（烧钱又慢），或者该重算的层没重算（默默交错的片）；
 *  · 分诊归因码与反馈枚举表脱节 → 事件账本里的归因查不到标签；
 *  · 岗位/技能/管线/围栏四层断链 → 走到交付时"这一步没人执行、没有闸"。
 * 这些都能在磁盘上静态验出来，所以本组测试不触 DB、不依赖 ffmpeg。
 */
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import YAML from "yaml";

import { evalCondition } from "../fence-engine/expr.js";
import { bundlesRoot } from "./assembly.js";
import {
  ASPECT_PRESETS, UHD_ASPECT_PRESETS, POST_TOOLS, REVISION_RULES, analyzeImpact, buildCopyPack, extractShotIds,
  findVariantPack, listVariantPacks, pickTrackForVariant, resolveLut, resolveQuality, resolveResolution, triageFeedback,
} from "../../../bundles/ai-video/connectors/post-bridge/core.mjs";
import {
  NEVER_RETRY_CODES, POST_BRIDGE_TOOLS, createPostBridgeExecutor, isPostBridgeTool, stableKey,
} from "../../../bundles/ai-video/connectors/post-bridge/executor.ts";

const ROOT = bundlesRoot();
const BUNDLE_DIR = join(ROOT, "ai-video");
const BRIDGE_DIR = join(BUNDLE_DIR, "connectors/post-bridge");
const REPO_ROOT = dirname(ROOT);

interface FenceRule {
  rule_id: string;
  name: string;
  level: "auto" | "review" | "block";
  is_baseline: boolean;
  match: { object_types: string[]; actions: string[] };
  when: string;
  note?: string;
}

const fencePack = YAML.parse(readFileSync(join(BUNDLE_DIR, "fences/ai-video-delivery.yml"), "utf8")) as {
  version: string;
  default_level: string;
  rules: FenceRule[];
};
const when = (ruleId: string): string => fencePack.rules.find((rule) => rule.rule_id === ruleId)!.when;
const evaluate = (ruleId: string, params: Record<string, unknown> = {}, context: Record<string, unknown> = {}): boolean =>
  evalCondition(when(ruleId), { params, context } as never);

const preset = YAML.parse(readFileSync(join(BUNDLE_DIR, "presets/post-editor.yml"), "utf8")) as {
  preset_key: string;
  name: string;
  readonly: boolean;
  fence_bindings: string[];
  skills: string[];
  tools: Array<{ name: string; access: "read" | "write"; desc: string }>;
  write_back: string[];
  coverage: Array<{ eventPrefix: string }>;
};

describe("交付与返修围栏（G-DLV0..G-DLV9）语义", () => {
  it("十条规则齐备、级别与基线口径正确", () => {
    expect(fencePack.version).toBe("ai-video-delivery/v1");
    expect(fencePack.rules.map((rule) => rule.rule_id)).toEqual([
      "G-DLV0", "G-DLV1", "G-DLV2", "G-DLV3", "G-DLV4", "G-DLV5", "G-DLV6", "G-DLV7", "G-DLV8", "G-DLV9",
    ]);
    expect(fencePack.rules.every((rule) => rule.is_baseline === true)).toBe(true);
    expect(fencePack.rules.find((rule) => rule.rule_id === "G-DLV0")!.level).toBe("auto");
    expect(fencePack.rules.find((rule) => rule.rule_id === "G-DLV5")!.level).toBe("review");
    for (const id of ["G-DLV1", "G-DLV2", "G-DLV3", "G-DLV4", "G-DLV6", "G-DLV7", "G-DLV8", "G-DLV9"]) {
      expect(fencePack.rules.find((rule) => rule.rule_id === id)!.level, `${id} 应为 block`).toBe("block");
    }
  });

  it("G-DLV0 覆盖本工位全部工具，写动作不留白", () => {
    const auto = fencePack.rules.find((rule) => rule.rule_id === "G-DLV0")!;
    for (const tool of POST_TOOLS) {
      expect(auto.match.actions, `G-DLV0 未覆盖 ${tool}`).toContain(tool);
    }
  });

  it("G-DLV1：变体雷同或数量不足即拒（这是多版本交付的唯一理由）", () => {
    expect(evaluate("G-DLV1", { variants_distinct: false })).toBe(true);
    expect(evaluate("G-DLV1", { identical_variants: true })).toBe(true);
    expect(evaluate("G-DLV1", { variant_count: 1 })).toBe(true);
    expect(evaluate("G-DLV1", { variant_count: 3, variants_distinct: true })).toBe(false);
    // 缺字段不命中（走 default_level 的保守 review），不会把正常交付一律熔断
    expect(evaluate("G-DLV1", {})).toBe(false);
  });

  it("G-DLV2：母版烧字/覆盖原片一律阻断", () => {
    expect(evaluate("G-DLV2", { master_burned_in: true })).toBe(true);
    expect(evaluate("G-DLV2", { burn_into_master: true })).toBe(true);
    expect(evaluate("G-DLV2", { overwrite_source: true })).toBe(true);
    expect(evaluate("G-DLV2", { output_path: "/a.mp4", input_path: "/a.mp4" })).toBe(true);
    expect(evaluate("G-DLV2", { output_path: "/a.mp4", input_path: "/b.mp4" })).toBe(false);
  });

  it("G-DLV3：软字幕轨必须带画面零改动复检", () => {
    expect(evaluate("G-DLV3", { skip_verify: true })).toBe(true);
    expect(evaluate("G-DLV3", { verify: false })).toBe(true);
    expect(evaluate("G-DLV3", { reencode_video: true })).toBe(true);
    expect(evaluate("G-DLV3", { allow_video_reencode: true })).toBe(true);
    expect(evaluate("G-DLV3", {})).toBe(false);
  });

  it("G-DLV4：返修必须带影响分析；点名不出镜头不许重生成", () => {
    expect(evaluate("G-DLV4", { skip_impact_analysis: true })).toBe(true);
    expect(evaluate("G-DLV4", { impact_analyzed: false })).toBe(true);
    expect(evaluate("G-DLV4", { requires_shot_regeneration: true, shot_ids_missing: true })).toBe(true);
    expect(evaluate("G-DLV4", { requires_shot_regeneration: true, shot_ids_missing: false })).toBe(false);
    expect(evaluate("G-DLV4", { requires_shot_regeneration: false })).toBe(false);
  });

  it("G-DLV5：镜头重生成（花钱）走人审", () => {
    expect(evaluate("G-DLV5", { requires_shot_regeneration: true })).toBe(true);
    expect(evaluate("G-DLV5", { regenerate_shots: true })).toBe(true);
    expect(evaluate("G-DLV5", {})).toBe(false);
  });

  it("G-DLV6/G-DLV7：交付必须带清单与工程文件；复用必须带证据", () => {
    expect(evaluate("G-DLV6", { delivery_manifest: false })).toBe(true);
    expect(evaluate("G-DLV6", { engineering_file: false })).toBe(true);
    expect(evaluate("G-DLV6", { skip_manifest: true })).toBe(true);
    expect(evaluate("G-DLV6", { delivery_manifest: true, engineering_file: true })).toBe(false);
    expect(evaluate("G-DLV7", { reuse_without_evidence: true })).toBe(true);
    expect(evaluate("G-DLV7", { claim_reuse_without_hash: true })).toBe(true);
    expect(evaluate("G-DLV7", {})).toBe(false);
  });

  it("G-DLV8/G-DLV9：UHD 实测画布与本地增强来源缺一即阻断", () => {
    expect(evaluate("G-DLV8", { uhd_requested: true, resolution_exact: false })).toBe(true);
    expect(evaluate("G-DLV8", { uhd_requested: true, resolution_exact: true })).toBe(false);
    expect(evaluate("G-DLV8", { uhd_requested: false, resolution_exact: false })).toBe(false);
    expect(evaluate("G-DLV9", { uhd_requested: true, enhancement_verified: false })).toBe(true);
    expect(evaluate("G-DLV9", { uhd_requested: true, enhancement_verified: true })).toBe(false);
    expect(evaluate("G-DLV9", { uhd_requested: false, enhancement_verified: false })).toBe(false);
  });
});

describe("后期工位桥（工具面与连接器纪律）", () => {
  it("只声明 6 个后期工具（读 3 / 写 3），且不提供他人工具", () => {
    expect(POST_TOOLS).toHaveLength(6);
    expect([...POST_TOOLS].sort()).toEqual([...POST_BRIDGE_TOOLS].sort());
    expect(isPostBridgeTool("postread.plan")).toBe(true);
    expect(isPostBridgeTool("postwrite.package")).toBe(true);
    expect(isPostBridgeTool("postwrite.reedit")).toBe(true);
    expect(isPostBridgeTool("subtitlewrite.burn")).toBe(false);
    expect(isPostBridgeTool("bgmwrite.mix")).toBe(false);
    expect(isPostBridgeTool("render.submit")).toBe(false);
  });

  it("未声明的工具软失败（不抛异常、不伪造回执）", async () => {
    const executor = createPostBridgeExecutor({
      baseUrl: "http://127.0.0.1:1",
      token: "t",
      fetchImpl: (async () => new Response("{}")) as unknown as typeof fetch,
    });
    const outcome = await executor("subtitlewrite.burn", {});
    expect(outcome.receipt.synced).toBe(false);
    expect(outcome.result.error).toBe("not_provided");
  });

  it("幂等键稳定（同参数同键），且不可重试码覆盖交付类硬错误", () => {
    expect(stableKey({ b: 1, a: [{ d: 2, c: 3 }] })).toBe(stableKey({ a: [{ c: 3, d: 2 }], b: 1 }));
    for (const code of ["verify_failed", "version_exists", "bad_recipe", "not_configured", "overwrite_source_forbidden", "bad_lut"]) {
      expect(NEVER_RETRY_CODES.has(code), `${code} 应为不可重试`).toBe(true);
    }
    expect(NEVER_RETRY_CODES.has("timeout")).toBe(false);
  });

  it("连接器资产齐备（README/core/cli/server/executor/adapter）", () => {
    for (const file of ["README.md", "core.mjs", "cli.mjs", "server.mjs", "executor.ts", "server-adapter.mts"]) {
      expect(existsSync(join(BRIDGE_DIR, file)), `缺 ${file}`).toBe(true);
    }
    const readme = readFileSync(join(BRIDGE_DIR, "README.md"), "utf8");
    for (const tool of POST_TOOLS) expect(readme).toContain(tool);
  });
});

describe("风格变体包（library/style-variants）", () => {
  const packs = listVariantPacks();

  it("索引列出 3 个默认变体，且每包可独立解析、id 一致", () => {
    expect(packs.map((pack) => pack.id)).toEqual(["warm-story", "clean-tech", "bold-promo"]);
    for (const pack of packs) {
      const full = findVariantPack(pack.id);
      expect(full.id).toBe(pack.id);
      expect(full.name.length).toBeGreaterThan(1);
      expect(String(full.positioning).length).toBeGreaterThan(8);
    }
  });

  it("每个变体在五个轴上都有明确取值（调色/BGM/转场/封面/文案）", () => {
    for (const pack of packs) {
      expect(pack.color, `${pack.id} 缺调色轴`).toBeTruthy();
      expect(pack.bgm, `${pack.id} 缺配乐轴`).toBeTruthy();
      expect(pack.transitions, `${pack.id} 缺转场轴`).toBeTruthy();
      expect(pack.cover, `${pack.id} 缺封面轴`).toBeTruthy();
      expect(pack.copy?.tone, `${pack.id} 缺文案口吻`).toBeTruthy();
      expect(Array.isArray(pack.copy?.hashtags) && pack.copy.hashtags.length >= 3).toBe(true);
      expect(typeof pack.copy?.cta === "string" && pack.copy.cta.length > 0).toBe(true);
    }
  });

  it("变体之间在配方层面确有差异（不是同一套参数换名字）", () => {
    const colorKeys = packs.map((pack) => `${pack.color.profile ?? ""}|${pack.color.lut ?? ""}`);
    expect(new Set(colorKeys).size).toBe(packs.length);
    const bgmKeys = packs.map((pack) => `${pack.bgm.mood ?? ""}|${pack.bgm.style ?? ""}|${pack.bgm.musicLevelDb ?? ""}`);
    expect(new Set(bgmKeys).size).toBe(packs.length);
    const transitionModes = packs.map((pack) => pack.transitions.mode);
    expect(new Set(transitionModes).size).toBeGreaterThanOrEqual(2);
    const coverTemplates = packs.map((pack) => pack.cover.template);
    expect(new Set(coverTemplates).size).toBe(packs.length);
  });

  it("引用的 LUT 与曲库情绪都真实存在（缺件必须报错，不许静默兜底）", () => {
    const lutDir = join(BUNDLE_DIR, "library/luts");
    expect(existsSync(join(lutDir, "manifest.json"))).toBe(true);
    const tracksDoc = JSON.parse(readFileSync(join(BUNDLE_DIR, "library/bgm-library-curated/tracks.json"), "utf8")) as {
      tracks: Array<{ mood?: string; style?: string }>;
    };
    const moods = new Set(tracksDoc.tracks.map((track) => track.mood));
    for (const pack of packs) {
      if (pack.color.lut) {
        expect(() => resolveLut(pack.color.lut), `${pack.id} 的 LUT ${pack.color.lut} 不存在`).not.toThrow();
      }
      expect(moods.has(pack.bgm.mood), `${pack.id} 的曲库情绪「${pack.bgm.mood}」在随仓曲库里没有曲目`).toBe(true);
    }
    // 路径监狱：LUT 只能取仓内 library/luts 下的 .cube
    expect(() => resolveLut("../../../../etc/passwd")).toThrow();
    expect(() => resolveLut("nope.cube")).toThrow();
  });

  it("选曲支持 曲目 id / 风格关键词 / 情绪 三种口径，且找不到就报错（不静默换曲）", () => {
    // ① 风格关键词（用户与配方说的"corporate-clean 那种风格"）——在全量曲库上匹配，不是只在前 20 条里找
    const byStyle = pickTrackForVariant({ id: "probe-style", bgm: { style: "corporate-clean" } });
    expect(String(byStyle.id)).toContain("corporate-clean");
    // ② 情绪
    const byMood = pickTrackForVariant({ id: "probe-mood", bgm: { mood: "温暖自在" } });
    expect(String(byMood.mood)).toContain("温暖自在");
    // ③ 不存在的风格 / 曲目 → 如实报错（fail-closed，不悄悄换一首风格不符的）
    expect(() => pickTrackForVariant({ id: "probe-missing", bgm: { style: "no-such-style-xyz" } })).toThrow(/风格|曲库/);
    expect(() => pickTrackForVariant({ id: "probe-missing-id", bgm: { trackId: "no-such-track-id" } })).toThrow(/曲库/);
  });
});

describe("变更影响分析（返修的分水岭）", () => {
  const project = {
    layers: { shots: [{ shotId: "SC-01" }, { shotId: "SC-02" }, { shotId: "SC-03" }] },
  };

  it("文字层：只重算 text，本地重合成、零 token", () => {
    const impact = analyzeImpact({ project, patch: { subtitles: { zhText: "1\n00:00:00,000 --> 00:00:01,000\n改了" } } });
    expect(impact.layers).toEqual(["text"]);
    expect(impact.localOnly).toBe(true);
    expect(impact.costHint.tokenCostDelta).toBe(0);
    expect(impact.shotRegeneration.required).toBe(false);
  });

  it("音频/调色/封面/文案：按素材依赖重算对应层", () => {
    expect(analyzeImpact({ project, patch: { bgm: { trackId: "x" } } }).layers).toEqual(["audio"]);
    // 调色会重编码音频轨（color-bridge 输出 -c:a aac），所以音频层随之重算：
    // 母版必须由同一支已调色母版派生，避免"画面 v2 / 声音 v1"的隐性错配
    // 封面从调色画面抽帧；调色变化也必须刷新封面。
    expect(analyzeImpact({ project, patch: { color: { profile: "warm-film" } } }).layers).toEqual(["color", "audio", "cover"]);
    expect(analyzeImpact({ project, patch: { cover: { at: 0.5 } } }).layers).toEqual(["cover"]);
    expect(analyzeImpact({ project, patch: { copy: { cta: "点这里" } } }).layers).toEqual(["copy"]);
  });

  it("转场变化：重拼接并顺带重算调色/音频/文字/封面，但镜头不动", () => {
    const impact = analyzeImpact({ project, patch: { transitions: { mode: "xfade", fadeSec: 0.4 } } });
    expect(impact.layers).toEqual(["assemble", "color", "audio", "text", "cover"]);
    expect(impact.localOnly).toBe(true);
    expect(impact.shotRegeneration.required).toBe(false);
  });

  it("点名画面内容：需要重生成镜头，走 G8 人审，且逐镜点名", () => {
    const impact = analyzeImpact({ project, patch: { shots: { regenerate: ["SC-02"] } } });
    expect(impact.layers).toContain("shots");
    expect(impact.shotRegeneration.required).toBe(true);
    expect(impact.shotRegeneration.shotIds).toEqual(["SC-02"]);
    expect(impact.shotRegeneration.gate).toBe("G8");
    expect(impact.localOnly).toBe(false);
    expect(String(impact.costHint.tokenCostDelta)).toContain(">0");
  });

  it("未知键与不存在的镜头都直接报错（不允许静默忽略）", () => {
    expect(() => analyzeImpact({ project, patch: { subtitel: {} } })).toThrow(/未知键/);
    expect(() => analyzeImpact({ project, patch: { subtitles: { cur: 1 } } })).toThrow(/未知键/);
    expect(() => analyzeImpact({ project, patch: { shots: { regenerate: ["SC-09"] } } })).toThrow(/不存在的镜头/);
  });
});

describe("反馈分诊（把用户的话变成返修任务）", () => {
  const project = { layers: { shots: [{ shotId: "SC-01" }, { shotId: "SC-02" }, { shotId: "SC-03" }] } };

  it("后期能解决的一律不走镜头重生成", () => {
    const cases: Array<[string, string]> = [
      ["字幕错别字太多了，时间轴也晚了半秒", "rev.text.track"],
      ["配乐太吵了，换个温柔点的", "rev.audio.mix"],
      ["颜色太黄了，想要冷一点", "rev.color.look"],
      ["封面字太小，换一张首图", "rev.cover.layout"],
      ["标题不够抓人，话题标签也换掉", "rev.copy.tone"],
      ["转场太生硬，节奏也太拖了", "rev.edit.pacing"],
    ];
    for (const [feedback, code] of cases) {
      const outcome = triageFeedback({ feedback, project });
      expect(outcome.attributions, feedback).toContain(code);
      expect(outcome.requiresShotRegeneration, feedback).toBe(false);
      expect(outcome.costHint.tokenCostDelta, feedback).toBe(0);
    }
  });

  it("点名画面内容时要求重生成镜头，并识别点名镜头", () => {
    const outcome = triageFeedback({ feedback: "第 3 个镜头人物走形了，重拍一下", project });
    expect(outcome.requiresShotRegeneration).toBe(true);
    expect(outcome.gate).toBe("G8");
    expect(outcome.shotIds).toEqual(["SC-03"]);
    expect(outcome.patchHint.shots.regenerate).toEqual(["SC-03"]);
  });

  it("镜头点名支持内部编号 / 中文序号 / 英文说法；认不出就不猜", () => {
    const shots = ["SC-01", "SC-02", "SC-03", "SC-04"];
    expect(extractShotIds("SC-02 有点晃", shots)).toEqual(["SC-02"]);
    expect(extractShotIds("镜头2 太暗了", shots)).toEqual(["SC-02"]);
    expect(extractShotIds("第 4 镜穿帮了", shots)).toEqual(["SC-04"]);
    expect(extractShotIds("shot 3 is blurry", shots)).toEqual(["SC-03"]);
    expect(extractShotIds("整体感觉不对", shots)).toEqual([]);
  });

  it("认不出类别时如实回问，不硬猜一个轴", () => {
    const outcome = triageFeedback({ feedback: "感觉不太对，说不上来", project });
    expect(outcome.kinds).toEqual(["unclear"]);
    expect(outcome.layers).toEqual([]);
    expect(outcome.requiresShotRegeneration).toBe(false);
  });
});

describe("文案包与画幅口径", () => {
  const project = {
    projectId: "VID-1",
    title: "苏州南园宾馆",
    copy: { title: "苏州南园宾馆", hook: "唯一可以入住的苏州园林", body: "百年园林里的一晚", hashtags: ["#园林民宿", "#苏州旅行", "#周末去哪儿"], cta: "想住的扣1" },
  };

  it("标题模板/话题/CTA 四检可复算", () => {
    const copy = buildCopyPack({ project, variant: { id: "warm-story", name: "暖调故事版", copy: { titleTemplate: "{title}｜{hook}", cta: "想去的扣个1", hashtags: ["#a", "#b", "#c"] } } });
    expect(copy.title).toBe("苏州南园宾馆｜唯一可以入住的苏州园林");
    expect(copy.checks.every((check) => check.ok)).toBe(true);
    const tooLong = buildCopyPack({ project: { ...project, copy: { ...project.copy, title: "标".repeat(60) } }, variant: {} });
    expect(tooLong.checks.find((check) => check.kind === "title_length")!.ok).toBe(false);
    const tooFewTags = buildCopyPack({ project, variant: { copy: { hashtags: ["#only"] } } });
    expect(tooFewTags.checks.find((check) => check.kind === "hashtags")!.ok).toBe(false);
  });

  it("画幅预设可用，未知画幅报错（不猜一个默认画幅）", () => {
    expect(resolveResolution({ aspect: "9:16" })).toEqual(ASPECT_PRESETS["9:16"]);
    expect(resolveResolution({ resolution: [720, 1280] })).toEqual([720, 1280]);
    for (const [aspect, size] of Object.entries(UHD_ASPECT_PRESETS)) {
      expect(resolveResolution({ aspect, quality: "uhd" })).toEqual(size);
    }
    expect(resolveQuality({})).toBe("hd");
    expect(resolveQuality({ quality: "uhd" })).toBe("uhd");
    expect(() => resolveQuality({ quality: "4k" })).toThrow(/未知清晰度/);
    expect(() => resolveResolution({ quality: "uhd", resolution: [1920, 1080] })).toThrow(/uhd 仅支持/);
    expect(() => resolveResolution({ aspect: "21:9" })).toThrow(/未知画幅/);
  });
});

describe("岗位 / 技能 / 管线 / 反馈枚举四层接线", () => {
  it("剪辑师岗位绑定交付围栏、装上两个交付技能，并声明写工具与回写", () => {
    expect(preset.preset_key).toBe("post-editor");
    expect(preset.readonly).toBe(false);
    for (const fence of ["G-DLV0", "G-DLV1", "G-DLV2", "G-DLV3", "G-DLV4", "G-DLV6", "G-DLV7", "G-DLV8", "G-DLV9"]) {
      expect(preset.fence_bindings, `岗位未绑定 ${fence}`).toContain(fence);
    }
    expect(preset.skills).toEqual(["delivery-package-ops", "delivery-revision-ops"]);
    const toolNames = preset.tools.map((tool) => tool.name);
    for (const tool of ["postread.plan", "postread.impact", "postwrite.package", "postwrite.reedit", "postwrite.triage", "subtitlewrite.sidecar", "subtitlewrite.softmux"]) {
      expect(toolNames, `岗位未声明 ${tool}`).toContain(tool);
    }
    for (const tool of ["postwrite.package", "postwrite.reedit"]) {
      expect(preset.write_back, `岗位未回写 ${tool}`).toContain(tool);
    }
    expect(preset.coverage.map((coverage) => coverage.eventPrefix)).toContain("delivery.");
  });

  it("两个技能目录都有 SKILL.md，frontmatter 名与目录一致且引用围栏", () => {
    for (const skill of preset.skills) {
      const file = join(BUNDLE_DIR, "skills", skill, "SKILL.md");
      expect(existsSync(file), `${skill} 缺 SKILL.md`).toBe(true);
      const front = YAML.parse(/^---\n([\s\S]*?)\n---/.exec(readFileSync(file, "utf8"))?.[1] ?? "{}") as { name?: string; description?: string };
      expect(front.name).toBe(skill);
      expect((front.description ?? "").length).toBeGreaterThan(80);
      expect(front.description ?? "").toMatch(/G-DLV/);
    }
  });

  it("叙事片管线把交付与返修写成显式步骤，且字幕步明确不烧字", () => {
    const pipeline = YAML.parse(readFileSync(join(BUNDLE_DIR, "pipelines/narrative-film.yml"), "utf8")) as {
      steps: Array<{ step_key: string; owner: string; outputs: string[]; note?: string; gate?: string }>;
    };
    const keys = pipeline.steps.map((step) => step.step_key);
    expect(keys).toContain("deliver");
    expect(keys).toContain("revise");
    const deliver = pipeline.steps.find((step) => step.step_key === "deliver")!;
    expect(deliver.owner).toBe("post-editor");
    expect(deliver.outputs).toContain("delivery_package");
    expect(deliver.gate).toBe("G-DLV1");
    const revise = pipeline.steps.find((step) => step.step_key === "revise")!;
    expect(revise.outputs).toContain("revision_report");
  });

  it("分诊归因码全部登记在反馈枚举表里（事件账本可归因）", () => {
    const enums = YAML.parse(readFileSync(join(BUNDLE_DIR, "feedback-enums.yml"), "utf8")) as {
      enums: Array<{ code: string; label: string; appliesTo: string[] }>;
    };
    const codes = new Set(enums.enums.map((entry) => entry.code));
    for (const rule of REVISION_RULES) {
      expect(codes.has(rule.attribution), `反馈枚举表缺 ${rule.attribution}`).toBe(true);
      expect(rule.patterns.length).toBeGreaterThan(0);
      expect(rule.layers.length).toBeGreaterThan(0);
    }
    // 返修归因码必须挂在 revise 场景下（历史事件按 code 归因，appliesTo 决定它出现在哪个反馈通道）
    for (const entry of enums.enums.filter((item) => item.code.startsWith("rev."))) {
      expect(entry.appliesTo, `${entry.code} 的 appliesTo 应含 revise`).toContain("revise");
    }
  });

  it("bundle 清单登记了交付围栏 / 两个技能 / 变体配方 / 后期连接器", () => {
    const manifest = JSON.parse(readFileSync(join(BUNDLE_DIR, "bundle.json"), "utf8")) as {
      workloom: { provides: Record<string, string[]> };
    };
    const provided = Object.values(manifest.workloom.provides).flat();
    for (const asset of [
      "fences/ai-video-delivery.yml",
      "skills/delivery-package-ops/SKILL.md",
      "skills/delivery-revision-ops/SKILL.md",
      "library/style-variants/index.json",
      "library/style-variants/warm-story.json",
      "connectors/post-bridge/core.mjs",
      "connectors/post-bridge/cli.mjs",
    ]) {
      expect(provided, `bundle.json 未登记 ${asset}`).toContain(asset);
      expect(existsSync(join(BUNDLE_DIR, asset)), `${asset} 不在磁盘上`).toBe(true);
    }
  });

  it("工位文件与岗位/管线声明一致（无孤儿：presets 里的每个技能目录都存在）", () => {
    const skillDirs = readdirSync(join(BUNDLE_DIR, "skills"));
    for (const skill of preset.skills) expect(skillDirs).toContain(skill);
    expect(REPO_ROOT.length).toBeGreaterThan(0);
  });
});
