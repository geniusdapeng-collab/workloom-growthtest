import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { applyPostEntity } from "./entity-post.mjs";
import { resolveBinaries } from "./core.mjs";

const bins = resolveBinaries();
const hasEngine = (() => { try { execFileSync(bins.ffmpeg, ["-v", "error", "-version"], { stdio: "ignore" }); return true; } catch { return false; } })();
describe.runIf(hasEngine)("后期实体适配器真实 CLI、失败与回执核验", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "entity-post-")), source = path.join(dir, "source.mp4"), binary = path.join(dir, "fixture-vision");
  const sha = (file: string) => createHash("sha256").update(fs.readFileSync(file)).digest("hex");
  const options = (name: string, extra: Record<string, unknown> = {}) => ({ input: source, output: path.join(dir, `${name}.mp4`), workDir: path.join(dir, name), fps: 8, bins,
    env: { ...process.env, WL_VISION_ENTITY: binary }, ...extra });
  beforeAll(() => {
    execFileSync(bins.ffmpeg, ["-hide_banner", "-v", "error", "-y", "-f", "lavfi", "-i", "color=c=0xc99575:size=160x120:rate=8:duration=1.5",
      "-c:v", "libx264", "-crf", "10", "-pix_fmt", "yuv420p", "-color_primaries", "bt709", "-color_trc", "bt709", "-colorspace", "bt709", source]);
    fs.writeFileSync(binary, `#!${process.execPath}\n` + `
import fs from 'node:fs'; import path from 'node:path';
const index=Number(path.basename(process.argv[2],'.png')),dir=process.argv[3],mask=Buffer.alloc(160*120),present=index<=3||index>=8;
if(present)for(let y=20;y<80;y++)for(let x=index<=3?10:100;x<(index<=3?55:145);x++)mask[y*160+x]=255;
fs.writeFileSync(path.join(dir,'person.pgm'),Buffer.concat([Buffer.from('P5\\n160 120\\n255\\n'),mask]));
fs.writeFileSync(path.join(dir,'faces.json'),JSON.stringify(present?[{x:.1,y:.2,w:.2,h:.2}]:[]));
console.log(JSON.stringify({personRatio:present ? 0.14 : 0,personInstances:present?1:0,personSkinRatio:.8,personRequest:'instance',faceCount:present?1:0,
foodRatio:0,foodLabels:[],personMask:present,foodMask:false,notes:[]}));
`, { mode: 0o755 });
  }, 60_000);
  afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));
  it("逐帧实体执行后保留源字节，回执与实际成片、规格和掩膜模式一致", async () => {
    const before = sha(source), result = await applyPostEntity(options("processed"));
    expect(sha(source)).toBe(before); expect(result).toMatchObject({ schema: "workloom.video-edit/entity-grade/v2", applied: 1, skipped: 0,
      sourceSha256: before, sha256: sha(result.output), outputSha256: sha(result.output) });
    expect(result.adapter).toMatchObject({ stage: "after-final-look-before-bgm", localOnly: true, sourceReadOnlyVerified: true, maskMode: "framewise", fps: 8 });
    expect(result.generations[0]).toMatchObject({ sourceSha256: before, sha256: result.sha256, frames: 12, maskMode: "framewise" });
    expect(result.sourceProbe.video).toMatchObject({ width: 160, height: 120 }); expect(result.outputProbe.video).toMatchObject({ width: 160, height: 120, fps: 8 });
    expect(JSON.parse(fs.readFileSync(result.receiptPath, "utf8"))).toEqual(result);
  }, 60_000);
  it("本地 Vision 不可用时回执写明跳过，复制成片 SHA 相同", async () => {
    const result = await applyPostEntity(options("no-vision", { env: { ...process.env, WL_VISION_ENTITY: path.join(dir, "missing-vision") } }));
    expect(result).toMatchObject({ applied: 0, skipped: 1, sourceSha256: sha(source), sha256: sha(source), generations: [] });
    expect(result.reason).toContain("不存在"); expect(result.rows[0].person.enabled).toBe(false); expect(result.adapter.maskMode).toBe("not-applied");
  }, 60_000);
  it("tsx 入口缺失时输出只读源的复制件，不能伪造实体已执行", async () => {
    const result = await applyPostEntity(options("no-tsx", { env: { ...process.env, WL_TSX_PATH: path.join(dir, "missing-tsx.mjs") } }));
    expect(result).toMatchObject({ applied: 0, skipped: 1, sha256: sha(source), generations: [] });
    expect(result.reason).toContain("tsx"); expect(fs.existsSync(result.receiptPath)).toBe(true);
  }, 60_000);
  it("源/输出别名、已有输出和非法数值在处理前拒绝", async () => {
    const before = sha(source), existing = path.join(dir, "existing.mp4"); fs.linkSync(source, existing);
    for (const extra of [{ output: source }, { output: existing }, { fps: NaN }, { intensity: -0.1 }, { intensity: 1.1 }]) {
      await expect(applyPostEntity(options("invalid", extra))).rejects.toMatchObject({ code: extra.output ? "overwrite_source_forbidden" : "bad_request" });
    }
    expect(sha(source)).toBe(before); expect(fs.existsSync(path.join(dir, "invalid.mp4"))).toBe(false);
  }, 60_000);
  it("无法解码的源片拒绝执行，不留下成片或假回执", async () => {
    const bad = path.join(dir, "bad.mp4"), output = path.join(dir, "bad-output.mp4"); fs.writeFileSync(bad, "not a video");
    await expect(applyPostEntity(options("bad-pass", { input: bad, output }))).rejects.toMatchObject({ code: "ffmpeg_failed" });
    expect(fs.existsSync(output)).toBe(false);
  }, 60_000);
  it("两个并发调用同一输出仅一个发布成功，失败者不能删除成功者的文件", async () => {
    const output = path.join(dir, "concurrent.mp4"), before = sha(source), env = { ...process.env, WL_VISION_ENTITY: path.join(dir, "missing-vision") };
    const results = await Promise.allSettled([applyPostEntity(options("concurrent-a", { output, env })), applyPostEntity(options("concurrent-b", { output, env }))]);
    expect(results.filter(result => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter(result => result.status === "rejected")).toHaveLength(1);
    expect(fs.existsSync(output)).toBe(true); expect(sha(output)).toBe(before); expect(sha(source)).toBe(before);
  }, 60_000);
  it("不同 schema 和虚构应用数量均不能作为后期实体证据", async () => {
    const fakeTsx = path.join(dir, "forged-tsx.mjs");
    fs.writeFileSync(fakeTsx, `import fs from 'node:fs'; import {createHash} from 'node:crypto';
const arg=n=>process.argv[process.argv.indexOf(n)+1],input=arg('--input'),output=arg('--out'),sha=createHash('sha256').update(fs.readFileSync(input)).digest('hex'),forgedCount=process.env.ENTITY_FORGED_COUNT==='1';
fs.copyFileSync(input,output); fs.writeFileSync(arg('--report'),JSON.stringify({schema:forgedCount?'workloom.video-edit/entity-grade/v2':'forged/v1',input,output,sourceSha256:sha,sha256:sha,applied:forgedCount?1:0,skipped:forgedCount?0:1,generations:[],rows:[{person:{enabled:false},food:{enabled:false}}]}));`);
    const before = sha(source);
    for (const mode of ["0", "1"]) {
      const output = path.join(dir, `forged-${mode}.mp4`);
      await expect(applyPostEntity(options(`forged-pass-${mode}`, { output, env: { ...process.env, WL_TSX_PATH: fakeTsx, ENTITY_FORGED_COUNT: mode } }))).rejects.toMatchObject({ code: "entity_receipt_failed" });
      expect(fs.existsSync(output)).toBe(false); expect(sha(source)).toBe(before);
    }
  }, 60_000);
});
