/** V2: one frozen source pool, independently executed picture/audio/subtitle timelines. */
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import {
  directorHash, resolveDeliveryTargets, buildPostVariantPlans, normaliseSourceManifest,
  mapCuesToTimeline, assessPostVariantDifference, DIRECTOR_RECIPES, attributeCreativeFeedback,
  applyTimelineFeedback,
} from "../../library/director-system/core.mjs";
import { collectDirectorPersonQc } from "../../library/director-system/person-qc.mjs";
import {
  normaliseShots, assertPathAllowed, allowedRoots, resolveResolution, resolveBinaries,
  pickTrackForVariant, buildCover, buildCopyPack, PostError,
} from "./core.mjs";
import { runBin, sha256File, probeMedia, extractFrame } from "../subtitle-bridge/measure.mjs";
import {
  parseSrt, cuesToSrt, cuesToVtt, buildAssDocument, srtSecondsToAss, assistToSeconds, stripSubtitlePunctuation, plan as planSubtitle, softMux, renderWithSubtitles,
} from "../subtitle-bridge/core.mjs";
import { grade, frameDifference } from "../color-bridge/core.mjs";
import { renderAudioStems, verifyAudioStemBundle, snapshotAudioStemArtifact, muxAudioProgram } from "../bgm-bridge/audio-stems.mjs";
import { createAudioStemReceiptVerifier } from "../bgm-bridge/audio-stems-trust.mjs";

const SCHEMA = "workloom.film-project/v2";
const fail = (code, message) => { throw new PostError(message, code); };
const writeJson = async (file, value) => {
  const temporary = `${file}.${randomUUID()}.tmp`;
  try { await fsp.writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { flag: "wx", mode: 0o600 }); await fsp.rename(temporary, file); }
  finally { await fsp.rm(temporary, { force: true }); }
};
const portablePath = file => file.replaceAll("\\", "/").replaceAll("'", "'\\''");
const descriptor = async file => ({ path: file, sha256: await sha256File(file), bytes: (await fsp.stat(file)).size });
async function exactFrames(file, bins) {
  const { stdout } = await runBin(bins.ffprobe, ["-v", "error", "-select_streams", "v:0", "-count_frames", "-show_entries", "stream=nb_read_frames,avg_frame_rate", "-of", "json", file], { label: "director(frame-readback)" });
  const count = Number(JSON.parse(stdout)?.streams?.[0]?.nb_read_frames);
  if (!Number.isSafeInteger(count) || count < 1) fail("TIMELINE_INVALID", "成品帧数无法回读");
  return count;
}
async function checkedCopy(source, expectedHash, output, env) {
  return snapshotAudioStemArtifact({ file: source, sha256: expectedHash, output, allowedRoots: allowedRoots(env) });
}
async function verifyFile(artifact, env) {
  if (!artifact?.path || !artifact.sha256) fail("SOURCE_CHANGED", "产物引用缺失");
  const file = assertPathAllowed(artifact.path, allowedRoots(env));
  if (await sha256File(file) !== artifact.sha256) fail("SOURCE_CHANGED", "已冻结产物字节变化");
  return file;
}
async function verifyArtifacts(value, env, checked = new Set(), baseDir = null) {
  if (!value || typeof value !== "object") return;
  const directory=typeof value.dir==="string"?assertPathAllowed(value.dir,allowedRoots(env)):baseDir;
  const file=typeof value.path==="string"?value.path:typeof value.file==="string"&&path.isAbsolute(value.file)?value.file:null;
  if (file && typeof value.sha256 === "string") {
    if(!path.isAbsolute(file)&&!directory) fail("SOURCE_CHANGED","相对产物引用缺少所属目录");
    const absolute=path.isAbsolute(file)?file:path.resolve(directory,file),key=`${absolute}/${value.sha256}`;
    if(!checked.has(key)){await verifyFile({...value,path:absolute},env);checked.add(key);}
  }
  for (const nested of Object.values(value)) if (nested && typeof nested === "object") await verifyArtifacts(nested,env,checked,directory);
}
async function verifyFrozenSnapshot(snapshot,env,bins) {
  if(snapshot.schemaVersion!==SCHEMA) fail("CONTRACT_INVALID","不是 V2 后期工程");
  await verifyArtifacts(snapshot,env);
  for(const shot of snapshot.shots) {
    const expected=snapshot.prepared.source.shots.find(source=>source.shotId===shot.shotId)?.sha256;
    if(!expected || await sha256File(assertPathAllowed(shot.path??shot.localPath,allowedRoots(env)))!==expected)
      fail("SOURCE_CHANGED","共享源镜头已变化，禁止复用旧版回执");
  }
  snapshot.prepared.sourceStems=await verifyAudioStemBundle({dir:snapshot.prepared.sourceStems.dir,
    expectedManifestSha256:snapshot.prepared.sourceStems.manifestSha256,expectedRecipeSha256:snapshot.prepared.sourceStems.recipeSha256,
    scope:snapshot.scope,allowedRoots:allowedRoots(env),verifySource:createAudioStemReceiptVerifier({env,expectedTenant:snapshot.scope.tenantId}),bins});
}
function validateDirectorPatch(patch) {
  const schema={bgm:["enabled","musicLevelDb","fadeInSec","fadeOutSec"],color:["profile","intensity"],
    cover:["at","alignment","marginRatio"],copy:["tone","opening","closing","cta"],subtitles:["style"],timeline:["shotIds","pace","factor"]};
  if(!patch || typeof patch!=="object" || Array.isArray(patch) || !Object.keys(patch).length) fail("POST_PLAN_UNSUPPORTED","返修内容不是已登记的后期层");
  for(const [layer,fields] of Object.entries(patch)) {
    if(!schema[layer] || !fields || typeof fields!=="object" || Array.isArray(fields)
      || Object.keys(fields).some(key=>!schema[layer].includes(key))) fail("POST_PLAN_UNSUPPORTED","返修包含未登记字段");
    for(const [key,value] of Object.entries(fields)) {
      if(["musicLevelDb","fadeInSec","fadeOutSec","intensity","at","alignment","marginRatio","factor"].includes(key)) {
        const range={musicLevelDb:[-48,-10],fadeInSec:[0,5],fadeOutSec:[0,5],intensity:[0,1],at:[0,1],alignment:[1,9],marginRatio:[.05,.3],factor:[.5,1.75]}[key];
        if(typeof value!=="number"||!Number.isFinite(value)||value<range[0]||value>range[1]) fail("POST_PLAN_UNSUPPORTED","返修数值越界");
      } else if(key==="enabled") {if(typeof value!=="boolean") fail("POST_PLAN_UNSUPPORTED","配乐开关非法");}
      else if(key==="shotIds") {if(!Array.isArray(value)||value.length>128||value.some(id=>typeof id!=="string"||!/^SC-\d+$/u.test(id))) fail("POST_PLAN_UNSUPPORTED","节奏镜号非法");}
      else if(typeof value!=="string"||value.length>300||/[\0\r]/u.test(value)) fail("POST_PLAN_UNSUPPORTED","返修文字非法");
    }
    if(layer==="color"&&fields.profile&&!new Set(["natural",...Object.values(DIRECTOR_RECIPES.recipes).map(r=>r.color.profile)]).has(fields.profile)) fail("POST_PLAN_UNSUPPORTED","未登记调色配方");
    if(layer==="subtitles"&&fields.style&&!["大字可读","克制细描边"].includes(fields.style)) fail("POST_PLAN_UNSUPPORTED","未登记字幕样式");
  }
}
function scopeOf(project) {
  const scope = project.audioScope;
  if (!scope || scope.projectId !== (project.projectId ?? project.project_id)
    || (project.tenantId && scope.tenantId !== project.tenantId) || (project.workspaceId && scope.workspaceId !== project.workspaceId)
    || !Number.isSafeInteger(scope.revision) || scope.revision < 1) fail("AUDIO_SOURCE_UNVERIFIED", "工程缺少一致的独立声音作用域");
  return scope;
}
async function lockDirectory(target) {
  await fsp.mkdir(target, { recursive: true });
  const lock = path.join(target, ".director.lock");
  let handle;
  try { handle = await fsp.open(lock, "wx", 0o600); }
  catch (error) {
    if (error.code !== "EEXIST") throw error;
    const owner = JSON.parse(await fsp.readFile(lock,"utf8"));
    let alive=true;
    try { process.kill(owner.pid,0); } catch (probe) { if(probe.code==="ESRCH") alive=false; else throw probe; }
    if(alive) fail("REVISION_CONFLICT", "该工程正被另一个后期任务执行");
    await fsp.unlink(lock);
    try { handle=await fsp.open(lock,"wx",0o600); }
    catch(retry) { if(retry.code==="EEXIST") fail("REVISION_CONFLICT","另一个工人已接管中断任务"); throw retry; }
  }
  await handle.writeFile(JSON.stringify({ pid: process.pid, claimId: randomUUID(), createdAt: new Date().toISOString() }));
  return async () => { await handle.close(); await fsp.unlink(lock); };
}

async function executePicture(plan, normalised, outputDir, bins, env) {
  const rows = [];
  for (const [index, edit] of plan.pictureEdl.entries()) {
    const clip = normalised.find(c => c.shotId === edit.sourceId);
    if (!clip || clip.sourceHash !== edit.sourceSha256) fail("SOURCE_CHANGED", `镜头 ${edit.sourceId} 不在冻结池内`);
    await verifyFile({ path: clip.path, sha256: clip.sha256 }, env);
    const output = path.join(outputDir, `segment-${index}.mp4`);
    await runBin(bins.ffmpeg, ["-hide_banner", "-v", "error", "-n", "-filter_threads", "1", "-i", clip.path,
      "-vf", `trim=start_frame=${edit.inFrame}:end_frame=${edit.outFrame},setpts=PTS-STARTPTS`,
      "-map", "0:v:0", "-an", "-c:v", "libx264", "-preset", "veryfast", "-crf", "18", "-threads", "2", "-r", String(plan.fps), "-pix_fmt", "yuv420p", output],
    { label: "director(picture-segment)", timeoutMs: 900000 });
    const frames = await exactFrames(output, bins);
    if (frames !== edit.outFrame - edit.inFrame) fail("TIMELINE_INVALID", `镜头 ${edit.sourceId} 裁切帧数与 EDL 不符`);
    rows.push({ ...edit, output: await descriptor(output), frames });
  }
  const list = path.join(outputDir, "concat.txt");
  await fsp.writeFile(list, rows.map(row => `file '${portablePath(row.output.path)}'`).join("\n") + "\n");
  const picture = path.join(outputDir, "picture.mp4");
  await runBin(bins.ffmpeg, ["-hide_banner", "-v", "error", "-n", "-f", "concat", "-safe", "0", "-i", list, "-c:v", "copy", "-an", "-movflags", "+faststart", picture], { label: "director(independent-picture)" });
  if (await exactFrames(picture, bins) !== plan.durationFrames) fail("TIMELINE_INVALID", "新时间线拼接帧数不符");
  const readback = { planHash: plan.planHash, pictureEdl: rows.map(({ output, frames, ...row }) => row),
    segments: rows, durationFrames: plan.durationFrames, fps: plan.fps, output: await descriptor(picture) };
  await writeJson(path.join(outputDir, "picture-edl-readback.json"), readback);
  return { picture, readback };
}

async function executeProgram(plan, source, sourceStems, output, bins) {
  const sourceById = new Map(source.shots.map(shot => [shot.shotId, shot]));
  const count = plan.audioEdl.length;
  const filters = count === 1 ? [] : [`[0:a]asplit=${count}${plan.audioEdl.map((_, i) => `[s${i}]`).join("")}`];
  const boundaries = [];
  plan.audioEdl.forEach((edit, index) => {
    const shot = sourceById.get(edit.sourceId);
    const offset = Math.round(shot.sourceStartFrame * 48000 / source.fps);
    const start = offset + edit.inSample, end = offset + edit.outSample;
    filters.push(`${count === 1 ? "[0:a]" : `[s${index}]`}atrim=start_sample=${start}:end_sample=${end},asetpts=N/SR/TB[a${index}]`);
    boundaries.push({ ...edit, sourceStartSample: start, sourceEndSample: end });
  });
  const totalSamples = Math.round(plan.durationFrames * 48000 / plan.fps);
  const join = count === 1 ? "[a0]" : `${plan.audioEdl.map((_, i) => `[a${i}]`).join("")}concat=n=${count}:v=0:a=1`;
  filters.push(`${join}${count === 1 ? "" : ","}apad=whole_len=${totalSamples},atrim=end_sample=${totalSamples},asetpts=N/SR/TB[out]`);
  await runBin(bins.ffmpeg, ["-hide_banner", "-v", "error", "-n", "-i", sourceStems.program.path,
    "-filter_complex", filters.join(";"), "-map", "[out]", "-c:a", "pcm_f32le", "-ar", "48000", "-ac", "2", output],
  { label: "director(aligned-program)", timeoutMs: 1800000 });
  const media = JSON.parse((await runBin(bins.ffprobe, ["-v", "error", "-show_streams", "-show_format", "-of", "json", output])).stdout);
  const audio = media.streams.find(s => s.codec_type === "audio");
  if (Number(audio.sample_rate) !== 48000 || Math.round(Number(audio.duration ?? media.format.duration) * 48000) !== totalSamples) fail("TIMELINE_INVALID", "新节目音轨样点数不符");
  return { ...await descriptor(output), totalSamples, audioEdl: boundaries, musicExcluded: true, sourceProgramSha256: sourceStems.program.sha256 };
}

async function loudness(file, bins) {
  const result = await runBin(bins.ffmpeg, ["-hide_banner", "-v", "info", "-i", file, "-af", "loudnorm=I=-14:TP=-1:LRA=11:print_format=json", "-f", "null", "-"], { label: "director(loudness-readback)" });
  const match = result.stderr.match(/\{\s*"input_i"[\s\S]*?\}/u);
  if (!match) fail("AUDIO_SOURCE_UNVERIFIED", "成片响度无法实测");
  const values = JSON.parse(match[0]);
  return { integratedLufs: Number(values.input_i), truePeakDbtp: Number(values.input_tp), lra: Number(values.input_lra), raw: values };
}

async function mixIndependentMusic(plan, program, output, bins, env) {
  const recipe = { id: plan.variantId, bgm: plan.musicPlan };
  if (plan.musicPlan.enabled === false) {
    await checkedCopy(program.path, program.sha256, output, env);
    return { ...await descriptor(output), musicDisabled: true, musicSha256: null, measured: await loudness(output, bins), programSha256: program.sha256 };
  }
  const track = pickTrackForVariant(recipe, { env });
  const trackHash = await sha256File(track.path);
  const snapshot = path.join(path.dirname(output), "music-source");
  await checkedCopy(track.path, trackHash, snapshot, env);
  const seconds = plan.durationFrames / plan.fps;
  const totalSamples = Math.round(seconds * 48000);
  const arrangement = plan.musicPlan.arrangement ?? {};
  const silence = Math.min(seconds / 4, Math.max(0, Number(arrangement.introSilenceSec ?? 0)));
  const breath = seconds * Number(arrangement.breathAtRatio ?? .45);
  const climax = seconds * Number(arrangement.climaxAtRatio ?? .72);
  const fadeIn = Math.min(seconds / 3, Number(plan.musicPlan.fadeInSec ?? 1.2));
  const fadeOut = Math.min(seconds / 3, Number(plan.musicPlan.fadeOutSec ?? 1.6));
  // Independent source content/arrangement is evidence; gain is never used to certify version difference.
  const musicFilter = `aresample=48000,aformat=channel_layouts=stereo,atrim=end_sample=${totalSamples},asetpts=N/SR/TB,volume=${Number(plan.musicPlan.musicLevelDb ?? -24)}dB,afade=t=in:st=${silence}:d=${fadeIn},afade=t=out:st=${Math.max(0, seconds-fadeOut)}:d=${fadeOut},volume='if(lt(t,${silence}),0,if(between(t,${Math.max(silence, breath-.25)},${breath+.25}),0.35,if(gte(t,${climax}),1,0.75)))':eval=frame`;
  const mixed = path.join(path.dirname(output), "mix-raw.wav");
  const chain = `[0:a]asplit=2[p][side];[1:a]${musicFilter}[music];[music][side]sidechaincompress=threshold=0.03:ratio=6:attack=15:release=180[ducked];[p][ducked]amix=inputs=2:duration=first:dropout_transition=0:normalize=0,atrim=end_sample=${totalSamples}[out]`;
  await runBin(bins.ffmpeg, ["-hide_banner", "-v", "error", "-n", "-i", program.path, "-stream_loop", "-1", "-i", snapshot,
    "-filter_complex", chain, "-map", "[out]", "-ar", "48000", "-ac", "2", "-c:a", "pcm_f32le", mixed], { label: "director(music-arrangement)", timeoutMs: 1800000 });
  const raw = await loudness(mixed, bins);
  if (!Number.isFinite(raw.integratedLufs) || !Number.isFinite(raw.truePeakDbtp)) fail("AUDIO_SOURCE_UNVERIFIED", "声音为静音或测量无效");
  const r = raw.raw;
  const normalize = `loudnorm=I=-14:TP=-1:LRA=11:measured_I=${r.input_i}:measured_TP=${r.input_tp}:measured_LRA=${r.input_lra}:measured_thresh=${r.input_thresh}:offset=${r.target_offset}:linear=true,aresample=48000,apad=whole_len=${totalSamples},atrim=end_sample=${totalSamples}`;
  await runBin(bins.ffmpeg, ["-hide_banner", "-v", "error", "-n", "-i", mixed, "-af", normalize, "-ar", "48000", "-ac", "2", "-c:a", "pcm_f32le", output], { label: "director(normalized-mix)", timeoutMs: 1800000 });
  const measured = await loudness(output, bins);
  if (!Number.isFinite(measured.integratedLufs) || Math.abs(measured.integratedLufs+14) > 1.5 || measured.truePeakDbtp > -.8) fail("AUDIO_SOURCE_UNVERIFIED", "声音响度或真峰值实测未过质量门");
  if (await sha256File(track.path) !== trackHash) fail("SOURCE_CHANGED", "混音期间音乐源变化");
  return { ...await descriptor(output), programSha256: program.sha256, musicSha256: trackHash,
    music: { id: track.id, title: track.title, license: track.license, attribution: track.attribution,
      provenance:track.provenance??null,libraryFallbackReason:track.libraryFallbackReason??null },musicSource:await descriptor(snapshot),
    arrangement: { silence, breath, climax, fadeIn, fadeOut }, measured,
    sourceAuthority: "signed-independent-program", embeddedAudioUsed: false, dialogueTextUnchanged: true,
    checks: { loudness: true, truePeak: true, sidechainDuck: true, independentSources: true } };
}

function cueData(subtitles) {
  if (!subtitles) return { zh: [], en: [] };
  const read = lang => {
    const explicit = subtitles[`${lang}Cues`];
    if (Array.isArray(explicit)) return explicit.map(c => ({ startSec: Number(c.startSec ?? c.startSeconds ?? (typeof c.start === "string" ? assistToSeconds(c.start) : c.start)), endSec: Number(c.endSec ?? c.endSeconds ?? (typeof c.end === "string" ? assistToSeconds(c.end) : c.end)), text: stripSubtitlePunctuation(c.text) }));
    const value = subtitles[`${lang}Text`] ?? (subtitles[`${lang}Path`] ? fs.readFileSync(subtitles[`${lang}Path`], "utf8") : "");
    return value ? parseSrt(value).map(c => ({ startSec: assistToSeconds(c.start), endSec: assistToSeconds(c.end), text: c.text })) : [];
  };
  return { zh: read("zh"), en: read("en") };
}

async function executeSubtitles(plan, source, cues, input, outputDir, bins, softSubtitles, burnSubtitles) {
  const mapped = mapCuesToTimeline(cues.zh, plan, source);
  const mappedEn = mapCuesToTimeline(cues.en, plan, source);
  if (!mapped.length) return { state: "not_applicable", files: [], mapped: [], softsub: null, visibleStyle: null };
  const normalized = mapped.map(c => ({ ...c, start: srtSecondsToAss(c.startSec), end: srtSecondsToAss(c.endSec), startSeconds: c.startSec, endSeconds: c.endSec }));
  const media = await probeMedia(input, { bins });
  const layout = await planSubtitle({ input, resolution: [media.width, media.height], platform: plan.platform,
    cues: normalized, scenes: ["字幕"], bins, analyze: false, outputDir });
  const styles = layout.styles.map(entry => ({ ...entry, style: { ...entry.style,
    fontSize: Math.max(16, Math.round(entry.style.fontSize * Number(plan.subtitlePlan.style.fontScale ?? 1))),
    outline: Number(plan.subtitlePlan.style.outline ?? entry.style.outline),
    bold: Number(plan.subtitlePlan.style.weight ?? 400) >= 600,
    alignment: Number(plan.subtitlePlan.style.alignment ?? 2),
    marginV: Math.round(media.height * Number(plan.subtitlePlan.style.marginRatio ?? .15)) } }));
  const ass = buildAssDocument({ resolution: [media.width, media.height], styles,
    events: normalized.map(c => ({ layer: 0, start: c.start, end: c.end, style: "Sub", name: c.segmentId, text: c.text })) });
  const srt = path.join(outputDir, "film.zh.srt"), assPath = path.join(outputDir, "film.zh.ass"), vtt = path.join(outputDir, "film.vtt");
  await fsp.writeFile(srt, cuesToSrt(normalized)); await fsp.writeFile(assPath, ass); await fsp.writeFile(vtt, cuesToVtt(normalized));
  const back = parseSrt(await fsp.readFile(srt, "utf8"));
  if (back.length !== normalized.length || back.some((c,i) => Math.abs(assistToSeconds(c.start)-normalized[i].startSec)>.011 || Math.abs(assistToSeconds(c.end)-normalized[i].endSec)>.011)) fail("TIMELINE_INVALID", "字幕新时间线回读失败");
  const files = await Promise.all([srt, assPath, vtt].map(descriptor));
  const tracks = [{ path: srt, lang: "chi", title: "中文" }];
  if (mappedEn.length) {
    const enFile = path.join(outputDir, "film.en.srt");
    await fsp.writeFile(enFile, cuesToSrt(mappedEn.map(c=>({ text:c.text,start:srtSecondsToAss(c.startSec),end:srtSecondsToAss(c.endSec),startSeconds:c.startSec,endSeconds:c.endSec }))));
    files.push(await descriptor(enFile)); tracks.push({ path: enFile, lang: "eng", title: "English" });
  }
  const softPath = path.join(outputDir, "film.softsub.mp4");
  const soft = softSubtitles ? await softMux({ input, output: softPath, subtitles: tracks, bins }) : null;
  const burnedPath = path.join(outputDir, "film.burned.mp4");
  const burned = burnSubtitles ? await renderWithSubtitles({ input, output: burnedPath, cues: normalized,
    platform: plan.platform, bins, evidenceDir:outputDir,
    styleOverrides: Object.fromEntries(styles.map(entry => [entry.name, entry.style])) }) : null;
  return { state: "ready", files, mapped, mappedEn, styles, softsub: soft ? await descriptor(softPath) : null,
    burned: burned ? { ...await descriptor(burnedPath), checks: burned.checks, evidence: burned.evidence } : null,
    visibleStyle: { styles, assSha256: (await descriptor(assPath)).sha256 },
    note: "MP4 开关字幕保留文字和时间；ASS 版式随包提供，样式差异不以 MP4 mov_text 冒充" };
}

async function prepareSources({ project, shots, workDir, bins, env }) {
  scopeOf(project);
  if (!Array.isArray(shots) || !shots.length || shots.some(s=>!s.audioStems)) fail("AUDIO_SOURCE_UNVERIFIED", "每镜需要独立声音或内部签发的不适用决定");
  for (const shot of shots) assertPathAllowed(shot.path ?? shot.localPath, allowedRoots(env), "shot");
  const normalised = await normaliseShots({ shots, project, workDir, bins, env });
  const sourceManifest = { fps: Number(project.fps ?? 30), chronologyLocked: project.chronologyLocked === true,
    shots: normalised.map((clip,i) => ({ shotId: clip.shotId, sha256: clip.sourceHash,
      durationSec: clip.duration, role: shots[i].role, dialogue: shots[i].dialogue ?? "", lockTrim: shots[i].lockTrim,
      required: shots[i].required !== false })) };
  const source = normaliseSourceManifest(sourceManifest);
  const verifySource = createAudioStemReceiptVerifier({ env, expectedTenant: project.audioScope.tenantId });
  const sourceStems = await renderAudioStems({ scope: project.audioScope,
    shots: normalised.map(c => ({ shotId: c.shotId, videoSha256: c.sourceHash, normalisedVideoSha256: c.sha256,
      sourceDurationSec: c.sourceDuration, durationSec: c.duration, stems: c.audioStems })),
    transitions: { mode: "hard" }, outDir: path.join(workDir, "source-stems"), allowedRoots: allowedRoots(env), verifySource, bins });
  return { normalised, sourceManifest, source, sourceStems };
}

async function executeVariant({ plan, prepared, project, target, bins, env, cues, softSubtitles, burnSubtitles, previous = null, layers = null }) {
  const dir = path.join(target, "variants", plan.variantId); await fsp.mkdir(dir, { recursive: true });
  let picture, readback, program, graded, mix, video;
  const pictureChanged = !previous || ["shots", "assemble"].some(layer=>layers?.includes(layer));
  const colorChanged = pictureChanged || layers?.includes("color");
  const audioChanged = pictureChanged || layers?.includes("audio");
  const reusableVideo = previous && !colorChanged && !audioChanged;
  if (reusableVideo) {
    await verifyFile(previous.video, env);
    picture = previous.layers.picture; readback = previous.actual;
    program = previous.layers.program; graded = previous.layers.graded; mix = previous.audio;
    video = await checkedCopy(previous.video.path, previous.video.sha256, path.join(dir, "film.mp4"), env);
  } else {
    if (pictureChanged) {
      const pictureResult = await executePicture(plan, prepared.normalised, dir, bins, env);
      picture = await descriptor(pictureResult.picture); readback = pictureResult.readback;
      program = await executeProgram(plan, prepared.source, prepared.sourceStems, path.join(dir, "program.wav"), bins);
    } else {
      picture = previous.layers.picture; readback = previous.actual; program = previous.layers.program;
      await verifyFile(picture, env); await verifyFile(program, env);
    }
    if (colorChanged) {
    const gradedPath = path.join(dir, "graded.mp4");
    const neutral=plan.gradePlan.profile==="natural";
    const colorReport = await grade({ input: picture.path, output: gradedPath, profile: neutral?null:plan.gradePlan.profile,
      corrections:neutral?{eq:{contrast:1.03,saturation:1.04}}:{},
      intensity: Number(plan.gradePlan.intensity ?? .8), quality: project.quality ?? "hd", bins, defects: true });
    const lookProof=path.join(dir,"look-proof.png");
    await runBin(bins.ffmpeg,["-hide_banner","-v","error","-n","-i",prepared.normalised[0].path,"-vf",colorReport.chain,"-frames:v","1",lookProof],{label:"director(same-source-look-proof)"});
    graded = { ...await descriptor(gradedPath), lookProof:await descriptor(lookProof), report: { chain:colorReport.chain,delta:colorReport.delta,visibility: colorReport.visibility ?? colorReport.verification?.visibility ?? null,
      note: "调色仍需人物局部和商品本色对照，整帧代理不等于肤色保护" } };
    } else { graded = previous.layers.graded; await verifyFile(graded, env); await verifyFile(graded.lookProof, env); }
    if (audioChanged) mix = await mixIndependentMusic(plan, program, path.join(dir, "mixed.wav"), bins, env);
    else { mix = previous.audio; await verifyFile(mix, env); }
    video = await muxAudioProgram({ videoPath: graded.path, videoSha256: graded.sha256, programPath: mix.path,
      programSha256: mix.sha256, output: path.join(dir, "film.mp4"), allowedRoots: allowedRoots(env), bins });
  }
  const probe = await probeMedia(video.path, { bins });
  const count = await exactFrames(video.path, bins);
  if (count !== plan.durationFrames || Math.abs(Number(probe.videoDuration)-count/plan.fps) > 1/plan.fps+.001) fail("TIMELINE_INVALID", "成品与实际 EDL 时长不一致");
  const subtitleDir = path.join(dir, "subtitles"); await fsp.mkdir(subtitleDir, { recursive: true });
  const reuseSubtitles = reusableVideo && !layers?.includes("text");
  let subtitles;
  if(reuseSubtitles) {
    subtitles=structuredClone(previous.subtitles);
    for(const key of ["softsub","burned"]) if(subtitles[key]) {
      const copied=await checkedCopy(subtitles[key].path,subtitles[key].sha256,path.join(subtitleDir,path.basename(subtitles[key].path)),env);
      subtitles[key]={...subtitles[key],...copied};
    }
    subtitles.files=await Promise.all((subtitles.files??[]).map(async artifact=>({...artifact,
      ...await checkedCopy(artifact.path,artifact.sha256,path.join(subtitleDir,path.basename(artifact.path)),env)})));
  } else subtitles=await executeSubtitles(plan, prepared.source, cues, video.path, subtitleDir, bins, softSubtitles, burnSubtitles);
  const pack = { ...structuredClone(DIRECTOR_RECIPES.recipes[plan.recipeId]), id: plan.variantId,
    cover: plan.coverPlan, copy: plan.copyPlan, bgm: plan.musicPlan, color: plan.gradePlan };
  const coverSize = plan.platform === "xiaohongshu" ? [Math.round(probe.width/2)*2, Math.round(probe.width*4/3/2)*2] : [probe.width, probe.height];
  // Cover is a separate canvas. Letterboxing preserves the subject when ratios differ.
  let cover;
  const reuseCover = previous && !pictureChanged && !colorChanged && !layers?.includes("cover");
  if (reuseCover) {
    const copied = await checkedCopy(previous.cover.path, previous.cover.sha256, path.join(dir, "cover.png"), env);
    cover = { ...copied, output: copied.path, text: previous.cover.text, checks: [] };
  } else {
  const coverSource = path.join(dir, "cover-canvas.mp4");
  await runBin(bins.ffmpeg, ["-hide_banner", "-v", "error", "-n", "-filter_threads", "1", "-i", video.path,
    "-vf", `scale=${coverSize[0]}:${coverSize[1]}:force_original_aspect_ratio=decrease,pad=${coverSize[0]}:${coverSize[1]}:(ow-iw)/2:(oh-ih)/2`,
    "-an", "-c:v", "libx264", "-threads", "2", "-preset", "veryfast", coverSource], { label: "director(cover-canvas)", timeoutMs: 900000 });
  cover = await buildCover({ input: coverSource, output: path.join(dir, "cover.png"), project,
    variant: pack, resolution: coverSize, platform: plan.platform, bins, workDir: dir });
  if (cover.checks.some(c=>!c.ok)) fail("POST_PLAN_UNSUPPORTED", "封面实际版式检查失败");
  }
  const copy = buildCopyPack({ project, variant: pack });
  const copyPath = path.join(dir, "copy.json");
  const reuseCopy = previous && !layers?.includes("copy");
  if (reuseCopy) await checkedCopy(previous.copy.path, previous.copy.sha256, copyPath, env);
  else await writeJson(copyPath, copy);
  const reuseQc=previous && !pictureChanged && !colorChanged;
  const qc = reuseQc ? previous.personQc : await collectDirectorPersonQc({input:video.path,plan,filmPlan:project.directorFilmPlan,
    outDir:path.join(dir,"person-qc"),bins,personRegions:project.personRegions??[]});
  const actual = { variantId: plan.variantId, planHash: plan.planHash, pictureEdl: readback.pictureEdl,
    durationFrames: count, videoSha256: await sha256File(video.path), edlVerified: true,
    visualVerified: true, colorSignature: graded.lookProof?.sha256??null,
    audioVerified: true, audioSignature: directorHash({ music: mix.musicSha256, arrangement: mix.arrangement ?? null, program: program.sha256 }),
    subtitleVerified: Boolean(subtitles.burned), subtitleSignature: subtitles.burned ? directorHash(subtitles.styles) : null,
    coverVerified: true, coverSha256: cover.sha256 };
  const result = { id: plan.variantId, name: plan.label, label: plan.label, platform: plan.platform, kind: plan.kind,
    recommended: plan.recommended, recommendationReason: plan.recommendationReason, status: "complete", plan,
    video: { ...await descriptor(video.path), duration: count/plan.fps, resolution: [probe.width, probe.height] },
    softsub: subtitles.softsub, burned: subtitles.burned, cover: { ...await descriptor(cover.output), text: cover.text, resolution: coverSize },
    copy: { ...await descriptor(copyPath), title: copy.title }, subtitles, audio: mix, actual,
    personQc: qc, layers: { picture, program, graded }, reusedVideo: Boolean(reusableVideo),
    reusedLayers: previous ? { picture: !pictureChanged, program: !pictureChanged, color: !colorChanged, audio: !audioChanged,
      subtitles:Boolean(reuseSubtitles),personQc:Boolean(reuseQc),cover: Boolean(reuseCover), copy: Boolean(reuseCopy) } : {},
    sourceGenerationCalls: 0 };
  await writeJson(path.join(dir, "variant-receipt.json"), result);
  return result;
}

async function pairEvidence(plans, variants, bins) {
  // Compare complete outputs at three relative times. These are visual proxies; human aesthetic calibration stays separate.
  const pairs = [];
  for (let i=0;i<variants.length;i++) for (let j=i+1;j<variants.length;j++) {
    const a=variants[i], b=variants[j];
    const at = [.1,.45,.8].map(r=>Math.min(a.video.duration,b.video.duration)*r);
    const difference = await frameDifference({ before:a.video.path,after:b.video.path,at,bins });
    const lookDifference=await frameDifference({before:a.layers.graded.lookProof.path,after:b.layers.graded.lookProof.path,at:[0],bins});
    pairs.push({ a:a.id,b:b.id,visual:difference,look:lookDifference });
    if (lookDifference.verdict === "negligible") { a.actual.visualVerified=false; b.actual.visualVerified=false; }
  }
  return { ...assessPostVariantDifference(plans, variants.map(v=>v.actual)), visualPairs:pairs,
    humanAestheticReview:"not_run", thresholds:"initial production proxies; calibrate with paired films" };
}

export async function buildDirectorDelivery({ project = {}, shots = [], subtitles = null, outDir,
  softSubtitles = true, burnSubtitles = true, bins = resolveBinaries(), env = process.env,
  targetPlan = null, plannedVariants = null, preparedSources = null, previousVariants = null, impactLayers = null } = {}) {
  const projectId = String(project.projectId ?? project.project_id ?? "");
  if (!projectId || !outDir) fail("CONTRACT_INVALID", "工程 ID 或输出目录缺失");
  const target = assertPathAllowed(outDir, allowedRoots(env), "outDir");
  const targetContract = targetPlan ?? project.deliveryTargetPlan ?? resolveDeliveryTargets(project.intent ?? project.rawIntent ?? project.title ?? "", project.deliveryOptions ?? {});
  const requestHash = directorHash({ project, shots, subtitles, targetContract, plannedVariants, softSubtitles, burnSubtitles });
  const release = await lockDirectory(target);
  try {
    const manifestFile = path.join(target,"delivery-manifest.json");
    if (fs.existsSync(manifestFile)) {
      const existing = JSON.parse(await fsp.readFile(manifestFile,"utf8"));
      if (existing.requestHash !== requestHash) fail("REVISION_CONFLICT", "输出目录属于另一个输入快照");
      const projectFile=path.join(target,"film-project.json");
      if(!existing.projectSha256 || await sha256File(projectFile)!==existing.projectSha256) fail("SOURCE_CHANGED","已完成工程快照已变化");
      const snapshot=JSON.parse(await fsp.readFile(projectFile,"utf8"));
      if(snapshot.requestHash!==requestHash) fail("SOURCE_CHANGED","已完成工程与输入快照不一致");
      await verifyFrozenSnapshot(snapshot,env,bins);await verifyArtifacts(existing,env);
      return { ...existing,manifest:existing,reused:true,outputDir:target,outDir:target,
        passed:existing.status==="complete",manifestPath:manifestFile,projectPath:path.join(target,"film-project.json") };
    }
    const workDir = path.join(target,"work"); await fsp.mkdir(workDir,{recursive:true});
    const prepared = preparedSources ?? await prepareSources({project,shots,workDir,bins,env});
    const revision = Number(project.revision ?? project.audioScope.revision);
    const plans = plannedVariants ?? buildPostVariantPlans({sourceManifest:prepared.sourceManifest,targetPlan:targetContract,
      scope:{...project.audioScope,revision},hardConstraints:project.hardConstraints??{},narrativePlans:project.directorFilmPlan?.narrativePlans??[]});
    if (plans.length !== targetContract.expectedOutputs || new Set(plans.map(p=>p.variantId)).size !== plans.length
      || plans.some(p=>!targetContract.targets.some(t=>t.variantId===p.variantId && t.platform===p.platform))) fail("CONTRACT_INVALID", "输出计划与目标集合不一致");
    for(const plan of plans) {
      const {planHash,...body}=plan;
      if(planHash!==directorHash(body) || plan.sourceManifestHash!==directorHash(prepared.source)) fail("SOURCE_CHANGED","逐版合同和冻结源不一致");
    }
    const cues = cueData(subtitles);
    const variants = [],failures=[];
    for(const plan of plans) {
      try { variants.push(await executeVariant({plan,prepared,project,target,bins,env,cues,softSubtitles,burnSubtitles,
        previous:previousVariants?.find(v=>v.id===plan.variantId),layers:impactLayers?.[plan.variantId]??null})); }
      catch(error) { const failure={id:plan.variantId,name:plan.label,platform:plan.platform,kind:plan.kind,status:"failed",code:error.code??"POST_FAILED",message:error.message}; variants.push(failure); failures.push(failure); }
      await writeJson(path.join(target,"progress.json"),{expectedOutputs:plans.length,completed:variants.filter(v=>v.status==="complete").length,variants:variants.map(v=>({id:v.id,status:v.status,code:v.code}))});
    }
    const completed=variants.filter(v=>v.status==="complete");
    const differences=failures.length?{approved:false,errors:["交付版本未齐全"]}:await pairEvidence(plans,completed,bins);
    // Reauthorize exact source receipts after long encoding and before publishing any finished package.
    const verify=createAudioStemReceiptVerifier({env,expectedTenant:project.audioScope.tenantId});
    for(const item of prepared.sourceStems.sources) await verify(item);
    const result={schemaVersion:"workloom.delivery-package/v2",projectId,revision,requestHash,
      status:failures.length?"partial":differences.approved?"complete":"difference-failed",expectedOutputs:plans.length,
      variants,difference: differences,failures,quality:project.quality??"hd",resolution:resolveResolution(project),
      sourceGenerationCalls:0,renderApiCalls:0,createdAt:new Date().toISOString(),targetPlan:targetContract};
    const snapshot={schemaVersion:SCHEMA,projectId,version:revision,scope:scopeOf(project),project,shots,subtitles,
      targetPlan:targetContract,plans,prepared,variants,requestHash,deliveryManifest:"delivery-manifest.json",
      revisionRoot:project.revisionRoot??target,softSubtitles,burnSubtitles};
    await writeJson(path.join(target,"film-project.json"),snapshot);
    result.projectSha256=await sha256File(path.join(target,"film-project.json"));
    if (!project.revisionRoot) await writeJson(path.join(target,"revision-head.json"), { version:revision,
      projectPath:path.join(target,"film-project.json"),projectSha256:await sha256File(path.join(target,"film-project.json")),operations:{} });
    await writeJson(manifestFile,result);
    await fsp.writeFile(path.join(target,"delivery-report.md"),`# ${project.title??projectId}\n\n状态：${result.status}；${completed.length}/${plans.length} 支完成。\n\n${variants.map(v=>`- ${v.name}：${v.status}${v.message?` — ${v.message}`:""}`).join("\n")}\n\n共享镜头生成调用：0。独立 EDL、声音、字幕、封面和哈希见清单。人物审美与真实客户提升未在本次本地编码中验证。\n`);
    return {...result,manifest:result,outDir:target,outputDir:target,projectPath:path.join(target,"film-project.json"),
      manifestPath:manifestFile,reportPath:path.join(target,"delivery-report.md"),packageKey:requestHash,
      passed:result.status==="complete",checks:[{kind:"complete-target-set",ok:!failures.length},{kind:"actual-variant-difference",ok:differences.approved}]};
  } catch(error) {
    await writeJson(path.join(target,"failure.json"),{status:"failed",requestHash,code:error.code??"POST_FAILED",message:error.message,failedAt:new Date().toISOString()});
    throw error;
  } finally { await release(); }
}

export async function reviseDirectorDelivery({projectPath,feedback,variantId=null,patch=null,expectedVersion,expectedProjectSha256,idempotencyKey,outDir,bins=resolveBinaries(),env=process.env}={}) {
  const file=assertPathAllowed(projectPath,allowedRoots(env));
  if(!/^[a-zA-Z0-9_-]{1,128}$/u.test(idempotencyKey??"")) fail("CONTRACT_INVALID","返修幂等键缺失或非法");
  const initial=JSON.parse(await fsp.readFile(file,"utf8"));
  const base=assertPathAllowed(initial.revisionRoot??path.dirname(file),allowedRoots(env)),release=await lockDirectory(base);
  try {
    const currentHash=await sha256File(file),snapshot=JSON.parse(await fsp.readFile(file,"utf8"));
    if(snapshot.schemaVersion!==SCHEMA) fail("CONTRACT_INVALID","不是 V2 后期工程");
    const operationHash=directorHash({feedback,variantId,patch,expectedVersion,expectedProjectSha256});
    const journal=path.join(base,"revision-head.json");
    const head=fs.existsSync(journal)?JSON.parse(await fsp.readFile(journal,"utf8")):{version:snapshot.version,projectPath:file,projectSha256:currentHash,operations:{}};
    const prior=head.operations[idempotencyKey];
    if(prior) {
      if(prior.hash!==operationHash) fail("IDEMPOTENCY_MISMATCH","同幂等键对应不同反馈");
      if(prior.receipt && fs.existsSync(prior.receipt)) {
        if(!prior.receiptSha256 || await sha256File(assertPathAllowed(prior.receipt,allowedRoots(env)))!==prior.receiptSha256)
          fail("SOURCE_CHANGED","返修回执字节已变化");
        const replay=JSON.parse(await fsp.readFile(prior.receipt,"utf8"));
        if(replay.operationHash!==operationHash) fail("IDEMPOTENCY_MISMATCH","回执与本次反馈不一致");
        await verifyArtifacts(replay,env);return {...replay,idempotentReplay:true};
      }
    }
    if(snapshot.version!==expectedVersion || currentHash!==expectedProjectSha256 || head.version!==snapshot.version
      || path.resolve(head.projectPath)!==path.resolve(file) || head.projectSha256!==currentHash) fail("REVISION_CONFLICT","该工程已有较新版本或基础字节变化，请重新读取后提交反馈");
    const attribution=attributeCreativeFeedback(feedback,{variantId,variants:snapshot.variants});
    if(patch) {
      validateDirectorPatch(patch);
      attribution.patch=patch;
    }
    if(attribution.requiresNewRender) return {status:"requires-generation-plan",attribution,renderApiCalls:0,requiredApproval:"new-generation-budget",affectedShots:attribution.patch.shots.regenerate};
    await verifyFrozenSnapshot(snapshot,env,bins);
    const prepared=snapshot.prepared;
    const layerMap={},plans=snapshot.plans.map(original=>{
      const plan=structuredClone(original); delete plan.planHash;
      const selected=!attribution.selectedVariantId || attribution.selectedVariantId===plan.variantId;
      const layers=[];
      if(selected) for(const [key,patch] of Object.entries(attribution.patch)) {
        if(key==="bgm"){plan.musicPlan={...plan.musicPlan,...patch};layers.push("audio");}
        if(key==="color"){plan.gradePlan={...plan.gradePlan,...patch};layers.push("color");}
        if(key==="cover"){plan.coverPlan={...plan.coverPlan,...patch};layers.push("cover");}
        if(key==="copy"){plan.copyPlan={...plan.copyPlan,...patch};layers.push("copy");}
        if(key==="subtitles"){plan.subtitlePlan.style={...plan.subtitlePlan.style,fontScale:patch.style==="大字可读"?1.08:.91};layers.push("text");}
        if(key==="timeline") {
          const changed=applyTimelineFeedback(plan,prepared.sourceManifest,patch);
          Object.assign(plan,changed);delete plan.planHash;layers.push("assemble","audio","text");
        }
      }
      plan.parentRevision=snapshot.version;plan.scope={...plan.scope,revision:snapshot.version+1};layerMap[plan.variantId]=layers;
      return {...plan,planHash:directorHash(plan)};
    });
    const destination=assertPathAllowed(outDir??path.join(base,"revisions",`v${snapshot.version+1}`),allowedRoots(env));
    if(destination===base || destination===path.dirname(file)) fail("REVISION_CONFLICT","返修必须写入新的版本目录");
    if(prior?.destination && prior.destination!==destination) fail("IDEMPOTENCY_MISMATCH","幂等重试输出目录变化");
    if(prior && fs.existsSync(destination) && !fs.existsSync(path.join(destination,"delivery-manifest.json"))) await fsp.rm(destination,{recursive:true,force:true});
    await writeJson(journal,{...head,operations:{...head.operations,[idempotencyKey]:{hash:operationHash,destination,status:"running"}}});
    const result=await buildDirectorDelivery({project:{...snapshot.project,revision:snapshot.version+1,revisionRoot:base},shots:snapshot.shots,subtitles:snapshot.subtitles,
      targetPlan:snapshot.targetPlan,plannedVariants:plans,preparedSources:prepared,previousVariants:snapshot.variants,impactLayers:layerMap,
      softSubtitles:snapshot.softSubtitles,burnSubtitles:snapshot.burnSubtitles,outDir:destination,bins,env});
    const receipt=path.join(destination,"feedback-receipt.json");
    const response={...result,attribution,baseVersion:snapshot.version,newVersion:snapshot.version+1,idempotencyKey,operationHash,
      regeneratedSourceShots:0,impactLayers:layerMap};
    await writeJson(receipt,response);
    await writeJson(journal,{version:snapshot.version+1,projectPath:result.projectPath,projectSha256:await sha256File(result.projectPath),
      operations:{...head.operations,[idempotencyKey]:{hash:operationHash,receipt,receiptSha256:await sha256File(receipt),destination,status:"complete"}}});
    return response;
  } finally {await release();}
}

/** Read-only V2 plan; no signing, media creation or network submissions. */
export async function planDirectorDelivery({project={},shots=[],bins=resolveBinaries(),env=process.env}={}) {
  const probed=[];
  for(const [i,shot] of shots.entries()) {
    const file=assertPathAllowed(shot.path??shot.localPath,allowedRoots(env));
    const media=await probeMedia(file,{bins});
    probed.push({shotId:shot.shotId??`SC-${i+1}`,sha256:await sha256File(file),durationSec:media.videoDuration??media.duration,
      role:shot.role,dialogue:shot.dialogue,lockTrim:shot.lockTrim,required:shot.required});
  }
  const sourceManifest={fps:Number(project.fps??30),chronologyLocked:project.chronologyLocked===true,shots:probed};
  const targetPlan=project.deliveryTargetPlan??resolveDeliveryTargets(project.intent??project.title??"",project.deliveryOptions??{});
  return {schemaVersion:"workloom.delivery-plan/v2",projectId:project.projectId??project.project_id,targetPlan,sourceManifest,
    variants:buildPostVariantPlans({sourceManifest,targetPlan,scope:project.audioScope??{},hardConstraints:project.hardConstraints??{},narrativePlans:project.directorFilmPlan?.narrativePlans??[]}),
    renderApiCalls:0,sourceGenerationCalls:0,cost:{localEncoding:"按实际编码时长计；不重复源镜头生成",llmPlanning:"以原任务预算计"}};
}
