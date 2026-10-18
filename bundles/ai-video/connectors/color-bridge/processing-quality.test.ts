import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { assessProcessingQuality, clarityFilter, resolveColorManagement } from "./processing-quality.mjs";
import { compareFrames, grade, frameDifference, probeMedia, resolveBinaries } from "./core.mjs";

const video = { colorPrimaries: "bt709", colorTransfer: "bt709", colorSpace: "bt709", colorRange: "tv", pixelFormat: "yuv420p" };
describe("色彩转换与后期损伤护栏", () => {
  it("已知 sRGB 转移、601 矩阵和 full range 分别进行真实转换", () => {
    const srgb = resolveColorManagement({ probe: { video: { ...video, colorTransfer: "iec61966-2-1" } } });
    expect(srgb.chain).toContain("transferin=iec61966-2-1"); expect(srgb.kind).toBe("sdr-conversion");
    const sd = resolveColorManagement({ probe: { video: { ...video, colorSpace: "smpte170m", colorPrimaries: "smpte170m", colorRange: "pc" } } });
    expect(sd.chain).toContain("matrixin=smpte170m:rangein=full"); expect(sd.chain).toContain("primaries=bt709");
  });
  it.each(["smpte2084", "arib-std-b67"])("%s 默认沿用旧像素路径，不隐式压缩动态范围", (transfer) => {
    const result = resolveColorManagement({ probe: { video: { ...video, colorPrimaries: "bt2020", colorSpace: "bt2020nc", colorTransfer: transfer } } });
    expect(result.kind).toBe("legacy-hdr-pass-through");
    expect(result.chain).toBe("null");
    expect(result.toneMap).toBeNull();
    expect(result.removedHdrSideData).toEqual([]);
  });
  it("未知 SDR 标签记录假设；HDR 缺色域或未支持传递函数不能伪装 709", () => {
    const unknown = resolveColorManagement({ probe: { video: { pixelFormat: "yuv420p" } } });
    expect(unknown.assumptions).toHaveLength(4);
    expect(unknown.observed.transfer).toBeNull(); expect(unknown.source.transfer).toBe("bt709");
    expect(() => resolveColorManagement({ probe: { video: { colorTransfer: "smpte2084" } } })).toThrow(/HDR.*缺少/);
    expect(() => resolveColorManagement({ probe: { video: { ...video, colorTransfer: "camera-mystery-log" } } })).toThrow(/不支持/);
  });
  it("conservative 保持旧语义，并暴露 light/medium/strong 三档去雾链", () => {
    expect(clarityFilter()).toBeNull();
    expect(clarityFilter("conservative")).toBe("unsharp=luma_msize_x=3:luma_msize_y=3:luma_amount=0.25:chroma_amount=0");
    expect(clarityFilter("conservative")).not.toBe(clarityFilter("light"));
    expect(clarityFilter("light")).toContain("curves=all=");
    expect(clarityFilter("light")).toContain("unsharp=3:3:0.18");
    expect(clarityFilter("medium")).toContain("unsharp=5:5:0.30");
    expect(clarityFilter("medium")).toContain("cas=strength=0.15");
    expect(clarityFilter("strong")).toContain("unsharp=7:7:0.45");
    expect(clarityFilter("strong")).toContain("cas=strength=0.25");
    expect(() => clarityFilter("extreme")).toThrow(/clarity/);
  });
  const metric = { yavg: 100, rmsContrast: 30, tonalRange: 80, satMean: 0.3, oversatPct: 1, colorfulness: 35, sharpness: 12, shadowClipPct: 0, highlightClipPct: 0 };
  const context = { sampledAt: [0, 1], sourceSha256: "a".repeat(64), outputSha256: "b".repeat(64), sourceDimensions: { width: 320, height: 240 }, outputDimensions: { width: 320, height: 240 } };
  it("逐帧证据保留最坏帧；不能用平均数掩盖局部糊化和裁切", () => {
    const report = assessProcessingQuality({ ...context, before: [metric, metric], after: [metric, { ...metric, sharpness: 6, highlightClipPct: 4 }] });
    expect(report.passed).toBe(false); expect(report.issues).toContain("detail_loss"); expect(report.issues).toContain("highlight_clipping_increase");
    expect(report.perFrame[0].issues).toHaveLength(0); expect(report.sourceSha256).toBe(context.sourceSha256);
    expect(report.thresholdProvenance).toContain("local conservative heuristics");
  });
  it("源镜变化被抵消后，后期校正亮度跳变单独留证；低纹理不假称细节退化", () => {
    const source = { ...metric, sharpness: 0 };
    const report = assessProcessingQuality({ ...context, before: [source, { ...source, yavg: 150 }], after: [source, { ...source, yavg: 170 }] });
    expect(report.issues).toContain("temporal_correction_jump"); expect(report.perFrame[0].delta.detailRatio).toBeNull();
    expect(report.issues).not.toContain("detail_loss");
  });
  it("非数值指标和帧数错配必须报错，不能返回通过", () => {
    expect(() => assessProcessingQuality({ ...context, before: [metric], after: [metric] })).toThrow(/不一致/);
    expect(() => assessProcessingQuality({ ...context, before: [metric, metric], after: [metric, { ...metric, sharpness: NaN }] })).toThrow(/非数值/);
  });
});

const bins = resolveBinaries();
const hasEngine = (() => { try { execFileSync(bins.ffmpeg, ["-v", "error", "-version"], { stdio: "ignore" }); return true; } catch { return false; } })();
describe.runIf(hasEngine)("真实 ffmpeg 后期颜色与质量证据", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "color-quality-")), source = path.join(dir, "source.mp4");
  const sha = (file: string) => createHash("sha256").update(fs.readFileSync(file)).digest("hex");
  beforeAll(() => execFileSync(bins.ffmpeg, ["-hide_banner", "-v", "error", "-y", "-f", "lavfi", "-i", "testsrc2=size=320x240:rate=12:duration=1.5",
    "-c:v", "libx264", "-crf", "10", "-pix_fmt", "yuv420p", "-color_primaries", "bt709", "-color_trc", "bt709", "-colorspace", "bt709", source]));
  afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));
  it("light 清晰度报告给出实际前后帧、哈希、规格及阈值；原片字节保持", async () => {
    const before = sha(source), output = path.join(dir, "clarity.mp4");
    const result = await grade({ input: source, output, profile: "natural", intensity: 0.1, clarity: "light", qualityGuard: "report", bins });
    expect(sha(source)).toBe(before); expect(result.sourceSha256).toBe(before);
    expect(result.sha256).toBe(sha(output)); expect(result.processingQuality.reviewed).toBe(true);
    expect(result.processingQuality.perFrame).toHaveLength(result.processingQuality.sampleCount);
    expect(result.processingQuality.sourceDimensions.width).toBe(320); expect(result.processingQuality.outputDimensions.width).toBe(320);
    expect(result.chain).toContain("curves=all='0/0 0.20/0.18");
    expect(result.chain).toContain("unsharp=3:3:0.18");
    expect(result.colorManagement.destination).toMatchObject({ transfer: "bt709", range: "limited" });
  });
  it("纯技术 grade 可只做色彩管理与保守清晰度，无 look、LUT 或自动修正", async () => {
    const before = sha(source), output = path.join(dir, "technical-only.mp4");
    const result = await grade({ input: source, output, profile: null, lutPath: null, corrections: {}, auto: false,
      clarity: "conservative", qualityGuard: "report", bins });
    expect(sha(source)).toBe(before); expect(result).toMatchObject({ profile: null, lut: null, auto: null, sourceSha256: before, clarity: "conservative" });
    expect(result.chain).toContain(",null,unsharp=luma_msize_x=3:luma_msize_y=3:luma_amount=0.25:chroma_amount=0");
    expect(result.chain).not.toMatch(/colorbalance=|curves=|eq=/);
    expect(result.processingQuality).toMatchObject({ reviewed: true, outputSha256: sha(output) });
    await expect(grade({ input: source, output: path.join(dir, "technical-invalid.mp4"), profile: null, intensity: NaN, bins })).rejects.toMatchObject({ code: "bad_request" });
  });
  it("实际 SDR 对照图分别转换两个输入并记录源/输出 SHA，不依赖已删除的硬编码输入常量", async () => {
    const output = path.join(dir, "sdr-compare.png"), before = sha(source);
    const result = await compareFrames({ before: source, after: source, at: 0.5, output, bins });
    expect(result).toMatchObject({ path: output, sha256: sha(output), beforeSha256: before, afterSha256: before });
    expect(result.colorManagement.before.source.transfer).toBe("bt709");
    expect((await probeMedia(output, { bins })).video.width).toBe(1708); expect(sha(source)).toBe(before);
  });
  it("真实 CLI compare 返回有效 PNG 与各输入色彩证据，原片保持只读", () => {
    const output = path.join(dir, "cli-compare.png"), before = sha(source);
    const cli = path.join(path.dirname(fileURLToPath(import.meta.url)), "cli.mjs");
    const result = JSON.parse(execFileSync(process.execPath, [cli, "compare", "--before", source, "--after", source,
      "--at", "0.5", "--out", output, "--json"], { encoding: "utf8", env: { ...process.env, WORKLOOM_COLOR_ALLOWED_ROOTS: dir } }));
    expect(result).toMatchObject({ path: fs.realpathSync(output), sha256: sha(output), beforeSha256: before, afterSha256: before });
    expect(result.colorManagement.before.source.transfer).toBe("bt709"); expect(sha(source)).toBe(before);
  });
  it("对照输出不得经路径、软链或硬链覆盖任一输入，非法时间也拒绝", async () => {
    const after = path.join(dir, "compare-after.mp4"), beforeHash = sha(source); fs.copyFileSync(source, after);
    const symbolic = path.join(dir, "compare-symbolic.png"), hard = path.join(dir, "compare-hard.png"); fs.symlinkSync(source, symbolic); fs.linkSync(after, hard);
    for (const output of [source, after, symbolic, hard]) await expect(compareFrames({ before: source, after, output, bins })).rejects.toMatchObject({ code: "overwrite_source_forbidden" });
    await expect(compareFrames({ before: source, after, output: path.join(dir, "bad-time.png"), at: -1, bins })).rejects.toMatchObject({ code: "bad_request" });
    expect(sha(source)).toBe(beforeHash); expect(sha(after)).toBe(beforeHash);
  });
  it("report 模式保留已有成片并上报损伤，block 仅在明确请求时拒绝后期产物", async () => {
    const report = path.join(dir, "damaged-report.mp4"), blocked = path.join(dir, "damaged-block.mp4");
    const result = await grade({ input: source, output: report, corrections: { eq: { brightness: 0.8 } }, qualityGuard: "report", bins });
    expect(fs.existsSync(report)).toBe(true); expect(result.processingQuality.passed).toBe(false);
    expect(result.processingQuality.issues).toContain("highlight_clipping_increase");
    await expect(grade({ input: source, output: blocked, corrections: { eq: { brightness: 0.8 } }, qualityGuard: "block", bins })).rejects.toMatchObject({ code: "quality_regression" });
    expect(fs.existsSync(blocked)).toBe(false);
  });
  it.each(["smpte2084", "arib-std-b67"])("真实 %s 10-bit BT.2020 输入默认不加入 tone map", async (transfer) => {
    const hdr = path.join(dir, `${transfer}.mkv`), output = path.join(dir, `${transfer}.mp4`);
    const chain = `zscale=primariesin=bt709:transferin=bt709:matrixin=bt709:rangein=limited:primaries=bt2020:transfer=${transfer}:matrix=bt2020nc:range=limited,format=yuv420p10le`;
    execFileSync(bins.ffmpeg, ["-hide_banner", "-v", "error", "-y", "-i", source, "-vf", chain, "-c:v", "ffv1", "-color_primaries", "bt2020", "-color_trc", transfer, "-colorspace", "bt2020nc", hdr]);
    const sourceSha = sha(hdr), result = await grade({ input: hdr, output, profile: "natural", intensity: 0.1, qualityGuard: "report", bins });
    expect(sha(hdr)).toBe(sourceSha); expect(result.colorManagement.kind).toBe("legacy-hdr-pass-through");
    expect(result.chain).not.toContain("format=gbrpf32le"); expect(result.chain).not.toContain("tonemap=");
    const probed = await probeMedia(output, { bins });
    expect(probed.video).toMatchObject({ width: 320, height: 240, colorTransfer: "bt709", colorPrimaries: "bt709", colorSpace: "bt709", colorRange: "tv" });
    expect(result.processingQuality.reviewed).toBe(true);
    const compare = await compareFrames({ before: hdr, after: output, at: 0.5, output: path.join(dir, `${transfer}-compare.png`), bins });
    expect(compare.colorManagement.before.kind).toBe("legacy-hdr-pass-through"); expect(compare.colorManagement.after.source.transfer).toBe("bt709");
    expect(compare.beforeSha256).toBe(sourceSha); expect(sha(hdr)).toBe(sourceSha); expect(compare.sha256).toBe(sha(compare.path));
  });
  it("同画面 full-range 输入经过范围转换后亮度保持，不能只贴 tv 标签", async () => {
    const full = path.join(dir, "full.mp4"), output = path.join(dir, "full-normalized.mp4");
    execFileSync(bins.ffmpeg, ["-hide_banner", "-v", "error", "-y", "-i", source, "-vf", "scale=in_range=tv:out_range=pc", "-c:v", "libx264", "-crf", "10",
      "-color_range", "pc", "-color_primaries", "bt709", "-color_trc", "bt709", "-colorspace", "bt709", full]);
    const result = await grade({ input: full, output, profile: "natural", intensity: 0.001, qualityGuard: "report", bins });
    expect(result.colorManagement.source.range).toBe("full"); expect(result.chain).toContain("rangein=full");
    expect(Math.abs(result.processingQuality.perFrame[0].delta.luma)).toBeLessThan(2);
    const difference = await frameDifference({ before: full, after: output, at: [0.5], bins });
    expect(difference.meanAbsDiff).toBeLessThan(5);
  });
  it("未知源空间处理失败前不产出伪装 709 文件，非法模式也不能写出", async () => {
    const output = path.join(dir, "unsupported.mp4");
    await expect(grade({ input: source, output, profile: "natural", sourceTransfer: "mystery-log", bins })).rejects.toMatchObject({ code: "unsupported_color_space" });
    await expect(grade({ input: source, output, profile: "natural", qualityGuard: "automatic-retry", bins })).rejects.toMatchObject({ code: "bad_request" });
    expect(fs.existsSync(output)).toBe(false);
  });
});
