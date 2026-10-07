/**
 * geo-growth 行业能力 · 视频链路（T-2026-1001-0008）
 *
 * 这组函数是**只读/预览**能力，供桌面 Agent（Codex、DeepSeek Harness 等）通过
 * `scripts/workloom-agent.mjs` 或 `scripts/workloom-agent-mcp.mjs` 调用：
 *   - routeRecord      读已落盘的分流结论（work/route.json）
 *   - productionStatus 读逐阶段账本（logs/<project>/stages.jsonl）→ 汇总与失败项
 *   - deliveryInspect  读交付清单并逐个校验 sha256（交付物完整性）
 *   - productionPlan   产出"建议命令 + 前置检查清单"，**不执行任何生成**
 *
 * 边界（与 `scripts/AGENT-CAPABILITIES.md` 同源）：
 *   · 本地能力**不许写**：只读文件、只返回结构化结果；真正的生成/渲染/交付执行仍在 CLI
 *     （`scripts/tools/route-video.mts` → `scripts/tools/full-chain-film.mts`）；
 *   · 路径监狱：只允许读取**运行者配置的产物根内**的路径（请求拒绝绝对路径、`..`、符号链接逃逸）；
 *   · 不回显秘密：只报告密钥"是否存在"，绝不返回其值；
 *   · JSON/JSONL 读取上限 8MB / 2 万行；媒体哈希按 512KiB 分块完整计算。
 */
import { createHash } from "node:crypto";
import { closeSync, existsSync, lstatSync, openSync, readFileSync, readSync, realpathSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { assertFilmAudioPreflight } from "../../../scripts/tools/film-audio-policy.mjs";
import { buildFilmRenderLedger } from "../../../scripts/tools/film-render-ledger.mjs";
import { filmCompletionPolicyForDocument, describeFilmCompletion } from "../../../packages/video-studio/src/film-completion.mjs";

const MAX_FILE_BYTES = 8 * 1024 * 1024;
const MAX_LINES = 20_000;

export class VideoCapabilityError extends Error {
  constructor(message, code = "BAD_REQUEST") {
    super(message);
    this.name = "VideoCapabilityError";
    this.code = code;
  }
}

/** 仓库根：本模块位于 <root>/bundles/<bundle>/capabilities/，向上三级 */
export function repoRoot() {
  return resolve(import.meta.dirname, "..", "..", "..");
}

/**
 * 产物根（路径监狱的边界）：
 *   · 默认 = 仓库根（runbook 的 `work/...` 全部在仓内）；
 *   · 客户/Agent 把工作目录放在仓外时，用 `WORKLOOM_VIDEO_ARTIFACT_ROOT` **由运行者**显式指定
 *     （调用方仍然只能给相对路径，不能自己塞绝对路径 —— 边界由环境变量而不是请求决定）。
 */
export function artifactRoot() {
  const raw = String(process.env.WORKLOOM_VIDEO_ARTIFACT_ROOT ?? "").trim();
  return raw ? resolve(raw) : repoRoot();
}

function plain(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function assertKeys(input, allowed) {
  const value = input === undefined ? {} : input;
  if (!plain(value)) throw new VideoCapabilityError("输入须为 JSON 对象");
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) throw new VideoCapabilityError(`不支持字段 ${key}`);
  }
  return value;
}

function optionalText(value, key, maxChars = 200) {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !value.trim() || value.length > maxChars) {
    throw new VideoCapabilityError(`${key} 须为 1–${maxChars} 字符的非空字符串`);
  }
  return value.trim();
}

/**
 * 路径监狱：把调用方的相对路径解析到产物根内，并做 realpath 复核（防符号链接逃逸）。
 * 不存在的路径也允许解析（调用方要读"还没产出"时给可读的缺失信息），但必须落在根内。
 */
function insideRepo(relativePath, label = "path") {
  const root = artifactRoot();
  if (typeof relativePath !== "string" || !relativePath.trim() || relativePath.includes("\0")) {
    throw new VideoCapabilityError(`${label} 不能为空`);
  }
  if (relativePath.startsWith("/") || /^[A-Za-z]:[\\/]/u.test(relativePath)) {
    throw new VideoCapabilityError(`${label} 只接受相对路径（如 work/film/shotlist.json）；绝对路径请用 WORKLOOM_VIDEO_ARTIFACT_ROOT 设产物根`);
  }
  const absolute = resolve(root, relativePath);
  const rel = relative(root, absolute);
  if (!rel || rel.startsWith("..") || rel.split(sep).includes("..")) {
    throw new VideoCapabilityError(`${label} 越出产物根（路径监狱）`);
  }
  /** 不存在的文件也检查最近已存在的祖先，防止父目录软链逃逸。 */
  const realRoot = realpathSync(root);
  let ancestor = absolute;
  while (!existsSync(ancestor) && ancestor !== root) ancestor = dirname(ancestor);
  const real = realpathSync(ancestor);
  const realRel = relative(realRoot, real);
  if (realRel.startsWith("..") || realRel.split(sep).includes("..") || (!realRel && ancestor === absolute)) {
    throw new VideoCapabilityError(`${label} 的真实路径越出产物根（符号链接逃逸）`);
  }
  return absolute;
}

function readTextFile(absolute, label) {
  if (!existsSync(absolute)) return null;
  const info = lstatSync(absolute);
  if (!info.isFile() || info.isSymbolicLink()) throw new VideoCapabilityError(`${label} 不是普通文件`);
  if (info.size > MAX_FILE_BYTES) {
    throw new VideoCapabilityError(`${label} 超过 ${MAX_FILE_BYTES} 字节读取上限（${info.size} 字节）`, "TOO_LARGE");
  }
  return readFileSync(absolute, "utf8");
}

function readJsonFile(absolute, label) {
  const text = readTextFile(absolute, label);
  if (text === null) return null;
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new VideoCapabilityError(`${label} 不是合法 JSON：${error instanceof Error ? error.message : String(error)}`);
  }
}

function readJsonLines(absolute, label) {
  const text = readTextFile(absolute, label);
  if (text === null) return null;
  const lines = text.split("\n").filter((line) => line.trim());
  if (lines.length > MAX_LINES) {
    throw new VideoCapabilityError(`${label} 超过 ${MAX_LINES} 行读取上限（${lines.length} 行）`, "TOO_LARGE");
  }
  return lines.map((line, index) => {
    try {
      return JSON.parse(line);
    } catch {
      throw new VideoCapabilityError(`${label}:${index + 1} 不是合法 JSONL 行`);
    }
  });
}

function sha256File(absolute) {
  const hash = createHash("sha256");
  const buffer = Buffer.allocUnsafe(512 * 1024);
  const file = openSync(absolute, "r");
  try {
    let count;
    while ((count = readSync(file, buffer, 0, buffer.length, null)) > 0) hash.update(buffer.subarray(0, count));
    return hash.digest("hex");
  } finally { closeSync(file); }
}

/** 与 CLI 相同的本地配置来源；值只在函数内使用，不进入能力结果。 */
function configuredEnvironment() {
  const keysPath = String(process.env.WORKLOOM_KEYS_FILE ?? "").trim() || join(process.env.HOME ?? "", ".workloom/live.env");
  const keysFile = resolve(repoRoot(), keysPath);
  const env = {}, sources = {};
  for (const file of [keysFile, join(repoRoot(), ".env")]) {
    const bytes = readTextFile(file, "本地配置文件");
    if (bytes === null) continue;
    for (const line of bytes.split("\n")) {
      const match = line.match(/^([A-Z0-9_]+)=(.*)$/u);
      if (match && match[2].trim() && !env[match[1]]) {
        env[match[1]] = match[2].trim(); sources[match[1]] = file;
      }
    }
  }
  for (const [name, value] of Object.entries(process.env)) {
    if (value && !env[name]) { env[name] = value; sources[name] = "process-env"; }
  }
  return { env, sources, keysFile };
}

/* ---------------------------------- 能力 1：分流结论 ---------------------------------- */

/** 读已落盘的 `work/route.json`（route-video.mts 的产物）；不重新跑分流。 */
export function routeRecord(input) {
  const value = assertKeys(input, ["path"]);
  const path = optionalText(value.path, "path") ?? "work/route.json";
  const absolute = insideRepo(path, "path");
  const doc = readJsonFile(absolute, path);
  if (doc === null && !existsSync(absolute)) {
    return {
      found: false,
      path,
      hint: "尚未分流：先跑 `pnpm exec tsx scripts/tools/route-video.mts --title \"<需求原文>\" --llm --out work/route.json`",
    };
  }
  if (!plain(doc)) throw new VideoCapabilityError(`${path} 须为 JSON 对象`);
  const decision = plain(doc.decision) ? doc.decision : {};
  return {
    found: true,
    path,
    schemaVersion: typeof doc.schemaVersion === "string" ? doc.schemaVersion : null,
    title: typeof doc.title === "string" ? doc.title : null,
    route: typeof decision.route === "string" ? decision.route : null,
    confidence: typeof decision.confidence === "number" ? decision.confidence : null,
    via: typeof decision.via === "string" ? decision.via : null,
    productAnchor: plain(decision.product) && typeof decision.product.name === "string" ? decision.product.name : null,
    clarifyQuestion: plain(decision.clarify) && typeof decision.clarify.question === "string" ? decision.clarify.question : null,
    note: "分流结论是出片入口的硬前置：`full-chain-film.mts` 需要 --route 或 --route-kind",
  };
}

/* ---------------------------------- 能力 2：生产状态 ---------------------------------- */

/** 读逐阶段账本 `logs/<project>/stages.jsonl`，汇总阶段成败与"花钱的账"。 */
export function productionStatus(input) {
  const value = assertKeys(input, ["projectId", "workDir"]);
  const projectId = optionalText(value.projectId, "projectId") ?? "VID-FF02-FULL";
  const workDir = optionalText(value.workDir, "workDir") ?? "work";
  const logPath = `${workDir.replace(/\/+$/u, "")}/logs/${projectId}/stages.jsonl`;
  const absolute = insideRepo(logPath, "workDir/projectId");
  const rows = readJsonLines(absolute, logPath);
  if (rows === null) {
    return { found: false, projectId, logPath, hint: "该项目还没有阶段账本（还没跑过管线）" };
  }
  const byStage = new Map();
  let lastFailure = null;
  for (const row of rows) {
    if (!plain(row)) throw new VideoCapabilityError(`${logPath} 含非对象阶段记录`);
    const stage = String(row.stage ?? "(unknown)");
    const entry = byStage.get(stage) ?? { stage, invoked: 0, ok: 0, failed: 0, degraded: 0, cached: 0 };
    if (row.invoked) entry.invoked += 1;
    if (row.ok === true) entry.ok += 1;
    else if (row.ok === false) entry.failed += 1;
    if (row.degraded === true) entry.degraded += 1;
    if (row.cached === true) entry.cached += 1;
    byStage.set(stage, entry);
    const errorText = String(row.evidence?.error ?? "");
    const reason = String(row.verdict?.hardFailures?.[0] ?? row.verdict?.reason ?? row.note ?? errorText ?? "").slice(0, 200);
    if (row.ok === false && reason) lastFailure = { at: row.at ?? null, stage, shotId: row.shotId ?? null, reason };
  }
  const ledger = buildFilmRenderLedger(rows, { projectId });
  const { renderAttempts, rendersRejected, platformRejections, canaryAborts } = ledger.totals;
  const renderLedger = { renderAttempts, rendersRejected, platformRejections, canaryAborts };
  return {
    found: true,
    projectId,
    logPath,
    records: rows.length,
    firstAt: rows[0]?.at ?? null,
    lastAt: rows.at(-1)?.at ?? null,
    stages: [...byStage.values()].sort((a, b) => a.stage.localeCompare(b.stage)),
    renderLedger,
    acceptedTaskIds: ledger.acceptedTaskIds,
    unacceptedRenderRecords: ledger.unacceptedRenderRecords,
    ledgerWarnings: ledger.warnings,
    lastFailure,
    note: "有效平台 taskId 按 ID 去重；GET 接续/重复/缓存不新增受理次数。无 taskId 的调用受理未知；不做费用估算。",
  };
}

/* ---------------------------------- 能力 3：交付核验 ---------------------------------- */

/** 读交付清单并逐个校验 sha256（交付物是否被动过 / 是否缺件）。 */
export function deliveryInspect(input) {
  const value = assertKeys(input, ["projectId", "outDir"]);
  const projectId = optionalText(value.projectId, "projectId") ?? "VID-FF02-FULL";
  const outDir = optionalText(value.outDir, "outDir") ?? "work/out";
  const base = outDir.replace(/\/+$/u, "");
  const manifestPath = `${base}/${projectId}-delivery-manifest.json`;
  const absolute = insideRepo(manifestPath, "outDir/projectId");
  const manifest = readJsonFile(absolute, manifestPath);
  if (manifest === null && !existsSync(absolute)) {
    return { found: false, projectId, manifestPath, hint: "还没有交付清单（还没跑 deliver 阶段）" };
  }
  if (!plain(manifest)) throw new VideoCapabilityError(`${manifestPath} 须为 JSON 对象`);
  if (manifest.projectId !== projectId) throw new VideoCapabilityError("交付清单的 projectId 项目标识与请求不一致或缺失");
  const standard = manifest.schemaVersion === "workloom.standard-post-delivery/v1";
  const itemCount = [manifest.entries, manifest.assets, manifest.variants, manifest.outputs, manifest.subtitles?.files]
    .reduce((total, value) => total + (Array.isArray(value) ? value.length : 0), 0);
  if (itemCount > 1000) throw new VideoCapabilityError("交付清单文件数量超过 1000", "TOO_LARGE");
  const assets = new Map(), invalid = [];
  const addFile = (label, rawEntry, required = false) => {
    if (rawEntry === undefined || rawEntry === null) {
      if (required) invalid.push({label, state: "invalid-metadata", verified: false, detail: "清单项缺少路径"});
      return;
    }
    const entry = typeof rawEntry === "string" ? {path: rawEntry} : rawEntry;
    if (!plain(entry) || typeof entry.path !== "string" || !entry.path.trim()) {
      invalid.push({label, state: "invalid-metadata", verified: false, detail: "清单项须含非空路径"}); return;
    }
    const rawPath = entry.path;
    const relativePath = rawPath.startsWith("/") || /^[A-Za-z]:[\\/]/u.test(rawPath)
      ? relative(artifactRoot(), rawPath) : rawPath.replace(/^\.\//u, "");
    let absolute;
    try { absolute = insideRepo(relativePath, label); }
    catch (error) {
      invalid.push({label, path: rawPath, state: "out-of-root", verified: false,
        detail: error instanceof Error ? error.message : String(error)}); return;
    }
    const key = relative(artifactRoot(), absolute);
    const current = assets.get(key) ?? {label, path: key, absolute, expectedSha256: undefined, expectedBytes: undefined, invalidMetadata: false};
    if (entry.sha256 !== undefined) {
      if (typeof entry.sha256 !== "string" || !/^[a-fA-F0-9]{64}$/u.test(entry.sha256)) current.invalidMetadata = true;
      else {
        const sha = entry.sha256.toLowerCase();
        if (current.expectedSha256 && current.expectedSha256 !== sha) current.invalidMetadata = true;
        current.expectedSha256 = sha;
      }
    }
    if (entry.bytes !== undefined) {
      if (!Number.isSafeInteger(entry.bytes) || entry.bytes < 0 || (current.expectedBytes !== undefined && current.expectedBytes !== entry.bytes)) {
        current.invalidMetadata = true;
      } else current.expectedBytes = entry.bytes;
    }
    assets.set(key, current);
  };
  for (const name of ["entries", "assets"]) {
    if (manifest[name] === undefined) continue;
    if (!Array.isArray(manifest[name])) invalid.push({label: name, state: "invalid-metadata", verified: false, detail: "须为文件数组"});
    else for (const [index, entry] of manifest[name].entries()) addFile(entry?.label ?? `${name}:${index}`, entry, true);
  }
  if (standard) {
    if (!Array.isArray(manifest.outputs) || manifest.outputs.length === 0) {
      invalid.push({label: "outputs", state: "invalid-metadata", verified: false, detail: "标准后期清单须含非空 outputs"});
    }
    const ids = new Set();
    for (const [index, output] of (Array.isArray(manifest.outputs) ? manifest.outputs : []).entries()) {
      const id = output?.id;
      if (!plain(output) || !["master", "softsub", "warm-film", "cool-tech", "punchy-social"].includes(id) || ids.has(id)) {
        invalid.push({label: `outputs:${index}`, state: "invalid-metadata", verified: false, detail: "标准版本 ID 无效或重复"});
        continue;
      }
      ids.add(id);
      addFile(`output:${id}`, output, true);
      if (id !== "softsub") {
        const claim = output.coverReceipt?.cover;
        if (!plain(claim) || typeof output.cover !== "string" || claim.path !== output.cover) {
          invalid.push({label: `output-cover:${id}`, state: "invalid-metadata", verified: false, detail: "封面路径与首帧回执声明缺失或冲突"});
        } else addFile(`output-cover:${id}`, claim, true);
      }
    }
    if (!ids.has("master")) invalid.push({label: "outputs:master", state: "invalid-metadata", verified: false, detail: "标准后期缺主版"});
  } else addFile("deliverable", manifest.deliverable, true);
  if (manifest.cover !== undefined) addFile("cover", manifest.cover, true);
  if (manifest.variants !== undefined && !Array.isArray(manifest.variants)) invalid.push({label: "variants", state: "invalid-metadata", verified: false, detail: "须为版本数组"});
  for (const variant of Array.isArray(manifest.variants) ? manifest.variants : []) {
    addFile(`variant:${variant?.id ?? "?"}`, variant, true);
    if (variant?.cover !== undefined) addFile(`variant-cover:${variant.id ?? "?"}`, variant.cover, true);
  }
  if (manifest.subtitles !== undefined && !plain(manifest.subtitles)) invalid.push({label: "subtitles", state: "invalid-metadata", verified: false, detail: "须为字幕对象"});
  const subtitles = plain(manifest.subtitles) ? manifest.subtitles : {};
  if (subtitles.softsub) addFile("softsub", plain(subtitles.softsub) ? subtitles.softsub : {path: subtitles.softsub, ...(subtitles.softsubSha256 ? {sha256: subtitles.softsubSha256} : {})});
  if (subtitles.files !== undefined && !Array.isArray(subtitles.files)) invalid.push({label: "subtitles.files", state: "invalid-metadata", verified: false, detail: "须为文件数组"});
  for (const entry of Array.isArray(subtitles.files) ? subtitles.files : []) addFile("subtitle", entry, true);
  const checks = [...assets.values()].map(entry => {
    const {absolute, invalidMetadata, ...check} = entry;
    if (invalidMetadata) return {...check, state: "invalid-metadata", verified: false, detail: "SHA-256/字节数无效或同一路径的声明冲突"};
    try {
      if (!existsSync(absolute)) return {...check, state: "missing", verified: false};
      const info = lstatSync(absolute);
      if (!info.isFile() || info.isSymbolicLink()) return {...check, state: "not-file", verified: false};
      if (info.size === 0) return {...check, state: "empty-file", bytes: 0, verified: false};
      const sha256 = sha256File(absolute);
      if (entry.expectedBytes !== undefined && entry.expectedBytes !== info.size) return {...check, state: "size-mismatch", bytes: info.size, sha256, verified: false};
      if (entry.expectedSha256 && entry.expectedSha256 !== sha256) return {...check, state: "sha256-mismatch", bytes: info.size, sha256, verified: false};
      return {...check, state: "present", bytes: info.size, sha256, verified: Boolean(entry.expectedSha256)};
    } catch {
      return {...check, state: "unreadable", verified: false, detail: "文件读取失败，无法核验 SHA-256"};
    }
  }).concat(invalid);
  const missing = checks.filter(entry => entry.state !== "present");
  const integrity = !checks.length || missing.length ? "incomplete" : checks.every(entry => entry.verified) ? "sha256-verified" : "unverified";
  return {
    found: true,
    projectId,
    manifestPath,
    schemaVersion: manifest.schemaVersion ?? null,
    mode: manifest.mode ?? null,
    reviewPolicy: manifest.reviewPolicy ?? null,
    route: manifest.route ?? null,
    bgm: manifest.bgm ?? null,
    renderLedger: manifest.renderLedger?.totals ?? null,
    files: checks,
    missing: missing.map((entry) => entry.path ?? entry.label),
    integrity,
    note: "逐个读取清单文件并计算实际 SHA-256；与 entries/assets/旧指针的声明合并比较。缺少声明哈希只记 unverified，不提升为核验通过。",
  };
}

/* ---------------------------------- 能力 4：出片计划（预览） ---------------------------------- */

function declaredFps(shotlist) {
  const rates = [];
  const add = (value, label) => {
    if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) throw new VideoCapabilityError(`${label} 的帧率须为有限正数`);
    rates.push(value);
  };
  if (shotlist.fps !== undefined) add(shotlist.fps, "镜头卡");
  for (const shot of shotlist.shots) {
    if (shot.fps !== undefined) add(shot.fps, shot.shotId);
    for (const match of String(shot.constraint ?? "").matchAll(/([-+]?\d+(?:\.\d+)?)\s*fps\b/giu)) add(Number(match[1]), shot.shotId);
  }
  if (!rates.length) throw new VideoCapabilityError("镜头卡未声明帧率：在 fps 或各镜 constraint 中明确写出 fps，避免由入口猜测");
  if (rates.some(rate => Math.abs(rate - rates[0]) > 1e-6)) throw new VideoCapabilityError(`镜头卡的帧率声明冲突：${[...new Set(rates)].join(" / ")}fps`);
  return rates[0];
}

function validShots(doc) {
  if (!plain(doc) || !Array.isArray(doc.shots) || doc.shots.length === 0) throw new VideoCapabilityError("镜头卡须是含非空 shots 数组的对象");
  const ids = new Set();
  for (const shot of doc.shots) {
    if (!plain(shot) || typeof shot.shotId !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(shot.shotId) || shot.shotId.includes("..")) {
      throw new VideoCapabilityError("每镜须含不带路径的有效 shotId");
    }
    if (ids.has(shot.shotId)) throw new VideoCapabilityError(`重复镜头 ID：${shot.shotId}`);
    ids.add(shot.shotId);
    if (!Number.isInteger(shot.duration) || shot.duration < 4 || shot.duration > 12) {
      throw new VideoCapabilityError(`镜头 ${shot.shotId} 的 duration 须为当前生产支持的整数 4–12 秒；不能通过变速凑时长`);
    }
  }
  return doc;
}

function authoredProduct(doc) {
  const from = value => typeof value === "string" ? value.trim()
    : plain(value) ? [value.name, value.id, value.title].find(field => typeof field === "string" && field.trim())?.trim() ?? "" : "";
  const products = Array.isArray(doc?.products) ? doc.products : [];
  return products.map(from).find(Boolean) || (doc?.shots ?? []).map(shot => from(shot.productRef)).find(Boolean) || null;
}

/** POSIX 单引号把每个 argv 元素作为字面参数；结构化 argv 是调用方首选。 */
const quoteShell = value => `'${String(value).replaceAll("'", "'\\''")}'`;
const quotePowerShell = value => `'${String(value).replaceAll("'", "''")}'`;

/** 产出"建议命令 + 前置检查清单"；**不执行**任何生成/渲染/提交。 */
export function productionPlan(input) {
  const value = assertKeys(input, ["title", "projectId", "platform", "shotlistPath", "routePath", "outDir", "workDir", "unifiedNarration"]);
  const title = optionalText(value.title, "title", 400) ?? "";
  const projectId = optionalText(value.projectId, "projectId") ?? "VID-XXXX";
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(projectId) || projectId.includes("..")) throw new VideoCapabilityError("projectId 须是不带路径的项目 ID");
  const platform = optionalText(value.platform, "platform", 60) ?? "抖音";
  const shotlistPath = optionalText(value.shotlistPath, "shotlistPath", 400) ?? "work/film/shotlist.json";
  const routePath = optionalText(value.routePath, "routePath", 400) ?? "work/route.json";
  const outDir = optionalText(value.outDir, "outDir", 400) ?? `work/out-${projectId}`;
  const artifactWorkDir = optionalText(value.workDir, "workDir", 400) ?? `work/vm-${projectId}`;
  if (value.unifiedNarration !== undefined && typeof value.unifiedNarration !== "boolean") throw new VideoCapabilityError("unifiedNarration 须为布尔值");
  const shotlistFile = insideRepo(shotlistPath, "shotlistPath"), routeFile = insideRepo(routePath, "routePath");
  const outputFile = insideRepo(outDir, "outDir"), stageWorkDir = insideRepo(artifactWorkDir, "workDir");
  const checklist = [];
  let shotlist = null, fps = null, audioContracts = [], completion = null;
  try {
    const doc = readJsonFile(shotlistFile, shotlistPath);
    if (doc === null) throw new VideoCapabilityError(`缺镜头卡：${shotlistPath}`);
    shotlist = validShots(doc);
    checklist.push({id: "shotlist", ok: true, detail: `${shotlist.shots.length} 镜的 ID/时长结构有效；完整字段和规范仍由 CLI spec 检查`});
  } catch (error) { checklist.push({id: "shotlist", ok: false, detail: error.message}); }
  try {
    if (!shotlist) throw new VideoCapabilityError("镜头卡无效，无法读取完成度合同");
    completion = describeFilmCompletion(filmCompletionPolicyForDocument(shotlist),shotlist.shots.reduce((sum,shot)=>sum+shot.duration,0));
    checklist.push({id:"completion-policy",ok:true,detail:`完成度优先；目标 ${completion.policy.targetSeconds ?? "未指定"}s，完整分镜 ${completion.actualSeconds}s；仅显式硬上限约束总时长`});
  } catch (error) { checklist.push({id:"completion-policy",ok:false,detail:error.message}); }
  try {
    const route = readJsonFile(routeFile, routePath);
    if (!plain(route) || route.schemaVersion !== "workloom.video-route-record/v1" || !plain(route.decision)) throw new VideoCapabilityError("缺少有效分流记录，请先跑 route-video.mts");
    const kind = route.decision.route;
    if (kind === "clarify") throw new VideoCapabilityError("分流尚待澄清，不能给出执行命令");
    if (kind === "explainer") throw new VideoCapabilityError("口播解说片应使用 explainer:run，不能走 full-chain-film");
    if (!["marketing", "narrative"].includes(kind)) throw new VideoCapabilityError("分流没有可执行的 marketing/narrative 类型");
    if (kind === "marketing" && !authoredProduct(shotlist)) throw new VideoCapabilityError("营销片镜头卡缺商品锚点，不能只依赖分流摘要");
    checklist.push({id: "route", ok: true, detail: `分流：${kind}${kind === "marketing" ? `；商品锚点：${authoredProduct(shotlist)}` : ""}`});
  } catch (error) { checklist.push({id: "route", ok: false, detail: error.message}); }
  try {
    if (!shotlist) throw new VideoCapabilityError("镜头卡无效，无法读取帧率");
    fps = declaredFps(shotlist); checklist.push({id: "fps", ok: true, detail: `镜头卡声明一致：${fps}fps`});
  } catch (error) { checklist.push({id: "fps", ok: false, detail: error.message}); }
  let configuration = null;
  try {
    configuration = configuredEnvironment();
    const keyName = configuration.env.VOLCENGINE_ARK_API_KEY ? "VOLCENGINE_ARK_API_KEY" : "ARK_API_KEY";
    const configured = Boolean(configuration.env[keyName]);
    checklist.push({id: "ark-key", ok: configured, detail: configured ? `渲染密钥已配置（${configuration.sources[keyName]}）` : "缺渲染密钥；仅配置存在不证明余额或模型权限"});
  } catch { checklist.push({id: "ark-key", ok: false, detail: "本地配置文件读取失败，无法判断渲染配置"}); }
  try {
    if (!shotlist || !configuration) throw new VideoCapabilityError("镜头卡或本地配置无效，无法核验音频合同");
    audioContracts = assertFilmAudioPreflight({shots: shotlist.shots, unifiedNarration: value.unifiedNarration === true,
      generateAudio: configuration.env.SEEDANCE_GENERATE_AUDIO !== "0"});
    checklist.push({id: "audio-contract", ok: true, detail: `${audioContracts.length} 镜均保留同文件原声；语义包括出镜对白、画外音或环境声，均不授权后配`});
  } catch (error) { checklist.push({id: "audio-contract", ok: false, detail: error.message}); }
  const ready = checklist.every(entry => entry.ok);
  const argv = ready ? ["exec", "tsx", "scripts/tools/full-chain-film.mts", "--shots", shotlistFile, "--project", projectId,
    "--work-dir", stageWorkDir, "--out", outputFile, "--route", routeFile, "--keys-file", configuration.keysFile,
    "--platform", platform, "--fps", String(fps), "--subtitle-mode", "both", "--review-policy", "off"] : [];
  const executable = "pnpm";
  const command = ready ? [executable, ...argv].map(quoteShell).join(" ") : null;
  return {
    previewOnly: true,
    title: title || null,
    projectId,
    platform,
    fps,
    executable,
    argv,
    workDir: repoRoot(),
    artifactWorkDir: stageWorkDir,
    artifactRoot: artifactRoot(),
    audioSourcePolicy: "render-native",
    completion,
    audioContracts: audioContracts.map(({shotId, mode, sourcePolicy, policyHash}) => ({shotId, mode, sourcePolicy, policyHash})),
    checklist,
    ready,
    readyScope: "authored-input-and-local-configuration",
    recommendedCommand: command,
    recommendedPowerShellCommand: ready ? `& ${[executable, ...argv].map(quotePowerShell).join(" ")}` : null,
    execution: ready ? { command: executable, args: argv, cwd: repoRoot() } : null,
    beforeRun: [
      "pnpm video:doctor（环境自检：ffmpeg/渲染配置/曲库路径监狱；标准后期不依赖配音或 ASR）",
      "营销片：product-archive.mts 建/取商品档案；真人出镜：video:assets reconcile 对账素材清单",
      "账户欠费（AccountOverdueError 403）会拦住提交：先充值再跑，不要连点重试",
    ],
    notExecuted: "只读配置与已声明输入；未请求模型/ASR，未核验授权、身份、余额或完整规范，也未提交渲染。执行时 CLI 必须继续完成实际预检。",
  };
}
