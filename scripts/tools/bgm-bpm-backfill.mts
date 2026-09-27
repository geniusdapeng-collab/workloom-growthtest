#!/usr/bin/env tsx
/**
 * 曲库实测 BPM 回填（2026-09-26 真机事故沉淀 · 产品所有者点名"完成曲库实测 BPM 回填"）
 *
 * 为什么需要：选曲/卡点一直按曲库**标签 BPM**，真机实测卡点平均误差 123ms；
 * 抽测发现标签与实测最大差 40%+（city-beneath-the-waves 标签 120 / 实测 163.04）。
 * 标签是人工/批量打标，与音频真实节拍经常差一截（半速错标、变速混音、静音头尾都会偏）。
 *
 * 本脚本：逐首解码前 N 秒（默认 30s，16k 单声道）→ `measureBpm()` 实测 →
 * 按 `library-bpm.ts` 的纪律回填（`bpm` 写实测、`bpmLabel` 只写一次、来源/强度/时间戳可追溯）。
 *
 * 用法：
 *   pnpm exec tsx scripts/tools/bgm-bpm-backfill.mts [--library ~/.workloom-bgm/library] \
 *     [--limit 2000] [--concurrency 6] [--sample-seconds 30] [--min-strength 0] [--force] [--write]
 *
 * 纪律：
 *   · 默认 **dry-run**（只出报告与统计，不改库文件）；要落盘必须显式 `--write`；
 *   · 落盘前自动备份 `tracks.json.bak-<时间戳>`，写入用"临时文件 + rename"原子替换；
 *   · 已有实测值默认不重算（幂等）；`--force` 才重算，但**标签不会被实测值覆盖**（bpmLabel 只写一次）。
 */
import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { applyBpmMeasurement, summarizeBpmBackfill, BPM_BACKFILL_VERSION } from "../../packages/video-studio/src/library-bpm.js";
import { measureBpm } from "../../packages/video-studio/src/beat-verify.js";

const FFMPEG = process.env.WL_FFMPEG ?? "ffmpeg";
const SAMPLE_RATE = 16000;

function arg(name: string, fallback = ""): string {
  const index = process.argv.indexOf(name);
  return index >= 0 ? (process.argv[index + 1] ?? fallback) : fallback;
}
const flag = (name: string): boolean => process.argv.includes(name);

const libraryDir = resolve(arg("--library", join(homedir(), ".workloom-bgm", "library")));
const indexPath = join(libraryDir, "tracks.json");
const limit = Number(arg("--limit", "2000"));
const concurrency = Math.max(1, Number(arg("--concurrency", "6")));
const sampleSeconds = Math.max(10, Number(arg("--sample-seconds", "30")));
const minStrength = Number(arg("--min-strength", "0"));
const force = flag("--force");
const write = flag("--write");
const reportPath = resolve(arg("--report", join(libraryDir, "bpm-backfill-report.json")));

if (!existsSync(indexPath)) {
  throw new Error(`曲库索引不存在：${indexPath}（用 --library 指定曲库根）`);
}

interface TrackRecord {
  id?: string;
  file?: string;
  path?: string;
  bpm?: number;
  bpmLabel?: number;
  bpmMeasured?: number;
  [key: string]: unknown;
}

const doc = JSON.parse(readFileSync(indexPath, "utf8")) as { schemaVersion?: string; tracks?: TrackRecord[] };
const tracks = Array.isArray(doc.tracks) ? doc.tracks : [];
console.log(`曲库：${indexPath}`);
console.log(`曲目：${tracks.length} 首｜并发 ${concurrency}｜采样 ${sampleSeconds}s｜${write ? "**写回**" : "dry-run"}${force ? "（force 重算）" : ""}`);

function trackFilePath(track: TrackRecord): string | null {
  const relative = track.file ?? track.path;
  if (!relative) return null;
  const absolute = resolve(libraryDir, String(relative));
  return existsSync(absolute) ? absolute : null;
}

/** 解码前 N 秒为 f32 单声道（不做局部 seek：aac 帧对齐会自带 0–21ms 量化误差）。 */
function readPcm(file: string, seconds: number): Float32Array {
  const buf = execFileSync(FFMPEG, [
    "-v", "error", "-t", String(seconds), "-i", file,
    "-vn", "-ac", "1", "-ar", String(SAMPLE_RATE), "-f", "f32le", "-",
  ], { maxBuffer: 256 * 1024 * 1024 });
  return new Float32Array(buf.buffer, buf.byteOffset, Math.floor(buf.byteLength / 4)).slice();
}

interface Row {
  id: string;
  label: number | null;
  measured: number | null;
  strength: number | null;
  ok: boolean;
  skippedReason?: string;
  error?: string;
}

const rows: Row[] = new Array(tracks.length);
const updated: TrackRecord[] = tracks.map((track) => ({ ...track }));
let cursor = 0;
let done = 0;
const started = Date.now();

async function worker(): Promise<void> {
  for (;;) {
    const index = cursor;
    cursor += 1;
    if (index >= tracks.length) return;
    const track = tracks[index]!;
    if (index >= limit) {
      rows[index] = { id: String(track.id ?? index), label: null, measured: null, strength: null, ok: false, skippedReason: "over-limit" };
      continue;
    }
    const file = trackFilePath(track);
    if (!file) {
      rows[index] = { id: String(track.id ?? index), label: null, measured: null, strength: null, ok: false, skippedReason: "file-missing" };
      continue;
    }
    try {
      const measured = measureBpm(readPcm(file, sampleSeconds), SAMPLE_RATE);
      const applied = applyBpmMeasurement(updated[index]!, measured, {
        at: new Date().toISOString(), minStrength, force,
      });
      updated[index] = applied.track;
      rows[index] = {
        id: String(track.id ?? index),
        label: typeof applied.track.bpmLabel === "number" ? applied.track.bpmLabel : (Number.isFinite(track.bpm) ? Number(track.bpm) : null),
        measured: measured.bpm > 0 ? measured.bpm : null,
        strength: measured.strength,
        ok: applied.changed,
        ...(applied.skippedReason ? { skippedReason: applied.skippedReason } : {}),
      };
    } catch (error) {
      rows[index] = {
        id: String(track.id ?? index), label: null, measured: null, strength: null, ok: false,
        error: error instanceof Error ? error.message.slice(0, 160) : String(error),
      };
    }
    done += 1;
    if (done % 100 === 0) {
      const rate = done / ((Date.now() - started) / 1000);
      console.log(`  … ${done}/${Math.min(tracks.length, limit)}（${rate.toFixed(1)} 首/秒）`);
    }
  }
}

await Promise.all(Array.from({ length: concurrency }, () => worker()));

const changed = rows.filter((row) => row.ok).length;
const skipped = rows.filter((row) => !row.ok && row.skippedReason).reduce<Record<string, number>>((acc, row) => {
  const key = row.skippedReason!;
  acc[key] = (acc[key] ?? 0) + 1;
  return acc;
}, {});
const failed = rows.filter((row) => row.error).length;
const summary = summarizeBpmBackfill(updated);

console.log("\n== 回填结果 ==");
console.log(`  写入：${changed} 首｜跳过：${JSON.stringify(skipped)}｜失败：${failed}`);
console.log(`  标签 vs 实测：平均 |Δ| ${summary.meanAbsDeltaBpm} BPM｜中位 ${summary.medianAbsDeltaBpm}｜最大 ${summary.maxAbsDeltaBpm}｜超 10% 占比 ${summary.shareOver10Percent}`);
console.log("  偏差最大的 10 首：");
for (const row of summary.worst) {
  console.log(`    ${row.id.padEnd(38)} 标签 ${String(row.label).padStart(6)} → 实测 ${String(row.measured).padStart(7)}（${row.deltaPercent > 0 ? "+" : ""}${row.deltaPercent}%）`);
}

writeFileSync(reportPath, `${JSON.stringify({
  version: BPM_BACKFILL_VERSION,
  generatedAt: new Date().toISOString(),
  library: indexPath,
  sampleSeconds, minStrength, force, write,
  counts: { total: tracks.length, written: changed, skipped, failed },
  summary,
  rows,
}, null, 2)}\n`, "utf8");
console.log(`\n报告：${reportPath}`);

if (write) {
  const stamp = new Date().toISOString().replace(/[-:T]/g, "").slice(0, 14);
  const backup = `${indexPath}.bak-${stamp}`;
  copyFileSync(indexPath, backup);
  const temporary = `${indexPath}.tmp-${process.pid}`;
  writeFileSync(temporary, `${JSON.stringify({ ...doc, tracks: updated }, null, 2)}\n`, "utf8");
  renameSync(temporary, indexPath);
  console.log(`已写回曲库：${indexPath}（${(statSync(indexPath).size / 1048576).toFixed(1)}MB）｜备份：${backup}`);
} else {
  console.log("dry-run：未改动曲库文件（要落盘请加 --write）");
}
