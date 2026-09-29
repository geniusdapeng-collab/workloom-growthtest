#!/usr/bin/env node
/**
 * 从打标索引里精选随仓兜底曲库（`bundles/ai-video/library/bgm-library-curated/`）。
 *
 * 用法：
 *   node scripts/bgm-curate-library.mjs \
 *     --index ~/.workloom-bgm/library \
 *     --out bundles/ai-video/library/bgm-library-curated \
 *     --count 50 --seconds 60 --bitrate 112k \
 *     --library-name "WorkLoom 兜底曲库（50 首·可商用纯音乐）" \
 *     --license-note "..." --license-source "owner-provided-pack:..."
 *
 * 它做四件事：
 * 1. 读打标索引（tracks.json + tag-evidence.json），按"质量分 + 风格多样性"挑 N 首；
 * 2. 用结构/包络证据给每首定位"最合适那一段"，线性增益到 -14 LUFS 后转码 AAC（进仓前就统一母版口径）；
 * 3. 写曲库三件套：tracks.json（运行时契约）、curation-report.json（选谁/为何/哪一段）、README.md（含许可与来源，给人看）；
 * 4. 打印一行摘要（首数与体积），便于门禁/流水线引用。
 */
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";

import {
  STYLE_FAMILIES, encodeExcerpt, planExcerpt, scoreForCurated, selectCuratedTracks,
} from "../bundles/ai-video/connectors/bgm-bridge/tag.mjs";

function arg(name, fallback = null) {
  const index = process.argv.indexOf(`--${name}`);
  if (index < 0) return fallback;
  const value = process.argv[index + 1];
  return value === undefined || value.startsWith("--") ? true : value;
}

const indexPath = arg("index", path.join(process.env.HOME ?? ".", ".workloom-bgm/library"));
const outDir = arg("out", "bundles/ai-video/library/bgm-library-curated");
const count = Number(arg("count", 50));
const targetSec = Number(arg("seconds", 60));
const bitrate = String(arg("bitrate", "112k"));
const libraryName = String(arg("library-name", `WorkLoom 兜底曲库（${count} 首）`));
const licenseNote = String(arg("license-note", "许可：可商用（调用方声明）"));
const licenseSource = arg("license-source", null);
const provider = String(arg("provider", "owner-provided-pack"));

const indexFile = path.join(indexPath, "tracks.json");
const evidenceFile = path.join(indexPath, "tag-evidence.json");
if (!existsSync(indexFile)) throw new Error(`打标索引不存在：${indexFile}（先跑 bgmwrite.tag / bgm-cli tag）`);
if (!existsSync(evidenceFile)) throw new Error(`打标证据不存在：${evidenceFile}`);
const index = JSON.parse(readFileSync(indexFile, "utf8"));
const evidenceDoc = JSON.parse(readFileSync(evidenceFile, "utf8"));
const evidenceById = new Map((evidenceDoc.evidence ?? []).map((entry) => [entry.id, entry]));
const tracks = Array.isArray(index.tracks) ? index.tracks : [];
if (!tracks.length) throw new Error("打标索引里没有曲目（tracks 为空）");

const selection = selectCuratedTracks({ tracks, count });
mkdirSync(outDir, { recursive: true });

const curated = [];
const report = [];
for (const pick of selection.picks) {
  const track = selection.tracksById.get(pick.id).track;
  const evidence = evidenceById.get(pick.id);
  const sourcePath = path.isAbsolute(track.file) ? track.file : path.resolve(indexPath, track.file);
  if (!existsSync(sourcePath)) throw new Error(`源文件不存在：${sourcePath}（索引与素材不同步，先重跑打标）`);
  const excerpt = planExcerpt({
    track,
    targetSec,
    outlineDb: evidence?.envelope?.outlineDb ?? null,
  });
  const fileName = `${track.id}.m4a`;
  const encoded = await encodeExcerpt({
    input: sourcePath,
    output: path.join(outDir, fileName),
    startSec: excerpt.startSec,
    durationSec: excerpt.durationSec,
    bitrate,
  });
  curated.push({
    ...track,
    id: track.id,
    file: fileName,
    durationSec: excerpt.durationSec,
    bytes: encoded.bytes,
    sha256: encoded.sha256,
    format: "aac/m4a",
    bytesSource: track.bytes ?? null,
    fileSource: track.file,
    excerpt: {
      startSec: excerpt.startSec,
      durationSec: excerpt.durationSec,
      sourceDurationSec: track.durationSec,
      reason: excerpt.reason,
      gainAppliedDb: encoded.gainAppliedDb,
      gainMode: encoded.gainMode,
      peakProtected: encoded.peakProtected,
      peakOverrunDb: encoded.peakOverrunDb,
      loudnessDeltaDb: encoded.loudnessDeltaDb,
    },
    loudness: encoded.loudness,
    licenseNote,
    ...(licenseSource ? { licenseSource } : {}),
    curatedAt: new Date().toISOString(),
    curatedScore: pick.score,
  });
  report.push({
    id: track.id,
    file: fileName,
    style: track.style,
    energyBucket: track.energyBucket,
    score: pick.score,
    reasons: pick.reasons,
    excerpt,
    encoded: {
      bytes: encoded.bytes, sha256: encoded.sha256, loudness: encoded.loudness,
      gainAppliedDb: encoded.gainAppliedDb, gainMode: encoded.gainMode,
      peakProtected: encoded.peakProtected, peakOverrunDb: encoded.peakOverrunDb,
      loudnessDeltaDb: encoded.loudnessDeltaDb, retried: encoded.retried,
    },
    sourceFile: track.file,
  });
  process.stderr.write(`[${report.length}/${selection.count}] ${track.id} ← ${path.basename(sourcePath)}（${excerpt.reason}）\n`);
}

const totalBytes = curated.reduce((sum, track) => sum + (track.bytes ?? 0), 0);
const doc = {
  schemaVersion: "workloom.bgm-library/v1",
  library: {
    name: libraryName,
    provider,
    licensePolicy: licenseNote,
    generatedAt: new Date().toISOString(),
    generator: "scripts/bgm-curate-library.mjs",
    tracks: curated.length,
    totalBytes,
    sourceIndex: indexFile,
    selection: {
      rule: "质量分（响度/峰值/削波/结构/动态/拍速置信度/频谱/循环/风格置信度）+ 风格族轮转",
      maxPerStyle: selection.maxPerStyle,
      byStyle: selection.byStyle,
      byEnergyBucket: selection.byEnergyBucket,
      note: "打分只用实测证据；选段用结构/包络证据——没有任何'听了觉得好听'式的主观声明",
    },
    excerptPolicy: `每首取 ${targetSec}s 最合适选段（优先 drop 中心，其次能量最高滑窗），线性增益到 -14 LUFS（峰值贴顶的选段按峰值保护优先、结果低于 -14，逐首实测值见 excerpt.loudnessDeltaDb），AAC ${bitrate} 44.1kHz 立体声`,
    note: "随仓兜底曲库：客户/工位没有自建曲库、在线曲源又不可用时，用这批曲目保证配乐链路不断档",
  },
  tracks: curated,
};
writeFileSync(path.join(outDir, "tracks.json"), `${JSON.stringify(doc, null, 2)}\n`);
writeFileSync(path.join(outDir, "curation-report.json"), `${JSON.stringify({
  generatedAt: doc.library.generatedAt,
  sourceIndex: indexFile,
  count: selection.count,
  maxPerStyle: selection.maxPerStyle,
  byStyle: selection.byStyle,
  byEnergyBucket: selection.byEnergyBucket,
  items: report,
}, null, 2)}\n`);

const styleLines = Object.entries(selection.byStyle)
  .sort((a, b) => b[1] - a[1])
  .map(([style, number]) => `| \`${style}\` | ${STYLE_FAMILIES[style]?.label ?? "（非标准风格名）"} | ${number} |`)
  .join("\n");
const readme = `# 随仓兜底曲库（${curated.length} 首 · 可商用纯音乐选段）

> 本目录由 \`scripts/bgm-curate-library.mjs\` 从产品所有者提供的可商用曲库包中**按实测证据**精选生成，
> 不是手工挑曲、也不是自算合成。每次重生成都会刷新 \`tracks.json\` 与 \`curation-report.json\`。

## 这批曲目是什么

- **用途**：兜底。客户没有自建曲库（\`WORKLOOM_BGM_LIBRARY_DIR\`）、在线曲源也不可用时，配乐链路用这批曲目不断档；
- **形态**：每首 \`${targetSec}s\` 选段（优先取曲子能量最饱满的 drop 段中心），线性增益到 **-14 LUFS / -1 dBTP**，
  AAC ${bitrate} 44.1kHz 立体声——与配乐工位的母版口径一致，混音前不必再猜增益；
- **检索**：\`tracks.json\` 是运行时契约（风格族/题材/情绪/BPM 档/能量档/配器/使用场景/结构/响度/许可），
  工位用 \`bgmread.library\` 检索、\`bgmwrite.best\` 择优；
- **许可**：${licenseNote}
  ${licenseSource ? `\n- **来源**：\`${licenseSource}\`` : ""}

## 风格分布

| 风格族 | 含义 | 曲目数 |
|---|---|---|
${styleLines}

## 选曲口径（可复核）

1. 打标阶段对**原始素材**逐首实测：响度（EBU R128）、真峰值、astats 平坦因子（削波证据）、
   结构分段（intro/drop/breakdown/outro）、起音密度、频谱重心、静音占比、循环友好度；
2. 精选分数 = 响度贴近 -14 LUFS + 峰值/削波 + 结构完整度 + 动态区间 + 拍速置信度 + 频谱 + 循环友好 + 风格置信度 + 时长；
3. 风格族之间**轮转取曲**（每族先保 1 首、单族上限 ${selection.maxPerStyle} 首），保证"不同风格"真的落到库里；
4. 每首为什么入选、取了哪一段、增益多少，全部写在 \`curation-report.json\` 里。

## 复核与再生成

\`\`\`bash
# 重新打标（素材包更新后）
bgm-cli tag --in <素材目录> --out ~/.workloom-bgm/library --license royalty-free --license-note "..."
# 重新精选进仓
node scripts/bgm-curate-library.mjs --index ~/.workloom-bgm/library --out bundles/ai-video/library/bgm-library-curated --count ${curated.length}
\`\`\`

**待产品所有者确认的一点**：素材包内没有逐首上游许可文件，当前按"所有者声明可商用"登记为 \`royalty-free\`。
若这批曲目的授权条款不允许**再分发**（例如仅允许"使用"而不允许随仓分发），请把本目录改为私有存放或只保留索引——
详见 \`curation-report.json\` 的 \`sourceIndex\` 与 \`sourceFile\` 字段（每首都可回溯到原始文件）。
`;
writeFileSync(path.join(outDir, "README.md"), readme);

const sizeMb = (totalBytes / 1024 / 1024).toFixed(1);
const fileSizes = curated.map((track) => statSync(path.join(outDir, track.file)).size);
process.stdout.write(`${JSON.stringify({
  outDir, count: curated.length, totalBytes, totalMb: Number(sizeMb),
  avgKb: Math.round(fileSizes.reduce((a, b) => a + b, 0) / fileSizes.length / 1024),
  byStyle: selection.byStyle, byEnergyBucket: selection.byEnergyBucket, maxPerStyle: selection.maxPerStyle,
}, null, 2)}\n`);
