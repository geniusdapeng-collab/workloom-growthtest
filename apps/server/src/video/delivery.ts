/**
 * video/delivery.ts —— 交付包与返修的宿主侧接线（T-2026-0924-0071）
 *
 * 定位：把 `bundles/ai-video/connectors/post-bridge` 交付包**放进产品面**——
 *   ① 读：列出交付包、读单个包（母版/旁挂字幕/变体/差异实测/检查结论/返修历史）；
 *   ② 选：用户在几个风格变体里点一个 → 落 `selection.json` + 事件留痕（谁、什么时候、选了哪个、为什么）；
 *   ③ 修：用户提意见 → 调分诊（确定性规则表）→ 生成 patch → **本地层增量重合成**（spawn 工位 CLI，
 *      不重新生成镜头；点名到画面内容时只出计划、要求人审）。
 *
 * 纪律：
 * - **路径监狱**：只允许访问交付根（`WORKLOOM_DELIVERY_DIR`，默认 `<repo>/var/delivery`）内的包；
 *   目录名不接受斜杠/点点，解析后再做一次 startsWith 校验；
 * - **不伪造**：清单缺失、变体不存在、工位 CLI 不存在一律抛错或明确标注，不静默兜底；
 * - **不做长事务**：重合成是本地 ffmpeg 作业，接口立刻返回 jobId，前端轮询作业状态（日志落盘可追）；
 * - 事件与文件写入分离：文件写盘在本地完成，五元事件由 router 侧在同一事务里补（D16）。
 */
import { spawn } from "node:child_process";
import {
  appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync,
} from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

/**
 * 交付物取件走 **tRPC 单一入口**（`video.delivery.artifact`），不再新开 Hono 路由：
 * 舰队同步 PR（`sync/base-*`）常年会改 `apps/server/src/index.ts`，协议 §4 的"同文件后到者拒"
 * 会让交付界面永远排在同步 PR 后面。落在行业域的 tRPC 子路由既避开该热点文件，
 * 又天然继承 workspace 作用域与统一的错误规约。
 */
const ARTIFACT_MIME: Record<string, string> = {
  ".mp4": "video/mp4",
  ".mov": "video/quicktime",
  ".mkv": "video/x-matroska",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".srt": "text/plain; charset=utf-8",
  ".vtt": "text/vtt; charset=utf-8",
  ".ass": "text/plain; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".md": "text/markdown; charset=utf-8",
};
/** 页内取件上限（base64 会膨胀约 1/3）：超过就只给本地路径提示，不在页面里搬大文件 */
export const ARTIFACT_INLINE_MAX_BYTES = 8 * 1024 * 1024;

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../../..");

export class DeliveryError extends Error {
  readonly code: string;
  constructor(message: string, code = "bad_request") {
    super(message);
    this.name = "DeliveryError";
    this.code = code;
  }
}

/* ============================ 路径监狱 ============================ */

export function deliveryRoot(env: NodeJS.ProcessEnv = process.env): string {
  const raw = (env.WORKLOOM_DELIVERY_DIR ?? "").trim();
  return raw ? resolve(raw) : join(REPO_ROOT, "var/delivery");
}

function assertInside(target: string, root: string): string {
  const abs = resolve(target);
  if (abs !== root && !abs.startsWith(root + sep)) {
    throw new DeliveryError(`路径越界：${abs}（交付根 ${root}）`, "path_not_allowed");
  }
  return abs;
}

/**
 * 交付包目录名解析：只接受**单个目录名**（不含分隔符与 `..`），再拼到交付根下做二次校验。
 * 这样"包"这个用户可见标识永远是根下的直接子目录，杜绝 `../` 之类的路径穿越。
 */
export function resolvePackageDir(dir: string, env: NodeJS.ProcessEnv = process.env): string {
  const root = deliveryRoot(env);
  const name = String(dir ?? "").trim();
  if (!name) throw new DeliveryError("缺少交付包目录名", "bad_request");
  if (name.includes("/") || name.includes("\\") || name.includes("..") || name.startsWith(".")) {
    throw new DeliveryError(`交付包目录名非法：${name}`, "path_not_allowed");
  }
  const abs = assertInside(join(root, name), root);
  if (!existsSync(abs) || !statSync(abs).isDirectory()) {
    throw new DeliveryError(`交付包不存在：${name}`, "not_found");
  }
  if (!existsSync(join(abs, "delivery-manifest.json"))) {
    throw new DeliveryError(`该目录不是交付包（缺 delivery-manifest.json）：${name}`, "not_found");
  }
  return abs;
}

/**
 * 产物 → **包内相对引用**（如 `variants/warm-story/cover.png`）。
 *
 * 为什么不是签名 URL：交付根专属的 HTTP 路由要改 `apps/server/src/index.ts`，而舰队同步 PR 常年占用该文件
 * （协议 §4 同文件后到者拒）。改成"引用 + tRPC 取件"后，这条链路不再与同步 PR 抢路径，
 * 也避免为本地交付物再引入一套签名密钥；安全边界由 `readDeliveryArtifact` 的路径监狱守住。
 *
 * **必须接收 env**：交付根可经 `WORKLOOM_DELIVERY_DIR` 覆盖（测试/多实例部署）。
 */
function artifactRefFor(
  packageDir: string,
  relOrAbs: string | null | undefined,
  env: NodeJS.ProcessEnv = process.env,
): string | null {
  if (!relOrAbs) return null;
  void env;
  const abs = isAbsolute(relOrAbs) ? relOrAbs : resolve(packageDir, relOrAbs);
  if (!existsSync(abs)) return null;
  const rel = relative(packageDir, abs);
  if (!rel || rel.startsWith("..")) return null;
  return rel.split(sep).join("/");
}

/**
 * 读交付物（页内取件）：路径监狱 + 体积上限 + 内容类型推断。
 * 超出上限时抛 `artifact_too_large`（界面据此提示"用本地播放器打开 <路径>"），不硬搬大文件。
 */
export function readDeliveryArtifact({
  dir, ref, maxBytes = ARTIFACT_INLINE_MAX_BYTES, env = process.env,
}: {
  dir: string; ref: string; maxBytes?: number; env?: NodeJS.ProcessEnv;
}): { ref: string; bytes: number; contentType: string; base64: string } {
  const packageDir = resolvePackageDir(dir, env);
  const cleanRef = String(ref ?? "").trim();
  if (!cleanRef || isAbsolute(cleanRef) || cleanRef.includes("..")) {
    throw new DeliveryError(`交付物引用非法：${cleanRef}`, "path_not_allowed");
  }
  const abs = resolve(packageDir, cleanRef);
  if (!abs.startsWith(packageDir + sep)) {
    throw new DeliveryError(`交付物越界：${cleanRef}`, "path_not_allowed");
  }
  if (!existsSync(abs) || !statSync(abs).isFile()) {
    throw new DeliveryError(`交付物不存在：${cleanRef}`, "not_found");
  }
  const bytes = statSync(abs).size;
  const limit = Math.max(1024, Math.min(maxBytes, 64 * 1024 * 1024));
  if (bytes > limit) {
    throw new DeliveryError(
      `交付物 ${cleanRef} 共 ${(bytes / 1048576).toFixed(1)}MB，超过页内取件上限 ${(limit / 1048576).toFixed(0)}MB：`
      + `请用本地播放器打开交付物（路径 ${abs}）`,
      "artifact_too_large",
    );
  }
  return {
    ref: cleanRef,
    bytes,
    contentType: ARTIFACT_MIME[extnameOf(abs)] ?? "application/octet-stream",
    base64: readFileSync(abs).toString("base64"),
  };
}

function extnameOf(file: string): string {
  const index = file.lastIndexOf(".");
  return index < 0 ? "" : file.slice(index).toLowerCase();
}

/* ============================ 交付清单的读模型 ============================ */

export interface ManifestVariant {
  id: string;
  name?: string;
  positioning?: string | null;
  dir?: string;
  video?: { path?: string; sha256?: string; duration?: number | null };
  softsub?: { path?: string; sha256?: string; tracks?: Array<{ lang?: string; title?: string }> } | null;
  burned?: { path?: string; sha256?: string } | null;
  cover?: { path?: string; sha256?: string; text?: string | null; at?: number | null };
  copy?: { path?: string; title?: string | null; hashtags?: string[]; checks?: Array<{ kind?: string; ok?: boolean }> };
  audio?: {
    path?: string; trackId?: string | null; trackTitle?: string | null;
    loudness?: { after?: { integratedLufs?: number | null; truePeakDbtp?: number | null } } | null;
    mixing?: { requestedMusicLevelDb?: number | null; appliedMusicLevelDb?: number | null; autoTrimDb?: number | null; note?: string } | null;
    failed?: boolean; code?: string; message?: string;
  } | null;
  style?: {
    color?: { profile?: string | null; lut?: string | null; intensity?: number | null } | null;
    bgm?: { mood?: string | null; style?: string | null; policy?: string | null; musicLevelDb?: number | null } | null;
    transitions?: { mode?: string; fadeSec?: number } | null;
    copyTone?: string | null;
  };
}

export interface DeliveryManifest {
  schemaVersion?: string;
  projectId?: string;
  title?: string;
  createdAt?: string;
  platform?: string | null;
  resolution?: number[];
  fps?: number;
  master?: { path?: string; sha256?: string; duration?: number | null; subtitles?: string };
  subtitles?: {
    dir?: string;
    manifest?: string;
    files?: Array<{ path?: string; role?: string; lang?: string; format?: string; sha256?: string }>;
  } | null;
  variants?: ManifestVariant[];
  divergence?: Array<{
    a?: string; b?: string;
    visual?: { meanAbsDiff?: number; verdict?: string };
    audio?: { a?: string | null; b?: string | null; differs?: boolean };
  }>;
  coverDivergence?: Array<{ a?: string; b?: string; meanAbsDiff?: number; verdict?: string }>;
  checks?: Array<{ kind?: string; ok?: boolean; detail?: unknown }>;
  filmProject?: string;
  cost?: { shotGeneration?: string; tokenCostDelta?: number | string; note?: string };
}

export interface DeliverySelection {
  variantId: string;
  note: string | null;
  by: string | null;
  at: string;
}

export interface DeliveryPackageSummary {
  dir: string;
  projectId: string;
  title: string;
  createdAt: string | null;
  platform: string | null;
  variantCount: number;
  variantIds: string[];
  passed: boolean;
  failedChecks: string[];
  selectedVariantId: string | null;
  revisionCount: number;
  coverRef: string | null;
}

export interface DeliveryPackageDetail extends DeliveryPackageSummary {
  resolution: number[] | null;
  fps: number | null;
  master: { path: string | null; ref: string | null; duration: number | null; sha256: string | null; subtitles: string | null };
  subtitleFiles: Array<{ path: string; lang: string; format: string; ref: string | null; sha256: string | null }>;
  variants: DeliveryVariantView[];
  divergence: Array<{ a: string; b: string; meanAbsDiff: number | null; verdict: string | null; audioDiffers: boolean }>;
  coverDivergence: Array<{ a: string; b: string; meanAbsDiff: number | null; verdict: string | null }>;
  checks: Array<{ kind: string; ok: boolean; detail: unknown }>;
  cost: DeliveryManifest["cost"] | null;
    selection: DeliverySelection | null;
    selections: DeliverySelection[];
    revisions: Array<{ version: number | null; at: string | null; localOnly: boolean | null; patch: unknown; outDir: string | null }>;
  /** 最新一轮返修里"如实记账但用户必须知道"的瑕疵（例如某变体配乐没过检、已按原声降级） */
  latestRevisionWarnings: string[];
  projectPath: string | null;
}

/** 交付包里一个风格变体在界面上的读模型（含签名媒体 URL 与"是否被选中"）。 */
export interface DeliveryVariantView {
  id: string;
  name: string;
  positioning: string | null;
  videoRef: string | null;
  /** 成片的包内相对路径：超出页内取件上限时，界面用它提示"用本地播放器打开" */
  videoPath: string | null;
  softsubRef: string | null;
  burnedRef: string | null;
  coverRef: string | null;
  coverText: string | null;
  duration: number | null;
  style: ManifestVariant["style"] | null;
  copy: { title: string | null; hashtags: string[]; checks: Array<{ kind: string; ok: boolean }> };
  audio: {
    trackId: string | null;
    trackTitle: string | null;
    lufs: number | null;
    autoTrimDb: number | null;
    failed: boolean;
    message: string | null;
  } | null;
  isSelected: boolean;
}

function readJson<T>(file: string): T | null {
  if (!existsSync(file)) return null;
  try {
    return JSON.parse(readFileSync(file, "utf8")) as T;
  } catch {
    throw new DeliveryError(`JSON 解析失败：${file}`, "bad_media");
  }
}

function readSelections(packageDir: string): DeliverySelection[] {
  const latest = readJson<DeliverySelection>(join(packageDir, "selection.json"));
  const rows: DeliverySelection[] = [];
  const jsonl = join(packageDir, "selections.jsonl");
  if (existsSync(jsonl)) {
    for (const line of readFileSync(jsonl, "utf8").split("\n")) {
      if (!line.trim()) continue;
      try {
        rows.push(JSON.parse(line) as DeliverySelection);
      } catch {
        /* 单行损坏不阻塞读模型：历史行只作展示 */
      }
    }
  }
  if (latest && !rows.some((row) => row.at === latest.at && row.variantId === latest.variantId)) rows.push(latest);
  return rows;
}

function readRevisions(packageDir: string): DeliveryPackageDetail["revisions"] {
  const versionsDir = join(packageDir, "versions");
  if (!existsSync(versionsDir)) return [];
  const rows: DeliveryPackageDetail["revisions"] = [];
  for (const entry of readdirSync(versionsDir)) {
    const rev = readJson<{ version?: number; at?: string; impact?: { localOnly?: boolean }; patch?: unknown; outDir?: string }>(
      join(versionsDir, entry, "revision.json"),
    );
    if (!rev) continue;
    rows.push({
      version: typeof rev.version === "number" ? rev.version : null,
      at: typeof rev.at === "string" ? rev.at : null,
      localOnly: rev.impact?.localOnly ?? null,
      patch: rev.patch ?? null,
      outDir: rev.outDir ? relative(packageDir, rev.outDir) : `versions/${entry}`,
    });
  }
  return rows.sort((a, b) => (b.version ?? 0) - (a.version ?? 0));
}

/**
 * 最新一轮返修的"瑕疵清单"（**如实上屏，不埋在日志里**）。
 *
 * 典型场景：返修给的配乐指令在曲库里找不到 → 工位拒绝出带配乐的成片、把该变体按**原声**降级交付，
 * 并在 `variants/<id>/audio.json` 里写 `failed/code/message`。如果界面只显示"重合成完成"，
 * 用户会以为配乐换了——所以这里把失败逐条抽出来给界面显示。
 */
function readLatestRevisionWarnings(packageDir: string, revisions: DeliveryPackageDetail["revisions"]): string[] {
  const latest = revisions.find((rev) => rev.outDir);
  if (!latest?.outDir) return [];
  const root = resolve(packageDir, latest.outDir);
  const warnings: string[] = [];
  const variantsDir = join(root, "variants");
  if (existsSync(variantsDir)) {
    for (const variantId of readdirSync(variantsDir)) {
      const audio = readJson<{ failed?: boolean; code?: string; message?: string }>(
        join(variantsDir, variantId, "audio.json"),
      );
      if (audio?.failed) {
        warnings.push(`变体「${variantId}」配乐未通过复检（${audio.code ?? "unknown"}）：${audio.message ?? ""}——该变体已按原声降级交付`);
      }
    }
  }
  const revision = readJson<{ rebuilt?: Array<{ layer?: string; variant?: string; failure?: { code?: string; message?: string } }> }>(
    join(root, "revision.json"),
  );
  for (const row of revision?.rebuilt ?? []) {
    if (row.failure) {
      warnings.push(`${row.layer ?? "层"}（${row.variant ?? "-"}）失败：${row.failure.message ?? row.failure.code ?? "未知原因"}`);
    }
  }
  return warnings;
}

function summarize(packageDir: string, manifest: DeliveryManifest, env: NodeJS.ProcessEnv = process.env): DeliveryPackageSummary {
  const variants = Array.isArray(manifest.variants) ? manifest.variants : [];
  const checks = Array.isArray(manifest.checks) ? manifest.checks : [];
  const selections = readSelections(packageDir);
  const revisions = readRevisions(packageDir);
  const firstCover = variants.find((variant) => variant.cover?.path)?.cover?.path ?? null;
  return {
    dir: basename(packageDir),
    projectId: String(manifest.projectId ?? basename(packageDir)),
    title: String(manifest.title ?? manifest.projectId ?? basename(packageDir)),
    createdAt: manifest.createdAt ?? null,
    platform: manifest.platform ?? null,
    variantCount: variants.length,
    variantIds: variants.map((variant) => String(variant.id)),
    passed: checks.length > 0 && checks.every((check) => check.ok !== false),
    failedChecks: checks.filter((check) => check.ok === false).map((check) => String(check.kind ?? "unknown")),
    selectedVariantId: selections.at(-1)?.variantId ?? null,
    revisionCount: revisions.length,
    coverRef: firstCover ? artifactRefFor(packageDir, firstCover, env) : null,
  };
}

/** 列出交付根下的全部交付包（按创建时间倒序；根不存在时返回空列表而不是报错）。 */
export function listDeliveryPackages({
  limit = 20, env = process.env,
}: { limit?: number; env?: NodeJS.ProcessEnv } = {}): DeliveryPackageSummary[] {
  const root = deliveryRoot(env);
  if (!existsSync(root)) return [];
  const rows: DeliveryPackageSummary[] = [];
  for (const entry of readdirSync(root)) {
    const packageDir = join(root, entry);
    if (!statSync(packageDir).isDirectory()) continue;
    const manifest = readJson<DeliveryManifest>(join(packageDir, "delivery-manifest.json"));
    if (!manifest) continue;
    rows.push(summarize(packageDir, manifest, env));
  }
  return rows
    .sort((a, b) => String(b.createdAt ?? "").localeCompare(String(a.createdAt ?? "")))
    .slice(0, Math.max(1, Math.min(100, limit)));
}

/** 读单个交付包（清单 + 变体 + 差异实测 + 检查 + 返修历史 + 选择记录；媒体给出签名 URL）。 */
export function readDeliveryPackage(dir: string, env: NodeJS.ProcessEnv = process.env): DeliveryPackageDetail {
  const packageDir = resolvePackageDir(dir, env);
  const manifest = readJson<DeliveryManifest>(join(packageDir, "delivery-manifest.json"));
  if (!manifest) throw new DeliveryError(`交付清单缺失：${dir}`, "not_found");
  const base = summarize(packageDir, manifest, env);
  const selections = readSelections(packageDir);
  const selectedId = selections.at(-1)?.variantId ?? null;
  const variants: DeliveryVariantView[] = (manifest.variants ?? []).map((variant) => ({
    id: String(variant.id),
    name: String(variant.name ?? variant.id),
    positioning: variant.positioning ?? null,
    videoRef: artifactRefFor(packageDir, variant.video?.path, env),
    videoPath: variant.video?.path ?? null,
    softsubRef: artifactRefFor(packageDir, variant.softsub?.path, env),
    burnedRef: artifactRefFor(packageDir, variant.burned?.path, env),
    coverRef: artifactRefFor(packageDir, variant.cover?.path, env),
    coverText: variant.cover?.text ?? null,
    duration: variant.video?.duration ?? null,
    style: variant.style ?? null,
    copy: {
      title: variant.copy?.title ?? null,
      hashtags: Array.isArray(variant.copy?.hashtags) ? variant.copy.hashtags : [],
      checks: (variant.copy?.checks ?? []).map((check: { kind?: string; ok?: boolean }) => ({ kind: String(check.kind ?? ""), ok: check.ok !== false })),
    },
    audio: variant.audio
      ? {
        trackId: variant.audio.trackId ?? null,
        trackTitle: variant.audio.trackTitle ?? null,
        lufs: variant.audio.loudness?.after?.integratedLufs ?? null,
        autoTrimDb: variant.audio.mixing?.autoTrimDb ?? null,
        failed: variant.audio.failed === true,
        message: variant.audio.message ?? null,
      }
      : null,
    isSelected: selectedId === variant.id,
  }));
  const subtitleFiles = (manifest.subtitles?.files ?? []).map((file) => ({
    path: String(file.path ?? ""),
    lang: String(file.lang ?? ""),
    format: String(file.format ?? ""),
    sha256: file.sha256 ?? null,
    ref: artifactRefFor(packageDir, file.path, env),
  }));
  const revisions = readRevisions(packageDir);
  return {
    ...base,
    resolution: Array.isArray(manifest.resolution) ? manifest.resolution : null,
    fps: typeof manifest.fps === "number" ? manifest.fps : null,
    master: {
      path: manifest.master?.path ?? null,
      ref: artifactRefFor(packageDir, manifest.master?.path, env),
      duration: manifest.master?.duration ?? null,
      sha256: manifest.master?.sha256 ?? null,
      subtitles: manifest.master?.subtitles ?? null,
    },
    subtitleFiles,
    variants,
    divergence: (manifest.divergence ?? []).map((row) => ({
      a: String(row.a ?? ""),
      b: String(row.b ?? ""),
      meanAbsDiff: row.visual?.meanAbsDiff ?? null,
      verdict: row.visual?.verdict ?? null,
      audioDiffers: row.audio?.differs === true,
    })),
    coverDivergence: (manifest.coverDivergence ?? []).map((row) => ({
      a: String(row.a ?? ""),
      b: String(row.b ?? ""),
      meanAbsDiff: row.meanAbsDiff ?? null,
      verdict: row.verdict ?? null,
    })),
    checks: (manifest.checks ?? []).map((check) => ({
      kind: String(check.kind ?? ""),
      ok: check.ok !== false,
      detail: check.detail ?? null,
    })),
    cost: manifest.cost ?? null,
    selection: selections.at(-1) ?? null,
    selections,
    revisions,
    latestRevisionWarnings: readLatestRevisionWarnings(packageDir, revisions),
    projectPath: manifest.filmProject ? join(packageDir, manifest.filmProject) : null,
  };
}

/* ============================ 分诊 / 选择 / 返修单 ============================ */

interface PostBridgeCore {
  triageFeedback(input: { feedback: string; project: unknown }): Record<string, unknown>;
  analyzeImpact(input: { project: unknown; patch: Record<string, unknown> }): Record<string, unknown>;
}

export const postBridgeCorePath = (): string => {
  const override = (process.env.WORKLOOM_POST_BRIDGE_CORE ?? "").trim();
  return override || join(REPO_ROOT, "bundles/ai-video/connectors/post-bridge/core.mjs");
};

export const postBridgeCliPath = (): string => {
  const override = (process.env.WORKLOOM_POST_BRIDGE_CLI ?? "").trim();
  return override || join(REPO_ROOT, "bundles/ai-video/connectors/post-bridge/cli.mjs");
};

/**
 * 加载后期工位内核（进程内 import **同一份代码**，避免"界面一套规则、工位另一套规则"）。
 * 未随部署携带 bundles 的托管形态下会失败——**明确报错**，不退回"猜一套规则"。
 */
async function loadBridgeCore(): Promise<PostBridgeCore> {
  const file = postBridgeCorePath();
  if (!existsSync(file)) {
    throw new DeliveryError(`后期工位内核不存在：${file}（可用 WORKLOOM_POST_BRIDGE_CORE 指向部署副本）`, "not_configured");
  }
  return await import(pathToFileURL(file).href) as unknown as PostBridgeCore;
}

function readFilmProject(packageDir: string): unknown {
  const project = readJson<Record<string, unknown>>(join(packageDir, "film-project.json"));
  if (!project) throw new DeliveryError("交付包缺 film-project.json（工程文件是返修的输入）", "not_found");
  return project;
}

/**
 * 返修的**基线工程文件**：有历史版本时用最新一轮（`versions/v3/film-project.json`），否则用根工程文件。
 *
 * 为什么必须这样：每轮返修的工程文件里记录的产物路径都相对自己所在目录；若永远拿根工程文件当基线，
 * 第二轮返修会把 v2 的成片、v2 的字幕再次覆盖到 `versions/v2`（真机验证时撞到过：连续两次返修都写进 v2），
 * 版本链就断了。以最新版本为基线，才能得到 v3、v4 的连续链。
 */
export function latestFilmProjectPath(packageDir: string): string {
  const rootProject = join(packageDir, "film-project.json");
  const versionsDir = join(packageDir, "versions");
  if (!existsSync(versionsDir)) return rootProject;
  const candidates = readdirSync(versionsDir)
    .filter((name) => /^v\d+$/.test(name))
    .map((name) => ({
      version: Number(name.slice(1)),
      path: join(versionsDir, name, "film-project.json"),
    }))
    .filter((entry) => existsSync(entry.path))
    .sort((a, b) => b.version - a.version);
  return candidates[0]?.path ?? rootProject;
}

/** 反馈分诊（确定性规则表）：只读，不改任何文件；返回归因/受影响层/是否需重生成镜头/成本口径。 */
export async function triageDeliveryFeedback(
  dir: string,
  feedback: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<{ triage: Record<string, unknown>; patchHint: Record<string, unknown>; packageDir: string }> {
  const packageDir = resolvePackageDir(dir, env);
  const core = await loadBridgeCore();
  const project = readFilmProject(packageDir);
  const triage = core.triageFeedback({ feedback: String(feedback ?? "").trim(), project });
  return {
    triage,
    patchHint: (triage.patchHint as Record<string, unknown>) ?? {},
    packageDir,
  };
}

/** 选择变体：落 `selection.json`（最新）+ 追加 `selections.jsonl`（历史），返回选择记录。 */
export function selectDeliveryVariant({
  dir, variantId, note = null, by = null, env = process.env,
}: {
  dir: string; variantId: string; note?: string | null; by?: string | null; env?: NodeJS.ProcessEnv;
}): DeliverySelection & {
  selectionCount: number;
  projectId: string;
  variant: { id: string; name: string; positioning: string | null; style: ManifestVariant["style"] | null } | null;
} {
  const packageDir = resolvePackageDir(dir, env);
  const manifest = readJson<DeliveryManifest>(join(packageDir, "delivery-manifest.json"));
  const matched = (manifest?.variants ?? []).find((variant) => variant.id === variantId);
  if (!matched) {
    throw new DeliveryError(
      `交付包里没有变体「${variantId}」`
      + `（可用：${(manifest?.variants ?? []).map((variant) => variant.id).join("、") || "无"}）`,
      "not_found",
    );
  }
  const selection: DeliverySelection = {
    variantId,
    note: note ? String(note).slice(0, 500) : null,
    by: by ? String(by) : null,
    at: new Date().toISOString(),
  };
  writeFileSync(join(packageDir, "selection.json"), `${JSON.stringify(selection, null, 2)}\n`, "utf8");
  appendFileSync(join(packageDir, "selections.jsonl"), `${JSON.stringify(selection)}\n`, "utf8");
  /**
   * 一并返回"这一版被选过几次"：选择结果回流组织偏好池时用它推导 confidence，
   * 让"同一风格被反复选中"表现为置信度单调上调，而不是每次都写同一个 0.5。
   */
  const selectionCount = readSelections(packageDir).filter((row) => row.variantId === variantId).length;
  return {
    ...selection,
    selectionCount,
    projectId: String(manifest?.projectId ?? ""),
    variant: {
      id: matched.id,
      name: String(matched.name ?? matched.id),
      positioning: matched.positioning ?? null,
      style: matched.style ?? null,
    },
  };
}

/* ============== 选择结果 → 组织偏好池（evolve 偏好写入侧） ============== */

/**
 * 把"用户在交付包里选了哪个风格版本"翻译成**组织偏好记忆**。
 *
 * 为什么写在行业层：偏好措辞是视频语义（调色 / 配乐 / 转场 / 文案口吻），基座 `evolve`
 * 只提供通用的偏好检索与注入；行业措辞留在行业包，避免底座行业零残留（不变量 D18）。
 *
 * 闭环（不需要重训任何模型）：
 *   选择 → 本函数产出偏好内容 → `upsertMemoryInTx` 落 `org_memory(kind='preference', scope='workspace')`
 *   → `packages/runtime/src/loop.ts` / `ask.ts` 执行前注入（`loadActivePreferences` +
 *   `buildPreferenceBlock`）→ 下一轮出片的提案与变体默认值自动贴合这口味。
 */
export function buildVariantPreferenceContent(input: {
  projectId: string;
  variantId: string;
  variantName?: string | null;
  positioning?: string | null;
  style?: {
    color?: { profile?: string | null; lut?: string | null; intensity?: number | null } | null;
    bgm?: { mood?: string | null; style?: string | null; policy?: string | null } | null;
    transitions?: { mode?: string; fadeSec?: number } | null;
    copyTone?: string | null;
  } | null;
  note?: string | null;
}): string {
  const style = input.style ?? {};
  /**
   * 注意：**不要用 `profile@强度` 这种写法**——workdata 的 PII 脱敏会把 `warm-film@0.75`
   * 误判成邮箱并替换为 `[PII:EMAIL:…]`（真机实测：偏好内容里的调色信息整段丢失）。
   * 改用「（强度 0.75）」，既避开邮箱形态，也保持可读。
   */
  const color = style.color
    ? `${style.color.profile ?? style.color.lut ?? "有色"}`
      + `${style.color.intensity === null || style.color.intensity === undefined ? "" : `（强度 ${style.color.intensity}）`}`
    : "不调色";
  const bgm = style.bgm
    ? `${style.bgm.mood ?? style.bgm.style ?? "已配乐"}${style.bgm.policy ? `（${style.bgm.policy}）` : ""}`
    : "原声";
  const transitions = style.transitions?.mode
    ? `${style.transitions.mode}${style.transitions.fadeSec ? ` ${style.transitions.fadeSec}s` : ""}`
    : "默认";
  return [
    `【交付口味】${input.projectId} 的交付包中，用户选择了「${input.variantName ?? input.variantId}」（${input.variantId}）`,
    input.positioning ? `定位：${input.positioning}` : null,
    `风格：调色 ${color} · 配乐 ${bgm} · 转场 ${transitions} · 文案口吻 ${style.copyTone ?? "默认"}`,
    input.note ? `用户补充：${String(input.note).slice(0, 200)}` : null,
    "后续同类题材出片时，把该风格作为变体集合的首选与默认（除非用户明确要求换风格）。",
  ].filter(Boolean).join("｜");
}

/** 偏好记忆 id：按（工作区 × 变体）稳定——反复选同一风格是**更新同一条记忆**，不堆新行。 */
export function deliveryPreferenceMemoryId(workspaceId: string, variantId: string): string {
  const safe = (value: string) => value.replace(/[^A-Za-z0-9_-]/g, "-").slice(0, 60);
  return `mem-pref-delivery-${safe(workspaceId)}-${safe(variantId)}`;
}

/** 选择次数 → 偏好置信度（0.5 起、每次 +0.05、上限 0.9：留出人审上调空间，不自动封顶）。 */
export function deliveryPreferenceConfidence(selectionCount: number): number {
  const count = Number.isFinite(selectionCount) ? Math.max(1, Math.floor(selectionCount)) : 1;
  return Math.min(0.9, Math.round((0.5 + 0.05 * (count - 1)) * 100) / 100);
}

/** 落返修单（用户意见 + 分诊 + patch 提示）：工位/CLI 与人审都从这份单据接手。 */
export function recordRevisionRequest({
  dir, feedback, triage, patchHint = null, by = null, env = process.env,
}: {
  dir: string; feedback: string; triage: Record<string, unknown>;
  patchHint?: Record<string, unknown> | null; by?: string | null; env?: NodeJS.ProcessEnv;
}): { requestPath: string; request: Record<string, unknown> } {
  const packageDir = resolvePackageDir(dir, env);
  const requestDir = join(packageDir, "revision-requests");
  mkdirSync(requestDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const request = {
    schemaVersion: "workloom.delivery-revision-request/v1",
    at: new Date().toISOString(),
    by: by ? String(by) : null,
    feedback: String(feedback ?? "").slice(0, 4000),
    triage,
    patchHint,
  };
  const requestPath = join(requestDir, `${stamp}.json`);
  writeFileSync(requestPath, `${JSON.stringify(request, null, 2)}\n`, "utf8");
  return { requestPath, request };
}

/* ============================ 本地重合成作业 ============================ */

export interface RevisionJob {
  jobId: string;
  dir: string;
  status: "running" | "done" | "failed";
  startedAt: string;
  finishedAt: string | null;
  exitCode: number | null;
  impact: Record<string, unknown> | null;
  patch: Record<string, unknown>;
  logPath: string;
  logTail: string[];
  version: number | null;
  outDir: string | null;
}

const jobs = new Map<string, RevisionJob>();

/**
 * 占位符检测：分诊给出的 `patchHint` 是**模板**（形如 `<新字幕文本或路径>`），不是可执行指令。
 * 直接拿模板去跑等于"让系统自己猜"，必须拦下——要求调用方填入真实内容（G-DLV4 的"不猜"纪律）。
 */
function findPlaceholder(value: unknown, path = "patch"): string | null {
  if (typeof value === "string") {
    return /<[^<>]{2,}>/.test(value) ? path : null;
  }
  if (Array.isArray(value)) {
    for (const [index, item] of value.entries()) {
      const hit = findPlaceholder(item, `${path}[${index}]`);
      if (hit) return hit;
    }
    return null;
  }
  if (value && typeof value === "object") {
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      const hit = findPlaceholder(item, `${path}.${key}`);
      if (hit) return hit;
    }
  }
  return null;
}

export function deliveryJobStatus(jobId: string): RevisionJob | null {
  return jobs.get(jobId) ?? null;
}

export function listDeliveryJobs(dir?: string): RevisionJob[] {
  const rows = [...jobs.values()];
  return (dir ? rows.filter((job) => job.dir === dir) : rows)
    .sort((a, b) => b.startedAt.localeCompare(a.startedAt));
}

/**
 * 启动本地层增量重合成（spawn 工位 CLI，立刻返回 jobId）。
 *
 * 为什么不在请求里等：一次重合成要跑 ffmpeg（秒级到分钟级），HTTP 长事务会把 UI 与网关一起拖住；
 * 这里改为"作业 + 轮询"，并把 stdout/stderr 落到 `revision-jobs/<jobId>.log`（事后可审计）。
 * **不在本接口里重生成镜头**：patch 命中画面内容时直接拒绝（先去过 G8 人审 + 只重跑点名镜头）。
 */
export async function startDeliveryRevision({
  dir, patch, by = null, env = process.env,
}: {
  dir: string; patch: Record<string, unknown>; by?: string | null; env?: NodeJS.ProcessEnv;
}): Promise<RevisionJob> {
  const packageDir = resolvePackageDir(dir, env);
  const projectPath = latestFilmProjectPath(packageDir);
  if (!existsSync(projectPath)) throw new DeliveryError("交付包缺 film-project.json（返修入口）", "not_found");
  const running = [...jobs.values()].find((job) => job.dir === dir && job.status === "running");
  if (running) {
    throw new DeliveryError(`该交付包已有重合成作业在执行中（${running.jobId}）：等它结束再提交`, "idempotency_conflict");
  }
  if (!patch || Object.keys(patch).length === 0) {
    throw new DeliveryError(
      "patch 为空：返修必须至少给一条具体修改（字幕文本 / 曲目 / 调色配方 / 封面 / 文案 / 转场）",
      "bad_request",
    );
  }
  const placeholder = findPlaceholder(patch);
  if (placeholder) {
    throw new DeliveryError(
      `patch 的 ${placeholder} 还是模板占位符（形如 <...>）：请填入真实内容再执行——系统不替用户猜要改成什么`,
      "bad_request",
    );
  }
  const core = await loadBridgeCore();
  const project = readFilmProject(packageDir);
  // 先做影响分析：未知键 / 不存在的镜头在这里就被拒（不静默忽略用户指令）
  const impact = core.analyzeImpact({ project, patch: patch ?? {} });
  const regeneration = (impact.shotRegeneration ?? {}) as { required?: boolean; shotIds?: string[] };
  if (regeneration.required === true) {
    throw new DeliveryError(
      "该返修点名到画面内容"
      + `（${regeneration.shotIds?.join("、") || "未点名"}）：需要先过 G8 人审并重生成点名镜头，`
      + "再回到本地重合成（本接口不自动烧渲染额度）",
      "shot_regeneration_required",
    );
  }

  const cli = postBridgeCliPath();
  if (!existsSync(cli)) throw new DeliveryError(`后期工位 CLI 不存在：${cli}`, "not_configured");
  const jobId = `rev-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  const jobsDir = join(packageDir, "revision-jobs");
  mkdirSync(jobsDir, { recursive: true });
  const patchPath = join(jobsDir, `${jobId}.patch.json`);
  const logPath = join(jobsDir, `${jobId}.log`);
  /**
   * patch 文件必须是**纯 patch**（工位 CLI 的 `--patch` 直接按 patch 的顶层键解析）：
   * 早期版本写成 `{ by, patch }` 会让工位报"未知键 by/patch"——真机 UI 验证第一轮就撞上了。
   * 提交人信息记在作业日志与事件账本里，不混进指令本身。
   */
  writeFileSync(patchPath, `${JSON.stringify(patch, null, 2)}\n`, "utf8");
  writeFileSync(
    logPath,
    `[${new Date().toISOString()}] 重合成开始 by=${by ?? "unknown"} patch=${JSON.stringify(patch)}\n`,
    "utf8",
  );

  const job: RevisionJob = {
    jobId,
    dir,
    status: "running",
    startedAt: new Date().toISOString(),
    finishedAt: null,
    exitCode: null,
    impact,
    patch,
    logPath,
    logTail: [],
    version: null,
    outDir: null,
  };
  jobs.set(jobId, job);

  /**
   * `--delivery-dir` 必须显式传交付包根：连续返修的基线是 `versions/vN/film-project.json`，
   * 新版本目录与缓存要落到**包根**（`versions/vN+1`、`work/`），否则会出现 `versions/v2/versions/v3` 嵌套。
   */
  const child = spawn(
    process.execPath,
    [cli, "reedit", "--project", projectPath, "--patch", patchPath, "--delivery-dir", packageDir],
    {
    cwd: REPO_ROOT,
    env: { ...process.env, ...env },
    stdio: ["ignore", "pipe", "pipe"],
    },
  );
  const onChunk = (chunk: Buffer) => {
    const text = chunk.toString("utf8");
    appendFileSync(logPath, text, "utf8");
    for (const line of text.split("\n")) {
      if (!line.trim()) continue;
      job.logTail.push(line.trim());
      if (job.logTail.length > 60) job.logTail.shift();
      const versionMatch = /返修完成：v(\d+) → (.+)$/.exec(line.trim());
      if (versionMatch) {
        job.version = Number(versionMatch[1]);
        job.outDir = versionMatch[2]?.trim() ?? null;
        /**
         * 以**工位打印的完成标记**为权威完成信号，不等进程退出事件。
         * 原因（2026-09-24 真机）：Node 24 在"跑完立刻退出"时可能卡在 V8 worker 线程 join，
         * 进程不退出但产物已经全部写好——若只认 `close` 事件，界面会永远停在"执行中"。
         * 标记 + 退出事件双通道：先到者生效（退出事件仍会把非 0 退出码判为失败）。
         */
        if (job.status === "running") {
          job.status = "done";
          job.finishedAt = new Date().toISOString();
          /**
           * 完成标记到了但进程还没退（Node 关停阶段的 join 卡顿）：给 15 秒宽限，
           * 仍不退就 Kill——产物已经齐了，不能让一个僵尸进程占住"同包只能一个作业"的闸。
           */
          const guard = setTimeout(() => {
            if (child.exitCode === null && !child.killed) {
              appendFileSync(logPath, `[${new Date().toISOString()}] 完成标记已到但进程未退出 → 结束进程（产物已落盘）\n`, "utf8");
              child.kill("SIGTERM");
            }
          }, 15_000);
          guard.unref();
        }
      }
    }
  };
  child.stdout?.on("data", onChunk);
  child.stderr?.on("data", onChunk);
  child.on("error", (error) => {
    job.status = "failed";
    job.finishedAt = new Date().toISOString();
    job.exitCode = -1;
    appendFileSync(logPath, `\n[launch-error] ${error.message}\n`, "utf8");
    job.logTail.push(`启动失败：${error.message}`);
  });
  child.on("close", (code) => {
    // 退出码为准：非 0 即使中途打印过完成标记也要如实报失败
    job.status = code === 0 ? "done" : "failed";
    job.finishedAt = job.finishedAt ?? new Date().toISOString();
    job.exitCode = code ?? -1;
    appendFileSync(logPath, `\n[${job.finishedAt}] 退出码 ${code}\n`, "utf8");
  });
  return job;
}
