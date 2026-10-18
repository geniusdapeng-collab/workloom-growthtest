import assert from "node:assert/strict";
import { before, after, test } from "node:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { assembleTimeline, resolveVariantClarity } from "./core.mjs";
import { grade } from "../color-bridge/core.mjs";
import { inspectDeliveryManifest, inspectPostQuality, captureProcessingInputs, writeProcessingProof, POST_QUALITY_STAGES } from "./quality-gate.mjs";
const bins = { ffmpeg: process.env.WL_FFMPEG ?? "ffmpeg", ffprobe: process.env.WL_FFPROBE ?? "ffprobe" };
const hash = async (file) => createHash("sha256").update(await fs.readFile(file)).digest("hex");
let root, manifest, input;
const copy = () => structuredClone(manifest);
before(async () => {
  root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "post-contract-")));
  input = path.join(root, "source.mp4");
  execFileSync(bins.ffmpeg, ["-v", "error", "-y", "-f", "lavfi", "-i", "testsrc2=s=160x90:r=25:d=0.6", "-f", "lavfi", "-i", "sine=frequency=440:duration=0.6", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", input]);
  const processing = [];
  for (const id of ["master", "v"]) {
    const before = await captureProcessingInputs([input]);
    const output = path.join(root, `${id}-picture.mp4`);
    await assembleTimeline({ clips: [{ shotId: "source", path: input, duration: 0.6 }], transitions: { mode: "hard" }, output, resolution: [160, 90], fps: 25, bins });
    processing.push(await writeProcessingProof({ root, stage: "transitions", id, inputs: before, outputs: [{ path: output }], parameters: { request: { mode: "hard" }, mode: "hard" }, execution: { shotCount: 1, cuts: [] } }));
  }
  const colorInputs = await captureProcessingInputs([path.join(root, "v-picture.mp4")]);
  const result = await grade({ input: colorInputs[0].path, output: path.join(root, "v.mp4"), profile: null, lutPath: null, auto: false, clarity: "conservative", qualityGuard: "report", bins });
  processing.push(await writeProcessingProof({ root, stage: "color", id: "v", inputs: colorInputs, outputs: [{ path: result.output, sha256: result.sha256 }],
    parameters: { request: { technicalOnly: true }, technicalOnly: true, clarity: "conservative" }, execution: { outputSha256: result.sha256, colorManagement: result.colorManagement, processingQuality: result.processingQuality } }));
  const cover = path.join(root, "cover.png");
  execFileSync(bins.ffmpeg, ["-v", "error", "-y", "-i", result.output, "-frames:v", "1", cover]);
  manifest = { resolution: [160, 90], nativeResolution: [160, 90], fps: 25, processing,
    master: { path: "master-picture.mp4", sha256: await hash(path.join(root, "master-picture.mp4")), duration: 0.6 },
    transitions: { request: { mode: "hard" } }, postRequirements: { variantIds: ["v"], subtitles: false, danmaku: false },
    variants: [{ id: "v", video: { path: "v.mp4", sha256: result.sha256, duration: 0.6 }, cover: { path: "cover.png", sha256: await hash(cover) }, style: { technicalColor: true, color: null, bgm: { enabled: false }, transitions: { mode: "hard" } } }] };
});
after(async () => { if (root) await fs.rm(root, { recursive: true, force: true }); });
const inspect = (value) => inspectDeliveryManifest({ root, manifest: value, bins });
test("逐镜去雾已执行时，变体调色可关闭旧 conservative 二次锐化", () => {
  assert.equal(resolveVariantClarity({}), "conservative");
  assert.equal(resolveVariantClarity({ colorPipeline: { variantClarity: "off" } }), "off");
  assert.equal(resolveVariantClarity({ colorPipeline: { variantClarity: "strong" } }), "strong");
  assert.throws(() => resolveVariantClarity({ colorPipeline: { variantClarity: "extreme" } }), /variantClarity/);
});
test("真实本地拼接与技术调色的字节链可以交付，不需要模型调用", async () => { const report = await inspect(copy()); assert.equal(report.passed, true); assert.equal(report.paidCalls, 0); assert.equal(report.artisticQualityReviewed, false); });
test("同短边的极宽原片不能冒充原生分辨率保留", async () => { const value = copy(); value.nativeResolution = [1000, 90]; assert.equal((await inspect(value)).passed, false); });
test("换画幅必须显式批准并说明原因", async () => { const value = copy(); value.nativeResolution = [90, 160]; assert.equal((await inspect(value)).passed, false); value.resolutionPolicy = { reframeApproved: true, reframeReason: "项目明确将竖屏转横屏" }; assert.equal((await inspect(value)).passed, true); });
test("母版与每个变体的主视频都是必需产物", async () => { for (const field of ["master", "variant"]) { const value = copy(); if (field === "master") delete value.master; else delete value.variants[0].video; assert.equal((await inspect(value)).passed, false); } });
test("删除或复制请求变体都不能用现存视频糊弄完整交付", async () => { for (const ids of [["missing"], ["v", "v"], []]) { const value = copy(); value.postRequirements.variantIds = ids; assert.equal((await inspect(value)).passed, false); } });
test("任意 JSON 和 reused/passed 字段不能冒充真实转场凭证", async () => { const value = copy(); const file = path.join(root, "arbitrary.json"); await fs.writeFile(file, JSON.stringify({ passed: true, reused: true, mode: "hard" })); value.processing[0] = { ...value.processing[0], path: file, sha256: await hash(file) }; assert.equal((await inspect(value)).passed, false); });
test("一个母版凭证不能同时冒充变体加工与调色", async () => { const value = copy(); value.processing = [value.processing[0], { ...value.processing[0], id: "v" }, { ...value.processing[0], id: "v", stage: "color" }]; assert.equal((await inspect(value)).passed, false); });
test("调色请求改变必须重新执行，不能只改清单中的风格名", async () => { const value = copy(); value.variants[0].style.color = { profile: "warm-film" }; assert.equal((await inspect(value)).passed, false); });
test("音轨需绑定实际音乐处理；原声视频无法冒充带配乐成片", async () => { const value = copy(); value.variants[0].style.bgm = { enabled: true, policy: "keep-dialogue" }; assert.equal((await inspect(value)).passed, false); });
test("软字幕与烧录字幕不能只靠外观文件名声明已完成", async () => { for (const form of ["soft", "burn"]) { const value = copy(); value.postRequirements[form === "soft" ? "softSubtitles" : "burnSubtitles"] = true; value.postRequirements.subtitles = true; assert.equal((await inspect(value)).passed, false); } });
test("弹幕必需请求为空、缺执行结果时不得放行", async () => { const value = copy(); value.postRequirements.danmaku = true; value.danmaku = { forms: [] }; assert.equal((await inspect(value)).passed, false); });
test("实体工位请求不能悄悄丢弃，缺末端执行证明即失败", async () => { const value = copy(); value.entityColor = { enabled: true, intensity: 1 }; assert.equal((await inspect(value)).passed, false); });
test("响度硬闸不能用 NaN/Infinity/未知模式绕过", async () => { for (const policy of [{ mode: "x", targetLufs: -14, toleranceLu: 1, maxTruePeakDbtp: -1 }, { mode: "block", targetLufs: NaN, toleranceLu: Infinity, maxTruePeakDbtp: -1 }, { mode: "block", targetLufs: -14, toleranceLu: -1, maxTruePeakDbtp: 1 }]) { const value = copy(); value.audioQuality = policy; assert.equal((await inspect(value)).passed, false); } });
test("实际编码音轨达不到声明目标时 block 失败，report 留实测而不虚报目标", async () => { const value = copy(); value.audioQuality = { mode: "block", targetLufs: -50, toleranceLu: 0.01, maxTruePeakDbtp: -30 }; assert.equal((await inspect(value)).passed, false); value.audioQuality.mode = "report"; const report = await inspect(value); assert.equal(report.passed, true); assert.equal(report.assets.find(asset => asset.id === "v:video").audioMeasurement.withinTarget, false); });
for (const [ext, text] of [["ass", "[Events]\nFormat: Start, End, Text\nDialogue: abc,def,伪字幕"], ["vtt", "WEBVTT\n\n坏内容没有时间轴"], ["srt", "1\n00:00:00,000 --> 00:00:00,400\n有效\n\n2\n00:99:00,000 --> 00:00:00,600\n坏条"]]) test(`完整解析 ${ext}，不因合法头部或第一条就接受剩余坏内容`, async () => {
  const file = path.join(root, `bad-${ext}.${ext}`); await fs.writeFile(file, text);
  const stages = POST_QUALITY_STAGES.map(name => name === "resolution" ? { name, requirement: "required", artifactIds: ["film"] } : { name, requirement: "not_applicable", reason: "夹具不要求该环节" });
  const report = await inspectPostQuality({ root, bins, contract: { schemaVersion: "workloom.post-contract/v1", resolution: [160, 90], sourceResolution: [160, 90], stages },
    assets: [{ id: "film", path: "v.mp4", sha256: manifest.variants[0].video.sha256, media: "video" }, { id: "subtitle", path: file, sha256: await hash(file), media: "subtitle", durationSeconds: 0.6 }], receipts: [{ name: "resolution", status: "completed", artifactIds: ["film"] }] });
  assert.equal(report.passed, false);
});
test("加工发生前保存的源 SHA 能查出加工器改写源文件", async () => { const file = path.join(root, "before.txt"); await fs.writeFile(file, "before"); const inputs = await captureProcessingInputs([file]); await fs.writeFile(file, "after"); await assert.rejects(writeProcessingProof({ root, stage: "color", id: "bad", inputs, outputs: [{ path: input }], parameters: { technicalOnly: true }, execution: { outputSha256: await hash(input) } }), { code: "post_quality_failed" }); });
