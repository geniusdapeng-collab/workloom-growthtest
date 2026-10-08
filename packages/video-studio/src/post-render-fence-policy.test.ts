import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import YAML from "yaml";
// This package typecheck keeps rootDir=src. Load the real cross-package evaluator
// at runtime while retaining the tested public input/output contract locally.
type FenceLevel = "auto" | "review" | "block";
type RuntimeRule = { rule_id: string; version: string; name: string; level: FenceLevel;
  is_baseline: boolean; objectTypes: string[]; actions: string[]; when: string };
type Judge = (input: { object: { type: string }; action: string; effect: "write";
  params: Record<string, unknown>; context: Record<string, unknown> }, rules: RuntimeRule[], defaultLevel: FenceLevel) => {
    level: FenceLevel; impacts: Array<{ rule_id: string; result: "pass" | "review" | "blocked" | "conflict" }>;
    evalErrors: string[];
  };
const judgeModule = fileURLToPath(new URL("../../base/fence-engine/judge.ts", import.meta.url));
const { judge } = await import(judgeModule) as { judge: Judge };

type FactoryRule = {
  rule_id: string; name: string; level: FenceLevel; is_baseline: boolean;
  match: { object_types: string[]; actions: string[] }; when: string;
};
const directory = fileURLToPath(new URL("../../../bundles/ai-video/fences/", import.meta.url));
const packs = ["delivery", "subtitle", "color", "bgm", "voice", "material"].map(name => {
  const pack = YAML.parse(readFileSync(directory + "ai-video-" + name + ".yml", "utf8")) as {
    version: string; default_level: FenceLevel; rules: FactoryRule[];
  };
  return {
    name, defaultLevel: pack.default_level,
    rules: pack.rules.map((rule): RuntimeRule => ({
      rule_id: rule.rule_id, name: rule.name, level: rule.level, is_baseline: rule.is_baseline,
      version: pack.version, objectTypes: rule.match.object_types, actions: rule.match.actions, when: rule.when,
    })),
  };
});
const rules = packs.flatMap(pack => pack.rules);
const context = { tenant_daily_bgm: 0, tenant_daily_subtitle: 0, tenant_daily_grades: 0, tenant_daily_voice_seconds: 0 };
const material = {
  material_usage: "generation-reference", reference_only: true,
  render_task_id: "ARK-task-1", model: "seedance-1.5-pro",
  source_material_sha256: "a".repeat(64), output_sha256: "b".repeat(64),
};
const qualityFlags = {
  verify: false, skip_verify: true, min_score: 99999, variants_distinct: false,
  identical_variants: true, variant_count: 1, uhd_requested: true, enhancement_verified: false,
  brand_font_change: true, font_library_new: true, look_change: true, lut_approved: false,
  theme_change: true, fidelity_reviewed: false, landmark_altered: true, text_identifier_changed: true,
  ignore_safe_area: true, allow_ui_overlap: true, allow_flood: true, ignore_density: true, skip_safe_area: true,
};
const verdict = (action: string, params: Record<string, unknown> = {}, objectType = "final_video",
  override: Record<string, unknown> = {}) => judge({
    object: { type: objectType }, action, effect: "write", params, context: { ...context, ...override },
  }, rules, "review");

describe("默认后期通过真实围栏判定器", () => {
  it.each([
    "postwrite.package", "postwrite.reedit", "postwrite.triage",
    "subtitlewrite.plan", "subtitlewrite.burn", "subtitlewrite.title", "subtitlewrite.danmaku",
    "subtitlewrite.sticker", "subtitlewrite.karaoke", "subtitlewrite.best", "subtitlewrite.sidecar", "subtitlewrite.softmux",
    "colorwrite.grade", "colorwrite.match", "bgmwrite.compose", "bgmwrite.mix", "bgmwrite.best", "bgmwrite.separate",
    "voicewrite.speak", "voicewrite.dub",
  ])("%s 未提供旧质量字段或原片路径时正常 auto", action => {
    const actual = verdict(action);
    expect(actual.evalErrors).toEqual([]);
    expect(actual.level).toBe("auto");
  });

  it.each([
    "postwrite.package", "postwrite.reedit", "subtitlewrite.burn", "subtitlewrite.title", "subtitlewrite.danmaku",
    "subtitlewrite.sticker", "subtitlewrite.karaoke", "subtitlewrite.best", "subtitlewrite.sidecar", "subtitlewrite.softmux",
    "colorwrite.grade", "bgmwrite.mix", "bgmwrite.best", "voicewrite.speak", "voicewrite.dub",
  ])("%s 原片观感与旧质量参数不挂起、不重生成", action => {
    const actual = verdict(action, qualityFlags);
    expect(actual.evalErrors).toEqual([]);
    expect(actual.level).toBe("auto");
  });

  it("成功素材镜有真实声明字段但旧保真失败时直接采用", () => {
    const actual = verdict("material.generate", { ...material, ...qualityFlags }, "video_asset");
    expect(actual.evalErrors).toEqual([]);
    expect(actual.level).toBe("auto");
  });

  it.each(["render_task_id", "model", "source_material_sha256", "output_sha256"])("素材镜缺 %s 仍不视为完成", key => {
    const params: Record<string, unknown> = { ...material };
    delete params[key];
    const actual = verdict("material.generate", params, "video_asset");
    expect(actual.evalErrors).toEqual([]);
    expect(actual.level).toBe("review");
    expect(actual.impacts.find(impact => impact.rule_id === "G-MAT2")?.result).toBe("review");
  });

  it.each([null, false, 0, "", [], {}])("素材镜伪声明 %j 不通过溯源门槛", value => {
    for (const key of ["render_task_id", "model", "source_material_sha256", "output_sha256"]) {
      const actual = verdict("material.generate", { ...material, [key]: value }, "video_asset");
      expect(actual.evalErrors).toEqual([]);
      expect(actual.level).toBe("review");
    }
  });

  it.each([
    { provider_failed: true }, { render_failed: true }, { render_status: "failed" }, { render_status: "error" }, { render_status: "cancelled" },
  ])("真实生成失败 %j 不能采用为成功回执", flag => {
    const actual = verdict("material.generate", { ...material, ...flag }, "video_asset");
    expect(actual.evalErrors).toEqual([]);
    expect(actual.level).toBe("review");
  });

  it.each([
    ["subtitlewrite.burn", { output_path: "/work/a.mp4", input_path: "/work/a.mp4" }],
    ["postwrite.package", { overwrite_source: true }],
    ["colorwrite.grade", { output_path: "C:\\work\\a.mp4", input_path: "C:\\work\\a.mp4" }],
    ["bgmwrite.mix", { output_path: "/work/a.mp4", input_path: "/work/a.mp4" }],
    ["voicewrite.dub", { out: "/work/a.mp4", video: "/work/a.mp4" }],
    ["subtitlewrite.burn", { commercial_use: true, font_license: "cc-by-nc-4.0" }],
    ["bgmwrite.mix", { commercial_use: true, track_license: "unknown" }],
    ["bgmwrite.mix", { policy: "music-only" }],
    ["voicewrite.speak", { upload_voiceprint: true }],
  ] as Array<[string, Record<string, unknown>]>)("%s 原始字节、许可和隐私边界仍拒绝违规参数", (action, params) => {
    const type = action === "voicewrite.speak" ? "voice_report"
      : action === "bgmwrite.mix" && params.commercial_use ? "bgm_report"
      : action === "subtitlewrite.burn" && params.commercial_use ? "subtitle_report" : "final_video";
    const actual = verdict(action, params, type);
    expect(actual.evalErrors).toEqual([]);
    expect(actual.level).toBe("block");
  });

  it.each([
    ["subtitlewrite.burn", "tenant_daily_subtitle", 60],
    ["colorwrite.grade", "tenant_daily_grades", 30],
    ["bgmwrite.mix", "tenant_daily_bgm", 40],
    ["voicewrite.dub", "tenant_daily_voice_seconds", 3600],
  ] as Array<[string, string, number]>)("%s 租户配额保持熔断", (action, key, limit) => {
    const actual = verdict(action, {}, "final_video", { [key]: limit });
    expect(actual.evalErrors).toEqual([]);
    expect(actual.level).toBe("block");
  });

  it("新镜头生成、声音授权和外发权限仍在执行前控制", () => {
    expect(verdict("postwrite.reedit", { requires_shot_regeneration: true }).level).toBe("review");
    expect(verdict("voicewrite.register", {}, "voice_profile").level).toBe("review");
    expect(verdict("voicewrite.dub", { publish_external: true, consent_scope: "internal" }).level).toBe("review");
    expect(verdict("material.generate", { ...material, reference_only: false }, "video_asset").level).toBe("block");
    expect(verdict("material.generate", { ...material, first_frame_from_reference: true }, "video_asset").level).toBe("block");
    expect(verdict("material.generate", { ...material, static_display: true }, "video_asset").level).toBe("block");
    expect(verdict("bgmwrite.mix", { policy: "music-only", allow_discard_original: true }).level).toBe("auto");
  });
});
