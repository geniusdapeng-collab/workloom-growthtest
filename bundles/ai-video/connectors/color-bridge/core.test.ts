/**
 * 调色内核单测：纯函数（滤镜链/路径监狱/自动校正）+ 真实 ffmpeg 端到端（有 ffmpeg 才跑）。
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  COLOR_TOOLS, ColorError, SCOPE_KINDS, allowedRoots, analyze, assertPathAllowed, autoCorrections,
  BANDING_THRESHOLDS, BLUR_THRESHOLDS, bandingFromYuv, best, buildChain,
  detectBanding, detectDefects, detectSkinRegion, estimateNoise, findRecipes,
  frameDifference, frameQuality, grade,
  HIST_RESIDUAL_THRESHOLD, histChiSquare, histResidual, histogramFromYuv,
  loadRecipes, match, NOISE_DIFF_YAVG_HIT, probeMedia,
  planSampling, PROFILES, renderScopes, resolveBinaries, resolveConversionLuts, resolveSourceColor,
  sceneSampleTimes, sceneSegments, scoreQuality, standardHueFromUv, summarize, yuvHistogram,
} from "./core.mjs";

const bins = resolveBinaries();
const hasFfmpeg = (() => {
  try {
    execFileSync(bins.ffmpeg, ["-hide_banner", "-version"], { stdio: "ignore" });
    execFileSync(bins.ffprobe, ["-hide_banner", "-version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
})();

const hasX264 = hasFfmpeg && (() => {
  try {
    return execFileSync(bins.ffmpeg, ["-hide_banner", "-encoders"]).toString().includes("libx264");
  } catch {
    return false;
  }
})();

describe("直方图残差与可选降噪（T-24，纯函数）", () => {
  const makeYuv = (yFn: (x: number, y: number) => number, w = 160, h = 120) => {
    const buf = Buffer.alloc(w * h * 1.5);
    for (let yy = 0; yy < h; yy += 1) {
      for (let x = 0; x < w; x += 1) buf[yy * w + x] = yFn(x, yy);
    }
    buf.fill(128, w * h); // U/V 中性
    return buf;
  };

  it("histogramFromYuv / histChiSquare：同分布=0，同均值异分布超阈值，小曝光差不超", () => {
    const grad = histogramFromYuv(makeYuv((x) => 60 + Math.round((100 * x) / 160)), 160);
    const bimodal = histogramFromYuv(makeYuv((x) => (x < 80 ? 60 : 160)), 160);
    expect(grad.Y).toHaveLength(64);
    expect(histChiSquare(grad.Y, grad.Y)).toBe(0);
    // 均值相同（60..160 渐变 vs 60/160 双峰，均值均 ≈110）但分布迥异 → 必须识别
    const mismatch = histResidual(bimodal, grad);
    expect(mismatch.weighted).toBeGreaterThan(HIST_RESIDUAL_THRESHOLD);
    // 权重纪律：Y 通道贡献 0.6（色度中性时 weighted = 0.6 × chi2Y）
    expect(mismatch.weighted).toBeCloseTo(0.6 * mismatch.chi2.Y, 6);
    // 正常小曝光差（-10 级，均值判据本就兜得住的场景）不得误报
    const darker = histogramFromYuv(makeYuv((x) => 50 + Math.round((100 * x) / 160)), 160);
    expect(histResidual(darker, grad).weighted).toBeLessThan(HIST_RESIDUAL_THRESHOLD);
  });

  it("降噪默认关闭：不传 denoise 时滤镜链不含 hqdn3d", () => {
    const chain = buildChain({ corrections: { eq: { brightness: 0.05 } }, profile: "natural", intensity: 1 });
    expect(chain).not.toContain("hqdn3d");
  });

  it("显式开启降噪：hqdn3d 位于 conversion 之后、校正之前，luma_spatial 保守 ≤2.0", () => {
    const chain = buildChain({
      conversionLuts: ["/tmp/conv.cube"],
      denoise: { lumaSpatial: 1.5 },
      corrections: { eq: { brightness: 0.05 } },
      profile: "natural",
      intensity: 1,
    });
    const convAt = chain.indexOf("lut3d='/tmp/conv.cube'");
    const dnAt = chain.indexOf("hqdn3d=luma_spatial=1.5");
    const eqAt = chain.indexOf("eq=brightness=0.05");
    expect(dnAt).toBeGreaterThan(convAt);
    expect(eqAt).toBeGreaterThan(dnAt);
    // 超上限被钳制到 2.0
    const clamped = buildChain({ denoise: { lumaSpatial: 9 }, corrections: { eq: { brightness: 0.01 } }, intensity: 1 });
    expect(clamped).toContain("hqdn3d=luma_spatial=2");
    // 强度混合场景：降噪在 split 之前（恒 100% 生效，不进 look 混合）
    const mixed = buildChain({ denoise: { lumaSpatial: 1.5 }, profile: "natural", intensity: 0.8 });
    expect(mixed.indexOf("hqdn3d=luma_spatial=1.5")).toBeLessThan(mixed.indexOf("split=2"));
  });
});

describe("工具面与滤镜链（纯函数）", () => {
  it("工具面固定为 8 个（含配方库检索与择优调色），scope 三种", () => {
    expect(COLOR_TOOLS).toHaveLength(8);
    expect(COLOR_TOOLS).toContain("colorread.recipes");
    expect(COLOR_TOOLS).toContain("colorwrite.best");
    expect(SCOPE_KINDS).toEqual(["waveform", "vectorscope", "histogram"]);
  });

  it("滤镜链顺序：校正 → profile → LUT 最后", () => {
    const chain = buildChain({
      corrections: { normalize: true, colorTemperature: 5600, eq: { brightness: 0.02 } },
      profile: "warm-film",
      lutPath: "/tmp/look.cube",
      intensity: 1,
    });
    const normalizeAt = chain.indexOf("normalize=");
    const tempAt = chain.indexOf("colortemperature=");
    const eqAt = chain.indexOf("eq=");
    const profileAt = chain.indexOf("curves=all=");
    const lutAt = chain.indexOf("lut3d=");
    expect(normalizeAt).toBeGreaterThanOrEqual(0);
    expect(tempAt).toBeGreaterThan(normalizeAt);
    expect(eqAt).toBeGreaterThan(tempAt);
    expect(profileAt).toBeGreaterThan(eqAt);
    expect(lutAt).toBeGreaterThan(profileAt);
    expect(chain.endsWith("lut3d='/tmp/look.cube'")).toBe(true);
  });

  it("强度 <1 时用 split/blend 混合，且不出现二阶滤镜", () => {
    const chain = buildChain({ profile: "natural", intensity: 0.8 });
    expect(chain).toContain("split=2[__orig][__tograde]");
    // 顺序必须是 [已调色][原片]，opacity 才等价于"look 强度"（写反=强度失效）
    expect(chain).toContain("[__graded][__orig]blend=all_mode=normal:all_opacity=0.8");
  });

  it("校正恒为 100%：只做校正时根本不该出现混合（避免欠曝只修 80%）", () => {
    const chain = buildChain({ corrections: { normalize: true, eq: { brightness: 0.08 } }, intensity: 0.5 });
    expect(chain).not.toContain("split=2");
    expect(chain).not.toContain("blend=");
    expect(chain).toContain("normalize=");
    expect(chain).toContain("eq=brightness=0.08");
  });

  it("校正 + look：校正在混合之外（先校正，再按强度叠 look）", () => {
    const chain = buildChain({ corrections: { eq: { brightness: 0.08 } }, profile: "teal-orange", intensity: 0.8 });
    const eqAt = chain.indexOf("eq=brightness=0.08");
    const splitAt = chain.indexOf("split=2");
    expect(eqAt).toBeGreaterThanOrEqual(0);
    expect(splitAt).toBeGreaterThan(eqAt);
    expect(chain).toContain("[__graded][__orig]blend=all_mode=normal:all_opacity=0.8");
  });

  it("内置 look 的量级足够（满档参数必须真的能推得动画面）", () => {
    // 回归防线：早期版本 colorbalance 只有 ±0.04，成品像素差 ≈1.5%，用户看不出变化
    expect(PROFILES["teal-orange"]).toMatch(/rs=-0\.1[5-9]/);
    expect(PROFILES["teal-orange"]).toMatch(/bs=0\.2/);
    expect(PROFILES["warm-film"]).toMatch(/rs=0\.1/);
    expect(PROFILES["moody-dark"]).toMatch(/saturation=0\.7/);
  });

  it("非法 profile / 非法强度 / 空指令被拒绝", () => {
    expect(() => buildChain({ profile: "nope" })).toThrow(/未知 profile/);
    expect(() => buildChain({ profile: "natural", intensity: 0 })).toThrow(/intensity/);
    expect(() => buildChain({ intensity: 1 })).toThrow(/未指定任何/);
  });

  it("自动校正：欠曝补 gamma/brightness、低饱和补饱和，且幅度受限", () => {
    const dark = autoCorrections({ YAVG: 55, SATAVG: 20, UAVG: 128, VAVG: 128 });
    expect(dark.eq.gamma).toBeGreaterThan(1);
    expect(dark.eq.brightness).toBeGreaterThan(0);
    expect(dark.eq.saturation).toBeGreaterThan(1);
    expect(dark.eq.brightness).toBeLessThanOrEqual(0.12);
    expect(dark.eq.saturation).toBeLessThanOrEqual(1.25);
    const bright = autoCorrections({ YAVG: 170, SATAVG: 95, UAVG: 128, VAVG: 128 });
    expect(bright.eq.brightness).toBeLessThan(0);
    expect(bright.eq.saturation).toBeLessThan(1);
    const neutral = autoCorrections({ YAVG: 110, SATAVG: 55, UAVG: 128, VAVG: 128 });
    expect(neutral).toEqual({});
  });

  it("summarize 对空输入返回 null 而不是 NaN 假值", () => {
    expect(summarize([]).YAVG).toBeNull();
    expect(summarize([{ YAVG: 100 }, { YAVG: 120 }]).YAVG).toBe(110);
  });
});

describe("conversion 级：S-Log3 / S-Gamut3.Cine 转换 LUT 链（T-21）", () => {
  it("resolveSourceColor：调用方参数优先，元数据仅在明确写出 slog3/sgamut3cine 时采信", () => {
    expect(resolveSourceColor({ sourceTransfer: "slog3", sourceGamut: "sgamut3cine" }))
      .toEqual({ transfer: "slog3", gamut: "sgamut3cine" });
    expect(resolveSourceColor({ probe: { video: { colorTransfer: "s-log3", colorPrimaries: "sgamut3.cine" } } }))
      .toEqual({ transfer: "slog3", gamut: "sgamut3cine" });
    // 元数据无标准标签时不猜（unspecified / bt709 / bt2020 均不触发）
    expect(resolveSourceColor({ probe: { video: { colorTransfer: "unspecified", colorPrimaries: "unspecified" } } }))
      .toEqual({ transfer: null, gamut: null });
    expect(resolveSourceColor({ probe: { video: { colorTransfer: "bt709", colorPrimaries: "bt2020" } } }))
      .toEqual({ transfer: null, gamut: null });
    // 参数压过元数据
    expect(resolveSourceColor({
      probe: { video: { colorTransfer: "s-log3", colorPrimaries: "bt709" } },
      sourceGamut: "sgamut3cine",
    })).toEqual({ transfer: "slog3", gamut: "sgamut3cine" });
  });

  it("resolveConversionLuts：S-Log3+S-Gamut3.Cine 挂双 LUT 且顺序正确；色域不确定时仅 OETF 并带缺口注明", () => {
    const both = resolveConversionLuts({ transfer: "slog3", gamut: "sgamut3cine" });
    expect(both.luts.map((p) => path.basename(p))).toEqual(["slog3-to-rec709.cube", "sgamut3cine-to-rec709.cube"]);
    expect(both.note).toBeNull();
    for (const lut of both.luts) expect(fs.existsSync(lut), `转换 LUT 应在盘：${lut}`).toBe(true);

    const oetfOnly = resolveConversionLuts({ transfer: "slog3", gamut: null });
    expect(oetfOnly.luts.map((p) => path.basename(p))).toEqual(["slog3-to-rec709.cube"]);
    expect(oetfOnly.note).toContain("S-Gamut3.Cine");

    expect(resolveConversionLuts({ transfer: null, gamut: null }).luts).toEqual([]);
    expect(resolveConversionLuts({ transfer: "clog3", gamut: null }).luts).toEqual([]);
  });

  it("buildChain：conversion LUT 恒 100% 置于最前，不进 split/blend 强度混合", () => {
    const dir = path.join(os.tmpdir(), "conv-luts");
    const a = path.join(dir, "slog3-to-rec709.cube");
    const b = path.join(dir, "sgamut3cine-to-rec709.cube");
    // 无 look：conversion 单独成链
    const convOnly = buildChain({ conversionLuts: [a, b], intensity: 1 });
    expect(convOnly).toBe(`lut3d='${a}',lut3d='${b}'`);
    expect(convOnly).not.toContain("split=2");
    // conversion + 校正 + look(intensity<1)：conversion/校正在混合之外且 conversion 最前
    const full = buildChain({ conversionLuts: [a, b], corrections: { eq: { brightness: 0.05 } }, profile: "natural", intensity: 0.8 });
    const convAt = full.indexOf(`lut3d='${a}'`);
    const gamutAt = full.indexOf(`lut3d='${b}'`);
    const eqAt = full.indexOf("eq=brightness=0.05");
    const splitAt = full.indexOf("split=2");
    expect(convAt).toBe(0);
    expect(gamutAt).toBeGreaterThan(convAt);
    expect(eqAt).toBeGreaterThan(gamutAt);
    expect(splitAt).toBeGreaterThan(eqAt);
    expect(full).toContain("[__graded][__orig]blend=all_mode=normal:all_opacity=0.8");
    // 空指令仍被拒绝
    expect(() => buildChain({ intensity: 1 })).toThrow(/未指定任何/);
  });
});

describe("路径监狱", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "colorjail-"));
  const inside = path.join(root, "a.mp4");
  fs.writeFileSync(inside, "x");

  it("放行白名单内路径，拒绝越界路径", () => {
    expect(assertPathAllowed(inside, [root], "input")).toBe(fs.realpathSync(inside));
    expect(() => assertPathAllowed("/etc/hosts", [root], "input")).toThrow(ColorError);
    expect(() => assertPathAllowed("/etc/hosts", [root], "input")).toThrow(/路径监狱/);
  });

  it("软链逃逸被拦（真实路径判定）", () => {
    const link = path.join(root, "escape");
    try {
      fs.symlinkSync("/etc", link);
    } catch {
      return; // 无权限建软链则跳过
    }
    expect(() => assertPathAllowed(path.join(link, "hosts"), [root], "input")).toThrow(/路径监狱/);
  });

  it("默认根目录只有工作目录与临时目录", () => {
    const roots = allowedRoots({});
    expect(roots).toContain(fs.realpathSync(os.tmpdir()));
    expect(allowedRoots({ WORKLOOM_COLOR_ALLOWED_ROOTS: root })).toEqual([fs.realpathSync(root)]);
  });
});

describe("画质度量与打分（纯函数）", () => {
  const flatFrame = (() => {
    const buf = Buffer.alloc(32 * 32 * 3);
    for (let i = 0; i < buf.length; i += 3) { buf[i] = 120; buf[i + 1] = 120; buf[i + 2] = 120; }
    return buf;
  })();
  const richFrame = (() => {
    const buf = Buffer.alloc(32 * 32 * 3);
    for (let p = 0; p < 32 * 32; p += 1) {
      const i = p * 3;
      buf[i] = p % 2 ? 240 : 12;
      buf[i + 1] = p % 3 ? 40 : 200;
      buf[i + 2] = p % 5 ? 30 : 210;
    }
    return buf;
  })();

  it("对比度/饱和/裁切指标方向正确", () => {
    const flat = frameQuality(flatFrame, 32, 32);
    const rich = frameQuality(richFrame, 32, 32);
    expect(flat.rmsContrast).toBeLessThan(rich.rmsContrast);
    expect(flat.satMean).toBeLessThan(rich.satMean);
    expect(flat.yavg).toBeCloseTo(120, 0);
    // 全黑帧应被识别为暗部裁切
    const black = frameQuality(Buffer.alloc(32 * 32 * 3), 32, 32);
    expect(black.shadowClipPct).toBeGreaterThan(99);
  });

  it("打分对「拉亮+加饱和+裁切」这类劣化敏感（回归：2026-09-21 事故的真实数值）", () => {
    // 真实实测：原片 yavg 104.1 / satMean 0.286 / rmsContrast 38.9 / 高光裁切 0%
    // 劣化交付：yavg 137.7（+33.6）/ satMean 0.419（+46%）/ 高光裁切 1.6%
    const src = { yavg: 104.1, rmsContrast: 38.9, tonalRange: 124, satMean: 0.286, oversatPct: 0, colorfulness: 38.5, sharpness: 12, shadowClipPct: 0, highlightClipPct: 0 };
    const degraded = { ...src, yavg: 137.7, satMean: 0.419, colorfulness: 53.9, highlightClipPct: 1.6, rmsContrast: 38.84 };
    const scored = scoreQuality(degraded, src);
    expect(scored.score).toBeLessThan(90);              // 明显低于原片（100），择优时必输
    expect(scored.reasons.brokeHealthyExposure).toBe(true);
    expect(scored.reasons.clipDeltaPct).toBeCloseTo(1.6, 1);
    const healthy = { ...src, yavg: 110 };
    const brokeExposure = { ...healthy, yavg: 160 };
    expect(scoreQuality(brokeExposure, healthy).reasons.brokeHealthyExposure).toBe(true);
  });

  it("打分对「把偏灰素材拉回健康区间」给正分（这才是该调的场景）", () => {
    const src = { yavg: 96, rmsContrast: 18, tonalRange: 90, satMean: 0.17, oversatPct: 0, colorfulness: 22, sharpness: 8, shadowClipPct: 0, highlightClipPct: 0 };
    const better = { ...src, rmsContrast: 26, satMean: 0.28, sharpness: 8.8, yavg: 93 };
    expect(scoreQuality(better, src).score).toBeGreaterThan(100);
  });
});

describe("配方库与平台微调（T-14）", () => {
  const REQUIRED_FIELDS = ["id", "genre", "scene", "mood", "profile", "intensity", "overrides", "platforms", "avoid", "notes"];
  const TARGET_KEYS = new Set(["YMIN", "YAVG", "YMAX", "UAVG", "VAVG", "SATAVG", "skinHue"]);

  it("recipes.json 加载后配方总数 ≥25，且每条字段完整、profile 真实存在", () => {
    const doc = loadRecipes();
    expect(doc.recipes.length).toBeGreaterThanOrEqual(25);
    const ids = new Set();
    for (const r of doc.recipes) {
      for (const field of REQUIRED_FIELDS) {
        expect(r[field], `${r.id} 缺字段 ${field}`).toBeDefined();
      }
      expect(r.id).toMatch(/^[a-z0-9-]+$/);
      expect(ids.has(r.id), `配方 id 重复：${r.id}`).toBe(false);
      ids.add(r.id);
      expect(PROFILES[r.profile], `${r.id} 的 profile ${r.profile} 不存在于 PROFILES`).toBeDefined();
      expect(r.intensity).toBeGreaterThan(0);
      expect(r.intensity).toBeLessThanOrEqual(1);
      expect(r.avoid.length).toBeGreaterThanOrEqual(2);
      expect(typeof r.notes).toBe("string");
      expect(r.notes.length).toBeGreaterThan(10);
    }
    // T-14 新增 12 条全部在库，且 intensity 落在 0.5–0.9
    const t14 = ["wedding-day", "sports-event", "gaming-esports", "fashion-editorial", "baby-family",
      "real-estate-showroom", "automotive-night", "finance-corporate", "city-night-neon",
      "rain-mood", "retro-film", "festival-sale"];
    for (const id of t14) {
      const r = doc.recipes.find((x) => x.id === id);
      expect(r, `T-14 配方缺失：${id}`).toBeDefined();
      expect(r.intensity).toBeGreaterThanOrEqual(0.5);
      expect(r.intensity).toBeLessThanOrEqual(0.9);
    }
    // ≥3 条新配方携带 overrides.platformOverrides，且键名属于 platforms、值为 targets 键子集
    const withPlatformOverrides = doc.recipes.filter((r) => r.overrides?.platformOverrides);
    expect(withPlatformOverrides.length).toBeGreaterThanOrEqual(3);
    for (const r of withPlatformOverrides) {
      for (const [platformName, patch] of Object.entries(r.overrides.platformOverrides)) {
        expect(r.platforms, `${r.id} 的 platformOverrides 键 ${platformName} 不在 platforms 中`).toContain(platformName);
        for (const key of Object.keys(patch)) {
          expect(TARGET_KEYS.has(key), `${r.id} 的 platformOverrides.${platformName} 含非 targets 键 ${key}`).toBe(true);
        }
      }
    }
  });

  it("带平台上下文时 platformOverrides 生效（优先级高于配方级 overrides）", () => {
    const base = findRecipes({ recipeId: "wedding-day" });
    expect(base.recipe.platformOverrideApplied).toBeNull();
    expect(base.recipe.targets.SATAVG).toEqual([40, 62]);       // 配方级 overrides
    expect(base.recipe.targets.platformOverrides).toBeUndefined(); // 嵌套键不得混入 targets

    const tuned = findRecipes({ recipeId: "wedding-day", platform: "抖音" });
    expect(tuned.recipe.platformOverrideApplied).toBe("抖音");
    expect(tuned.recipe.targets.SATAVG).toEqual([45, 68]);       // 平台微调覆盖配方级
    expect(tuned.recipe.targets.YAVG).toEqual([100, 145]);       // 未微调键仍取配方级
    expect(tuned.recipe.targets.YMAX).toEqual([235, 255]);       // 全局 targets 兜底

    // 平台命中但配方无该平台微调 → 回落配方级（sports-event 只配了抖音）
    const fallback = findRecipes({ recipeId: "sports-event", platform: "B站" });
    expect(fallback.recipe.platformOverrideApplied).toBeNull();
    expect(fallback.recipe.targets.SATAVG).toEqual([50, 85]);
  });

  it("不带平台时行为与旧版一致（targets = 全局 + 配方级 overrides）", () => {
    const doc = loadRecipes();
    for (const id of ["product-hero", "documentary-natural", "festival-sale"]) {
      const raw = doc.recipes.find((r) => r.id === id);
      const { platformOverrides, ...recipeOverrides } = raw.overrides ?? {};
      const found = findRecipes({ recipeId: id });
      expect(found.recipe.platformOverrideApplied).toBeNull();
      expect(found.recipe.targets).toEqual({ ...doc.targets, ...recipeOverrides });
    }
  });
});

describe.runIf(hasFfmpeg)("真实 ffmpeg 端到端", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "colore2e-"));
  const source = path.join(dir, "src.mp4");
  const gradedOut = path.join(dir, "graded.mp4");

  beforeAll(() => {
    // 合成一段偏暗、低饱和的测试片段（sine 渐变 + 彩条），用于验证校正可见
    execFileSync(bins.ffmpeg, [
      "-hide_banner", "-v", "error", "-y",
      "-f", "lavfi", "-i", "testsrc2=size=320x240:rate=15:duration=3",
      "-vf", "eq=brightness=-0.12:saturation=0.6",
      "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", source,
    ]);
  }, 60_000);

  afterAll(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("probe 读得到真实规格", async () => {
    const probe = await probeMedia(source, { bins });
    expect(probe.video.width).toBe(320);
    expect(probe.video.height).toBe(240);
    expect(probe.duration).toBeGreaterThan(2);
  }, 60_000);

  it("grade 出片并给出前后指标与哈希；覆盖原片被拒", async () => {
    const result = await grade({
      input: source,
      output: gradedOut,
      profile: "clean-bright",
      intensity: 0.8,
      auto: true,
      bins,
    });
    expect(fs.existsSync(gradedOut)).toBe(true);
    expect(result.sha256).toHaveLength(64);
    expect(result.after.YAVG).toBeGreaterThan(result.before.YAVG);
    expect(result.chain).toContain("eq=");
    // 可见性：这是"调了跟没调一样"事故的回归防线
    expect(result.visibility.verdict).not.toBe("negligible");
    expect(result.visibility.meanAbsDiff).toBeGreaterThanOrEqual(2);
    await expect(grade({ input: source, output: source, bins })).rejects.toThrow(/禁止覆盖原片/);
  }, 120_000);

  it("look 参数可辨：teal-orange 满档必须产生肉眼可见差异（visible）", async () => {
    const out = path.join(dir, "graded-teal.mp4");
    const result = await grade({ input: source, output: out, profile: "teal-orange", intensity: 1, bins });
    expect(result.visibility.verdict).toBe("visible");
    expect(result.visibility.meanAbsDiff).toBeGreaterThanOrEqual(4);
    const diff = await frameDifference({ before: source, after: out, at: [1], bins });
    expect(diff.frames[0]?.pctOver5).toBeGreaterThan(20);
  }, 120_000);

  it("强度必须单调生效：0.25 的改动量显著小于 1.0（回归：曾因混合顺序写反而失效）", async () => {
    const weak = path.join(dir, "graded-i025.mp4");
    const full = path.join(dir, "graded-i100.mp4");
    const a = await grade({ input: source, output: weak, profile: "teal-orange", intensity: 0.25, bins });
    const b = await grade({ input: source, output: full, profile: "teal-orange", intensity: 1, bins });
    expect(a.visibility.meanAbsDiff).toBeLessThan(b.visibility.meanAbsDiff * 0.6);
    expect(a.visibility.meanAbsDiff).toBeLessThan(6);
  }, 180_000);

  it("看不出变化就拒绝交付（verify_failed，且不留产物）", async () => {
    const out = path.join(dir, "graded-invisible.mp4");
    await expect(grade({ input: source, output: out, profile: "natural", intensity: 0.02, bins }))
      .rejects.toThrow(/未产生可见变化/);
    expect(fs.existsSync(out)).toBe(false);
  }, 120_000);

  it("scope 渲染三种图并各自带哈希", async () => {
    const outputs = await renderScopes({ input: source, at: 1, outDir: path.join(dir, "scopes"), bins });
    expect(outputs.map((o) => o.kind)).toEqual(["waveform", "vectorscope", "histogram"]);
    for (const o of outputs) {
      expect(fs.existsSync(o.path)).toBe(true);
      expect(o.sha256).toHaveLength(64);
    }
  }, 120_000);

  it("LUT 非法/缺失被拒（bad_lut）", async () => {
    await expect(grade({ input: source, output: path.join(dir, "x.mp4"), lutPath: "/tmp/missing.cube", bins }))
      .rejects.toThrow(/LUT 不存在/);
  }, 60_000);

  it("择优：健康素材判「无需调色」且不产出文件（do no harm）", async () => {
    const out = path.join(dir, "best-none.mp4");
    const result = await best({
      input: source, output: out, sampleAt: [1],
      candidates: [{ id: "moody-dark@1", label: "moody-dark", spec: { profile: "moody-dark", intensity: 1 } }],
      bins,
    });
    expect(result.verdict).toBe("no_change_needed");
    expect(result.candidates.length).toBeGreaterThanOrEqual(2);
    expect(fs.existsSync(out)).toBe(false);
  }, 180_000);

  it("择优：扁平素材会选出「提升对比度」的候选并出片（且不是靠拉饱和骗分）", async () => {
    const flat = path.join(dir, "flat.mp4");
    execFileSync(bins.ffmpeg, [
      "-hide_banner", "-v", "error", "-y",
      // 低对比、无彩的灰阶渐变：模拟"未调色的相机原片"
      // 静态低对比夹具（luma 72→80、无彩）：确定性输出，任何对比度提升都明显胜出
      "-f", "lavfi", "-i", "color=c=0x505050:size=320x240:duration=3:rate=15",
      "-vf", "geq=lum='72+8*X/W':cb=128:cr=128",
      "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", flat,
    ]);
    const out = path.join(dir, "flat-best.mp4");
    const result = await best({
      input: flat, output: out, sampleAt: [1],
      candidates: [
        { id: "natural@1", label: "natural", spec: { profile: "natural", intensity: 1 } },
        { id: "high-contrast-social@0.5", label: "high-contrast", spec: { profile: "high-contrast-social", intensity: 0.5 } },
        { id: "clean-bright@0.5", label: "clean-bright", spec: { profile: "clean-bright", intensity: 0.5 } },
      ],
      bins,
    });
    expect(result.verdict).toBe("graded");
    expect(fs.existsSync(out)).toBe(true);
    expect(result.finalScore.score).toBeGreaterThan(100);
    expect((result.finalScore.reasons.contrastRatio as number)).toBeGreaterThanOrEqual(1);
    expect((result.finalScore.reasons.clipDeltaPct as number)).toBeLessThanOrEqual(0.5);
  }, 240_000);

  it("配方驱动：给出题材后候选池包含该配方的强度梯度与 LUT，并在结果里回报所用配方", async () => {
    const out = path.join(dir, "recipe-best.mp4");
    const result = await best({
      input: source, output: out, sampleAt: [1], genre: "美食",
      candidates: [{ id: "natural@0.5", label: "natural", spec: { profile: "natural", intensity: 0.5 } }],
      bins,
    });
    const ids = result.candidates.map((c) => c.id);
    expect(result.recipe).toBe("food-appetite");
    expect(ids).toContain("recipe:food-appetite@0.65");
    expect(ids).toContain("recipe-lut:food-appetite");
    expect(result.recipeContext?.genre).toContain("美食");
  }, 180_000);
});

/**
 * T-24 解码级标定：夹具用 mpeg4 编码（沙箱可用），只读像素不渲染成片，
 * 因此无需 libx264 即可验证直方图残差与噪点代理的阈值口径。
 */
describe.runIf(hasFfmpeg)("直方图残差与噪点代理（解码级标定）", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "colort24-cal-"));
  const p = (name: string) => path.join(dir, name);
  const files = {
    grad: p("grad.mp4"),        // 灰平渐变：lum 60→160，均值 ≈110
    bimodal: p("bimodal.mp4"),  // 双峰高对比：左 60 右 160，均值同样 ≈110
    gradDark: p("grad-dark.mp4"), // 同分布 -10 级：均值 ≈100
    clean: p("clean.mp4"),
    noisy: p("noisy.mp4"),
  };

  beforeAll(() => {
    const mk = (out: string, src: string, vf: string) => execFileSync(bins.ffmpeg, [
      "-hide_banner", "-v", "error", "-y",
      "-f", "lavfi", "-i", src,
      "-vf", vf,
      "-c:v", "mpeg4", "-q:v", "3", "-pix_fmt", "yuv420p", out,
    ]);
    const gray = "color=c=0x808080:size=320x240:duration=2:rate=15";
    mk(files.grad, gray, "geq=lum='60+100*X/W':cb=128:cr=128");
    mk(files.bimodal, gray, "geq=lum='if(lt(X,W/2),60,160)':cb=128:cr=128");
    mk(files.gradDark, gray, "geq=lum='50+100*X/W':cb=128:cr=128");
    mk(files.clean, "testsrc2=size=320x240:duration=2:rate=15", "null");
    mk(files.noisy, "testsrc2=size=320x240:duration=2:rate=15,noise=alls=40:allf=t+u", "null");
  }, 120_000);

  afterAll(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("①同均值异分布：均值判据漏检的场景，直方图残差超阈值", async () => {
    const ref = await yuvHistogram({ input: files.grad, at: 1, bins });
    const target = await yuvHistogram({ input: files.bimodal, at: 1, bins });
    const { weighted, chi2 } = histResidual(target, ref);
    expect(weighted).toBeGreaterThan(HIST_RESIDUAL_THRESHOLD);
    expect(chi2.Y).toBeGreaterThan(chi2.U); // 触发源是亮度分布，不是色度
  }, 120_000);

  it("②正常素材不触发（误报 0）：同片 ≈0、小曝光差也在阈值之下", async () => {
    const ref = await yuvHistogram({ input: files.grad, at: 1, bins });
    const same = await yuvHistogram({ input: files.grad, at: 0.5, bins });
    expect(histResidual(same, ref).weighted).toBeLessThan(HIST_RESIDUAL_THRESHOLD);
    const darker = await yuvHistogram({ input: files.gradDark, at: 1, bins });
    expect(histResidual(darker, ref).weighted).toBeLessThan(HIST_RESIDUAL_THRESHOLD);
  }, 120_000);

  it("③噪点代理：颗粒噪命中阈值、干净素材不命中", async () => {
    const noisyLevel = await estimateNoise({ input: files.noisy, at: 1, bins });
    const cleanLevel = await estimateNoise({ input: files.clean, at: 1, bins });
    expect(noisyLevel).toBeGreaterThanOrEqual(NOISE_DIFF_YAVG_HIT);
    expect(cleanLevel).toBeLessThan(NOISE_DIFF_YAVG_HIT);
  }, 120_000);
});

/**
 * T-24 完整链路：match 的直方图残差判据与 grade 的可选降噪。
 * grade 内部硬编码 libx264 出片，沙箱缺该编码器时整组跳过（与既有 e2e 同口径）。
 */
describe.runIf(hasX264)("镜间匹配端到端：直方图残差 + 可选降噪（T-24）", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "colort24-e2e-"));
  const p = (name: string) => path.join(dir, name);
  const files = {
    grad: p("grad.mp4"),
    bimodal: p("bimodal.mp4"),
    gradDark: p("grad-dark.mp4"),
    clean: p("clean.mp4"),
    noisy: p("noisy.mp4"),
  };

  beforeAll(() => {
    const mk = (out: string, src: string, vf: string) => execFileSync(bins.ffmpeg, [
      "-hide_banner", "-v", "error", "-y",
      "-f", "lavfi", "-i", src,
      "-vf", vf,
      "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", out,
    ]);
    const gray = "color=c=0x808080:size=320x240:duration=2:rate=15";
    mk(files.grad, gray, "geq=lum='60+100*X/W':cb=128:cr=128");
    mk(files.bimodal, gray, "geq=lum='if(lt(X,W/2),60,160)':cb=128:cr=128");
    mk(files.gradDark, gray, "geq=lum='50+100*X/W':cb=128:cr=128");
    mk(files.clean, "testsrc2=size=320x240:duration=2:rate=15", "null");
    mk(files.noisy, "testsrc2=size=320x240:duration=2:rate=15,noise=alls=40:allf=t+u", "null");
  }, 120_000);

  afterAll(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("①亮度均值相同但分布不同：旧均值判据通过、新残差识别；fail 判负、off 关闭", async () => {
    const res = await match({ reference: files.grad, targets: [files.bimodal], outDir: p("m-warn"), bins });
    const item = res.results[0];
    expect(item.ok).toBe(true);
    // 旧均值判据：同均值合成素材必须过线（证明旧判据确实漏检这类素材）
    expect(Math.abs(item.residual.YAVG as number)).toBeLessThanOrEqual(5);
    // 新直方图判据：默认 warn 上报，写入既有 residual 字段
    expect(item.residual.histogram.over).toBe(true);
    expect(item.residual.histogram.weighted).toBeGreaterThan(HIST_RESIDUAL_THRESHOLD);
    expect(item.residual.histogram.warning).toContain("均值陷阱");

    const failed = await match({
      reference: files.grad, targets: [files.bimodal], outDir: p("m-fail"), histogramCheck: "fail", bins,
    });
    expect(failed.results[0].ok).toBe(false);
    expect(failed.results[0].error).toBe("histogram_residual");

    const off = await match({
      reference: files.grad, targets: [files.bimodal], outDir: p("m-off"), histogramCheck: "off", bins,
    });
    expect(off.results[0].ok).toBe(true);
    expect(off.results[0].residual.histogram).toBeUndefined();
  }, 360_000);

  it("②正常匹配素材：均值与直方图判据双双过线，零误报", async () => {
    const res = await match({ reference: files.grad, targets: [files.gradDark], outDir: p("m-ok"), bins });
    const item = res.results[0];
    expect(item.ok).toBe(true);
    expect(Math.abs(item.residual.YAVG as number)).toBeLessThanOrEqual(5);
    expect(item.residual.histogram.over).toBe(false);
    expect(item.residual.histogram.weighted).toBeLessThanOrEqual(HIST_RESIDUAL_THRESHOLD);
    expect(item.residual.histogram.warning).toBeNull();
  }, 240_000);

  it("③降噪默认关闭；开启且噪点命中时插入 hqdn3d 且 luma_spatial≤2.0；干净素材不插入", async () => {
    // 默认关闭：滤镜链无 hqdn3d
    const def = await grade({
      input: files.noisy, output: p("dn-default.mp4"),
      corrections: { eq: { brightness: 0.01 } }, bins,
    });
    expect(def.chain).not.toContain("hqdn3d");
    // 开启 + 噪点命中：存在且保守
    const on = await grade({
      input: files.noisy, output: p("dn-on.mp4"),
      corrections: { eq: { brightness: 0.01 } }, denoise: true, bins,
    });
    const m = /hqdn3d=luma_spatial=([0-9.]+)/.exec(on.chain);
    expect(m, "噪点命中时滤镜链应含 hqdn3d").not.toBeNull();
    expect(Number(m![1])).toBeLessThanOrEqual(2);
    // 开启但噪点未命中：不插入，并在 verifyWarnings 注明原因
    const clean = await grade({
      input: files.clean, output: p("dn-clean.mp4"),
      corrections: { eq: { brightness: 0.01 } }, denoise: true, bins,
    });
    expect(clean.chain).not.toContain("hqdn3d");
    expect(clean.verifyWarnings.join("\n")).toContain("未插入降噪");
  }, 360_000);
});

/**
 * P0 真机事故防线（T-01..T-04）：
 *   肤色自动检测（T-01）/ 场景切分自适应抽样（T-02）/ 不可修复缺陷检测（T-03）/ Rec.709 元数据（T-04）。
 * 每个检测器都要求"正例命中 + 负例不误报"；口径依据见 library/color-kb 与 scenarios 的失败案例编号。
 */
describe.runIf(hasX264)("P0 防线端到端：肤色 / 场景抽样 / 缺陷 / Rec.709（T-01..T-04）", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "colorp0-"));
  const p = (name: string) => path.join(dir, name);
  const files = {
    skin: p("skin.mp4"),        // 灰底 + 中央真实肤色块（U/V 落在肤色带，HSV hue ≈24°）
    greenBlock: p("green.mp4"), // 灰底 + 绿色块：肤色带的负例
    single: p("single.mp4"),    // 单镜到底（灰）
    multi: p("multi.mp4"),      // 6 段硬切
    sharp: p("sharp.mp4"),
    blurred: p("blurred.mp4"),
  };

  const run = (args: string[]) => execFileSync(bins.ffmpeg, args);

  beforeAll(() => {
    const overlay = (color: string, out: string) => run([
      "-hide_banner", "-v", "error", "-y",
      "-f", "lavfi", "-i", "color=c=0x808080:s=320x240:d=1:r=10",
      "-f", "lavfi", "-i", `color=c=${color}:s=128x144:d=1:r=10`,
      "-filter_complex", "[0:v][1:v]overlay=96:48",
      "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", out,
    ]);
    overlay("0xE0B090", files.skin);
    overlay("0x8DD27C", files.greenBlock);
    run([
      "-hide_banner", "-v", "error", "-y",
      "-f", "lavfi", "-i", "color=c=gray:s=320x240:d=2:r=10",
      "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", files.single,
    ]);
    run([
      "-hide_banner", "-v", "error", "-y",
      "-f", "lavfi", "-i", "color=c=red:s=160x120:d=0.5:r=10",
      "-f", "lavfi", "-i", "color=c=green:s=160x120:d=0.5:r=10",
      "-f", "lavfi", "-i", "color=c=blue:s=160x120:d=0.5:r=10",
      "-f", "lavfi", "-i", "color=c=yellow:s=160x120:d=0.5:r=10",
      "-f", "lavfi", "-i", "color=c=magenta:s=160x120:d=0.5:r=10",
      "-f", "lavfi", "-i", "color=c=cyan:s=160x120:d=0.5:r=10",
      "-filter_complex", "[0:v][1:v][2:v][3:v][4:v][5:v]concat=n=6:v=1:a=0",
      "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", files.multi,
    ]);
    run([
      "-hide_banner", "-v", "error", "-y",
      "-f", "lavfi", "-i", "testsrc2=size=320x240:rate=10:duration=1",
      "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", files.sharp,
    ]);
    run([
      "-hide_banner", "-v", "error", "-y",
      "-i", files.sharp, "-vf", "gblur=sigma=8",
      "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", files.blurred,
    ]);
  }, 180_000);

  afterAll(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("T-01 口径修复（FC-COL-007）：肤色用标准 HSV 色相，不是 signalstats 的复合相位角", () => {
    // 实拍肤色 U=97,V=160：标准 HSV ≈25.7°，而 ffmpeg HUEAVG 是 135°（实测）——两把尺子不可混用
    expect(standardHueFromUv(97, 160)).toBeCloseTo(25.7, 0);
    expect(standardHueFromUv(128, 128)).toBeNull();          // 中性灰无色相
    expect(standardHueFromUv(54, 34)).toBeGreaterThan(100);  // 纯绿：远在肤色带之外
  });

  it("T-01 自动肤色检测：无 patch 命中真实肤色区（低置信度也如实上报），绿色块不误判", async () => {
    const report = await analyze({ input: files.skin, sampling: "uniform", defects: false, bins });
    expect(report.skin?.source).toBe("auto-skin-band");
    expect(report.skin?.hue).toBeGreaterThanOrEqual(20);
    expect(report.skin?.hue).toBeLessThanOrEqual(40);
    expect(report.skin?.healthy).toBe(true);
    expect(report.skinDetection?.patch?.w ?? 0).toBeGreaterThan(0);
    expect(report.skinDetection?.confidence).toMatch(/high|medium/);

    const negative = await analyze({ input: files.greenBlock, sampling: "uniform", defects: false, bins });
    expect(negative.skin?.detected).toBe(false);
    expect(negative.issues.some((i) => i.kind === "skin_check_skipped")).toBe(true);
  }, 120_000);

  it("T-01 显式 patch 优先于自动检测（调用方永远压得住工具）", async () => {
    const report = await analyze({
      input: files.skin, sampling: "uniform", defects: false,
      skinPatch: { x: 96, y: 48, w: 128, h: 144 }, bins,
    });
    expect(report.skin?.source).toBe("explicit-patch");
    expect(report.skin?.healthy).toBe(true);
  }, 120_000);

  it("T-02 纯函数：分段/代表帧/时长权重；段数超上限按窗口取最长段", () => {
    const segments = sceneSegments({ cuts: [1, 2.5, 4], duration: 6 });
    expect(segments.map((s) => [s.start, s.end])).toEqual([[0, 1], [1, 2.5], [2.5, 4], [4, 6]]);
    const picked = sceneSampleTimes({ segments });
    expect(picked.times).toEqual([0.5, 1.75, 3.25, 5]);
    expect(picked.weights).toEqual([1, 1.5, 1.5, 2]);
    const capped = sceneSampleTimes({
      segments: Array.from({ length: 10 }, (_, i) => ({ start: i, end: i + 1, durationSec: 1 })),
      maxSamples: 4,
    });
    expect(capped.times).toHaveLength(4);
  });

  it("T-02 场景抽样：6 段硬切按场景取中段代表帧；单镜到底退回均匀四帧", async () => {
    const plan = await planSampling({ input: files.multi, duration: 3, bins });
    expect(plan.mode).toBe("scene");
    expect(plan.sceneCount).toBeGreaterThanOrEqual(5);
    expect(plan.cuts.length).toBeGreaterThanOrEqual(4);
    expect(plan.times.length).toBeGreaterThanOrEqual(5);
    expect(plan.weights).toHaveLength(plan.times.length);
    // 代表帧在时间轴递增，且落在各自场景中段（0.25s 的抖动容差覆盖帧率粒度）
    expect([...plan.times].sort((a, b) => a - b)).toEqual(plan.times);
    expect(plan.times[0]).toBeGreaterThan(0.1);
    // 代表帧落在首段中段附近：ffmpeg 切点检测对"极小分辨率纯色硬切"的首刀可能只报后续切点，
    // 因此断言"落在首秒内"，不断言到具体帧（抽样正确性由 weights/递增/sceneCount 保证）。
    expect(plan.times[0]).toBeLessThan(1.2);

    const single = await planSampling({ input: files.single, duration: 2, bins });
    expect(single.mode).toBe("uniform");
    expect(single.times).toEqual([0.2, 0.7, 1.2, 1.7]);
  }, 120_000);

  it("T-03 色带（纯函数）：阶梯渐变命中、平滑渐变/纯色/高细节不误报", () => {
    const w = 160;
    const h = 90;
    const make = (fn: (x: number, y: number) => number) => {
      const buf = Buffer.alloc(w * h * 1.5);
      for (let y = 0; y < h; y += 1) {
        for (let x = 0; x < w; x += 1) buf[y * w + x] = Math.max(0, Math.min(255, Math.round(fn(x, y))));
      }
      buf.fill(128, w * h);
      return buf;
    };
    const smooth = bandingFromYuv(make((x) => 40 + (x / w) * 180), w);
    expect(smooth.banded).toBe(false);
    const stepped = bandingFromYuv(make((x) => 40 + Math.floor(((x / w) * 180) / 24) * 24), w);
    expect(stepped.banded).toBe(true);
    expect(stepped.holeRatio).toBeGreaterThanOrEqual(BANDING_THRESHOLDS.holeRatio);
    const flat = bandingFromYuv(make(() => 128), w);
    expect(flat.banded).toBe(false);
    const detail = bandingFromYuv(make((x, y) => ((x * 7 + y * 13) % 256)), w);
    expect(detail.banded).toBe(false);
  });

  it("T-03 缺陷检测：失焦素材命中不可修复档，清晰素材不误报", async () => {
    const clean = await detectDefects({ input: files.sharp, at: [0.3], bins });
    expect(clean.unfixable).toHaveLength(0);
    const blurred = await detectDefects({ input: files.blurred, at: [0.3], bins });
    const blur = blurred.defects.find((d) => d.kind === "blur");
    expect(blur, "gblur sigma=8 素材必须命中失焦档").toBeTruthy();
    expect(blur?.fixable).toBe(false);
    expect(blur?.measured).toBeGreaterThanOrEqual(BLUR_THRESHOLDS.heavy);
    const report = await analyze({ input: files.blurred, sampling: "uniform", bins });
    expect(report.defects?.unfixable.some((d) => d.kind === "blur")).toBe(true);
    expect(report.issues.some((i) => i.kind === "defect_blur")).toBe(true);
  }, 180_000);

  it("T-03 交付闸：onUnfixable=block 时拒出片且不留产物，默认 report 只如实上报", async () => {
    const blocked = p("blocked.mp4");
    await expect(grade({
      input: files.blurred, output: blocked,
      corrections: { eq: { brightness: 0.06 } }, onUnfixable: "block", bins,
    })).rejects.toThrow(/不可修复/);
    expect(fs.existsSync(blocked)).toBe(false);

    const reported = await grade({
      input: files.blurred, output: p("reported.mp4"),
      corrections: { eq: { brightness: 0.06 } }, bins,
    });
    expect(reported.defects?.unfixable.some((d) => d.kind === "blur")).toBe(true);
    expect(reported.verifyWarnings.join("\n")).toContain("不可修复");
  }, 300_000);

  it("T-04 交付元数据：输出 bt709 三标签齐全且 ffprobe 回读一致", async () => {
    const out = p("tagged.mp4");
    const result = await grade({
      input: files.sharp, output: out, profile: "teal-orange", intensity: 1, bins,
    });
    expect(result.outputColor).toMatchObject({ primaries: "bt709", transfer: "bt709", space: "bt709", verified: true });
    const probe = await probeMedia(out, { bins });
    expect(probe.video.colorPrimaries).toBe("bt709");
    expect(probe.video.colorTransfer).toBe("bt709");
    expect(probe.video.colorSpace).toBe("bt709");
  }, 180_000);
});
