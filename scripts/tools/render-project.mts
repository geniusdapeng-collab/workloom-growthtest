#!/usr/bin/env tsx
/**
 * 服务项目出片：当前预生产档案 → 最终请求资格 → canonical提交 → 轮询入库。
 * 正式生产：--project <id> --model <目录id> [--only S1,S2] [--max-estimated-cny N]
 * 先用 --list-models 查询当前服务目录。WORKLOOM_API/WORKLOOM_TOKEN 提供服务地址与作用域凭据。
 * 本地预览：--dry-run --shots <shots.json> --project <preview-id>；只做文本诊断，不授予生产资格。
 * 真实提交不再把本地文件写入CMS或夹紧服务计划；未知回执不会自动再次提交。
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, extname, isAbsolute, resolve } from "node:path";
import {
  allocateShotDurations,
  allocateReferenceSlots,
  composeShotReferences,
  durationRulesMarkdown,
  durationValidationMarkdown,
  fieldSpec,
  pickCharacterPortrait as pickCharacterPortraitFromIndex,
  loadCharacterLibrary,
  prepareShotPrompt,
  resolveShotCharacters,
  shotSpecMarkdown,
  validateShotDurations,
  type ShotSpecReport
} from "../../packages/video-studio/src/index.js";
import type { PortraitIndexLike as PackagePortraitIndexLike } from "../../packages/video-studio/src/index.js";

import { ProductionClient, renderServiceProject } from "../../packages/video-studio/src/production-client.js";
import { randomUUID } from "node:crypto";

const API = process.env.WORKLOOM_API ?? "http://127.0.0.1:8787";
const TOKEN = process.env.WORKLOOM_TOKEN ?? "";
const REPO_ROOT = resolve(import.meta.dirname ?? process.cwd(), "../..");

function arg(name: string, fallback = ""): string {
  const i = process.argv.indexOf(name);
  return i >= 0 ? (process.argv[i + 1] ?? fallback) : fallback;
}
const flag = (name: string) => process.argv.includes(name);

/* ================= 镜头卡 ================= */

interface ShotCard {
  shotId: string;
  duration?: number;
  prompt?: string;
  scene?: string;
  sceneDescription?: string;
  title?: string;
  subtitle?: string;
  characters?: string[];
  character_ref?: string;
  [key: string]: unknown;
}

function loadShots(file: string): ShotCard[] {
  const raw = JSON.parse(readFileSync(file, "utf8")) as unknown;
  const list = Array.isArray(raw)
    ? raw
    : ((raw as { shots?: ShotCard[] }).shots ?? []);
  const shots = (list as ShotCard[]).filter((s) => s && typeof s === "object" && s.shotId);
  if (shots.length === 0) throw new Error(`镜头卡为空：${file}`);
  return shots;
}

/** 把 PRD 自定节奏等比缩放到目标总时长，并夹紧到模型 limits（4–15s） */
export function allocateDurations(
  shots: Array<{ shotId: string; duration?: number }>,
  totalSeconds: number,
  min = 4,
  max = 15,
): Map<string, number> {
  const raw = shots.map((s) => Math.max(1, Number(s.duration) || min));
  const sum = raw.reduce((a, b) => a + b, 0);
  const scaled = raw.map((d) => Math.min(max, Math.max(min, Math.round((d * totalSeconds) / sum))));
  let drift = totalSeconds - scaled.reduce((a, b) => a + b, 0);
  // 余量优先补给最长镜头（保持节奏形状），不足则从最长镜头回收
  let guard = 0;
  while (drift !== 0 && guard < 200) {
    const order = scaled.map((d, i) => ({ i, d })).sort((a, b) => b.d - a.d);
    let moved = false;
    for (const { i, d } of order) {
      if (drift > 0 && d < max) { scaled[i] = d + 1; drift -= 1; moved = true; }
      else if (drift < 0 && d > min) { scaled[i] = d - 1; drift += 1; moved = true; }
      if (drift === 0) break;
    }
    if (!moved) break;
    guard += 1;
  }
  return new Map(shots.map((s, i) => [s.shotId, scaled[i]!]));
}

/* ================= 参考图 ================= */

const VENUE_KEYWORDS: Array<{ pattern: RegExp; ref: string[] }> = [
  { pattern: /夜|灯|月色|倒影|夜游/, ref: ["ref-01.jpg", "ref-06.jpg"] },
  { pattern: /客房|床|民国|家具|丽夕阁|廊柱|桌椅|室内|书房|大堂/, ref: ["ref-03.jpg"] },
  { pattern: /院落|白墙|灰瓦|明轩|园林|庭院|门楼|十全街/, ref: ["ref-04.jpg", "ref-05.jpg"] },
  { pattern: /亭|水景|榭|湖|池/, ref: ["ref-06.jpg"] },
  { pattern: /人|导游|住客|旗袍|服务/, ref: ["ref-02.jpg"] },
];

export function pickVenueRefs(shot: ShotCard, refs: string[], limit: number): string[] {
  if (refs.length === 0) return [];
  // 镜头卡显式指定的参考图优先（人工校正脚本时最准确）
  const hinted = Array.isArray(shot.referenceHint)
    ? (shot.referenceHint as unknown[])
        .map((name) => refs.find((r) => basename(r) === String(name)))
        .filter((file): file is string => Boolean(file))
    : [];
  const text = `${shot.scene ?? ""} ${shot.sceneDescription ?? ""} ${shot.prompt ?? ""} ${shot.subtitle ?? ""}`;
  const scored = new Map<string, number>();
  for (const { pattern, ref } of VENUE_KEYWORDS) {
    if (!pattern.test(text)) continue;
    ref.forEach((name, idx) => {
      const file = refs.find((r) => basename(r) === name);
      if (file) scored.set(file, (scored.get(file) ?? 0) + (ref.length - idx));
    });
  }
  const ranked = [
    ...hinted,
    ...[...scored.entries()].sort((a, b) => b[1] - a[1]).map(([file]) => file).filter((f) => !hinted.includes(f)),
  ];
  for (const file of refs) {
    if (ranked.length >= limit) break;
    if (!ranked.includes(file)) ranked.push(file);
  }
  return ranked.slice(0, limit);
}

function loadRefFiles(spec: string): string[] {
  if (!spec) return [];
  const parts = spec.includes(",") ? spec.split(",").map((s) => s.trim()) : [spec.trim()];
  const files: string[] = [];
  for (const part of parts) {
    if (!part) continue;
    const abs = isAbsolute(part) ? part : resolve(REPO_ROOT, part);
    if (!existsSync(abs)) continue;
    if (statSync(abs).isDirectory()) {
      for (const name of readdirSync(abs).sort()) {
        if (/\.(jpe?g|png|webp)$/i.test(name)) files.push(resolve(abs, name));
      }
      continue;
    }
    if (extname(abs)) files.push(abs);
  }
  return files.filter((f) => /\.(jpe?g|png|webp)$/i.test(f));
}

/**
 * 旧的自写组装器（保留导出供回归对比；提交路径已改走 `shot-spec` 的 vendor 规范组装）。
 */
export function composePrompt(shot: ShotCard): string {
  const text = (v: unknown): string => (typeof v === "string" ? v.trim() : "");
  const finalized = text(shot.prompt);
  if (finalized.length >= 120) return finalized;
  const lighting = shot.lighting as Record<string, unknown> | undefined;
  const camera = shot.cameraMovement as Record<string, unknown> | undefined;
  const dialogue = Array.isArray(shot.dialogue)
    ? (shot.dialogue as Array<Record<string, unknown>>)
        .map((d) => text(d.text))
        .filter(Boolean)
        .join(" ")
    : text(shot.dialogue);
  const lines: string[] = [];
  const push = (label: string, value: string) => { if (value) lines.push(`${label}：${value}`); };

  push("画面", [text(shot.scene), text(shot.sceneDescription), text(shot.action)].filter(Boolean).join("；"));
  push("角色", text(shot.character));
  push("服装", text(shot.costume));
  push("妆容", text(shot.makeup));
  push("镜头运动", [text(camera?.composition), text(shot.composition)].filter(Boolean).join("；"));
  push("景深", text(shot.depthOfField));
  push(
    "光线氛围",
    [
      text(lighting?.key_light),
      text(lighting?.fill_light),
      text(lighting?.time_of_day),
      text(lighting?.atmosphere)
    ].filter(Boolean).join("；")
  );
  push("色调", text(shot.colorPalette));
  push("情绪节奏", [text(shot.mood), text(shot.pacing)].filter(Boolean).join("；"));
  push("转场", text(shot.transition));
  push("台词", dialogue);
  push("画质", text(shot.directorInstruction) || text(shot.baseline));
  push("约束", [text(shot.constraint), text(shot.characterConstraint), text(shot.consistency)].filter(Boolean).join("；"));
  push("负面", [text(shot.negative), text(shot.negativeConstraints)].filter(Boolean).join("；"));
  if (finalized) lines.push(`补充：${finalized}`);
  return lines.join("\n");
}

/**
 * 新提交路径：vendor 规范组装 + 交付闸。
 * 详见 `packages/video-studio/src/shot-spec.ts`（25/30 字段、长度口径、台词速率、情绪可见性）。
 */
export function composePromptBySpec(
  shot: ShotCard,
  options: { aspect: string; resolution: string; log?: (line: string) => void }
): ShotSpecReport {
  return prepareShotPrompt(shot as unknown as Record<string, unknown>, {
    ratio: options.aspect,
    resolution: options.resolution,
    log: options.log
  });
}

/**
 * 摄影知识库注入（2026-09-24）：生产出片路径与 `full-chain-film.mts` 同口径——
 * 提交渲染前先按场景定光圈档/景别/光位/色调/材质，把知识库的画面语言补进字段。
 * 失败不阻断（但**不静默**：把原因写进日志），因为知识库是增强项、不是渲染前置依赖。
 */
export async function enrichShotWithCinematographyKb(
  shot: ShotCard,
  options: { kbDir?: string; log?: (line: string) => void } = {}
): Promise<{ shot: ShotCard; aperture: string | null; fields: string[]; error: string | null }> {
  const log = options.log ?? (() => undefined);
  const kbDir = resolve(options.kbDir ?? process.env.WORKLOOM_CINE_KB_DIR ?? resolve(REPO_ROOT, "bundles/ai-video/library/cinematography-kb"));
  const bridge = resolve(REPO_ROOT, "bundles/ai-video/connectors/cine-kb-bridge/core.mjs");
  if (!existsSync(bridge) || !existsSync(kbDir)) {
    return { shot, aperture: null, fields: [], error: `摄影知识库不可用（bridge=${existsSync(bridge)}, kb=${existsSync(kbDir)}）` };
  }
  try {
    const core = (await import(bridge)) as {
      loadKb: (dir: string) => unknown;
      enrichShotCard: (kb: unknown, card: unknown) => { card: ShotCard; trace: Record<string, unknown> };
    };
    /** 知识库整库解析有成本，进程内缓存一次（同一批镜头复用） */
    const cacheKey = kbDir;
    if (!cinematographyKbCache.has(cacheKey)) cinematographyKbCache.set(cacheKey, core.loadKb(kbDir));
    const { card, trace } = core.enrichShotCard(cinematographyKbCache.get(cacheKey), shot);
    const advisor = (trace as { apertureAdvisor?: { aperture?: string } }).apertureAdvisor;
    const fields = ((trace as { applied?: Array<{ field: string }> }).applied ?? []).map((a) => a.field);
    log(`[cine-kb] ${shot.shotId}：光圈 ${advisor?.aperture ?? "-"} · 注入 ${fields.length} 处（${fields.join("/")}）`);
    return { shot: card, aperture: advisor?.aperture ?? null, fields, error: null };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log(`[cine-kb] ${shot.shotId} 注入失败（不阻断，但记录）：${message.slice(0, 200)}`);
    return { shot, aperture: null, fields: [], error: message.slice(0, 300) };
  }
}

/** 知识库进程内缓存（key=目录） */
const cinematographyKbCache = new Map<string, unknown>();

/* ================= 定妆照索引 ================= */

interface PortraitIndexLike {
  characters?: Record<string, { id?: string; name?: string; files?: Record<string, string> }>;
}

function loadPortraitIndex(projectId: string, workDir: string): PortraitIndexLike | null {
  const file = resolve(workDir, "characters", projectId, "portrait-index.json");
  if (!existsSync(file)) return null;
  try {
    return JSON.parse(readFileSync(file, "utf8")) as PortraitIndexLike;
  } catch {
    return null;
  }
}

/**
 * 挑定妆照（2026-09-23 修复）：旧实现只看 `shot.prompt + shot.characters`，而我们的镜头卡用
 * `character`（单数）→ 12/12 镜头永远命中不到 → 视频里的人只能靠文字瞎编（真机事故）。
 * 现在委托给 `packages/video-studio/src/portrait-binding.ts`（纯函数，带单测）。
 */
export function pickCharacterPortrait(index: PortraitIndexLike | null, shot: ShotCard): string | null {
  return pickCharacterPortraitFromIndex(index as PackagePortraitIndexLike | null, shot).file;
}

/* ================= 主流程 ================= */

const dryRun = flag("--dry-run");
const projectId = arg("--project");
const shotsFile = arg("--shots");
const modelId = arg("--model", dryRun ? "doubao-seedance-2-5" : "");
const only = arg("--only").split(",").map((value) => value.trim()).filter(Boolean);
if (!dryRun) {
  const client = new ProductionClient({ api: API, token: TOKEN });
  if (flag("--list-models")) {
    console.log(JSON.stringify(await client.request("video.gen.catalog", { kind: "video", includeUnavailable: false }, "GET"), null, 2));
    process.exit(0);
  }
  if (!projectId || !modelId) throw new Error("服务生产需要 --project <id> --model <服务模型目录id>；--list-models 可查询当前可用目录");
  const forbidden = ["--shots", "--refs", "--total-seconds", "--max-shot-seconds", "--allow-spec-fail", "--allow-missing-portrait", "--allow-overage", "--chain-last-frame"];
  const supplied = forbidden.filter(flag);
  if (supplied.length) throw new Error(`LOCAL_PRODUCTION_OVERRIDE_REJECTED: ${supplied.join(", ")} 只适用于本地诊断或旧接口；正式生成只消费服务当前原稿与计划时长。本地镜头文件用 --dry-run 预览。`);
  const summaryPath = resolve(REPO_ROOT, arg("--summary-out", `outputs/${projectId}/render-summary.json`));
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/.test(projectId) || projectId.includes("..")) throw new Error("PROJECT_ID_INVALID");
  const save = (value: unknown): void => {
    mkdirSync(dirname(summaryPath), { recursive: true });
    const temp = `${summaryPath}.${randomUUID()}.tmp`;
    try { writeFileSync(temp, JSON.stringify(value, null, 2) + "\n", { flag: "wx", mode: 0o600 }); renameSync(temp, summaryPath); }
    finally { rmSync(temp, { force: true }); }
  };
  try {
    const result = await renderServiceProject({ client, projectId, modelId, only,
      params: { ...(flag("--aspect") ? { aspectRatio: arg("--aspect") } : {}), ...(flag("--resolution") ? { resolution: arg("--resolution") } : {}),
        ...(flag("--seed") ? { seed: Number(arg("--seed")) } : {}), ...(flag("--service-tier") ? { serviceTier: arg("--service-tier") } : {}),
        ...(flag("--camera-fixed") ? { cameraFixed: true } : {}), ...(flag("--no-audio") ? { generateAudio: false } : {}) },
      ...(flag("--max-estimated-cny") ? { maxEstimatedCny: Number(arg("--max-estimated-cny")) } : {}),
      pollRounds: Number(arg("--poll-rounds", "80")), pollIntervalMs: Number(arg("--poll-interval-ms", "15000")),
      onProgress: save });
    console.log(`出片汇总：${summaryPath}`);
    console.log(`SUMMARY ${JSON.stringify(result)}`);
    process.exit(result.status === "done" ? 0 : 6);
  } catch (error) {
    console.error(client.safeError(error));
    process.exit(6);
  }
}
if (!shotsFile) throw new Error("本地预览需要 --dry-run --shots <shots.json>");
if (!projectId) throw new Error("需要 --project <VideoProjectId>");
const totalSeconds = Number(arg("--total-seconds", "30"));
const aspect = arg("--aspect", "9:16");
const resolution = arg("--resolution", "1080p");
/** 单镜时长上限覆盖（缺省=媒体目录里该模型的能力上限，Seedance 2.5 实测 4–30s） */
const maxShotSeconds = arg("--max-shot-seconds");
/** 交付闸未过的镜头默认拒绝提交（避免把不合规提示词烧成额度）；显式放行需带此开关 */
const allowSpecFail = flag("--allow-spec-fail");
/**
 * 项目里有角色、但拿不到人物定妆照时默认**拒绝提交**（2026-09-23 真机事故：4 张场景图下发、
 * 人物缺失，成片主角完全由文字编出来）。显式放行需带此开关 —— 只用于空镜/纯场景片。
 */
const allowMissingPortrait = flag("--allow-missing-portrait");
const workDir = resolve(REPO_ROOT, process.env.HR_WORK_DIR ?? ".vm-work");
const refFiles = loadRefFiles(arg("--refs", "var/media/references/suzhou-nanyuan"));
const portraitIndex = loadPortraitIndex(projectId, workDir);
/** 人物档案库（跨项目资产；`HR_CHARACTER_LIBRARY` 可覆盖默认 var/media/characters） */
const characterLibrary = loadCharacterLibrary(resolve(REPO_ROOT, process.env.HR_CHARACTER_LIBRARY ?? "var/media/characters"));
if (characterLibrary.size > 0) {
  console.log(`人物档案库：${characterLibrary.size} 个角色（${[...characterLibrary.values()].map((c) => `${c.name}@v${c.activeSet?.version ?? "-"}`).join("、")}）`);
}

const shots = loadShots(resolve(shotsFile)).filter((s) => only.length === 0 || only.includes(s.shotId));
/**
 * 时长分配走共享 `duration-rules`（媒体目录 = 唯一真源）：
 * 上限不再是硬编码 15s，而是模型能力（Seedance 2.5 = 30s，真机实测 31s 被拒）。
 */
const durationPlan = allocateShotDurations(shots, {
  totalSeconds,
  modelId,
  ...(maxShotSeconds ? { maxSeconds: Number(maxShotSeconds) } : {})
});
const durations = durationPlan.map;
const durationValidation = validateShotDurations(
  shots.map((s) => ({ shotId: s.shotId, duration: durations.get(s.shotId), sceneType: s.sceneType })),
  { targetTotalSeconds: totalSeconds, modelId }
);
console.log(`项目 ${projectId} | 镜头 ${shots.length} 个 | 目标总时长 ${totalSeconds}s | 参考图 ${refFiles.length} 张 | 定妆照索引 ${portraitIndex ? "有" : "无"}`);
console.log(`时长分配：${shots.map((s) => `${s.shotId}=${durations.get(s.shotId)}s`).join(" ")}`);
console.log(`时长规则校验：${durationValidation.pass ? "通过" : "不通过"}（合计 ${durationValidation.actualTotalSeconds}s / 目标 ${totalSeconds}s）`);
for (const warning of durationValidation.warnings) console.warn(`   ⚠️ ${warning}`);
for (const issue of durationValidation.issues) console.error(`   ❌ ${issue}`);
/** 逐镜时长报告（计划/采用/夹紧 + 口径清单）：dry-run 也打印，便于出片前复核 */
console.log(durationValidationMarkdown(durationValidation));
console.log(durationRulesMarkdown(modelId));

interface ShotResult {
  shotId: string;
  scriptKey: string;
  scriptId: string;
  seconds: number;
  references: number;
  spec?: {
    isOpening: boolean;
    charCount: number;
    promptSource: string;
    deliveryPass: boolean;
    deliveryIssues: string[];
    missingFields: string[];
    missingOpeningFields: string[];
    redlines: string[];
  };
  jobId?: string;
  taskId?: string;
  mock?: boolean;
  status?: string;
  assetId?: string | null;
  localPath?: string | null;
  error?: string;
}

const results: ShotResult[] = [];
const specReports: ShotSpecReport[] = [];
for (const shot of shots) {
  const seconds = durations.get(shot.shotId)!;
  const scriptKey = `${projectId}-${shot.shotId}`.toLowerCase();
  /**
   * ① 档案库选角（1–10 人，T-2026-0923-0058）：跨项目人物档案优先；
   *    未建档的老项目回退到项目级 `portrait-index.json` 的单角色逻辑。
   */
  const cast = characterLibrary.size > 0
    ? resolveShotCharacters(shot as unknown as Record<string, unknown>, characterLibrary)
    : { characters: [], unmatched: [] as string[] };
  const venuePool = pickVenueRefs(shot, refFiles, 4);
  let references: string[];
  let planNote: string;
  let usedCharacters: Array<{ id: string; name: string; angle: string }> = [];
  let droppedCharacters: Array<{ id: string; name: string; reason: string }> = [];
  let portrait: string | null = null;
  let portraitPick: { file: string | null; matchedBy: string; character?: string; note?: string } = { file: null, matchedBy: "none" };
  let sourceLabel = "档案库";

  if (cast.characters.length > 0) {
    const dialogueLines = Array.isArray((shot as Record<string, unknown>).dialogueBlocks)
      ? ((shot as Record<string, unknown>).dialogueBlocks as unknown[]).length
      : 0;
    const plan = allocateReferenceSlots({
      characters: cast.characters.map((character, index) => ({
        id: character.id,
        name: character.name,
        files: character.files,
        dialogueLines,
        lead: index === 0
      })),
      venueRefs: venuePool,
      maxRefs: 4
    });
    references = plan.references;
    planNote = plan.note;
    usedCharacters = plan.used;
    droppedCharacters = plan.dropped;
    const first = plan.used[0];
    portrait = first ? (cast.characters.find((c) => c.id === first.id)?.files[first.angle] ?? null) : null;
    portraitPick = { file: portrait, matchedBy: "archive", character: first?.name };
  } else {
    sourceLabel = "项目索引";
    const pick = pickCharacterPortraitFromIndex(portraitIndex as PackagePortraitIndexLike | null, shot);
    portraitPick = pick;
    portrait = pick.file;
    const venue = pickVenueRefs(shot, refFiles, portrait ? 3 : 4);
    const composed = composeShotReferences({ portrait, venueRefs: venue, maxRefs: 4 });
    references = composed.references;
    planNote = composed.note;
    usedCharacters = portrait ? [{ id: pick.character ?? "unknown", name: pick.character ?? "未命名", angle: "front" }] : [];
  }
  const characterCount = Object.keys((portraitIndex as PackagePortraitIndexLike | null)?.characters ?? {}).length;
  /** 镜头卡自己声明了出镜角色（`character`/`characters`/`character_ref` 任一非空）也算"需要人物参考" */
  const declaresCharacter = Boolean(
    [shot.character, shot.character_ref, shot.characterRef]
      .map((value) => (typeof value === "string" ? value.trim() : ""))
      .find(Boolean)
  ) || (Array.isArray(shot.characters) && shot.characters.length > 0);
  console.log(
    `🎭 ${shot.shotId} 参考图：${planNote}`
    + `（来源=${sourceLabel}｜命中方式=${portraitPick.matchedBy}`
    + `${portrait ? `｜人物=${basename(portrait)}` : "｜人物=无"}`
    + `${usedCharacters.length > 0
      ? `｜角色=${usedCharacters.map((u) => {
          const version = cast.characters.find((c) => c.id === u.id)?.activeSet?.version;
          return `${u.name}@v${version ?? "-"}:${u.angle}`;
        }).join("、")}`
      : ""}）`
    + `${portraitPick.note ? `\n   · ${portraitPick.note}` : ""}`
    + `${droppedCharacters.length > 0 ? `\n   · 降级：${droppedCharacters.map((d) => `${d.name}（${d.reason}）`).join("、")}` : ""}`
    + `${cast.unmatched.length > 0 ? `\n   · ⚠️ 未建档角色（当前按文字描述处理）：${cast.unmatched.join("、")}` : ""}`
  );
  const row: ShotResult = { shotId: shot.shotId, scriptKey, scriptId: scriptKey, seconds, references: references.length };
  results.push(row);

  /**
   * fail-closed：项目登记了角色却没有可下发的人物参考图 → 拒绝提交。
   * 历史事故：静默按"纯场景"提交，成片主角完全由文字生成，与真人和定妆照都无关。
   */
  if ((declaresCharacter || characterCount > 0) && !portrait && !allowMissingPortrait) {
    row.error = `本镜需要人物出镜（${declaresCharacter ? "镜头卡声明了角色" : `项目登记了 ${characterCount} 个角色`}），`
      + `但拿不到人物定妆照（命中方式：${portraitPick.matchedBy}`
      + `${portraitPick.note ? `；${portraitPick.note}` : ""}）→ 默认拒绝提交，避免生成"主角不存在"的镜头`;
    console.error(`⛔ ${shot.shotId}：${row.error}（--allow-missing-portrait 可显式放行，仅适用于空镜/纯场景片）`);
    continue;
  }

  /**
   * 定妆照字段回填（机械修复）：vendor 的 25 字段含 `portraits`，但管线里该字段常为空
   * （portrait-resolver 只写 `prompt.portraitBindings`）。这里用定妆照索引把**真实产物**
   * 回填进镜头卡：既满足交付闸的【定妆照】字段，也让渲染拿到同一批锚点图。
   */
  const cardWithPortraits: ShotCard = { ...shot };
  if (!Array.isArray(cardWithPortraits.portraits) || (cardWithPortraits.portraits as unknown[]).length === 0) {
    /**
     * 定妆照绑定优先级（2026-09-22 真人出镜场景）：
     *   ① 角色定妆照（镜头文本命中角色 id/name）→ ② 商品/场所定妆照 → ③ 实拍参考图。
     * 角色 4 角度齐备时按 front/threeQuarter/closeup/side 全绑（作为【定妆照】锚点）。
     */
    const characterEntry = portraitIndex?.characters
      ? Object.values(portraitIndex.characters).find((entry) =>
          [entry.id, entry.name]
            .filter((t): t is string => Boolean(t))
            .some((token) => `${shot.character ?? ""} ${shot.characters ?? ""} ${shot.prompt ?? ""}`.includes(token))
        ) ?? Object.values(portraitIndex.characters)[0]
      : undefined;
    const characterPortraits = characterEntry?.files
      ? ["front", "threeQuarter", "closeup", "side"]
          .map((angle) => characterEntry.files?.[angle])
          .filter((file): file is string => Boolean(file))
      : [];
    const productPortraits = portraitIndex?.products
      ? Object.values(portraitIndex.products)
          .map((entry) => entry.files?.front ?? Object.values(entry.files ?? {})[0])
          .filter((file): file is string => Boolean(file))
          .slice(0, 2)
      : [];
    const fallback = characterPortraits.length > 0
      ? characterPortraits
      : productPortraits.length > 0
        ? productPortraits
        : venuePool;
    if (fallback.length > 0) cardWithPortraits.portraits = fallback;
  }

  /**
   * 摄影知识库注入（先定关键细节，再组装提示词）：光圈/景别/光位/色调/材质按场景从库里选，
   * 让"质感参数"有依据；注入失败只记录不阻断（渲染链路不因知识库不可用而停）。
   */
  const kbEnriched = await enrichShotWithCinematographyKb(cardWithPortraits, { log: (line) => console.log(line) });
  const cardForPrompt: ShotCard = kbEnriched.shot;
  const specReport = composePromptBySpec(cardForPrompt, { aspect, resolution, log: (line) => console.log(line) });
  specReports.push(specReport);
  row.spec = {
    isOpening: specReport.isOpening,
    charCount: specReport.charCount,
    promptSource: specReport.promptSource,
    deliveryPass: specReport.delivery.pass,
    deliveryIssues: specReport.delivery.issues,
    missingFields: specReport.missingSpecFields,
    missingOpeningFields: specReport.missingOpeningFields,
    redlines: specReport.redlines
  };
  const promptText = specReport.prompt;
  if (!specReport.delivery.pass || specReport.redlines.length > 0) {
    row.error = `镜头卡未过交付闸：${[
      ...specReport.delivery.issues,
      ...specReport.redlines.map((word) => `内容红线「${word}」`)
    ].join("；")}`;
    if (!allowSpecFail) {
      console.error(`⛔ ${shot.shotId}：${row.error}（默认拒绝提交；--allow-spec-fail 可越过）`);
      continue;
    }
    console.warn(`⚠️ ${shot.shotId}：${row.error}（--allow-spec-fail 已显式放行）`);
  }
  console.log(
    `[dry-run] ${shot.shotId} ${seconds}s refs=${references.map((file) => basename(file)).join("+") || "无"}`
    + ` prompt=${promptText.length}字 source=${specReport.promptSource}`
    + ` 交付闸=${specReport.delivery.pass ? "pass" : "fail"} 字段体系=${specReport.isOpening ? "片头30" : "内容25"}`
  );
}

/* ---------- 报告落盘：镜头卡规范表 + 出片汇总（供 pipeline-audit 消费） ---------- */
if (specReports.length > 0) {
  const specMd = [
    `# 出片镜头卡规范报告 · ${projectId}`,
    "",
    `- 画幅：${aspect} / ${resolution}；总时长目标：${totalSeconds}s`,
    `- 字段规范真源：vendor field-standardizer + PromptDeliveryGuard（25 字段内容镜 / 30 字段片头）`,
    `- 交付闸：${specReports.filter((r) => r.delivery.pass).length}/${specReports.length} 通过`
    + `（未过：${specReports.filter((r) => !r.delivery.pass).map((r) => r.shotId).join("、") || "无"}）`,
    "",
    shotSpecMarkdown(specReports),
    "",
    "## 时长校验（逐镜计划 / 采用 / 夹紧）",
    "",
    durationValidationMarkdown(durationValidation),
    "",
    durationRulesMarkdown(modelId)
  ].join("\n");
  const outDir = dirname(resolve(REPO_ROOT, shotsFile));
  const specPath = resolve(REPO_ROOT, arg("--spec-report", `${outDir}/render-spec-report.md`));
  writeFileSync(specPath, specMd, "utf8");
  console.log(`镜头卡规范报告：${specPath}`);
}

const summary = {
  mode: "local-preview",
  productionQualified: false,
  projectId,
  totalSeconds,
  aspect,
  resolution,
  modelId,
  generatedAt: new Date().toISOString(),
  spec: {
    total: specReports.length,
    passed: specReports.filter((r) => r.delivery.pass).length,
    openingShots: specReports.filter((r) => r.isOpening).length,
    fieldSpec: fieldSpec().lengths
  },
  shots: results
};
const summaryPath = resolve(REPO_ROOT, arg("--summary-out", `${dirname(resolve(REPO_ROOT, shotsFile))}/render-summary.json`));
writeFileSync(summaryPath, `${JSON.stringify(summary, null, 2)}\n`, "utf8");
console.log(`出片汇总：${summaryPath}`);
console.log(`SUMMARY ${JSON.stringify(summary)}`);
