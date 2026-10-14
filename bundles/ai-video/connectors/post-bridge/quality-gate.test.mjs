import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { inspectPostQuality, assertPostQuality, POST_QUALITY_STAGES, resolveDeliveryRoot } from "./quality-gate.mjs";

let root;
let video;
let hash;
const bins = { ffmpeg: process.env.WL_FFMPEG ?? "ffmpeg", ffprobe: process.env.WL_FFPROBE ?? "ffprobe" };
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
before(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "post-quality-test-"));
  video = path.join(root, "actual video 中文.mp4");
  execFileSync(bins.ffmpeg, ["-v", "error", "-y", "-f", "lavfi", "-i", "testsrc2=s=160x90:r=25:d=0.4",
    "-f", "lavfi", "-i", "sine=frequency=440:duration=0.4", "-c:v", "libx264", "-pix_fmt", "yuv420p",
    "-c:a", "aac", "-shortest", video]);
  hash = digest(await fs.readFile(video));
});
after(async () => { if (root) await fs.rm(root, { recursive: true, force: true }); });

function request(overrides = {}) {
  const stages = POST_QUALITY_STAGES.map((name) => name === "resolution"
    ? { name, requirement: "required", artifactIds: ["film"] }
    : { name, requirement: "not_applicable", reason: `测试夹具明确不制作 ${name}` });
  return { root, bins, assets: [{ id: "film", path: path.basename(video), sha256: hash, media: "video",
    resolution: [160, 90], fps: 25, durationSeconds: 0.4, requireAudio: true }],
    contract: { schemaVersion: "workloom.post-contract/v1", phase: "post", resolution: [160, 90],
      sourceResolution: [160, 90], stages }, receipts: [{ name: "resolution", status: "completed", artifactIds: ["film"] }], ...overrides };
}

test("真实媒体全片解码、尺寸与 SHA 一致后才放行，路径含空格和中文可执行", async () => {
  const report = await inspectPostQuality(request());
  assert.equal(report.passed, true);
  assert.equal(report.assets[0].probe.width, 160);
  assert.equal(report.assets[0].decoded, true);
  assert.equal(report.artisticQualityReviewed, false);
  assertPostQuality(report);
});
test("报告中的过期哈希不能让当前媒体通过", async () => {
  const input = request();
  input.assets[0].sha256 = "0".repeat(64);
  const report = await inspectPostQuality(input);
  assert.equal(report.passed, false);
  assert.throws(() => assertPostQuality(report), { code: "post_quality_failed" });
});
test("要求字幕但缺真实产物/执行回执即失败，passed 字段不能代替它", async () => {
  const input = request();
  input.contract.stages.find((stage) => stage.name === "subtitles").requirement = "required";
  input.receipts.push({ name: "subtitles", status: "completed", passed: true, artifactIds: ["missing-burned"] });
  const report = await inspectPostQuality(input);
  assert.equal(report.passed, false);
  assert(report.checks.some((row) => row.kind === "stage:subtitles" && !row.ok));
});
test("不适用必须有具体理由，删掉某个环节也不能绕过七项完整性", async () => {
  const input = request();
  input.contract.stages = input.contract.stages.filter((stage) => stage.name !== "cover");
  delete input.contract.stages.find((stage) => stage.name === "danmaku").reason;
  const report = await inspectPostQuality(input);
  assert.equal(report.passed, false);
  assert(report.checks.some((row) => row.kind === "stage:cover" && !row.ok));
  assert(report.checks.some((row) => row.kind === "stage:danmaku" && !row.ok));
});
test("分辨率降低必须在契约里声明，实测结果仍必须等于目标", async () => {
  const input = request();
  input.contract.sourceResolution = [320, 180];
  const rejected = await inspectPostQuality(input);
  assert.equal(rejected.passed, false);
  input.contract.allowDownscale = true;
  assert.equal((await inspectPostQuality(input)).passed, true);
  input.assets[0].resolution = [320, 180];
  assert.equal((await inspectPostQuality(input)).passed, false);
});
test("probe 能读到规格仍不等于媒体完整：截断的 MP4 无法被放行", async () => {
  const broken = path.join(root, "truncated.mp4");
  const bytes = await fs.readFile(video);
  await fs.writeFile(broken, bytes.subarray(0, Math.floor(bytes.length / 2)));
  const input = request();
  input.assets[0].path = broken;
  input.assets[0].sha256 = digest(await fs.readFile(broken));
  const report = await inspectPostQuality(input);
  assert.equal(report.passed, false);
  assert.equal(report.assets[0].decoded, false);
});
test("软字幕形态缺实际字幕流即失败", async () => {
  const input = request();
  input.assets[0].requireSubtitleStream = true;
  assert.equal((await inspectPostQuality(input)).passed, false);
});
test("路径越界或软链接逃逸不能读成交付包的已核实资产", async () => {
  const outside = path.join(os.tmpdir(), `post-quality-outside-${process.pid}.txt`);
  await fs.writeFile(outside, "outside");
  const link = path.join(root, "escape.txt");
  await fs.symlink(outside, link);
  try {
    const input = request();
    input.assets.push({ id: "escaped", path: link, media: "text", sha256: digest(Buffer.from("outside")) });
    assert.equal((await inspectPostQuality(input)).passed, false);
  } finally { await fs.rm(outside, { force: true }); }
});
test("客观硬项失败不能降级成艺术建议，重复资产 ID 也拒绝", async () => {
  const input = request({ checks: [{ kind: "requested-transition", hard: true, ok: false, detail: "缺少逐刀执行回执" }] });
  input.assets.push({ ...input.assets[0] });
  assert.equal((await inspectPostQuality(input)).passed, false);
});
test("格式坏的字幕文件不能用非空字节伪装完成", async () => {
  const file = path.join(root, "bad.srt");
  await fs.writeFile(file, "这不是 SRT");
  const input = request();
  input.assets.push({ id: "bad-subtitle", path: file, media: "subtitle", sha256: digest(Buffer.from("这不是 SRT")), durationSeconds: 0.4 });
  assert.equal((await inspectPostQuality(input)).passed, false);
});

test("返修版本可回读所属交付根，版本或工程身份不符及父目录逃逸均拒绝", async () => {
  const base = path.join(root, "revision-root");
  const versionDir = path.join(base, "versions", "v2");
  await fs.mkdir(versionDir, { recursive: true });
  const manifest = { schemaVersion: "workloom.delivery-manifest/v1", projectId: "revision-root-test", version: 2, deliveryRoot: "../.." };
  await fs.writeFile(path.join(base, "delivery-manifest.json"), JSON.stringify({ ...manifest, version: 1, deliveryRoot: "." }));
  assert.equal(await resolveDeliveryRoot({ manifestDir: versionDir, manifest, allowedRoots: [root] }), await fs.realpath(base));
  for (const invalid of [
    { ...manifest, deliveryRoot: "../../.." },
    { ...manifest, deliveryRoot: base },
    { ...manifest, version: 3 },
    { ...manifest, projectId: "another-project" },
    { ...manifest, schemaVersion: "another-schema" },
  ]) {
    await assert.rejects(resolveDeliveryRoot({ manifestDir: versionDir, manifest: invalid, allowedRoots: [root] }), { code: "post_quality_failed" });
  }
  await assert.rejects(resolveDeliveryRoot({ manifestDir: versionDir, manifest, allowedRoots: [versionDir] }), { code: "post_quality_failed" });
  await assert.rejects(resolveDeliveryRoot({ manifestDir: base, manifest }), { code: "post_quality_failed" });
});
