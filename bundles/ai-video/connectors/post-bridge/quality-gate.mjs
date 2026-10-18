/** Independent technical post-production gate. Never calls a model or regenerates sources. */
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { probeMedia, runBin, sha256File } from "../subtitle-bridge/measure.mjs";
import { measureLoudness } from "../bgm-bridge/measure.mjs";

export const POST_QUALITY_STAGES = Object.freeze(["cover", "bgm", "subtitles", "danmaku", "transitions", "color", "resolution"]);
export const POST_QUALITY_SCHEMA = "workloom.post-quality/v1";
export class PostQualityError extends Error {
  constructor(message, report = null) {
    super(message);
    this.name = "PostQualityError";
    this.code = "post_quality_failed";
    this.retryable = false;
    this.report = report;
  }
}
const canonical = (value) => Array.isArray(value) ? value.map(canonical)
  : value && typeof value === "object" ? Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])])) : value;
const hashJson = (value) => createHash("sha256").update(JSON.stringify(canonical(value))).digest("hex");
const legacyHashJson = (value) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const hasHash = (value) => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
const inside = (root, file) => { const rel = path.relative(root, file); return rel === "" || (rel !== ".." && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel)); };
const pixels = (value) => Array.isArray(value) && value.length === 2 && value.every((n) => Number.isSafeInteger(n) && n > 0);
const message = (error) => error instanceof Error ? error.message : String(error);
const sameIdentity = (a, b) => a.dev === b.dev && a.ino === b.ino && a.size === b.size && a.mtimeMs === b.mtimeMs && a.ctimeMs === b.ctimeMs;

/** Resolve a published revision's package-relative assets without permitting an arbitrary parent escape. */
export async function resolveDeliveryRoot({ manifestDir, manifest, allowedRoots = null }) {
  const dir = await fs.realpath(path.resolve(manifestDir));
  const hint = manifest?.deliveryRoot ?? ".";
  if (typeof hint !== "string" || !hint || path.isAbsolute(hint)) throw new PostQualityError("交付根必须是合法相对路径");
  const lexicalRoot = path.resolve(dir, hint);
  const root = await fs.realpath(lexicalRoot);
  if (root !== dir) {
    const version = /^v([1-9]\d*)$/.exec(path.basename(dir));
    const expected = path.dirname(path.dirname(dir));
    if (!version || Number(version[1]) < 2 || path.basename(path.dirname(dir)) !== "versions"
        || manifest.version !== Number(version[1]) || lexicalRoot !== expected || root !== expected) {
      throw new PostQualityError("返修交付根与版本目录不一致");
    }
    const baseManifest = JSON.parse(await fs.readFile(path.join(root, "delivery-manifest.json"), "utf8"));
    if (!manifest.projectId || baseManifest.projectId !== manifest.projectId || baseManifest.schemaVersion !== manifest.schemaVersion) {
      throw new PostQualityError("返修交付根与原工程身份不一致");
    }
  }
  if (Array.isArray(allowedRoots) && allowedRoots.length) {
    const prisonRoots = await Promise.all(allowedRoots.map((entry) => fs.realpath(path.resolve(entry))));
    if (!prisonRoots.some((entry) => inside(entry, root))) throw new PostQualityError("返修交付根越过允许目录");
  }
  return root;
}

function subtitleChecks(text, file, limit) {
  const clock = (value, format) => {
    const match = format === "ass" ? /^(\d+):(\d{2}):(\d{2})\.(\d{2})$/.exec(value)
      : /^(?:(\d{2,}):)?(\d{2}):(\d{2})[,.](\d{3})$/.exec(value);
    if (!match || Number(match[2]) >= 60 || Number(match[3]) >= 60) throw new Error("字幕时间格式非法");
    return Number(match[1] ?? 0) * 3600 + Number(match[2]) * 60 + Number(match[3]) + Number(match[4]) / (format === "ass" ? 100 : 1000);
  };
  let cues;
  if (/\.srt$/i.test(file) || /\.vtt$/i.test(file)) {
    const isVtt = /\.vtt$/i.test(file);
    const normalized = text.replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n").trim();
    if (isVtt && !/^WEBVTT(?:[ \t][^\n]*)?(?:\n|$)/.test(normalized)) throw new Error("VTT 缺少合法头部");
    const blocks = normalized.split(/\n[ \t]*\n/);
    cues = [];
    for (const block of blocks) {
      if (isVtt && /^(WEBVTT|NOTE(?:[ \t]|$)|STYLE(?:\n|$)|REGION(?:\n|$))/.test(block)) continue;
      const lines = block.split("\n");
      const index = lines.findIndex((line) => line.includes("-->"));
      if (index < 0 || index > 1 || (!isVtt && (index !== 1 || !/^\d+$/.test(lines[0])))) throw new Error("字幕块缺编号或合法时间轴");
      const time = /^(\S+)\s+-->\s+(\S+)(?:[ \t]+[^\n]*)?$/.exec(lines[index]);
      if (!time) throw new Error("字幕时间轴非法");
      cues.push({ start: clock(time[1], "srt"), end: clock(time[2], "srt"), text: lines.slice(index + 1).join("\n") });
    }
  } else if (/\.ass$/i.test(file)) {
    let events = false;
    let fields = null;
    cues = [];
    for (const line of text.replace(/\r\n?/g, "\n").split("\n")) {
      if (/^\[.*\]$/.test(line.trim())) { events = line.trim() === "[Events]"; continue; }
      if (!events || !line.trim() || line.startsWith(";")) continue;
      if (/^Format:/.test(line)) { fields = line.slice(7).split(",").map((field) => field.trim().toLowerCase()); continue; }
      if (/^Comment:/.test(line)) continue;
      if (!/^Dialogue:/.test(line) || !fields || !["start", "end", "text"].every((field) => fields.includes(field)) || fields.at(-1) !== "text") throw new Error("ASS 事件结构非法");
      const values = line.slice(9).trimStart().split(",");
      if (values.length < fields.length) throw new Error("ASS 事件字段不足");
      cues.push({ start: clock(values[fields.indexOf("start")], "ass"), end: clock(values[fields.indexOf("end")], "ass"), text: values.slice(fields.length - 1).join(",").replace(/\{[^}]*\}/g, "").replace(/\\[Nn]/g, "\n") });
    }
  } else throw new Error("未声明可验证的字幕格式");
  if (!cues.length) throw new Error("没有可读的字幕时间与文字");
  for (const cue of cues) if (!(cue.end > cue.start) || !cue.text.trim() || (Number.isFinite(limit) && cue.end > limit + 0.1)) throw new Error("字幕为空、时序非法或越过片尾");
}

export const PROCESSING_SCHEMA = "workloom.post-processing/v1";
/** Capture input bytes BEFORE invoking a local processor. */
export async function captureProcessingInputs(files) {
  return Promise.all(files.map(async (file) => ({ path: path.resolve(file), sha256: await sha256File(file) })));
}
/** Called by the processing engine after successful execution, with its before-call input snapshot. */
export async function writeProcessingProof({ root, stage, id, inputs, outputs, parameters, execution }) {
  if (!POST_QUALITY_STAGES.includes(stage) || !inputs?.length || !outputs?.length || !parameters || !execution) throw new PostQualityError("加工凭证缺执行参数、输入或产物");
  const base = await fs.realpath(root);
  const record = async (entry) => {
    const file = await fs.realpath(path.resolve(entry.path));
    if (!inside(base, file)) throw new PostQualityError("加工凭证引用越过交付根");
    const sha256 = await sha256File(file);
    if (entry.sha256 && entry.sha256 !== sha256) throw new PostQualityError("加工过程中源文件被修改");
    return { path: path.relative(base, file), sha256 };
  };
  const proof = { schemaVersion: PROCESSING_SCHEMA, stage, id, engine: "workloom.local-post", status: "completed",
    inputs: await Promise.all(inputs.map(record)), outputs: await Promise.all(outputs.map(record)), parameters, execution: { ...execution, exitCode: 0 }, requestSha256: hashJson(parameters.request ?? parameters),
    requestHashAlgorithm: "canonical-json-v1", generatedAt: new Date().toISOString(), sourcePreserved: true };
  const folder = path.join(base, "quality", "processing");
  await fs.mkdir(folder, { recursive: true });
  const output = path.join(folder, `${stage}-${String(id).replace(/[^a-zA-Z0-9_-]/g, "_")}-${randomUUID()}.json`);
  await fs.writeFile(output, `${JSON.stringify(proof, null, 2)}\n`, { flag: "wx" });
  return { path: path.relative(base, output), sha256: await sha256File(output), stage, id, outputs: proof.outputs.map((entry, index) => ({ ...entry, media: outputs[index].media ?? "video" })) };
}

export async function verifyProcessingProof(proof, stage, realRoot, assetById, expectedOutputs = []) {
  if (proof?.schemaVersion !== PROCESSING_SCHEMA || proof.stage !== stage || proof.status !== "completed"
      || proof.engine !== "workloom.local-post" || proof.sourcePreserved !== true || !proof.id
      || !Array.isArray(proof.inputs) || !proof.inputs.length || !Array.isArray(proof.outputs) || !proof.outputs.length
      || !proof.parameters || !Object.keys(proof.parameters).length || !proof.execution || !Object.keys(proof.execution).length) throw new Error("缺真实类型化加工凭证");
  if (Array.isArray(proof.execution.checks) && proof.execution.checks.some((row) => row.hard !== false && (row.ok ?? row.pass) !== true)) throw new Error("加工器客观硬项失败");
  const digest = proof.requestHashAlgorithm === "canonical-json-v1" ? hashJson : legacyHashJson;
  if (proof.requestHashAlgorithm && proof.requestHashAlgorithm !== "canonical-json-v1") throw new Error("加工请求摘要算法不支持");
  if (proof.execution.exitCode !== 0 || proof.requestSha256 !== digest(proof.parameters.request ?? proof.parameters)) throw new Error("加工执行失败或请求哈希不一致");
  for (const entry of [...proof.inputs, ...proof.outputs]) {
    if (!entry?.path || !hasHash(entry.sha256)) throw new Error("加工凭证缺输入/输出哈希");
    const file = await fs.realpath(path.resolve(realRoot, entry.path));
    if (!inside(realRoot, file) || await sha256File(file) !== entry.sha256) throw new Error("加工凭证引用文件缺失、越界或已变更");
  }
  for (const id of expectedOutputs) {
    const output = assetById.get(id);
    if (!output?.passed || !proof.outputs.some((entry) => entry.sha256 === output.sha256 && path.resolve(realRoot, entry.path) === path.resolve(realRoot, output.path))) throw new Error("加工凭证没有绑定当前交付产物");
  }
  if (stage === "transitions" && (!Array.isArray(proof.execution.cuts) || !Number.isInteger(proof.execution.shotCount)
      || proof.execution.cuts.length !== Math.max(0, proof.execution.shotCount - 1)
      || proof.execution.cuts.some((cut) => !cut.type || !Number.isFinite(cut.at) || !(cut.duration >= 0)))) throw new Error("缺逐刀实际转场执行记录");
  if (stage === "bgm" && proof.parameters.mode !== "original-program" && (!proof.execution.trackId || !hasHash(proof.execution.trackSha256) || !proof.parameters.policy)) throw new Error("缺配乐来源与混音参数");
  if (stage === "color" && (proof.execution.outputSha256 !== proof.outputs[0].sha256 || !proof.execution.outputSha256 || !proof.parameters.profile && !proof.parameters.lut && proof.parameters.technicalOnly !== true)) throw new Error("缺调色执行参数");
  if (["subtitles", "danmaku"].includes(stage) && (!Number.isInteger(proof.execution.cueCount) || proof.execution.cueCount < 1 || !proof.parameters.mode)) throw new Error("缺字幕/弹幕实际执行条数");
  return true;
}

/** Required stages and output bytes are checked independently of caller-supplied passed/synced flags. */
export async function inspectPostQuality({ root, assets = [], contract = {}, receipts = [], checks = [], bins,
  environment = "local-preview" } = {}) {
  const report = { schemaVersion: POST_QUALITY_SCHEMA, generatedAt: new Date().toISOString(), environment,
    phase: contract.phase ?? "post", contractSha256: hashJson(contract), contract, assets: [], stages: [], checks: [],
    passed: false, artisticQualityReviewed: false, paidCalls: 0,
    limitation: "技术合规报告不证明身份、审美、口型或业务效果；不触发源片重生成。" };
  const check = (kind, ok, detail, hard = true) => report.checks.push({ kind, ok: ok === true, hard, detail });
  let realRoot;
  try { realRoot = await fs.realpath(path.resolve(root)); }
  catch (error) { check("delivery-root", false, message(error)); return report; }
  check("contract-schema", contract.schemaVersion === "workloom.post-contract/v1", contract.schemaVersion ?? null);
  check("target-resolution", pixels(contract.resolution), contract.resolution ?? null);
  check("source-resolution", pixels(contract.sourceResolution), contract.sourceResolution ?? "原生规格未核实");
  const audioPolicy = contract.audioQuality ?? { mode: "report", targetLufs: -14, toleranceLu: 1, maxTruePeakDbtp: -1 };
  check("audio-policy", ["report", "block"].includes(audioPolicy.mode)
    && Number.isFinite(audioPolicy.targetLufs) && audioPolicy.targetLufs >= -70 && audioPolicy.targetLufs <= 0
    && Number.isFinite(audioPolicy.toleranceLu) && audioPolicy.toleranceLu >= 0 && audioPolicy.toleranceLu <= 20
    && Number.isFinite(audioPolicy.maxTruePeakDbtp) && audioPolicy.maxTruePeakDbtp >= -30 && audioPolicy.maxTruePeakDbtp <= 0,
    audioPolicy);
  if (pixels(contract.sourceResolution) && pixels(contract.resolution)) {
    const sourceShort = Math.min(...contract.sourceResolution);
    const outputShort = Math.min(...contract.resolution);
    const sameAspect = Math.abs(contract.sourceResolution[0] / contract.sourceResolution[1] - contract.resolution[0] / contract.resolution[1]) < 0.005;
    const reframe = contract.allowReframe === true && typeof contract.reframeReason === "string" && Boolean(contract.reframeReason.trim());
    const preservesPixels = sameAspect ? contract.resolution.every((value, axis) => value >= contract.sourceResolution[axis]) : reframe && outputShort >= sourceShort;
    check("native-resolution", preservesPixels || contract.allowDownscale === true,
      { source: contract.sourceResolution, output: contract.resolution, allowDownscale: contract.allowDownscale === true });
  }
  const ids = new Set();
  for (const asset of assets) {
    const row = { id: asset?.id ?? null, path: asset?.path ?? null, expectedSha256: asset?.sha256 ?? null,
      sha256: null, bytes: null, media: asset?.media, probe: null, decoded: false, passed: false };
    report.assets.push(row);
    try {
      if (typeof asset?.id !== "string" || !asset.id || ids.has(asset.id)) throw new Error("资产 ID 缺失或重复");
      ids.add(asset.id);
      if (typeof asset.path !== "string" || !asset.path || !hasHash(asset.sha256)) throw new Error("资产缺路径或完整 SHA-256 回执");
      const file = path.resolve(realRoot, asset.path);
      const realFile = await fs.realpath(file);
      if (!inside(realRoot, file) || !inside(realRoot, realFile)) throw new Error("资产路径越过交付根");
      const before = await fs.stat(realFile);
      if (!before.isFile() || before.size <= 0) throw new Error("资产不是非空文件");
      row.bytes = before.size;
      row.sha256 = await sha256File(realFile);
      if (row.sha256 !== asset.sha256) throw new Error("当前文件 SHA-256 与执行回执不一致");
      if (asset.media === "video" || asset.media === "image") {
        row.probe = await probeMedia(realFile, { bins });
        const target = asset.resolution ?? contract.resolution;
        if (!pixels(target) || row.probe.width !== target[0] || row.probe.height !== target[1]) throw new Error("实际像素尺寸与交付契约不一致");
        if (asset.media === "video") {
          if (!(row.probe.videoDuration > 0)) throw new Error("没有可核实的视频轨时长");
          if (asset.requireAudio && !row.probe.hasAudio) throw new Error("应有音轨的成片缺音轨");
          if (Number.isFinite(asset.fps) && Math.abs(row.probe.fps - asset.fps) > 0.02) throw new Error("实际帧率与交付契约不一致");
          const tolerance = Math.max(0.1, 2 / (row.probe.fps || 25));
          if (Number.isFinite(asset.durationSeconds) && Math.abs(row.probe.videoDuration - asset.durationSeconds) > tolerance) throw new Error("实际视频轨时长与执行时间轴不一致");
          if (asset.requireSubtitleStream) {
            const streamText = (await runBin(bins?.ffprobe ?? "ffprobe", ["-v", "error", "-show_streams", "-of", "json", realFile], { label: "ffprobe(quality-subtitles)", timeoutMs: 30_000 })).stdout;
            if (!JSON.parse(streamText).streams?.some((stream) => stream.codec_type === "subtitle")) throw new Error("软字幕形态没有实际字幕流");
          }
        }
        await runBin(bins?.ffmpeg ?? "ffmpeg", ["-hide_banner", "-v", "error", "-xerror", "-i", realFile,
          "-map", "0:v:0", "-map", "0:a?", "-f", "null", "-"], { label: "ffmpeg(post-quality-full-decode)" });
        row.decoded = true;
        if (asset.media === "video" && row.probe.hasAudio) {
          row.audioMeasurement = await measureLoudness(realFile, { bins, maxSeconds: null, startSec: null });
          const policy = audioPolicy;
          row.audioMeasurement.policy = policy;
          const finite = Number.isFinite(row.audioMeasurement.integratedLufs) && Number.isFinite(row.audioMeasurement.truePeakDbtp);
          row.audioMeasurement.withinTarget = finite && Math.abs(row.audioMeasurement.integratedLufs - policy.targetLufs) <= policy.toleranceLu && row.audioMeasurement.truePeakDbtp <= policy.maxTruePeakDbtp;
          if (policy.mode === "block" && !row.audioMeasurement.withinTarget) throw new Error("实际编码音轨未达到声明的响度/真峰值目标");
        }
      } else if (["json", "subtitle", "text"].includes(asset.media)) {
        if (before.size > 16 * 1024 * 1024) throw new Error("文本证据超过 16 MiB 验证上限");
        const text = await fs.readFile(realFile, "utf8");
        if (!text.trim()) throw new Error("文字证据为空");
        if (asset.media === "json") row.document = JSON.parse(text);
        if (asset.media === "subtitle") subtitleChecks(text, file, asset.durationSeconds);
      } else throw new Error("资产未声明可验证的媒体类别");
      const after = await fs.stat(realFile);
      if (!sameIdentity(before, after) || await sha256File(realFile) !== row.sha256 || await fs.realpath(file) !== realFile) throw new Error("资产在质检期间发生变化");
      row.passed = true;
      check(`asset:${asset.id}`, true, { sha256: row.sha256, decoded: row.decoded });
    } catch (error) { row.error = message(error); check(`asset:${row.id ?? "missing"}`, false, row.error); }
  }
  check("assets-present", assets.length > 0, { count: assets.length });
  const assetById = new Map(report.assets.map((row) => [row.id, row]));
  for (const name of POST_QUALITY_STAGES) {
    const expected = Array.isArray(contract.stages) ? contract.stages.filter((stage) => stage?.name === name) : [];
    const actual = Array.isArray(receipts) ? receipts.filter((receipt) => receipt?.name === name) : [];
    const stage = expected[0];
    let ok = expected.length === 1;
    let detail;
    if (!ok) detail = "环节缺失或重复";
    else if (stage.requirement === "not_applicable") {
      ok = typeof stage.reason === "string" && stage.reason.trim().length > 0;
      detail = { requirement: stage.requirement, reason: stage.reason ?? null };
    } else if (stage.requirement === "required") {
      const receipt = actual[0];
      const requiredIds = Array.isArray(stage.artifactIds) ? stage.artifactIds : [];
      const deliveredIds = Array.isArray(receipt?.artifactIds) ? receipt.artifactIds : [];
      ok = actual.length === 1 && receipt.status === "completed" && requiredIds.length > 0
        && requiredIds.every((id) => deliveredIds.includes(id) && assetById.get(id)?.passed === true)
        && (receipt.checks ?? []).every((row) => row.hard !== true || row.ok === true);
      const evidence = [];
      if (ok && name !== "resolution") {
        for (const id of requiredIds) {
          const asset = assetById.get(id);
          try {
            if (name === "cover" && asset.media === "image") { /* Actual dimensions + decode + engine cover checks below. */ }
            else if (name === "subtitles" && asset.media === "subtitle") { /* Every cue already parsed above. */ }
            else {
              if (asset.media !== "json") throw new Error("环节资产类别与实际加工证据不一致");
              await verifyProcessingProof(asset.document, name, realRoot, assetById, stage.outputIdsByProof?.[id] ?? []);
              if (stage.requestSha256ByProof?.[id] && stage.requestSha256ByProof[id] !== hashJson(asset.document.parameters.request ?? asset.document.parameters)) throw new Error("加工参数与当前交付请求不一致");
            }
            evidence.push({ id, ok: true });
          } catch (error) { evidence.push({ id, ok: false, error: message(error) }); ok = false; }
        }
      }
      detail = { requirement: stage.requirement, requiredIds, deliveredIds, evidence, receiptChecks: receipt?.checks ?? [], reason: receipt?.reason ?? null };
    } else { ok = false; detail = "环节未声明 required / not_applicable"; }
    report.stages.push({ name, passed: ok, ...detail });
    check(`stage:${name}`, ok, detail);
  }
  for (const row of checks) check(`processing:${row.kind ?? "unknown"}`, row.ok, row.detail ?? null, row.hard === true);
  report.passed = report.checks.every((row) => !row.hard || row.ok);
  return report;
}

export function assertPostQuality(report) {
  if (report?.schemaVersion !== POST_QUALITY_SCHEMA || report.passed !== true) {
    const failures = (report?.checks ?? []).filter((row) => row.hard && !row.ok).map((row) => row.kind);
    throw new PostQualityError(`后期技术质检未通过：${failures.join("、") || "缺真实质检报告"}`, report);
  }
  return report;
}

export async function writePostQuality(root, report) {
  const folder = path.join(root, "quality");
  await fs.mkdir(folder, { recursive: true });
  const output = path.join(folder, `post-quality-${report.phase}.json`);
  const pending = `${output}.${randomUUID()}.pending`;
  try {
    await fs.writeFile(pending, `${JSON.stringify(report, null, 2)}\n`, { flag: "wx" });
    await fs.rename(pending, output);
  } finally { await fs.rm(pending, { force: true }); }
  return { path: output, sha256: await sha256File(output), passed: report.passed };
}

/** Adapt current engine manifests. Only host-created processing proofs count as execution evidence. */
export async function inspectDeliveryManifest({ root, manifest, bins, phase = "post", sourceResolution = null,
  allowDownscale = false, extraChecks = [] } = {}) {
  const assets = [];
  const grouped = Object.fromEntries(POST_QUALITY_STAGES.map((name) => [name, []]));
  const stageChecks = Object.fromEntries(POST_QUALITY_STAGES.map((name) => [name, []]));
  const bindings = Object.fromEntries(POST_QUALITY_STAGES.map((name) => [name, {}]));
  const requestBindings = Object.fromEntries(POST_QUALITY_STAGES.map((name) => [name, {}]));
  const add = (id, artifact, media, stages = [], options = {}) => {
    if (!artifact?.path) return;
    if (!assets.some((item) => item.id === id)) assets.push({ id, path: artifact.path, sha256: artifact.sha256, media,
      ...(media === "video" ? { resolution: manifest.resolution, fps: manifest.fps, requireAudio: true,
        durationSeconds: artifact.duration ?? artifact.durationSeconds } : {}), ...options });
    for (const stage of stages) grouped[stage].push(id);
  };
  add("master", manifest.master, "video", ["resolution"]);
  const variants = manifest.variants ?? [];
  for (const variant of variants) {
    const id = String(variant.id);
    add(`${id}:video`, variant.video, "video", ["resolution"]);
    add(`${id}:cover`, variant.cover, "image", ["cover"], { resolution: manifest.resolution });
    add(`${id}:softsub`, variant.softsub, "video", ["resolution"], { requireSubtitleStream: true, durationSeconds: variant.video?.duration });
    add(`${id}:burned`, variant.burned, "video", ["resolution"], { durationSeconds: variant.video?.duration });
    stageChecks.cover.push(...(variant.cover?.checks ?? []).map((row) => ({ ...row, ok: row.ok ?? row.pass, hard: row.hard !== false })));
  }
  const maxDuration = Math.max(manifest.master?.duration ?? 0, ...variants.map((variant) => variant.video?.duration ?? 0));
  for (const [index, file] of (manifest.subtitles?.files ?? []).entries()) {
    add(`subtitle:${index}`, file, file.role === "subtitle" ? "subtitle" : "json", file.role === "subtitle" ? ["subtitles"] : [], { durationSeconds: maxDuration });
  }
  for (const [index, form] of (manifest.danmaku?.forms ?? []).entries()) {
    add(`danmaku:${index}`, { ...form, path: form.output ?? form.path }, "video", ["resolution"]);
  }
  for (const [index, form] of (manifest.coverIntro?.forms ?? []).entries()) {
    add(`cover-intro:${index}`, { ...form, path: form.output ?? form.path }, "video", ["resolution"], { requireSubtitleStream: form.form === "softsub" || form.form === ".softsub" || form.sourceForm === "softsub" });
  }
  const proofs = manifest.processing ?? [];
  for (const [index, proof] of proofs.entries()) {
    const id = `processing:${index}`;
    if (!POST_QUALITY_STAGES.includes(proof.stage) || proof.stage === "resolution") continue;
    add(id, proof, "json", [proof.stage]);
    const outputIds = [];
    for (const [outputIndex, output] of (proof.outputs ?? []).entries()) {
      const outputId = `processing-output:${index}:${outputIndex}`;
      add(outputId, output, output.media ?? "video", output.media === "subtitle" ? [] : ["resolution"],
        output.media === "subtitle" ? { durationSeconds: maxDuration } : {});
      outputIds.push(outputId);
    }
    bindings[proof.stage][id] = outputIds;
    const variant = variants.find((item) => item.id === proof.id);
    const requested = proof.stage === "bgm" ? variant?.style?.bgm : proof.stage === "color" ? variant?.style?.color
      : proof.stage === "transitions" ? (proof.id === "master" ? manifest.transitions?.request : variant?.style?.transitions) : null;
    if (requested) requestBindings[proof.stage][id] = hashJson(requested);
    stageChecks[proof.stage].push({ kind: `${proof.id}:bound-output`, hard: true, ok: outputIds.length > 0 });
  }
  const hasProof = (stage, id) => proofs.some((proof) => proof.stage === stage && proof.id === id && proof.path && hasHash(proof.sha256));
  for (const variant of variants) {
    const id = variant.id;
    if (variant.style?.bgm?.enabled !== false) stageChecks.bgm.push({ kind: `${id}:bgm-proof`, hard: true, ok: hasProof("bgm", id) });
    if (variant.style?.color || variant.style?.technicalColor) stageChecks.color.push({ kind: `${id}:color-proof`, hard: true, ok: hasProof("color", id) });
    if (manifest.entityColor?.enabled === true) stageChecks.color.push({ kind: `${id}:entity-proof`, hard: true, ok: hasProof("color", `${id}-entity`) });
    stageChecks.transitions.push({ kind: `${id}:transition-proof`, hard: true, ok: hasProof("transitions", id) });
    if (manifest.postRequirements?.burnSubtitles === true) stageChecks.subtitles.push({ kind: `${id}:burned-required`, hard: true,
      ok: Boolean(variant.burned?.path && hasHash(variant.burned.sha256)) && hasProof("subtitles", `${id}-burned`) });
    if (manifest.postRequirements?.softSubtitles === true) stageChecks.subtitles.push({ kind: `${id}:softsub-required`, hard: true,
      ok: Boolean(variant.softsub?.path && hasHash(variant.softsub.sha256)) && hasProof("subtitles", `${id}-softsub`) });
  }
  stageChecks.transitions.push({ kind: "master:transition-proof", hard: true, ok: hasProof("transitions", "master") });
  for (const [index] of (manifest.danmaku?.forms ?? []).entries()) stageChecks.danmaku.push({ kind: `danmaku:${index}:proof`, hard: true, ok: hasProof("danmaku", String(index)) });
  const wants = { cover: true, bgm: variants.some((variant) => variant.style?.bgm?.enabled !== false),
    subtitles: manifest.postRequirements?.subtitles === true || Boolean(manifest.subtitles),
    danmaku: manifest.postRequirements?.danmaku === true || Boolean(manifest.danmaku),
    transitions: true, color: variants.some((variant) => Boolean(variant.style?.color || variant.style?.technicalColor)), resolution: true };
  const reasons = { bgm: "所有变体明确使用原声，未要求添加 BGM", subtitles: "本次未提供字幕文字；此交付明确不含字幕",
    danmaku: "本次未要求弹幕；保留无弹幕发布形态", color: "所有变体明确保留源画面颜色" };
  const stages = POST_QUALITY_STAGES.map((name) => wants[name] ? { name, requirement: "required", artifactIds: grouped[name],
    outputIdsByProof: bindings[name], requestSha256ByProof: requestBindings[name] }
    : { name, requirement: "not_applicable", reason: reasons[name] });
  const contract = { schemaVersion: "workloom.post-contract/v1", phase, resolution: manifest.resolution,
    sourceResolution: sourceResolution ?? manifest.nativeResolution,
    allowDownscale: allowDownscale || manifest.resolutionPolicy?.downscaleApproved === true,
    allowReframe: manifest.resolutionPolicy?.reframeApproved === true, reframeReason: manifest.resolutionPolicy?.reframeReason ?? null,
    audioQuality: manifest.audioQuality ?? { mode: "report", targetLufs: -14, toleranceLu: 1, maxTruePeakDbtp: -1 }, stages };
  const receipts = POST_QUALITY_STAGES.filter((name) => wants[name]).map((name) => ({ name, status: "completed", artifactIds: grouped[name], checks: stageChecks[name] }));
  const required = [
    { kind: "master-required", hard: true, ok: Boolean(manifest.master?.path && hasHash(manifest.master.sha256)) },
    { kind: "variant-count", hard: true, ok: variants.length > 0 },
    { kind: "variant-videos", hard: true, ok: variants.every((variant) => Boolean(variant.video?.path && hasHash(variant.video.sha256))) },
    { kind: "variant-covers", hard: true, ok: variants.every((variant) => Boolean(variant.cover?.path && hasHash(variant.cover.sha256))) },
    { kind: "requested-variants", hard: true, ok: Array.isArray(manifest.postRequirements?.variantIds)
      && manifest.postRequirements.variantIds.length === variants.length
      && manifest.postRequirements.variantIds.every((id) => variants.filter((variant) => variant.id === id).length === 1) },
  ];
  const report = await inspectPostQuality({ root, assets, contract, receipts, bins, checks: [...required,
    ...(manifest.checks ?? []).map((row) => ({ ...row, hard: row.hard !== false })), ...extraChecks] });
  const checkChain = (kind, ok, detail = null) => report.checks.push({ kind: `chain:${kind}`, hard: true, ok, detail });
  const documents = proofs.map((proof, index) => ({ ...proof, document: report.assets.find((asset) => asset.id === `processing:${index}`)?.document }));
  for (const [index, proof] of documents.entries()) {
    try {
      await verifyProcessingProof(proof.document, proof.stage, await fs.realpath(root), new Map(report.assets.map((asset) => [asset.id, asset])), bindings[proof.stage]?.[`processing:${index}`] ?? []);
      checkChain(`processing:${index}:typed-proof`, true);
    } catch (error) { checkChain(`processing:${index}:typed-proof`, false, message(error)); }
  }
  const find = (stage, id) => documents.find((proof) => proof.stage === stage && proof.id === id)?.document;
  const outputHash = (proof) => proof?.outputs?.[0]?.sha256;
  const consumes = (proof, sha256) => hasHash(sha256) && proof?.inputs?.some((input) => input.sha256 === sha256);
  checkChain("master", outputHash(find("transitions", "master")) === manifest.master?.sha256);
  for (const variant of variants) {
    const transition = find("transitions", variant.id);
    const color = find("color", variant.id);
    const entity = find("color", `${variant.id}-entity`);
    const bgm = find("bgm", variant.id);
    let picture = outputHash(transition);
    if (color) { checkChain(`${variant.id}:color-input`, consumes(color, picture)); picture = outputHash(color); }
    if (entity) { checkChain(`${variant.id}:entity-input`, consumes(entity, picture)); picture = outputHash(entity); }
    const stemProgram = find("bgm", `${variant.id}-stems`);
    if (stemProgram) { checkChain(`${variant.id}:stem-input`, consumes(stemProgram, picture)); picture = outputHash(stemProgram); }
    const sound = find("bgm", `${variant.id}-sound`);
    if (sound) { checkChain(`${variant.id}:sound-input`, consumes(sound, picture)); picture = outputHash(sound); }
    if (variant.style?.bgm?.enabled !== false) {
      checkChain(`${variant.id}:music-input`, consumes(bgm, picture));
      checkChain(`${variant.id}:music-output`, outputHash(bgm) === variant.video?.sha256);
    } else {
      // A no-music program mux has its own verified byte receipt when independent stems change the container.
      const program = find("bgm", `${variant.id}-program`);
      checkChain(`${variant.id}:program-output`, picture === variant.video?.sha256 || consumes(program, picture) && outputHash(program) === variant.video?.sha256);
    }
    for (const form of ["burned", "softsub"]) if (variant[form]) {
      const subtitle = find("subtitles", `${variant.id}-${form}`);
      checkChain(`${variant.id}:${form}`, consumes(subtitle, variant.video?.sha256) && outputHash(subtitle) === variant[form].sha256);
    }
  }
  for (const [index, form] of (manifest.danmaku?.forms ?? []).entries()) {
    const proof = find("danmaku", String(index));
    const variant = variants.find((item) => item.id === form.variantId);
    checkChain(`danmaku:${index}`, Boolean(variant) && (consumes(proof, variant.burned?.sha256) || consumes(proof, variant.video?.sha256)) && outputHash(proof) === form.sha256);
  }
  /**
   * 字幕+弹幕的发布件必须是一次合并 ASS 编码：
   * 两条 processing proof 指向同一输出字节，且都记录 textEncodingPasses=1。
   * 这样后续即使有人把实现偷偷退回“先烧字再烧弹幕”，链级硬检查也会红灯。
   */
  if (manifest.postRequirements?.burnSubtitles === true && manifest.postRequirements?.danmaku === true) {
    for (const variant of variants) {
      const formIndex = (manifest.danmaku?.forms ?? []).findIndex((form) => form.variantId === variant.id);
      const subtitle = find("subtitles", `${variant.id}-burned`);
      const danmakuProof = find("danmaku", String(formIndex));
      checkChain(
        `${variant.id}:text-single-pass`,
        variant.burned?.combinedWithDanmaku === true
          && variant.burned?.textEncodingPasses === 1
          && subtitle?.parameters?.combinedEncoding === true
          && subtitle?.parameters?.textEncodingPasses === 1
          && danmakuProof?.parameters?.combinedEncoding === true
          && danmakuProof?.parameters?.textEncodingPasses === 1
          && outputHash(subtitle) === variant.burned?.sha256
          && outputHash(danmakuProof) === variant.burned?.sha256,
        {
          outputSha256: variant.burned?.sha256 ?? null,
          subtitleProofPasses: subtitle?.parameters?.textEncodingPasses ?? null,
          danmakuProofPasses: danmakuProof?.parameters?.textEncodingPasses ?? null,
        },
      );
    }
  }
  for (const [index, displayed] of (manifest.displaySet?.artifacts ?? []).entries()) {
    try {
      if (!displayed.path || !displayed.source || !hasHash(displayed.sha256) || !hasHash(displayed.sourceSha256)) throw new Error("中文交付文件缺当前字节证据");
      const source = path.resolve(displayed.source), target = path.resolve(displayed.path);
      const currentSource = await sha256File(source), currentTarget = await sha256File(target);
      if (currentSource !== displayed.sourceSha256 || currentTarget !== displayed.sha256 || currentTarget !== currentSource) throw new Error("中文交付文件或来源已被修改");
      if (displayed.role !== "preview" && !displayed.preview && !report.assets.some((asset) => asset.passed && path.resolve(root, asset.path) === source && asset.sha256 === currentSource)) throw new Error("中文交付文件没有绑定已验收产物");
      checkChain(`display-set:${index}`, true, { sha256: currentTarget });
    } catch (error) { checkChain(`display-set:${index}`, false, message(error)); }
  }
  // edit:post writes the requirement before the engine starts. A half-finished package
  // cannot become publishable merely because the generic post phase completed first.
  let rhythmRequired = null;
  try { rhythmRequired = JSON.parse(await fs.readFile(path.join(root, "rhythm-direction-required.json"), "utf8")); }
  catch (error) { if (error?.code !== "ENOENT") checkChain("rhythm-requirement", false, message(error)); }
  if (manifest.rhythmDirection || rhythmRequired && phase !== "post") {
    try {
      const binding = manifest.rhythmDirection;
      if (!binding?.path || !hasHash(binding.sha256) || binding.passed !== true) throw new Error("缺实际首尾节奏复验回执");
      const base = await fs.realpath(root), file = await fs.realpath(path.resolve(base, binding.path));
      if (!inside(base, file) || await sha256File(file) !== binding.sha256) throw new Error("节奏复验回执越界或已变化");
      const receipt = JSON.parse(await fs.readFile(file, "utf8"));
      if (receipt.schemaVersion !== "workloom.video-edit/rhythm-output-inspection/v1" || receipt.passed !== true
          || receipt.timelineSha256 !== binding.timelineSha256 || receipt.direction?.timelineSha256 !== binding.timelineSha256
          || rhythmRequired && rhythmRequired.timelineSha256 !== binding.timelineSha256
          || !receipt.executionEvidence?.executions?.length || receipt.sourcePreserved !== true) throw new Error("节奏回执没有绑定当前时间轴与实际执行");
      if (!Array.isArray(receipt.sources) || !receipt.sources.length) throw new Error("节奏回执缺当前源素材身份");
      for (const source of receipt.sources) {
        if (!source.path || !hasHash(source.sha256) || await sha256File(source.path) !== source.sha256) throw new Error("节奏源素材已变化");
      }
      const music = receipt.direction?.music;
      if (music && (await sha256File(music.path) !== music.sha256 || await sha256File(music.source.path) !== music.source.sha256)) throw new Error("固定节奏音乐已变化");
      for (const scope of receipt.executionEvidence.executions) {
        const current = path.resolve(base, scope.proofPath);
        if (!inside(base, await fs.realpath(current)) || await sha256File(current) !== scope.proofSha256) throw new Error("逐刀执行证据已变化");
      }
      const delivered = [manifest.master, ...variants.flatMap((v) => [v.video, v.burned, v.softsub]),
        ...(manifest.danmaku?.forms ?? []).map((f) => ({ ...f, path: f.output ?? f.path })),
        ...(manifest.coverIntro?.forms ?? []).map((f) => ({ ...f, path: f.output ?? f.path }))].filter((entry) => entry?.path);
      const covered = receipt.outputs.filter((row) => row.passed === true && row.path && hasHash(row.sha256));
      const coverDerivatives = (manifest.coverIntro?.forms ?? []).map((form, index) => ({
        ...form,
        path: form.output ?? form.path,
        asset: report.assets.find((asset) => asset.id === `cover-intro:${index}`),
      }));
      const sameOutput = (left, right) => left?.sha256 === right?.sha256
        && path.resolve(base, left?.path ?? "") === path.resolve(base, right?.path ?? "");
      for (const item of delivered) {
        if (covered.some((row) => sameOutput(row, item))) continue;
        /**
         * 烧封片头是已覆盖成片的派生形态：源文件必须逐字节命中节奏复验，
         * 派生文件必须命中封面阶段资产回执、实际时长等于源片 + 片头，且有非零片头。
         * 这不把未验证的任意新文件当成已覆盖。
         */
        const derivative = coverDerivatives.find((form) => sameOutput(form, item));
        if (!derivative || !derivative.asset?.passed || !hasHash(derivative.sourceSha256)
          || !Number.isFinite(derivative.introSeconds) || derivative.introSeconds <= 0
          || !Number.isFinite(derivative.asset.probe?.videoDuration)) {
          throw new Error("当前交付形态未被首尾节奏复验覆盖");
        }
        const sourceEvidence = receipt.outputs.find((row) => row.passed === true && row.sha256 === derivative.sourceSha256
          && sameOutput(row, { path: derivative.source, sha256: derivative.sourceSha256 }));
        const sourceAsset = report.assets.find((asset) => asset.path === derivative.source && asset.sha256 === derivative.sourceSha256 && asset.passed);
        if (!sourceEvidence || !sourceAsset || !Number.isFinite(sourceAsset.probe?.videoDuration)
          || Math.abs(derivative.asset.probe.videoDuration - sourceAsset.probe.videoDuration - derivative.introSeconds)
            > Math.max(0.1, 2 / (derivative.asset.probe.fps || 25))) {
          throw new Error("烧封片头派生形态未绑定已覆盖源片或实际时长不符");
        }
      }
      checkChain("rhythm-direction", true, { sha256: binding.sha256, timelineSha256: binding.timelineSha256 });
    } catch (error) { checkChain("rhythm-direction", false, message(error)); }
  }
  report.passed = report.checks.every((row) => !row.hard || row.ok);
  return report;
}
