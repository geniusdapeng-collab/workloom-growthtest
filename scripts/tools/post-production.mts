#!/usr/bin/env tsx
/**
 * post-production.mts —— 后期环节的宿主侧接线（2026-09-22）
 *
 * 为什么需要：`deferRender` 之后 vendor Layer 3 不再提交渲染，vendor 的后期引擎因此拿不到
 * `shot-<id>.mp4`，质量门固定失败（真机 2026-09-22：4 个版本全部 "视频文件不存在 (shot-S1.mp4)"）。
 * 本工具把**宿主渲染出来的真实成片路径**回填成 `renderResult.results`（含绝对 videoPath），
 * 再调 vendor 的 `PostProductionEngine.postProduce`，让"后期合成"这一步真正产出：
 * 字幕轨（身份卡）、音乐轨、四个版本（standard/clean/subtitled/raw）的 HTML 与 config，
 * 以及质量门结论。
 *
 * 用法：
 *   pnpm exec tsx scripts/tools/post-production.mts \
 *     --run apps/server/output/<ts>_<title> --render-summary <runDir>/render-summary.json [--json]
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";

const REPO_ROOT = resolve(import.meta.dirname ?? process.cwd(), "../..");

function arg(name: string, fallback = ""): string {
  const i = process.argv.indexOf(name);
  return i >= 0 ? (process.argv[i + 1] ?? fallback) : fallback;
}
const flag = (name: string) => process.argv.includes(name);

function newestRunDir(): string {
  const base = join(REPO_ROOT, "apps/server/output");
  const dirs = readdirSync(base).map((n) => join(base, n)).filter((p) => statSync(p).isDirectory());
  dirs.sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs);
  if (!dirs[0]) throw new Error("apps/server/output 下没有运行产物");
  return dirs[0];
}

const runDir = arg("--run") ? resolve(REPO_ROOT, arg("--run")) : newestRunDir();
const resultPath = join(runDir, "result.json");
if (!existsSync(resultPath)) throw new Error(`缺少 result.json：${resultPath}`);
const result = JSON.parse(readFileSync(resultPath, "utf8")) as {
  stages?: Record<string, unknown>;
};

const summaryPath = arg("--render-summary")
  ? resolve(REPO_ROOT, arg("--render-summary"))
  : join(runDir, "render-summary.json");
if (!existsSync(summaryPath)) throw new Error(`缺少出片汇总（先跑 render-project.mts）：${summaryPath}`);
const summary = JSON.parse(readFileSync(summaryPath, "utf8")) as {
  shots?: Array<{ shotId: string; localPath?: string | null; status?: string; assetId?: string | null; seconds?: number }>;
};

const mediaRoot = process.env.WORKLOOM_MEDIA_DIR?.trim() || join(REPO_ROOT, "var/media");
const rendered = (summary.shots ?? []).map((shot) => {
  const localPath = shot.localPath
    ? (shot.localPath.startsWith("/") ? shot.localPath : join(mediaRoot, shot.localPath))
    : null;
  return {
    shotId: shot.shotId,
    success: shot.status === "done",
    videoPath: localPath,
    videoUrl: localPath,
    assetId: shot.assetId ?? null,
    duration: shot.seconds ?? null
  };
});
const missing = rendered.filter((r) => !r.videoPath || !existsSync(r.videoPath));
if (missing.length > 0) {
  throw new Error(
    `以下镜头本地成片缺失（先完成渲染与入库）：${missing.map((m) => m.shotId).join("、")}`
  );
}

const outDir = resolve(REPO_ROOT, arg("--out", join(runDir.replace(REPO_ROOT + "/", ""), "post")));
mkdirSync(outDir, { recursive: true });

const vendorRequire = createRequire(join(REPO_ROOT, "package.json"));
const enginePath = join(
  REPO_ROOT,
  "vendor/supermickey/hyperreality-system/engines/post-production-engine/post-production-engine.js"
);
const { PostProductionEngine } = vendorRequire(enginePath) as {
  PostProductionEngine: new (options?: Record<string, unknown>) => {
    postProduce(
      productionResult: Record<string, unknown>,
      scriptResult: Record<string, unknown>,
      renderResult: Record<string, unknown>
    ): Promise<Record<string, unknown>>;
  };
};

const productionEngine = (result.stages?.productionEngine ?? {}) as Record<string, unknown>;
/**
 * vendor 的 `qualityCheck` 读的是 `productionResult.shots[].videoSrc/videoPath`（不是 HTML 里的 src），
 * 因此必须把宿主渲染出的**绝对路径**合进镜头卡，否则永远报 "视频文件不存在 (shot-SX.mp4)"。
 */
const renderByShot = new Map(rendered.map((r) => [r.shotId, r]));
const shotsWithRenderPaths = ((productionEngine.shots as Array<Record<string, unknown>>) ?? []).map((shot) => {
  const hit = renderByShot.get(String(shot.shotId));
  return hit?.videoPath ? { ...shot, videoSrc: hit.videoPath, videoPath: hit.videoPath } : shot;
});
const productionResult = {
  shots: shotsWithRenderPaths,
  prompts: productionEngine.prompts ?? [],
  _creativeIntensity: result.stages?.creativeIntensity ?? null
};
const scriptResult = (result.stages?.scriptEngine ?? {}) as Record<string, unknown>;

const engine = new PostProductionEngine({ outputDir: outDir, versions: ["standard", "clean", "subtitled", "raw"] });
console.log(`后期合成（vendor PostProductionEngine）→ ${outDir}`);
console.log(`   镜头成片：${rendered.map((r) => `${r.shotId}=${r.videoPath}`).join(" ")}`);
const post = await engine.postProduce(productionResult, scriptResult, { results: rendered });

const reportPath = join(outDir, "post-report.json");
writeFileSync(reportPath, `${JSON.stringify(post, null, 2)}\n`, "utf8");
const mdPath = join(outDir, "post-report.md");
const versions = (post.versions ?? {}) as Record<string, { htmlPath?: string; shots?: unknown[] }>;
const stageInfo = (post.stages ?? {}) as Record<string, Record<string, unknown>>;
const quality = stageInfo.quality ?? {};
const md = [
  "# 后期合成报告（宿主渲染回填）",
  "",
  `- 产物目录：\`${outDir.replace(REPO_ROOT + "/", "")}\``,
  `- 结果：${post.success ? "✅ 成功" : "❌ 失败"}`,
  `- 版本：${Object.keys(versions).join("、") || "—"}`,
  `- 字幕轨：${String(stageInfo.subtitles?.count ?? "—")} 条；音乐轨：${String(stageInfo.music?.count ?? "—")} 条；剪辑：${String(stageInfo.assembly?.timing ?? "—")}ms`,
  `- 质量门：${quality.passed === true ? "pass" : `fail（${((quality.issues as string[]) ?? []).slice(0, 3).join("；")}）`}`,
  "",
  "| 版本 | HTML | 镜头数 |",
  "|---|---|---:|",
  ...Object.entries(versions).map(([name, v]) => `| ${name} | ${v.htmlPath ?? "—"} | ${v.shots?.length ?? 0} |`),
  ""
].join("\n");
writeFileSync(mdPath, md, "utf8");

console.log(md);
if (flag("--json")) console.log(JSON.stringify({ outDir, report: reportPath, post }, null, 2));
else console.log(`后期报告：${reportPath.replace(REPO_ROOT + "/", "")} / ${mdPath.replace(REPO_ROOT + "/", "")}`);
