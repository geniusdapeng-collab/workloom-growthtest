/**
 * 标题字幕能力（岗位 / 技能 / 字体档案 / 版式配方 / 围栏 / 管线 / 工位桥）交叉引用与语义回归测试。
 *
 * 为什么单独一组：字幕这条链路的失败模式是**静默**的——
 *  · 围栏 when 写错 → 要么放行覆盖原片，要么把所有干净渲染都熔断（求值异常按 block）；
 *  · 版式遮挡区算错 → 字幕压在平台点赞栏上，观众看不清而系统"全绿"；
 *  · 字体许可判松 → 商用交付踩字体版权；
 *  · 字体只登记不核验 → 工位装了错的字体、或 libass 静默回落系统字体，选型形同虚设；
 *  · 岗位/技能/管线/对象四层断链 → 运行到后期时"这一步没人执行"。
 * 这些都能在磁盘上静态验出来，所以本组测试不触 DB、不依赖 ffmpeg。
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import YAML from "yaml";

import { evalCondition } from "../fence-engine/expr.js";
import { bundlesRoot } from "./assembly.js";
import {
  FONT_LICENSE_TABLE, MOOD_ART_PREF, SCENE_WEIGHT_PREF, SUBTITLE_TOOLS, WEIGHTS,
  assColour, buildAssDocument, checkFontSize, checkLineWidth, decideTextStyle, findRecipes,
  checkDanmakuDensity, escapeAssText, karaokeAssText, layoutFor, licenseInfo, loadFontCatalog, loadRecipes,
  overlapsOcclusion, parseAssEvents, parseDanmaku, parseSrt, parseTimedWords, planDanmakuTracks,
  prepareFlatFontsDir, recommendSize, scoreFont, selectFonts, stickerAssText, stickerStylePreset,
  styleLine, textBands, trimDanmaku, fontsRoot, scanFonts,
} from "../../../bundles/ai-video/connectors/subtitle-bridge/core.mjs";

const ROOT = bundlesRoot();
const REPO_ROOT = dirname(ROOT);
const BUNDLE_DIR = join(ROOT, "ai-video");
const BRIDGE_DIR = join(BUNDLE_DIR, "connectors/subtitle-bridge");

interface FenceRule {
  rule_id: string;
  name: string;
  level: "auto" | "review" | "block";
  is_baseline: boolean;
  match: { object_types: string[]; actions: string[] };
  when: string;
  note?: string;
}

const fencePack = YAML.parse(readFileSync(join(BUNDLE_DIR, "fences/ai-video-subtitle.yml"), "utf8")) as {
  version: string;
  default_level: string;
  rules: FenceRule[];
};
const when = (ruleId: string): string => fencePack.rules.find((rule) => rule.rule_id === ruleId)!.when;
const evaluate = (ruleId: string, params: Record<string, unknown> = {}, context: Record<string, unknown> = {}): boolean =>
  evalCondition(when(ruleId), { params, context } as never);

describe("标题字幕围栏（G-SUB0..G-SUB5）语义", () => {
  it("六条规则齐备，级别与基线口径正确", () => {
    expect(fencePack.version).toBe("ai-video-subtitle/v3");
    expect(fencePack.rules.map((rule) => rule.rule_id)).toEqual([
      "G-SUB0", "G-SUB1", "G-SUB2", "G-SUB3", "G-SUB4", "G-SUB5", "G-SUB6",
    ]);
    expect(fencePack.rules.every((rule) => rule.is_baseline === true)).toBe(true);
    const levels = Object.fromEntries(fencePack.rules.map((rule) => [rule.rule_id, rule.level]));
    expect(levels).toEqual({
      "G-SUB0": "auto", "G-SUB1": "review", "G-SUB2": "block",
      "G-SUB3": "block", "G-SUB4": "block", "G-SUB5": "block", "G-SUB6": "block",
    });
  });

  it("常规渲染直通；四类红线各自命中；表达式不产生求值异常（异常=全量熔断）", () => {
    expect(evaluate("G-SUB0")).toBe(true);

    // G-SUB1：品牌视觉锤变更 / 字体库首次入片 / 许可未核验 → review
    expect(evaluate("G-SUB1", { license_reviewed: false })).toBe(true);
    expect(evaluate("G-SUB1", { brand_font_change: true })).toBe(true);
    expect(evaluate("G-SUB1", { font_library_new: true })).toBe(true);
    expect(evaluate("G-SUB1", { license_reviewed: true })).toBe(false);
    expect(evaluate("G-SUB1")).toBe(false);

    // G-SUB2：覆盖原片 → block
    expect(evaluate("G-SUB2", { overwrite_source: true })).toBe(true);
    expect(evaluate("G-SUB2", { output_path: "/a.mp4", input_path: "/a.mp4" })).toBe(true);
    expect(evaluate("G-SUB2", { output_path: "/b.mp4", input_path: "/a.mp4" })).toBe(false);

    // G-SUB3：关闭复检 / 无视安全区 → block
    expect(evaluate("G-SUB3", { skip_verify: true })).toBe(true);
    expect(evaluate("G-SUB3", { verify: false })).toBe(true);
    expect(evaluate("G-SUB3", { ignore_safe_area: true })).toBe(true);
    expect(evaluate("G-SUB3", { allow_ui_overlap: true })).toBe(true);
    expect(evaluate("G-SUB3", { verify: true })).toBe(false);
    expect(evaluate("G-SUB3")).toBe(false);

    // G-SUB4：日配额熔断（缺字段按求值异常 → block，属 fail-closed，故运行时必须带值）
    expect(evaluate("G-SUB4", {}, { tenant_daily_subtitle: 60 })).toBe(true);
    expect(evaluate("G-SUB4", {}, { tenant_daily_subtitle: 59 })).toBe(false);
    expect(() => evalCondition(when("G-SUB4"), { params: {}, context: {} } as never)).toThrow();

    // G-SUB5：字体许可白名单（缺许可 / 非白名单 → 阻断；白名单 → 放行）
    expect(evaluate("G-SUB5", { commercial_use: true })).toBe(true);
    expect(evaluate("G-SUB5", { commercial_use: true, font_license: "unknown-vendor" })).toBe(true);
    expect(evaluate("G-SUB5", { commercial_use: true, font_license: "cc-by-nc-4.0" })).toBe(true);
    expect(evaluate("G-SUB5", { commercial_use: true, font_license: "ofl-1.1" })).toBe(false);
    expect(evaluate("G-SUB5", { commercial_use: true, font_license: "apache-2.0" })).toBe(false);
    expect(evaluate("G-SUB5", { commercial_use: true, font_license: "vendor-free-commercial" })).toBe(false);
    expect(evaluate("G-SUB5", { commercial_use: false, font_license: "unknown-vendor" })).toBe(false);

    // G-SUB6：弹幕/贴纸不得绕过密度与安全区（allow_flood / ignore_density / skip_safe_area）
    expect(evaluate("G-SUB6", { allow_flood: true })).toBe(true);
    expect(evaluate("G-SUB6", { ignore_density: true })).toBe(true);
    expect(evaluate("G-SUB6", { skip_safe_area: true })).toBe(true);
    expect(evaluate("G-SUB6", { max_concurrent: 8 })).toBe(false);
  });

  it("G-SUB0 覆盖全部渲染动作（含弹幕/贴纸/卡拉OK），写动作不留白", () => {
    const auto = fencePack.rules.find((rule) => rule.rule_id === "G-SUB0")!;
    for (const action of SUBTITLE_TOOLS.filter((tool) => tool.startsWith("subtitlewrite."))) {
      expect(auto.match.actions, `G-SUB0 未覆盖 ${action}`).toContain(action);
    }
    const flood = fencePack.rules.find((rule) => rule.rule_id === "G-SUB6")!;
    expect(flood.match.actions).toContain("subtitlewrite.danmaku");
    expect(flood.match.actions).toContain("subtitlewrite.sticker");
  });
});

describe("字体档案库（font-catalog）", () => {
  const catalog = loadFontCatalog();

  it("29 款字体（中文 13 + 英文 16），打标维度齐备且取值合法", () => {
    expect(catalog.schemaVersion).toBe("workloom.font-catalog/v1");
    expect(catalog.fonts).toHaveLength(29);
    expect(catalog.fonts.filter((font: { file: string }) => font.file.startsWith("cn/"))).toHaveLength(13);
    expect(catalog.fonts.filter((font: { file: string }) => font.file.startsWith("en/"))).toHaveLength(16);
    const ids = catalog.fonts.map((font: { id: string }) => font.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const font of catalog.fonts) {
      expect(font.文件 ?? font.file).toMatch(/^(cn|en)\/[\w.-]+\.(ttf|otf|ttc)$/);
      expect(font.sha256, `${font.id} sha256`).toMatch(/^[a-f0-9]{64}$/);
      expect(font.bytes).toBeGreaterThan(1000);
      expect(font.语言.length).toBeGreaterThan(0);
      for (const lang of font.语言) expect(["zh", "en"]).toContain(lang);
      expect(font.场景.length).toBeGreaterThan(0);
      for (const scene of font.场景) expect(["标题", "字幕", "弹幕", "贴纸"]).toContain(scene);
      expect(font.艺术气息).toBeGreaterThanOrEqual(1);
      expect(font.艺术气息).toBeLessThanOrEqual(5);
      expect(font.字体粗细程度).toBeGreaterThanOrEqual(0.5);
      expect(font.字体粗细程度).toBeLessThanOrEqual(5);
      expect(font.气质关键词.length).toBeGreaterThan(0);
      expect(font.适合作品类型.length).toBeGreaterThan(0);
      expect(font.适配BGM节奏.length).toBeGreaterThan(0);
      // 许可必须落在商用白名单（未登记许可不得进档案）
      expect(catalog.licensePolicy.commercialWhitelist).toContain(font.license);
      expect(FONT_LICENSE_TABLE[font.license]?.commercial).toBe(true);
      expect(font.source).toMatch(/^https:\/\//);
    }
  });

  it("字号策略与版式策略齐备：六平台 + 遮挡区矩形合法 + 账号视觉锤示例", () => {
    const size = catalog.size_policy;
    expect(size.base_ratio).toMatchObject({ 标题: 0.11, 字幕: 0.048, 弹幕: 0.04, 贴纸: 0.07 });
    expect(size.outline_ratio).toBeCloseTo(0.06, 5);
    expect(size.safe_margin_ratio).toBeCloseTo(0.05, 5);

    const platforms = ["默认", "抖音/快手", "B站", "小红书", "视频号", "YouTube"];
    for (const platform of platforms) {
      const layout = catalog.layout_policy[platform];
      expect(layout, platform).toBeDefined();
      expect(layout.画幅).toMatch(/^\d+:\d+$/);
      expect(layout.标题.alignment).toBeGreaterThanOrEqual(1);
      expect(layout.标题.alignment).toBeLessThanOrEqual(9);
      expect(layout.字幕.alignment).toBeGreaterThanOrEqual(1);
      expect(layout.字幕.alignment).toBeLessThanOrEqual(9);
      expect(layout.字幕.bottom_margin_ratio).toBeGreaterThan(0);
      expect(layout.字幕.bottom_margin_ratio).toBeLessThan(0.3);
      expect(layout.字幕.字号倍率).toBeGreaterThan(0.8);
      expect(layout.字幕.字号倍率).toBeLessThan(1.4);
      for (const zone of layout.occlusion_zones ?? []) {
        expect(zone.id).toBeTruthy();
        for (const key of ["x", "y", "w", "h"]) {
          expect(zone[key], `${platform}.${zone.id}.${key}`).toBeGreaterThanOrEqual(0);
          expect(zone[key], `${platform}.${zone.id}.${key}`).toBeLessThanOrEqual(1);
        }
        expect(zone.x + zone.w).toBeLessThanOrEqual(1.0001);
        expect(zone.y + zone.h).toBeLessThanOrEqual(1.0001);
      }
    }
    // 竖屏三平台必须有遮挡区（右侧互动栏 / 底部文案），否则安全区校验无从谈起
    for (const platform of ["抖音/快手", "小红书", "视频号"]) {
      const zones = catalog.layout_policy[platform].occlusion_zones ?? [];
      expect(zones.map((zone: { id: string }) => zone.id)).toContain("right-rail");
    }
    expect(Object.keys(catalog.account_persona).some((key) => key.includes("文艺"))).toBe(true);
    const persona = catalog.account_persona["示例-文艺旅行账号"];
    expect(persona.锁定字体.字幕).toBeTruthy();
    expect(persona.艺术气息区间).toEqual([3, 5]);
  });
});

describe("版式配方库（typography-recipes）", () => {
  const doc = loadRecipes();

  it("16 条题材配方，引用的字体全部在档案里且场景/平台取值合法", () => {
    expect(doc.schemaVersion).toBe("workloom.typography-recipes/v1");
    expect(doc.recipes).toHaveLength(16);
    const ids = doc.recipes.map((recipe: { id: string }) => recipe.id);
    expect(new Set(ids).size).toBe(ids.length);
    const catalog = loadFontCatalog();
    const fontNames = new Set(catalog.fonts.map((font: { 字体名称: string }) => font.字体名称));
    const platforms = new Set(Object.keys(catalog.layout_policy));
    for (const recipe of doc.recipes) {
      expect(recipe.genre).toBeTruthy();
      expect(recipe.mood).toBeTruthy();
      expect(recipe.subtitleFont.length).toBeGreaterThan(0);
      expect(recipe.titleFont.length).toBeGreaterThan(0);
      for (const name of [...recipe.subtitleFont, ...recipe.titleFont]) {
        expect(fontNames.has(name), `${recipe.id} 引用未登记字体：${name}`).toBe(true);
      }
      expect(recipe.artMax).toBeGreaterThanOrEqual(1);
      expect(recipe.artMax).toBeLessThanOrEqual(5);
      expect(recipe.outlineRatio).toBeGreaterThanOrEqual(0.03);
      expect(recipe.outlineRatio).toBeLessThanOrEqual(0.12);
      expect(["none", "box", "shadow"]).toContain(recipe.backdrop);
      expect(recipe.platforms.length).toBeGreaterThan(0);
      for (const platform of recipe.platforms) expect(platforms.has(platform), `${recipe.id} 平台 ${platform}`).toBe(true);
      expect(recipe.avoid.length).toBeGreaterThan(0);
      expect(recipe.notes.length).toBeGreaterThan(10);
    }
  });

  it("交付目标值齐备（字号区间/行宽/对比/可现度/标题时长）", () => {
    const targets = doc.targets;
    expect(targets.subtitleMinPxRatio).toBeCloseTo(0.038, 4);
    expect(targets.subtitleMaxPxRatio).toBeCloseTo(0.075, 4);
    expect(targets.maxLineCharsZh).toBe(18);
    expect(targets.maxLineCharsEn).toBe(42);
    expect(targets.maxLinesSubtitle).toBe(2);
    expect(targets.minTextBackgroundContrast).toBeCloseTo(0.32, 4);
    expect(targets.titleOnScreenSec).toEqual([1.5, 4.0]);
  });

  it("检索：题材/平台/关键词都能收敛，命中不了时如实说明", () => {
    expect(findRecipes({ recipeId: "outdoor-travel" }).recipe.id).toBe("outdoor-travel");
    expect(findRecipes({ genre: "美妆" }).recipe.id).toBe("beauty");
    expect(findRecipes({ platform: "YouTube" }).matched).toBeGreaterThan(0);
    const none = findRecipes({ recipeId: "not-exist" });
    expect(none.recipe).toBeNull();
    expect(none.note).toContain("没有匹配");
  });
});

describe("选型规则引擎（纯函数，与附件 v1.1 口径一致）", () => {
  const catalog = loadFontCatalog();
  const travelBrief = {
    作品类型: "生活vlog",
    视频生成提示词: "川西高原航拍，雪山倒映在草海晨光中，藏寨炊烟袅袅，经幡随风舞动，文艺清新的旅行vlog质感，镜头节奏明快",
    内容调性: "旅行文艺",
    账号调性: "文艺旅行账号",
    BGM节奏: "快",
    语言: "zh",
    平台: "抖音/快手",
    分辨率: [1080, 1920],
    气质关键词: ["文艺", "清新"],
  };

  it("权重与场景/调性口径固定（改口径必须同步改附件与文档）", () => {
    expect(WEIGHTS).toEqual({ type_match: 30, tempo_match: 20, weight_fit: 20, art_fit: 15, keyword_hit: 15 });
    expect(SCENE_WEIGHT_PREF.字幕.range).toEqual([0.5, 3.0]);
    expect(SCENE_WEIGHT_PREF.标题.ideal).toBe(4.5);
    expect(MOOD_ART_PREF.文艺).toEqual([4, 5]);
  });

  it("硬过滤：场景不符、语言不符、许可不可商用一律 -1 且带原因", () => {
    const serif = catalog.fonts.find((font: { id: string }) => font.id === "noto-serif-sc-variable");
    expect(scoreFont(serif, travelBrief, "贴纸").score).toBe(-1);
    expect(scoreFont(serif, travelBrief, "贴纸").reasons[0]).toContain("不支持场景");

    const enOnly = catalog.fonts.find((font: { id: string }) => font.id === "playfair-display");
    expect(scoreFont(enOnly, travelBrief, "标题").score).toBe(-1);
    expect(scoreFont(enOnly, travelBrief, "标题").reasons[0]).toContain("不支持语言");

    const ncFont = { ...serif, license: "cc-by-nc-4.0" };
    expect(scoreFont(ncFont, travelBrief, "字幕").score).toBe(-1);
    expect(scoreFont(ncFont, travelBrief, "字幕").reasons[0]).toContain("许可不可商用");
  });

  it("打分：文艺旅拍下书法/手写系靠前，且每条都带可解释理由", () => {
    const top = selectFonts({ brief: travelBrief, scene: "字幕", top: 3, catalog }).top;
    expect(top.map((item: { name: string }) => item.name)).toContain("霞鹜文楷");
    expect(top[0].score).toBeGreaterThan(70);
    for (const item of top) {
      expect(item.reasons.length).toBeGreaterThan(0);
      expect(item.size.sizePx).toBeGreaterThan(0);
    }
    // 排序必须单调不增（同分按 id 稳定）
    for (let index = 1; index < top.length; index += 1) {
      expect(top[index - 1].score).toBeGreaterThanOrEqual(top[index].score);
    }
  });

  it("账号视觉锤：锁定字体置顶且标记 pinned，其余候选仍按分数排序", () => {
    const pinnedBrief = {
      ...travelBrief,
      账号调性配置: { 锁定字体: { 字幕: "思源黑体CN（可变字重）" }, 艺术气息区间: [3, 5] },
    };
    const result = selectFonts({ brief: pinnedBrief, scene: "字幕", top: 3, catalog });
    expect(result.pinned).toBe(true);
    expect(result.top[0].name).toBe("思源黑体CN（可变字重）");
    expect(result.top[0].pinned).toBe(true);
    expect(result.top[0].score).toBe(999);
    expect(result.top.filter((item: { name: string }) => item.name === "思源黑体CN（可变字重）")).toHaveLength(1);
  });

  it("未安装的字体在工位视角被标出来（不能拿没装的字体出方案）", () => {
    const dir = mkdtempSync(join(tmpdir(), "subtitle-fonts-"));
    try {
      const result = selectFonts({ brief: travelBrief, scene: "字幕", top: 3, catalog, fontsDir: dir });
      expect(result.top.every((item: { installed: boolean }) => item.installed === false)).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("字号推导式与平台倍率：短边×基准比×粗细修正×倍率，可复算", () => {
    const font = catalog.fonts.find((item: { 字体名称: string }) => item.字体名称 === "思源黑体CN（可变字重）");
    const size = recommendSize({ scene: "字幕", resolution: [1080, 1920], font, catalog, platform: "抖音/快手" });
    // 短边 1080 × 0.048 × (1 + (2.5-2)*0.04 = 1.02) × 1.05 = 55.6 → 56
    expect(size.sizePx).toBe(56);
    expect(size.basis).toContain("短边1080");
    expect(size.outlinePx).toBe(Math.max(1, Math.round(56 * 0.06)));
    expect(size.safeMarginPx).toBe(54);
    const titleSize = recommendSize({ scene: "标题", resolution: [1080, 1920], font, catalog, platform: "抖音/快手" });
    expect(titleSize.sizePx).toBeGreaterThan(size.sizePx);
  });

  it("版式回落：未知平台回落「默认」，不静默用错平台的遮挡区", () => {
    expect(layoutFor("不存在的平台", catalog).key).toBe("默认");
    expect(layoutFor("抖音/快手", catalog).key).toBe("抖音/快手");
    expect(layoutFor(null, catalog).layout.画幅).toBe("16:9");
  });
});

describe("版式校验（行宽/字号/遮挡/配色决策）", () => {
  const targets = loadRecipes().targets;

  it("行宽：18 字内通过，超限给出可执行处置", () => {
    expect(checkLineWidth("雪山倒映在草海的晨光里", targets).ok).toBe(true);
    const long = checkLineWidth("这是一句特别长的字幕文案用来验证单行字符上限是否会被正确识别出来", targets);
    expect(long.ok).toBe(false);
    expect(long.note).toContain("拆两行");
  });

  it("字号体检：低于下限/高于上限都判不达标", () => {
    expect(checkFontSize({ scene: "字幕", sizePx: 54, resolution: [1080, 1920], targets }).ok).toBe(true);
    expect(checkFontSize({ scene: "字幕", sizePx: 30, resolution: [1080, 1920], targets }).ok).toBe(false);
    expect(checkFontSize({ scene: "标题", sizePx: 60, resolution: [1080, 1920], targets }).ok).toBe(false);
    expect(checkFontSize({ scene: "标题", sizePx: 140, resolution: [1080, 1920], targets }).ok).toBe(true);
  });

  it("遮挡区判定：字幕带压到抖音右栏/底部文案即判命中", () => {
    const catalog = loadFontCatalog();
    const zones = catalog.layout_policy["抖音/快手"].occlusion_zones;
    expect(overlapsOcclusion({ x: 0.3, y: 0.78, w: 0.4, h: 0.03 }, zones)).toHaveLength(0);
    expect(overlapsOcclusion({ x: 0.7, y: 0.78, w: 0.28, h: 0.03 }, zones).map((zone: { id: string }) => zone.id))
      .toContain("right-rail");
    expect(overlapsOcclusion({ x: 0.1, y: 0.90, w: 0.8, h: 0.03 }, zones).map((zone: { id: string }) => zone.id))
      .toContain("bottom-caption");
  });

  it("配色决策由实测驱动：亮底用深字、暗底用浅字、花底加底衬；对比不足判不达标", () => {
    const light = decideTextStyle({ scene: "字幕", band: { lumaAvgUnit: 0.8, edgeDensityUnit: 0.05 }, size: 54, targets });
    expect(light.primaryColour).toBe(assColour("#16181D"));
    expect(light.contrastOk).toBe(true);
    const dark = decideTextStyle({ scene: "字幕", band: { lumaAvgUnit: 0.12, edgeDensityUnit: 0.04 }, size: 54, targets });
    expect(dark.primaryColour).toBe(assColour("#FFFFFF"));
    const busy = decideTextStyle({ scene: "字幕", band: { lumaAvgUnit: 0.4, edgeDensityUnit: 0.35 }, size: 54, targets });
    expect(busy.busy).toBe(true);
    expect(busy.borderStyle).toBe(3);
    expect(busy.outline).toBeGreaterThanOrEqual(Math.round(54 * 0.08));
    // 中间调背景（0.61）：纯描边对比 0.312 刚好卡在合格线下 → 自动升级底衬并按等效背景重算
    const lowContrast = decideTextStyle({ scene: "字幕", band: { lumaAvgUnit: 0.61, edgeDensityUnit: 0.05 }, size: 54, targets });
    expect(lowContrast.contrast).toBeLessThan(0.32);
    expect(lowContrast.escalated).toBe(true);
    expect(lowContrast.borderStyle).toBe(3);
    expect(lowContrast.effectiveContrast).toBeGreaterThanOrEqual(0.32);
    expect(lowContrast.contrastOk).toBe(true);
  });

  it("逗号文案带：字幕带随平台边距变化（抖音上抬、B站贴底）", () => {
    const catalog = loadFontCatalog();
    const douyin = textBands({ resolution: [1080, 1920], layout: catalog.layout_policy["抖音/快手"] });
    const bili = textBands({ resolution: [1920, 1080], layout: catalog.layout_policy.B站 });
    expect(douyin.subtitleBand.y).toBeLessThan(bili.subtitleBand.y);
    expect(douyin.subtitleBand.px.y).toBeGreaterThan(1000);
  });
});

describe("SRT 与 ASS（时间轴是交付契约）", () => {
  const targets = loadRecipes().targets;

  it("解析 SRT：BOM / 逗号毫秒 / 多行换行都能处理", () => {
    const cues = parseSrt("\uFEFF1\n00:00:01,000 --> 00:00:03,500\n第一行\n第二行\n\n2\n00:00:04.000 --> 00:00:07.000\nSnow peaks\n");
    expect(cues).toHaveLength(2);
    expect(cues[0]).toMatchObject({ start: "0:00:01.00", end: "0:00:03.50", text: "第一行\\N第二行" });
    expect(cues[1].start).toBe("0:00:04.00");
  });

  it("非法 SRT 显式失败（时间倒挂 / 缺时间轴 / 空文本），不静默丢条", () => {
    expect(() => parseSrt("1\n00:00:05,000 --> 00:00:02,000\n倒挂\n")).toThrow(/时间轴非法/);
    expect(() => parseSrt("1\n没有时间轴\n文本\n")).toThrow(/缺少时间轴/);
    expect(() => parseSrt("1\n00:00:01,000 --> 00:00:02,000\n\n")).toThrow();
    expect(() => parseSrt("")).toThrow(/没有可用字幕条/);
  });

  it("ASS 生成与回读闭环：样式字段顺序正确、事件可原样读回", () => {
    const style = {
      fontName: "LXGW WenKai", fontSize: 56, primaryColour: assColour("#FFFFFF"),
      outlineColour: assColour("#000000"), bold: false, outline: 3, shadow: 1, alignment: 2,
      marginL: 54, marginR: 54, marginV: 346,
    };
    expect(styleLine("Sub", style)).toMatch(/^Style: Sub,LXGW WenKai,56,&H00FFFFFF,/);
    const ass = buildAssDocument({
      resolution: [1080, 1920],
      styles: [{ name: "Sub", style }],
      events: [{ layer: 0, start: "0:00:01.00", end: "0:00:03.50", style: "Sub", name: "lxgw-wen-kai", text: "雪山倒映在草海的晨光里" }],
    });
    expect(ass).toContain("PlayResX: 1080");
    expect(ass).toContain("ScaledBorderAndShadow: yes");
    const events = parseAssEvents(ass);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ start: "0:00:01.00", end: "0:00:03.50", style: "Sub", text: "雪山倒映在草海的晨光里" });
  });

  it("目标值：一次渲染的字号/行宽/安全区都能被判定（不是只写在文档里）", () => {
    expect(targets.maxLinesSubtitle).toBe(2);
    // 18 个汉字正好在口径内；再多一个字就必须拆行
    expect(checkLineWidth("一二三四五六七八九十一二三四五六七八", targets).ok).toBe(true);
    expect(checkLineWidth("一二三四五六七八九十一二三四五六七八九", targets).ok).toBe(false);
  });
});

describe("渲染字体目录准备（防 libass 静默回落）", () => {
  it("29 款字体已随仓分发，且文件字节与档案 sha256 逐一致（A 级：真实文件哈希）", () => {
    const catalog = loadFontCatalog();
    const fontsDir = join(BUNDLE_DIR, "library/fonts");
    expect(existsSync(join(fontsDir, "LICENSES.md"))).toBe(true);
    let verified = 0;
    for (const font of catalog.fonts) {
      const file = join(fontsDir, font.file);
      expect(existsSync(file), `随包字体缺失：${font.file}`).toBe(true);
      const digest = createHash("sha256").update(readFileSync(file)).digest("hex");
      expect(digest, `${font.file} 与档案 sha256 不一致`).toBe(font.sha256);
      expect(statSync(file).size).toBe(font.bytes);
      verified += 1;
    }
    expect(verified).toBe(29);
  });

  it("字体目录默认解析到随包目录（无需工位安装即可渲染）", () => {
    const previous = process.env.WORKLOOM_SUBTITLE_FONTS_DIR;
    delete process.env.WORKLOOM_SUBTITLE_FONTS_DIR;
    try {
      expect(fontsRoot()).toBe(join(BUNDLE_DIR, "library/fonts"));
      const scan = scanFonts();
      expect(scan.installed).toBe(29);
      expect(scan.missing).toEqual([]);
    } finally {
      if (previous === undefined) delete process.env.WORKLOOM_SUBTITLE_FONTS_DIR;
      else process.env.WORKLOOM_SUBTITLE_FONTS_DIR = previous;
    }
  });

  it("把 cn/ en/ 摊平成单层目录，并把缺失字体如实列出", () => {
    const fontsDir = mkdtempSync(join(tmpdir(), "subtitle-flat-"));
    const workDir = mkdtempSync(join(tmpdir(), "subtitle-flat-work-"));
    try {
      const catalog = loadFontCatalog();
      mkdirSync(join(fontsDir, "cn"), { recursive: true });
      mkdirSync(join(fontsDir, "en"), { recursive: true });
      // 只放两款：一款中文、一款英文（其余按缺失记录）
      writeFileSync(join(fontsDir, "cn/LXGWWenKai-Regular.ttf"), "fake-font");
      writeFileSync(join(fontsDir, "en/Inter-Variable.ttf"), "fake-font");
      const flat = prepareFlatFontsDir({ fontsDir, catalog, workDir });
      expect(flat.linked).toBe(2);
      expect(flat.missing).toHaveLength(catalog.fonts.length - 2);
      const files = readdirSync(flat.flat);
      expect(files.sort()).toEqual(["Inter-Variable.ttf", "LXGWWenKai-Regular.ttf"]);
    } finally {
      rmSync(fontsDir, { recursive: true, force: true });
      rmSync(workDir, { recursive: true, force: true });
    }
  });
});

describe("弹幕 / 贴纸 / 卡拉OK（v1.1 二期）", () => {
  it("弹幕解析：数组与 JSONL 两种输入都支持，非法条目显式失败", () => {
    const fromArray = parseDanmaku([{ at: 1.2, text: "这也太好看了吧" }, { at: 2, text: "川西永远的神", mode: "top" }]);
    expect(fromArray).toHaveLength(2);
    expect(fromArray[0]).toMatchObject({ at: 1.2, text: "这也太好看了吧", mode: "scroll" });
    expect(fromArray[1].mode).toBe("top");
    const fromJsonl = parseDanmaku('{"at":3,"text":"求路线"}\n{"at":4,"text":"已收藏","mode":"bottom"}');
    expect(fromJsonl.map((item: { mode: string }) => item.mode)).toEqual(["scroll", "bottom"]);
    expect(() => parseDanmaku([])).toThrow(/为空/);
    expect(() => parseDanmaku([{ at: -1, text: "负时间" }])).toThrow(/at 非法/);
    expect(() => parseDanmaku([{ at: 1, text: "   " }])).toThrow(/文本为空/);
  });

  it("弹幕密度：1s 窗口并发超上限即判不达标，抽稀按窗口逐条裁并如实计数", () => {
    const dense = Array.from({ length: 12 }, (_, index) => ({ at: 10 + index * 0.02, text: `弹幕${index}`, mode: "scroll" }));
    const density = checkDanmakuDensity(dense, { windowSec: 1, maxConcurrent: 8 });
    expect(density.ok).toBe(false);
    expect(density.peakConcurrent).toBe(12);
    const { kept, dropped, trimmed } = trimDanmaku(dense, { windowSec: 1, maxConcurrent: 8 });
    expect(kept).toHaveLength(8);
    expect(dropped).toHaveLength(4);
    expect(trimmed).toBe(4);
    // 稀疏时不动刀
    expect(trimDanmaku([{ at: 0, text: "a" }, { at: 5, text: "b" }], { windowSec: 1, maxConcurrent: 8 }).trimmed).toBe(0);
  });

  it("弹幕轨道：滚动占顶部 1/4 轨道（round-robin）、顶部/底部固定各占行位，长弹幕走更久", () => {
    const items = [
      { at: 0.5, text: "短", mode: "scroll", colour: null, sizeScale: 1 },
      { at: 0.7, text: "一条比较长的滚动弹幕文本", mode: "scroll", colour: null, sizeScale: 1 },
      { at: 1, text: "顶部固定", mode: "top", colour: null, sizeScale: 1 },
      { at: 2, text: "底部固定", mode: "bottom", colour: null, sizeScale: 1 },
    ];
    const tracks = planDanmakuTracks(items, {
      resolution: [1080, 1920], layout: { 弹幕: { top_band_ratio: 0.25 }, 字幕: { bottom_margin_ratio: 0.18 } }, size: 47,
    });
    expect(tracks[0].y).toBeLessThan(1920 * 0.25);
    expect(tracks[1].y).toBeGreaterThan(tracks[0].y);
    expect(tracks[0].enterX).toBe(1080);
    expect(tracks[0].exitX).toBeLessThan(0);
    expect(tracks[1].durationSec).toBeGreaterThan(tracks[0].durationSec);
    expect(tracks[2].enterX).toBeNull();
    expect(tracks[3].y).toBeGreaterThan(1000);
  });

  it("卡拉OK 逐字时间轴：显式优先，缺失时按字数均分并如实标注；\\kf 时长与字数一致", () => {
    const explicit = parseTimedWords(
      [{ text: "雪", start: 1, end: 1.4 }, { text: "山", start: 1.4, end: 2.0 }],
      { text: "雪山", start: "0:00:01.00", end: "0:00:02.00" },
    );
    expect(explicit.basis).toBe("explicit");
    expect(explicit.sumErrorSec).toBeCloseTo(0, 3);
    // 显式时间轴与字幕条时长不匹配时如实报误差（不悄悄拉伸）
    const mismatched = parseTimedWords(
      [{ text: "雪", start: 1, end: 1.4 }, { text: "山", start: 1.4, end: 1.8 }],
      { text: "雪山", start: "0:00:01.00", end: "0:00:02.00" },
    );
    expect(mismatched.sumErrorSec).toBeCloseTo(-0.2, 3);
    const even = parseTimedWords(null, { text: "雪山倒映", start: "0:00:01.00", end: "0:00:03.00" });
    expect(even.basis).toContain("even-split");
    expect(even.words).toHaveLength(4);
    expect(even.sumErrorSec).toBe(0);
    const tags = karaokeAssText(even.words);
    expect(tags).toMatch(/^\{\\kf50\}雪\{\\kf50\}山\{\\kf50\}倒\{\\kf50\}映$/);
    expect(() => parseTimedWords(null, { text: "字", start: "0:00:01.00", end: "0:00:02.00", mode: "explicit" })).toThrow(/even/);
  });

  it("贴纸：五种预设齐备，200ms 弹入 + 旋转写进 ASS 文本", () => {
    const preset = stickerStylePreset("撞色");
    expect(preset.name).toBe("撞色");
    expect(Object.keys(stickerStylePreset("不存在")).length).toBeGreaterThan(0);
    expect(stickerStylePreset("不存在").name).toBe("撞色");
    const ass = stickerAssText({ text: "川西必去" }, { preset });
    expect(ass).toContain("\\t(0,200,");
    expect(ass).toContain("川西必去");
    for (const name of ["撞色", "奶油", "国风", "科技", "促销"]) {
      expect(stickerStylePreset(name).primaryColour).toMatch(/^#[0-9A-F]{6}$/i);
    }
  });

  it("ASS 文本转义：大括号与换行不会破坏 override 标签", () => {
    expect(escapeAssText("正常文本")).toBe("正常文本");
    expect(escapeAssText("{恶意}")).toBe("\\{恶意\\}");
    expect(escapeAssText("第一行\n第二行")).toBe("第一行\\N第二行");
  });
});

describe("许可判定", () => {
  it("白名单可商用；未登记许可按不合规处理（fail-closed）", () => {
    expect(licenseInfo("ofl-1.1").commercial).toBe(true);
    expect(licenseInfo("apache-2.0").commercial).toBe(true);
    expect(licenseInfo("vendor-free-commercial").commercial).toBe(true);
    expect(licenseInfo("vendor-free-commercial").requiresProofUrl).toBe(true);
    expect(licenseInfo("").commercial).toBeNull();
    expect(licenseInfo("方正兰亭黑").known).toBe(false);
    expect(licenseInfo("").note).toContain("fail-closed");
  });
});

describe("岗位 / 技能 / 管线 / 对象四层引用", () => {
  const preset = YAML.parse(readFileSync(join(BUNDLE_DIR, "presets/subtitle-stylist.yml"), "utf8")) as {
    preset_key: string; name: string; kind: string; readonly: boolean; night_shift: boolean;
    high_risk: boolean; fence_bindings: string[]; skills: string[];
    tools: Array<{ name: string; access: "read" | "write" }>;
    coverage: Array<{ eventPrefix: string }>; write_back: string[];
  };

  it("岗位卡：5 技能 / 12 工具 / 7 围栏 / 事件域 subtitle.", () => {
    expect(preset.preset_key).toBe("subtitle-stylist");
    expect(preset.name).toBe("字幕师");
    expect(preset.kind).toBe("operator");
    expect(preset.readonly).toBe(false);
    expect(preset.night_shift).toBe(true);
    expect(preset.high_risk).toBe(false);
    expect(preset.fence_bindings).toEqual(["G-SUB0", "G-SUB1", "G-SUB2", "G-SUB3", "G-SUB4", "G-SUB5", "G-SUB6"]);
    expect(preset.skills).toEqual([
      "font-selection", "subtitle-layout-design", "caption-burnin-ops", "font-license-compliance", "subtitle-delivery-spec",
    ]);
    expect(preset.tools.map((tool) => tool.name)).toEqual([...SUBTITLE_TOOLS]);
    expect(preset.tools.filter((tool) => tool.access === "write").map((tool) => tool.name)).toEqual([
      "subtitlewrite.plan", "subtitlewrite.burn", "subtitlewrite.title",
      "subtitlewrite.danmaku", "subtitlewrite.sticker", "subtitlewrite.karaoke",
      "subtitlewrite.sidecar", "subtitlewrite.softmux", "subtitlewrite.best",
    ]);
    expect(preset.write_back).toEqual([
      "subtitlewrite.burn", "subtitlewrite.title", "subtitlewrite.danmaku", "subtitlewrite.sticker", "subtitlewrite.karaoke",
      "subtitlewrite.sidecar", "subtitlewrite.softmux",
    ]);
    expect(preset.coverage.map((coverage) => coverage.eventPrefix)).toEqual(["subtitle."]);
  });

  it("事件前缀 subtitle. 在本包内未被其它岗位占用", () => {
    const clashes: string[] = [];
    for (const file of readPresetFiles(join(BUNDLE_DIR, "presets"))) {
      const doc = YAML.parse(readFileSync(file, "utf8")) as { preset_key?: string; coverage?: Array<{ eventPrefix?: string }> };
      if (doc.preset_key === "subtitle-stylist") continue;
      for (const coverage of doc.coverage ?? []) {
        if (coverage.eventPrefix === "subtitle.") clashes.push(String(doc.preset_key));
      }
    }
    expect(clashes).toEqual([]);
  });

  it("五个技能目录都有 SKILL.md，frontmatter name 与目录一致，且声明了 G-SUB 绑定", () => {
    for (const skill of preset.skills) {
      const file = join(BUNDLE_DIR, "skills", skill, "SKILL.md");
      expect(existsSync(file), `${skill} 缺 SKILL.md`).toBe(true);
      const raw = readFileSync(file, "utf8");
      const front = YAML.parse(/^---\n([\s\S]*?)\n---/.exec(raw)?.[1] ?? "{}") as { name?: string; description?: string };
      expect(front.name).toBe(skill);
      expect((front.description ?? "").length).toBeGreaterThan(40);
      expect(front.description ?? "").toMatch(/G-SUB/);
    }
  });

  it("技能围栏绑定表覆盖五个新技能，且绑定 id 都在围栏包里存在", () => {
    const bindings = readSkillBindings();
    const ruleIds = new Set(fencePack.rules.map((rule) => rule.rule_id));
    for (const skill of preset.skills) {
      const bound = bindings[skill];
      expect(bound, `${skill} 未登记围栏绑定`).toBeDefined();
      expect(bound.length).toBeGreaterThan(0);
      for (const ruleId of bound) expect(ruleIds.has(ruleId), `${skill} 绑定不存在的围栏 ${ruleId}`).toBe(true);
    }
    // 交付规范是"全量口径"，必须绑满七条
    expect(bindings["subtitle-delivery-spec"]).toEqual(["G-SUB0", "G-SUB1", "G-SUB2", "G-SUB3", "G-SUB4", "G-SUB5", "G-SUB6"]);
  });

  it("叙事片管线在调色之后、配乐之前插入字幕步，且 owner/产物齐备", () => {
    const pipeline = YAML.parse(readFileSync(join(BUNDLE_DIR, "pipelines/narrative-film.yml"), "utf8")) as {
      description: string;
      steps: Array<{ step_key: string; owner?: string; outputs?: string[] }>;
    };
    const keys = pipeline.steps.map((step) => step.step_key);
    const subtitle = pipeline.steps.find((step) => step.step_key === "subtitle")!;
    expect(subtitle).toBeDefined();
    expect(subtitle.owner).toBe("subtitle-stylist");
    expect(subtitle.outputs).toEqual(["subtitle_track", "subtitle_report", "final_video"]);
    expect(keys.indexOf("subtitle")).toBeGreaterThan(keys.indexOf("color"));
    expect(keys.indexOf("subtitle")).toBeLessThan(keys.indexOf("bgm"));
    expect(keys.indexOf("subtitle")).toBeLessThan(keys.indexOf("archive"));
    expect(pipeline.description).toContain("字幕");
  });

  it("对象类型 subtitle_track / subtitle_report 已登记（下游按对象类型挂事件与投影）", () => {
    const objects = JSON.parse(readFileSync(join(BUNDLE_DIR, "schemas/objects.json"), "utf8")) as {
      objects: Array<{ type: string; note?: string }>;
    };
    const types = objects.objects.map((entry) => entry.type);
    expect(types).toContain("subtitle_track");
    expect(types).toContain("subtitle_report");
    expect(objects.objects.find((entry) => entry.type === "subtitle_report")!.note).toContain("sha256");
    expect(objects.objects.find((entry) => entry.type === "subtitle_track")!.note).toContain("G-SUB5");
  });

  it("bundle.json 登记了岗位/围栏/技能/字体档案/配方/字幕工位连接器，且完整性索引覆盖它们", () => {
    const bundle = JSON.parse(readFileSync(join(BUNDLE_DIR, "bundle.json"), "utf8")) as {
      workloom: { provides: Record<string, string[] | string> };
      integrity: { assets: Record<string, string> };
    };
    const provides = bundle.workloom.provides as Record<string, string[]>;
    expect(provides.presets).toContain("presets/subtitle-stylist.yml");
    expect(provides.fences).toContain("fences/ai-video-subtitle.yml");
    expect(provides.skills).toContain("skills/font-selection/SKILL.md");
    expect(provides.library).toContain("library/font-catalog/font_db.json");
    expect(provides.library).toContain("library/font-catalog/LICENSES.md");
    expect(provides.library).toContain("library/typography-recipes/recipes.json");
    expect(provides.connectors).toContain("connectors/subtitle-bridge/core.mjs");
    expect(provides.connectors).toContain("connectors/subtitle-bridge/measure.mjs");
    expect(provides.connectors).toContain("connectors/subtitle-bridge/kit/fonts-pin.json");
    expect(provides.connectors).toContain("connectors/subtitle-bridge/kit/install-fonts.sh");
    for (const asset of [...provides.connectors, ...provides.library.filter((item) => item.includes("font-catalog") || item.includes("typography-recipes"))]) {
      const sha = bundle.integrity.assets[asset];
      expect(sha, `${asset} 未进完整性索引`).toMatch(/^[a-f0-9]{64}$/);
      expect(existsSync(join(BUNDLE_DIR, asset)), `${asset} 在磁盘不存在`).toBe(true);
    }
  });

  it("字幕连接器不依赖仓库外代码（工位自包含：只用 node 内置模块 + 相对导入）", () => {
    for (const file of ["core.mjs", "measure.mjs", "server.mjs", "cli.mjs"]) {
      const source = readFileSync(join(BRIDGE_DIR, file), "utf8");
      const imports = [...source.matchAll(/from\s+"([^"]+)"/g)].map((match) => match[1]!);
      for (const specifier of imports) {
        expect(
          specifier.startsWith("node:") || specifier.startsWith("./") || specifier.startsWith("../"),
          `${file} 引入了非自包含依赖：${specifier}`,
        ).toBe(true);
      }
    }
  });
});

describe("字体引脚（fonts-pin）与档案一致", () => {
  const catalog = loadFontCatalog();
  const pin = JSON.parse(readFileSync(join(BRIDGE_DIR, "kit/fonts-pin.json"), "utf8")) as {
    schemaVersion: string;
    licenseWhitelist: string[];
    install: { discipline: string; bundledDir: string; externalDir: string };
    fonts: Array<{
      id: string; name: string; file: string; sha256: string; bytes: number; license: string;
      upstream: { url: string | null; verifiedAt: string | null; verifiedSha256?: string; zipMember?: string | null };
    }>;
  };

  it("档案与引脚逐文件一一对应，sha256 完全一致（字体随仓分发 + 引脚可审计）", () => {
    expect(pin.schemaVersion).toBe("workloom.workstation-pin/v1");
    expect(pin.fonts).toHaveLength(catalog.fonts.length);
    const byFile = new Map(pin.fonts.map((font) => [font.file, font]));
    expect(byFile.size).toBe(pin.fonts.length);
    for (const font of catalog.fonts) {
      const entry = byFile.get(font.file);
      expect(entry, `${font.file} 未登记引脚`).toBeDefined();
      expect(entry!.sha256).toBe(font.sha256);
      expect(entry!.bytes).toBe(font.bytes);
      expect(entry!.id).toBe(font.id);
      expect(pin.licenseWhitelist).toContain(entry!.license);
    }
    // 字体二进制随仓分发（library/fonts），引脚登记上游地址与逐文件摘要供升级比对
    expect(existsSync(join(BUNDLE_DIR, "library/fonts/cn"))).toBe(true);
    expect(existsSync(join(BUNDLE_DIR, "library/fonts/en"))).toBe(true);
  });

  it("上游直链要么核验过（sha256 对得上），要么显式标未核验并给出来源说明", () => {
    for (const font of pin.fonts) {
      if (font.upstream.verifiedAt) {
        expect(font.upstream.url).toMatch(/^https:\/\//);
        expect(font.upstream.verifiedSha256).toBe(font.sha256);
      } else {
        // 未核验的上游直链只用于升级比对；随包字体本身已由 sha256 三重校验
        expect(font.upstream.note ?? "").toContain("升级");
      }
    }
    expect(pin.install.discipline).toContain("sha256");
    expect(pin.install.bundledDir).toContain("library/fonts");
    expect(pin.install.externalDir).toContain("WORKLOOM_SUBTITLE_FONTS_DIR");
  });
});

function readPresetFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".yml"))
    .map((entry) => join(dir, entry.name));
}

/** 从 scripts/skill-bindings.mts 里读出 ai-video 的技能→围栏绑定（唯一事实源）。 */
function readSkillBindings(): Record<string, string[]> {
  const source = readFileSync(join(REPO_ROOT, "scripts/skill-bindings.mts"), "utf8");
  const block = /"ai-video":\s*\{([\s\S]*?)\n  \},/.exec(source)?.[1] ?? "";
  const bindings: Record<string, string[]> = {};
  for (const match of block.matchAll(/"([\w-]+)":\s*\[([^\]]*)\]/g)) {
    bindings[match[1]!] = match[2]!.split(",").map((item) => item.trim().replace(/^"|"$/g, "")).filter(Boolean);
  }
  return bindings;
}
