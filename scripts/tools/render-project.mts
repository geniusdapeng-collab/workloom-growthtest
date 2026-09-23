#!/usr/bin/env tsx
/**
 * 项目级出片工具（2026-09-21）——把一条预生产项目的镜头卡逐镜推到 Seedance 并轮询入库。
 *
 * 与 `render-shot.mts`（单镜）的关系：这是"一部片子"的操作口径（融合设计 §6 render-operator）：
 *   镜头卡（预生产产物 shots.json）
 *     → video.cms.saveScriptVersion（版本即审批对象，G8 前置）
 *     → video.render.submit（唯一写入口：幂等键/降级链/报价/预算闸/事件留痕）
 *     → video.render.poll（回填 + 成片入库 video_assets，local_path 落 var/media）
 *
 * 参考图（≤4 张，媒体目录 maxReferenceImages 口径）：
 *   - 实拍场地图按镜头内容关键词匹配（夜景/客房/院落/亭榭…）；
 *   - 定妆照索引（`.vm-work/characters/<project>/portrait-index.json`）里角色四角度齐备时，
 *     额外挂 1 张角色正面定妆照（角色一致性锚定）。
 *   本地无公网素材站，参考图以 base64 data URL 下发（Ark 接受，已实测）。
 *
 * 用法：
 *   pnpm exec tsx --env-file=.env scripts/tools/render-project.mts \
 *     --shots apps/server/output/<ts>_untitled/shots.json \
 *     --project VID-1019 --total-seconds 30 --aspect 9:16 --resolution 1080p \
 *     [--only SC-03,SC-04] [--dry-run] [--refs <目录或逗号分隔路径>]
 *
 * 输出：每镜的 job/task/asset/localPath 汇总 JSON（stdout 的 SUMMARY 行），供拼接/调色环节消费。
 */
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
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

const API = process.env.WORKLOOM_API ?? "http://127.0.0.1:8787";
const TOKEN = process.env.WORKLOOM_TOKEN ?? "";
const REPO_ROOT = resolve(import.meta.dirname ?? process.cwd(), "../..");

function arg(name: string, fallback = ""): string {
  const i = process.argv.indexOf(name);
  return i >= 0 ? (process.argv[i + 1] ?? fallback) : fallback;
}
const flag = (name: string) => process.argv.includes(name);

async function call<T>(path: string, body: unknown, method: "POST" | "GET" = "POST"): Promise<T> {
  const url = method === "GET"
    ? `${API}/trpc/${path}?input=${encodeURIComponent(JSON.stringify(body))}`
    : `${API}/trpc/${path}`;
  const res = await fetch(url, {
    method,
    headers: { "content-type": "application/json", authorization: `Bearer ${TOKEN}` },
    ...(method === "POST" ? { body: JSON.stringify(body) } : {}),
  });
  const text = await res.text();
  const json = text ? (JSON.parse(text) as { error?: { message?: string }; result?: { data?: T } }) : {};
  if (json.error) throw new Error(`${path}: ${json.error.message}`);
  return json.result?.data as T;
}

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

function dataUrl(file: string): string {
  /**
   * 已授权真人素材（方舟人像库 asset ID）与远端 URL 直接透传：
   * 真人肖像不能直传图片（平台隐私闸 400），必须用 `asset://<asset ID>`；
   * 透传可避免把 asset 引用误读成本地文件。
   */
  if (file.startsWith("asset://") || /^https?:\/\//i.test(file)) return file;
  const ext = extname(file).toLowerCase();
  const mime = ext === ".png" ? "image/png" : ext === ".webp" ? "image/webp" : "image/jpeg";
  return `data:${mime};base64,${readFileSync(file).toString("base64")}`;
}

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

const shotsFile = arg("--shots");
if (!shotsFile) throw new Error("需要 --shots <shots.json>");
const projectId = arg("--project");
if (!projectId) throw new Error("需要 --project <VideoProjectId>");
const totalSeconds = Number(arg("--total-seconds", "30"));
const aspect = arg("--aspect", "9:16");
const resolution = arg("--resolution", "1080p");
const modelId = arg("--model", "doubao-seedance-2-5");
const only = arg("--only").split(",").map((s) => s.trim()).filter(Boolean);
const dryRun = flag("--dry-run");
/** 单镜时长上限覆盖（缺省=媒体目录里该模型的能力上限，Seedance 2.5 实测 4–30s） */
const maxShotSeconds = arg("--max-shot-seconds");
/** 交付闸未过的镜头默认拒绝提交（避免把不合规提示词烧成额度）；显式放行需带此开关 */
const allowSpecFail = flag("--allow-spec-fail");
/**
 * 项目里有角色、但拿不到人物定妆照时默认**拒绝提交**（2026-09-23 真机事故：4 张场景图下发、
 * 人物缺失，成片主角完全由文字编出来）。显式放行需带此开关 —— 只用于空镜/纯场景片。
 */
const allowMissingPortrait = flag("--allow-missing-portrait");
/** 复现种子（同一 seed + 同 prompt 便于 A/B；写入 render_jobs 便于复盘） */
const seedArg = arg("--seed");
/** 服务档位：default（终稿）| flex（草稿，成本更低） */
const serviceTier = arg("--service-tier");
/** 固定机位（口播/棚拍镜头） */
const cameraFixed = flag("--camera-fixed");
/**
 * 逐镜首尾帧接力：第 N 镜返回尾帧（return_last_frame），作为第 N+1 镜 first_frame。
 * 官方 SDK 参数（volcengine-python-sdk@5.0.50）确认支持；能显著改善多镜空间/光线连续性。
 * 代价：必须顺序提交（每镜等出片），总时长变长。
 */
const chainLastFrame = flag("--chain-last-frame");
/**
 * 超套餐额度时显式确认按量实扣（G8 预算闸口径：`allowOverage`）。
 * 默认关闭（平台额度用尽即停）；产品所有者明确要求产出完整成片时才开。
 */
const allowOverage = flag("--allow-overage");
const ARK_BASE = (process.env.ARK_BASE_URL ?? "https://ark.cn-beijing.volces.com/api/v3").replace(/\/$/, "");
const ARK_KEY = process.env.VOLCENGINE_ARK_API_KEY ?? process.env.ARK_API_KEY ?? "";
/** 查询 Ark 任务详情（取 content.last_frame_url） */
async function fetchLastFrameUrl(taskId: string, timeoutMs = 15_000): Promise<string | null> {
  if (!ARK_KEY) return null;
  try {
    const res = await fetch(`${ARK_BASE}/contents/generations/tasks/${taskId}`, {
      headers: { authorization: `Bearer ${ARK_KEY}` },
      signal: AbortSignal.timeout(timeoutMs)
    });
    if (!res.ok) return null;
    const data = (await res.json()) as { content?: { last_frame_url?: string } };
    return data?.content?.last_frame_url ?? null;
  } catch {
    return null;
  }
}
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
const pending = new Map<string, ShotResult>();
/** 首尾帧接力用：当前镜头应带的首帧 URL（Ark 尾帧 URL 或 null） */
let chainFirstFrame: string | null = null;

/** 轮询单个渲染任务直到 done/failed；返回尾帧 URL（用于接力） */
async function waitForShotAndLastFrame(jobId: string, taskId: string): Promise<string | null> {
  for (let i = 0; i < 90; i += 1) {
    await new Promise((r) => setTimeout(r, 15_000));
    await call("video.render.poll", { limit: 20 }).catch(() => undefined);
    const jobs = await call<Array<{ id: string; status: string; asset_id: string | null; local_path: string | null }>>(
      "video.gen.jobs", { projectId, limit: 100 }, "GET"
    ).catch(() => []);
    const job = jobs.find((j) => j.id === jobId);
    if (!job) continue;
    if (job.status === "done") {
      const row = pending.get(jobId) ?? results.find((r) => r.jobId === jobId);
      if (row) { row.status = "done"; row.assetId = job.asset_id; row.localPath = job.local_path; }
      pending.delete(jobId);
      console.log(`   🔗 ${jobId} 已出片 asset=${job.asset_id ?? "—"}`);
      return await fetchLastFrameUrl(taskId);
    }
    if (job.status === "failed") {
      const row = pending.get(jobId) ?? results.find((r) => r.jobId === jobId);
      if (row) row.status = "failed";
      pending.delete(jobId);
      console.warn(`   ⛔ ${jobId} 渲染失败，接力中断`);
      return null;
    }
  }
  return null;
}

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
        : venue;
    if (fallback.length > 0) cardWithPortraits.portraits = fallback;
  }

  const specReport = composePromptBySpec(cardWithPortraits, { aspect, resolution, log: (line) => console.log(line) });
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
  const md = [
    `# ${projectId} · ${shot.shotId}`,
    "",
    "## 镜头描述（预生产定稿，25/30 字段全文）",
    "",
    promptText,
    "",
    "## 参数",
    "",
    `- 画幅：${aspect}`,
    `- 分辨率：${resolution}`,
    `- 时长：${seconds}s`,
    `- 模型：${modelId}`,
    `- 参考图：${references.length} 张（${references.map((f) => basename(f)).join("、") || "无"}）`,
  ].join("\n");

  if (dryRun) {
    console.log(
      `[dry-run] ${shot.shotId} ${seconds}s refs=${references.map((f) => basename(f)).join("+") || "无"}`
      + ` prompt=${promptText.length}字 source=${specReport.promptSource}`
      + ` 交付闸=${specReport.delivery.pass ? "pass" : "fail"} 字段体系=${specReport.isOpening ? "片头30" : "内容25"}`
    );
    continue;
  }

  try {
    const fields = {
      镜头号: shot.shotId,
      场景: shot.scene ?? "",
      时长秒: seconds,
      画幅: aspect,
      分辨率: resolution,
      参考图: references.map((f) => basename(f)),
      角色: shot.characters ?? [],
    };
    const diffSummary = String(shot.diffSummary ?? `项目级出片：${shot.shotId}（预生产定稿 ${promptText.length} 字）`);
    /**
     * 镜头卡进管线的正门：v1 用 cms.createScript；key 已存在则走 saveScriptVersion 生成新版本
     * （版本链 + diff 摘要留痕，v1 缺失是 2026-09-21 真机暴露的缺口）。
     */
    let saved: { id: string; version: number };
    try {
      saved = await call<{ id: string; version: number }>("video.cms.createScript", {
        scriptKey, projectId, shotId: shot.shotId, md, fields,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (!/已存在/.test(message)) throw err;
      saved = await call<{ id: string; version: number }>("video.cms.saveScriptVersion", {
        scriptKey, md, fields, diffSummary,
      });
    }
    row.scriptId = saved.id;
    const submitted = await call<{
      jobId: string; taskId: string; mock: boolean; durationSec: number; clamped: boolean;
    }>("video.render.submit", {
      scriptId: saved.id,
      mode: "auto",
      modelId,
      durationSec: seconds,
      /**
       * 首帧模式（i2v）**不能传 ratio**（真机 2026-09-22 实测 400：
       * `For first-frame or first-last-frame generation, the output ratio follows the first-frame image`）。
       * 接力镜沿用上一镜尾帧的画幅，因此这里只在非接力镜上传 ratio。
       */
      ...(chainFirstFrame ? {} : { aspectRatio: aspect }),
      resolution,
      generateAudio: true,
      /**
       * 首尾帧与参考图**互斥**（真机 2026-09-22 实测 400：
       * `first/last frame content cannot be mixed with reference media content`）。
       * 接力镜只用上一镜尾帧作为 first_frame（尾帧本身已携带人物与场景，天然保持一致性），
       * 非接力镜继续用 ≤4 张定妆照/实拍参考图。
       */
      ...(chainFirstFrame
        ? { firstFrameUrl: chainFirstFrame }
        : { referenceImageUrls: references.map(dataUrl) }),
      ...(seedArg ? { seed: Number(seedArg) } : {}),
      ...(serviceTier ? { serviceTier } : {}),
      ...(cameraFixed ? { cameraFixed: true } : {}),
      ...(chainLastFrame ? { returnLastFrame: true } : {}),
      ...(allowOverage ? { allowOverage: true } : {}),
      estimatedSeconds: seconds,
      idempotencyKey: `render-project:${projectId}:${shot.shotId}:${modelId}:${seconds}`,
    });
    row.jobId = submitted.jobId;
    row.taskId = submitted.taskId;
    row.mock = submitted.mock;
    row.status = "submitted";
    pending.set(submitted.jobId, row);
    console.log(`✅ ${shot.shotId} 提交：job=${submitted.jobId} task=${submitted.taskId} mock=${submitted.mock} ${submitted.durationSec}s${submitted.clamped ? "（已夹紧）" : ""} refs=${references.length}`);
    /** 首尾帧接力：顺序等本镜出片 → 取尾帧 → 作为下一镜首帧 */
    if (chainLastFrame && !submitted.mock) {
      const lastFrame = await waitForShotAndLastFrame(submitted.jobId, submitted.taskId);
      if (lastFrame) {
        chainFirstFrame = lastFrame;
        console.log(`   🔗 ${shot.shotId} 尾帧就绪 → 作为下一镜 first_frame`);
      } else {
        console.warn(`   ⚠️ ${shot.shotId} 未取到尾帧（下一镜按无条件首帧提交）`);
        chainFirstFrame = null;
      }
    }
  } catch (err) {
    row.error = err instanceof Error ? err.message : String(err);
    console.error(`⛔ ${shot.shotId} 提交失败：${row.error}`);
  }
}

/* ---------- 轮询到成片入库 ---------- */
const POLL_ROUNDS = Number(arg("--poll-rounds", "80"));
const POLL_INTERVAL_MS = Number(arg("--poll-interval-ms", "15000"));
for (let round = 0; round < POLL_ROUNDS && pending.size > 0 && !dryRun; round += 1) {
  await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
  await call("video.render.poll", { limit: 50 }).catch((err: unknown) => {
    console.warn(`轮询回填失败（下轮重试）：${err instanceof Error ? err.message : String(err)}`);
  });
  /** 任务台账在 gen 路由下（video.gen.jobs）：render.* 只有提交与轮询回填 */
  const jobs = await call<Array<{
    id: string; status: string; asset_id: string | null; local_path: string | null; result_url: string | null;
  }>>("video.gen.jobs", { projectId, limit: 100 }, "GET");
  for (const job of jobs) {
    const row = pending.get(job.id);
    if (!row) continue;
    row.status = job.status;
    row.assetId = job.asset_id;
    row.localPath = job.local_path;
    if (job.status === "done" || job.status === "failed") {
      pending.delete(job.id);
      console.log(`${job.status === "done" ? "🎬" : "⛔"} ${row.shotId} ${job.status} asset=${job.asset_id ?? "—"} local=${job.local_path ?? "—"}`);
    }
  }
  if (round % 4 === 0) {
    console.log(`轮询 ${round + 1}：待完成 ${pending.size}（${[...pending.values()].map((r) => `${r.shotId}:${r.status}`).join(" ")}）`);
  }
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
