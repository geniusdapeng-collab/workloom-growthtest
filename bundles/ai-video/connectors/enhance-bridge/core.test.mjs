import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { analyzeCadence, enhanceImage, enhanceVideo, EnhanceError, estimateEnhanceVideoBudget } from "./core.mjs";

const ffmpeg = process.env.WORKLOOM_ENHANCE_FFMPEG_PATH || "ffmpeg";
const ffprobe = process.env.WORKLOOM_ENHANCE_FFPROBE_PATH || "ffprobe";
const hasMediaTools = spawnSync(ffmpeg, ["-version"], { stdio: "ignore" }).status === 0
  && spawnSync(ffprobe, ["-version"], { stdio: "ignore" }).status === 0;

function run(bin, args) {
  const result = spawnSync(bin, args, { encoding: "utf8", timeout: 30_000 });
  assert.equal(result.status, 0, result.stderr || result.error?.message);
}

test("CFR analysis rejects variable timestamps without retiming", () => {
  assert.deepEqual(analyzeCadence(["0", "0.5", "1"], "2/1").frameCount, 3);
  assert.throws(() => analyzeCadence(["0", "0.5", "1.2"], "2/1"),
    (error) => error instanceof EnhanceError && error.code === "vfr_unsupported");
});

test("text content and malformed dimensions fail before processing", async () => {
  const base = { input: "/missing/source.mp4", outputDir: "/tmp/enhanced", scopeId: "tenant/project",
    targetWidth: 128, targetHeight: 128, kind: "text" };
  await assert.rejects(enhanceVideo(base), (error) => error instanceof EnhanceError && error.code === "unsupported_content");
  await assert.rejects(enhanceVideo({ ...base, kind: "animation", targetWidth: 127 }),
    (error) => error instanceof EnhanceError && error.code === "bad_request");
});

test("M3 UHD budget preflight blocks full-length x4plus clips", () => {
  const estimate = estimateEnhanceVideoBudget({ sourcePixels: 1920 * 1080, frameCount: 192,
    modelName: "realesrgan-x4plus", totalTimeoutMs: 3_600_000, cpuModel: "Apple M3", memoryBytes: 8 * 1024 ** 3 });
  assert.equal(estimate.exceedsBudget, true);
  assert.ok(estimate.estimatedSec > estimate.budgetSec);
  assert.equal(estimateEnhanceVideoBudget({ sourcePixels: 1920 * 1080, frameCount: 192,
    modelName: "realesrgan-x4plus", totalTimeoutMs: 3_600_000, cpuModel: "Apple M4", memoryBytes: 8 * 1024 ** 3 }), null);
});

test("native sized MP4 keeps video and audio and returns verified provenance", { skip: !hasMediaTools }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "workloom-enhance-test-"));
  try {
    const input = path.join(root, "input.mp4");
    run(ffmpeg, ["-hide_banner", "-v", "error", "-y", "-f", "lavfi", "-i", "testsrc=size=64x64:rate=3:duration=1",
      "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000:duration=1", "-c:v", "libx264", "-pix_fmt", "yuv420p",
      "-c:a", "aac", "-shortest", input]);
    const options = {
      input, outputDir: path.join(root, "work", "enhanced"), scratchRoot: path.join(root, "scratch"),
      scopeId: "tenant-1/project-1", targetWidth: 64, targetHeight: 64, kind: "live-action",
      bins: { ffmpeg, ffprobe }, maxScratchBytes: 32 * 1024 ** 2,
      maxOutputBytes: 32 * 1024 ** 2, reserveBytes: 32 * 1024 ** 2,
    };
    const first = await enhanceVideo(options);
    const second = await enhanceVideo(options);
    const bytes = await readFile(first.output);
    const metadata = JSON.parse(await readFile(first.provenancePath, "utf8"));
    assert.equal(first.sha256, createHash("sha256").update(bytes).digest("hex"));
    assert.equal(first.sha256, metadata.output.sha256);
    assert.equal(first.sourceSha256, createHash("sha256").update(await readFile(input)).digest("hex"));
    assert.equal(first.processingMode, "passthrough");
    assert.equal(first.model, null);
    assert.equal(first.modelScale, null);
    assert.equal(first.engine.name, "source-copy");
    assert.equal(first.receipt.localVerified, true);
    assert.equal(first.receipt.provenancePath, first.provenancePath);
    assert.equal(first.diskPreflight.reserveBytes, options.reserveBytes);
    assert.deepEqual(first.receipt.diskPreflight, first.diskPreflight);
    assert.deepEqual(metadata.process.diskPreflight, first.diskPreflight);
    assert.equal(first.probe.width, 64);
    assert.equal(first.probe.height, 64);
    assert.equal(first.probe.audio.length, 1);
    assert.equal(first.probe.audio[0].codec, "aac");
    assert.ok((await stat(first.output)).size > 0);
    assert.equal(second.reused, true);
    assert.deepEqual(second.receipt, first.receipt);
    assert.deepEqual(second.diskPreflight, first.diskPreflight);
    assert.equal(second.output, first.output);
    assert.ok(first.output.startsWith(path.join(root, "work", "enhanced") + path.sep));
    metadata.receipt.localVerified = false;
    await writeFile(first.provenancePath, JSON.stringify(metadata));
    await assert.rejects(enhanceVideo(options),
      (error) => error instanceof EnhanceError && error.code === "cache_corrupt");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("larger source uses native contain and preserves the audio track", { skip: !hasMediaTools }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "workloom-enhance-native-"));
  try {
    const input = path.join(root, "input.mp4");
    run(ffmpeg, ["-hide_banner", "-v", "error", "-y", "-f", "lavfi", "-i", "testsrc=size=96x64:rate=3:duration=1",
      "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000:duration=1", "-c:v", "libx264", "-pix_fmt", "yuv420p",
      "-c:a", "aac", "-shortest", input]);
    const result = await enhanceVideo({ input, outputDir: path.join(root, "work", "enhanced"),
      scratchRoot: path.join(root, "scratch"), scopeId: "tenant/project", targetWidth: 64, targetHeight: 64,
      kind: "live-action", bins: { ffmpeg, ffprobe }, maxScratchBytes: 32 * 1024 ** 2,
      maxOutputBytes: 32 * 1024 ** 2, reserveBytes: 32 * 1024 ** 2 });
    assert.equal(result.processingMode, "native-resize");
    assert.equal(result.model, null);
    assert.equal(result.probe.width, 64);
    assert.equal(result.probe.height, 64);
    assert.equal(result.probe.audio.length, 1);
    assert.equal(result.probe.audio[0].codec, "aac");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("M3 preflight rejects an eight-second 1080p live-action clip before GPU work",
  { skip: !hasMediaTools || process.env.WORKLOOM_ENHANCE_PREFLIGHT_TEST !== "1" || os.cpus()[0]?.model !== "Apple M3" },
  async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "workloom-enhance-preflight-"));
    try {
      const input = path.join(root, "source.mp4");
      run(ffmpeg, ["-hide_banner", "-v", "error", "-y", "-f", "lavfi",
        "-i", "color=c=navy:size=1920x1080:rate=24:duration=8", "-f", "lavfi",
        "-i", "sine=frequency=440:sample_rate=48000:duration=8", "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p",
        "-c:a", "aac", "-shortest", input]);
      await assert.rejects(enhanceVideo({ input, outputDir: path.join(root, "work", "enhanced"),
        scratchRoot: path.join(root, "scratch"), scopeId: "tenant/project", targetWidth: 3840, targetHeight: 2160,
        kind: "live-action", bins: { ffmpeg, ffprobe }, maxScratchBytes: 32 * 1024 ** 2,
        maxOutputBytes: 32 * 1024 ** 2, reserveBytes: 32 * 1024 ** 2 }),
      (error) => error instanceof EnhanceError && error.code === "time_budget_exceeded"
        && error.details?.exceedsBudget === true && error.details.estimatedSec > error.details.budgetSec);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

test("local GPU enhances a still and a voiced CFR clip", { skip: !hasMediaTools || process.env.WORKLOOM_ENHANCE_GPU_TEST !== "1" }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "workloom-enhance-gpu-"));
  try {
    const imageInput = path.join(root, "source.png");
    const videoInput = path.join(root, "source.mp4");
    run(ffmpeg, ["-hide_banner", "-v", "error", "-y", "-f", "lavfi", "-i", "testsrc=size=64x64:rate=1",
      "-frames:v", "1", imageInput]);
    run(ffmpeg, ["-hide_banner", "-v", "error", "-y", "-f", "lavfi", "-i", "testsrc=size=64x64:rate=2:duration=1",
      "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000:duration=1", "-c:v", "libx264", "-pix_fmt", "yuv420p",
      "-c:a", "aac", "-shortest", videoInput]);
    const shared = { outputDir: path.join(root, "work", "enhanced"), scratchRoot: path.join(root, "scratch"),
      scopeId: "tenant-1/project-1", targetWidth: 128, targetHeight: 128, bins: { ffmpeg, ffprobe },
      maxScratchBytes: 64 * 1024 ** 2, maxOutputBytes: 64 * 1024 ** 2, reserveBytes: 64 * 1024 ** 2 };
    const image = await enhanceImage({ ...shared, input: imageInput, kind: "live-action" });
    const video = await enhanceVideo({ ...shared, input: videoInput, kind: "animation" });
    assert.equal(image.probe.width, 128);
    assert.equal(image.probe.height, 128);
    assert.equal(image.model, "realesrgan-x4plus");
    assert.equal(image.modelScale, 4);
    assert.equal(video.probe.width, 128);
    assert.equal(video.probe.height, 128);
    assert.equal(video.probe.audio.length, 1);
    assert.equal(video.model, "realesr-animevideov3");
    assert.equal(video.modelScale, 2);
    assert.equal(video.processingMode, "ai-upscale");
    assert.match(video.engine.archiveSha256, /^[a-f0-9]{64}$/);
    assert.equal(video.receipt.engine.archiveSha256, video.engine.archiveSha256);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("UHD path upscales 1080p still and passes native 2160p video", { skip: !hasMediaTools || process.env.WORKLOOM_ENHANCE_UHD_TEST !== "1" }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "workloom-enhance-uhd-"));
  try {
    const imageInput = path.join(root, "source-1080p.png");
    const videoInput = path.join(root, "source-2160p.mp4");
    run(ffmpeg, ["-hide_banner", "-v", "error", "-y", "-f", "lavfi",
      "-i", "testsrc2=size=1920x1080:rate=1", "-frames:v", "1", imageInput]);
    run(ffmpeg, ["-hide_banner", "-v", "error", "-y", "-f", "lavfi",
      "-i", "color=c=navy:size=3840x2160:rate=2:duration=1", "-f", "lavfi",
      "-i", "sine=frequency=440:sample_rate=48000:duration=1", "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p",
      "-c:a", "aac", "-shortest", videoInput]);
    const shared = { outputDir: path.join(root, "work", "enhanced"), scratchRoot: path.join(root, "scratch"),
      scopeId: "tenant-1/project-uhd", targetWidth: 3840, targetHeight: 2160, bins: { ffmpeg, ffprobe },
      maxOutputBytes: 256 * 1024 ** 2 };
    const image = await enhanceImage({ ...shared, input: imageInput, kind: "live-action" });
    const video = await enhanceVideo({ ...shared, input: videoInput, kind: "live-action" });
    assert.equal(image.processingMode, "ai-upscale");
    assert.equal(image.probe.width, 3840);
    assert.equal(image.probe.height, 2160);
    assert.equal(video.processingMode, "passthrough");
    assert.equal(video.probe.width, 3840);
    assert.equal(video.probe.height, 2160);
    assert.equal(video.probe.audio.length, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
