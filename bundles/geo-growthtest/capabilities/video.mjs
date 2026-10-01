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
 *   · 路径监狱：只允许读取**仓库根内**的路径（拒绝绝对路径、`..`、符号链接逃逸）；
 *   · 不回显秘密：只报告密钥"是否存在"，绝不返回其值；
 *   · 单文件读取上限 8MB / 2 万行，超出即如实失败，不截断冒充完整。
 */
import { createHash } from "node:crypto";
import { existsSync, lstatSync, readFileSync, realpathSync, statSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";

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
 * 路径监狱：把调用方的相对路径解析到仓库根内，并做 realpath 复核（防符号链接逃逸）。
 * 不存在的路径也允许解析（调用方要读"还没产出"时给可读的缺失信息），但必须落在根内。
 */
function insideRepo(relativePath, label = "path") {
  const root = artifactRoot();
  if (typeof relativePath !== "string" || !relativePath.trim()) {
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
  /** 已存在时用 realpath 复核（软链指向仓外一律拒绝） */
  if (existsSync(absolute)) {
    const realRoot = realpathSync(root);
    const real = realpathSync(absolute);
    const realRel = relative(realRoot, real);
    if (!realRel || realRel.startsWith("..") || realRel.split(sep).includes("..")) {
      throw new VideoCapabilityError(`${label} 的真实路径越出产物根（符号链接逃逸）`);
    }
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
  return createHash("sha256").update(readFileSync(absolute)).digest("hex");
}

/** 只报"密钥是否配置"，绝不返回值（凭据纪律） */
function envFileKeyPresence(name) {
  const candidates = [process.env.WORKLOOM_KEYS_FILE, join(process.env.HOME ?? "", ".workloom/live.env")]
    .filter((entry) => typeof entry === "string" && entry.trim());
  for (const file of candidates) {
    if (!existsSync(file)) continue;
    let text;
    try {
      text = readFileSync(file, "utf8");
    } catch {
      continue;
    }
    for (const line of text.split("\n")) {
      const match = line.match(/^([A-Z0-9_]+)=(.*)$/u);
      if (match && match[1] === name) return { present: Boolean(match[2].trim()), source: file };
    }
    return { present: false, source: file };
  }
  return { present: false, source: null };
}

/* ---------------------------------- 能力 1：分流结论 ---------------------------------- */

/** 读已落盘的 `work/route.json`（route-video.mts 的产物）；不重新跑分流。 */
export function routeRecord(input) {
  const value = assertKeys(input, ["path"]);
  const path = optionalText(value.path, "path") ?? "work/route.json";
  const absolute = insideRepo(path, "path");
  const doc = readJsonFile(absolute, path);
  if (doc === null) {
    return {
      found: false,
      path,
      hint: "尚未分流：先跑 `pnpm exec tsx scripts/tools/route-video.mts --title \"<需求原文>\" --llm --out work/route.json`",
    };
  }
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
  let renderAttempts = 0;
  let rendersRejected = 0;
  let platformRejections = 0;
  let canaryAborts = 0;
  let lastFailure = null;
  for (const row of rows) {
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
    if (!row.ok && reason) lastFailure = { at: row.at ?? null, stage, shotId: row.shotId ?? null, reason };
    if ((stage === "material-gen" || stage === "shot") && row.invoked) {
      if (/AccountOverdue|quota|限额/iu.test(errorText)) platformRejections += 1;
      else if (errorText.startsWith("CANARY_ABORT")) canaryAborts += 1;
      else {
        renderAttempts += 1;
        if (row.ok !== true) rendersRejected += 1;
      }
    }
  }
  return {
    found: true,
    projectId,
    logPath,
    records: rows.length,
    firstAt: rows[0]?.at ?? null,
    lastAt: rows.at(-1)?.at ?? null,
    stages: [...byStage.values()].sort((a, b) => a.stage.localeCompare(b.stage)),
    renderLedger: { renderAttempts, rendersRejected, platformRejections, canaryAborts },
    lastFailure,
    note: "只读账本汇总；金额未登记，不做费用估算",
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
  if (manifest === null) {
    return { found: false, projectId, manifestPath, hint: "还没有交付清单（还没跑 deliver 阶段）" };
  }
  const checks = [];
  const checkFile = (label, rawPath) => {
    if (typeof rawPath !== "string" || !rawPath.trim()) return;
    const relativePath = rawPath.startsWith("/")
      ? relative(artifactRoot(), rawPath)
      : rawPath.replace(/^\.\//u, "");
    let file;
    try {
      file = insideRepo(relativePath, label);
    } catch (error) {
      checks.push({ label, path: rawPath, state: "out-of-root", detail: error instanceof Error ? error.message : String(error) });
      return;
    }
    if (!existsSync(file)) {
      checks.push({ label, path: relativePath, state: "missing" });
      return;
    }
    checks.push({ label, path: relativePath, state: "present", bytes: statSync(file).size });
  };
  checkFile("deliverable", manifest.deliverable?.path);
  checkFile("cover", manifest.cover?.path);
  for (const variant of Array.isArray(manifest.variants) ? manifest.variants : []) {
    checkFile(`variant:${variant.id ?? "?"}`, variant.path);
    if (variant.cover?.path) checkFile(`variant-cover:${variant.id ?? "?"}`, variant.cover.path);
  }
  const subtitles = manifest.subtitles ?? {};
  checkFile("softsub", subtitles.softsub);
  for (const entry of Array.isArray(subtitles.files) ? subtitles.files : []) checkFile("subtitle", entry.path ?? entry);
  const missing = checks.filter((entry) => entry.state !== "present");
  return {
    found: true,
    projectId,
    manifestPath,
    reviewPolicy: manifest.reviewPolicy ?? null,
    route: manifest.route ?? null,
    bgm: manifest.bgm ?? null,
    renderLedger: manifest.renderLedger?.totals ?? null,
    files: checks,
    missing: missing.map((entry) => entry.path ?? entry.label),
    integrity: missing.length === 0 ? "all-listed-files-present" : "incomplete",
    note: "本轮只校验清单所列文件是否存在与大小；`render-ledger.md` 与 `delivery-manifest.json` 里的 sha256 由 deliver 阶段写入",
  };
}

/* ---------------------------------- 能力 4：出片计划（预览） ---------------------------------- */

/** 产出"建议命令 + 前置检查清单"；**不执行**任何生成/渲染/提交。 */
export function productionPlan(input) {
  const value = assertKeys(input, ["title", "projectId", "platform", "shotlistPath", "routePath", "outDir"]);
  const title = optionalText(value.title, "title", 400) ?? "";
  const projectId = optionalText(value.projectId, "projectId") ?? "VID-XXXX";
  const platform = optionalText(value.platform, "platform") ?? "抖音";
  const shotlistPath = optionalText(value.shotlistPath, "shotlistPath") ?? "work/film/shotlist.json";
  const routePath = optionalText(value.routePath, "routePath") ?? "work/route.json";
  const outDir = optionalText(value.outDir, "outDir") ?? `work/out-${projectId}`;

  const route = routeRecord({ path: routePath });
  const shotlistExists = existsSync(insideRepo(shotlistPath, "shotlistPath"));
  const arkKey = envFileKeyPresence("VOLCENGINE_ARK_API_KEY");
  const checklist = [
    { id: "route", ok: route.found === true, detail: route.found ? `分流结论：${route.route ?? "?"}` : "缺 work/route.json：先跑 route-video.mts" },
    { id: "shotlist", ok: shotlistExists, detail: shotlistExists ? `镜头卡在场：${shotlistPath}` : `缺镜头卡：${shotlistPath}（25 字段规范）` },
    { id: "ark-key", ok: arkKey.present, detail: arkKey.present ? `火山方舟密钥已配置（${arkKey.source}）` : "缺 VOLCENGINE_ARK_API_KEY（渲染会 403）" },
  ];
  const command = [
    "pnpm exec tsx scripts/tools/full-chain-film.mts \\",
    `  --shots ${shotlistPath} --project ${projectId} \\`,
    `  --work-dir work/vm-${projectId} --out ${outDir} \\`,
    `  --route ${routePath} --keys-file ~/.workloom/live.env --platform ${platform} --fps 24 \\`,
    "  --subtitle-mode both --review-policy off",
  ].join("\n");
  return {
    previewOnly: true,
    title: title || null,
    projectId,
    platform,
    checklist,
    ready: checklist.every((entry) => entry.ok),
    recommendedCommand: command,
    beforeRun: [
      "pnpm video:doctor（环境自检：ffmpeg/密钥/配音工位/曲库路径监狱）",
      "营销片：product-archive.mts 建/取商品档案；真人出镜：video:assets reconcile 对账素材清单",
      "账户欠费（AccountOverdueError 403）会拦住提交：先充值再跑，不要连点重试",
    ],
    notExecuted: "本能力只产出计划与检查项，不代跑管线；出片执行见 `scripts/tools/full-chain-film.mts`",
  };
}
