/**
 * 曲库打标（bgmwrite.tag / tag.mjs）回归测试。
 *
 * 为什么单独一组：打标是"把外部素材纳入可交付曲库"的动作，失败模式是**静默且昂贵**的——
 *  · 许可没声明就入册 → 客户交付踩版权红线；
 *  · 拍速八度歧义没折叠 → 240 BPM 的曲子永远匹配不上任何题材配方；
 *  · 削波/噪声素材混进库 → 混音后才发现，返工成本高；
 *  · 索引字段与运行时契约漂移 → 曲库"看起来有货"，运行时却加载不到。
 * 因此这里对纯函数（分类/过滤/八度折叠/索引契约）做穷尽断言；真机量测（ffmpeg）用例在
 * 缺 ffmpeg 的环境自动跳过，保证 CI 不因环境缺件而假红。
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path, { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";

import { loadAllLocalTracks } from "../../../bundles/ai-video/connectors/bgm-bridge/core.mjs";
import { planComposition, renderCompositionToWav } from "../../../bundles/ai-video/connectors/bgm-bridge/synth.mjs";
import {
  DEFAULT_FILTERS, FOLDER_HINTS, STYLE_FAMILIES, applyHardFilters, bpmBucketOf, buildIndexEntry,
  canonicalBpm, classifyStyle, classifyTrack, clipRiskOf, computeExcerptGain, energyScoreOf, folderHintFor,
  instrumentationOf, listAudioFiles, loopFriendlyOf, parseAstatsOverall, planExcerpt, scoreForCurated,
  mergeExternalTags, selectCuratedTracks, silenceStatsOf, tagLibrary, titleArtistFromFile, titleArtistOf, writeLibrary,
  defaultScanRoots, discoverLibraries, inspectLibraryDir, packLibrary, rebindLibrary,
} from "../../../bundles/ai-video/connectors/bgm-bridge/tag.mjs";

/** ffmpeg 可用性（CI 的 test-gate 镜像里可能没有 ffmpeg；缺件时跳过真机量测，不假红）。 */
function ffmpegAvailable(): boolean {
  try {
    execFileSync("ffmpeg", ["-version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}
const HAS_FFMPEG = ffmpegAvailable();

const tempDirs: string[] = [];
function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

describe("曲库打标 · 量测解析与硬过滤", () => {
  it("astats 只取 Overall 段（不能被每声道行带偏）", () => {
    const stderr = [
      "[Parsed_astats_0] Channel: 1",
      "[Parsed_astats_0] Peak level dB: -3.000000",
      "[Parsed_astats_0] Flat factor: 0.000000",
      "[Parsed_astats_0] Peak count: 1.000000",
      "[Parsed_astats_0] Channel: 2",
      "[Parsed_astats_0] Peak level dB: -4.000000",
      "[Parsed_astats_0] Overall",
      "[Parsed_astats_0] Peak level dB: -0.500000",
      "[Parsed_astats_0] Flat factor: 0.012000",
      "[Parsed_astats_0] Peak count: 7.000000",
    ].join("\n");
    expect(parseAstatsOverall(stderr)).toEqual({ peakDb: -0.5, flatFactor: 0.012, peakCount: 7 });
  });

  it("削波判定：平坦因子超标=硬拒；真峰值贴顶=只标注 hot（不误杀现代母带）", () => {
    const clipped = clipRiskOf({ truePeakDbtp: -0.2, flatFactor: 0.08, peakDb: -0.05 });
    expect(clipped.clipped).toBe(true);
    expect(clipped.reasons.join()).toContain("平坦因子");

    const hot = clipRiskOf({ truePeakDbtp: 0.4, flatFactor: 0, peakDb: -0.09 });
    expect(hot.clipped).toBe(false);
    expect(hot.flags.join()).toContain("峰值贴顶");

    const clean = clipRiskOf({ truePeakDbtp: -1.6, flatFactor: 0, peakDb: -1.5 });
    expect(clean.clipped).toBe(false);
    expect(clean.flags).toHaveLength(0);
  });

  it("硬过滤：时长/响度/削波/静音四类各自拦下，达标曲目放行", () => {
    const base = {
      durationSec: 120, loudness: { integratedLufs: -14 }, silenceRatio: 0.02,
      clip: { clipped: false, reasons: [], flags: [] },
    };
    expect(applyHardFilters(base)).toEqual({ keep: true, rejections: [] });
    expect(applyHardFilters({ ...base, durationSec: 12 }).keep).toBe(false);
    expect(applyHardFilters({ ...base, loudness: { integratedLufs: -42 } }).rejections.join()).toContain("整体响度");
    expect(applyHardFilters({ ...base, clip: { clipped: true, reasons: ["平坦因子超标"], flags: [] } }).keep).toBe(false);
    expect(applyHardFilters({ ...base, silenceRatio: 0.8 }).keep).toBe(false);
  });

  it("静音统计：首尾静音秒数与静音占比按 0.25s 窗口如实计算", () => {
    const envelope = [-70, -70, -40, -20, -18, -30, -70];
    const stats = silenceStatsOf(envelope, -55);
    expect(stats.leadingSec).toBe(0.5);
    expect(stats.trailingSec).toBe(0.25);
    expect(stats.ratio).toBeCloseTo(3 / 7, 3);
  });
});

describe("曲库打标 · 拍速与标签", () => {
  it("拍速八度折叠：240→120、48→96、120 保持不变（折叠因子留痕）", () => {
    expect(canonicalBpm(240)).toEqual({ bpm: 120, raw: 240, foldFactor: 2 });
    expect(canonicalBpm(48)).toEqual({ bpm: 96, raw: 48, foldFactor: 0.5 });
    expect(canonicalBpm(120)).toEqual({ bpm: 120, raw: 120, foldFactor: null });
    expect(canonicalBpm(null).bpm).toBeNull();
  });

  it("BPM 档：拍速不可信时不给档位（不许硬编）", () => {
    expect(bpmBucketOf(70, "high")).toBe("slow");
    expect(bpmBucketOf(95, "medium")).toBe("mid");
    expect(bpmBucketOf(125, "high")).toBe("up");
    expect(bpmBucketOf(150, "high")).toBe("fast");
    expect(bpmBucketOf(150, "low")).toBeNull();
    expect(bpmBucketOf(null, "high")).toBeNull();
  });

  it("能量分：起音密度为主、响度为辅，单调且落在 [0,1]", () => {
    const sparseQuiet = energyScoreOf({ integratedLufs: -24, onsetRatePerSec: 0.4 });
    const denseQuiet = energyScoreOf({ integratedLufs: -24, onsetRatePerSec: 6 });
    const denseLoud = energyScoreOf({ integratedLufs: -9, onsetRatePerSec: 6 });
    expect(sparseQuiet).toBeLessThan(denseQuiet);
    expect(denseQuiet).toBeLessThanOrEqual(denseLoud);
    expect(denseLoud).toBeLessThanOrEqual(1);
    expect(sparseQuiet).toBeGreaterThanOrEqual(0);
  });

  it("配器倾向：频谱重心/起音密度映射成可检索标签", () => {
    expect(instrumentationOf({ centroidHz: 600, flatness: 0.1, onsetRatePerSec: 1 })).toContain("低频厚（bass-heavy）");
    expect(instrumentationOf({ centroidHz: 1500, flatness: 0.1, onsetRatePerSec: 4 })).toContain("打击感强（percussive）");
    expect(instrumentationOf({ centroidHz: 3000, flatness: 0.5, onsetRatePerSec: 0.3 })).toEqual(
      expect.arrayContaining(["高频亮（bright）", "噪声质感（noise-texture）", "无鼓/铺底（beatless）"]),
    );
  });

  it("风格裁决：目录先验是人工分类，特征要推翻它必须领先 12 分以上", () => {
    // 特征略偏电子脉冲（快节奏+高能量），但目录先验说旅拍（原声温暖）→ 保留先验，候选里留痕
    const hinted = classifyStyle({
      bpm: 120, tempoConfidence: "medium", energyScore: 0.88, dynamicsDb: 11.8,
      folderHint: { style: "acoustic-warm", match: "Vlog-旅拍" },
    });
    expect(hinted.style).toBe("acoustic-warm");
    expect(hinted.confidence).toBe("high");
    expect(hinted.candidates.map((candidate) => candidate.style)).toContain("electronic-pulse");

    // 特征与先验彻底冲突（160 BPM + 0.99 能量 + 10 dB 动态，领先先验 >12 分）：先验被推翻
    const overridden = classifyStyle({
      bpm: 160, tempoConfidence: "high", energyScore: 0.99, dynamicsDb: 10,
      folderHint: { style: "ambient-calm", match: "安静-舒缓" },
    });
    expect(overridden.style).toBe("sports-hype");
    expect(["medium", "high"]).toContain(overridden.confidence);

    // 先验小胜（领先 <12 分）：风格保留先验，margin 与候选都写进返回值，供人工复核
    const closeCall = classifyStyle({
      bpm: 120, tempoConfidence: "medium", energyScore: 0.88, dynamicsDb: 11.8,
      folderHint: { style: "acoustic-warm", match: "Vlog-旅拍" },
    });
    expect(closeCall.style).toBe("acoustic-warm");
    expect(closeCall.margin).toBeLessThan(12);
    expect(closeCall.candidates.map((candidate) => candidate.style)).toContain("electronic-pulse");
    expect(closeCall.candidates[0]!.reasons.join()).toContain("目录先验");

    // 没有先验、特征极端（150 BPM + 0.95 能量）→ 运动燃点
    const noHint = classifyStyle({ bpm: 150, tempoConfidence: "high", energyScore: 0.95, dynamicsDb: 9 });
    expect(noHint.style).toBe("sports-hype");
    expect(noHint.confidence).toBe("high");

    // 拍速不可信时置信度不得虚高
    const unsure = classifyStyle({ bpm: null, tempoConfidence: "low", energyScore: 0.3, dynamicsDb: 4 });
    expect(["low", "medium"]).toContain(unsure.confidence);
  });

  it("循环友好度：首尾能量接近且尾部无长静音才判可循环", () => {
    const flat = Array.from({ length: 40 }, (_, index) => -18 + (index % 3));
    expect(loopFriendlyOf({ envelopeDb: flat, trailingSilenceSec: 0.2 }).loopFriendly).toBe(true);
    const fading = [...Array.from({ length: 20 }, () => -14), ...Array.from({ length: 20 }, () => -34)];
    expect(loopFriendlyOf({ envelopeDb: fading, trailingSilenceSec: 2.5 }).loopFriendly).toBe(false);
    expect(loopFriendlyOf({ envelopeDb: [-20, -20], trailingSilenceSec: 0 }).loopFriendly).toBeNull();
  });

  it("目录先验与标题解析：中文分类目录、`作者-标题.mp3` 都能识别", () => {
    expect(folderHintFor("卡点-节奏/Action Rhythms.mp3")!.style).toBe("electronic-pulse");
    expect(folderHintFor("400首商用/安静冥想/x.mp3")!.style).toBe("ambient-calm");
    expect(folderHintFor("随机目录/x.mp3")).toBeNull();
    expect(titleArtistFromFile("/music/Vlog-旅拍/Roa-Tiny Love.mp3")).toEqual({ artist: "Roa", title: "Tiny Love" });
    expect(titleArtistFromFile("/music/无作者曲.mp3")).toEqual({ artist: null, title: "无作者曲" });
  });

  it("标题/作者归属：内嵌 ID3 元数据优先于文件名，并标注来源（缺就如实留空）", () => {
    const embedded = titleArtistOf({
      relativePath: "Vlog-旅拍/Roa-Tiny Love.mp3",
      tags: { title: "Tiny Love (Radio Edit)", artist: "Roa Music", album: "Free Pack Vol.3", copyright: "CC BY 4.0", date: "2024" },
    });
    expect(embedded.title).toBe("Tiny Love (Radio Edit)");
    expect(embedded.artist).toBe("Roa Music");
    expect(embedded.album).toBe("Free Pack Vol.3");
    expect(embedded.copyright).toBe("CC BY 4.0");
    expect(embedded.titleSource).toBe("embedded-tag");

    const fromName = titleArtistOf({ relativePath: "Vlog-旅拍/Roa-Tiny Love.mp3", tags: { title: null, artist: null } });
    expect(fromName.title).toBe("Tiny Love");
    expect(fromName.artist).toBe("Roa");
    expect(fromName.titleSource).toBe("file-name");

    const missing = titleArtistOf({ relativePath: "无作者曲.mp3", tags: null });
    expect(missing.artist).toBeNull();
    expect(missing.artistSource).toBe("missing");
  });

  it("风格表与目录先验自洽：每个先验风格都在风格族表里，标签不重复", () => {
    for (const hint of FOLDER_HINTS) expect(STYLE_FAMILIES[hint.style], hint.style).toBeDefined();
    const entry = buildIndexEntry({
      index: 1, root: "/music", relativePath: "卡点-节奏/Action.mp3",
      license: "royalty-free", licenseNote: "x", licenseSource: "owner-pack",
      measurement: {
        input: "/music/卡点-节奏/Action.mp3", sha256: "a".repeat(64), bytes: 1024, durationSec: 120,
        format: { codec: "mp3", container: "mp3", bitrateKbps: 320, sampleRate: 44100, channels: 2 },
        loudness: { integratedLufs: -11, truePeakDbtp: 0.4, lra: 8 },
        peak: { peakDb: -0.1, flatFactor: 0 },
        clip: { clipped: false, reasons: [], flags: ["峰值贴顶"] },
        envelope: { dynamicsDb: 9, quantiles: { p10: -18, p50: -12, p90: -9 }, outlineDb: [] },
        tempo: { bpm: 240, confidence: "medium" }, structure: { method: "rule-based", hasDrop: true, segments: [] },
        voice: { activeRatio: 0.2 }, silence: { trailingSec: 0.1 }, spectral: { centroidHz: 1800, flatness: 0.1 },
        onsetRatePerSec: 4, energyScore: 0.7,
      },
      tags: classifyTrack({
        relativePath: "卡点-节奏/Action.mp3",
        measurement: {
          input: "/music/卡点-节奏/Action.mp3", durationSec: 120, energyScore: 0.7,
          tempo: { bpm: 240, confidence: "medium" },
          envelope: { dynamicsDb: 9, outlineDb: Array.from({ length: 20 }, () => -14) },
          silence: { trailingSec: 0.1 }, spectral: { centroidHz: 1800, flatness: 0.1 },
          voice: { activeRatio: 0.2 }, onsetRatePerSec: 4,
        },
      }),
    });
    expect(entry.bpm).toBe(120);
    expect(entry.bpmRaw).toBe(240);
    expect(entry.bpmFoldFactor).toBe(2);
    expect(entry.tags.length).toBe(new Set(entry.tags).size);
    expect(entry.file).toBe("卡点-节奏/Action.mp3");
    expect(entry.qualityFlags).toContain("峰值贴顶");
  });
});

describe("曲库打标 · 精选口径（质量分 / 多样性 / 选段 / 增益）", () => {
  const trackOf = (over: Record<string, unknown> = {}) => ({
    id: "t-1", file: "/music/a.mp3", style: "modern-pop", styleLabel: "现代流行（鼓组+副旋律）",
    energyBucket: "mid", bpm: 110, bpmConfidence: "high", durationSec: 150, dynamicsDb: 12,
    loudness: { integratedLufs: -14, truePeakDbtp: -1.2 }, peak: { flatFactor: 0 },
    spectral: { centroidHz: 1800 }, structure: { hasDrop: true, segments: [{ type: "intro" }, { type: "drop" }, { type: "outro" }] },
    loop: { loopFriendly: true, startEndDeltaDb: 1.2 }, confidence: { style: "high" },
    ...over,
  });

  it("质量分：贴近目标响度、无削波、结构完整、拍速可信的曲子分更高", () => {
    const good = scoreForCurated(trackOf());
    const bad = scoreForCurated(trackOf({
      loudness: { integratedLufs: -22, truePeakDbtp: 1.4 }, peak: { flatFactor: 0.05 },
      bpmConfidence: "low", dynamicsDb: 30, confidence: { style: "low" },
      structure: { hasDrop: false, segments: [] }, loop: { loopFriendly: false },
    }));
    expect(good.score).toBeGreaterThan(bad.score + 25);
    expect(good.reasons.length).toBeGreaterThan(5);
    expect(bad.reasons.join()).toContain("平坦因子");
  });

  it("精选挑选：风格族轮转覆盖，单族不超上限，总数严格等于要求", () => {
    const tracks = [];
    for (const [styleIndex, style] of ["modern-pop", "cinematic-build", "ambient-calm", "sports-hype"].entries()) {
      for (let index = 0; index < 10; index += 1) {
        tracks.push(trackOf({
          id: `${style}-${index}`,
          style,
          energyBucket: index % 3 === 0 ? "low" : index % 3 === 1 ? "mid" : "high",
          loudness: { integratedLufs: -14 - index * 0.2, truePeakDbtp: -1.2 },
          bpmConfidence: index < 5 ? "high" : "medium",
        }));
      }
    }
    const selection = selectCuratedTracks({ tracks, count: 12 });
    expect(selection.count).toBe(12);
    expect(Object.keys(selection.byStyle).length).toBe(4); // 四种风格都有货 → 都要覆盖
    for (const [style, number] of Object.entries(selection.byStyle)) {
      expect(number, style).toBeLessThanOrEqual(selection.maxPerStyle);
      expect(number, style).toBeGreaterThanOrEqual(1);
    }
    expect(new Set(selection.picks.map((pick) => pick.id)).size).toBe(12);
    expect(selection.picks[0]!.reasons.length).toBeGreaterThan(3);
  });

  it("选段：优先取最长 drop 段中心（不够长则退回包络滑窗/默认 35% 处）", () => {
    const withDrop = planExcerpt({
      track: trackOf({ durationSec: 200, structure: { hasDrop: true, segments: [
        { type: "intro", startSec: 0, endSec: 20 },
        { type: "drop", startSec: 60, endSec: 140 },
        { type: "outro", startSec: 170, endSec: 200 },
      ] } }),
      targetSec: 60,
    });
    expect(withDrop.startSec).toBe(70);
    expect(withDrop.reason).toContain("drop");

    const outline = Array.from({ length: 60 }, (_, index) => (index > 20 && index < 40 ? -10 : -30));
    const byOutline = planExcerpt({
      track: trackOf({ durationSec: 120, structure: { hasDrop: false, segments: [] } }),
      targetSec: 30,
      outlineDb: outline,
    });
    expect(byOutline.startSec).toBeGreaterThan(30);
    expect(byOutline.reason).toContain("能量最高");

    const fallback = planExcerpt({ track: trackOf({ durationSec: 100, structure: null, loop: null }), targetSec: 30 });
    expect(fallback.startSec).toBe(35);
    expect(fallback.reason).toContain("证据不足");
  });

  it("外部模型标签：只并列留痕、不覆盖实测；本地置信度不高时才把模型风格记为 styleExternal", () => {
    const tracks = [
      { id: "a", sha256: "a".repeat(64), confidence: { style: "low" } },
      { id: "b", sha256: "b".repeat(64), confidence: { style: "high" } },
      { id: "c", sha256: "c".repeat(64), confidence: { style: "medium" } },
    ];
    const result = mergeExternalTags({
      tracks,
      external: {
        tracks: {
          ["a".repeat(64)]: { style: "cinematic-build", mood: "悲壮", genres: ["trailer"], instrumentation: ["strings"], valence: 0.2, arousal: 0.8, confidence: 0.91, source: "clap-v2" },
          ["b".repeat(64)]: { style: "festive-bright", confidence: 0.62, source: "clap-v2" },
        },
      },
    });
    expect(result.merged).toBe(2);
    expect(result.styleAdopted).toBe(1); // 只有 low 置信度那条采纳模型风格
    expect(tracks[0]!.styleExternal).toBe("cinematic-build");
    expect(tracks[0]!.styleSource).toBe("external-model");
    expect(tracks[0]!.externalTags.source).toBe("clap-v2");
    expect(tracks[1]!.styleExternal).toBeUndefined(); // high 置信度不被覆盖
    expect(tracks[1]!.externalTags.confidence).toBeCloseTo(0.62, 3);
    expect(tracks[2]!.externalTags).toBeUndefined(); // 没有模型输出就不塞空字段
  });

  it("选段增益：线性对齐目标响度，峰值越界时峰值保护优先（宁可略轻也不削波）", () => {
    const normal = computeExcerptGain({ integratedLufs: -12, truePeakDbtp: -6 }, { targetLufs: -14, truePeakDbtp: -1 });
    expect(normal.gainDb).toBe(-2);
    expect(normal.peakProtected).toBe(false);

    // 需要"加增益才能到目标响度，但真峰值已经贴顶"才算峰值保护生效
    const hot = computeExcerptGain({ integratedLufs: -18, truePeakDbtp: -0.2 }, { targetLufs: -14, truePeakDbtp: -1 });
    expect(hot.gainDb).toBe(-0.8);
    expect(hot.peakProtected).toBe(true);
    expect(hot.reason).toContain("峰值保护");

    const unknown = computeExcerptGain({ integratedLufs: null, truePeakDbtp: null });
    expect(unknown.gainDb).toBe(0);
    expect(unknown.reason).toContain("不猜增益");
  });
});

describe("曲库打标 · 索引契约（与运行时加载器同构）", () => {
  /** 造一个小曲库目录：写若干假音频文件 + 索引（不跑 ffmpeg，纯路径/契约测试）。 */
  const buildFakeLibrary = (root: string, names: string[], fileMode: "absolute" | "relative" = "relative") => {
    const tracks = names.map((name, index) => {
      const abs = join(root, name);
      writeFileSync(abs, `fake-audio-${index}-${name}`);
      return {
        id: `t-${index}`, file: fileMode === "absolute" ? abs : name, bytes: readFileSync(abs).length,
        sha256: createHash("sha256").update(readFileSync(abs)).digest("hex"), license: "royalty-free",
      };
    });
    writeFileSync(join(root, "tracks.json"), JSON.stringify({
      schemaVersion: "workloom.bgm-library/v1",
      library: { name: "测试曲库", provider: "owner-provided-pack", fileMode, tracks: tracks.length, sourceRoot: root },
      tracks,
    }, null, 2));
    return tracks;
  };

  it("自动发现：带索引且在位的目录被识别为可用；音频丢失的目录被标成需要 rebind", () => {
    const scanRoot = tempDir("bgm-scan-");
    const good = join(scanRoot, "用户的下载", "素材包");
    mkdirSync(good, { recursive: true });
    buildFakeLibrary(good, ["a.mp3", "b.mp3"]);

    const broken = join(scanRoot, "旧位置", "素材包");
    mkdirSync(broken, { recursive: true });
    const brokenTracks = buildFakeLibrary(broken, ["c.mp3"]);
    // 模拟"音频被挪走"：删掉音频，只留索引
    rmSync(join(broken, "c.mp3"));

    const found = discoverLibraries({ scanRoots: [scanRoot] });
    expect(found).toHaveLength(2);
    const usable = found.find((item) => item.dir === good)!;
    expect(usable.usable).toBe(true);
    expect(usable.sample).toEqual({ scanned: 2, present: 2, missing: 0 });
    const needing = found.find((item) => item.dir === broken)!;
    expect(needing.usable).toBe(false);
    expect(needing.needsRebind).toBe(true);
    expect(needing.note).toContain("rebind");

    // 只有真在位的那批才允许被加载器自动接上
    const inspected = inspectLibraryDir(broken)!;
    expect(inspected.tracks).toBe(brokenTracks.length);
  });

  it("rebind：素材换位置后按文件名+大小重新绑定（sha256 模式严格核验内容）", async () => {
    const work = tempDir("bgm-rebind-");
    const material = join(work, "素材");
    mkdirSync(material, { recursive: true });
    buildFakeLibrary(material, ["x.mp3", "y.mp3"], "absolute");
    const indexDir = join(work, "工位曲库");
    mkdirSync(indexDir, { recursive: true });
    // 索引搬到独立目录（模拟工位曲库与素材分离），仍记绝对路径
    const manifest = JSON.parse(readFileSync(join(material, "tracks.json"), "utf8"));
    writeFileSync(join(indexDir, "tracks.json"), JSON.stringify(manifest, null, 2));

    const moved = join(work, "外接盘", "素材");
    mkdirSync(path.dirname(moved), { recursive: true });
    renameSync(material, moved);

    const report = await rebindLibrary({ indexDir, newRoot: moved, verify: "sha256" });
    expect(report.matched).toBe(2);
    expect(report.missing).toBe(0);
    const doc = JSON.parse(readFileSync(join(indexDir, "tracks.json"), "utf8")) as {
      library: { sourceRoot: string; rebind: { matched: number; verify: string } };
      tracks: Array<{ file: string; relocatedFrom: string }>;
    };
    expect(doc.library.sourceRoot).toBe(moved);
    expect(doc.library.rebind).toMatchObject({ matched: 2, verify: "sha256" });
    expect(doc.tracks.every((track) => track.file.startsWith(moved))).toBe(true);
    expect(doc.tracks.every((track) => existsSync(track.file))).toBe(true);
    expect(doc.tracks[0]!.relocatedFrom.startsWith(material.slice(0, material.length))).toBe(true);

    // 新目录里找不到对应文件时如实报 missing（不猜、不硬绑）
    const empty = join(work, "空目录");
    mkdirSync(empty, { recursive: true });
    const missingReport = await rebindLibrary({ indexDir, newRoot: empty, verify: "size" });
    expect(missingReport.matched).toBe(0);
    expect(missingReport.missing).toBe(2);
  });

  it("pack：把索引进素材目录并转成相对路径（文件夹整体拷走后仍可用）", () => {
    const work = tempDir("bgm-pack-");
    const material = join(work, "素材");
    mkdirSync(material, { recursive: true });
    const tracks = buildFakeLibrary(material, ["p.mp3", "q.mp3"], "absolute");
    const indexDir = join(work, "索引");
    mkdirSync(indexDir, { recursive: true });
    writeFileSync(join(indexDir, "tracks.json"), readFileSync(join(material, "tracks.json")));
    writeFileSync(join(indexDir, "tag-evidence.json"), JSON.stringify({
      evidence: tracks.map((track) => ({ id: track.id, file: track.file })),
    }));

    const packed = packLibrary({ indexDir, destDir: material, overwrite: true });
    expect(packed.fileMode).toBe("relative");
    const doc = JSON.parse(readFileSync(join(material, "tracks.json"), "utf8")) as {
      library: { fileMode: string }; tracks: Array<{ file: string }>;
    };
    expect(doc.library.fileMode).toBe("relative");
    expect(doc.tracks.every((track) => !path.isAbsolute(track.file))).toBe(true);
    const evidence = JSON.parse(readFileSync(join(material, "tag-evidence.json"), "utf8")) as { evidence: Array<{ file: string }> };
    expect(evidence.evidence.every((entry) => !path.isAbsolute(entry.file))).toBe(true);

    // pack 之后这个目录自己就是合法曲库（自动发现能认出来）
    const found = discoverLibraries({ scanRoots: [work] });
    expect(found.map((item) => item.dir)).toContain(material);
  });

  it("扫描根可由 WORKLOOM_BGM_SCAN_ROOTS 覆盖（部署时可指定挂载盘/共享盘）", () => {
    expect(defaultScanRoots({ WORKLOOM_BGM_SCAN_ROOTS: "/tmp/a:/tmp/b" })).toEqual(["/tmp/a", "/tmp/b"]);
    const fakeHome = tempDir("bgm-home-");
    mkdirSync(join(fakeHome, "Downloads"), { recursive: true });
    const defaults = defaultScanRoots({ HOME: fakeHome });
    expect(defaults).toContain(join(fakeHome, "Downloads")); // 存在的目录才扫
    expect(defaults.every((dir) => existsSync(dir))).toBe(true);
  });

  const measurement = {
    input: "/music/旅拍/温暖.mp3", sha256: "b".repeat(64), bytes: 2048, durationSec: 180,
    format: { codec: "mp3", container: "mp3", bitrateKbps: 320, sampleRate: 44100, channels: 2 },
    loudness: { integratedLufs: -13.5, truePeakDbtp: -0.4, lra: 9 },
    peak: { peakDb: -0.3, flatFactor: 0 },
    clip: { clipped: false, reasons: [], flags: [] },
    envelope: { dynamicsDb: 10, quantiles: { p10: -20, p50: -14, p90: -10 }, outlineDb: Array.from({ length: 30 }, (_, i) => -16 + (i % 4)) },
    tempo: { bpm: 96, confidence: "high" },
    structure: { method: "rule-based", hasDrop: true, segments: [{ type: "intro", startSec: 0, endSec: 8 }] },
    voice: { activeRatio: 0.15 }, silence: { trailingSec: 0.3 },
    spectral: { centroidHz: 1500, flatness: 0.12 }, onsetRatePerSec: 3, energyScore: 0.55,
  };
  const tags = classifyTrack({ relativePath: "旅拍/温暖.mp3", measurement });
  const entry = buildIndexEntry({
    measurement, tags, root: "/music", relativePath: "旅拍/温暖.mp3",
    license: "royalty-free", licenseNote: "所有者声明可商用", licenseSource: "owner-pack", index: 3,
  });

  it("索引条目带齐运行时契约字段（按契约取用，不做未声明假设）", () => {
    for (const field of [
      "id", "title", "artist", "genre", "mood", "style", "styleLabel", "tags", "bpm", "durationSec",
      "license", "licenseNote", "file", "sha256", "bytes", "format", "loudness", "energyScore",
      "dynamicsDb", "structure", "voiceBandActivity", "loop", "confidence",
    ]) {
      expect(entry[field], `缺字段 ${field}`).toBeDefined();
    }
    expect(entry.loudness.integratedLufs).toBeCloseTo(-13.5, 3);
    expect(entry.structure.hasDrop).toBe(true);
    expect(entry.confidence.note).toBe("风格判定 ≥ medium");
  });

  it("写盘后运行时加载器能直接读到（三级曲库合并的第一级）", () => {
    const dir = tempDir("bgm-tag-lib-");
    const outDir = join(dir, "library");
    const written = writeLibrary({
      outDir,
      libraryName: "测试曲库",
      provider: "owner-provided-pack",
      fileMode: "absolute",
      result: {
        schemaVersion: "workloom.bgm-tag/v1", root: "/music", license: "royalty-free",
        licenseNote: "所有者声明可商用", licenseSource: "owner-pack",
        filters: DEFAULT_FILTERS, generatedAt: new Date().toISOString(),
        counts: { scanned: 1, tagged: 1, rejected: 0, failed: 0, byStyle: { "acoustic-warm": 1 } },
        tracks: [{ ...entry, energyBucket: "mid" }], rejected: [], errors: [],
        evidence: [{ id: entry.id, file: entry.file, sha256: entry.sha256, loudness: entry.loudness }],
      },
    });
    expect(written.files).toEqual(["tracks.json", "tag-evidence.json", "tag-report.json"]);
    const doc = JSON.parse(readFileSync(join(outDir, "tracks.json"), "utf8")) as {
      schemaVersion: string; library: { tracks: number; provider: string; fileMode: string }; tracks: unknown[];
    };
    expect(doc.schemaVersion).toBe("workloom.bgm-library/v1");
    expect(doc.library.tracks).toBe(1);
    expect(doc.library.fileMode).toBe("absolute");

    // 注意：加载器会合并"客户曲库 + 随仓精选 + 工位本地"三级，工位本地可能有真实曲库，
    // 因此这里按 id/来源断言本曲库，而不是断言全局总数（避免被真实环境带偏）。
    const loaded = loadAllLocalTracks({ WORKLOOM_BGM_LIBRARY_DIR: outDir });
    const custom = loaded.sources.find((source) => source.kind === "local-custom");
    expect(custom?.present).toBe(true);
    expect(custom?.tracks).toBe(1);
    const mine = loaded.tracks.find((track) => track.id === entry.id);
    expect(mine).toBeDefined();
    expect(mine!.license).toBe("royalty-free");
    expect(mine!.localPath).toBe("/music/旅拍/温暖.mp3"); // fileMode=absolute：索引记绝对路径，加载器原样采用
  });

  it("常量口径：过滤阈值与风格族表是可审计的显式取值（不藏在代码里）", () => {
    expect(DEFAULT_FILTERS.minDurationSec).toBe(30);
    expect(DEFAULT_FILTERS.maxFlatFactor).toBe(0.02);
    expect(Object.keys(STYLE_FAMILIES).length).toBe(12);
    for (const [style, profile] of Object.entries(STYLE_FAMILIES)) {
      expect(profile.bpm[0], style).toBeLessThan(profile.bpm[1]);
      expect(profile.energy[0], style).toBeLessThanOrEqual(profile.energy[1]);
    }
  });

  it("目录遍历：只收音频扩展名，隐藏文件与非音频不进扫描", () => {
    const dir = tempDir("bgm-tag-walk-");
    writeFileSync(join(dir, "a.mp3"), "x");
    writeFileSync(join(dir, "b.txt"), "x");
    writeFileSync(join(dir, ".DS_Store"), "x");
    writeFileSync(join(dir, "c.M4A"), "x");
    const files = listAudioFiles(dir).map((file) => file.split("/").pop());
    expect(files).toEqual(["a.mp3", "c.M4A"]);
  });
});

describe.runIf(HAS_FFMPEG)("曲库打标 · 真机量测（需要 ffmpeg）", () => {
  it("合成曲目打标 → 索引/证据/报告三件套齐备，且拍速/响度来自实测", async () => {
    const dir = tempDir("bgm-tag-real-");
    const wav = join(dir, "sample.wav");
    const recipe = {
      id: "food", genre: "美食 / 餐饮", bpm: 96, mode: "major", chords: ["I", "V", "vi", "IV"],
      instrumentation: ["pad", "bass", "pluck", "kick", "hat"], musicLevelDb: -22, duckingDb: 12,
    };
    await renderCompositionToWav({ plan: planComposition({ recipe, durationSec: 40, seed: 5 }), output: wav });
    expect(existsSync(wav)).toBe(true);

    const outDir = join(dir, "library");
    const result = await tagLibrary({
      root: dir, license: "workloom-self-generated", licenseNote: "合成测试素材",
      maxSeconds: 60, concurrency: 1, filters: { ...DEFAULT_FILTERS, minDurationSec: 10 },
    });
    expect(result.counts.scanned).toBe(1);
    expect(result.counts.tagged + result.counts.rejected).toBe(1);
    if (result.counts.tagged === 0) {
      // 合成素材若因响度/削波被剔除也必须给理由（不许静默丢弃）
      expect(result.rejected[0]!.reasons.length).toBeGreaterThan(0);
      return;
    }
    const track = result.tracks[0]!;
    expect(track.durationSec).toBeGreaterThan(35);
    expect(Math.abs(track.loudness.integratedLufs ?? 0)).toBeGreaterThan(0);
    expect(track.structure.segments.length).toBeGreaterThan(0);
    expect(result.evidence[0]!.sha256).toBe(track.sha256);

    writeLibrary({ outDir, result, libraryName: "真机测试曲库", fileMode: "relative" });
    const loaded = loadAllLocalTracks({ WORKLOOM_BGM_LIBRARY_DIR: outDir });
    const custom = loaded.sources.find((source) => source.kind === "local-custom");
    expect(custom?.tracks).toBe(1);
    expect(loaded.tracks.some((track) => track.id === track.id && track.libraryKind === "local-custom")).toBe(true);
    const report = JSON.parse(readFileSync(join(outDir, "tag-report.json"), "utf8")) as {
      counts: { scanned: number }; lowConfidenceTracks: unknown[];
    };
    expect(report.counts.scanned).toBe(1);
    expect(Array.isArray(report.lowConfidenceTracks)).toBe(true);
  }, 300_000);

  it("真机量测的清单与报告落在库里，低置信与剔除项都可追溯", async () => {
    const dir = tempDir("bgm-tag-real2-");
    const wav = join(dir, "quiet.wav");
    const recipe = {
      id: "documentary", genre: "纪录片", bpm: 72, mode: "minor", chords: ["i", "VI", "III", "VII"],
      instrumentation: ["pad", "bass"], musicLevelDb: -24, duckingDb: 10,
    };
    await renderCompositionToWav({ plan: planComposition({ recipe, durationSec: 52, seed: 9 }), output: wav });
    const result = await tagLibrary({
      root: dir, license: "workloom-self-generated", licenseNote: "合成测试素材",
      maxSeconds: 60, concurrency: 1,
    });
    const total = result.counts.tagged + result.counts.rejected;
    expect(total).toBe(1);
    for (const rejected of result.rejected) expect(rejected.reasons.length).toBeGreaterThan(0);
    for (const track of result.tracks) {
      expect(["high", "medium", "low"]).toContain(track.confidence.style);
      expect(track.license).toBe("workloom-self-generated");
    }
  }, 300_000);
});

process.on("exit", () => {
  for (const dir of tempDirs) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* 清理失败不影响测试结论 */
    }
  }
});
