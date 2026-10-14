/** Local adapter; source is read-only and returned sound receipt binds the actual output. */
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { probeMedia, sha256File } from "../subtitle-bridge/measure.mjs";
const execute = promisify(execFile);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..");
export async function applyPostRhythmSound({ input, plan, workDir, bins, env = process.env }) {
  const sourceHash = await sha256File(input);
  const dir = path.join(workDir, `post-sound-${randomUUID()}`);
  await fs.mkdir(dir, { recursive: true });
  const requestFile = path.join(dir, "request.json"), resultFile = path.join(dir, "result.json");
  await fs.writeFile(requestFile, JSON.stringify({ plan, file: path.resolve(input), outputDir: dir, ffmpeg: bins.ffmpeg, ffprobe: bins.ffprobe, resultFile }), { flag: "wx" });
  try {
    await execute(process.execPath, [path.join(root, "node_modules/tsx/dist/cli.mjs"), path.join(root, "scripts/tools/rhythm-post.mts"), requestFile], { cwd: root, env, timeout: 1_800_000, maxBuffer: 8 * 1024 * 1024 });
    const result = JSON.parse(await fs.readFile(resultFile, "utf8"));
    const relative = path.relative(dir, result.file ?? "");
    if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) throw new Error("RHYTHM_POST_OUTPUT_OUTSIDE_WORK");
    const receipt = JSON.parse(await fs.readFile(result.reportFile, "utf8"));
    const outputHash = await sha256File(result.file);
    if (receipt.schemaVersion !== "workloom.rhythm-sound/v1" || receipt.source.sha256 !== sourceHash || receipt.output.sha256 !== outputHash
      || receipt.videoPacketsUnchanged !== true || receipt.programmeSpeed !== 1 || await sha256File(input) !== sourceHash) throw new Error("RHYTHM_POST_SOURCE_OR_RECEIPT_CHANGED");
    const probe = await probeMedia(result.file, { bins });
    if (!probe.hasAudio || !(probe.videoDuration > 0)) throw new Error("RHYTHM_POST_MEDIA_INVALID");
    return { ...result, sourceSha256: sourceHash, sha256: outputHash, receipt, probe };
  } catch (error) { const detail = String(error.stderr ?? error.message).split("\n").filter(Boolean).slice(-4).join(" | "); throw Object.assign(new Error(`节奏音效加工失败：${detail}`), { code: "rhythm_processing_failed", retryable: false }); }
}
