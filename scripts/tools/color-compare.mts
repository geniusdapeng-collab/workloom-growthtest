#!/usr/bin/env tsx
/**
 * color-compare.mts —— 调色客观对比（2026-09-22）
 *
 * 用调色工位自己的画质度量回答"这次调色到底值不值"：
 *   · 画质指标（对比/影调跨度/饱和/过饱和/色彩浓度/细节能量/裁切）取自 core.mjs 的 qualityOfFile
 *   · 打分取 scoreQuality（原片 = 100 基准；朝健康区间移动才加分，清晰度只能不掉）
 *   · 可见性取 frameDifference（≥4/255 肉眼可辨、2–4 轻微、<2 等于没调）
 *
 * 用法：
 *   pnpm exec tsx scripts/tools/color-compare.mts --baseline <母版.mp4> --candidate <版本.mp4> [--candidate b.mp4 ...] [--json]
 */
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const REPO_ROOT = resolve(import.meta.dirname ?? process.cwd(), "../..");

function args(name: string): string[] {
  const out: string[] = [];
  process.argv.forEach((token, i) => {
    if (token === name && process.argv[i + 1]) out.push(process.argv[i + 1]!);
  });
  return out;
}
const flag = (name: string) => process.argv.includes(name);

const baseline = args("--baseline")[0];
if (!baseline) throw new Error("需要 --baseline <母版.mp4>");
const candidates = args("--candidate");
if (candidates.length === 0) throw new Error("需要至少一个 --candidate <文件.mp4>");
for (const file of [baseline, ...candidates]) {
  if (!existsSync(resolve(REPO_ROOT, file))) throw new Error(`文件不存在：${file}`);
}

const coreUrl = pathToFileURL(resolve(REPO_ROOT, "bundles/ai-video/connectors/color-bridge/core.mjs")).href;
const core = await import(coreUrl) as {
  qualityOfFile(input: Record<string, unknown>): Promise<{ avg: Record<string, number> }>;
  scoreQuality(candidate: Record<string, number>, source: Record<string, number>): { score: number; reasons: Record<string, number> };
  frameDifference(input: Record<string, unknown>): Promise<Record<string, number> & { verdict?: string }>;
  resolveBinaries(): unknown;
};

const bins = core.resolveBinaries();
const at = [3.04, 10.62, 18.21, 25.8];
const base = (await core.qualityOfFile({ input: resolve(REPO_ROOT, baseline), at, width: 480, bins })).avg;

const rows: Array<Record<string, unknown>> = [];
for (const candidate of candidates) {
  const file = resolve(REPO_ROOT, candidate);
  const quality = (await core.qualityOfFile({ input: file, at, width: 480, bins })).avg;
  const score = core.scoreQuality(quality, base);
  const diff = await core.frameDifference({ before: resolve(REPO_ROOT, baseline), after: file, at, bins }).catch(() => null);
  rows.push({ file: candidate, quality, score: score.score, reasons: score.reasons, visibility: diff });
}

const report = {
  baseline: { file: baseline, quality: base },
  candidates: rows,
  generatedAt: new Date().toISOString()
};

if (flag("--json")) {
  console.log(JSON.stringify(report, null, 2));
} else {
  console.log(`基准（母版）：${baseline}`);
  console.log(
    `  画质：yavg=${base.yavg?.toFixed(1)} 对比=${base.rmsContrast?.toFixed(1)} 影调=${base.tonalRange?.toFixed(1)} `
    + `饱和=${base.satMean?.toFixed(2)} 过饱和=${(base.oversatPct ?? 0) * 100}% 色彩浓度=${base.colorfulness?.toFixed(1)} `
    + `细节=${base.sharpness?.toFixed(2)} 暗部裁切=${base.shadowClipPct}% 高光裁切=${base.highlightClipPct}%`
  );
  for (const row of rows) {
    const reasons = row.reasons as Record<string, number>;
    const quality = row.quality as Record<string, number>;
    const visibility = row.visibility as (Record<string, unknown> | null);
    console.log(`\n候选：${String(row.file)}`);
    console.log(
      `  画质分：${Number(row.score).toFixed(2)}（原片 100）｜对比度×${reasons.contrastRatio} 饱和×${reasons.satRatio} `
      + `细节×${reasons.detailRatio} 裁切${reasons.clipDeltaPct >= 0 ? "+" : ""}${reasons.clipDeltaPct}% 亮度${reasons.lumaDrift >= 0 ? "+" : ""}${reasons.lumaDrift}`
    );
    console.log(
      `  画质：yavg=${quality.yavg?.toFixed(1)} 饱和=${quality.satMean?.toFixed(2)} 色彩浓度=${quality.colorfulness?.toFixed(1)} 细节=${quality.sharpness?.toFixed(2)}`
    );
    if (visibility) {
      console.log(`  可见性：平均差 ${visibility.meanAbsDiff}/255（${String(visibility.verdict)}）`);
    }
  }
  console.log("\n判读口径：画质分 > 100 才算「朝健康区间改善」；母版=100；可见性 <2/255 等价于「没调」。");
}
