/**
 * 调性/调式检测 + 能量弧线标签的验证。
 *
 * 分两层：
 * 1. 纯 JS 单元用例（不依赖 ffmpeg）：K-S 模板匹配、置信度分档、先验裁决、弧线归纳、标签幂等；
 * 2. 真机用例（有 ffmpeg 才跑）：用仓内 synth.mjs 合成 5 首**已知调性**的 WAV，
 *    逐首走 `measureKey` 实测链路（ffmpeg 解码 → chromagram → K-S），正确率要求 ≥4/5。
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { resolveBinaries } from "./measure.mjs";
import { composeToWav } from "./synth.mjs";
import {
  applyKeyArcTags, chromagramFromPcm, classifyEnergyArc, decideKeyWithPrior, estimateKeyFromChroma,
  fftRadix2, keyConfidenceFromMargin, keyPriorFromTags, measureKey,
} from "./tag.mjs";

const bins = resolveBinaries();
const hasFfmpeg = (() => {
  try {
    execFileSync(bins.ffmpeg, ["-hide_banner", "-version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
})();

/* ============================ 纯 JS 单元用例 ============================ */

describe("调性检测（纯 JS，无 ffmpeg）", () => {
  it("基-2 FFT：单位冲激的频谱是全平坦的", () => {
    const re = new Float64Array(1024);
    const im = new Float64Array(1024);
    re[0] = 1;
    fftRadix2(re, im);
    for (let bin = 0; bin < 512; bin += 1) {
      expect(Math.hypot(re[bin]!, im[bin]!), `bin ${bin}`).toBeCloseTo(1, 6);
    }
  });

  it("chromagram：合成 D 大三和弦（D/F#/A + 根音低音）→ chroma 峰值落在 D/F#/A", () => {
    const sampleRate = 22050;
    const n = sampleRate * 8;
    const pcm = new Float32Array(n);
    const freq = (midi: number) => 440 * 2 ** ((midi - 69) / 12);
    for (let i = 0; i < n; i += 1) {
      const t = i / sampleRate;
      pcm[i] = 0.2 * (Math.sin(2 * Math.PI * freq(50) * t) + Math.sin(2 * Math.PI * freq(62) * t)
        + Math.sin(2 * Math.PI * freq(66) * t) + Math.sin(2 * Math.PI * freq(69) * t));
    }
    const { chroma, framesUsed } = chromagramFromPcm({ pcm, sampleRate });
    expect(framesUsed).toBeGreaterThan(10);
    const top = chroma
      .map((value, pc) => ({ value, pc }))
      .sort((a, b) => b.value - a.value)
      .slice(0, 3)
      .map((entry) => entry.pc)
      .sort((a, b) => a - b);
    expect(top).toEqual([2, 6, 9]); // D / F# / A
  });

  it("K-S 模板：G 大调 chroma → G4 major；E 小调 chroma → E4 minor", () => {
    const majorChroma = [0.4, 0.1, 0.55, 0.15, 0.75, 0.3, 0.1, 1.0, 0.15, 0.5, 0.2, 0.65];
    const gMajor = estimateKeyFromChroma(majorChroma);
    expect(gMajor.key).toBe("G4");
    expect(gMajor.mode).toBe("major");
    const minorChroma = [0.35, 0.1, 0.5, 0.15, 1.0, 0.2, 0.6, 0.75, 0.1, 0.55, 0.65, 0.4];
    const eMinor = estimateKeyFromChroma(minorChroma);
    expect(eMinor.key).toBe("E4");
    expect(eMinor.mode).toBe("minor");
  });

  it("置信度三档：按领先幅度 + 最佳相关度分档", () => {
    expect(keyConfidenceFromMargin(0.15, 0.7)).toBe("high");
    expect(keyConfidenceFromMargin(0.12, 0.6)).toBe("high");
    expect(keyConfidenceFromMargin(0.08, 0.5)).toBe("medium");
    expect(keyConfidenceFromMargin(0.15, 0.5)).toBe("medium"); // 领先够但相关度不够 → 降档
    expect(keyConfidenceFromMargin(0.04, 0.9)).toBe("low"); // 相关度高但咬得紧 → low
    expect(keyConfidenceFromMargin(0.02, 0.3)).toBe("low");
  });

  it("目录先验：实测 medium 不推翻先验，high 才推翻（对齐 classifyStyle 纪律）", () => {
    const mediumDetection = {
      key: "D4", mode: "major" as const, confidence: "medium" as const,
      margin: 0.08, bestCorr: 0.55, secondCorr: 0.47, candidates: [],
    };
    const kept = decideKeyWithPrior({ detection: mediumDetection, priorKey: "C4", priorMode: "major" });
    expect(kept.key).toBe("C4");
    expect(kept.confidence).toBe("medium");
    expect(kept.source).toBe("prior-kept");
    expect(kept.conflict).toContain("保留先验");

    const highDetection = { ...mediumDetection, confidence: "high" as const, margin: 0.2, bestCorr: 0.8 };
    const overridden = decideKeyWithPrior({ detection: highDetection, priorKey: "C4", priorMode: "major" });
    expect(overridden.key).toBe("D4");
    expect(overridden.source).toBe("measured-override");

    const agreed = decideKeyWithPrior({ detection: mediumDetection, priorKey: "D4", priorMode: "major" });
    expect(agreed.key).toBe("D4");
    expect(agreed.source).toBe("prior+measured");
  });

  it("keyPriorFromTags：从既有 tags 提取先验", () => {
    expect(keyPriorFromTags(["modern-pop", "key:F#4", "mode:minor"])).toEqual({ key: "F#4", mode: "minor" });
    expect(keyPriorFromTags(["modern-pop"])).toEqual({ key: null, mode: null });
  });
});

describe("能量弧线标签", () => {
  const seg = (type: string, startSec: number, durationSec: number, avgDb: number) => ({
    id: `s-${type}-${startSec}`, type, level: "mid", startSec, endSec: startSec + durationSec,
    durationSec, avgDb, peakDb: avgDb + 3, riseDb: 0, onsetDensity: 1,
  });

  it("单段 flat → flat-ambient；动态 <6dB → flat-ambient", () => {
    expect(classifyEnergyArc({ segments: [seg("flat", 0, 60, -20)] }).arc).toBe("flat-ambient");
    expect(classifyEnergyArc({ segments: [seg("intro", 0, 30, -20), seg("verse", 30, 30, -19)], dynamicsDb: 4 }).arc).toBe("flat-ambient");
  });

  it("build→drop → build-drop；drop+长回落尾段 → outro-resolve", () => {
    const buildDrop = classifyEnergyArc({
      segments: [seg("intro", 0, 10, -28), seg("build", 10, 10, -22), seg("drop", 20, 30, -12)],
      dynamicsDb: 12,
    });
    expect(buildDrop.arc).toBe("build-drop");
    const resolve = classifyEnergyArc({
      segments: [seg("intro", 0, 8, -26), seg("drop", 8, 22, -12), seg("outro", 30, 14, -24)],
      dynamicsDb: 12,
    });
    expect(resolve.arc).toBe("outro-resolve");
  });

  it("双 drop → wave-narrative；无 drop 渐进上升 → rising-steady；前重后轻 → front-loaded", () => {
    expect(classifyEnergyArc({
      segments: [seg("drop", 0, 15, -12), seg("breakdown", 15, 10, -24), seg("drop", 25, 15, -13)],
      dynamicsDb: 12,
    }).arc).toBe("wave-narrative");
    expect(classifyEnergyArc({
      segments: [seg("intro", 0, 20, -30), seg("verse", 20, 20, -24), seg("verse", 40, 20, -18)],
      dynamicsDb: 10,
    }).arc).toBe("rising-steady");
    expect(classifyEnergyArc({
      segments: [seg("verse", 0, 20, -16), seg("verse", 20, 20, -22), seg("outro", 40, 20, -28)],
      dynamicsDb: 10,
    }).arc).toBe("front-loaded");
  });
});

describe("标签幂等", () => {
  it("applyKeyArcTags 重跑不产生重复标签，且清掉旧 key/mode/arc 前缀", () => {
    const base = ["modern-pop", "明快愉悦", "key:C4", "mode:major", "arc:flat-ambient"];
    const once = applyKeyArcTags(base, { key: "G4", mode: "major", arc: "build-drop" });
    expect(once).toEqual(["modern-pop", "明快愉悦", "key:G4", "mode:major", "arc:build-drop"]);
    const twice = applyKeyArcTags(once, { key: "G4", mode: "major", arc: "build-drop" });
    expect(twice).toEqual(once);
    // 低置信调性重跑：旧 key/mode 被清掉（不许猜），arc 照常更新
    const cleared = applyKeyArcTags(once, { arc: "rising-steady" });
    expect(cleared).toEqual(["modern-pop", "明快愉悦", "arc:rising-steady"]);
  });
});

/* ============================ 真机用例（需要 ffmpeg） ============================ */

const workDir = join(tmpdir(), `bgm-key-arc-${Date.now().toString(36)}`);

/** 5 首已知调性的合成曲目（刻意跨大/小调、跨根音；A 小调与 C 大调共享调号，是最难的一档）。 */
const KNOWN_KEYS = [
  { key: "C4", mode: "major", chords: ["I", "IV", "V", "I"], seed: 11 },
  { key: "G4", mode: "major", chords: ["I", "V", "vi", "IV"], seed: 22 },
  { key: "F4", mode: "major", chords: ["I", "vi", "IV", "V"], seed: 33 },
  { key: "A4", mode: "minor", chords: ["i", "VI", "III", "VII"], seed: 44 },
  { key: "E4", mode: "minor", chords: ["i", "iv", "VI", "v"], seed: 55 },
] as const;

describe.skipIf(!hasFfmpeg)("调性实测（synth 合成已知调性 + ffmpeg 解码）", () => {
  const results: Array<{ expected: (typeof KNOWN_KEYS)[number]; detected: { key: string | null; mode: string | null; confidence: string } }> = [];

  beforeAll(async () => {
    mkdirSync(workDir, { recursive: true });
    for (const fixture of KNOWN_KEYS) {
      const output = join(workDir, `${fixture.key}-${fixture.mode}.wav`);
      await composeToWav({
        recipe: {
          id: `key-test-${fixture.key}-${fixture.mode}`,
          key: fixture.key,
          mode: fixture.mode,
          bpm: 100,
          chords: [...fixture.chords],
          instrumentation: ["pad", "bass", "pluck"],
          style: "acoustic-warm",
        },
        durationSec: 24,
        output,
        seed: fixture.seed,
      });
      const detected = await measureKey(output, { bins });
      results.push({ expected: fixture, detected });
    }
  }, 300_000);

  afterAll(() => {
    if (!process.env.BGM_KEEP_FIXTURES) rmSync(workDir, { recursive: true, force: true });
  });

  it("5 首已知调性检测正确 ≥4 首，且命中的置信度 ≥medium", () => {
    const hits = results.filter(
      ({ expected, detected }) => detected.key === expected.key && detected.mode === expected.mode,
    );
    const detail = results
      .map(({ expected, detected }) => `${expected.key}/${expected.mode} → ${detected.key}/${detected.mode}(${detected.confidence})`)
      .join("; ");
    expect(hits.length, `逐首结果：${detail}`).toBeGreaterThanOrEqual(4);
    for (const hit of hits) {
      expect(["high", "medium"]).toContain(hit.detected.confidence);
    }
  }, 30_000);
});
