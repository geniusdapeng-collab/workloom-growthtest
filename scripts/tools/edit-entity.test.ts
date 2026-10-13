import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { resolveBinaries } from "../../bundles/ai-video/connectors/color-bridge/core.mjs";

const bins = resolveBinaries();
const hasFfmpeg = (() => { try { execFileSync(bins.ffmpeg, ["-v", "error", "-version"], { stdio: "ignore" }); return true; } catch { return false; } })();
describe.runIf(hasFfmpeg)("实体执行器真实 FFmpeg 与原片只读", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "entity-motion-")), source = path.join(dir, "source.mp4"), binary = path.join(dir, "fixture-vision");
  const sha = (file: string) => createHash("sha256").update(fs.readFileSync(file)).digest("hex");
  let entity: typeof import("./edit-entity.mjs");
  const previous = { binary: process.env.WL_VISION_ENTITY, ffmpeg: process.env.WL_FFMPEG, ffprobe: process.env.WL_FFPROBE };
  beforeAll(async () => {
    execFileSync(bins.ffmpeg, ["-hide_banner", "-v", "error", "-y", "-f", "lavfi", "-i", "color=c=0xc99575:size=160x120:rate=8:duration=1.5",
      "-c:v", "libx264", "-crf", "10", "-pix_fmt", "yuv420p", "-color_primaries", "bt709", "-color_trc", "bt709", "-colorspace", "bt709", source]);
    fs.writeFileSync(binary, `#!${process.execPath}\n` + `
import fs from 'node:fs'; import path from 'node:path';
const frame=process.argv[2],dir=process.argv[3],index=Number(path.basename(frame,'.png')),w=160,h=120;
const mask=Buffer.alloc(w*h);const present=index<=3||index>=8;
if(present)for(let y=20;y<80;y++)for(let x=index<=3?10:100;x<(index<=3?55:145);x++)mask[y*w+x]=255;
fs.writeFileSync(path.join(dir,'person.pgm'),Buffer.concat([Buffer.from('P5\\n160 120\\n255\\n'),mask]));
fs.writeFileSync(path.join(dir,'faces.json'),JSON.stringify(present?[{x:.1,y:.2,w:.2,h:.2}]:[]));
console.log(JSON.stringify({personRatio:present ? 0.14 : 0,personInstances:present?1:0,personSkinRatio:.8,personRequest:'instance',faceCount:present?1:0,
foodRatio:0,foodLabels:[],personMask:present,foodMask:false,notes:[]}));
`, { mode: 0o755 });
    process.env.WL_VISION_ENTITY = binary; process.env.WL_FFMPEG = bins.ffmpeg; process.env.WL_FFPROBE = bins.ffprobe;
    entity = await import("./edit-entity.mjs");
  });
  afterAll(() => {
    for (const [name, value] of [["WL_VISION_ENTITY", previous.binary], ["WL_FFMPEG", previous.ffmpeg], ["WL_FFPROBE", previous.ffprobe]]) {
      if (value === undefined) delete process.env[name!]; else process.env[name!] = value;
    }
    fs.rmSync(dir, { recursive: true, force: true });
  });
  it("逐帧当前支持随目标移动；消失期间清零，掩膜与片段帧数对齐", async () => {
    const working = path.join(dir, "working.mp4"), workDir = path.join(dir, "pass"); fs.copyFileSync(source, working);
    const before = sha(working), result = await entity.applyEntityGrade({ clips: [{ shotId: "moving", path: working }], workDir, fps: 8 });
    expect(result.applied).toBe(1); expect(result.generations[0]).toMatchObject({ sourceSha256: before, frames: 12, maskMode: "framewise" });
    expect(result.generations[0]!.sha256).toBe(sha(working)); expect(result.generations[0]!.filterComplex).not.toContain("-loop");
    const mask = fs.readFileSync(path.join(workDir, "moving/person.gray")), pixels = 160 * 120;
    expect(mask.length).toBe(pixels * 12);
    expect(mask[40 * 160 + 20]).toBeGreaterThan(0);
    expect(mask.subarray(pixels * 3, pixels * 7).every((value) => value === 0)).toBe(true);
    expect(mask[pixels * 11 + 40 * 160 + 20]).toBe(0);
    expect(mask[pixels * 11 + 40 * 160 + 120]).toBeGreaterThan(0);
    expect(result.rows[0]!.sampledAt).toHaveLength(12); expect(result.summary.personSegments).toBe(1);
    const pixel = (file: string) => {
      const decoded = execFileSync(bins.ffmpeg, ["-hide_banner", "-v", "error", "-ss", "0.25", "-i", file, "-frames:v", "1", "-f", "rawvideo", "-pix_fmt", "rgb24", "-"]);
      return decoded.subarray((40 * 160 + 120) * 3, (40 * 160 + 120) * 3 + 3);
    };
    const untouchedSource = pixel(source), untouchedOutput = pixel(working);
    expect(Array.from(untouchedSource).reduce((total, value, index) => total + Math.abs(value - untouchedOutput[index]!), 0) / 3).toBeLessThan(3);
    expect(result.generations[0]!.colorManagement.destination).toMatchObject({ matrix: "bt709", range: "limited" });
    expect(result.generations[0]!.masks[0]).toMatchObject({ kind: "person", frames: 12, width: 160, height: 120, fps: 8, sha256: sha(path.join(workDir, "moving/person.gray")) });
  });
  it("CLI 输出新文件，源文件存在且 SHA 不变；回执记录真实输出及遮罩模式", () => {
    const script = fileURLToPath(new URL("./edit-entity.mts", import.meta.url)), output = path.join(dir, "cli-output.mp4"), report = `${output}.json`, before = sha(source);
    const cli = fileURLToPath(new URL("../../node_modules/.bin/tsx", import.meta.url));
    const result = spawnSync(cli, [script, "--input", source, "--out", output, "--report", report, "--fps", "8"], { encoding: "utf8", env: process.env });
    expect(result.status, result.stderr).toBe(0); expect(sha(source)).toBe(before); expect(fs.existsSync(output)).toBe(true);
    const receipt = JSON.parse(fs.readFileSync(report, "utf8"));
    expect(receipt).toMatchObject({ sourceSha256: before, sha256: sha(output), input: source, output, applied: 1 });
    expect(receipt.generations[0].maskMode).toBe("framewise");
  });
  it("CLI 拒绝同路径、已有输出及回执源片别名，拒绝后源 SHA 保持", () => {
    const script = fileURLToPath(new URL("./edit-entity.mts", import.meta.url)), cli = fileURLToPath(new URL("../../node_modules/.bin/tsx", import.meta.url)), before = sha(source);
    const alias = path.join(dir, "source-alias.json"); fs.symlinkSync(source, alias);
    for (const args of [["--out", source], ["--out", path.join(dir, "guard-output.mp4"), "--report", alias]]) {
      const result = spawnSync(cli, [script, "--input", source, ...args], { encoding: "utf8", env: process.env });
      expect(result.status).toBe(1); expect(sha(source)).toBe(before);
    }
  });
  it("CLI 回执的硬链别名同样不能写入原片字节", () => {
    const script = fileURLToPath(new URL("./edit-entity.mts", import.meta.url)), cli = fileURLToPath(new URL("../../node_modules/.bin/tsx", import.meta.url));
    const original = fs.readFileSync(source), before = sha(source), alias = path.join(dir, "source-hardlink.json"); fs.linkSync(source, alias);
    try {
      const result = spawnSync(cli, [script, "--input", source, "--out", path.join(dir, "hardlink-pass.mp4"), "--report", alias], { encoding: "utf8", env: process.env });
      expect(result.status).toBe(1); expect(sha(source)).toBe(before);
    } finally { fs.writeFileSync(source, original); }
  });
  it("掩膜缺失、规格错配与非法 fps/shotId 有明确失败路径", async () => {
    const pgm = path.join(dir, "invalid.pgm"); fs.writeFileSync(pgm, "P5\n1 1\n255\nx");
    expect(() => entity.readEntityPgm(pgm, 160, 120)).toThrow(/规格不匹配/);
    await expect(entity.applyEntityGrade({ clips: [], workDir: dir, fps: 8, intensity: NaN })).rejects.toThrow(/intensity/);
    await expect(entity.applyEntityGrade({ clips: [], workDir: dir, fps: NaN })).rejects.toThrow(/fps/);
    await expect(entity.applyEntityGrade({ clips: [{ shotId: "../escape", path: source }], workDir: dir, fps: 8 })).rejects.toThrow(/shotId/);
  });
  it("工位不可用时每段明确跳过，不能把计划数量当实际应用量", async () => {
    process.env.WL_VISION_ENTITY = path.join(dir, "missing-vision");
    const result = await entity.applyEntityGrade({ clips: [{ shotId: "disabled", path: source }], workDir: dir, fps: 8 });
    expect(result.applied).toBe(0); expect(result.skipped).toBe(1); expect(result.rows).toHaveLength(1);
    expect(result.summary).toEqual({ segments: 1, personSegments: 0, foodSegments: 0, bothSegments: 0 });
    expect(result.rows[0]!.notes[0]).toContain("不存在"); process.env.WL_VISION_ENTITY = binary;
  });
});
