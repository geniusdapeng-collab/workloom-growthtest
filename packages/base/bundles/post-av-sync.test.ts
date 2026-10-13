/**
 * 平台侧音画对齐（post-bridge/av-sync.mjs）回归：
 *  · 纯逻辑（互相关求时延 + 漂移判定）与基座 TS 版**逐值等价**——两侧口径漂移是这类机制最容易出的静默故障；
 *  · 拼接方案必须是"画面 copy + 声音样点级 concat 滤镜"（真机事故：`-c copy` 直拼导致逐镜漂移）；
 *  · 源码级守卫：硬切/淡入淡出分支不许再出现"整条 demuxer copy"的写法。
 * 本组不触 DB；纯逻辑与源码守卫不依赖 ffmpeg，实际加工回归明确要求本地 ffmpeg/ffprobe。
 */
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";

import {
  AV_SYNC_POLICY,
  AV_SYNC_FAILURE_KINDS,
  buildSampleAccurateConcatPlan,
  classifyAvSyncFailure,
  crossCorrelationLag as bundleLag,
  evaluateAvSync as bundleEvaluate,
  measureAssembledAvSync,
  verifyAssembledAvSync,
} from "../../../bundles/ai-video/connectors/post-bridge/av-sync.mjs";
import {
  crossCorrelationLag as baseLag,
  evaluateAvSync as baseEvaluate,
} from "../../../packages/video-studio/src/av-sync.js";
import { bundlesRoot } from "./assembly.js";
import { assembleTimeline, normaliseShots } from "../../../bundles/ai-video/connectors/post-bridge/core.mjs";

const SR = 16000;
const BRIDGE_DIR = join(bundlesRoot(), "ai-video/connectors/post-bridge");

/** 合成"有声信号"：低频脉冲 + 噪声（与基座单测同构，便于互证）。 */
function signal(seconds: number, seed = 7): Float32Array {
  const n = Math.round(seconds * SR);
  const out = new Float32Array(n);
  let state = seed;
  for (let i = 0; i < n; i += 1) {
    state = (state * 1103515245 + 12345) % 2147483648;
    const noise = state / 2147483648 - 0.5;
    const pulse = Math.sin((2 * Math.PI * 3 * i) / SR) * Math.sin((2 * Math.PI * 0.7 * i) / SR);
    out[i] = 0.6 * pulse + 0.4 * noise;
  }
  return out;
}

function shift(x: Float32Array, samples: number): Float32Array {
  const out = new Float32Array(x.length);
  for (let i = 0; i < x.length; i += 1) {
    const src = i - samples;
    out[i] = src >= 0 && src < x.length ? x[src]! : 0;
  }
  return out;
}

describe("平台侧音画对齐 · 与基座同口径", () => {
  it("互相关求时延：两侧实现对同一输入给出相同结果（±80 样点 = +5ms）", () => {
    const ref = signal(1.5);
    const target = shift(ref, 80);
    const a = bundleLag(ref, target, { sampleRate: SR, maxLagMs: 200 });
    const b = baseLag(ref, target, { sampleRate: SR, maxLagMs: 200 });
    expect(Math.abs(a.lagMs - 5)).toBeLessThan(0.5);
    expect(a.lagMs).toBeCloseTo(b.lagMs, 3);
    expect(a.correlation).toBeCloseTo(b.correlation, 4);
  });

  it("逐镜 +8ms 累计漂移（真机事故形态）在两侧都判失败，且理由同类", () => {
    const samples = Array.from({ length: 15 }, (_, index) => ({
      shotId: `NC-${String(index + 1).padStart(2, "0")}`,
      index,
      lagMs: index * 8,
      correlation: 0.9,
    }));
    const a = bundleEvaluate(samples, AV_SYNC_POLICY);
    const b = baseEvaluate(samples);
    expect(a.ok).toBe(false);
    expect(b.ok).toBe(false);
    expect(a.monotonic).toBe(b.monotonic);
    expect(a.maxAbsLagMs).toBeCloseTo(b.maxAbsLagMs, 3);
    expect(a.violations.join("｜")).toMatch(/累计漂移|单调漂移/);
    expect(b.violations.join("｜")).toMatch(/累计漂移|单调漂移/);
  });

  it("无取样 → 两侧都判失败（不允许「没测就当过」）", () => {
    expect(bundleEvaluate([]).ok).toBe(false);
    expect(baseEvaluate([]).ok).toBe(false);
  });
});

describe("平台侧拼接方案（样点级对齐）", () => {
  const clips = [
    { shotId: "A", path: "/tmp/a.mp4", durationSec: 3.75 },
    { shotId: "B", path: "/tmp/b.mp4", durationSec: 2.5 },
  ];
  const plan = buildSampleAccurateConcatPlan({
    listFile: "/tmp/list.txt", clips, output: "/tmp/out.mp4", workDir: "/tmp/work", fps: 30,
  });

  it("画面：concat demuxer + `-c:v copy`（帧级无损、不重编码）", () => {
    const args = plan.videoArgs.join(" ");
    expect(args).toContain("-f concat");
    expect(args).toContain("-c:v copy");
    expect(args).toContain("-an");
    expect(args).not.toContain("libx264");
    expect(plan.concatList).toContain("file '/tmp/a.mp4'\nduration 3.750000");
    expect(plan.concatList).toContain("file '/tmp/b.mp4'\nduration 2.500000");
  });

  it("声音：每段按画面时长 atrim+apad，再走 concat 滤镜（样点级）", () => {
    const filter = plan.audioArgs[plan.audioArgs.indexOf("-filter_complex") + 1] as string;
    expect(filter).toContain("atrim=end=3.750000");
    expect(filter).toContain("apad=whole_dur=3.750000");
    expect(filter).toContain("atrim=end=2.500000");
    expect(filter).toContain("concat=n=2:v=0:a=1");
  });

  it("合流：画面 copy + 音轨重编码 + `-shortest`", () => {
    const args = plan.muxArgs.join(" ");
    expect(args).toContain("-c:v copy");
    expect(args).toContain("-c:a aac");
    expect(args).toContain("-shortest");
  });
});

describe("源码守卫：拼接分支不许再整条 demuxer copy", () => {
  const source = readFileSync(join(BRIDGE_DIR, "core.mjs"), "utf8");

  it("assembleTimeline 走 assembleSampleAccurate（样点级）", () => {
    expect(source).toContain("assembleSampleAccurate(");
    expect(source).toContain("buildSampleAccurateConcatPlan");
    expect(source).not.toContain("verifyAssembledAvSync");
    expect(source).not.toContain("measureAssembledAvSync");
  });

  it("不再出现「concat demuxer + 双流 -c copy」的历史写法", () => {
    /** 历史写法：`-f concat ... -c copy -movflags +faststart`（画面与声音一起直拷 → 逐镜漂移） */
    expect(source).not.toMatch(/"-f",\s*"concat",[\s\S]{0,200}?"-c",\s*"copy",\s*"-movflags"/);
  });
});

describe("实测不可执行的降级路径（三态口径：达标 / 偏移 / 测不了）", () => {
  it("classifyAvSyncFailure：只有真实偏移才算 drift，其余归 unverifiable", () => {
    expect(classifyAvSyncFailure({ ok: true, samples: [{ shotId: "A" }], violations: [] })).toBeNull();
    expect(classifyAvSyncFailure({
      ok: false, samples: [{ shotId: "A" }], violations: ["单镜偏移超阈值：A 120.0ms（上限 40ms）"],
    })).toBe(AV_SYNC_FAILURE_KINDS.drift);
    expect(classifyAvSyncFailure({
      ok: false, samples: [{ shotId: "A" }], violations: ["单调漂移：5/5 段偏移同向且累计 33.0ms"],
    })).toBe(AV_SYNC_FAILURE_KINDS.drift);
    expect(classifyAvSyncFailure({ ok: false, samples: [], violations: ["没有任何可测窗口（未提供取样）"] }))
      .toBe(AV_SYNC_FAILURE_KINDS.unverifiable);
  });

  it("环境缺 ffmpeg → 归 unverifiable（而不是误报成偏移）", async () => {
    const report = await measureAssembledAvSync({
      ffmpeg: "/nonexistent/ffmpeg-binary",
      output: "/tmp/does-not-exist.mp4",
      clips: [{ shotId: "A", path: "/tmp/a.mp4", durationSec: 3 }],
      starts: [0],
    });
    expect(report.ok).toBe(false);
    expect(report.kind).toBe(AV_SYNC_FAILURE_KINDS.unverifiable);
    expect(String(report.reason)).toMatch(/解码母版失败/);
  });

  it("默认（严格）抛 av_sync_unverifiable；只有显式 allowUnverified 才降级且带 degraded 标记", async () => {
    const base = {
      ffmpeg: "/nonexistent/ffmpeg-binary",
      output: "/tmp/does-not-exist.mp4",
      clips: [{ shotId: "A", path: "/tmp/a.mp4", durationSec: 3 }],
      starts: [0],
    };
    await expect(verifyAssembledAvSync(base)).rejects.toMatchObject({ code: "av_sync_unverifiable" });
    const degraded = await verifyAssembledAvSync({ ...base, allowUnverified: true });
    /** 降级返回值**绝不能**长成"通过"（ok 必须是 null，不是 true） */
    expect(degraded.ok).toBeNull();
    expect(degraded.degraded).toBe(true);
    expect(degraded.kind).toBe(AV_SYNC_FAILURE_KINDS.unverifiable);
    expect(String(degraded.reason)).toMatch(/解码母版失败/);
  });

  it("源码守卫：平台侧拼接写真实处理回执，旧诊断开关不重新建立默认品质门", () => {
    const core = readFileSync(join(BRIDGE_DIR, "core.mjs"), "utf8");
    expect(core).toContain("writeAvSyncReport");
    expect(core).toContain(".av-sync.json");
    expect(core).toContain("allowUnverifiedAvSync");
    expect(core).not.toContain("av_sync_unverifiable");
    expect(core).toContain("audioAlignmentMeasured: false");
    expect(core).toContain("processingSucceeded: true");
  });
});

describe("正式拼接的实际处理与工作目录边界", () => {
  const ffmpeg = process.env.WORKLOOM_POST_FFMPEG_PATH || "ffmpeg", ffprobe = process.env.WORKLOOM_POST_FFPROBE_PATH || "ffprobe";
  const hasTools = [ffmpeg, ffprobe].every(binary => spawnSync(binary, ["-version"], { stdio: "ignore" }).status === 0);
  const hash = (file: string) => createHash("sha256").update(readFileSync(file)).digest("hex");
  it.skipIf(!hasTools)("真实黑帧无声源经请求归一化与 hard/fade 拼接，不跑默认 PCM 或品质审计且源字节不变", async () => {
    const dir = mkdtempSync(join(tmpdir(), "post-default-composition-")), source = join(dir, "black.mp4");
    try {
      const encoded = spawnSync(ffmpeg, ["-v", "error", "-nostdin", "-n", "-f", "lavfi", "-i", "color=black:s=64x64:r=12:d=0.5", "-an", "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", source], { encoding: "utf8", timeout: 30_000 });
      expect(encoded.status, encoded.stderr).toBe(0);
      const before = hash(source), wrapper = join(dir, "actual-no-quality.mjs"), commands = join(dir, "commands.jsonl");
      writeFileSync(wrapper, `#!${process.execPath}\nimport {spawnSync} from 'node:child_process';import fs from 'node:fs';const args=process.argv.slice(2);fs.appendFileSync(${JSON.stringify(commands)},JSON.stringify(args)+'\\n');if(args.includes('f32le')||args.includes('-count_frames')||args.some(arg=>/signalstats|psnr|astats|ebur128|framemd5|blurdetect/.test(arg))){process.stderr.write('forbidden default quality audit');process.exit(87)}const r=spawnSync(${JSON.stringify(ffmpeg)},args,{stdio:'inherit'});if(r.error){process.stderr.write(r.error.message);process.exit(88)}process.exit(r.status??89);\n`); chmodSync(wrapper, 0o755);
      const bins = { ffmpeg: wrapper, ffprobe }, root = realpathSync(dir);
      const clips = await normaliseShots({ shots: [{ shotId: "A", path: source }, { shotId: "B", path: source }], project: { resolution: [64, 64], fps: 12 }, workDir: dir, bins,
        env: { ...process.env, WORKLOOM_POST_ALLOWED_ROOTS: root } });
      expect(clips).toHaveLength(2); expect(clips.every((clip: { path: string }) => clip.path.startsWith(root))).toBe(true);
      for (const mode of ["hard", "fade"]) {
        const output = join(dir, `${mode}.mp4`), result = await assembleTimeline({ clips, transitions: { mode, fadeSec: 0.1 }, output, resolution: [64, 64], fps: 12, bins });
        expect(result.avSync).toMatchObject({ processingSucceeded: true, audioAlignmentMeasured: false, qualityReviewed: false });
        expect(existsSync(output)).toBe(true);
        expect(JSON.parse(readFileSync(output.replace(/\.mp4$/, ".av-sync.json"), "utf8"))).toMatchObject({ schemaVersion: "workloom.composition-process/v1", processingSucceeded: true, audioAlignmentMeasured: false });
      }
      expect(hash(source)).toBe(before);
      const failed = join(dir, "actual-failure.mjs");
      writeFileSync(failed, `#!${process.execPath}\nimport {spawnSync} from 'node:child_process';const args=process.argv.slice(2);if(args.some(arg=>arg.includes('concat=n=2:v=0:a=1'))){process.stderr.write('actual audio concat failure');process.exit(51)}const r=spawnSync(${JSON.stringify(ffmpeg)},args,{stdio:'inherit'});process.exit(r.status??52);\n`); chmodSync(failed, 0o755);
      const failedOutput = join(dir, "failed.mp4");
      await expect(assembleTimeline({ clips, transitions: { mode: "hard" }, output: failedOutput, resolution: [64, 64], fps: 12, bins: { ffmpeg: failed, ffprobe } })).rejects.toMatchObject({ code: "ffmpeg_failed" });
      expect(existsSync(failedOutput)).toBe(false); expect(existsSync(failedOutput.replace(/\.mp4$/, ".av-sync.json"))).toBe(false); expect(hash(source)).toBe(before);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  }, 120_000);
  it("越权 workDir 在创建 norm 或任何产物前拒绝", async () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), "post-work-auth-")));
    try {
      const allowed = join(dir, "allowed"), denied = join(dir, "denied", "must-not-exist"); mkdirSync(allowed);
      await expect(normaliseShots({ shots: [{ shotId: "A", path: join(dir, "unused-source.mp4") }], project: { resolution: [64, 64] }, workDir: denied, bins: { ffmpeg: "must-not-run", ffprobe: "must-not-run" }, env: { WORKLOOM_POST_ALLOWED_ROOTS: allowed } })).rejects.toMatchObject({ code: "path_not_allowed" });
      expect(existsSync(join(dir, "denied"))).toBe(false);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
  it.each(["norm", "work"])("允许根下的 %s 符号链接不能冒充合法工作路径，即使仍指向根内", async kind => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), "post-work-symlink-")));
    try {
      const work = join(dir, "work"), actual = join(dir, "actual"); mkdirSync(actual);
      if (kind === "norm") { mkdirSync(work); symlinkSync(actual, join(work, "norm")); } else symlinkSync(actual, work);
      await expect(normaliseShots({ shots: [{ shotId: "A", path: join(dir, "unused-source.mp4") }], project: { resolution: [64, 64] }, workDir: work, bins: { ffmpeg: "must-not-run", ffprobe: "must-not-run" }, env: { WORKLOOM_POST_ALLOWED_ROOTS: dir } })).rejects.toMatchObject({ code: "path_not_allowed" });
      expect(existsSync(join(actual, "norm"))).toBe(false);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});
