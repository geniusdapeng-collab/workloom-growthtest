import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import {
  fontsRoot, loadFontCatalog, parseAssEvents, parseSrt, renderDanmaku, renderKaraoke,
  renderSticker, renderTitle, renderWithSubtitles, softMux, srtSecondsToAss,
} from "./core.mjs";
import { probeMedia, resolveBinaries } from "./measure.mjs";

const bins = resolveBinaries();
const available = [bins.ffmpeg, bins.ffprobe]
  .every(bin => spawnSync(bin, ["-version"], { stdio: "ignore" }).status === 0);
const mediaTest = (name, fn) => test(name, { skip: !available }, fn);
const sha = file => createHash("sha256").update(fs.readFileSync(file)).digest("hex");
let root, input, shortVideo, sourceHash, suppressedBins, unknownDurationBins;
const common = () => ({ input, bins, evidenceDir: path.join(root, "evidence"),
  fontsDir: fontsRoot(), catalog: loadFontCatalog(), brief: { 语言: "zh", 平台: "默认" } });
const cue = (start = "0:00:00.10", end = "0:00:01.10", text = "真实字幕") => ({ start, end, text });
const outputFor = name => path.join(root, `${name}.mp4`);

before(() => {
  if (!available) return;
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "subtitle-timeline-")));
  input = path.join(root, "source.mp4");
  execFileSync(bins.ffmpeg, ["-hide_banner", "-v", "error", "-n",
    "-f", "lavfi", "-i", "color=c=black:s=640x360:r=30:d=3",
    "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000:duration=3",
    "-map", "0:v:0", "-map", "1:a:0", "-c:v", "libx264", "-pix_fmt", "yuv420p",
    "-c:a", "aac", "-shortest", input], { stdio: "pipe", timeout: 30000 });
  sourceHash = sha(input);
  shortVideo = path.join(root, "short-video-long-audio.mp4");
  execFileSync(bins.ffmpeg, ["-hide_banner", "-v", "error", "-n",
    "-f", "lavfi", "-i", "color=c=black:s=640x360:r=30:d=1",
    "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000:duration=3",
    "-map", "0:v:0", "-map", "1:a:0", "-c:v", "libx264", "-pix_fmt", "yuv420p",
    "-c:a", "aac", shortVideo], { stdio: "pipe", timeout: 30000 });
  const proxy = path.join(root, "ffmpeg-without-fontselect.mjs");
  fs.writeFileSync(proxy, `#!${process.execPath}\nimport { spawnSync } from 'node:child_process';\nconst result = spawnSync(${JSON.stringify(bins.ffmpeg)}, process.argv.slice(2), { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });\nif (result.error) { process.stderr.write(String(result.error)); process.exit(70); }\nprocess.stdout.write(result.stdout ?? '');\nprocess.stderr.write((result.stderr ?? '').split('\\n').filter(line => !line.includes('fontselect:')).join('\\n'));\nprocess.exit(result.status ?? 71);\n`);
  fs.chmodSync(proxy, 0o755);
  suppressedBins = { ...bins, ffmpeg: proxy };
  const probeProxy = path.join(root, "ffprobe-without-video-duration.mjs");
  fs.writeFileSync(probeProxy, `#!${process.execPath}\nimport { spawnSync } from 'node:child_process';\nconst result = spawnSync(${JSON.stringify(bins.ffprobe)}, process.argv.slice(2), { encoding: 'utf8' });\nif (result.error) { process.stderr.write(String(result.error)); process.exit(70); }\nif (result.status !== 0) { process.stderr.write(result.stderr ?? ''); process.exit(result.status ?? 71); }\nconst doc = JSON.parse(result.stdout);\nfor (const stream of doc.streams ?? []) if (stream.codec_type === 'video') { delete stream.duration; delete stream.nb_frames; stream.avg_frame_rate = '0/0'; stream.r_frame_rate = '0/0'; }\nprocess.stdout.write(JSON.stringify(doc));\n`);
  fs.chmodSync(probeProxy, 0o755);
  unknownDurationBins = { ...bins, ffprobe: probeProxy };
});
after(() => {
  if (root) {
    assert.equal(sha(input), sourceHash, "original source bytes must be unchanged by every success and failure");
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("SRT rejects a malformed singleton block among valid cues", () => {
  assert.throws(() => parseSrt("1\n00:00:00,100 --> 00:00:01,100\n有效\n\n坏块\n"),
    error => error.code === "bad_srt");
});
test("SRT rejects minute or second overflow", () => {
  for (const time of ["00:60:00,100", "00:00:60,100"]) {
    assert.throws(() => parseSrt(`1\n${time} --> 01:00:01,100\n非法时间\n`),
      error => error.code === "bad_srt");
  }
});
test("ASS rejects truncated dialogue or invalid time fields", () => {
  for (const dialogue of ["Dialogue: 0,0:00:00.10", "Dialogue: 0,0:60:00.00,1:00:01.00,Sub,,0,0,0,,内容",
    "Dialogue: 0,0:00:00.10,0:00:01.10,,,0,0,0,,内容"]) {
    assert.throws(() => parseAssEvents(dialogue), error => error.code === "bad_srt");
  }
});
test("ASS centisecond serialization carries at a minute or hour boundary", () => {
  assert.equal(srtSecondsToAss(59.999), "0:01:00.00");
  assert.equal(srtSecondsToAss(3599.999), "1:00:00.00");
  for (const seconds of [NaN, Infinity, -1]) assert.throws(() => srtSecondsToAss(seconds),
    error => error.code === "bad_srt");
});
mediaTest("container audio duration cannot authorize a cue after the final video frame", async () => {
  const facts = await probeMedia(shortVideo, { bins });
  assert.equal(facts.videoDuration, 1);
  assert.ok(facts.duration >= 3);
  await assert.rejects(renderWithSubtitles({ ...common(), input: shortVideo,
    output: outputFor("outside-short-video"), cues: [cue("0:00:02.00", "0:00:02.50")] }),
    error => error.code === "bad_srt");
});
mediaTest("unknown video duration is not filled from the audio container duration", async () => {
  const facts = await probeMedia(input, { bins: unknownDurationBins });
  assert.equal(facts.videoDuration, null);
  await assert.rejects(renderWithSubtitles({ ...common(), bins: unknownDurationBins,
    output: outputFor("unknown-video-duration"), cues: [cue()] }), error => error.code === "bad_media");
});

mediaTest("subtitle burn rejects every cue wholly after the actual video", async () => {
  const output = outputFor("outside-subtitle");
  await assert.rejects(renderWithSubtitles({ ...common(), output, cues: [cue("0:00:10.00", "0:00:11.00")] }),
    error => error.code === "bad_srt");
  assert.equal(fs.existsSync(output), false);
});
mediaTest("subtitle burn rejects mixed valid and invalid cues without dropping text", async () => {
  const output = outputFor("mixed-subtitle");
  await assert.rejects(renderWithSubtitles({ ...common(), output, cues: [cue(), cue("0:00:10.00", "0:00:11.00")] }),
    error => error.code === "bad_srt");
  assert.equal(fs.existsSync(output), false);
});
mediaTest("subtitle burn rejects a cue that crosses the video end", async () => {
  await assert.rejects(renderWithSubtitles({ ...common(), output: outputFor("crossing-subtitle"),
    cues: [cue("0:00:02.50", "0:00:03.50")] }), error => error.code === "bad_srt");
});
mediaTest("subtitle burn rejects a zero duration event", async () => {
  await assert.rejects(renderWithSubtitles({ ...common(), output: outputFor("zero-subtitle"),
    cues: [cue("0:00:01.00", "0:00:01.00")] }), error => error.code === "bad_srt");
});
mediaTest("title and karaoke use the same video timeline contract", async () => {
  await assert.rejects(renderTitle({ ...common(), output: outputFor("outside-title"), titleText: "标题", titleDurationSec: 4 }),
    error => error.code === "bad_srt");
  await assert.rejects(renderKaraoke({ ...common(), output: outputFor("outside-karaoke"),
    cues: [cue("0:00:10.00", "0:00:11.00")] }), error => error.code === "bad_srt");
});
mediaTest("default title fits the actual video while explicit zero duration fails", async () => {
  const output = outputFor("default-short-title");
  const report = await renderTitle({ ...common(), input: shortVideo, output, titleText: "短片标题" });
  assert.ok(report.textTimeline.last <= 1.01);
  assert.equal(report.output.hash, sha(output));
  await assert.rejects(renderTitle({ ...common(), output: outputFor("zero-title"), titleText: "标题", titleDurationSec: 0 }),
    error => error.code === "bad_srt");
});
mediaTest("sticker rejects a valid hold entirely after the video", async () => {
  await assert.rejects(renderSticker({ ...common(), output: outputFor("outside-sticker"),
    stickers: [{ text: "贴纸", start: 10, end: 12, x: 0.5, y: 0.3 }] }), error => error.code === "bad_srt");
});
mediaTest("danmaku rejects an item starting at or after the video end", async () => {
  for (const at of [3, 10]) {
    const output = outputFor(`outside-danmaku-${at}`);
    await assert.rejects(renderDanmaku({ ...common(), output, items: [{ at, mode: "top", text: "弹幕" }] }),
      error => error.code === "bad_srt");
    assert.equal(fs.existsSync(output), false);
  }
});
mediaTest("danmaku does not discard an invalid item under an explicit density limit", async () => {
  await assert.rejects(renderDanmaku({ ...common(), output: outputFor("mixed-danmaku"), maxConcurrent: 1,
    items: [{ at: 0.1, text: "有效", mode: "top" }, { at: 10, text: "越界", mode: "top" }] }),
  error => error.code === "bad_srt");
});
mediaTest("missing actual render fontselect remains unverified and deletes the output", async () => {
  for (const kind of ["subtitle", "danmaku"]) {
    const output = outputFor(`unverified-font-${kind}`);
    const request = { ...common(), bins: suppressedBins, output };
    await assert.rejects(kind === "subtitle"
      ? renderWithSubtitles({ ...request, cues: [cue()] })
      : renderDanmaku({ ...request, items: [{ at: 0.1, text: "弹幕", mode: "top" }] }),
    error => error.code === "verify_failed");
    assert.equal(fs.existsSync(output), false);
  }
});
mediaTest("real subtitle and natural clipped danmaku render with bound receipts", async () => {
  const subtitleOutput = outputFor("valid-subtitle");
  const report = await renderWithSubtitles({ ...common(), output: subtitleOutput, cues: [cue()] });
  assert.equal(report.checks.timeline_within_video, true);
  assert.equal(report.checks.source_bytes_unchanged, true);
  assert.equal(report.fontResolution.allFromFontsDir, true);
  assert.ok(report.fontResolution.selections.length > 0);
  assert.equal(report.sourceSha256, sourceHash);
  assert.equal(report.assSha256, sha(report.assPath));
  assert.equal(report.output.hash, sha(subtitleOutput));
  for (const mode of ["top", "scroll"]) {
    const output = outputFor(`valid-danmaku-${mode}`);
    const danmaku = await renderDanmaku({ ...common(), output, items: [{ at: 0.1, text: "真实弹幕", mode }] });
    assert.equal(danmaku.checks.timeline_within_video, true);
    assert.equal(danmaku.sourceSha256, sourceHash);
    assert.equal(danmaku.assSha256, sha(danmaku.assPath));
    assert.ok(danmaku.fontResolution.selections.length > 0);
    execFileSync(bins.ffmpeg, ["-v", "error", "-xerror", "-i", output, "-f", "null", "-"], { stdio: "pipe", timeout: 30000 });
  }
  execFileSync(bins.ffmpeg, ["-v", "error", "-xerror", "-i", subtitleOutput, "-f", "null", "-"], { stdio: "pipe", timeout: 30000 });
});
mediaTest("source aliases are rejected before FFmpeg can truncate the original", async () => {
  for (const alias of ["hardlink", "symlink"]) {
    const output = outputFor(`source-${alias}`);
    if (alias === "hardlink") fs.linkSync(input, output); else fs.symlinkSync(input, output);
    await assert.rejects(renderWithSubtitles({ ...common(), output, cues: [cue()] }),
      error => error.code === "overwrite_source_forbidden");
    assert.equal(sha(input), sourceHash);
    fs.unlinkSync(output);
  }
});
mediaTest("rotated source metadata uses display axes for actual subtitle and danmaku rendering", async () => {
  const rotated=outputFor("rotated-source");
  execFileSync(bins.ffmpeg,["-v","error","-nostdin","-n","-i",input,"-c","copy","-metadata:s:v:0","rotate=90",rotated],{stdio:"pipe",timeout:30000});
  const before=sha(rotated),facts=await probeMedia(rotated,{bins});
  assert.deepEqual([facts.width,facts.height],[640,360]);assert.deepEqual([facts.displayWidth,facts.displayHeight],[360,640]);assert.equal(facts.orientation,"portrait");
  for(const mode of ["subtitle","danmaku"]){
    const output=outputFor(`rotated-${mode}`),request={...common(),input:rotated,output};
    const report=mode==="subtitle"?await renderWithSubtitles({...request,cues:[cue()]}):await renderDanmaku({...request,items:[{at:0.1,text:"旋转弹幕",mode:"top"}]});
    assert.equal(report.checks.resolution_preserved,true);const rendered=await probeMedia(output,{bins});
    assert.deepEqual([rendered.width,rendered.height],[360,640]);assert.equal(sha(rotated),before);
    execFileSync(bins.ffmpeg,["-v","error","-xerror","-i",output,"-f","null","-"],{stdio:"pipe",timeout:30000});
  }
});

mediaTest("soft subtitle mux rejects video and subtitle aliases before any source bytes change", async () => {
  const subtitles=path.join(root,"alias-source.srt");fs.writeFileSync(subtitles,"1\n00:00:00,100 --> 00:00:01,100\n原始字幕\n");
  const subtitleHash=sha(subtitles);
  for(const source of [input,subtitles]) for(const alias of ["hardlink","symlink"]){
    const output=outputFor(`softmux-${source===input?"video":"subtitle"}-${alias}`);
    if(alias==="hardlink")fs.linkSync(source,output);else fs.symlinkSync(source,output);
    await assert.rejects(softMux({input,output,subtitles:[{path:subtitles}],bins}),error=>error.code==="overwrite_source_forbidden");
    assert.equal(sha(input),sourceHash);assert.equal(sha(subtitles),subtitleHash);fs.unlinkSync(output);
  }
});
mediaTest("soft subtitle mux preserves rotated coded axes, display axes and encoded video packets", async () => {
  const rotated=outputFor("softmux-rotated-source"),output=outputFor("softmux-rotated-output");
  execFileSync(bins.ffmpeg,["-v","error","-nostdin","-n","-i",input,"-c","copy","-metadata:s:v:0","rotate=90",rotated],{stdio:"pipe",timeout:30000});
  const subtitles=path.join(root,"rotated-softmux.srt");fs.writeFileSync(subtitles,"1\n00:00:00,100 --> 00:00:01,100\n旋转字幕\n");
  const before=sha(rotated),subtitleHash=sha(subtitles),sourceFacts=await probeMedia(rotated,{bins});
  const report=await softMux({input:rotated,output,subtitles:[{path:subtitles}],bins});
  assert.ok(report.checks.every(check=>check.ok!==false));const outputFacts=await probeMedia(output,{bins});
  for(const key of ["width","height","displayWidth","displayHeight","rotationDegrees","videoCodec"])assert.equal(outputFacts[key],sourceFacts[key],key);
  const packetHash=file=>execFileSync(bins.ffmpeg,["-v","error","-i",file,"-map","0:v:0","-c","copy","-f","hash","-hash","sha256","-"],{encoding:"utf8",timeout:30000}).trim();
  assert.equal(packetHash(output),packetHash(rotated));assert.equal(sha(rotated),before);assert.equal(sha(subtitles),subtitleHash);
  execFileSync(bins.ffmpeg,["-v","error","-xerror","-i",output,"-f","null","-"],{stdio:"pipe",timeout:30000});
});

mediaTest("soft subtitle mux rejects failed temporary cleanup instead of declaring success", async () => {
  const subtitles=path.join(root,"cleanup-source.srt"),output=outputFor("cleanup-rejected");
  fs.writeFileSync(subtitles,"1\n00:00:00,100 --> 00:00:05,000\n原始完整字幕\n");
  const originalSubtitle=sha(subtitles),remove=fs.promises.rm;let temporary=null;
  fs.promises.rm=async function(file,options){
    if(path.basename(String(file)).startsWith("workloom-subtitle-clamp-")){
      temporary=String(file);throw new Error("actual injected subtitle clamp cleanup failure");
    }
    return remove.call(this,file,options);
  };
  try{
    await assert.rejects(softMux({input,output,subtitles:[{path:subtitles}],bins}),/actual injected subtitle clamp cleanup failure/);
    assert.ok(temporary,"the real softmux call must attempt to clean its clamp directory");
    assert.equal(sha(input),sourceHash);assert.equal(sha(subtitles),originalSubtitle);
  }finally{
    fs.promises.rm=remove;
    if(temporary)await remove(temporary,{recursive:true,force:true});
    await remove(output,{force:true});
  }
});
