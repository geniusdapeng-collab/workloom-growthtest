#!/usr/bin/env node
/**
 * 调性/调式 + 能量弧线**增量回标**：对既有曲库逐首实测调性（chromagram + K-S 模板相关，
 * 中部代表段）、按 structure 段落证据归纳能量弧线，幂等写入 tracks.json 的 tags 数组
 * （`key:C4` / `mode:major` / `arc:build-drop` 形式），证据落 tag-evidence.json 的
 * `keyArcEvidence` 段。
 *
 * 不重新实测响度/拍速/结构（那些标签本来就在库里），只补调性与弧线两个维度。
 * 重跑安全：applyKeyArcTags 先清同前缀标签再追加，不产生重复。
 *
 * 用法：node scripts/bgm-backfill-key-arc.mjs --library bundles/ai-video/library/bgm-library-curated [--concurrency 4]
 */
import path from "node:path";

import { retagLibraryKeyArc } from "../bundles/ai-video/connectors/bgm-bridge/tag.mjs";

function arg(name, fallback = null) {
  const index = process.argv.indexOf(`--${name}`);
  if (index < 0) return fallback;
  const value = process.argv[index + 1];
  return value === undefined || value.startsWith("--") ? true : value;
}

const libraryDir = path.resolve(String(arg("library", "bundles/ai-video/library/bgm-library-curated")));
const concurrency = Math.max(1, Number(arg("concurrency", 4)) || 4);

const summary = await retagLibraryKeyArc({
  libraryDir,
  concurrency,
  onProgress: ({ id, index, total, failed }) => {
    process.stdout.write(`\r[${index}/${total}] ${failed ? "✗" : "✓"} ${id}                    `);
  },
});
process.stdout.write("\n");
console.log(JSON.stringify(summary, null, 2));
