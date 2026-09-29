#!/usr/bin/env node
/**
 * 补跑打标失败项：读曲库目录里的 `tag-report.json`，把 `errors` 里列出的文件重新量测，
 * 成功则并入 `tracks.json` / `tag-evidence.json` / `tag-report.json`（失败原因照旧保留）。
 *
 * 为什么要有它：上千首素材里总有个别文件触发 ffmpeg 的边缘情况（实测 4 首 MP3 带损坏的内嵌 PNG 封面，
 * 让 loudnorm 收尾直接 "Conversion failed!"）。为此重跑 30 分钟全量打标不划算，
 * 但也不能把这些文件悄悄丢掉——补跑 + 如实留痕才是正确做法。
 *
 * 用法：node scripts/bgm-tag-retry.mjs --library ~/.workloom-bgm/library [--mode all|retry|backfill] [--external-tags model.json]
 *
 * `backfill`：索引是用旧版打标器生成时（比如还没读内嵌元数据），不必重跑 30 分钟全量分析——
 * 只补读 ID3/MP4 tags 并回填 title/artist/album/copyright（每首一次 ffprobe，约 30ms）。
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

import {
  DEFAULT_FILTERS, applyHardFilters, buildIndexEntry, classifyTrack, measureTrack,
  mergeExternalTags, readMediaTags, titleArtistOf, writeLibrary,
} from "../bundles/ai-video/connectors/bgm-bridge/tag.mjs";

function arg(name, fallback = null) {
  const index = process.argv.indexOf(`--${name}`);
  if (index < 0) return fallback;
  const value = process.argv[index + 1];
  return value === undefined || value.startsWith("--") ? true : value;
}

const libraryDir = path.resolve(String(arg("library", path.join(process.env.HOME ?? ".", ".workloom-bgm/library"))));
const indexFile = path.join(libraryDir, "tracks.json");
const evidenceFile = path.join(libraryDir, "tag-evidence.json");
const reportFile = path.join(libraryDir, "tag-report.json");
for (const file of [indexFile, evidenceFile, reportFile]) {
  if (!existsSync(file)) throw new Error(`缺少 ${file}（先跑一次全量打标）`);
}

const doc = JSON.parse(readFileSync(indexFile, "utf8"));
const evidenceDoc = JSON.parse(readFileSync(evidenceFile, "utf8"));
const report = JSON.parse(readFileSync(reportFile, "utf8"));
const mode = String(arg("mode", "all"));
const failed = Array.isArray(report.errors) ? report.errors : [];

const license = String(arg("license", doc.tracks?.[0]?.license ?? "royalty-free"));
const licenseNote = doc.tracks?.[0]?.licenseNote ?? `许可 ${license}（调用方声明）`;
const filters = report.filters ?? DEFAULT_FILTERS;
const tracks = [...(doc.tracks ?? [])];
const evidence = [...(evidenceDoc.evidence ?? [])];
const stillFailing = [];
const recovered = [];

for (const item of mode === "backfill" ? [] : failed) {
  const absolute = path.isAbsolute(item.file) ? item.file : path.resolve(doc.library?.sourceRoot ?? libraryDir, item.file);
  if (!existsSync(absolute)) {
    stillFailing.push({ ...item, error: `源文件不存在：${absolute}` });
    continue;
  }
  try {
    const measurement = await measureTrack({ input: absolute });
    const mediaTags = await readMediaTags(absolute);
    const verdict = applyHardFilters(measurement, filters);
    if (!verdict.keep) {
      stillFailing.push({ file: item.file, error: `补跑后仍不达标：${verdict.rejections.join("；")}` });
      continue;
    }
    const relativePath = item.file;
    const tags = classifyTrack({ measurement, relativePath, mediaTags });
    const entry = buildIndexEntry({
      measurement, tags, root: doc.library?.sourceRoot ?? libraryDir, relativePath,
      license, licenseNote, licenseSource: doc.tracks?.[0]?.licenseSource ?? null, index: tracks.length + 1,
    });
    // 包内相对能量档：沿用既有三分位（补跑单曲不重算整包分档）
    entry.energyBucket = entry.energyBucket ?? "mid";
    tracks.push(entry);
    evidence.push({
      id: entry.id, file: relativePath, sha256: measurement.sha256, durationSec: measurement.durationSec,
      analyzedSec: measurement.analyzedSec, analyzedNote: measurement.analyzedNote, loudness: measurement.loudness,
      peak: measurement.peak, clip: measurement.clip, envelope: measurement.envelope, tempo: measurement.tempo,
      structure: measurement.structure, voice: measurement.voice, silence: measurement.silence,
      spectral: measurement.spectral, onsetRatePerSec: measurement.onsetRatePerSec, energyScore: measurement.energyScore,
      tags: {
        style: tags.style, styleConfidence: tags.styleConfidence, genre: tags.genre, mood: tags.mood,
        useCases: tags.useCases, bpmBucket: tags.bpmBucket, instrumentation: tags.instrumentation,
        loop: tags.loop, vocalPresence: tags.vocalPresence, hint: tags.hint,
      },
      retried: true,
    });
    recovered.push({ file: item.file, id: entry.id, error: item.error });
  } catch (error) {
    stillFailing.push({ ...item, error: `${item.error} → 补跑仍失败：${error instanceof Error ? error.message : String(error)}` });
  }
}

/** 元数据回填：只补读内嵌 tags，重算标题/作者/专辑/版权归属（不动音频量测与标签）。 */
let backfilled = 0;
if (mode !== "retry") {
  for (const track of tracks) {
    const absolute = path.isAbsolute(track.file) ? track.file : path.resolve(doc.library?.sourceRoot ?? libraryDir, track.file);
    if (!existsSync(absolute)) continue;
    const tags = await readMediaTags(absolute);
    const identity = titleArtistOf({ tags, relativePath: track.curatedFrom ?? track.file });
    const before = `${track.title}|${track.artist}`;
    track.title = identity.title ?? track.title;
    track.artist = identity.artist ?? track.artist;
    if (identity.album) track.album = identity.album;
    track.titleSource = identity.titleSource;
    track.artistSource = identity.artistSource;
    if (identity.copyright) track.sourceCopyright = identity.copyright;
    if (identity.date) track.sourceDate = identity.date;
    if (`${track.title}|${track.artist}` !== before) backfilled += 1;
  }
}

/** 可选：并入外部打标模型输出（不覆盖本地实测，只并列留痕；详见 mergeExternalTags 注释）。 */
let externalMerge = null;
const externalFile = arg("external-tags", null);
if (externalFile && externalFile !== true) {
  const external = JSON.parse(readFileSync(path.resolve(String(externalFile)), "utf8"));
  externalMerge = mergeExternalTags({ tracks, external });
}

const counts = {
  ...(doc.library?.counts ?? {}),
  scanned: doc.library?.counts?.scanned ?? tracks.length,
  tagged: tracks.length,
  failed: stillFailing.length,
};
writeLibrary({
  outDir: libraryDir,
  libraryName: doc.library?.name ?? "本地曲库",
  provider: doc.library?.provider ?? "owner-provided-pack",
  fileMode: doc.library?.fileMode ?? "absolute",
  result: {
    schemaVersion: "workloom.bgm-tag/v1",
    root: doc.library?.sourceRoot ?? libraryDir,
    license,
    licenseNote,
    licenseSource: doc.tracks?.[0]?.licenseSource ?? null,
    filters,
    generatedAt: new Date().toISOString(),
    counts,
    tracks,
    rejected: report.rejected ?? [],
    errors: stillFailing,
    evidence,
  },
});
process.stdout.write(`${JSON.stringify({
  libraryDir, mode, recovered: recovered.length, stillFailing: stillFailing.length, backfilled,
  externalMerge,
  tracks: tracks.length, recoveredItems: recovered,
  remaining: stillFailing.map((item) => ({ file: item.file, error: item.error })),
}, null, 2)}\n`);
