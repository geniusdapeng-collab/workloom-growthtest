/** Apply the entity layer after the final creative look, before BGM/subtitles. All work is local; input bytes are read-only. */
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { ColorError, probeMedia, resolveBinaries, sha256File } from "./core.mjs";

const execute = promisify(execFile);
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..");
function validateNumber(value, label, min, max) {
  if (!Number.isFinite(value) || value < min || value > max) throw new ColorError(`${label} 必须在 ${min}..${max}`, "bad_request");
}
async function writeReceipt(receiptPath, receipt) {
  const temp = `${receiptPath}.tmp`;
  try { await fsp.writeFile(temp, `${JSON.stringify(receipt, null, 2)}\n`, { flag: "wx" }); await fsp.rename(temp, receiptPath); }
  catch (error) { await fsp.rm(temp, { force: true }); throw new ColorError(`实体回执写入失败：${error.message}`, "entity_receipt_failed"); }
}
/**
 * @param {{input:string, output:string, workDir:string, fps:number, intensity?:number, bins?:{ffmpeg:string,ffprobe:string}, env?:object}} options
 * @returns {Promise<object>} Complete CLI receipt plus verified source/output SHA, specs and local adapter provenance.
 */
export async function applyPostEntity({ input, output, workDir, fps, intensity = 1, bins = null, env = process.env } = {}) {
  for (const [label, value] of Object.entries({ input, output, workDir })) {
    if (typeof value !== "string" || !value.trim() || value.includes("\0")) throw new ColorError(`${label} 路径缺失或非法`, "bad_request");
  }
  validateNumber(fps, "实体 fps", 1, 120); validateNumber(intensity, "实体 intensity", 0, 1);
  const inputPath = path.resolve(input), outputPath = path.resolve(output), workspace = path.resolve(workDir);
  if (inputPath === outputPath || fs.existsSync(outputPath)) throw new ColorError("实体层必须输出不存在的新文件，禁止覆盖原片或已有产物", "overwrite_source_forbidden");
  const engines = bins ?? resolveBinaries(env), started = Date.now();
  const sourceSha256 = await sha256File(inputPath), sourceProbe = await probeMedia(inputPath, { bins: engines });
  await fsp.mkdir(workspace, { recursive: true }); await fsp.mkdir(path.dirname(outputPath), { recursive: true });
  const receiptPath = path.join(workspace, `entity-receipt-${randomUUID()}.json`);
  const candidatePath = path.join(workspace, `entity-candidate-${randomUUID()}.mp4`);
  const script = path.join(REPO_ROOT, "scripts/tools/edit-entity.mts");
  const tsx = env.WL_TSX_PATH?.trim() || path.join(REPO_ROOT, "node_modules/tsx/dist/cli.mjs");
  let receipt, outputCreated = false;
  if (!fs.existsSync(tsx) || !fs.existsSync(script)) {
    const reason = `实体工位适配器不可用：${!fs.existsSync(tsx) ? "本地 tsx 入口缺失" : "edit-entity 执行器缺失"}`;
    await fsp.copyFile(inputPath, candidatePath, fs.constants.COPYFILE_EXCL);
    receipt = { schema: "workloom.video-edit/entity-grade/v2", input: inputPath, output: candidatePath, sourceSha256, sha256: sourceSha256,
      binary: null, reason, applied: 0, skipped: 1, summary: { segments: 1, personSegments: 0, foodSegments: 0, bothSegments: 0 },
      rows: [{ segmentId: "single", person: { enabled: false, opacity: 0, reason }, food: { enabled: false, opacity: 0, reason }, notes: [reason], sampledAt: [] }],
      generations: [], generatedAt: new Date().toISOString() };
  } else {
    const timeoutValue = Number(env.WORKLOOM_ENTITY_TIMEOUT_MS ?? 7_200_000);
    const timeout = Number.isFinite(timeoutValue) && timeoutValue > 0 ? timeoutValue : 7_200_000;
    try {
      await execute(process.execPath, [tsx, script, "--input", inputPath, "--out", candidatePath, "--work-dir", workspace,
        "--report", receiptPath, "--fps", String(fps), "--intensity", String(intensity)], {
        cwd: REPO_ROOT, env: { ...env, WL_FFMPEG: engines.ffmpeg, WL_FFPROBE: engines.ffprobe }, timeout, maxBuffer: 16 * 1024 * 1024,
      });
      receipt = JSON.parse(await fsp.readFile(receiptPath, "utf8"));
    } catch (error) {
      await fsp.rm(candidatePath, { force: true });
      const detail = String(error.stderr || error.message || error).split("\n").filter(Boolean).slice(-4).join(" | ");
      throw new ColorError(`实体后期执行失败：${detail}`, "entity_processing_failed");
    }
  }
  try {
    if (receipt.schema !== "workloom.video-edit/entity-grade/v2" || !Number.isInteger(receipt.applied) || receipt.applied < 0 || receipt.applied > 1
      || receipt.skipped !== 1 - receipt.applied || !Array.isArray(receipt.generations) || receipt.generations.length !== receipt.applied
      || !Array.isArray(receipt.rows) || receipt.rows.length !== 1 || typeof receipt.input !== "string" || typeof receipt.output !== "string"
      || !receipt.rows.every(row => typeof row.person?.enabled === "boolean" && typeof row.food?.enabled === "boolean")
      || (receipt.applied === 0 && receipt.rows.some(row => row.person.enabled || row.food.enabled))) {
      throw new ColorError("实体后期回执 schema 或实际应用数量不符", "entity_receipt_failed");
    }
    const actualSourceSha = await sha256File(inputPath), outputSha256 = await sha256File(candidatePath);
    if (actualSourceSha !== sourceSha256 || receipt.sourceSha256 !== sourceSha256 || receipt.sha256 !== outputSha256
      || path.resolve(receipt.input) !== inputPath || path.resolve(receipt.output) !== candidatePath) {
      throw new ColorError("实体后期源/输出 SHA 或回执路径核验失败", "verify_failed");
    }
    for (const generation of receipt.generations) {
      if (generation.sourceSha256 !== sourceSha256 || generation.sha256 !== outputSha256 || generation.maskMode !== "framewise"
        || !Number.isInteger(generation.frames) || generation.frames <= 0 || typeof generation.filterComplex !== "string" || !generation.filterComplex.trim()
        || !Array.isArray(generation.masks) || !generation.masks.length) throw new ColorError("实体后期执行参数或掩膜证据缺失", "entity_receipt_failed");
      for (const mask of generation.masks) {
        const maskPath = typeof mask.path === "string" ? path.resolve(mask.path) : "";
        if (!maskPath.startsWith(workspace + path.sep) || !["person", "food"].includes(mask.kind) || mask.frames !== generation.frames
          || mask.fps !== fps || !Number.isInteger(mask.width) || !Number.isInteger(mask.height) || mask.width < 2 || mask.height < 2
          || (await fsp.stat(maskPath)).size !== mask.width * mask.height * mask.frames || await sha256File(maskPath) !== mask.sha256) {
          throw new ColorError("实体逐帧掩膜文件、规格或 SHA 核验失败", "verify_failed");
        }
      }
    }
    const outputProbe = await probeMedia(candidatePath, { bins: engines });
    if (sourceProbe.video.width !== outputProbe.video.width || sourceProbe.video.height !== outputProbe.video.height
      || Math.abs(sourceProbe.duration - outputProbe.duration) > Math.max(0.12, 1 / fps + 0.025)) {
      throw new ColorError("实体后期时间线或尺寸核验失败", "verify_failed");
    }
    try { await fsp.copyFile(candidatePath, outputPath, fs.constants.COPYFILE_EXCL); outputCreated = true; }
    catch (error) {
      if (error.code === "EEXIST") throw new ColorError("实体输出已被另一个调用创建，拒绝覆盖", "overwrite_source_forbidden");
      throw new ColorError(`实体输出发布失败：${error.message}`, "entity_processing_failed");
    }
    if (await sha256File(outputPath) !== outputSha256 || await sha256File(inputPath) !== sourceSha256) throw new ColorError("实体发布后输出或源片 SHA 核验失败", "verify_failed");
    const result = { ...receipt, output: outputPath, sourceSha256, sha256: outputSha256, outputSha256,
      reason: receipt.reason || (receipt.applied === 0 ? "当前帧无可靠实体掩膜，实体层保持原样" : null),
      sourceProbe, outputProbe, receiptPath,
      adapter: { schema: "workloom/entity-post-adapter/v1", stage: "after-final-look-before-bgm", localOnly: true,
        sourceReadOnlyVerified: true, maskMode: receipt.applied > 0 ? "framewise" : "not-applied", fps, intensity, elapsedMs: Date.now() - started } };
    await writeReceipt(receiptPath, result); return result;
  } catch (error) { if (outputCreated) await fsp.rm(outputPath, { force: true }); throw error; }
  finally { await fsp.rm(candidatePath, { force: true }); }
}
