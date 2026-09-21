/**
 * 调色内核单测：纯函数（滤镜链/路径监狱/自动校正）+ 真实 ffmpeg 端到端（有 ffmpeg 才跑）。
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  COLOR_TOOLS, ColorError, SCOPE_KINDS, allowedRoots, assertPathAllowed, autoCorrections,
  best, buildChain, frameDifference, frameQuality, grade, probeMedia, PROFILES, renderScopes,
  resolveBinaries, scoreQuality, summarize,
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
