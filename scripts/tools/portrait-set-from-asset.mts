#!/usr/bin/env tsx
/**
 * portrait-set-from-asset.mts —— **以认证真人素材为参考，一次生成整套多角度定妆照**
 *
 * 为什么是这条路（2026-09-30）：
 *   客户侧资产只以 `asset://` 存在（本地没有原图；平台 API 无"取资产内容"接口——实测 /assets/* 全 404；
 *   控制台里的私域人像库需要客户账号登录）。**不该让客户逐张导出**。而当初那张"有点像本人"的图，
 *   正是我们用 `asset://` 当参考跑生成得到的（见 `work/probe/render-sample.mjs` / `probe-asset.mjs`）——
 *   同一条路可以一次产出整套 8 角度，**客户零操作**。
 *
 * 用法：
 *   # 先干跑（不花钱）：打印逐角度提示词与将要发的请求
 *   pnpm exec tsx scripts/tools/portrait-set-from-asset.mts \
 *     --asset asset://asset-20260101000000-demo \
 *     --character demo-character --library work/film/library/characters \
 *     --out-dir work/film/library/characters/model-01-demo-character/portraits/_derived-src \
 *     --dry-run
 *
 *   # 充值后真跑（生成 → 落盘 → 自动调安装器写档案 + 复核）
 *   pnpm exec tsx scripts/tools/portrait-set-from-asset.mts ... --install --activate
 *
 * 纪律：
 *   1. **不伪造来源**：产物一律标注 `source=asset-derived`（派生定妆照，非权威原图）；
 *   2. **账户欠费即停**（403 AccountOverdueError）——不许"少几张也装"；
 *   3. 逐角度隔离：任一角度失败即整体失败（不装半套）；
 *   4. 同一张图被两个角度命中（模型偷懒）→ 拒绝；
 *   5. 装档与写后复核交给 `portrait-set-install.mts`（同一套校验与证据口径）。
 */
import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { assessLikenessBatch } from "../../packages/video-studio/src/likeness-policy.js";
import { generationRequestHash, isDefiniteGenerationRejection, readGenerationSubmissionState,
  submitGenerationOnce } from "../../packages/video-studio/src/generation-submission.mjs";
import { OpenAiCompatibleProvider } from "../../packages/base/model-router/providers.js";

function arg(name: string, fallback = ""): string {
  const index = process.argv.indexOf(name);
  return index >= 0 ? String(process.argv[index + 1] ?? fallback) : fallback;
}
const flag = (name: string): boolean => process.argv.includes(name);

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const INSTALLER = join(REPO_ROOT, "scripts/tools/portrait-set-install.mts");
/**
 * 默认角度 = **仓内角色库的标准 8 角度**（`REQUIRED_PORTRAIT_ANGLES` + back/actionPose/emotionCloseup/handDetail）——
 * 这样"一次出满 8 张"直接就是可入库、可驱动全片的标准套（旧默认那 4 个角度 frontFull/threeQuarterLeft/
 * threeQuarterRight/smileCloseup 仍可用 `--angles` 追加，属备选角度）。
 */
const DEFAULT_ANGLES = ["front", "threeQuarter", "closeup", "side", "back", "actionPose", "emotionCloseup", "handDetail"];

/** 逐角度提示词：与角色档案的生成纪律同源（纯写实 + 中性背景/中性光 + 保留真实皮肤纹理） */
const ANGLE_PROMPTS: Record<string, string> = {
  front: "正面标准定妆照：人物正面直视镜头、肩线水平、双手自然垂放或交叠；",
  threeQuarter: "四分之三侧角定妆照：人物身体与面部约 45° 朝向镜头，露出两侧脸颊轮廓；",
  closeup: "面部近景定妆照：胸部以上近景，面部占据画面主体，眼神自然看向镜头；",
  side: "正侧面定妆照：人物 90° 正侧对镜头，完整呈现鼻梁、下颌与发型轮廓；",
  back: "背面全身定妆照：人物背对镜头站立、全身入画、肩线水平，用于侧面/背影镜头的身份锚；",
  actionPose: "标志性动作全身像：自然生活姿态（站立、重心稳定、双手自然摆放），身体结构与动态张力清晰，不作夸张动作；",
  emotionCloseup: "情绪特写：胸部以上近景，完整呈现核心情绪状态，微表情层次清晰、眼神有交流感；",
  handDetail: "手部特写：手部自然摆放或持物的姿态清晰，手指结构正确、指甲自然，不出现第二只手；",
  frontFull: "正全身定妆照：人物正面站立、全身入画、重心自然、双手放松；",
  threeQuarterLeft: "左侧四分之三定妆照：人物向画面右侧转身约 45°，左肩靠近镜头；",
  threeQuarterRight: "右侧四分之三定妆照：人物向画面左侧转身约 45°，右肩靠近镜头；",
  smileCloseup: "微笑近景定妆照：胸部以上近景，自然真诚的微笑，眼神看向镜头；",
};
/**
 * 拍摄口径（2026-10-01 客户口径修订）：**只对"人脸是真的"负责**。
 * 不再强制"同发型同发色/无商标/统一 5600K 中性灰"——真实生活里本人也会换发型、戴品牌首饰衣物；
 * 这些差异不是缺陷（评审里也一律降为咨询项）。保留的只有：写实、自然皮肤质感、竖版人像、无文字水印、无第二人。
 */
const SKIN_AND_LIGHT = "写实人像（自然光或影棚光皆可，白平衡中性）、皮肤保留真实纹理与毛孔、不磨皮不美颜、"
  + "不做网红滤镜；发型/配饰/服装可保持参考素材的自然状态；竖版 3:4 人像构图；无文字、无水印、无第二人。";

const assetRef = arg("--asset").trim();
const characterId = arg("--character").trim();
const libraryRoot = resolve(arg("--library", "work/film/library/characters"));
const assetId = assetRef.replace(/^asset:\/\//, "");
/**
 * **身份绑定语**（真机教训，2026-09-30）：只给 `reference_image` 而提示词不绑定身份时，
 * 模型会跑成"任意一个人"（实测：生成出一位穿汉服的陌生女性，与认证素材完全无关）。
 * 因此逐角度提示词必须以主档属性 + "与参考素材为同一人"开头——这是像不像的前提。
 */
const identityBinding = (() => {
  const profileFile = join(REPO_ROOT, "bundles/ai-video/library/real-person-assets", assetId, "profile.json");
  if (!existsSync(profileFile)) return "与参考素材中的同一人（面孔、发型与身份完全一致，不得换人）：";
  try {
    const profile = JSON.parse(readFileSync(profileFile, "utf8")) as {
      displayName?: string;
      certified?: { gender?: string; ageBand?: string; hair?: string; appearance?: string; wardrobeBaseline?: string };
    };
    const certified = profile.certified ?? {};
    const who = certified.gender === "female" ? "东亚女性" : certified.gender === "male" ? "东亚男性" : "同一人物";
    return `与参考素材中的同一人（${who}，${certified.ageBand ?? "年龄段以素材为准"}，`
      + `${certified.hair ?? "发型与参考素材一致"}，${certified.wardrobeBaseline ?? "服装与参考素材一致"}）；`
      + `面孔、五官比例、脸型、发型与身份必须与参考素材完全一致——不得换人、不得改年龄、不得改发型；`
      + `造型要求（软性，不作不合格理由）：优先现代商务造型（${certified.wardrobeBaseline ?? "与参考素材一致的高定套装"}）；`
      + `尽量避开与商务场景明显冲突的古装/汉服/旗袍/影楼戏服；发型发饰与佩戴物保持本人自然状态即可，品牌首饰衣物不算缺陷；`;
  } catch {
    return "与参考素材中的同一人（面孔、发型与身份完全一致，不得换人）：";
  }
})();

/**
 * **多参考图**（2026-09-30 修正，产品所有者口径）：
 * 认证素材是**一组 11 张**（主素材 + 10 张同组，含不同角度）——不能"用一张正面照派生 8 张"。
 * 正确用法：每个目标角度都以「**该角度对应的那张**（若档案里有映射）＋ 主素材 ＋ 同组若干张」为参考一起提交，
 * 让模型拿到多视角的同一人信息；这也是管线里 `referenceAssetRefs(主素材 + 同组 2 张)` 的口径。
 */
const assetProfile = (() => {
  const profileFile = join(REPO_ROOT, "bundles/ai-video/library/real-person-assets", assetId, "profile.json");
  if (!existsSync(profileFile)) return null;
  try {
    return JSON.parse(readFileSync(profileFile, "utf8")) as {
      assetId?: string;
      referenceAssets?: string[];
      portraitSet?: { assets?: Array<{ assetId?: string; angleGuess?: string }> };
      notes?: string[];
    };
  } catch {
    return null;
  }
})();
const angleAssetMap: Record<string, string> = (() => {
  const map: Record<string, string> = {};
  for (const entry of assetProfile?.portraitSet?.assets ?? []) {
    const guess = entry.angleGuess ?? "";
    const id = entry.assetId ?? "";
    if (!id) continue;
    for (const angle of Object.keys(ANGLE_PROMPTS)) {
      if (guess.includes(angle)) map[angle] = id;
    }
  }
  return map;
})();
const mainAssetId = assetProfile?.assetId ?? assetId;
const groupAssetIds = (assetProfile?.referenceAssets ?? []).filter((id) => id && id !== mainAssetId);
/** 平台实测已失效的 assetId（首次提交时从 400 `not found` 里解析，后续角度不再送） */
const invalidAssetRefs = new Set<string>();
/** 该角度的参考清单：角度专属那张 → 主素材 → 同组依次补齐（去重），上限 `--refs`（默认 3，最多 4） */
function refsForAngle(angle: string): string[] {
  const ordered = [angleAssetMap[angle], mainAssetId, ...groupAssetIds]
    .filter((id): id is string => Boolean(id) && !invalidAssetRefs.has(id));
  const unique = [...new Set(ordered)];
  const limit = Math.max(1, Math.min(4, Number(arg("--refs", "3")) || 3));
  return unique.slice(0, limit).map((id) => `asset://${id}`);
}
if (!assetRef || !/^asset:\/\/[A-Za-z0-9._-]+$/.test(assetRef)) {
  console.error("用法：portrait-set-from-asset.mts --asset asset://asset-xxxx --character <角色ID> --library <角色库> [--angles a,b,...] [--out-dir <目录>] [--dry-run] [--install --activate] [--keys-file ~/.workloom/live.env] [--verify-against <锚帧>] [--require-likeness]");
  process.exit(2);
}
if (!characterId) {
  console.error("缺少 --character");
  process.exit(2);
}
const characterDir = join(libraryRoot, characterId);
if (!existsSync(join(characterDir, "profile.json"))) {
  console.error(`角色档案不存在：${join(characterDir, "profile.json")}`);
  process.exit(2);
}
const angles = (arg("--angles").trim() ? arg("--angles").split(",").map((value) => value.trim()) : DEFAULT_ANGLES).filter(Boolean);
for (const angle of angles) {
  if (!ANGLE_PROMPTS[angle]) {
    console.error(`未知角度：${angle}（可用：${Object.keys(ANGLE_PROMPTS).join(" / ")}）`);
    process.exit(2);
  }
}
const outDir = resolve(arg("--out-dir", join(characterDir, "portraits", "_derived-src")));
const dryRun = flag("--dry-run");
const doInstall = flag("--install");
const activate = flag("--activate");

/** 密钥（只进内存，不落盘、不打印） */
const keysFile = resolve(arg("--keys-file", join(homedir(), ".workloom/live.env")));
const env: Record<string, string> = {};
if (existsSync(keysFile)) {
  for (const line of readFileSync(keysFile, "utf8").split("\n")) {
    const match = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (match && match[2]!.trim()) env[match[1]!] = match[2]!.trim();
  }
}
const apiKey = process.env.VOLCENGINE_ARK_API_KEY || env.VOLCENGINE_ARK_API_KEY;
const baseUrl = (process.env.ARK_BASE_URL || env.ARK_BASE_URL || "https://ark.cn-beijing.volces.com/api/v3").replace(/\/$/, "");
const model = process.env.SEEDREAM_MODEL || env.SEEDREAM_MODEL || "doubao-seedream-4-0-250828";
if (!apiKey && !dryRun) {
  console.error(`缺少 VOLCENGINE_ARK_API_KEY（读 ${keysFile} 或环境变量）`);
  process.exit(2);
}

const plan = {
  schemaVersion: "workloom.portrait-derived-plan/v1",
  at: new Date().toISOString(),
  assetRef, characterId, model, endpoint: `${baseUrl}/images/generations`, outDir,
  identityBinding,
  angles: angles.map((angle) => ({
    angle,
    prompt: `${identityBinding}${ANGLE_PROMPTS[angle]}${SKIN_AND_LIGHT}`,
    refs: refsForAngle(angle),
  })),
  source: "asset-derived",
  discipline: "派生定妆照（合成，非权威原图）：仅用于生成锚定；权威 likeness 以平台认证素材为准",
};
console.log(`计划：以 ${assetRef} 为参考生成 ${angles.length} 个角度（模型 ${model}）`);
console.log(`多参考图：主素材 ${mainAssetId} + 同组 ${groupAssetIds.length} 张（每个角度按 --refs 取 3–4 张一起提交）`);
for (const entry of plan.angles) {
  console.log(`  ${entry.angle.padEnd(18)} refs=${entry.refs.length} 张（${entry.refs.map((ref) => ref.split("-").pop()).join("/")}）`);
}
if (dryRun) {
  console.log(`\n（dry-run：未调用模型。逐角度完整提示词见下方 JSON；充值后去掉 --dry-run 即真跑）`);
  console.log(JSON.stringify(plan, null, 2));
  process.exit(0);
}

mkdirSync(outDir, { recursive: true });
/**
 * **自动像不像校验**（产品所有者口径：不能指望客户/人工确认）：
 * `--verify-against <已通过验收的成片帧>` 作为"事实锚"，逐张送评审模型判"是不是同一个人"
 * （只看人：面孔/五官比例/脸型/发型/年龄段；服装差异不影响判定）。
 * **结果只作留证**（2026-10-01 口径：出图后的评审决策交给人类）；要旧行为加 `--require-likeness`。
 */
const verifyAgainst = arg("--verify-against").trim();
/**
 * 身份阈值（`--min-likeness`，默认 **88**）：客户口径是"人脸一定要真"，
 * 70 分档容易"差不多就过"——低于阈值宁可打回重出，也不用弱锚图去生成整片。
 */
const minLikeness = Number(arg("--min-likeness", "88"));
/**
 * 校验模型必须用**仓内监制同款**配置（`LLM_*` 优先）：
 * `~/.workloom/live.env` 里的 `DEEPSEEK_BASE_URL` 指向的是 **anthropic 兼容端点**
 * （`https://api.deepseek.com/anthropic`），拿它拼 `/chat/completions` 会 404 —— 真机踩过：
 * 校验全判"失败"，看起来像"生成的图不像"，其实是校验通道写错了。
 */
const judgeKey = process.env.LLM_API_KEY || env.LLM_API_KEY || process.env.DEEPSEEK_API_KEY || env.DEEPSEEK_API_KEY || "";
const judgeBase = (process.env.LLM_BASE_URL || env.LLM_BASE_URL || "https://api.deepseek.com").replace(/\/$/, "");
const judgeModel = process.env.LLM_MODEL || env.LLM_MODEL || process.env.DEEPSEEK_MODEL || env.DEEPSEEK_MODEL || "deepseek-flash";
const verifyAnchorDataUrl = verifyAgainst && existsSync(resolve(verifyAgainst))
  ? `data:image/jpeg;base64,${readFileSync((() => {
    const prepared = join(outDir, ".verify-anchor.jpg");
    execFileSync(process.env.WL_FFMPEG ?? "ffmpeg", ["-v", "error", "-y", "-i", resolve(verifyAgainst),
      "-vf", "scale='min(1280,iw)':-2", "-q:v", "3", prepared]);
    return prepared;
  })()).toString("base64")}`
  : null;
if (verifyAgainst && !verifyAnchorDataUrl) {
  console.error(`--verify-against 不存在：${verifyAgainst}`);
  process.exit(2);
}
if (verifyAnchorDataUrl && !judgeKey) {
  console.error("要做自动像不像校验，需要 DEEPSEEK_API_KEY（读 keys-file 或环境变量）");
  process.exit(2);
}
async function likenessCheck(png: Buffer, angle: string): Promise<{ ok: boolean; same: boolean; score: number | null; reason: string }> {
  if (!verifyAnchorDataUrl) return { ok: true, same: true, score: null, reason: "未启用自动校验（--verify-against 未提供）" };
  const imageDataUrl = `data:image/png;base64,${png.toString("base64")}`;
  const provider = new OpenAiCompatibleProvider(judgeModel, {
    baseUrl: judgeBase,
    apiKey: judgeKey,
  });
  const result = await provider.chat([{
        role: "user",
        content: [
          { type: "text", text: "图1 = 已通过验收的成片帧（认证真人的事实锚）；图2 = 新生成的定妆照。"
            + "只判\"是不是同一个人\"：看面孔五官比例、脸型、发型与年龄段；**服装/背景/光线差异不影响判定**。"
            + `只输出 JSON：{"same":true|false,"score":0-100,"reason":"一句话"}。当前角度：${angle}` },
          { type: "image_url", image_url: { url: verifyAnchorDataUrl } },
          { type: "image_url", image_url: { url: imageDataUrl } },
        ],
  }], {
    scene: "video.quality.plausibility-review",
    timeoutMs: 600_000,
    temperature: 0,
    retries: 0,
  });
  try {
    const parsed = JSON.parse(result.text.trim()) as { same?: boolean; score?: number; reason?: string };
    const score = Number.isFinite(Number(parsed.score)) ? Number(parsed.score) : null;
    const same = parsed.same === true && (score === null || score >= (Number.isFinite(minLikeness) ? minLikeness : 88));
    return { ok: same, same: parsed.same === true, score, reason: String(parsed.reason ?? "").slice(0, 200) };
  } catch {
    return { ok: false, same: false, score: null, reason: `校验结论结构非法：${result.text.slice(0, 160)}` };
  }
}
const perAngle: Array<{ angle: string; file: string; sha256: string; bytes: number; refs: string[]; likeness: { ok: boolean; same: boolean; score: number | null; reason: string } }> = [];
/**
 * 两条引擎（`--engine auto|image|video`）：
 *   · image：`/images/generations` + `image: asset://…`（若平台在该端点支持 asset 参考，最快最省）；
 *   · video：`/contents/generations/tasks` + `image_url.url=asset://… & role=reference_image`（**已实测可用**，
 *     当初那张"像本人"的关键帧就是这条路的产物）→ 取视频首帧当定妆照。
 *   · auto（默认）：先 image，遇到"该端点不支持 asset 参考"这类 4xx 再退 video；**欠费(403)立刻整体失败**。
 */
const engineArg = arg("--engine", "two-stage").trim();
/**
 * `--anchor-image <本地图>`：图端点**不接受 `asset://`**（实测 400），但接受本地图（base64 data URL）。
 * 因此标准两段式是：① 用视频端点 + asset 参考出**一张**正面（或复用已有的一张）；
 * ② 以这张为锚点走图端点 img2img 出其余角度（更便宜、分辨率更高、脸部更稳）。
 */
const anchorImage = arg("--anchor-image").trim();
let anchorDataUrl: string | null = null;
if (anchorImage) {
  const file = resolve(anchorImage);
  if (!existsSync(file)) {
    console.error(`--anchor-image 不存在：${file}`);
    process.exit(2);
  }
  /**
   * 锚点必须**压到可发包**再送：真机实测 5.9MB PNG 直接 base64（≈8MB）会被端点拒/断连（`fetch failed`）。
   * 统一转 JPEG、最长边 ≤1536、质量 3 —— 对"锁脸+锁服装"足够，且把请求体压到几百 KB。
   */
  const prepared = join(outDir, ".anchor-input.jpg");
  mkdirSync(outDir, { recursive: true });
  execFileSync(process.env.WL_FFMPEG ?? "ffmpeg", ["-v", "error", "-y", "-i", file,
    "-vf", "scale='min(1536,iw)':-2", "-q:v", "3", prepared]);
  anchorDataUrl = `data:image/jpeg;base64,${readFileSync(prepared).toString("base64")}`;
}
if (!["two-stage", "auto", "image", "video"].includes(engineArg)) {
  console.error(`--engine 只支持 two-stage（默认：视频出身份母版 + 图生图出其余角度）/ auto / image / video，收到：${engineArg}`);
  process.exit(2);
}
const isOverdue = (text: string): boolean => /AccountOverdueError|overdue balance/i.test(text);

/** Existing unjournaled outputs cannot prove whether a former paid request was accepted. */
function derivedSubmissionPath(key: string, kind: "image" | "video"): string {
  if (!/^[A-Za-z0-9_-]+$/.test(key)) throw new Error("DERIVED_SUBMISSION_KEY_INVALID");
  return join(outDir, ".submissions", `${key}.${kind}.json`);
}

function derivedSubmissionJournal(key: string, kind: "image" | "video"): string {
  const file = derivedSubmissionPath(key, kind);
  const angle = key.replace(/^master-/, "");
  const legacy = [join(outDir, `${characterId}-${angle}.png`), ...(key.startsWith("master-") ? [join(outDir, `_master-${angle}.png`)] : [])];
  if (!existsSync(file) && legacy.some(path => existsSync(path)))
    throw new Error("DERIVED_LEGACY_SUBMISSION_UNKNOWN: existing output has no acceptance journal; reconcile before POST");
  return file;
}

/** A logical angle owns both engines. Changing engine cannot discard a paid acceptance. */
function derivedAdmissionState(key: string, requested: "image" | "video" | "auto"): { kind: "image" | "video"; readOnly: boolean } {
  const active = (["image", "video"] as const).map(kind => ({ kind, prior: readGenerationSubmissionState(derivedSubmissionPath(key, kind)) }))
    .filter(entry => entry.prior && entry.prior.state !== "rejected");
  if (active.length > 1) throw new Error("DERIVED_ACCEPTANCE_CONFLICT: both engines have accepted or unknown submissions; reconcile before proceeding");
  const old = active[0];
  if (old && requested !== "auto" && requested !== old.kind)
    throw new Error(old.prior?.state === "submission-unknown" ? "DERIVED_SUBMISSION_UNKNOWN: another engine may already be paid"
      : "DERIVED_ENGINE_CONFLICT: another engine is already accepted; restore that engine before proceeding");
  return { kind: old?.kind ?? (requested === "video" ? "video" : "image"), readOnly: Boolean(old) };
}

/** Old task media must have an authoritative accepted video journal before a new POST. */
function assertDerivedTemporaryMediaKnown(): void {
  const temporary = readdirSync(outDir).filter(name => /^\.tmp-.*\.(?:mp4|png)$/.test(name));
  if (!temporary.length) return;
  const dir = join(outDir, ".submissions"), known = new Set<string>();
  if (existsSync(dir)) {
    const info = lstatSync(dir);
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("DERIVED_SUBMISSION_DIRECTORY_INVALID");
    for (const name of readdirSync(dir).filter(name => /^[A-Za-z0-9_-]+\.video\.json$/.test(name))) {
      const file = join(dir, name), prior = readGenerationSubmissionState(file);
      if (prior?.state !== "accepted") continue;
      // readGenerationSubmissionState has checked the journal and response digest.
      const saved = JSON.parse(readFileSync(file, "utf8")) as { responseText: string };
      const taskId = (JSON.parse(saved.responseText) as { id?: string }).id;
      if (typeof taskId === "string" && /^[A-Za-z0-9_-]{1,160}$/.test(taskId)) known.add(taskId);
    }
  }
  if (temporary.some(name => {
    const taskId = /^\.tmp-([A-Za-z0-9_-]{1,160})\.(?:mp4|png)$/.exec(name)?.[1];
    return !taskId || !known.has(taskId);
  })) throw new Error("DERIVED_LEGACY_SUBMISSION_UNKNOWN: temporary task media lacks an accepted journal; reconcile before POST");
}

/** Hold one admission lock across the image rejection and the video fallback. Never steal an old lock. */
async function withDerivedAdmission(key: string, requested: "image" | "video" | "auto",
  operation: (kind: "image" | "video", readOnly: boolean) => Promise<Buffer>): Promise<Buffer> {
  const cached = derivedAdmissionState(key, requested);
  // The request helper still validates exact endpoint/body; beforeSubmit forbids a raced fresh POST.
  if (cached.readOnly) return operation(cached.kind, true);
  const dir = join(outDir, ".submissions"); mkdirSync(dir, { recursive: true, mode: 0o700 });
  const info = lstatSync(dir);
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("DERIVED_SUBMISSION_DIRECTORY_INVALID");
  const lock = derivedSubmissionPath(key, "image").replace(/\.image\.json$/, ".admission.lock"), owner = randomUUID();
  try { writeFileSync(lock, owner, { flag: "wx", mode: 0o600 }); }
  catch (cause) { throw new Error("DERIVED_SUBMISSION_BUSY: same angle admission is owned; no duplicate POST sent", { cause }); }
  try {
    const current = derivedAdmissionState(key, requested);
    return await operation(current.kind, current.readOnly);
  } finally {
    if (!existsSync(lock)) throw new Error("DERIVED_SUBMISSION_LOCK_CHANGED");
    const held = lstatSync(lock);
    if (!held.isFile() || held.isSymbolicLink() || held.nlink !== 1 || readFileSync(lock, "utf8") !== owner)
      throw new Error("DERIVED_SUBMISSION_LOCK_CHANGED");
    unlinkSync(lock);
  }
}

function derivedBeforeSubmit(readOnly: boolean): void {
  if (readOnly) throw new Error("DERIVED_RECOVERY_POST_FORBIDDEN: cached acceptance changed; reconcile before POST");
  assertDerivedTemporaryMediaKnown();
}

/** Auto fallback is safe only after an explicit rejection of unsupported asset input. */
function canFallbackToVideo(error: unknown): boolean {
  const value = error as { status?: number; body?: string };
  return value?.status === 400 && typeof value.body === "string" && isDefiniteGenerationRejection(400, value.body)
    && /asset:\/\/|asset(?:[_ -]reference|\s+reference)/i.test(value.body)
    && /not supported|unsupported|does not support|不支持/i.test(value.body);
}

async function imageGeneration(prompt: string, referenceImages: string[], key: string, readOnly: boolean): Promise<Buffer> {
  /**
   * 图端点接受**本地图 / data URL**（也接受多张，见 `portrait-agent` 的 anchors 用法）；不接受 `asset://`。
   * `referenceImages` 为多图参考（身份母版）——多图比单图稳，但张数过多会稀释，2 张左右最佳。
   */
  const images = referenceImages.length > 0 ? referenceImages : (anchorDataUrl ? [anchorDataUrl] : [assetRef]);
  const requestBody = JSON.stringify({
    model, prompt, image: images.length === 1 ? images[0] : images,
    size: arg("--size", "2K"), response_format: "url", watermark: false,
  });
  const { response } = await submitGenerationOnce({ endpoint: `${baseUrl}/images/generations`,
    journalFile: derivedSubmissionJournal(key, "image"), body: requestBody,
    headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` }, timeoutMs: 300_000,
    beforeSubmit: () => derivedBeforeSubmit(readOnly) });
  const text = await response.text();
  if (!response.ok) throw Object.assign(new Error(`HTTP ${response.status} ${text.slice(0, 160)}`), { status: response.status, body: text });
  const body = JSON.parse(text) as { data?: Array<{ url?: string }> };
  const url = body.data?.[0]?.url ?? null;
  if (!url) throw new Error(`响应里没有图片 URL：${text.slice(0, 160)}`);
  const download = await fetch(url, { signal: AbortSignal.timeout(120_000) });
  if (!download.ok) throw new Error(`IMAGE_DOWNLOAD_FAILED: HTTP ${download.status}; accepted response retained`);
  return Buffer.from(await download.arrayBuffer());
}

/**
 * 视频路：**多参考图**提交 → 轮询 → 取首帧（frames:v 1）。
 *
 * **失效参考自动剔除**（2026-09-30 真机）：主档里的"同组 11 张"清单可能已经过期——
 * 实测 `asset-20260929120055-d6xr` 被平台判 `not found`。这里从 400 错误里解析出失效 assetId、
 * 仅在结构化明确400拒绝后剔除；未知结果绝不重发。首次受理响应先落盘，重启只GET。
 */
async function videoGeneration(prompt: string, refs: string[], key: string, readOnly: boolean): Promise<Buffer> {
  let activeRefs = [...refs];
  const endpoint = `${baseUrl}/contents/generations/tasks`;
  const journalFile = derivedSubmissionJournal(key, "video");
  const requestBody = (selected: string[]): string => JSON.stringify({
    model: process.env.SEEDANCE_MODEL || env.SEEDANCE_MODEL,
    content: [{ type: "text", text: `${prompt}（人物保持静止的定妆姿态，镜头固定不动）` },
      ...selected.map((ref) => ({ type: "image_url", image_url: { url: ref }, role: "reference_image" }))],
    duration: Number(arg("--video-seconds", "4")), resolution: arg("--video-resolution", "1080p"),
    generate_audio: false, watermark: false, return_last_frame: false,
  });
  const prior = readGenerationSubmissionState(journalFile);
  if (prior && prior.state !== "rejected") {
    // The accepted request may have removed an explicitly missing reference.
    // Recover only an exact request derived from this caller's declared refs.
    let matching: string[] | null = null;
    if (refs.length > 4) throw new Error("DERIVED_REFERENCE_LIMIT_INVALID");
    for (let mask = 1; mask < 2 ** refs.length; mask += 1) {
      const selected = refs.filter((_ref, index) => mask & (1 << index));
      if (generationRequestHash(endpoint, requestBody(selected)) === prior.requestHash) matching = selected;
    }
    if (!matching) throw new Error("GENERATION_REQUEST_CHANGED: previous derived video uses different input");
    activeRefs = matching;
  }
  let submit: Response | null = null;
  let submitText = "";
  for (let attempt = 0; attempt < 6; attempt += 1) {
    const accepted = await submitGenerationOnce({ endpoint, journalFile,
      headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
      body: requestBody(activeRefs), timeoutMs: 120_000, beforeSubmit: () => derivedBeforeSubmit(readOnly),
    });
    submit = accepted.response;
    submitText = await submit.text();
    if (submit.ok) break;
    const missing = /specified asset (asset-[A-Za-z0-9._-]+) is not found/.exec(submitText)?.[1];
    if (submit.status !== 400 || !isDefiniteGenerationRejection(submit.status, submitText) || !missing || activeRefs.length <= 1) {
      throw Object.assign(new Error(`HTTP ${submit.status} ${submitText.slice(0, 200)}`), { status: submit.status, body: submitText });
    }
    invalidAssetRefs.add(missing);
    activeRefs = activeRefs.filter((ref) => !ref.includes(missing));
    console.log(`  ↻ 参考素材失效（${missing}）→ 剔除后重试（剩余 ${activeRefs.length} 张参考）`);
  }
  if (!submit?.ok) throw Object.assign(new Error(`HTTP ${submit?.status ?? "?"} ${submitText.slice(0, 200)}`), { status: submit?.status ?? 0, body: submitText });
  const taskId = (JSON.parse(submitText) as { id?: string }).id;
  if (typeof taskId !== "string" || !/^[A-Za-z0-9_-]{1,160}$/.test(taskId))
    throw new Error("VIDEO_ACCEPTED_TASK_INVALID: first response retained; reconcile provider before POST");
  for (let i = 0; i < 36; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 10_000));
    const poll = await fetch(`${baseUrl}/contents/generations/tasks/${taskId}`, { headers: { authorization: `Bearer ${apiKey}` }, signal: AbortSignal.timeout(60_000) });
    const pollText = await poll.text();
    if (!poll.ok) throw new Error(`VIDEO_POLL_FAILED: HTTP ${poll.status}; task ${taskId} retained`);
    const body = JSON.parse(pollText) as { id?: string; status?: string; content?: { video_url?: string }; error?: unknown };
    if (body.id && body.id !== taskId) throw new Error("VIDEO_POLL_TASK_MISMATCH");
    if (body.status === "failed" || body.status === "cancelled") throw new Error(`视频任务失败：${pollText.slice(0, 200)}`);
    if (body.status !== "succeeded" || !body.content?.video_url) continue;
    const video = join(outDir, `.tmp-${taskId}.mp4`);
    const download = await fetch(body.content.video_url, { signal: AbortSignal.timeout(180_000) });
    if (!download.ok) throw new Error(`VIDEO_DOWNLOAD_FAILED: HTTP ${download.status}; task ${taskId} retained`);
    writeFileSync(video, Buffer.from(await download.arrayBuffer()));
    const frame = join(outDir, `.tmp-${taskId}.png`);
    execFileSync(process.env.WL_FFMPEG ?? "ffmpeg", ["-v", "error", "-y", "-ss", "0.4", "-i", video, "-frames:v", "1", frame]);
    return readFileSync(frame);
  }
  throw new Error("视频任务轮询超时（6 分钟）");
}

async function generateViaImage(prompt: string, referenceImages: string[] = [], key = "front"): Promise<Buffer> {
  return withDerivedAdmission(key, "image", (_kind, readOnly) => imageGeneration(prompt, referenceImages, key, readOnly));
}

async function generateViaVideo(prompt: string, refs: string[], key = "front"): Promise<Buffer> {
  return withDerivedAdmission(key, "video", (_kind, readOnly) => videoGeneration(prompt, refs, key, readOnly));
}

async function generateDerivedAngle(prompt: string, refs: string[], key: string, mode: "image" | "auto"): Promise<Buffer> {
  return withDerivedAdmission(key, mode, async (kind, readOnly) => {
    if (kind === "video") return videoGeneration(prompt, refs, key, readOnly);
    try { return await imageGeneration(prompt, [], key, readOnly); }
    catch (error) {
      if (mode !== "auto" || readOnly || !canFallbackToVideo(error)) throw error;
      console.log(`  ↻ ${key}：图片端点明确拒绝asset参考 → 退到视频路（保持同一角度准入锁）`);
      return videoGeneration(prompt, refs, key, false);
    }
  });
}

/** 把一张图压成"可发包"的 data URL（图端点单次请求体过大就 fetch failed，实测过） */
const dataUrlCache = new Map<string, string>();
async function toDataUrl(png: Buffer, tag: string): Promise<string> {
  const cached = dataUrlCache.get(tag);
  if (cached) return cached;
  const raw = join(outDir, `.ref-${tag}.png`);
  const small = join(outDir, `.ref-${tag}.jpg`);
  writeFileSync(raw, png);
  execFileSync(process.env.WL_FFMPEG ?? "ffmpeg", ["-v", "error", "-y", "-i", raw,
    "-vf", "scale='min(1536,iw)':-2", "-q:v", "3", small]);
  const url = `data:image/jpeg;base64,${readFileSync(small).toString("base64")}`;
  dataUrlCache.set(tag, url);
  return url;
}

/**
 * **两段式生产**（默认引擎，产品所有者口径：要"专业定妆照"、不要单图派生）：
 *   第一段：用 `asset://` 参考（视频路，唯一吃 asset 的入口）先出 1–2 张**身份母版**（默认 front，可加 threeQuarter）；
 *   第二段：以身份母版**多图**为参考走图端点 img2img（2K、便宜、专业布光），逐角度出图。
 * 任何一张不过"机器像不像"→ **只记录，不自动重做**（T-2026-1001-0007）；默认整批照常出图交人类验收，
 * 只有显式 `--require-likeness` 才整批拒绝（旧行为 opt-in）。
 */
const stageAAngles = arg("--stage-a-angles", "front").split(",").map((value) => value.trim()).filter(Boolean);
const stageAMasters = new Map<string, Buffer>();
if (engineArg === "two-stage") {
  for (const angle of stageAAngles) {
    const entry = plan.angles.find((item) => item.angle === angle);
    if (!entry) continue;
    /**
     * 默认接续原受理任务；不盲信磁盘缓存或要求用户额外传 --reuse-masters。
     * 母版/派生图的来源必须由相同请求的接续日志证明，GET/取帧失败不产生第二次收费。
     */
    const masterFile = join(outDir, `_master-${angle}.png`);
    const liveRefs = entry.refs.filter((ref) => !invalidAssetRefs.has(ref.replace(/^asset:\/\//, "")));
    console.log(`  ★ 身份母版 ${angle}：视频路 + ${liveRefs.length} 张 asset 参考（多参考=同一人多视角）`);
    const master = await generateViaVideo(entry.prompt, liveRefs, `master-${angle}`);
    stageAMasters.set(angle, master);
    writeFileSync(masterFile, master);
    console.log(`    母版已存：${masterFile}（${(master.byteLength / 1024).toFixed(0)}KB）`);
  }
}
const masterDataUrls: string[] = [];
for (const [angle, master] of stageAMasters) masterDataUrls.push(await toDataUrl(master, `master-${angle}`));
/**
 * **追加模式**（`--archive-refs <角色目录>`，客户口径 2026-10-01）：
 * 后续生产要"补角度"时，新角度必须以**档案里已发布的定妆照**为参考——否则新定的锚图与之前出片用的
 * 不是同一套，客户平台上先后发布的视频人物会不一致。因此追加时优先用已装档的 front/threeQuarter 当参考，
 * 而不是重新从素材生成一套新 look。旧版本一律保留（installer 只新增版本，不覆盖）。
 */
const archiveRefsDir = arg("--archive-refs").trim();
if (archiveRefsDir) {
  const dir = resolve(archiveRefsDir);
  const portraitsDir = join(dir, "portraits");
  const files: string[] = [];
  if (existsSync(portraitsDir)) {
    for (const version of readdirSync(portraitsDir).filter((name) => /^v\d+$/.test(name)).sort()) {
      for (const name of readdirSync(join(portraitsDir, version))) {
        if (/\.(png|jpe?g|webp)$/i.test(name)) files.push(join(portraitsDir, version, name));
      }
    }
  }
  const pick = (keyword: string): string | undefined => files.find((file) => file.includes(keyword));
  const chosen = [pick("front"), pick("threeQuarter"), pick("closeup")].filter(Boolean).slice(0, 2) as string[];
  if (chosen.length > 0) {
    masterDataUrls.length = 0;
    for (const [index, file] of chosen.entries()) {
      masterDataUrls.push(await toDataUrl(readFileSync(file), `archive-${index}`));
    }
    console.log(`↻ 追加模式：以档案已有定妆照为参考（${chosen.map((file) => basename(file)).join(" / ")}）——与已发布视频保持人物一致性`);
  } else {
    console.log(`⚠ 追加模式：档案里没有可用定妆照（${portraitsDir}）→ 退回用新生成的身份母版`);
  }
}

for (const entry of plan.angles) {
  /** 参考集在每个角度开跑前重算：已确认失效的 assetId 不再送（避免每个角度都白试一次） */
  const liveRefs = entry.refs.filter((ref) => !invalidAssetRefs.has(ref.replace(/^asset:\/\//, "")));
  let image: Buffer;
  if (stageAMasters.has(entry.angle)) {
    image = stageAMasters.get(entry.angle)!;
  } else if (engineArg === "two-stage") {
    image = await generateViaImage(entry.prompt, masterDataUrls, entry.angle);
  } else if (engineArg === "video") {
    image = await generateViaVideo(entry.prompt, liveRefs, entry.angle);
  } else {
    try {
      image = await generateDerivedAngle(entry.prompt, liveRefs, entry.angle, engineArg as "image" | "auto");
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      const body = (error as { body?: string }).body ?? "";
      if (isOverdue(detail) || isOverdue(body)) {
        console.error(`${entry.angle}：账户欠费（AccountOverdueError）→ 整体失败，先充值再重跑（本轮不产出任何文件、不做部分安装）`);
        process.exit(3);
      }
      console.error(`${entry.angle}：生成端点失败 —— ${detail}`);
      process.exit(3);
    }
  }
  if (image.byteLength < 50_000) {
    console.error(`${entry.angle}：返回图过小（${image.byteLength} 字节），疑似失败页`);
    process.exit(3);
  }
  const file = join(outDir, `${characterId}-${entry.angle}.png`);
  writeFileSync(file, image);
  const likeness = await likenessCheck(image, entry.angle);
  /**
   * 机器像不像结论**不触发任何自动重做**（T-2026-1001-0007）：本文件已经写盘并进入本批产物，
   * 是否重做由人类看过 8 张后决定。曾经这里是“图生图不像 → 回退视频路重做一次”，
   * 那正是“机器判不合格 → 自己重新提交生成”的残留路径，已删除。
   */
  perAngle.push({
    angle: entry.angle, file, sha256: createHash("sha256").update(image).digest("hex"),
    bytes: image.byteLength, refs: entry.refs, likeness,
  });
  console.log(`  ${likeness.ok ? "✓" : "✗"} ${entry.angle} → ${file}（${(image.byteLength / 1024).toFixed(0)}KB）`
    + ` 像不像：${likeness.same ? "同一人" : "疑似不一致"}${likeness.score === null ? "" : `（score ${likeness.score}）`} ${likeness.reason.slice(0, 60)}`);
}

/**
 * 像不像**只作留证**（2026-10-01 产品所有者口径：出图后的评审决策交给人类）。
 *
 * 为什么不再当闸门：这个机器判据本身不稳定——同一批文件实测同一张图出现 92 / 15 / 86 三种结论，
 * 拿它当门只会误杀（把像的拦下）或误放（把不像的放过）。需要旧行为时显式加 `--require-likeness`。
 * `assessLikenessBatch` 固化“默认不阻断、不重做；只有显式 --require-likeness 才整批拒绝”。
 */
const likenessDecision = assessLikenessBatch(
  perAngle.map((entry) => ({ angle: entry.angle, ok: entry.likeness.ok, score: entry.likeness.score, reason: entry.likeness.reason })),
  { requireLikeness: flag("--require-likeness") },
);
if (likenessDecision.failed.length > 0) {
  const detail = likenessDecision.failed.map((entry) => `${entry.angle}（score ${entry.score ?? "n/a"}）：${entry.reason ?? ""}`);
  if (likenessDecision.blocking) {
    console.error(`\n以下角度未过自动像不像校验（--require-likeness：整批拒绝）：`);
    for (const line of detail) console.error(`  ${line}`);
    process.exit(2);
  }
  console.log(`\n⚠ ${likenessDecision.summary}——不自动重做，请人类看过原图后决定`);
  for (const line of detail) console.log(`  ${line}`);
}

/** 模型偷懒防线：两个角度拿到同一张图 → 整套拒绝 */
const byHash = new Map<string, string[]>();
for (const entry of perAngle) byHash.set(entry.sha256, [...(byHash.get(entry.sha256) ?? []), entry.angle]);
const duplicated = [...byHash.entries()].filter(([, list]) => list.length > 1);
if (duplicated.length > 0) {
  console.error(`生成结果里有重复图（同一张被指到多个角度）：${duplicated.map(([, list]) => list.join("+")).join("，")} → 整套拒绝`);
  process.exit(2);
}

const mappingFile = join(outDir, "mapping.json");
writeFileSync(mappingFile, `${JSON.stringify(Object.fromEntries(perAngle.map((entry) => [entry.angle, `${characterId}-${entry.angle}.png`])), null, 2)}\n`, "utf8");
writeFileSync(join(outDir, "derived-plan.json"), `${JSON.stringify({ ...plan, perAngle }, null, 2)}\n`, "utf8");
console.log(`\n已产出 ${perAngle.length} 张派生定妆照：${outDir}`);

if (doInstall) {
  console.log("→ 调用安装器写档案并复核…");
  execFileSync(process.execPath, ["--import", "tsx", INSTALLER,
    "--character", characterId, "--library", libraryRoot, "--from", outDir, "--mapping", mappingFile,
    "--source", "asset-derived", ...(activate ? ["--activate"] : []),
  ], { stdio: "inherit" });
} else {
  console.log(`（未安装：加 --install 一步写入档案；或手工跑 portrait-set-install.mts --from ${outDir} --mapping ${mappingFile} --source asset-derived --activate）`);
}
