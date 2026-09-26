#!/usr/bin/env node
/**
 * 素材台账（material ledger）· 2026-09-26
 *
 * 用途：把一支片子的**全部渲染素材**逐镜检查一遍，回答三个问题——
 *   ① 这一镜到底是"模型构建的真实场景"还是"参考照片被变焦/平移"（静态直出）；
 *   ② 若是照片尾段，能否靠**裁掉尾段 + 变速归一**止损（额度受限时的正路，不重渲）；
 *   ③ 这一镜的运动是否够（速度坡道由后期负责，这里只看原始渲染）。
 *
 * 与出片链路口径**同源**：判定函数用 `packages/video-studio/src/material-policy.ts#assessMaterialReuse`，
 * 候选窗口/采样点与 `scripts/tools/full-chain-film.mts#measureMaterialReuse` 保持一致（含 1–3.6× 变焦档）。
 *
 * 用法：
 *   node scripts/tools/material-ledger.mts \
 *     --shotlist work/nanchang/shotlist.json \
 *     --clips    work/vm-nc/clips/VID-NC-WT01 \
 *     --out      outputs/VID-NC-WT01/ledger \
 *     [--trim]            # 需要止损时把裁好的素材写到 <out>/trimmed/（不动原素材）
 *     [--json-only]
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { assessMaterialReuse, MATERIAL_REUSE_POLICY } from "../../packages/video-studio/src/material-policy.ts";

const FFMPEG = process.env.FFMPEG_BIN ?? "/Users/mac/.local/bin/ffmpeg";
const FFPROBE = process.env.FFPROBE_BIN ?? "/Users/mac/.local/bin/ffprobe";

function arg(name: string, fallback = ""): string {
  const index = process.argv.indexOf(name);
  return index >= 0 ? (process.argv[index + 1] ?? fallback) : fallback;
}
const flag = (name: string): boolean => process.argv.includes(name);

const REPO_ROOT = resolve(import.meta.dirname, "..", "..");
const SHOTLIST = resolve(arg("--shotlist", ""));
const CLIPS = resolve(arg("--clips", ""));
const OUT = resolve(arg("--out", join(REPO_ROOT, "outputs", "material-ledger")));
const TRIM = flag("--trim");

if (!existsSync(SHOTLIST)) throw new Error(`shotlist 不存在：${SHOTLIST}`);
if (!existsSync(CLIPS)) throw new Error(`素材目录不存在：${CLIPS}`);
mkdirSync(OUT, { recursive: true });

const W = 180;
const H = 320;
const SCALES = [1, 1.3, 1.7, 2.2, 2.8, 3.6];
const POSITIONS: Array<[string, number, number]> = [
  ["center", 0.5, 0.5], ["left", 0, 0.5], ["right", 1, 0.5], ["top", 0.5, 0], ["bottom", 0.5, 1],
  ["topleft", 0, 0], ["topright", 1, 0], ["bottomleft", 0, 1], ["bottomright", 1, 1]
];
const SAMPLE_RATIOS = [0.08, 0.2, 0.32, 0.44, 0.56, 0.68, 0.78, 0.86, 0.92, 0.97];

interface Probe { duration: number; width: number; height: number; hasAudio: boolean }

function probe(file: string): Probe {
  const res = spawnSync(FFPROBE, ["-v", "error", "-show_entries", "format=duration",
    "-show_entries", "stream=width,height,codec_type", "-of", "json", file], { encoding: "utf8" });
  try {
    const parsed = JSON.parse(res.stdout || "{}") as { format?: { duration?: string }; streams?: Array<Record<string, unknown>> };
    const video = (parsed.streams ?? []).find((s) => s.codec_type === "video") ?? {};
    return {
      duration: Number(parsed.format?.duration ?? 0),
      width: Number(video.width ?? 0),
      height: Number(video.height ?? 0),
      hasAudio: (parsed.streams ?? []).some((s) => s.codec_type === "audio")
    };
  } catch {
    return { duration: 0, width: 0, height: 0, hasAudio: false };
  }
}

function grayFrameRaw(clip: string, atSec: number): Buffer {
  const res = spawnSync(FFMPEG, ["-hide_banner", "-v", "error", "-ss", atSec.toFixed(3), "-i", clip, "-frames:v", "1",
    "-vf", `scale=${W}:${H}:force_original_aspect_ratio=increase,crop=${W}:${H}`, "-f", "rawvideo", "-pix_fmt", "gray", "-"],
    { maxBuffer: 32 * 1024 * 1024 });
  if (res.status !== 0 || !res.stdout) throw new Error(`灰度抽帧失败：${clip}@${atSec.toFixed(2)}s`);
  return res.stdout as Buffer;
}

function psnrGray(a: Buffer, b: Buffer): number {
  const n = Math.min(a.length, b.length);
  if (n === 0) return 0;
  let mse = 0;
  for (let i = 0; i < n; i += 1) { const d = (a[i] ?? 0) - (b[i] ?? 0); mse += d * d; }
  mse /= n;
  return mse <= 1e-9 ? 99 : 10 * Math.log10((255 * 255) / mse);
}

function ssimGray(a: Buffer, b: Buffer): number {
  const c1 = (0.01 * 255) ** 2; const c2 = (0.03 * 255) ** 2; const block = 8;
  let sum = 0; let blocks = 0;
  for (let by = 0; by + block <= H; by += block) {
    for (let bx = 0; bx + block <= W; bx += block) {
      let sa = 0; let sb = 0; let saa = 0; let sbb = 0; let sab = 0;
      for (let y = by; y < by + block; y += 1) {
        for (let x = bx; x < bx + block; x += 1) {
          const i = y * W + x;
          const va = a[i] ?? 0; const vb = b[i] ?? 0;
          sa += va; sb += vb; saa += va * va; sbb += vb * vb; sab += va * vb;
        }
      }
      const n = block * block;
      const ma = sa / n; const mb = sb / n;
      const va2 = saa / n - ma * ma; const vb2 = sbb / n - mb * mb; const cov = sab / n - ma * mb;
      sum += ((2 * ma * mb + c1) * (2 * cov + c2)) / ((ma * ma + mb * mb + c1) * (va2 + vb2 + c2));
      blocks += 1;
    }
  }
  return blocks > 0 ? sum / blocks : 0;
}

function buildCandidates(material: string, shotId: string): Buffer[] {
  const dir = join(OUT, "candidates", shotId);
  mkdirSync(dir, { recursive: true });
  const pixels: Buffer[] = [];
  for (const scale of SCALES) {
    for (const [name, fx, fy] of POSITIONS) {
      const file = join(dir, `cand-s${scale}-${name}.png`);
      try {
        if (!existsSync(file)) {
          /** 画幅准备（9:16 覆盖裁切）→ 变焦裁窗 → 检索分辨率；横图直接裁再拉伸会引入各向异性失真 */
          spawnSync(FFMPEG, ["-y", "-i", material,
            "-vf", `scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920,`
              + `crop=round(1080/${scale}/2)*2:round(1920/${scale}/2)*2:(1080-round(1080/${scale}/2)*2)*${fx}:(1920-round(1920/${scale}/2)*2)*${fy},`
              + `scale=${W}:${H}`,
            "-frames:v", "1", file], { encoding: "utf8" });
        }
        if (existsSync(file)) {
          const raw = spawnSync(FFMPEG, ["-hide_banner", "-v", "error", "-i", file, "-f", "rawvideo", "-pix_fmt", "gray", "-"],
            { maxBuffer: 32 * 1024 * 1024 });
          if (raw.stdout) pixels.push(raw.stdout as Buffer);
        }
      } catch {
        /* 越界窗口跳过 */
      }
    }
  }
  return pixels;
}

/** 头段裁剪 + 变速归一回目标时长（与出片链路 trimMaterialPhotoTail 同源） */
function trimTail(clip: string, keepSec: number, targetSec: number, outFile: string): { factor: number; actual: number; keepSec: number } {
  const cut = `${outFile}.headcut.mp4`;
  spawnSync(FFMPEG, ["-y", "-t", keepSec.toFixed(3), "-i", clip, "-c:v", "libx264", "-preset", "medium", "-crf", "18",
    "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "192k", "-ar", "48000", "-ac", "2", "-movflags", "+faststart", cut]);
  const from = probe(cut).duration;
  const factor = Number((targetSec / from).toFixed(6));
  const tempo = 1 / factor;
  const chain: string[] = [];
  let remaining = tempo;
  while (remaining > 2) { chain.push("atempo=2"); remaining /= 2; }
  while (remaining < 0.5) { chain.push("atempo=0.5"); remaining /= 0.5; }
  chain.push(`atempo=${remaining.toFixed(6)}`);
  spawnSync(FFMPEG, ["-y", "-i", cut, "-vf", `setpts=PTS*${factor.toFixed(6)}`, "-af", chain.join(","),
    "-t", targetSec.toFixed(3), "-c:v", "libx264", "-preset", "medium", "-crf", "18", "-pix_fmt", "yuv420p",
    "-c:a", "aac", "-b:a", "192k", "-ar", "48000", "-ac", "2", "-movflags", "+faststart", outFile]);
  return { factor, actual: probe(outFile).duration, keepSec };
}

interface Shot { shotId: string; duration?: number; photo?: string }
const shotlist = JSON.parse(readFileSync(SHOTLIST, "utf8")) as { shots: Shot[] };
const trimmedDir = join(OUT, "trimmed");
if (TRIM) mkdirSync(trimmedDir, { recursive: true });

const rows: Array<Record<string, unknown>> = [];
for (const shot of shotlist.shots ?? []) {
  const shotId = String(shot.shotId);
  const clip = join(CLIPS, `${shotId}.mp4`);
  const material = String(shot.photo ?? "");
  if (!existsSync(clip)) { rows.push({ shotId, status: "缺片段", clip }); continue; }
  if (!material || !existsSync(material)) { rows.push({ shotId, status: "缺参考素材", material }); continue; }
  const info = probe(clip);
  const target = Number(shot.duration ?? info.duration);
  const candidates = buildCandidates(material, shotId);
  const samples: Array<{ atSec: number; bestPsnrDb: number | null; bestSsim: number | null }> = [];
  for (const ratio of SAMPLE_RATIOS) {
    const atSec = Math.min(info.duration - 0.05, Math.max(0.1, info.duration * ratio));
    if (atSec <= 0) continue;
    let frame: Buffer;
    try { frame = grayFrameRaw(clip, atSec); } catch { samples.push({ atSec, bestPsnrDb: null, bestSsim: null }); continue; }
    let best: number | null = null; let bestSsim: number | null = null;
    for (const pixels of candidates) {
      const value = psnrGray(frame, pixels);
      if (best === null || value > best) best = value;
      if (value >= 22) {
        const structural = ssimGray(frame, pixels);
        if (bestSsim === null || structural > bestSsim) bestSsim = structural;
      }
    }
    samples.push({ atSec, bestPsnrDb: best, bestSsim });
  }
  const verdict = assessMaterialReuse(samples, { durationSec: info.duration });
  const row: Record<string, unknown> = {
    shotId, status: verdict.staticDisplay ? "照片风险" : "OK",
    clip, material: basename(material), durationSec: Number(info.duration.toFixed(3)), targetSec: target,
    resolution: `${info.width}x${info.height}`, hasAudio: info.hasAudio,
    candidates: candidates.length, peakPsnrDb: verdict.worst, peakSsim: verdict.maxSsim,
    hits: verdict.hits, hitKind: verdict.hitKind, firstHitSec: verdict.firstHitSec, detail: verdict.detail
  };
  if (TRIM && verdict.staticDisplay && verdict.firstHitSec !== null && verdict.firstHitSec - 0.15 >= Math.max(0.9, info.duration * 0.55)) {
    const keep = Number((verdict.firstHitSec - 0.15).toFixed(3));
    const outFile = join(trimmedDir, `${shotId}.mp4`);
    try {
      row.trim = trimTail(clip, keep, target, outFile);
      const after = probe(outFile);
      const afterSamples: Array<{ atSec: number; bestPsnrDb: number | null; bestSsim: number | null }> = [];
      for (const ratio of SAMPLE_RATIOS) {
        const atSec = Math.min(after.duration - 0.05, Math.max(0.1, after.duration * ratio));
        if (atSec <= 0) continue;
        let frame: Buffer;
        try { frame = grayFrameRaw(outFile, atSec); } catch { afterSamples.push({ atSec, bestPsnrDb: null, bestSsim: null }); continue; }
        let best: number | null = null; let bestSsim: number | null = null;
        for (const pixels of candidates) {
          const value = psnrGray(frame, pixels);
          if (best === null || value > best) best = value;
          if (value >= 22) {
            const structural = ssimGray(frame, pixels);
            if (bestSsim === null || structural > bestSsim) bestSsim = structural;
          }
        }
        afterSamples.push({ atSec, bestPsnrDb: best, bestSsim });
      }
      const afterVerdict = assessMaterialReuse(afterSamples, { durationSec: after.duration });
      row.trimmedFile = outFile;
      row.trimVerdict = { status: afterVerdict.staticDisplay ? "仍判照片" : "已通过", peakPsnrDb: afterVerdict.worst, peakSsim: afterVerdict.maxSsim, detail: afterVerdict.detail };
    } catch (error) {
      row.trimError = error instanceof Error ? error.message : String(error);
    }
  }
  rows.push(row);
  console.log(`${shotId}: ${row.status} peakPSNR=${verdict.worst === null ? "n/a" : verdict.worst.toFixed(1)}dB peakSSIM=${verdict.maxSsim === null ? "n/a" : verdict.maxSsim.toFixed(3)}`
    + `${row.trimVerdict ? ` → 裁尾段后 ${(row.trimVerdict as Record<string, unknown>).status}` : ""}`);
}

const summary = {
  schemaVersion: "workloom.material-ledger/v1",
  generatedAt: new Date().toISOString(),
  shotlist: SHOTLIST, clips: CLIPS,
  policy: MATERIAL_REUSE_POLICY,
  shots: rows,
  counts: {
    total: rows.length,
    ok: rows.filter((r) => r.status === "OK").length,
    photoRisk: rows.filter((r) => r.status === "照片风险").length,
    missing: rows.filter((r) => String(r.status).startsWith("缺")).length,
    trimmedOk: rows.filter((r) => (r.trimVerdict as Record<string, unknown> | undefined)?.status === "已通过").length
  }
};
writeFileSync(join(OUT, "materials-ledger.json"), `${JSON.stringify(summary, null, 2)}\n`, "utf8");

if (!flag("--json-only")) {
  const lines = [
    `# 素材台账（${basename(CLIPS)}）`,
    "",
    `- 生成时间：${summary.generatedAt}`,
    `- 判定口径：PSNR ≥ ${MATERIAL_REUSE_POLICY.identicalPsnrDb}dB（像素级）或 PSNR ≥ ${MATERIAL_REUSE_POLICY.photoLikePsnrDb}dB 且 SSIM ≥ ${MATERIAL_REUSE_POLICY.photoLikeSsim}（视觉级），中后段命中 ≥ ${MATERIAL_REUSE_POLICY.minHits} 帧即判静态直出`,
    `- 统计：共 ${summary.counts.total} 镜 · 通过 ${summary.counts.ok} · 照片风险 ${summary.counts.photoRisk} · 缺失 ${summary.counts.missing}` + (TRIM ? ` · 裁尾段后通过 ${summary.counts.trimmedOk}` : ""),
    "",
    "| 镜头 | 时长 | 判定 | 峰值 PSNR | 峰值 SSIM | 首次命中 | 裁尾段 | 说明 |",
    "|---|---|---|---|---|---|---|---|"
  ];
  for (const row of rows) {
    const trim = row.trimVerdict as Record<string, unknown> | undefined;
    lines.push(`| ${row.shotId} | ${row.durationSec ?? "-"}s | ${row.status} | ${typeof row.peakPsnrDb === "number" ? `${(row.peakPsnrDb as number).toFixed(1)}dB` : "-"} | ${typeof row.peakSsim === "number" ? (row.peakSsim as number).toFixed(3) : "-"} | ${typeof row.firstHitSec === "number" ? `${(row.firstHitSec as number).toFixed(2)}s` : "-"} | ${trim ? `${trim.status}${typeof trim.peakPsnrDb === "number" ? `（${(trim.peakPsnrDb as number).toFixed(1)}dB）` : ""}` : "-"} | ${String(row.detail ?? row.material ?? "").slice(0, 90)} |`);
  }
  writeFileSync(join(OUT, "materials-ledger.md"), `${lines.join("\n")}\n`, "utf8");
}

console.log(`\n台账输出：${join(OUT, "materials-ledger.json")}${flag("--json-only") ? "" : ` / ${join(OUT, "materials-ledger.md")}`}`);
