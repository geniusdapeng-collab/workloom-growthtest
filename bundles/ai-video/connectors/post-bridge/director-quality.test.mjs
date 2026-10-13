/** Real local exports and negative current-byte evidence. No provider or paid source generation. */
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { execFileSync } from "node:child_process";
import { buildDirectorDelivery, reviseDirectorDelivery, planDirectorDelivery, inspectDirectorDeliveryManifest } from "./director-delivery.mjs";
import { directorHash, resolveDeliveryTargets } from "../../library/director-system/core.mjs";
import { callTool } from "./core.mjs";
import { sha256File } from "../subtitle-bridge/measure.mjs";
import { deliveryQuality } from "../../../geo-growth/capabilities/post-quality.mjs";

const bins = { ffmpeg: process.env.WL_FFMPEG ?? "ffmpeg", ffprobe: process.env.WL_FFPROBE ?? "ffprobe" };
const libraryRoot = path.resolve(new URL("../../library/", import.meta.url).pathname);
let root, env, shots, project, targetPlan, plans, delivered, revised;
const sourceHashes = new Map();
const read = async file => JSON.parse(await fs.readFile(file, "utf8"));
const request = manifest => inspectDirectorDeliveryManifest({ root: delivered.outDir, manifest, bins, env, phase: "director-negative" });
const pcmWindow = (file, start, end) => {
  const bytes = execFileSync(bins.ffmpeg, ["-v", "error", "-i", file, "-map", "0:a:0", "-af",
    `atrim=start=${start}:end=${end},asetpts=PTS-STARTPTS`, "-ar", "48000", "-ac", "1", "-c:a", "pcm_f32le", "-f", "f32le", "pipe:1"], { maxBuffer: 1024 * 1024 });
  return Array.from({ length: bytes.length / 4 }, (_, index) => bytes.readFloatLE(index * 4));
};
const deltaRms = (before, after) => {
  assert.equal(after.length, before.length); assert(before.length > 0);
  return Math.sqrt(before.reduce((sum, sample, index) => sum + (after[index] - sample) ** 2, 0) / before.length);
};
before(async () => {
  root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "director-quality-")));
  env = { ...process.env, WORKLOOM_POST_ALLOWED_ROOTS: [root, libraryRoot].join(path.delimiter),
    WORKLOOM_BGM_ALLOWED_ROOTS: [root, libraryRoot].join(path.delimiter), WORKLOOM_BGM_DISCOVER: "0",
    WORKLOOM_BGM_LIBRARY_DIR: path.join(root, "music"), WORKLOOM_BGM_HOME: path.join(root, "bgm-home"),
    WL_TSX_PATH: path.join(root, "missing-local-entity-adapter") };
  await fs.mkdir(env.WORKLOOM_BGM_LIBRARY_DIR);
  const track = path.join(env.WORKLOOM_BGM_LIBRARY_DIR, "corporate.wav");
  execFileSync(bins.ffmpeg, ["-v", "error", "-n", "-f", "lavfi", "-i", "sine=frequency=660:duration=8", "-c:a", "pcm_f32le", track]);
  await fs.writeFile(path.join(env.WORKLOOM_BGM_LIBRARY_DIR, "tracks.json"), JSON.stringify({ tracks: [{
    id: "director-test-corporate", style: "corporate-clean", title: "Local synthetic", mood: "干净可信", file: "corporate.wav",
    durationSec: 8, license: "workloom-self-generated", source: "local-ffmpeg-test", artist: "fixture" }] }));
  shots = [];
  for (const [index, [size, seconds, frequency]] of [["320x180", 0.8, 440], ["620x140", 1.2, 880]].entries()) {
    const file = path.join(root, `SC-${index + 1}.mp4`);
    execFileSync(bins.ffmpeg, ["-v", "error", "-n", "-f", "lavfi", "-i", `testsrc2=s=${size}:r=30:d=${seconds}`,
      "-f", "lavfi", "-i", `sine=frequency=${frequency}:sample_rate=48000:duration=${seconds}`,
      "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", file]);
    sourceHashes.set(file, await sha256File(file));
    shots.push({ shotId: `SC-${index + 1}`, path: file, lockTrim: true, role: index ? "hero" : "establishing" });
  }
  project = { projectId: "director-current-quality", title: "导演当前证据", fps: 30, chronologyLocked: true,
    copy: { title: "导演当前证据", hook: "本地真实验证", body: "保留原速与原生像素", cta: "查看" },
    directorSoundCues: [{ sourceId: "SC-1", atSeconds: 0.5, kind: "impact", gainDb: 0, reason: "源动作明确重音" }] };
  targetPlan = resolveDeliveryTargets("视频号只要一版", { platforms: ["wechat-channels"], versionCount: 1, includeSurprise: false });
  const planned = await planDirectorDelivery({ project: { ...project, deliveryTargetPlan: targetPlan }, shots, bins, env });
  plans = planned.variants.map(plan => { const { planHash, ...body } = plan; body.musicPlan = { ...body.musicPlan, enabled: false }; return { ...body, planHash: directorHash(body) }; });
  delivered = await buildDirectorDelivery({ project, shots, targetPlan, plannedVariants: plans,
    outDir: path.join(root, "delivery"), bins, env, softSubtitles: false, burnSubtitles: false });
}, { timeout: 180000 });
after(async () => { if (root) await fs.rm(root, { recursive: true, force: true }); });

test("独立 EDL 保留每个源轴、真实 proof 与最终声音；七项技术门禁通过但审美保持未验证", async () => {
  assert.equal(delivered.passed, true);
  assert.equal(delivered.postQuality.passed, true);
  assert.deepEqual(delivered.resolution, [798, 180]);
  for (const source of delivered.resolutionPolicy.inputDimensions) {
    assert(delivered.resolution[0] >= source.width && delivered.resolution[1] >= source.height);
  }
  assert.equal(delivered.resolutionPolicy.downscale, false);
  assert.equal(delivered.qualityReport.artisticQualityReviewed, false);
  assert.equal(delivered.qualityReport.paidCalls, 0);
  assert.equal(delivered.qualityReport.stages.length, 7);
  assert(delivered.qualityReport.assets.filter(asset => asset.media === "video").every(asset => asset.decoded));
  const variant = delivered.variants[0];
  assert.equal(variant.actual.durationFrames, 60);
  assert.equal(variant.entity.receipt.applied, 0);
  assert.equal(variant.sound.applied, true);
  assert.equal(variant.sound.receipt.programmeSpeed, 1);
  assert.equal(variant.sound.receipt.videoPacketsUnchanged, true);
  assert.equal(variant.audio.musicDisabled, true);
  assert.equal(variant.personQc.identityVerified, false);
  const cueDelta = deltaRms(pcmWindow(variant.layers.programme.path, 0.5, 0.75), pcmWindow(variant.video.path, 0.5, 0.75));
  const quietDelta = deltaRms(pcmWindow(variant.layers.programme.path, 0.1, 0.35), pcmWindow(variant.video.path, 0.1, 0.35));
  assert(cueDelta > 0.01, `Final programme must contain the requested real impact: ${cueDelta}`);
  assert(cueDelta > quietDelta * 4, `Impact must occur at its requested source-derived time: ${cueDelta}/${quietDelta}`);
  console.info(JSON.stringify({ fixture: "director-current-complete-media", resolution: delivered.resolution,
    sourceInputs: delivered.sourceInputs, durationFrames: variant.actual.durationFrames,
    finalSha256: variant.video.sha256, soundSha256: variant.sound.sha256, programmeSpeed: 1,
    cueAtSeconds: 0.5, cueDeltaRms: cueDelta, quietDeltaRms: quietDelta, technicalPassed: delivered.postQuality.passed,
    artisticQualityReviewed: delivered.qualityReport.artisticQualityReviewed, paidCalls: 0 }));
  for (const proof of variant.processing) {
    const document = await read(path.resolve(delivered.outDir, proof.path));
    assert.equal(document.sourcePreserved, true);
    assert.equal(document.execution.exitCode, 0);
    for (const artifact of [...document.inputs, ...document.outputs]) assert.equal(await sha256File(path.resolve(delivered.outDir, artifact.path)), artifact.sha256);
  }
  for (const [file, hash] of sourceHashes) assert.equal(await sha256File(file), hash);
});

test("缺真实加工证明不能靠旧 passed/synced 放行，创作请求变化拒绝旧执行参数", async () => {
  const missing = structuredClone(delivered.manifest);
  missing.postQuality = { passed: true }; missing.variants[0].processing = [];
  assert.equal((await request(missing)).passed, false);
  const missingSource = structuredClone(delivered.manifest);
  missingSource.sourceInputs.pop();
  assert.equal((await request(missingSource)).passed, false);
  const changed = structuredClone(delivered.manifest);
  changed.variants[0].plan.gradePlan.intensity -= 0.1;
  const report = await request(changed);
  assert.equal(report.passed, false);
  assert(report.stages.some(stage => stage.name === "color" && !stage.passed));
});

test("当前完整媒体仍需解码，重新声称截断文件 SHA 也失败；恢复后可回读", async () => {
  const file = delivered.variants[0].video.path, bytes = await fs.readFile(file);
  try {
    await fs.writeFile(file, bytes.subarray(0, 100));
    const changed = structuredClone(delivered.manifest);
    changed.variants[0].video.sha256 = await sha256File(file);
    const report = await request(changed);
    assert.equal(report.passed, false);
    assert(report.assets.some(asset => asset.id.endsWith(":video") && !asset.decoded));
  } finally { await fs.writeFile(file, bytes); }
  assert.equal((await request(delivered.manifest)).passed, true);
});

test("原生像素降低在编码前拒绝，默认计划不会偷偷落入固定 HD 画布", async () => {
  const output = path.join(root, "unapproved-small");
  await assert.rejects(buildDirectorDelivery({ project: { ...project, resolution: [320, 180] }, shots, targetPlan,
    outDir: output, bins, env }), { code: "verify_failed" });
  await assert.rejects(fs.stat(output), { code: "ENOENT" });
  for (const [file, hash] of sourceHashes) assert.equal(await sha256File(file), hash);
});

test("文案返修公开回读 revision 目录并重新验当前资产，非法 deliveryRoot 逃逸拒绝", async () => {
  const initialProjectHash = await sha256File(delivered.projectPath);
  revised = await reviseDirectorDelivery({ projectPath: delivered.projectPath, expectedVersion: 1,
    expectedProjectSha256: initialProjectHash, feedback: "只修改文案", patch: { copy: { cta: "新行动" } },
    variantId: delivered.variants[0].id, idempotencyKey: "director-copy-current", bins, env });
  assert.equal(revised.passed, true);
  assert.equal(revised.newVersion, 2);
  assert.equal(revised.variants[0].video.sha256, delivered.variants[0].video.sha256);
  assert.equal(await sha256File(delivered.projectPath), initialProjectHash);
  const current = () => callTool("postread.quality", { delivery_dir: revised.outDir, idempotency_key: "same-v2-quality" }, { bins, env });
  assert.equal((await current()).result.passed, true);
  const file = revised.variants[0].cover.path, bytes = await fs.readFile(file);
  try {
    await fs.appendFile(file, "changed-current-v2-cover");
    const changed = await current(); assert.equal(changed.result.passed, false); assert.equal(changed.receipt.synced, false);
  } finally { await fs.writeFile(file, bytes); }
  assert.equal((await current()).result.passed, true);
  const escaped = structuredClone(revised.manifest); escaped.deliveryRoot = "../../..";
  await assert.rejects(inspectDirectorDeliveryManifest({ root: revised.outDir, manifest: escaped, bins, env }), { code: "post_quality_failed" });
});

test("配乐返修仍消费当前 cue 后节目声，旧源和旧交付字节保持不变", async () => {
  const initialBytes = await sha256File(delivered.variants[0].video.path);
  const result = await reviseDirectorDelivery({ projectPath: revised.projectPath, expectedVersion: 2,
    expectedProjectSha256: await sha256File(revised.projectPath), feedback: "打开配乐", patch: { bgm: { enabled: true } },
    variantId: revised.variants[0].id, idempotencyKey: "director-current-music", bins, env });
  assert.equal(result.passed, true);
  const variant = result.variants[0];
  assert.equal(variant.sound.applied, true);
  assert.equal(variant.sound.receipt.programmeSpeed, 1);
  assert.equal(variant.audio.programSha256, variant.sound.sha256);
  assert.equal(variant.audio.music.id, "director-test-corporate");
  assert.equal(await sha256File(delivered.variants[0].video.path), initialBytes);
  for (const [file, hash] of sourceHashes) assert.equal(await sha256File(file), hash);
});


test("外部 quality capability 回读导演 V2 返修，当前字节篡改不能沿用旧绿灯", async () => {
  const keys = ["WORKLOOM_VIDEO_ARTIFACT_ROOT", "WORKLOOM_POST_ALLOWED_ROOTS", "WORKLOOM_POST_FFMPEG_PATH", "WORKLOOM_POST_FFPROBE_PATH"];
  const previous = Object.fromEntries(keys.map(key => [key, process.env[key]]));
  Object.assign(process.env, { WORKLOOM_VIDEO_ARTIFACT_ROOT: root, WORKLOOM_POST_ALLOWED_ROOTS: env.WORKLOOM_POST_ALLOWED_ROOTS,
    WORKLOOM_POST_FFMPEG_PATH: bins.ffmpeg, WORKLOOM_POST_FFPROBE_PATH: bins.ffprobe });
  const input = { projectId: project.projectId, outDir: path.relative(root, revised.outDir), kind: "post" };
  const file = revised.variants[0].cover.path, bytes = await fs.readFile(file);
  try {
    const accepted = await deliveryQuality(input);
    assert.equal(accepted.complete, true, JSON.stringify(accepted.report.checks.filter(check => check.hard && !check.ok)));
    assert.equal(accepted.report.director.revision, 2);
    assert.equal(accepted.paidCalls, 0); assert.equal(accepted.artisticQuality, "unverified");
    await fs.appendFile(file, "external-current-director-tamper");
    assert.equal((await deliveryQuality(input)).complete, false);
    await fs.writeFile(file, bytes);
    assert.equal((await deliveryQuality(input)).complete, true);
    const manifestFile = path.join(revised.outDir, "delivery-manifest.json"), manifestBytes = await fs.readFile(manifestFile);
    try {
      await fs.writeFile(manifestFile, JSON.stringify({ ...revised.manifest, deliveryRoot: "../../.." }));
      await assert.rejects(deliveryQuality(input), /返修交付根与版本目录不一致/u);
    } finally { await fs.writeFile(manifestFile, manifestBytes); }
    for (const [source, hash] of sourceHashes) assert.equal(await sha256File(source), hash);
  } finally {
    await fs.writeFile(file, bytes);
    for (const key of keys) { if (previous[key] === undefined) delete process.env[key]; else process.env[key] = previous[key]; }
  }
});
