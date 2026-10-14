/** Technical acceptance for independent Director EDL exports; never rates source identity or aesthetics. */
import fs from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { inspectPostQuality, POST_QUALITY_STAGES, PostQualityError } from "./quality-gate.mjs";
import { allowedRoots, assertPathAllowed } from "./core.mjs";
import { probeMedia, runBin, sha256File } from "../subtitle-bridge/measure.mjs";

const canonical = value => Array.isArray(value) ? value.map(canonical) : value && typeof value === "object"
  ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
const requestHash = value => createHash("sha256").update(JSON.stringify(canonical(value))).digest("hex");
const hasHash = value => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
const inside = (root, file) => { const rel = path.relative(root, file); return !rel || rel !== ".." && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel); };
const pictureRequest = plan => ({ pictureEdl: plan.pictureEdl, fps: plan.fps, durationFrames: plan.durationFrames });
export { pictureRequest as directorPictureRequest };

/** A V2 revision only resolves to its own original package, never an arbitrary parent. */
export async function resolveDirectorDeliveryRoot({ root, manifest, env = process.env }) {
  const dir = await fs.realpath(assertPathAllowed(root, allowedRoots(env)));
  const hint = manifest?.deliveryRoot ?? ".";
  if (typeof hint !== "string" || !hint || path.isAbsolute(hint)) throw new PostQualityError("导演交付根必须是合法相对路径");
  const base = await fs.realpath(assertPathAllowed(path.resolve(dir, hint), allowedRoots(env)));
  if (base !== dir) {
    const version = /^v([1-9]\d*)$/.exec(path.basename(dir));
    const expected = path.dirname(path.dirname(dir));
    if (!version || Number(version[1]) < 2 || path.basename(path.dirname(dir)) !== "revisions"
      || manifest.revision !== Number(version[1]) || path.resolve(dir, hint) !== expected || base !== expected) {
      throw new PostQualityError("导演返修交付根与版本目录不一致");
    }
    const original = JSON.parse(await fs.readFile(path.join(base, "delivery-manifest.json"), "utf8"));
    if (!manifest.projectId || original.projectId !== manifest.projectId || original.schemaVersion !== manifest.schemaVersion) {
      throw new PostQualityError("导演返修交付根与原工程身份不一致");
    }
  }
  return { dir, base };
}

/** Read every current primary form and proof. Caller-supplied passed flags have no authority. */
export async function inspectDirectorDeliveryManifest({ root, manifest, bins, phase = "director-post", env = process.env } = {}) {
  const { base } = await resolveDirectorDeliveryRoot({ root, manifest, env });
  const assets = [], checks = [], receipts = [], documents = new Map();
  const groups = Object.fromEntries(POST_QUALITY_STAGES.map(stage => [stage, []]));
  const bindings = Object.fromEntries(POST_QUALITY_STAGES.map(stage => [stage, {}]));
  const requests = Object.fromEntries(POST_QUALITY_STAGES.map(stage => [stage, {}]));
  const check = (kind, ok, detail = null) => checks.push({ kind: `director:${kind}`, ok: ok === true, hard: true, detail });
  const add = (id, artifact, media, stage = null, options = {}) => {
    if (!artifact?.path || !hasHash(artifact.sha256)) { check(`${id}:descriptor`, false); return null; }
    if (assets.some(asset => asset.id === id)) { check(`${id}:duplicate`, false); return null; }
    assets.push({ id, path: path.relative(base, path.resolve(artifact.path)), sha256: artifact.sha256, media, ...options });
    if (stage) groups[stage].push(id);
    return id;
  };
  check("schema", manifest?.schemaVersion === "workloom.delivery-package/v2");
  const variants = manifest.variants ?? [], targets = manifest.targetPlan?.targets ?? [];
  check("complete-target-set", manifest.status === "complete" && targets.length > 0 && variants.length === targets.length
    && new Set(variants.map(variant => variant.id)).size === variants.length
    && targets.every(target => variants.filter(variant => variant.id === target.variantId && variant.platform === target.platform && variant.status === "complete").length === 1));
  check("resolution-policy", Array.isArray(manifest.resolution) && manifest.resolution.length === 2
    && Array.isArray(manifest.nativeResolution) && manifest.resolutionPolicy?.inputDimensions?.length > 0);
  const sourceInputs = manifest.sourceInputs ?? [];
  const sourceById = new Map(sourceInputs.map(source => [source.shotId, source]));
  const dimensions = manifest.resolutionPolicy?.inputDimensions ?? [];
  check("source-set", sourceInputs.length > 0 && sourceById.size === sourceInputs.length
    && dimensions.length === sourceInputs.length && new Set(dimensions.map(source => source.shotId)).size === dimensions.length
    && dimensions.every(source => sourceById.has(source.shotId)));
  for (const source of manifest.sourceInputs ?? []) {
    try {
      const file = assertPathAllowed(source.path, allowedRoots(env));
      if (!hasHash(source.sha256) || await sha256File(file) !== source.sha256) throw new Error("当前共享源字节与冻结回执不一致");
      const media = await probeMedia(file, { bins });
      const recorded = manifest.resolutionPolicy.inputDimensions.find(row => row.shotId === source.shotId);
      const actual = [media.displayWidth ?? media.width, media.displayHeight ?? media.height];
      if (!recorded || recorded.width !== actual[0] || recorded.height !== actual[1]) throw new Error("原生源规格与实际媒体不一致");
      const output = manifest.resolution;
      const sameAspect = Math.abs(actual[0] / actual[1] - output[0] / output[1]) < .005;
      const preserved = sameAspect ? output.every((value, axis) => value >= actual[axis])
        : output.every((value, axis) => value >= actual[axis]) || manifest.resolutionPolicy.reframeApproved === true && Math.min(...output) >= Math.min(...actual);
      if (!preserved && manifest.resolutionPolicy.downscaleApproved !== true) throw new Error("导演交付存在未声明的原生像素降低");
      check(`source:${source.shotId}`, true, { sha256: source.sha256, resolution: actual });
    } catch (error) { check(`source:${source.shotId}`, false, error.message); }
  }
  check("sources-present", Array.isArray(manifest.sourceInputs) && manifest.sourceInputs.length > 0);
  const proofByKey = new Map();
  for (const variant of variants) {
    if (variant.status !== "complete") continue;
    const id = variant.id, plan = variant.plan;
    check(`${id}:picture-source-binding`, Array.isArray(plan?.pictureEdl) && plan.pictureEdl.length > 0
      && plan.pictureEdl.every(edit => sourceById.get(edit.sourceId)?.sha256 === edit.sourceSha256));
    const options = { resolution: manifest.resolution, fps: manifest.fps, durationSeconds: plan.durationFrames / plan.fps, requireAudio: true };
    add(`${id}:video`, variant.video, "video", "resolution", options);
    add(`${id}:cover`, variant.cover, "image", "cover", { resolution: variant.cover?.resolution });
    add(`${id}:copy`, variant.copy, "json");
    if (manifest.postRequirements?.softSubtitles) {
      add(`${id}:softsub`, variant.softsub, "video", "resolution", { ...options, requireSubtitleStream: true });
      check(`${id}:softsub-required`, Boolean(variant.softsub));
    }
    if (manifest.postRequirements?.burnSubtitles) {
      add(`${id}:burned`, variant.burned, "video", "resolution", options);
      check(`${id}:burned-required`, Boolean(variant.burned));
    }
    for (const [index, subtitle] of (variant.subtitles?.files ?? []).entries()) add(`${id}:subtitle:${index}`, subtitle, "subtitle", "subtitles", { durationSeconds: options.durationSeconds });
    const seen = new Set();
    for (const [index, proof] of (variant.processing ?? []).entries()) {
      const key = `${proof.stage}:${proof.id}`;
      if (seen.has(key)) { check(`${id}:${key}:duplicate`, false); continue; }
      seen.add(key);
      const assetId = `${id}:proof:${index}`;
      if (!POST_QUALITY_STAGES.includes(proof.stage)) { check(`${assetId}:stage`, false); continue; }
      add(assetId, { ...proof, path: path.resolve(base, proof.path) }, "json", proof.stage);
      const outputs = [];
      for (const [outputIndex, output] of (proof.outputs ?? []).entries()) {
        if (output.media === "audio") continue;
        const outputId = `${assetId}:output:${outputIndex}`;
        add(outputId, { ...output, path: path.resolve(base, output.path) }, output.media ?? "video", null,
          output.media === "image" ? { resolution: output.resolution ?? variant.cover?.resolution }
            : output.media === "subtitle" ? { durationSeconds: options.durationSeconds }
              : { resolution: manifest.resolution, fps: manifest.fps, durationSeconds: output.durationSeconds, requireAudio: output.requireAudio === true });
        outputs.push(outputId);
      }
      bindings[proof.stage][assetId] = outputs;
      const expected = proof.id === `${id}-picture` ? pictureRequest(plan) : proof.id === `${id}-grade` ? plan.gradePlan
        : proof.id === `${id}-mix` ? plan.musicPlan : proof.id === `${id}-program` ? { audioEdl: plan.audioEdl, fps: plan.fps, durationFrames: plan.durationFrames }
          : proof.id === `${id}-cover` ? plan.coverPlan : proof.id === `${id}-entity` ? variant.entity?.request
            : proof.id === `${id}-sound` ? variant.sound?.request : null;
      if (expected) requests[proof.stage][assetId] = requestHash(expected);
      try {
        const file = path.resolve(base, proof.path);
        if (!inside(base, await fs.realpath(file))) throw new Error("加工凭证越过导演交付根");
        const document = JSON.parse(await fs.readFile(file, "utf8"));
        documents.set(key, document); proofByKey.set(`${id}:${key}`, document);
      } catch (error) { check(`${assetId}:read`, false, error.message); }
    }
    const find = (stage, suffix) => proofByKey.get(`${id}:${stage}:${id}-${suffix}`);
    const outHash = proof => proof?.outputs?.[0]?.sha256;
    const consumes = (proof, hash) => hasHash(hash) && proof?.inputs?.some(input => input.sha256 === hash);
    let picture = outHash(find("transitions", "picture"));
    check(`${id}:picture`, hasHash(picture) && picture === variant.layers?.picture?.sha256);
    const grade = find("color", "grade");
    check(`${id}:grade`, consumes(grade, picture) && outHash(grade) === variant.layers?.graded?.sha256);
    picture = outHash(grade);
    const entity = find("color", "entity");
    check(`${id}:entity`, consumes(entity, picture) && outHash(entity) === variant.entity?.sha256);
    picture = outHash(entity);
    const program = find("bgm", "program");
    check(`${id}:audio-edl`, outHash(program) === variant.layers?.program?.sha256);
    const programme = find("bgm", "programme");
    check(`${id}:programme`, consumes(programme, picture) && consumes(programme, outHash(program)));
    picture = outHash(programme);
    if (variant.sound?.applied) {
      const sound = find("bgm", "sound");
      check(`${id}:sound`, consumes(sound, picture) && outHash(sound) === variant.sound.sha256);
      picture = outHash(sound);
    }
    const mix = find("bgm", "mix"), mux = find("bgm", "mux");
    check(`${id}:mix`, consumes(mix, picture) && outHash(mix) === variant.audio?.sha256);
    check(`${id}:mux`, consumes(mux, picture) && consumes(mux, outHash(mix)));
    let final = outHash(mux);
    const copied = find("bgm", "publish-copy");
    if (copied) { check(`${id}:publish-copy`, consumes(copied, final)); final = outHash(copied); }
    check(`${id}:current-video`, final === variant.video?.sha256);
    for (const form of ["softsub", "burned"]) if (variant[form]) {
      const subtitle = find("subtitles", form);
      check(`${id}:${form}`, consumes(subtitle, variant.video.sha256) && outHash(subtitle) === variant[form].sha256);
    }
    const cover = find("cover", "cover");
    check(`${id}:cover`, outHash(cover) === variant.cover?.sha256);
    for (const [kind, artifact] of [["program", variant.layers?.program], ["mix", variant.audio]]) {
      try {
        const file = await fs.realpath(artifact?.path ?? "");
        if (!inside(base, file) || await sha256File(file) !== artifact?.sha256) throw new Error("声音来源缺失、越界或已变化");
        await runBin(bins.ffmpeg, ["-hide_banner", "-v", "error", "-xerror", "-i", file, "-map", "0:a:0", "-f", "null", "-"], { label: "director(quality-audio-full-decode)" });
        check(`${id}:${kind}:audio-decode`, true);
      } catch (error) { check(`${id}:${kind}:audio-decode`, false, error.message); }
    }
  }
  const wantsText = manifest.postRequirements?.subtitles === true;
  const wanted = { cover: true, bgm: true, subtitles: wantsText, danmaku: false, transitions: true, color: true, resolution: true };
  const stages = POST_QUALITY_STAGES.map(name => wanted[name]
    ? { name, requirement: "required", artifactIds: groups[name], outputIdsByProof: bindings[name], requestSha256ByProof: requests[name] }
    : { name, requirement: "not_applicable", reason: name === "danmaku" ? "导演 V2 本次未登记弹幕层" : "本次没有字幕文字，未要求制作字幕形态" });
  for (const name of POST_QUALITY_STAGES) if (wanted[name]) receipts.push({ name, status: "completed", artifactIds: groups[name] });
  const contract = { schemaVersion: "workloom.post-contract/v1", phase, resolution: manifest.resolution,
    sourceResolution: manifest.nativeResolution, allowDownscale: manifest.resolutionPolicy?.downscaleApproved === true,
    allowReframe: manifest.resolutionPolicy?.reframeApproved === true, reframeReason: manifest.resolutionPolicy?.reframeReason,
    audioQuality: manifest.audioQuality ?? { mode: "report", targetLufs: -14, toleranceLu: 1, maxTruePeakDbtp: -1 }, stages };
  const report = await inspectPostQuality({ root: base, assets, contract, receipts, checks, bins });
  report.director = { root: base, revision: manifest.revision, sourceCount: manifest.sourceInputs?.length ?? 0,
    expectedOutputs: targets.length, currentPrimaryForms: variants.filter(variant => variant.status === "complete").length,
    independentEdl: true, personQualityReviewed: false };
  return report;
}
