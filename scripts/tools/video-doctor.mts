#!/usr/bin/env tsx
/**
 * video-doctor.mts —— 出片环境自检（给 AI Agent / 交付同学，T-2026-0930-0015）
 *
 * 为什么有它（2026-09-30 真机复盘）：客户按"用 Codex 拉云端代码 → 跑视频"这条路走时，
 * 失败点往往不在创意，而在环境：ffmpeg 路径不对、密钥缺、配音工位没起、曲库被路径监狱拦住、
 * 真人素材/商品档案没建档。这些都能在**花钱之前**用确定性检查发现。
 *
 * 用法：
 *   pnpm exec tsx scripts/tools/video-doctor.mts            # 人类可读
 *   pnpm exec tsx scripts/tools/video-doctor.mts --json     # 机器可读（Agent 用）
 * 退出码：存在 FAIL 时 1；只有 WARN 时 0。
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

const REPO_ROOT = resolve(import.meta.dirname ?? process.cwd(), "../..");
const JSON_OUT = process.argv.includes("--json");
type Level = "pass" | "warn" | "fail";
interface Check { id: string; level: Level; detail: string; hint?: string }
const checks: Check[] = [];
const add = (id: string, level: Level, detail: string, hint?: string): void => { checks.push({ id, level, detail, ...(hint ? { hint } : {}) }); };

function probe(command: string, args: string[]): string | null {
  try {
    return execFileSync(command, args, { encoding: "utf8", timeout: 15000, stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return null;
  }
}
function readEnvFile(file: string): Record<string, string> {
  if (!existsSync(file)) return {};
  const out: Record<string, string> = {};
  for (const line of readFileSync(file, "utf8").split("\n")) {
    const match = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (match?.[2]?.trim()) out[match[1]!] = match[2]!.trim();
  }
  return out;
}

/* ---------- 1. 运行时 ---------- */
const nodeVersion = process.versions.node;
add("node", Number(nodeVersion.split(".")[0]) >= 24 ? "pass" : "fail",
  `Node ${nodeVersion}（要求 ≥ 24）`, "安装 Node 24（本仓 engines 要求）后重试");
const pnpmVersion = probe("pnpm", ["--version"]) ?? probe(process.execPath, [join(REPO_ROOT, "node_modules", ".bin", "pnpm"), "--version"]);
add("pnpm", pnpmVersion ? "pass" : "warn", pnpmVersion ? `pnpm ${pnpmVersion}` : "PATH 里没有 pnpm（可用 corepack enable 或 pnpm@10.14.0）",
  "CI 使用 pnpm@10.14.0；版本不一致可能重新解析依赖");
add("deps", existsSync(join(REPO_ROOT, "node_modules")) ? "pass" : "fail",
  existsSync(join(REPO_ROOT, "node_modules")) ? "node_modules 已安装" : "缺少 node_modules", "先跑 pnpm install --frozen-lockfile");

/* ---------- 2. 媒体工具（工位本地 kit 优先，与管线同口径） ---------- */
const kitDir = join(process.env.WORKLOOM_COLOR_HOME || join(homedir(), ".workloom-color"), "bin");
const ffmpeg = process.env.WL_FFMPEG || process.env.FFMPEG_PATH
  || (existsSync(join(kitDir, "ffmpeg")) ? join(kitDir, "ffmpeg") : "ffmpeg");
const ffprobe = process.env.WL_FFPROBE || process.env.FFPROBE_PATH
  || (existsSync(join(kitDir, "ffprobe")) ? join(kitDir, "ffprobe") : "ffprobe");
const ffmpegVersion = probe(ffmpeg, ["-version"]);
const ffprobeVersion = probe(ffprobe, ["-version"]);
add("ffmpeg", ffmpegVersion ? "pass" : "fail", ffmpegVersion ? `${ffmpeg}（${ffmpegVersion.split("\n")[0]?.slice(0, 60)}）` : `找不到 ffmpeg：${ffmpeg}`,
  "安装 ffmpeg/ffprobe，或用 WL_FFMPEG/WL_FFPROBE 指定（管线的调色/字幕/配乐/合成都依赖它）");
add("ffprobe", ffprobeVersion ? "pass" : "fail", ffprobeVersion ? ffprobe : `找不到 ffprobe：${ffprobe}`);

/* ---------- 3. 密钥（只报存在性，不打印值） ---------- */
const keysFile = process.env.WORKLOOM_KEYS_FILE || join(homedir(), ".workloom", "live.env");
const keys = { ...readEnvFile(keysFile), ...process.env };
const hasArk = Boolean(keys.VOLCENGINE_ARK_API_KEY?.trim());
add("ark-key", hasArk ? "pass" : "fail", hasArk ? `火山方舟密钥已配置（${keysFile}）` : `缺 VOLCENGINE_ARK_API_KEY（${keysFile}）`,
  "渲染/出图必需；**账户欠费时提交会被 403 AccountOverdueError 拒绝**——先充值再跑，不要连点重试");
const hasDeepseek = Boolean(keys.DEEPSEEK_API_KEY?.trim());
add("llm-key", hasDeepseek ? "pass" : "warn",
  hasDeepseek ? "评审/仲裁模型密钥已配置" : "缺 DEEPSEEK_API_KEY（只影响 --llm 分流与 advisory/blocking 评审；默认 review-policy=off 不调用）");
const hasStemSigner = Boolean(keys.WORKLOOM_AUDIO_STEM_SIGNING_SECRET?.trim());
add("audio-stem-signer", hasStemSigner ? "pass" : "warn",
  hasStemSigner ? "独立音轨签发者已配置（配乐走签章路径）"
    : "未配置签发者 → 配乐走**声明式直混**（本地无版权曲库可用，回执标注 declared-unverified/stemsVerified=false）");

/* ---------- 4. 配音工位 ---------- */
const voiceStation = join(homedir(), ".workloom/voice-station");
add("voice-station", existsSync(voiceStation) ? "pass" : "warn",
  existsSync(voiceStation) ? `配音工位目录存在：${voiceStation}` : `未发现 ${voiceStation}（逐镜人声核查/补旁白会缺能力）`,
  "voice-bridge health 可自检；缺它时 FP-02/FP-04 这类无声镜头无法本地补旁白");

/* ---------- 5. 曲库 + 路径监狱（真机事故：Downloads 曲库被拦） ---------- */
let jailDetail = "未读取 bgm-bridge（跳过）";
let jailLevel: Level = "warn";
try {
  const bgm = await import("../../bundles/ai-video/connectors/bgm-bridge/core.mjs") as {
    libraryRoots: (env?: NodeJS.ProcessEnv) => Array<{ dir: string; kind: string; label: string }>;
    allowedRoots: (env?: NodeJS.ProcessEnv) => string[];
  };
  const roots = bgm.libraryRoots(process.env);
  const allowed = bgm.allowedRoots(process.env);
  /**
   * 口径必须与出片管线一致：`full-chain-film.mts` 会把本地曲库根（~/.workloom-bgm、~/Downloads、~/Music）
   * 追加进 `WORKLOOM_BGM_ALLOWED_ROOTS`。这里按同一口径判定；同时提示"手工直调 bgm-bridge"的差异。
   */
  const pipelineRoots = [join(homedir(), ".workloom-bgm"), join(homedir(), "Downloads"), join(homedir(), "Music")]
    .filter((dir) => existsSync(dir));
  const effectiveAllowed = [...allowed, ...pipelineRoots];
  // A registered default root that does not exist is not a jail violation.
  const existingRoots = roots.filter((root) => existsSync(root.dir));
  const outside = existingRoots.filter((root) => !effectiveAllowed.some((base) => root.dir === base || root.dir.startsWith(`${base}/`)));
  jailLevel = existingRoots.length === 0 ? "warn" : outside.length === 0 ? "pass" : "fail";
  jailDetail = existingRoots.length === 0
    ? "没有发现任何本地曲库（随仓精选也会算一个，说明仓库结构异常）"
    : `${existingRoots.length} 个存在曲库根；${outside.length === 0
      ? `按管线口径（含追加白名单 ${pipelineRoots.length} 个）全部放行`
      : `有 ${outside.length} 个不在白名单：${outside.map((r) => r.dir).join("、")}`}`
      + `（裸调 bgm-bridge 时的白名单根：${allowed.length} 个——手工直调需自行设 WORKLOOM_BGM_ALLOWED_ROOTS）`;
} catch (error) {
  jailDetail = `读取曲库失败：${error instanceof Error ? error.message.slice(0, 120) : String(error)}`;
}
add("bgm-library-jail", jailLevel, jailDetail,
  "配乐工位的路径监狱默认只放行 cwd/tmpdir；本地曲库在 ~/Downloads 时由管线自动纳入白名单（BGM_ALLOWED_ROOTS）");

/* ---------- 6. 档案资产（真人 / 商品 / 片型 / 封面知识库） ---------- */
const assetDirs: Array<[string, string, string]> = [
  ["real-person-assets", join(REPO_ROOT, "bundles/ai-video/library/real-person-assets"), "认证真人主档（asset:// 出镜链路必需）"],
  ["products", join(REPO_ROOT, "bundles/ai-video/library/products"), "真实商品档案（营销片 G-PROD1 逐镜绑定）"],
  ["scene-policies", join(REPO_ROOT, "bundles/ai-video/library/scene-policies"), "片型知识条目（T1 商业真人出镜等）"],
  ["cover-kb", join(REPO_ROOT, "bundles/ai-video/library/cover-kb"), "封面知识库（cover-kb 注入）"]
];
for (const [id, dir, label] of assetDirs) {
  const exists = existsSync(dir);
  add(`library:${id}`, exists ? "pass" : "warn", exists ? `${label}：${dir}` : `缺 ${dir}（${label}）`);
}

/* ---------- 7. 入口与 runbook ---------- */
for (const [id, file, label] of [
  ["entry:route", "scripts/tools/route-video.mts", "分流 CLI（出片前必须先跑）"],
  ["entry:film", "scripts/tools/full-chain-film.mts", "出片 CLI"],
  ["entry:explainer", "scripts/tools/explainer-run.mts", "口播解说片 CLI"],
  ["runbook", "bundles/ai-video/README.md", "Agent 安装/执行 runbook"]
] as const) {
  add(id, existsSync(join(REPO_ROOT, file)) ? "pass" : "fail", `${label}：${file}`);
}

/* ---------- 输出 ---------- */
const failures = checks.filter((entry) => entry.level === "fail");
const warnings = checks.filter((entry) => entry.level === "warn");
if (JSON_OUT) {
  console.log(JSON.stringify({ at: new Date().toISOString(), repoRoot: REPO_ROOT, checks, summary: {
    pass: checks.length - failures.length - warnings.length, warn: warnings.length, fail: failures.length } }, null, 2));
} else {
  const badge = { pass: "✅", warn: "⚠️", fail: "⛔" } as const;
  console.log(`出片环境自检（video-doctor）· ${REPO_ROOT}\n`);
  for (const entry of checks) console.log(`${badge[entry.level]} ${entry.id.padEnd(22)} ${entry.detail}`);
  console.log(`\n通过 ${checks.length - failures.length - warnings.length} · 告警 ${warnings.length} · 失败 ${failures.length}`);
  if (failures.length > 0) {
    console.log("\n先修 FAIL 项：");
    for (const entry of failures) console.log(`- ${entry.id}：${entry.hint ?? entry.detail}`);
  }
  if (warnings.length > 0) {
    console.log("\n可先忽略的 WARN（会影响体验/降级能力）：");
    for (const entry of warnings) console.log(`- ${entry.id}：${entry.hint ?? entry.detail}`);
  }
}
process.exit(failures.length > 0 ? 1 : 0);
