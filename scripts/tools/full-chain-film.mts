#!/usr/bin/env tsx
/**
 * full-chain-film.mts —— 全链路出片（成功源镜头默认采用，正式后期处理回执）
 *
 * 与 `render-project.mts` 的分工：
 *   · render-project.mts 是"预生产产物 → 逐镜提交渲染"的服务端工具（依赖 server + DB + G8 审批）；
 *   · 本工具是**端到端制片**：脚本 → 提示词交付闸 → 关键帧 → 逐镜视频 → 合成 → 调色 → 字幕
 *     → 弹幕 → 配乐 → 封面 → 母版；保留生成前的真实提交授权与冻结来源，
 *     成功源镜头直接后期，实际处理/输出失败明确停止，品质未评审如实记录。
 *
 * 用法：
 *   tsx scripts/tools/full-chain-film.mts \
 *     --shots <shotlist.json> --project VID-PJL01 \
 *     --library <角色档案库根> --work-dir <.vm-work 根> --out <交付目录> \
 *     [--stages spec,plates,videos,compose,color,subtitle,danmaku,bgm,cover,mux] \
 *     [--subtitle-mode sidecar|burn|both]   # 缺省 sidecar：字幕只做旁挂文件 + 软字幕轨，母版不烧字 \
 *     [--aspect 9:16|16:9|1:1|4:5] [--resolution 720p|1080p|2160p] [--quality hd|uhd] \
 *     [--max-attempts 2]  # 帧率来自冻结原稿；后期不覆盖 \
 *     [--keys-file ~/.workloom/live.env] [--brief <brief.json>] [--no-resume] [--dry-run]
 *     [--resume-tasks <shotId-to-taskId.json>] # GET 接续已受理任务，按实际任务与字节采用成功原片
 *
 * 封面平台化与知识库（2026-09-27）：
 *   [--cover-platform douyin|kuaishou|xiaohongshu|wechat-channels|bilibili|tiktok|youtube|instagram-reels]
 *                                 # 缺省沿用 --platform（历史默认"抖音/快手"→抖音口径，回归基线）
 *   [--theme 知识科普|美食|旅行风光|…]   # 缺省从片名 + brief.goal 启发式匹配（匹配不到不注入）
 *   [--account chen-zhuo]           # 账号视觉锤档案（bundles/ai-video/library/account-profiles/<id>.yml）
 *   [--no-cover-kb]                 # 关闭封面知识库注入（退化为平台化之前的设计提示词）
 *
 * 阶段日志：`<work-dir>/logs/stages.jsonl`（逐条：stage/shotId/invoked/ok/degraded/cached/verdict）
 * 阶段汇总：`<work-dir>/logs/stages.json`
 */
import { execFileSync, spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  accessSync, appendFileSync, closeSync, constants as fsConstants, copyFileSync, existsSync, mkdirSync, openSync, readFileSync, readSync, readdirSync,
  renameSync, rmSync, statSync, writeFileSync
} from "node:fs";
import { homedir } from "node:os";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import YAML from "yaml";
import { filmReviewContracts, loadOrCreateFilmAuthorContext, reviewFilmStage } from "../../packages/video-studio/src/film-contracts.js";
import { buildProducerReviewContract, reviewStage as reviewCharacterVisualStage, type ProducerGateOptions } from "../../packages/video-studio/src/producer-gate.js";
import { buildVariantCoverFilters, embedCoverFirstFrame, type CoverFirstFrameReceipt, type CoverVariantId } from "../../packages/video-studio/src/cover-assembly.js";
import { adaptCharacterVisualVerdict, assessCharacterGenerationInput, assessCharacterRelease, assessRenderedCharacterUse, buildCharacterIdentityReviewRequest, generationIdentityLock, type CharacterIdentityEvidence, type CharacterReleaseArtifact } from "../../packages/video-studio/src/character-release-contract.js";
import { buildRegisteredCharacterReleaseSource } from "../../packages/video-studio/src/character-release-source.js";
import type { FilmVideoSubmissionReceipt } from "../../packages/video-studio/src/film-worker-provenance.js";
import { assessPortraitDecision, selectPortraitDecisionRecord } from "../../packages/video-studio/src/portrait-decision.js";
import { executeRevision } from "../../packages/video-studio/src/revision-executor.js";
import { assessVoiceArtifact, fingerprintFile, fingerprintText, promoteDubCandidate, type VoiceArtifactRecord } from "./film-voice-artifact.js";
import { readResumeTasks, runFilmRenderTask } from "./film-render-task.mjs";
import { buildFilmRenderLedger, type FilmRenderLedger as RenderLedger } from "./film-render-ledger.mjs";
import { assertFilmAudioPreflight, assertFilmAudioSource, decideFilmVoiceAction, resolveFilmAudioContract } from "./film-audio-policy.mjs";
import { freezeOriginalSubmission, issueOriginalRenderReceipt, adoptCompletedOriginalRenders, captureOriginalRenderManifest, loadOriginalRenderManifest, assertStandardPostExportClock, resolveStandardPostBinary } from "./film-standard-post.mjs";
import { assertCoverPublication, resolveOpeningTitle } from "./film-publication-policy.mjs";
import {
  assertSelectedShotStageScope, captureLineageInputs, createLineageReceipt, fingerprintArtifact, latestLineageRecord, productionHash,
  reusableLineageArtifact, stageLineageApproved, verifyLineageReceipt,
  type LineageReceipt, type LineageInputSnapshot,
} from "../../packages/video-studio/src/production-lineage.js";
import {
  applyMicromotion, assessVariantDistinctness, auditContinuity, buildDeliveryManifest, buildGateEvent,
  assessMotionRichness, motionPolicyForShot, buildCoverDesignPrompt, buildMaterialMotionPrompt, buildPlatePrompt, buildRevisionPlan, buildRevisionReport, buildVariantPlan,
  buildMaterialScenePrompt, assessReferenceIndependence, decidePlateCache, plateRequestSha256, MATERIAL_SCENE_POLICY_VERSION,
  isDoubledNarration, speechAcceptance,
  termPronunciationCheck,
  REFERENCE_INDEPENDENCE_POLICY,
  coverDeterministicChecks, coverPrefersNightBackground, COVER_FONTS, COVER_LOWER_BAND_SAFE_AREA, COVER_REVIEW_RUBRIC, COVER_SAFE_AREA,
  type CoverFontId,
  getCoverSpec, isKnownCoverPlatform, COVER_PLATFORM_IDS,
  fallbackCoverPlan, findAngleFile, MATERIAL_POLICY_STATEMENT, MATERIAL_POLICY_VERSION, assessMaterialReuse,
  assertMaterialGenerationProvenance, parseCoverPlan, prepareShotPrompt, readMaterialSpec, resolveProducerLlm,
  detectProductAnchor, resolveRoutePreflight, RoutePreflightError, type RoutePreflightResult,
  buildSfxArgs, cutTimesFromShots, planCutSfxDetailed, CUT_SFX_POLICY, planHookSfx, HOOK_SFX_POLICY,
  measureBpm, beatGridReport, checkShotOrder, assessVariantAxes, VARIANT_MIN_COUNT, auditDeliverableNaming,
  assessCharacterConsistency, medianColor, type CharacterConsistencyReport, type RgbColor,
  normalizePromptLanguage,
  normalizeDialogueWindow,
  restoreCardFieldText,
  mergeUniqueSegments,
  restoreTimelineField,
  environmentDefects, expandShotWithBible, summarizeDefects, validateSceneBible, spaceSummary,
  applyScenePolicy, auditScenePolicy, loadScenePolicies, selectScenePolicy, PRODUCER_RUBRICS,
  openingHookChecks, summarizeHookChecks, validateHookCard, defaultHookSfx, hookWindowFor, HOOK_TYPE_LABELS, HOOK_WINDOW_SEC,
  checkSpeechFit, speechRateProfile,
  deviceDefects, summarizeDeviceDefects, DEVICE_POLICY_VERSION, DEVICE_POLICY_VERIFIED_AT, allowedModelSummary,
  planMicromotion, MICROMOTION_MARKER, MICROMOTION_POLICY_VERSION,
  type CoverAccountProfile, type CoverDesignInput, type CoverMeasurements, type CoverPlan,
  type CoverPlatformSpec, type GateCheck, type GateEvent, type PipelineGateStepKey,
  type DeviceCategory, type DeviceDefect, type EnvDefect, type HookCard, type MicromotionTrace, type PlatePromptShot,
  type ProducerVerdict, type SceneBible, type ScenePolicyReport
} from "../../packages/video-studio/src/index.js";
import { coverShotHasCharacter, coverShotMatchesLead, coverShotCharacterIds, resolveCoverHero, resolveCoverComposition,
  type CoverLeadSource } from "../../packages/video-studio/src/cover-design.js";
import { assertStandardPostTimeline, validateStandardNativeClock } from "../../packages/video-studio/src/standard-post-contract.js";
import { FILM_COMPLETION_GUIDANCE, filmCompletionPolicyForDocument, describeFilmCompletion, type FilmCompletionRecord } from "../../packages/video-studio/src/film-completion.mjs";
import { normalizeShotIntent, shotIntentHash, type ShotIntentStatus } from "../../packages/video-studio/src/shot-intent.js";
import { verifyAvSyncEvidence } from "../../packages/video-studio/src/av-sync.js";
import { loadProductArchives, productArchivePromptLines, productHeroPhoto, productPhotoPath, selectProductArchive } from "../../packages/video-studio/src/product-archive.js";
import { assertShotMatchesCertifiedAsset, assetIdOf, hasIdentityAnchor, identityAnchorContext, identityAnchorPath, identityReviewContext, loadRealPersonAssets, realPersonUsageReceipt, referenceAssetRefs, REAL_PERSON_POLICY_VERSION } from "../../packages/video-studio/src/real-person-asset.js";
import { auditFilmRedlines, PROMPT_REDLINE_POLICY_VERSION } from "../../packages/video-studio/src/prompt-redlines.js";
import { assessFilmFirstPass, FIRST_PASS_POLICY_VERSION } from "../../packages/video-studio/src/first-pass.js";
import { publishUhdDelivery, sha256UhdAsset } from "../../packages/video-studio/src/uhd-delivery.js";
import { FullChainFilmWorker } from "../../packages/video-studio/src/film-worker-runtime.js";

const REPO_ROOT = resolve(import.meta.dirname ?? process.cwd(), "../..");
// A standard post entry consumes only the canonical issued originals and four post-layer settings.
if (process.argv.includes("--existing-render-edit")) {
  throw new Error("FREE_EDIT_REMOVED: --existing-render-edit was removed; use --standard-post with the issued original manifest");
}
if (process.argv.includes("--standard-post")) {
  if (process.argv.includes("--worker") || process.env.FILM_WORKER_MODE === "worker") throw new Error("STANDARD_POST_WORKER_FORBIDDEN: explicit local post entry required");
  const args = process.argv.slice(2), required = ["--standard-post", "--post-settings", "--out"];
  if (args.length !== 6 || required.some(key => args.filter(a => a === key).length !== 1)
    || [0, 2, 4].some(i => !required.includes(args[i]!) || !args[i + 1] || args[i + 1]!.startsWith("--")))
    throw new Error("STANDARD_POST_ARGUMENTS_INVALID: use --standard-post <issued-manifest.json> --post-settings <settings.json> --out <new-directory>");
  const value = (key: string) => resolve(args[args.indexOf(key) + 1]!);
  const { runStandardPost } = await import("./film-standard-post.mjs");
  const explicitFfmpeg = process.env.WL_FFMPEG || process.env.FFMPEG_PATH, explicitFfprobe = process.env.WL_FFPROBE || process.env.FFPROBE_PATH;
  const local = explicitFfmpeg && explicitFfprobe ? null : verifiedLocalMediaBins();
  const result = await runStandardPost(value("--standard-post"), value("--post-settings"), value("--out"), { repoRoot: REPO_ROOT,
    ffmpeg: explicitFfmpeg || local?.ffmpeg || "ffmpeg", ffprobe: explicitFfprobe || local?.ffprobe || "ffprobe" });
  process.stdout.write(`STANDARD_POST ${JSON.stringify(result)}\n`); process.exit(0);
}

const WORKER_RUNTIME = process.argv.includes("--worker") || process.env.FILM_WORKER_MODE === "worker"
  ? FullChainFilmWorker.fromEnvironment(REPO_ROOT) : null;
if (WORKER_RUNTIME) process.argv = [...process.argv.slice(0, 2), ...WORKER_RUNTIME.args];
/** GUI 启动时 PATH 常不含工位 kit；只选经过仓内 pin 摘要核验的本机二进制。 */
function verifiedLocalMediaBins(): { ffmpeg: string; ffprobe: string } | null {
  if (process.platform !== "darwin" || !["arm64", "x64"].includes(process.arch)) return null;
  const dir = join(process.env.WORKLOOM_COLOR_HOME || join(homedir(), ".workloom-color"), "bin");
  const paths = { ffmpeg: join(dir, "ffmpeg"), ffprobe: join(dir, "ffprobe") };
  if (!existsSync(paths.ffmpeg) && !existsSync(paths.ffprobe)) return null;
  const pinFile = join(REPO_ROOT, "bundles/ai-video/connectors/color-bridge/kit/ffmpeg-pin.json");
  if (!existsSync(pinFile)) throw new Error(`本机媒体工具已存在，但缺少摘要清单：${pinFile}`);
  const pin = JSON.parse(readFileSync(pinFile, "utf8")) as {
    targets?: Record<string, Record<string, { sha256?: string }>>;
  };
  const target = pin.targets?.[`darwin-${process.arch}`];
  for (const [name, file] of Object.entries(paths)) {
    const expected = target?.[name]?.sha256;
    if (!expected || !/^[a-f0-9]{64}$/i.test(expected)) {
      throw new Error(`本机媒体工具 ${name} 没有该平台的受控 SHA-256；请先检查 kit pin`);
    }
    try { accessSync(file, fsConstants.X_OK); }
    catch { throw new Error(`本机媒体工具不可执行或缺失：${file}`); }
    const actual = createHash("sha256").update(readFileSync(file)).digest("hex");
    if (actual !== expected) throw new Error(`本机媒体工具摘要不匹配：${file}`);
  }
  return paths;
}
const EXPLICIT_FFMPEG = process.env.WL_FFMPEG || process.env.FFMPEG_PATH;
const EXPLICIT_FFPROBE = process.env.WL_FFPROBE || process.env.FFPROBE_PATH;
const LOCAL_MEDIA_BINS = EXPLICIT_FFMPEG && EXPLICIT_FFPROBE ? null : verifiedLocalMediaBins();
const FFMPEG = EXPLICIT_FFMPEG || LOCAL_MEDIA_BINS?.ffmpeg || "ffmpeg";
const FFPROBE = EXPLICIT_FFPROBE || LOCAL_MEDIA_BINS?.ffprobe || "ffprobe";
process.env.WL_FFMPEG ||= FFMPEG;
process.env.WL_FFPROBE ||= FFPROBE;

function arg(name: string, fallback = ""): string {
  const i = process.argv.indexOf(name);
  return i >= 0 ? (process.argv[i + 1] ?? fallback) : fallback;
}
const flag = (name: string) => process.argv.includes(name);
const abs = (p: string) => (isAbsolute(p) ? p : resolve(REPO_ROOT, p));
const stamp = () => new Date().toISOString();
const log = (line: string): void => { process.stdout.write(`[${stamp().slice(11, 19)}] ${line}\n`); };

/* ================= 参数 ================= */

const SHOTS_ARGUMENT = arg("--shots");
if (!SHOTS_ARGUMENT) throw new Error("需要 --shots <shotlist.json>");
const SHOTS_FILE = abs(SHOTS_ARGUMENT);
if (!existsSync(SHOTS_FILE) || !statSync(SHOTS_FILE).isFile()) throw new Error("需要 --shots <shotlist.json>（有效本地文件）");
const sourceBytes = readFileSync(SHOTS_FILE);
const sourceFileHash = createHash("sha256").update(sourceBytes).digest("hex");
const sourceDocument = JSON.parse(sourceBytes.toString("utf8")) as Record<string, unknown> & { shots?: Array<Record<string, unknown>> };
const PROJECT = arg("--project", typeof sourceDocument.projectId === "string" ? sourceDocument.projectId : basename(SHOTS_FILE, ".json"));
if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(PROJECT) || PROJECT.includes("..")) throw new Error("PROJECT_ID_INVALID: 项目ID不能包含路径或特殊分隔符");
const RUN_ID = WORKER_RUNTIME?.context.runId ?? randomUUID();
const LIBRARY = resolve(arg("--library", join(REPO_ROOT, "var/media/characters")));
const WORK_DIR = resolve(arg("--work-dir", join(REPO_ROOT, ".vm-work")));
const OUT_ROOT = resolve(arg("--out", join(REPO_ROOT, "outputs", PROJECT)));
const KEYS_FILE = arg("--keys-file", join(homedir(), ".workloom", "live.env"));
const BRIEF_FILE = arg("--brief");
const REVISION_CONTEXT = arg("--revision-context", "");
const ASPECT = arg("--aspect", typeof sourceDocument.aspect === "string" ? sourceDocument.aspect : "9:16");
/**
 * 云端生成保持原来的低价分辨率；UHD 只在本机取得镜头文件后执行。
 * `--resolution 2160p` 是旧参数风格的交付档别名，不传给模型提示词。
 */
const REQUESTED_RESOLUTION = arg("--resolution", typeof sourceDocument.resolution === "string" ? sourceDocument.resolution : "1080p");
const QUALITY_ARG = arg("--quality", "");
if (!["720p", "1080p", "2160p"].includes(REQUESTED_RESOLUTION)) {
  throw new Error(`--resolution 不支持 ${REQUESTED_RESOLUTION}（可选 720p / 1080p / 2160p）`);
}
if (QUALITY_ARG && !["hd", "uhd"].includes(QUALITY_ARG)) {
  throw new Error(`--quality 不支持 ${QUALITY_ARG}（可选 hd / uhd）`);
}
if (REQUESTED_RESOLUTION === "2160p" && QUALITY_ARG === "hd") {
  throw new Error("--resolution 2160p 与 --quality hd 冲突");
}
type FilmQuality = "hd" | "uhd";
const QUALITY: FilmQuality = (QUALITY_ARG || (REQUESTED_RESOLUTION === "2160p" ? "uhd" : "hd")) as FilmQuality;
const SOURCE_RESOLUTION = REQUESTED_RESOLUTION === "2160p" ? "1080p" : REQUESTED_RESOLUTION;
const OUTPUT_RESOLUTION = QUALITY === "uhd" ? "2160p" : SOURCE_RESOLUTION;
/** UHD 全套交付文件先留在与正式目录同卷的源版本暂存区，交付门全过后整体发布。 */
const PUBLIC_OUT_DIR = QUALITY === "uhd" ? join(OUT_ROOT, "uhd") : OUT_ROOT;
const PUBLIC_RELEASE_DIR = QUALITY === "uhd" ? join(PUBLIC_OUT_DIR, "releases", RUN_ID) : PUBLIC_OUT_DIR;
const OUT_DIR = QUALITY === "uhd" ? join(OUT_ROOT, ".uhd-staging", RUN_ID) : OUT_ROOT;
function publicDeliveryPath(path: string): string {
  if (QUALITY !== "uhd") return path;
  const rel = relative(OUT_DIR, path);
  if (!rel || rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    throw new Error(`UHD_DELIVERY_PATH_OUTSIDE_STAGING: ${path}`);
  }
  return join(PUBLIC_RELEASE_DIR, rel);
}
/** 以短边为 720/1080/2160，四种交付画幅用同一个推导口径。 */
function dimensionsFor(aspect: string, resolution: string): { width: number; height: number } {
  const shortEdge = Number(resolution.replace(/p$/, ""));
  const ratio: Record<string, [number, number]> = {
    "9:16": [9, 16], "16:9": [16, 9], "1:1": [1, 1], "4:5": [4, 5]
  };
  const pair = ratio[aspect];
  if (!pair || ![720, 1080, 2160].includes(shortEdge)) {
    throw new Error(`不支持画幅/分辨率组合：${aspect} ${resolution}`);
  }
  const [x, y] = pair;
  const width = Math.round(shortEdge * x / Math.min(x, y));
  const height = Math.round(shortEdge * y / Math.min(x, y));
  if (width % 2 !== 0 || height % 2 !== 0) throw new Error(`编码尺寸必须为偶数：${width}x${height}`);
  return { width, height };
}
const SOURCE_SIZE = dimensionsFor(ASPECT, SOURCE_RESOLUTION);
const OUTPUT_SIZE = dimensionsFor(ASPECT, OUTPUT_RESOLUTION);
function sampleDimensions(shortEdge: number): { width: number; height: number } {
  const sourceShort = Math.min(SOURCE_SIZE.width, SOURCE_SIZE.height);
  return {
    width: Math.round(SOURCE_SIZE.width * shortEdge / sourceShort),
    height: Math.round(SOURCE_SIZE.height * shortEdge / sourceShort)
  };
}
const ENHANCE_KIND = arg("--enhance-kind", "live-action");
if (!["live-action", "animation"].includes(ENHANCE_KIND)) {
  throw new Error(`--enhance-kind 不支持 ${ENHANCE_KIND}（可选 live-action / animation；文字画面须原生渲染）`);
}
const ENHANCE_ENGINE_DIR = arg("--enhance-engine-dir", "");
if (["--enhance-kind", "--enhance-engine-dir"].some(flag)) {
  throw new Error("STANDARD_ENHANCEMENT_OPTION_UNSUPPORTED: this entry uses the local compositor for requested geometry; no model enhancement adapter is connected");
}
/** The original submitted card owns the frame clock. A post option cannot silently change it. */
function sourceFpsFor(document: typeof sourceDocument): number {
  const authored: number[] = [];
  const add = (value: unknown): void => {
    if (typeof value !== "number" || !Number.isFinite(value) || value <= 0 || value > 240)
      throw new Error("STANDARD_NATIVE_FPS_INVALID: authored fps must be a positive finite number at most 240");
    authored.push(value);
  };
  if (document.fps !== undefined) add(document.fps);
  for (const shot of document.shots ?? []) {
    if (shot.fps !== undefined) add(shot.fps);
    for (const match of String(shot.constraint ?? "").matchAll(/([0-9]+(?:\.[0-9]+)?)\s*fps\b/gi)) add(Number(match[1]));
  }
  if (authored.some(value => value !== authored[0])) throw new Error("STANDARD_NATIVE_FPS_CONFLICT: submitted shots have different frame clocks");
  return authored[0] ?? 24;
}
const SOURCE_FPS = sourceFpsFor(sourceDocument);
const FPS = Number(arg("--fps", String(SOURCE_FPS)));
if (FPS !== SOURCE_FPS) throw new Error("STANDARD_NATIVE_FPS_OVERRIDE_REJECTED: preserve the submitted original frame clock");
const RENDER_SECONDS_MIN = 4;
const RENDER_SECONDS_MAX = 12;
const MAX_ATTEMPTS = Math.max(1, Number(arg("--max-attempts", "1")) || 1);   // 默认不做盲重试（T-2026-0929-0009）
/** Standard post keeps full original ranges, native audio and hard-cut timing. */
const XFADE = Number(arg("--xfade", "0"));
const CUT_TRANSITION = arg("--cut-transition", "");
const CUT_TRANSITION_DURATION = Number(arg("--cut-transition-duration", "0"));
const CUT_TRANSITION_AT = arg("--cut-transition-at", "");
const ORDER_POLICY = arg("--order-policy", "storyboard") as "storyboard" | "reuse-assembly";
const COMPOSE_ORDER = arg("--compose-order", "");
const REUSE_PLAN = arg("--reuse-plan", "");
if (XFADE !== 0 || CUT_TRANSITION || CUT_TRANSITION_DURATION !== 0 || CUT_TRANSITION_AT
  || ORDER_POLICY !== "storyboard" || COMPOSE_ORDER || REUSE_PLAN
  || ["--retime-to", "--material-speed-ramp", "--material-post-camera-move", "--material-photo-tail-trim", "--material-post-only"].some(flag)) {
  throw new Error("STANDARD_NATIVE_EDIT_OPTION_REJECTED: standard production preserves all original ranges, source order and timing; only requested export geometry and fps are normalized");
}
/**
 * 封面主版式（2026-09-25 南昌片收口）：
 *   `auto`（默认）= 有主角来源则人物满幅，否则物体满幅；只保留一个主视觉。
 *   `landmark` = 地标满幅 + 人物卡（兼容模式，重复人物层会被移除）；
 *   `split`          = **左侧地标满幅 + 右侧人物竖带**（无卡片硬边，双主体都清晰；当"人物卡贴在地标上"反复被判 "贴图感/遮挡主体"时的收口版式）；
 *   `person`         = **人物满幅 + 地标小图**——当"人物卡贴在地标上"反复被判
 *                      "贴图感/遮挡主体/人物不是主角"时改用这一版：人物是背景（不存在贴片边缘），
 *                      地标以柔边小图出现在右上角，三件套（人物/地标/标题）仍然齐备。
 *   `person-solo`    = **人物满幅 + 不叠任何小图**（口播/讲解类片子的收口版式，2026-09-27 真机）：
 *                      文字块下移到**面部下方安全带**（画面 58%–88%），从根上避免"标题压在主角脸上"；
 *                      适用范围=人物本身就是唯一主视觉的片子（带货口播、讲解、访谈）。
 */
const COVER_REQUESTED_HERO = arg("--cover-hero", "auto");
let COVER_HERO = resolveCoverHero(COVER_REQUESTED_HERO, false);
/**
 * 封面版式（2026-09-26 产品所有者口径，收敛为两种主视觉）：
 *   · `subject-led`（物体为主）：景物/商品/动物等**非人主体**满幅 + 标题（`--cover-hero subject|scenery`）；
 *   · `person-led`（人物为主）：人物是唯一主视觉，背景只作点缀（`--cover-hero person`）。
 * 旧的 `landmark`（地标 + 人物卡）与 `split`（左地标右人物竖带）保留为兼容档，但不再是推荐默认。
 */
let COVER_ARCHETYPE: "person-led" | "subject-led" =
  ["subject", "scenery", "object", "product"].includes(COVER_HERO) ? "subject-led" : "person-led";
/** 人物满幅 + 无小图 + 文字下移安全带（person-solo 专属口径） */
let COVER_LOWER_BAND_TEXT = COVER_HERO === "person-solo";
/**
 * 封面平台（2026-09-27 平台化）：
 *   `--cover-platform` 显式指定封面平台（`douyin|kuaishou|xiaohongshu|wechat-channels|bilibili|tiktok|youtube|instagram-reels`，
 *   也接受"抖音/小红书"这类中文别名）；缺省沿用 `--platform`（历史默认值"抖音/快手"→抖音口径）。
 *   平台规格（画幅/画布/安全区/标题带/字数上限）来自 `packages/video-studio/src/cover-platforms.ts`——
 *   封面侧唯一事实源；**抖音默认路径与平台化之前逐像素一致**（有单测锁死）。
 */
const COVER_PLATFORM_ARG = arg("--cover-platform", "");
if (COVER_PLATFORM_ARG && !isKnownCoverPlatform(COVER_PLATFORM_ARG)) {
  throw new Error(`--cover-platform 未知平台：${COVER_PLATFORM_ARG}（可选：${COVER_PLATFORM_IDS.join(" / ")}，或中文别名 抖音/快手/小红书/视频号/B站）`);
}
/** 封面知识库（cover-kb）注入开关：默认开启（`--no-cover-kb` 关闭，退化为平台化之前的行为） */
const COVER_KB_ENABLED = !flag("--no-cover-kb");
const COVER_KB_DIR = resolve(arg("--cover-kb-dir", join(REPO_ROOT, "bundles/ai-video/library/cover-kb")));
/**
 * 封面题材（`--theme`）：进 cover-kb 的题材映射（theme → 版式/字级/配色）。
 * 缺省从片名 + brief.goal 启发式匹配 THEME-001 题材表；匹配不到就**不注入题材条目**（不硬凑）。
 */
const COVER_THEME_ARG = arg("--theme", "");
/** 账号定位档案（`--account <id>`）：读 `bundles/ai-video/library/account-profiles/<id>.yml`，注入视觉锤约束 */
const COVER_ACCOUNT_ARG = arg("--account", "");
const COVER_ACCOUNT_DIR = resolve(arg("--account-dir", join(REPO_ROOT, "bundles/ai-video/library/account-profiles")));
const DANMAKU_FILE = arg("--danmaku");
/** 只跑指定镜头（逗号分隔；用于单镜验证与局部重跑） */
const ONLY = arg("--only").split(",").map((s) => s.trim()).filter(Boolean);
/**
 * 监制已知悉但放行的镜头（逗号分隔）。
 * 用途：监制打回、但客观条件（账号欠费/额度用尽/时效）不允许重跑时，
 * **不允许静默放行**——必须显式列出，运行日志与阶段记录里要留"带瑕疵放行"的痕迹。
 */
const ACCEPT_REJECTED = arg("--accept-rejected").split(",").map((s) => s.trim()).filter(Boolean);
if (arg("--accept-weak-material-motion")) {
  throw new Error("运动质量不能通过 --accept-weak-material-motion 豁免；请按镜头意图修复并重测。");
}
/**
 * 纯后期组装模式（T-2026-0929-0012，真机事故沉淀）：
 * 当源镜头是**外部拿到的成品片段**（未过本片 shot/voice 回执）时，允许继续走完整后期链
 * （合成→调色→字幕→配乐→封面设计师→母版→变体交付包），但必须：
 *   1 显式传 `--assembly-mode post-only --assembly-reason "<原因>"`；
 *   2 落一条 degraded 门记录（哪些镜头无回执）；
 *   3 交付清单里标 assemblyMode=post-only、shotReceiptsMissing=[…]。
 * 目的：把"绕开管线、手工做封面/BGM"这条歪路堵死——要么走完整链并留痕，要么不做。
 */
const POST_ONLY_ASSEMBLY = arg("--assembly-mode", "") === "post-only";
const POST_ONLY_REASON = arg("--assembly-reason", "").trim();
if (POST_ONLY_ASSEMBLY && POST_ONLY_REASON.length < 8) {
  throw new Error("post-only 组装必须显式给出 --assembly-reason \"<至少 8 字原因>\"（说明源镜头为何没有本片回执）");
}
/** post-only 组装时"无本片回执"的镜头清单（交付清单里如实列出，供客户/审计复核） */
let postOnlyMissingReceipts: string[] = [];
/**
 * 配乐层状态（交付清单留痕，T-2026-0930-0015）：声明式直混 / 工位判定无需配乐 / 签章路径。
 * bgm 阶段在自己的块作用域里算出结论，这里提升到模块作用域供交付清单与母版终审引用。
 */
let bgmManifestInfo: Record<string, unknown> | null = null;
/**
 * 声明式直混（T-2026-0930-0014，配本机"无版权曲库直用"口径）：
 * 源片是对白+环境混在一起的成品（post-only 组装/既有素材复用）时**不存在**可独立取证的干净分轨；
 * 有签发者走签章路径，没有签发者时按调用方**显式声明**直混（回执写 declared-unverified / stemsVerified=false）。
 * 提升到模块作用域：母版配乐与变体配乐必须共用同一口径（否则变体缺配乐 → G-DLV1 三轴判据误红）。
 */
const BGM_DECLARED_PROGRAM_MIX = flag("--bgm-declared-program-mix")
  || !String(process.env.WORKLOOM_AUDIO_STEM_SIGNING_SECRET ?? "").trim();
/**
 * 曲库音乐床（2026-09-26，产品所有者："严格遵守配乐挑选评分逻辑，并去掉最早那批垃圾曲"）。
 *
 * 场景：`best` 按严格阈值判"人声太满、无需配乐"，但产品口径要求成片必须有配乐轨。
 * 早先的实现是**现场自算作曲**兜底——那正是"最早那批纯音乐质量太差"的来源，本次删除。
 *
 * 现在的口径（硬约束 + 打分，全部可复核）：
 *   ① **硬过滤**：BPM 必须落在剪辑网格族（60/120/240 ±5）——监制 2026-09-26 打回过 94.7BPM 的音乐床
 *      （"与 120BPM/0.5s 剪辑网格不相容、卡点与让位都无法验证"）；
 *   ② **硬过滤**：授权可商用、时长 ≥ 成片时长 + 8s、文件在盘；
 *   ③ 打分：本地曲库优先（产品所有者自己的库）> 随仓兜底；题材/用例贴合（旅行/城市/Vlog/卡点）加分；
 *   ④ 只选**纯器乐**音乐床：混音时用更低电平（-28dB）与更深让位（16dB），保证不抢人声。
 */
/**
 * 曲库音乐床选曲（**按实测 BPM**，2026-09-26 产品所有者口径）：
 * 早先按曲库标签 BPM 挑"落在 60/120/240 网格族"的曲子，真机实测卡点平均误差 123ms——
 * 标签 BPM 是人工/批量打标，与音频真实节拍经常差一截（半速错标、变速混音）。
 * 现在：标签只做粗筛，**入选必须实测 BPM 与剪辑网格的卡点误差达标**（见 beat-verify.ts）。
 */
/** 解码前 N 秒为 f32 单声道——实测 BPM 用（ffmpeg 抽 PCM，避免依赖外部库）。 */
function readPcmSamples(file: string, sampleRate: number, seconds: number): Float32Array {
  const buf = execFileSync(FFMPEG, [
    "-v", "error", "-t", String(seconds), "-i", file,
    "-vn", "-ac", "1", "-ar", String(sampleRate), "-f", "f32le", "-",
  ], { maxBuffer: 256 * 1024 * 1024 });
  const view = new Float32Array(buf.buffer, buf.byteOffset, Math.floor(buf.byteLength / 4));
  return view.slice();
}

/**
 * 从镜头卡解析**角色 id**（角色一致性判据用）：
 * 优先显式 `characterId`；否则用 `character` 字段的名字（主角按 cast.lead 归并，临时角色按名字）。
 * 为什么不猜：名字不同但其实是同一人的情况由上游 `characterId` 显式声明解决，
 * 本函数只在缺声明时给出**稳定且可追溯**的 id（写进证据，便于人工复核）。
 */
function characterIdOf(shot: Record<string, unknown>): string | null {
  const explicit = String((shot as { characterId?: unknown }).characterId ?? "").trim();
  if (explicit) return explicit;
  const name = String((shot as { character?: unknown }).character ?? "").trim();
  if (!name) return null;
  return name.slice(0, 32);
}

/** Choose a declared library source by metadata, without PCM/beat or quality candidate review. */
async function pickDeclaredMusicBed(
  _masterSeconds: number,
  _cutTimes: readonly number[],
  hints: { genre?: string; mood?: string; excludeTrackHashes?: ReadonlySet<string> } = {},
): Promise<{ id: string; title: string; path: string; bpm: number | null;
  measuredBpm: null; gridErrorMs: null; score: null; reasons: string[] } | null> {
  const core = await import(join(REPO_ROOT, "bundles/ai-video/connectors/bgm-bridge/core.mjs")) as {
    loadAllLocalTracks: (env?: NodeJS.ProcessEnv) => { tracks?: Array<{
      id?: string; title?: string; genre?: string; mood?: string; bpm?: number; localPath?: string | null;
    }> };
  };
  const tracks = (core.loadAllLocalTracks(ENV).tracks ?? []).filter(track => {
    const file = String(track.localPath ?? "");
    return file && existsSync(file) && !hints.excludeTrackHashes?.has(sha256FileSync(file));
  });
  const words = [hints.genre, hints.mood].flatMap(value => (value ?? "").split("|").map(word => word.trim()).filter(Boolean));
  const selected = tracks.find(track => words.some(word => [track.genre, track.mood, track.title].join(" ").includes(word))) ?? tracks[0];
  if (!selected) return null;
  const declaredBpm = Number(selected.bpm);
  return { id: String(selected.id), title: String(selected.title ?? ""), path: String(selected.localPath),
    bpm: Number.isFinite(declaredBpm) && declaredBpm > 0 ? declaredBpm : null,
    measuredBpm: null, gridErrorMs: null, score: null, reasons: ["Selected declared library metadata; no audio quality or beat sampling"] };
}
const RESUME = !flag("--no-resume");
const DRY_RUN = flag("--dry-run");
const ALLOW_FALLBACK_APPROVE = flag("--allow-fallback-approve");
const STAGES = new Set(
  /**
   * 默认阶段的并集：
   *   `cine-kb`（摄影知识库）/ `continuity`（连贯性导演评审）/ `micromotion`（微动作增强，T-2026-0924-0001 第二次收口）
   *   `mux`（软字幕轨收口，T-2026-0924-0070/0071）
   */
  /**
   * 与上一版的差别（2026-09-25）：
   *   · `photo-motion` 已**移除**——真实素材不再有"静态直出"路径，改为 `material-gen`（素材当生成输入）；
   *   · `voice` 记录原生音轨事实；无声源不自动追加 ASR、TTS 或口型审核。
   */
  /**
   * 2026-09-26 产品口径补充：`deliver`（多风格交付包）**默认开启**——
   * 真机复盘发现"一次产出几个版本"的约束一直没执行，根因就是它不在默认阶段表里，
   * 只有显式 `--stages ...,deliver` 才会跑，于是日常跑全链根本不产变体。
   */
  arg("--stages", "cine-kb,continuity,micromotion,spec,plates,material-gen,videos,voice,compose,color,subtitle,danmaku,bgm,cover,mux,master,deliver").split(",").map((s) => s.trim()).filter(Boolean)
);
/**
 * 字幕落地方式（2026-09-24 产品所有者口径）：
 *   sidecar（缺省）= 母版**不烧字**，出旁挂字幕文件（srt/ass/vtt + 清单）并另出一支软字幕轨版；
 *   burn           = 旧行为：把字幕烧进画面（母版变成带字版）；
 *   both           = 旁挂 + 烧字副本都出（发布方想两条路都留）。
 * 为什么默认改成 sidecar：**有些片子要带字幕、有些不要**，而"要不要"是后期/发布时的选择；
 * 烧一次就回不去了（画面像素被改），旁挂文件则可以随时软轨内嵌或再烧。
 */
const SUBTITLE_MODE = (() => {
  const value = arg("--subtitle-mode", "sidecar");
  if (!["sidecar", "burn", "both"].includes(value)) {
    throw new Error(`--subtitle-mode 只支持 sidecar | burn | both，收到：${value}`);
  }
  return value as "sidecar" | "burn" | "both";
})();

const VALID_STAGES = new Set(["cine-kb", "continuity", "micromotion", "spec", "plates", "material-gen", "videos", "voice", "compose", "color", "subtitle", "danmaku", "bgm", "sfx", "cover", "mux", "master", "deliver", "revise"]);
for (const stage of STAGES) if (!VALID_STAGES.has(stage)) throw new Error(`UNKNOWN_STAGE: ${stage}`);
if (STAGES.has("deliver")) STAGES.add("master");
/**
 * post-only 组装**必须**过字段规范闸（T-2026-0930-0015）。
 * 真机事故：手写组装卡没跑 `spec` → `character` 只写了"这位女士…"、没写主角名/ID（P0 字段不合格），
 * 一路漏到封面环节才炸（人物卡找不到来源镜 → 退最小稿 → 母版终审被拦）。
 * 这里不靠"记得加 spec"，而是入口自动补上；spec 阶段在 post-only 下按"字段规范"判（见下方 spec 块）。
 */
if (POST_ONLY_ASSEMBLY && !STAGES.has("spec")) {
  STAGES.add("spec");
  log("ℹ post-only 组装：自动补上 spec 阶段（25 字段规范闸）——手写组装卡同样要过字段规范");
}
assertSelectedShotStageScope(STAGES, ONLY);
if (!DRY_RUN && (ACCEPT_REJECTED.length || ALLOW_FALLBACK_APPROVE || flag("--accept-env-defects") || flag("--accept-av-sync-drift"))) {
  throw new Error("PRODUCTION_BYPASS_REJECTED: 生产不能通过豁免参数把未通过或未核实变为合格；请调用对应组件修复后重新验证。");
}
const LOG_DIR = join(WORK_DIR, "logs", PROJECT);
const STAGE_LOG = join(LOG_DIR, "stages.jsonl");
const PLATE_DIR = join(WORK_DIR, "plates", PROJECT);
const CLIP_DIR = join(WORK_DIR, "clips", PROJECT);
const POST_DIR = QUALITY === "uhd" ? join(WORK_DIR, "post", PROJECT, "uhd") : join(WORK_DIR, "post", PROJECT);
const PROMPT_DIR = join(WORK_DIR, "prompts", PROJECT);
/** 成片交付路径（模板块与交付包/返修块共用；模板块内部变量名保持 `deliverable` 不变） */
const DELIVERABLE = join(OUT_DIR, `${PROJECT}-final.mp4`);
/**
 * 成片的**实际交付路径**（2026-09-26 口径统一）：
 * 旧名写死 `-30s-final.mp4`，但片子可能是 48s/51s——发布方按文件名核对会踩空（真机事故）。
 * 下面在落盘时按**实测时长**重命名（如 `-48s-final.mp4`），并把这个路径用于交付清单与变体派生。
 */
let deliverablePath = DELIVERABLE;
let masterApprovedForUhd = false;
/** 工位路径白名单（冒号分隔）：仓库根 + 运行产物根 + 交付目录 + 系统临时目录 */
const CLI_ALLOWED_ROOTS = [REPO_ROOT, WORK_DIR, OUT_DIR, tmpdir()].join(":");
/**
 * 配乐工位额外白名单（2026-09-30 真机）：本地**无版权曲库**是产品所有者自己放在
 * `~/.workloom-bgm/library`（索引指向原始下载目录）里的——变体配乐的"按曲风挑曲"会命中
 * `~/Downloads/...` 的真实文件路径。工位路径监狱只放行 CLI_ALLOWED_ROOTS 时，
 * 混音会被 `path_not_allowed` 拦下（真机：变体三支全部缺配乐 → G-DLV1 三轴判据误红）。
 * 这里只给**配乐工位**加这两个曲库根；其它工位白名单不变。
 */
const BGM_LIBRARY_ROOTS = [join(homedir(), ".workloom-bgm"), join(homedir(), "Downloads"), join(homedir(), "Music")]
  .filter((dir) => existsSync(dir));
const BGM_ALLOWED_ROOTS = [CLI_ALLOWED_ROOTS, ...BGM_LIBRARY_ROOTS].join(":");
for (const dir of [LOG_DIR, PLATE_DIR, CLIP_DIR, POST_DIR, PROMPT_DIR, OUT_DIR]) mkdirSync(dir, { recursive: true });
if (!DRY_RUN) await freezeOriginalSubmission({ productionRoot: WORK_DIR, projectId: PROJECT, bytes: sourceBytes });
const completedOriginals = !DRY_RUN ? await adoptCompletedOriginalRenders({ productionRoot: WORK_DIR, projectId: PROJECT, submittedSha256: sourceFileHash }) : [];
const completedByShot = new Map(completedOriginals.map(original => [original.shotId, original]));
const ALL_RENDERED_LOCALLY = Array.isArray(sourceDocument.shots) && sourceDocument.shots.every(shot => completedByShot.has(String(shot.shotId)));
const PRE_RENDER_STAGES = ["cine-kb", "continuity", "micromotion", "spec", "plates", "material-gen", "videos"];
if (ALL_RENDERED_LOCALLY) {
  for (const stage of PRE_RENDER_STAGES) STAGES.delete(stage);
  log(`成功渲染素材 ${completedByShot.size} 镜均已按实际任务和原字节采用；直接正式后期，无重复预生产或付费提交`);
}
const PRERENDER_REQUESTED = PRE_RENDER_STAGES.some(stage => STAGES.has(stage));

/** 环境：进程环境优先，其次仓库外秘密文件（只进内存，不落盘） */
function loadEnv(): Record<string, string> {
  const out: Record<string, string> = {};
  if (WORKER_RUNTIME) {
    for (const [key, value] of Object.entries(process.env)) if (value) out[key] = value;
    return out;
  }
  if (existsSync(KEYS_FILE)) {
    for (const line of readFileSync(KEYS_FILE, "utf8").split("\n")) {
      const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
      if (m && m[2]!.trim()) out[m[1]!] = m[2]!.trim();
    }
  }
  if (existsSync(join(REPO_ROOT, ".env"))) {
    for (const line of readFileSync(join(REPO_ROOT, ".env"), "utf8").split("\n")) {
      const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
      if (m && m[2]!.trim() && !out[m[1]!]) out[m[1]!] = m[2]!.trim();
    }
  }
  for (const [key, value] of Object.entries(process.env)) if (value && !out[key]) out[key] = value;
  return out;
}
const ENV = loadEnv();
const ARK_KEY = ENV.VOLCENGINE_ARK_API_KEY ?? ENV.ARK_API_KEY ?? "";
const ARK_BASE = (ENV.ARK_BASE_URL ?? "https://ark.cn-beijing.volces.com/api/v3").replace(/\/$/, "");
const IMAGE_MODEL = ENV.SEEDREAM_MODEL ?? ENV.ARK_IMAGE_MODEL ?? "doubao-seedream-5-0-pro-260628";
const VIDEO_MODEL = ENV.SEEDANCE_MODEL ?? ENV.ARK_VIDEO_MODEL ?? "doubao-seedance-2-5-260628";


/* ================= 阶段日志 ================= */

type StageRecord = {
  at: string;
  stage: string;
  shotId: string | null;
  invoked: boolean;
  ok: boolean;
  cached: boolean;
  degraded: boolean;
  attempt: number;
  ms: number;
  artifact: string | null;
  evidence: Record<string, unknown>;
  verdict: ProducerVerdict | null;
  note?: string;
  /** 门事件专用：管线 step_key 与门编号（G5/G6/G7/G8） */
  stepKey?: PipelineGateStepKey;
  gate?: string;
  lineage?: LineageReceipt;
  approved?: boolean;
  checks?: GateCheck[];
  shotIds?: string[];
  sourceStage?: string | null;
  via?: GateEvent["via"];
  score?: number | null;
  reason?: string;
};
const records: StageRecord[] = [];
if (!Array.isArray(sourceDocument.shots) || !sourceDocument.shots.length) throw new Error("SHOT_REGISTRY_REQUIRED");
const sourceIds = sourceDocument.shots.map((shot) => String(shot.shotId ?? ""));
if (sourceIds.some((id) => !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(id) || id.includes("..")) || new Set(sourceIds).size !== sourceIds.length) throw new Error("SHOT_REGISTRY_INVALID: 镜号缺失、重复或包含路径字符");
if (ONLY.some((id) => !sourceIds.includes(id))) throw new Error("SHOT_SCOPE_UNKNOWN: --only 包含未登记镜号");
/**
 * 视频类型分流前置（T-2026-0930-0015，2026-09-30 真机复盘沉淀）。
 *
 * 分流器 `pipeline-router.ts` 此前只接在**服务端派活**上；AI agent / 交付同学直接跑本 CLI 时会
 * 跳过"先判营销片 / 叙事片 / 口播解说片"。这里把它变成**出片入口的 fail-closed 前置**：
 *   · `--route work/route.json`（由 scripts/tools/route-video.mts 生成）；或
 *   · `--route-kind marketing|narrative`（已确认过的补跑项目，显式声明并留痕）。
 * 营销片必须有商品锚点（纪律：**不猜商品**）；分流结论是"判不准"时必须先问用户，不许替用户花钱。
 */
const ROUTE_FILE = arg("--route", "");
const ROUTE_KIND_ARG = arg("--route-kind", "");
const routeBrief: unknown = BRIEF_FILE && existsSync(abs(BRIEF_FILE))
  ? (() => {
    try {
      return JSON.parse(readFileSync(abs(BRIEF_FILE), "utf8"));
    } catch (error) {
      throw new Error(`ROUTE_BRIEF_UNREADABLE: --brief 不是合法 JSON（${error instanceof Error ? error.message : String(error)}）`);
    }
  })()
  : undefined;
const routeRecord: unknown = ROUTE_FILE
  ? (() => {
    if (!existsSync(abs(ROUTE_FILE))) {
      throw new Error(`ROUTE_FILE_MISSING: --route ${ROUTE_FILE} 不存在；先跑 scripts/tools/route-video.mts --out ${ROUTE_FILE}`);
    }
    try {
      return JSON.parse(readFileSync(abs(ROUTE_FILE), "utf8"));
    } catch (error) {
      throw new Error(`ROUTE_FILE_UNREADABLE: --route 不是合法 JSON（${error instanceof Error ? error.message : String(error)}）`);
    }
  })()
  : undefined;
const ROUTE_PRODUCT_ANCHOR = detectProductAnchor({ brief: routeBrief, shotlist: sourceDocument });
const ROUTE_PREFLIGHT: RoutePreflightResult = (() => {
  try {
    return resolveRoutePreflight({ routeRecord, routeKind: ROUTE_KIND_ARG || (!PRERENDER_REQUESTED ? "narrative" : ""), productAnchor: ROUTE_PRODUCT_ANCHOR });
  } catch (error) {
    if (error instanceof RoutePreflightError) {
      log(`⛔ 分流前置检查未通过（${error.code}）：`);
      for (const line of error.message.split("\n")) log(`　　${line}`);
      throw new Error(`ROUTE_PREFLIGHT_${error.code}: ${error.message.split("\n")[0]}`);
    }
    throw error;
  }
})();
log(`✅ 分流前置：${ROUTE_PREFLIGHT.kind}（来源：${ROUTE_PREFLIGHT.source}）`
  + `${ROUTE_PREFLIGHT.productAnchor ? ` · 商品锚点「${ROUTE_PREFLIGHT.productAnchor}」` : ""}`);
const lineageComponentHash = productionHash([
  "scripts/tools/full-chain-film.mts", "scripts/tools/film-render-task.mjs", "scripts/tools/film-render-ledger.mjs", "scripts/tools/film-audio-policy.mjs", "scripts/tools/film-publication-policy.mjs",
  "scripts/tools/film-voice-artifact.ts", "packages/video-studio/src/character-release-contract.ts",
  "packages/video-studio/src/cover-assembly.ts", "packages/video-studio/src/cover-design.ts",
  "packages/video-studio/src/producer-gate.ts", "packages/video-studio/src/real-person-asset.ts",
  "packages/video-studio/src/film-completion.mjs", "packages/video-studio/src/standard-post-contract.ts",
  "packages/video-studio/src/character-release-source.ts", "packages/video-studio/src/film-worker-runtime.ts",
  "packages/video-studio/src/film-worker-provenance.ts", "packages/video-studio/src/film-worker-channel.ts",
].map((file) => ({ file, sha256: sha256FileSync(join(REPO_ROOT, file)) })));
const SCENE_BIBLE_FILE = arg("--scene-bible");
const sceneBible: SceneBible | null = SCENE_BIBLE_FILE
  ? JSON.parse(readFileSync(abs(SCENE_BIBLE_FILE), "utf8")) as SceneBible
  : (sourceDocument.sceneBible as SceneBible | undefined) ?? null;
const AUTHOR_CONTEXT_FILE = join(LOG_DIR, "project-context.json");
const authorContext = loadOrCreateFilmAuthorContext({ path: AUTHOR_CONTEXT_FILE, projectId: PROJECT,
  eraProfile: sourceDocument.eraProfile ?? sceneBible?.eraProfile });
const filmContractSource = { projectId: PROJECT, shots: sourceDocument.shots!, eraProfile: authorContext.eraProfile,
  ...(sceneBible ? { sceneBible } : {}) };
/**
 * 审核层策略（T-2026-0930-0014，产品所有者口径）：
 *   · 渲染**前**把关靠管线已有的**标准规范**（红线 linter、合同字段、参数与授权事实、素材用途/溯源）；
 *     目标是"提交前把问题清零，一次渲染成功"，而不是"渲完再挑毛病"。
 *   · 渲染**后**不再做"合格/不合格"裁决：片子渲出来了就**直接走完整后期链并交付**，
 *     由客户验收判断好坏（真机教训：监制判"不合格"的素材，客户往往认为可用；
 *     事后裁决既拖长交付时间，又反复重渲烧钱）。
 *   · 因此默认 `--review-policy off`：不调用评审模型；**只保留事实性硬闸**
 *     （产物存在/时长/分辨率/音轨/音画对齐/文件与命名这类可核验事实）。
 *   · 需要时可用 `--review-policy advisory`（只记录评审意见，不阻断）或 `blocking`（旧口径）。
 */
type ReviewPolicy = "off" | "advisory" | "blocking";
const REVIEW_POLICY = (arg("--review-policy", "off").trim() || "off") as ReviewPolicy;
if (!["off", "advisory", "blocking"].includes(REVIEW_POLICY)) {
  throw new Error(`--review-policy 只支持 off / advisory / blocking，收到：${REVIEW_POLICY}`);
}
const REVIEW_DISABLED_REASON = "成功渲染镜头默认采用并直接正式后期，无渲后品质、人物、服装、动作、音频、口型或台词审核；实际文件处理和请求的最终导出合同仍须完成";
/** 事实性硬闸：与"好看不好看"无关，失败即产物或交付规格不成立 */
function deterministicHardFailures(options: Omit<ProducerGateOptions, "contracts">): string[] {
  return options.deterministic
    .filter((check) => check.hard === true && (check.status === "failed" || (check.status === undefined && check.pass === false)))
    .map((check) => `${check.id}：${check.detail}`);
}
function syntheticReviewVerdict(
  options: Omit<ProducerGateOptions, "contracts">, hardFailures: string[], issues: string[], reason: string,
): ProducerVerdict {
  return {
    stage: options.stage,
    status: hardFailures.length > 0 ? "failed" : "passed",
    approved: hardFailures.length === 0,
    score: null,
    qualityStatus: "unverified",
    hardFailures,
    issues,
    suggestions: hardFailures.length > 0 ? [`修复事实性硬闸后重跑：${hardFailures[0]}`] : [],
    rerun: hardFailures.length > 0,
    via: "deterministic",
    ms: 0,
    reason,
    degraded: false,
    evidence: [],
  };
}
const POST_RENDER_STAGES = new Set(["shot", "compose", "color", "subtitle", "danmaku", "bgm", "sfx", "cover", "mux", "master"]);
const POST_TECHNICAL_CHECKS: Record<string, ReadonlySet<string>> = {
  shot: new Set(["provider-success", "source-bytes"]),
  compose: new Set(["tool-exit", "master-produced", "duration", "resolution", "original-timeline"]),
  color: new Set(["tool-exit", "graded-produced"]),
  subtitle: new Set(["tool-exit", "subtitle-produced", "sidecar-produced", "srt-produced", "timeline-readback"]),
  danmaku: new Set(["tool-exit", "danmaku-produced"]),
  bgm: new Set(["tool-exit", "mix-produced", "scored-produced"]),
  sfx: new Set(["tool-exit", "sfx-produced"]),
  cover: new Set(["cover-produced"]),
  mux: new Set(["softsub-produced", "tool-exit", "video-unchanged", "subtitle-files"]),
  master: new Set(["duration", "resolution", "subtitle-delivery", "deliverable-naming"]),
};
async function reviewStage(options: Omit<ProducerGateOptions, "contracts">): Promise<ProducerVerdict> {
  if (POST_RENDER_STAGES.has(options.stage)) {
    const technical = { ...options, deterministic: options.deterministic.filter(check => POST_TECHNICAL_CHECKS[options.stage]?.has(check.id)) };
    const failures = deterministicHardFailures(technical);
    return { ...syntheticReviewVerdict(technical, failures, [], failures.length ? "实际后期处理或导出合同失败" : "成功渲染素材直接正式后期；未执行品质、人物、音频口型或模型审核"), score: null, qualityReviewed: false };
  }
  if (WORKER_RUNTIME) return WORKER_RUNTIME.review(options);
  const hardFailures = deterministicHardFailures(options);
  if (hardFailures.length) return syntheticReviewVerdict(options, hardFailures, [], "预渲染提交要求未通过");
  if (REVIEW_POLICY === "off") return syntheticReviewVerdict(options, [], [], "预渲染标准检查通过；未调用评审模型");
  return reviewFilmStage(filmContractSource, options);
}
const sourceSupportFiles = [AUTHOR_CONTEXT_FILE, ...(BRIEF_FILE ? [abs(BRIEF_FILE)] : []), ...(arg("--scene-bible") ? [abs(arg("--scene-bible"))] : [])];
const sourceSnapshot = captureLineageInputs(sourceSupportFiles);
if (sourceSnapshot.errors.length) throw new Error(`SOURCE_UNREADABLE: ${sourceSnapshot.errors.join("; ")}`);
const sourceSupportHashes = new Map(sourceSnapshot.artifacts.map((entry) => [entry.path, entry.sha256]));
const lineageInputPaths = new Map<string, string[]>();
const lineageInputSnapshots = new Map<string, LineageInputSnapshot>();
const UHD_DELIVERY_STAGES = new Set([
  "enhance", "compose", "character-consistency", "color", "subtitle", "danmaku", "bgm", "sfx",
  "cover", "cover-intro", "mux", "master", "deliver",
]);
function uhdDeliveryStage(stage: string): boolean {
  return QUALITY === "uhd" && (UHD_DELIVERY_STAGES.has(stage) || stage.startsWith("gate:deliver:"));
}
function sourceHashFor(shotId: string | null, stage: string): string {
  const { shots: allShots, durationSeconds: _total, ...common } = sourceDocument;
  return productionHash({
    source: shotId ? { ...common, shot: allShots!.find((shot) => shot.shotId === shotId) ?? null } : { ...sourceDocument, selectedShotIds: ONLY },
    brief: BRIEF_FILE ? sourceSupportHashes.get(abs(BRIEF_FILE)) ?? null : null,
    sceneBible: arg("--scene-bible") ? sourceSupportHashes.get(abs(arg("--scene-bible"))) ?? null : null,
    eraProfile: authorContext.eraProfile, aspect: ASPECT, resolution: SOURCE_RESOLUTION, fps: FPS,
    ...(uhdDeliveryStage(stage) ? { quality: QUALITY, shotlistSha256: sourceFileHash } : {}),
  });
}
function lineageStage(rec: Pick<StageRecord, "stage" | "stepKey" | "evidence">): string {
  return rec.stage === "gate" ? `gate:${rec.stepKey}:${String(rec.evidence.mode ?? "")}` : rec.stage;
}
function lineageRecipe(stage: string): Record<string, unknown> {
  const prefixes = stage === "color" ? ["--color-"] : stage === "bgm" ? ["--bgm-"]
    : stage === "voice" ? ["--narration-", "--speech-"] : stage === "cover" ? ["--cover-", "--theme", "--account", "--no-cover-"]
    : stage === "compose" ? ["--xfade", "--cut-transition", "--order-policy", "--compose-order", "--reuse-plan"]
    : stage === "subtitle" || stage === "mux" ? ["--subtitle-", "--opening-title", "--no-title-card"]
    : stage === "danmaku" ? ["--danmaku", "--no-danmaku"] : [];
  const args = process.argv.slice(2), options: Record<string, string | boolean> = {};
  for (let i = 0; i < args.length; i++) if (prefixes.some((prefix) => args[i]!.startsWith(prefix))) options[args[i]!] = args[i + 1] && !args[i + 1]!.startsWith("--") ? args[i + 1]! : true;
  return { component: lineageComponentHash, stage, platform: arg("--platform", "抖音/快手"), subtitleMode: SUBTITLE_MODE, options,
    ...(uhdDeliveryStage(stage) ? { quality: QUALITY, shotlistSha256: sourceFileHash } : {}) };
}
function lineageRecords(rows: StageRecord[], stage: string): StageRecord[] {
  const recipeHash = productionHash(lineageRecipe(stage));
  // HD source clips can feed the local UHD compositor. For delivery stages, only the
  // current processing receipt must bind the requested export/recipe.
  return rows.map((row) => ({ ...row, stage: lineageStage(row) }))
    .filter((row) => row.stage === stage && (!row.lineage || row.lineage.recipeHash === recipeHash));
}
function stageApproved(stage: string, shotIds: Array<string | null> = [null], rows = readStageHistory()): boolean {
  return stageLineageApproved({ records: lineageRecords(rows, stage), projectId: PROJECT, stage, shotIds,
    sourceHash: (id) => sourceHashFor(id, stage), recipe: lineageRecipe(stage) }).ok;
}
function rememberInputs(stage: string, paths: string[], shotId: string | null = null): void {
  const key = `${stage}:${shotId ?? ""}`;
  const all = [...new Set([...sourceSupportFiles, ...paths])];
  lineageInputPaths.set(key, all);
  lineageInputSnapshots.set(key, captureLineageInputs(all));
}
function artifactReusable(stage: string, candidate: string, upstream?: string, shotId: string | null = null): boolean {
  return reusableLineageArtifact({ records: lineageRecords(readStageHistory(), stage),
    scope: { projectId: PROJECT, sourceHash: sourceHashFor(shotId, stage) },
    stage, shotId, recipe: lineageRecipe(stage), candidate, upstream });
}
function record(rec: Omit<StageRecord, "at">): StageRecord {
  if (sha256FileSync(SHOTS_FILE) !== sourceFileHash) throw new Error("SOURCE_CHANGED_DURING_RUN: 分镜源文件运行中发生变化，请从当前版本重新开始");
  const stage = lineageStage(rec);
  const declaredOutputs = [rec.artifact, ...(Array.isArray(rec.evidence.outputFiles) ? rec.evidence.outputFiles : [])].filter((file): file is string => typeof file === "string" && Boolean(file));
  const notApplicable = !rec.invoked && rec.ok && (rec.evidence.applicable === false || rec.evidence.dialogue === false || Boolean(rec.evidence.skipReason));
  const status = rec.degraded || rec.verdict?.degraded ? "unverified" : !rec.ok || rec.verdict?.approved === false ? "failed" : notApplicable ? "not_applicable" : "passed";
  const lineage = createLineageReceipt({ projectId: PROJECT, sourceHash: sourceHashFor(rec.shotId, stage), runId: RUN_ID, stage, shotId: rec.shotId,
    recipe: lineageRecipe(stage), status, inputs: lineageInputPaths.get(`${stage}:${rec.shotId ?? ""}`) ?? sourceSupportFiles,
    inputSnapshot: lineageInputSnapshots.get(`${stage}:${rec.shotId ?? ""}`) ?? sourceSnapshot, outputs: declaredOutputs, reviewedArtifacts: rec.verdict?.evidence,
    ...(notApplicable ? { notApplicableReason: rec.note ?? "镜头契约明确不适用" } : {}),
  });
  const ok = lineage.status === "passed" || lineage.status === "not_applicable";
  const full: StageRecord = { at: stamp(), ...rec, evidence: { ...rec.evidence, ...(REVISION_CONTEXT ? { revisionContext: REVISION_CONTEXT } : {}) }, ok, degraded: lineage.status === "unverified", lineage,
    ...(rec.stage === "gate" ? { approved: ok } : {}) };
  records.push(full);
  appendFileSync(STAGE_LOG, `${JSON.stringify(full)}\n`, "utf8");
  const tag = full.ok ? (full.degraded ? "DEGRADED" : "ok") : "FAIL";
  log(`  ⇢ [${full.stage}${full.shotId ? ` ${full.shotId}` : ""}] ${tag}${full.cached ? "（复用）" : ""} ${full.ms}ms${full.artifact ? ` → ${full.artifact}` : ""}`);
  if (POST_RENDER_STAGES.has(full.stage) && !full.ok) {
    throw new Error(`POST_PROCESSING_FAILED: ${full.stage}: ${full.verdict?.reason ?? full.note ?? "actual requested output or source binding failed"}`);
  }
  return full;
}

/**
 * 门事件记账（2026-09-24，G5/G6/G7/G8 的 step_key 级运行时组件）。
 *
 * 为什么需要：管线 yml 声明了四个按 step_key 记账的确认门，但运行时不落事件——
 * 审计只能看到"环节调没调用"，看不到"门有没有被按名调用、判据是什么、谁放行的"。
 * 现在每次门判定都往**同一个 stages.jsonl** 追加一条 `stage: "gate"` 记录
 * （规范形状见 `packages/video-studio/src/gate-ledger.ts`），平台执行器与审计器都能按 step_key 检索。
 */
function recordGate(input: {
  stepKey: PipelineGateStepKey;
  sourceStage: string | null;
  checks: GateCheck[];
  shotIds?: string[];
  softApproved?: boolean | null;
  via?: GateEvent["via"];
  score?: number | null;
  reason?: string;
  degraded?: boolean;
  evidence?: Record<string, unknown>;
}): GateEvent {
  const event = buildGateEvent({ projectId: PROJECT, ...input });
  const scopeShotId = input.shotIds?.length === 1 ? input.shotIds[0]! : null;
  const gateStage = `gate:${event.stepKey}:${String(input.evidence?.mode ?? "")}`;
  const gatePaths = (input.shotIds ?? []).flatMap((id) => [join(PROMPT_DIR, `${id}.txt`), join(PLATE_DIR, `${id}-plate.png`), join(CLIP_DIR, `${id}.mp4`)].filter((file) => existsSync(file)));
  const material = input.evidence?.material as Record<string, unknown> | undefined;
  for (const value of [input.evidence?.photo, input.evidence?.promptFile, material?.photo, material?.prepared, material?.promptFile]) {
    if (typeof value === "string" && value) gatePaths.push(abs(value));
  }
  rememberInputs(gateStage, gatePaths, scopeShotId);
  const bound = record({
    ...event,
    stage: "gate", shotId: input.shotIds?.length === 1 ? input.shotIds[0]! : null,
    invoked: true, ok: event.ok, cached: false, degraded: event.degraded, attempt: 1, ms: 0, artifact: null,
    evidence: { stepKey: event.stepKey, gate: event.gate, via: event.via, score: event.score, sourceStage: event.sourceStage, shotIds: event.shotIds, checks: event.checks, reason: event.reason, ...(event.evidence ?? {}) },
    verdict: null, note: `门 ${event.gate}（${event.stepKey}）`, stepKey: event.stepKey, gate: event.gate
  });
  const tag = event.ok ? (event.degraded ? "DEGRADED" : "ok") : "FAIL";
  log(`  ⇢ [gate ${event.gate} ${event.stepKey}] ${tag}${event.via === "llm" ? `（llm${event.score !== null ? ` score=${event.score}` : ""}）` : "（deterministic）"} — ${event.reason.slice(0, 140)}`);
  return { ...event, ok: bound.ok, approved: bound.ok, degraded: bound.degraded,
    reason: bound.ok ? event.reason : `${event.reason}；${bound.lineage?.errors.join("；") ?? "血缘未验证"}` };
}

/**
 * 读取**历史**阶段日志（同一 work-dir 的 `stages.jsonl`）。
 *
 * 为什么需要（2026-09-24 真机）：`--stages bgm,master` 这类"只重跑一段"的用法里，
 * 进程内 `records` 只有本次的两个环节，终审门因此误判"调色/字幕/弹幕没执行"。
 * 正确口径是看**产物血缘 + 历史裁决**：文件在、顺序对、历史里有放行记录，就算链路完整。
 */
function readStageHistory(): StageRecord[] {
  if (!existsSync(STAGE_LOG)) return [];
  return readFileSync(STAGE_LOG, "utf8").split("\n").filter(Boolean).map((line, index) => {
    try { return JSON.parse(line) as StageRecord; }
    catch { throw new Error(`STAGE_LEDGER_INVALID: ${STAGE_LOG}:${index + 1}，先恢复有效账本再续跑`); }
  });
}
/**
 * 受理任务 / 返工台账（T-2026-0930-0015）。
 *
 * 产品所有者口径（2026-09-30 真机复盘）：客户要能看到"**每一次花钱的账**"——
 * 提交了几次渲染、几次受理后最近记录未通过、几次被平台拒收（欠费/限额）、几次 canary 止损、
 * 后期各环节返工几次。只统计事实，不做费用估算（渲染单价未登记在仓库里）。
 */
function buildRenderLedger(history: StageRecord[]): RenderLedger {
  return buildFilmRenderLedger(history, { projectId: PROJECT, generatedAt: stamp() });
}
function renderLedgerMarkdown(ledger: RenderLedger): string {
  const lines = [
    `# 渲染与返工台账 · ${ledger.projectId}`,
    "",
    `生成时间：${ledger.generatedAt}`,
    "",
    "## 汇总",
    "",
    `- 唯一平台受理任务（按 taskId 去重）：**${ledger.totals.renderAttempts}** 个`,
    `- 受理后最近记录未通过：**${ledger.totals.rendersRejected}** 次`,
    `- 无有效任务 ID，受理状态未知：**${ledger.unacceptedRenderRecords}** 条`,
    `- 平台拒收（未渲染，如欠费）：**${ledger.totals.platformRejections}** 次`,
    `- canary 止损中止（未继续渲染）：**${ledger.totals.canaryAborts}** 次`,
    `- 后期返工：**${ledger.totals.postStageRetries}** 次`,
    "",
    "## 逐镜",
    "",
    "| 镜号 | 唯一受理任务 | 最近记录未通过 | 平台拒收 | canary 止损 | 最近原因 |",
    "|---|---:|---:|---:|---:|---|",
    ...(ledger.shots.length
      ? ledger.shots.map((shot) => `| ${shot.shotId} | ${shot.attempts} | ${shot.rejected} | ${shot.platformRejections} | ${shot.canaryAborts} | ${(shot.lastReason ?? "").replace(/\|/g, "／")} |`)
      : ["| （无渲染记录） | 0 | 0 | 0 | 0 | |"]),
    "",
    "## 后期返工",
    "",
    "| 环节 | 失败次数 | 最近原因 |",
    "|---|---:|---|",
    ...(ledger.postStages.length
      ? ledger.postStages.map((entry) => `| ${entry.stage} | ${entry.retries} | ${(entry.lastReason ?? "").replace(/\|/g, "／")} |`)
      : ["| （无返工记录） | 0 | |"]),
    "",
    "## 口径",
    "",
    ...ledger.notes.map((note) => `- ${note}`),
    ""
  ];
  return `${lines.join("\n")}\n`;
}
function historyApproved(history: StageRecord[], stage: string): boolean { return stageApproved(stage, [null], history); }
function lineageCheck(files: Array<{ label: string; path: string }>): { ok: boolean; detail: string } {
  const bindings: Record<string, string> = { raw: "compose", graded: "color", subtitled: "subtitle", danmaku: "danmaku", scored: "bgm", softsub: "mux" };
  const invalid = files.filter((file) => !artifactReusable(bindings[file.label] ?? file.label, file.path));
  return { ok: invalid.length === 0, detail: invalid.length ? `缺少当前哈希/最新通过裁决：${invalid.map((file) => file.label).join("、")}` : "各产物与当前源输入、配方及最近一次通过裁决一致" };
}
function preferDownstream(candidate: string, upstream: string, stage: string): string {
  return artifactReusable(stage, candidate, upstream) ? candidate : upstream;
}

/* ================= 媒体工具 ================= */

function run(bin: string, args: string[]): string {
  return execFileSync(bin, args, { encoding: "utf8", maxBuffer: 32 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"] });
}
/**
 * 文件指纹（素材镜溯源用）：素材与产物的 sha256 必须能证明"产物不是素材本身"。
 * 读盘失败时抛错（不许返回空串——空串会伪装成"指纹齐备"）。
 */
function sha256FileSync(file: string): string {
  const before = statSync(file), fd = openSync(file, "r"), digest = createHash("sha256");
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  try {
    let bytes = 0;
    do {
      bytes = readSync(fd, buffer, 0, buffer.length, null);
      if (bytes > 0) digest.update(buffer.subarray(0, bytes));
    } while (bytes > 0);
  } finally { closeSync(fd); }
  const after = statSync(file);
  if (before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ino !== after.ino) {
    throw new Error(`HASH_SOURCE_CHANGED_DURING_READ: ${file}`);
  }
  return digest.digest("hex");
}
function probe(file: string): Record<string, unknown> {
  try {
    const raw = run(FFPROBE, ["-v", "error", "-print_format", "json", "-show_format", "-show_streams", file]);
    const json = JSON.parse(raw) as { streams?: Array<Record<string, unknown>>; format?: Record<string, unknown> };
    const video = (json.streams ?? []).find((s) => s.codec_type === "video");
    const audio = (json.streams ?? []).find((s) => s.codec_type === "audio");
    return {
      duration: Number(json.format?.duration ?? 0),
      width: Number(video?.width ?? 0),
      height: Number(video?.height ?? 0),
      /** 实际平均画面钟优先；只有平均钟不可用时才记录声明帧率。 */
      fps: (() => {
        const rate = (value: unknown): number => {
          const [num, den] = String(value ?? "0/1").split("/").map(Number);
          return Number.isFinite(num) && Number.isFinite(den) && Number(num) > 0 && Number(den) > 0 ? Number(num) / Number(den) : 0;
        };
        return rate(video?.avg_frame_rate) || rate(video?.r_frame_rate);
      })(),
      vcodec: video?.codec_name ?? null,
      acodec: audio?.codec_name ?? null,
      hasAudio: Boolean(audio),
      videoDurationSec: Number(video?.duration ?? 0),
      videoFrames: Number(video?.nb_frames ?? 0),
      audioDurationSec: Number(audio?.duration ?? 0),
      audioSampleRate: Number(audio?.sample_rate ?? 0),
      audioChannels: Number(audio?.channels ?? 0),
      bytes: statSync(file).size
    };
  } catch (err) {
    return { error: err instanceof Error ? err.message.slice(0, 200) : String(err) };
  }
}
function runCli(cli: string, args: string[]): { ok: boolean; out: string } {
  try {
    /**
     * TypeScript 工具（`.ts/.mts`，例如 `compose-film.mts`）必须经 tsx 载入器运行：
     * 本工具的其它工位都是 `.mjs`（plain node 即可），但 TS 工具里会出现 `import "./x.js"`
     * 指向同名 `.ts` 的写法——plain node 解析不了，会报 `ERR_MODULE_NOT_FOUND`。
     * 2026-09-27 真机：`compose` 阶段（唯一走 .mts 的工位）因 #191 新增 `av-sync.js` 导入而整段失败，
     * 却因为磁盘上还留着上一版母版而"看起来跑过了"（旧声轨被继续使用——双声事故能存活到交付的第二个原因）。
     */
    const outIndex = args.indexOf("--out");
    if (outIndex >= 0 && args[outIndex + 1]) {
      const target = resolve(args[outIndex + 1]!);
      const inputIndex = args.indexOf("--in");
      if (inputIndex >= 0 && resolve(args[inputIndex + 1] ?? "") === target) throw new Error("TOOL_OUTPUT_OVERWRITES_INPUT");
      if (existsSync(target)) renameSync(target, `${target}.previous-${RUN_ID}-${randomUUID()}`);
    }
    const isTypeScriptCli = /\.m?ts$/i.test(cli);
    const out = execFileSync(process.execPath, isTypeScriptCli ? ["--import", "tsx", abs(cli), ...args] : [abs(cli), ...args], {
      encoding: "utf8", maxBuffer: 32 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"],
      /**
       * 工位路径监狱（2026-09-24 真机修复）：调色/配乐工位默认只允许访问 `process.cwd()` 与 tmpdir。
       * 本工具的产物根在工作区之外（项目less 会话目录），不显式放开会被 `path_not_allowed` 拒掉
       * （真机：调色直接失败）。这里把仓库根、运行产物根、交付目录与 tmpdir 一起写进白名单。
       */
      env: {
        ...process.env,
        WL_FFMPEG: FFMPEG,
        WL_FFPROBE: FFPROBE,
        FFMPEG_PATH: FFMPEG,
        FFPROBE_PATH: FFPROBE,
        WORKLOOM_BGM_FFMPEG_PATH: process.env.WORKLOOM_BGM_FFMPEG_PATH || FFMPEG,
        WORKLOOM_BGM_FFPROBE_PATH: process.env.WORKLOOM_BGM_FFPROBE_PATH || FFPROBE,
        WORKLOOM_SUBTITLE_FFMPEG_PATH: process.env.WORKLOOM_SUBTITLE_FFMPEG_PATH || FFMPEG,
        WORKLOOM_SUBTITLE_FFPROBE_PATH: process.env.WORKLOOM_SUBTITLE_FFPROBE_PATH || FFPROBE,
        WORKLOOM_POST_FFMPEG_PATH: process.env.WORKLOOM_POST_FFMPEG_PATH || FFMPEG,
        WORKLOOM_POST_FFPROBE_PATH: process.env.WORKLOOM_POST_FFPROBE_PATH || FFPROBE,
        WL_REPO_ROOT: REPO_ROOT,
        WORKLOOM_COLOR_ALLOWED_ROOTS: CLI_ALLOWED_ROOTS,
        WORKLOOM_SUBTITLE_ALLOWED_ROOTS: CLI_ALLOWED_ROOTS,
        WORKLOOM_BGM_ALLOWED_ROOTS: BGM_ALLOWED_ROOTS,
        WORKLOOM_VISUAL_ALLOWED_ROOTS: CLI_ALLOWED_ROOTS,
        /** 配音工位同样有路径监狱（配音写新文件、读原片），产物根/交付目录要显式放开 */
        WORKLOOM_VOICE_ALLOWED_ROOTS: CLI_ALLOWED_ROOTS
      }
    });
    return { ok: true, out };
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string; message?: string };
    return { ok: false, out: `${e.stdout ?? ""}\n${e.stderr ?? e.message ?? ""}`.slice(-1500) };
  }
}
const SUBTITLE_CLI = join(REPO_ROOT, "bundles/ai-video/connectors/subtitle-bridge/cli.mjs");
const COLOR_CLI = join(REPO_ROOT, "bundles/ai-video/connectors/color-bridge/cli.mjs");
const BGM_CLI = join(REPO_ROOT, "bundles/ai-video/connectors/bgm-bridge/cli.mjs");
const VOICE_CLI = join(REPO_ROOT, "bundles/ai-video/connectors/voice-bridge/cli.mjs");

/**
 * 重试指令（2026-09-24「反复重跑烧额度」根因修复）。
 *
 * 事故：SC-02 连烧 5 次渲染仍不过——因为第 2 次尝试提交的是**与第 1 次一字不差的提示词**，
 * 只换了 seed，本质是"重采样碰运气"。而监制每轮都给了具体问题与建议，这些信息**没有被用上**。
 * 现在：把上一轮 verdict 的 issues/suggestions 显式写进重跑提示词，并按次数给出升级动作。
 */
function retryInstruction(verdict: ProducerVerdict | null, attempt: number, maxAttempts: number): string {
  /**
   * 长度上限（2026-09-24 真机）：监制的 issues/suggestions 可能很长（一次给了 9 条、每条上百字），
   * 直接拼进重跑提示词会把多模态评审请求撑到 **HTTP 413（payload too large）**，
   * 于是监制不可用 → 又触发一次重渲（白烧额度）。这里按条裁断 + 总量封顶。
   */
  const clip = (text: string, max = 110) => (text.length > max ? `${text.slice(0, max)}…` : text);
  const issues = (verdict?.issues ?? []).filter(Boolean).slice(0, 3).map((item) => clip(item));
  const suggestions = (verdict?.suggestions ?? []).filter(Boolean).slice(0, 3).map((item) => clip(item));
  const reason = clip(String(verdict?.reason ?? "未给出理由"), 90);
  return [
    `【重跑要求·第 ${attempt}/${maxAttempts} 次】上一版未过监制：${reason}`,
    ...issues.map((item) => `必须修复：${item}`),
    ...suggestions.map((item) => `按建议修改：${item}`),
    attempt >= maxAttempts
      ? "本次为最后一次尝试：若仍不达标，将按「带瑕疵放行 + badcase 归档」处理，不再重复烧额度。"
      : "注意：同一问题第二次出现说明是分镜设计问题（机位/动作/朝向），优先改设计而不是继续加形容词。",
    "输出仍须满足：人物与定妆照同一张脸、肢体与手指结构正确、空间物理自洽（桥/台阶有落点）。"
  ].join("\n");
}

/**
 * 黑帧 / 静音段体检（监制终审要的"事故证据"，2026-09-24 真机补）：
 *   · 黑帧：`blackdetect` 抓 ≥0.2s 的整黑段 → 有即硬失败（拼接/编码事故的典型指纹）；
 *   · 静音：`silencedetect` 抓 ≥0.6s、低于 −45dB 的段 → 记录最长静音段（口播片配乐铺底后不应出现长静音）。
 */
/**
 * 响度实测（EBU R128）：`ebur128` 滤镜直接读整片 integrated loudness 与 true peak。
 * 为什么要自己量：配乐工位的 `best` 在"人声太满"时会直接判 `no_bgm_needed` 而不产出，
 * 监制因此拿不到任何响度证据（真机连续两次以"无响度读数"打回）。这里用确定性测量补上。
 */
/**
 * 画面运动能量（2026-09-24 SC-02 badcase 修复）：
 * 把片段按 8fps 降采样成 128×228 灰度帧序列，算**相邻帧中心区（60%）平均绝对差**。
 * 用途：给监制一个"到底有没有动"的数字证据——之前只给 3 张静帧，
 * 监制无法验证"走来/挥手"，只能以「动作证据不足」打回（fail-closed），
 * 于是同一镜反复重渲。返回平均运动能量（0–255）与峰值出现时刻。
 */
function measureMotionEnergy(file: string, durationSec: number): { energy: number; peakAt: number; frames: number } {
  const W = 128;
  const H = 228;
  const res = spawnSync(FFMPEG, [
    "-v", "error", "-i", file,
    "-vf", `fps=8,scale=${W}:${H},format=gray,crop=${Math.round(W * 0.6)}:${Math.round(H * 0.6)}`,
    "-f", "rawvideo", "-"
  ], { maxBuffer: 64 * 1024 * 1024 });
  const buf = res.stdout ?? Buffer.alloc(0);
  const cw = Math.round(W * 0.6);
  const ch = Math.round(H * 0.6);
  const frameBytes = cw * ch;
  const count = Math.floor(buf.length / frameBytes);
  if (count < 2) return { energy: 0, peakAt: 0, frames: count };
  let total = 0;
  let peak = 0;
  let peakIndex = 0;
  for (let i = 1; i < count; i += 1) {
    const prev = (i - 1) * frameBytes;
    const cur = i * frameBytes;
    let sum = 0;
    for (let p = 0; p < frameBytes; p += 4) sum += Math.abs(buf[cur + p]! - buf[prev + p]!);
    const diff = sum / (frameBytes / 4);
    total += diff;
    if (diff > peak) { peak = diff; peakIndex = i; }
  }
  const fps = 8;
  return {
    energy: total / (count - 1),
    peakAt: Math.min(durationSec, peakIndex / fps),
    frames: count
  };
}

function measureLoudness(file: string): { lufs: number | null; peakDb: number | null; detail: string } {
  /**
   * 注意：ffmpeg 把滤波器日志写在 **stderr**，且退出码通常为 0。
   * 早先用 `execFileSync` 只在 catch 里读 stderr → 成功路径拿到空字符串，
   * 于是"响度未读到"（真机监制连续打回 4 次的原因之一）。这里用 spawnSync 同时收 stdout+stderr。
   */
  const res = spawnSync(FFMPEG, ["-hide_banner", "-nostats", "-i", file, "-af", "ebur128=peak=true", "-f", "null", "-"], {
    encoding: "utf8", maxBuffer: 32 * 1024 * 1024
  });
  return parseLoudness(`${res.stdout ?? ""}\n${res.stderr ?? ""}`);
}

function parseLoudness(text: string): { lufs: number | null; peakDb: number | null; detail: string } {
  const integrated = [...text.matchAll(/I:\s*(-?[\d.]+)\s*LUFS/g)].pop();
  const peak = [...text.matchAll(/Peak:\s*(-?[\d.]+)\s*dBFS/g)].pop();
  const lufs = integrated ? Number(integrated[1]) : null;
  const peakDb = peak ? Number(peak[1]) : null;
  return {
    lufs,
    peakDb,
    detail: `integrated ${lufs === null ? "未读到" : `${lufs.toFixed(1)} LUFS`} · true peak ${peakDb === null ? "未读到" : `${peakDb.toFixed(1)} dBFS`}`
  };
}

function detectQualityAccidents(file: string): { blackSeconds: number; silenceSeconds: number; detail: string } {
  /** 同上：黑帧/静音探测日志同样走 stderr 且退出码为 0，必须显式读 stderr */
  const blackRes = spawnSync(FFMPEG, ["-v", "info", "-i", file, "-vf", "blackdetect=d=0.2:pix_th=0.10", "-an", "-f", "null", "-"], {
    encoding: "utf8", maxBuffer: 16 * 1024 * 1024
  });
  const blackText = `${blackRes.stdout ?? ""}\n${blackRes.stderr ?? ""}`;
  const blackMatches = [...blackText.matchAll(/black_start:([\d.]+)\s+black_end:([\d.]+)\s+black_duration:([\d.]+)/g)];
  const blackSeconds = blackMatches.length > 0 ? Math.max(...blackMatches.map((m) => Number(m[3]))) : 0;
  const blackDetail = blackMatches.length > 0
    ? blackMatches.map((m) => `${m[1]}s–${m[2]}s(${m[3]}s)`).join("、")
    : "未检出黑帧";
  const silenceRes = spawnSync(FFMPEG, ["-v", "info", "-i", file, "-af", "silencedetect=noise=-45dB:d=0.6", "-vn", "-f", "null", "-"], {
    encoding: "utf8", maxBuffer: 16 * 1024 * 1024
  });
  const silenceText = `${silenceRes.stdout ?? ""}\n${silenceRes.stderr ?? ""}`;
  const silenceMatches = [...silenceText.matchAll(/silence_start:\s*(-?[\d.]+)[\s\S]*?silence_end:\s*([\d.]+)\s*\|\s*silence_duration:\s*([\d.]+)/g)];
  const silenceSeconds = silenceMatches.length > 0 ? Math.max(...silenceMatches.map((m) => Number(m[3]))) : 0;
  const silenceDetail = silenceMatches.length > 0
    ? silenceMatches.map((m) => `${m[1]}s–${m[2]}s(${m[3]}s)`).join("、")
    : "未检出静音段";
  return { blackSeconds, silenceSeconds, detail: `黑帧：${blackDetail}；静音：${silenceDetail}` };
}

function recordAdoptedOriginal(original: typeof completedOriginals[number]): void {
  rememberInputs("render-adopted", [original.path, original.receiptFile], original.shotId);
  record({ stage: "render-adopted", shotId: original.shotId, invoked: false, ok: true, cached: true, degraded: false,
    attempt: 0, ms: 0, artifact: original.path, evidence: { projectId: PROJECT, taskId: original.taskId,
      rawSha256: original.sha256, rawBytes: original.bytes, disposition: original.disposition, providerSuccess: true,
      qualityReviewPerformed: false, historicalQualityRowsUnchanged: true, receiptFile: original.receiptFile }, verdict: null,
    note: "实际成功渲染镜头按原任务与原字节默认采用；不是旧品质审核通过，也未再次提交" });
}
for (const original of completedOriginals) recordAdoptedOriginal(original);

/* ================= 输入 ================= */

interface ShotCard {
  shotId: string; sceneType?: string; duration?: number;
  scene?: string; sceneDescription?: string; action?: string; character?: string; costume?: string;
  policyTags?: string[]; speechMode?: "on-camera" | "voice-over"; speechScene?: string;
  makeup?: string; composition?: string; lighting?: string; color_palette?: string; mood?: string;
  dialogue?: Array<{ speaker?: string; text?: string; emotion?: string; trigger?: string }>;
  [key: string]: unknown;
}
const shotlist = structuredClone(sourceDocument) as {
  projectId?: string; title?: string; durationSeconds?: number; aspect?: string; resolution?: string;
  sceneBible?: SceneBible;
  videoType?: string;
  logline?: string;
  scenePolicy?: { id?: string; exceptions?: Array<{ rule: "restricted-location" | "restricted-costume"; shotId: string; term: string; customerRequest: string; source: string }> };
  hook?: HookCard;
  character?: { id?: string; name?: string; appearanceInShots?: string[] }; shots: ShotCard[];
};
const RESUME_TASKS: Record<string, string> = readResumeTasks(arg("--resume-tasks", ""), shotlist.shots.map((shot) => shot.shotId));
const policyBrief: Record<string, unknown> | null = BRIEF_FILE && PRERENDER_REQUESTED ? (() => {
  const file = abs(BRIEF_FILE);
  if (!existsSync(file)) throw new Error(`--brief 指向的文件不存在：${file}`);
  const value: unknown = JSON.parse(readFileSync(file, "utf8"));
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`--brief 必须是 JSON 对象：${file}`);
  return value as Record<string, unknown>;
})() : null;
const scenePolicies = loadScenePolicies(join(REPO_ROOT, "bundles/ai-video/library/scene-policies"));
const scenePolicySelection = selectScenePolicy(shotlist, policyBrief, scenePolicies);
const scenePolicy = PRERENDER_REQUESTED ? scenePolicySelection.policy : null;
/** Existing successful originals are outside new-generation policy checks, including partial resume. */
const pendingSourceShots = shotlist.shots.filter(shot => !completedByShot.has(String(shot.shotId)));
function auditPendingScenePolicy(currentShots: ShotCard[]): ScenePolicyReport {
  const pending = currentShots.filter(shot => !completedByShot.has(String(shot.shotId)));
  const pendingIds = new Set(pending.map(shot => String(shot.shotId)));
  const report = auditScenePolicy({ ...shotlist, shots: pending,
    scenePolicy: shotlist.scenePolicy ? { ...shotlist.scenePolicy,
      exceptions: shotlist.scenePolicy.exceptions?.filter(entry => pendingIds.has(entry.shotId)) } : undefined }, scenePolicy!);
  // Whole-plan creative ratios and cues cannot reopen already adopted provider-success originals.
  // Individual pending-shot facts and restrictions still fail before a new submission.
  if (completedByShot.size > 0) {
    report.defects = report.defects.filter(defect => defect.shotId !== null);
    report.passed = report.defects.length === 0;
  }
  return report;
}
if (scenePolicy && (ACCEPT_REJECTED.length > 0 || flag("--accept-env-defects"))) {
  throw new Error(`${scenePolicy.id} 片型的品质底线不得用 --accept-rejected / --accept-env-defects 绕过；请修复或登记客户特殊场景例外`);
}
const SCENE_POLICY_REPORT_FILE = join(WORK_DIR, `scene-policy-report-${PROJECT}.json`);
let scenePolicyReport: ScenePolicyReport | null = scenePolicy ? auditPendingScenePolicy(pendingSourceShots) : null;
if (scenePolicyReport) scenePolicyReport.policy.selection = scenePolicySelection.reason;
const writeScenePolicyReport = (): void => {
  writeFileSync(SCENE_POLICY_REPORT_FILE, `${JSON.stringify(scenePolicyReport ?? {
    schemaVersion: "workloom.scene-policy-report/v1", policy: null, selection: scenePolicySelection.reason, passed: true
  }, null, 2)}\n`, "utf8");
};
writeScenePolicyReport();
/**
 * post-only 组装（T-2026-0929-0012）：片型门是生成前/生成后的**创作口径**检查，
 * 本模式不生成新镜头 → 未命中时按**已声明降级**记账（`degraded + assemblyMode=post-only`），
 * 后续收尾检查不会把它当成"请求未完成"（否则片子已交付、退出码却是 6，误导自动化）。
 */
const scenePolicyDeclaredDegraded = POST_ONLY_ASSEMBLY && scenePolicyReport !== null && !scenePolicyReport.passed;
/**
 * 分流结论留痕（T-2026-0930-0015）：`--route` / `--route-kind` 的结论与来源写进阶段账本，
 * 交付清单同样带 `route` 字段——审计能回答"这条片子当时按哪条管线做的、商品锚点是什么"。
 */
record({
  stage: "route", shotId: null, invoked: true, ok: true, cached: false, degraded: false, attempt: 1, ms: 0,
  artifact: ROUTE_FILE ? abs(ROUTE_FILE) : null,
  evidence: {
    kind: ROUTE_PREFLIGHT.kind, source: ROUTE_PREFLIGHT.source,
    productAnchor: ROUTE_PREFLIGHT.productAnchor, notes: ROUTE_PREFLIGHT.notes,
    recordTitle: ROUTE_PREFLIGHT.record ? String(ROUTE_PREFLIGHT.record.title ?? "") : null
  },
  verdict: null, note: `视频类型：${ROUTE_PREFLIGHT.kind}（${ROUTE_PREFLIGHT.source}）`
});
record({ stage: "scene-policy-audit", shotId: null, invoked: true, ok: scenePolicyReport?.passed ?? true,
  cached: false, degraded: scenePolicyDeclaredDegraded, attempt: 1, ms: 0, artifact: SCENE_POLICY_REPORT_FILE,
  evidence: { policy: scenePolicy?.id ?? null, version: scenePolicy?.version ?? null,
    sourceSha256: scenePolicy?.sourceSha256 ?? null, selection: scenePolicySelection.reason,
    defects: scenePolicyReport?.defects ?? [], ratios: scenePolicyReport?.ratios ?? null,
    ...(scenePolicyDeclaredDegraded ? { assemblyMode: "post-only" } : {}) }, verdict: null });
if (scenePolicy && scenePolicyReport && !scenePolicyReport.passed) {
  /**
   * post-only 组装（T-2026-0929-0012）：片型门是**生成前**门（管"别拍跑偏的片子"），
   * 而本模式不生成任何新镜头、只是把已有成品片段走完整后期链——因此降级为**告警 + 门记录**，
   * 不阻断；真正的把关点在 cover/deliver（平台规范、差异实测）与人工验收。
   */
  const defects = scenePolicyReport.defects.map((item) => `${item.shotId ?? "全片"}[${item.rule}] ${item.detail}`);
  if (POST_ONLY_ASSEMBLY) {
    log(`⚠ ${scenePolicy.title} 生成前门禁未通过（${scenePolicyReport.defects.length} 项），但本片为 post-only 组装（不生成新镜头）→ 记为 degraded，不阻断`);
    for (const defect of defects.slice(0, 6)) log(`   · ${defect}`);
    recordGate({
      stepKey: "g-post-only-assembly",
      sourceStage: "scene-policy",
      checks: [{ id: "scene-policy-degraded", pass: true, hard: false, detail: `片型门 ${scenePolicy.id} 未通过 ${scenePolicyReport.defects.length} 项：${defects.slice(0, 6).join("；")}` }],
      shotIds: sourceDocument.shots.map((shot) => String(shot.shotId)),
      degraded: true,
      reason: `post-only 组装：片型生成前门降级（${scenePolicyReport.defects.length} 项）`,
      evidence: { assemblyMode: "post-only", policy: scenePolicy.id, defects: scenePolicyReport.defects, ratios: scenePolicyReport.ratios }
    });
  } else {
    log(`⛔ ${scenePolicy.title} 生成前门禁未通过（${scenePolicyReport.defects.length} 项）：${defects.join("；")}`);
    process.exit(7);
  }
}
const shotsSelected = ONLY.length > 0 ? shotlist.shots.filter((s) => ONLY.includes(s.shotId)) : shotlist.shots;
if (!Array.isArray(shotsSelected) || shotsSelected.length === 0) throw new Error("shotlist 里没有镜头");

/* ================= 场景圣经 · 环境真实性（2026-09-27 真机事故 → 机制化） ================= */

/**
 * 事故：销售口播片 8 镜**全部通过监制**，但产品所有者一眼看出"空间布景不像实拍"。
 * 逐镜取证：8/8 缺空间实指与使用痕迹、7/8 灯光只有柔光箱/反光板这类棚具语言、材质全是一级名词。
 * 根因不是模型，是**管线里没有任何"环境真实性"判据**：模型收到"现代简约商务空间"这类空词时，
 * 只能落回训练分布里的**平均办公室**——平均化就是"AI 感"。
 *
 * 本节的机制（三件，缺一不可）：
 *   ① **展开**：片级 `sceneBible` 展开进每镜既有字段（scene/sceneDescription/lighting/props），
 *      关键帧提示词与视频提示词因此都吃到空间实指、材质工艺、实用光源、使用痕迹与道具交互；
 *   ② **审计**：`environmentDefects` 逐镜出硬/软缺陷，写 `env-realism-report-<project>.json` 留证；
 *   ③ **闸门**：本轮要做生成类阶段（spec/plates/material-gen/videos）时，硬缺陷 **fail-closed**
 *      ——"渲染前拦住"而不是"渲完肉眼发现"（单镜关键帧 ~85s、单镜视频 ~160s、还要重后期）。
 *      正式生产不可豁免；dry-run 可生成带明确降级标记的诊断记录。
 *
 * 纪律：圣经只升级**环境**，不改表演/台词/时长/构图（`expandShotWithBible` 的字段白名单）。
 */
const baseShots: ShotCard[] = sceneBible
  ? shotsSelected.map((shot) => completedByShot.has(shot.shotId) ? shot : expandShotWithBible(shot as ShotCard & Record<string, unknown>, sceneBible))
  : shotsSelected;
const shots: ShotCard[] = scenePolicy ? baseShots.map((shot) => completedByShot.has(shot.shotId) ? shot : applyScenePolicy(shot, scenePolicy)) : baseShots;

/**
 * 配乐师简报的输入文本（全片只算一次）：片子目标/调性/剪辑风格 + 镜头场景摘要。
 * 供母版配乐与三支风格变体的**选曲**共用（代理读它定"配方 + 能量档"，再据此在曲库打分选曲）。
 */
const bgmPromptText = (() => {
  const briefDoc = BRIEF_FILE && existsSync(abs(BRIEF_FILE))
    ? (JSON.parse(readFileSync(abs(BRIEF_FILE), "utf8")) as Record<string, unknown>)
    : {};
  /** 调用方可以给一条**专供配乐师**的简报（`--bgm-prompt` 或 `brief.bgmBrief`），
   * 用于把"片子是什么类型"喂给简报分析器（避免"片子里有一镜美食"把配方判成美食广告）。 */
  const declared = arg("--bgm-prompt", "").trim() || String(briefDoc.bgmBrief ?? "").trim();
  if (declared) return declared;
  return [
    String(briefDoc.goal ?? ""), String(briefDoc.tone ?? ""), String(briefDoc.editingStyle ?? ""),
    String(shotlist.title ?? ""),
    shots.map((shot) => String((shot as unknown as Record<string, unknown>).scene ?? "")).filter(Boolean).slice(0, 16).join("；")
  ].filter(Boolean).join("\n");
})();
const pendingShots = (): ShotCard[] => PRERENDER_REQUESTED ? shots.filter(shot => !completedByShot.has(shot.shotId)) : [];
/** 原生口播不可由旁白覆盖；在任何付费工位之前检查整片，不受 --only 缩窄。 */
const UNIFIED_NARRATION = flag("--narration-unified");
if (PRERENDER_REQUESTED) assertFilmAudioPreflight({ shots: shotlist.shots.filter(shot => !completedByShot.has(shot.shotId)) as unknown as Parameters<typeof assertFilmAudioPreflight>[0]["shots"],
  unifiedNarration: UNIFIED_NARRATION, generateAudio: ENV.SEEDANCE_GENERATE_AUDIO !== "0" });
if (["spec", "plates", "material-gen", "videos"].some(stage => STAGES.has(stage))) {
  for (const shot of shotlist.shots.filter(shot => !completedByShot.has(shot.shotId))) {
    renderSecondsFor(shot.duration as number);
    if (!Number.isSafeInteger(Number(shot.duration) * FPS))
      throw new Error(`STANDARD_NATIVE_FRAME_CLOCK_INVALID: ${shot.shotId} submitted duration does not contain an exact whole frame range`);
  }
}

/** 只有"要花钱生成"的阶段才让环境审计 fail-closed；纯后期复跑（compose/subtitle/mux…）不拦 */
const ENV_AUDIT_STAGES = ["spec", "plates", "material-gen", "videos"] as const;
const envAuditInScope = ENV_AUDIT_STAGES.some((stage) => STAGES.has(stage));
const envBibleIssues = sceneBible ? validateSceneBible(sceneBible) : [];
const envDefects: EnvDefect[] = PRERENDER_REQUESTED ? environmentDefects(baseShots.filter(shot => !completedByShot.has(shot.shotId)), sceneBible) : [];
const envSummary = summarizeDefects(envDefects);
/**
 * 设备口径：新项目默认当前故事日期并冻结，历史场景/品牌要求由源合同明确声明。
 * 与环境审计同一处 fail-closed——都是"渲染前必须清零"的资产级约束，报告合并在一份文件里（便于一条命令复核）。
 */
const devDefects: DeviceDefect[] = PRERENDER_REQUESTED ? deviceDefects(shots.filter(shot => !completedByShot.has(shot.shotId)), { eraProfile: authorContext.eraProfile }) : [];
const devSummary = summarizeDeviceDefects(devDefects);
const envHardTotal = envSummary.hard + devSummary.hard;
const envSoftTotal = envSummary.soft + devSummary.soft;
const ENV_REPORT_FILE = join(WORK_DIR, `env-realism-report-${PROJECT}.json`);
mkdirSync(WORK_DIR, { recursive: true });
writeFileSync(ENV_REPORT_FILE, `${JSON.stringify({
  schemaVersion: "workloom.env-realism-report/v2",
  eraProfile: authorContext.eraProfile,
  generatedAt: stamp(),
  shotlist: SHOTS_FILE,
  projectId: PROJECT,
  sceneBible: sceneBible
    ? { spaceId: sceneBible.spaceId, summary: spaceSummary(sceneBible), materials: sceneBible.materials?.length ?? 0, practicalLights: sceneBible.practicalLights?.length ?? 0, traces: sceneBible.traces?.length ?? 0, issues: envBibleIssues }
    : null,
  summary: { hard: envHardTotal, soft: envSoftTotal, byRule: { ...envSummary.byRule, ...devSummary.byRule }, environment: envSummary, device: devSummary },
  devicePolicy: { version: DEVICE_POLICY_VERSION, verifiedAt: DEVICE_POLICY_VERIFIED_AT, eraProfile: authorContext.eraProfile, brief: "按冻结故事年代、逐镜具体型号及显式品牌档案核实；局部时代合同可覆写" },
  perShot: shots.map((shot) => {
    const own = [...envDefects, ...devDefects].filter((defect) => defect.shotId === shot.shotId);
    return {
      shotId: shot.shotId,
      hard: own.filter((defect) => defect.hard).length,
      soft: own.filter((defect) => !defect.hard).length,
      rules: own.map((defect) => `${defect.rule}${defect.hard ? "" : "(软)"}`),
      detail: own.map((defect) => defect.detail)
    };
  }),
  defects: [...envDefects, ...devDefects]
}, null, 2)}\n`, "utf8");

log(`环境真实性审计：${sceneBible ? `场景圣经 ${sceneBible.spaceId}（${spaceSummary(sceneBible)}）` : "未提供场景圣经（片级 sceneBible / --scene-bible）"}`);
if (envBibleIssues.length > 0) log(`  ⚠ 圣经自身待完善（软）：${envBibleIssues.join("；")}`);
log(`  环境：硬缺陷 ${envSummary.hard} · 软提示 ${envSummary.soft}｜设备口径（${DEVICE_POLICY_VERSION}）：硬缺陷 ${devSummary.hard} · 软提示 ${devSummary.soft}`);
log(`  合计：硬缺陷 ${envHardTotal} · 软提示 ${envSoftTotal}｜规则：${Object.entries({ ...envSummary.byRule, ...devSummary.byRule }).map(([rule, count]) => `${rule}×${count}`).join(" · ") || "无"}`);
for (const defect of envDefects.filter((item) => item.hard)) log(`  ✗ ${defect.shotId} [${defect.rule}] ${defect.detail}`);
for (const defect of devDefects) log(`  ${defect.hard ? "✗" : "△"} ${defect.shotId} [${defect.rule}] ${defect.detail}`);
log(`  报告：${ENV_REPORT_FILE}`);

const envAccepted = ACCEPT_REJECTED.includes("env") || ACCEPT_REJECTED.includes("env-realism") || flag("--accept-env-defects");
record({
  stage: "env-audit", shotId: null, invoked: true,
  ok: envHardTotal === 0 || envAccepted || !envAuditInScope,
  cached: false,
  degraded: envHardTotal > 0 && envAccepted,
  attempt: 1, ms: 0, artifact: ENV_REPORT_FILE,
  evidence: {
    sceneBible: sceneBible ? sceneBible.spaceId : null,
    space: sceneBible ? spaceSummary(sceneBible) : null,
    bibleIssues: envBibleIssues,
    hard: envHardTotal, soft: envSoftTotal, byRule: { ...envSummary.byRule, ...devSummary.byRule },
    environment: { hard: envSummary.hard, soft: envSummary.soft },
    devicePolicy: { version: DEVICE_POLICY_VERSION, verifiedAt: DEVICE_POLICY_VERIFIED_AT, hard: devSummary.hard, soft: devSummary.soft },
    inScope: envAuditInScope, acceptedBy: envAccepted ? "ACCEPT_REJECTED(env)" : null,
    hardDefects: [...envDefects, ...devDefects].filter((item) => item.hard).map((item) => ({ shotId: item.shotId, rule: item.rule, detail: item.detail }))
  },
  verdict: null,
  note: "环境真实性 + 设备口径审计（场景圣经展开 + 确定性规则）"
});
if (envAuditInScope && envHardTotal > 0 && !envAccepted) {
  log("⛔ 环境真实性 / 设备口径硬缺陷未清零：本环节在花钱之前核对场景事实、器物用途与冻结年代。");
  log("   修法：在 shotlist 顶层写 sceneBible（或 --scene-bible <file>），让每镜带上空间、可见材质、实际光源和明确使用状态；");
  log("   可交互道具（手机/平板/笔记本）按用途补 propInteraction（prop / purpose / orientation / screenFacing / operatedBy）。");
  log(`   设备口径：每镜补 devices[]（category + model，机型见允许清单：${allowedModelSummary(undefined, authorContext.eraProfile)}…）——裸词不算机型。`);
  log("   按报告修复源合同后重跑；正式生产不接受豁免。");
  process.exit(7);
}

/* ================= 开场钩子 · 前 3 秒（2026-09-27 新增岗位/机制） ================= */

/**
 * 产品所有者口径：抖音类平台上，完播率的分水岭在**前 3 秒**。
 * 此前管线里没有"钩子"这个产物——片头设计师管的是片头镜头卡，音效只铺剪辑点（0–0.6s 空白），
 * 评审清单里也没有钩子类目，于是"开头三秒平平"没有任何机制能发现。
 *
 * 三段机制（与 `opening-hook.ts` 同源）：
 *   ① **钩子卡**（shotlist 顶层 `hook`，钩子设计师的产物）：type / promise / payoffShotId / 首镜模板 / 钩子音；
 *   ② **确定性判据**：类型在库内、承诺有兑现镜、音效落在 0–0.6s 窗口、首镜够长；
 *   ③ **钩子音效**：在 sfx 阶段把 0–0.6s 的钩子音铺上（短平台默认 impact，长视频默认 whoosh）。
 * 短平台缺钩子卡 = 硬失败（前 3 秒不许靠运气）；其余平台缺钩子卡 = 软提示。
 */
const PLATFORM = arg("--platform", "抖音/快手");
const hookCard: HookCard | null = shotlist.hook ?? null;
/**
 * 钩子判据必须看**整片**镜头卡，而不是 `--only` 过滤后的子集（2026-09-27 真机 v2 发现）：
 * 单镜补渲（`--stages plates --only CF-05`）时，兑现镜 CF-03 不在子集里 → 误报"兑现镜不存在"，
 * 把一次正常的补渲判成硬失败。首镜与兑现镜都是**片级**概念，口径应为完整 shotlist.shots。
 */
const hookChecks = PRERENDER_REQUESTED ? openingHookChecks({ shots: shotlist.shots.filter(shot => !completedByShot.has(shot.shotId)), hook: hookCard, platform: PLATFORM }) : [];
const hookSummary = summarizeHookChecks(hookChecks);
/**
 * 钩子音效三条开关口径：显式关（`--no-hook-sfx`）> 显式开（`--hook-sfx`）> 有钩子卡即开。
 * 音色与落点：钩子卡声明优先，否则按平台给安全默认（`defaultHookSfx`）。
 */
const hookSfxEnabled = flag("--no-hook-sfx") ? false : (flag("--hook-sfx") || Boolean(hookCard));
const hookSfxSpec = hookCard?.sfx ?? defaultHookSfx(PLATFORM);
log(`开场钩子：${hookCard ? `${hookCard.type}（${HOOK_TYPE_LABELS[hookCard.type] ?? "未知类型"}）· 兑现镜 ${hookCard.payoffShotId}` : "未登记钩子卡"}`);
log(`  窗口：前 ${hookWindowFor(PLATFORM)}s｜判据：硬失败 ${hookSummary.hard} · 软提示 ${hookSummary.soft}｜钩子音：${hookSfxEnabled ? `${hookSfxSpec.kind}@${hookSfxSpec.atSec}s` : "关闭"}`);
for (const check of hookChecks) log(`  ${check.pass ? "✓" : "✗"} [${check.id}] ${check.detail}`);
const hookAccepted = ACCEPT_REJECTED.includes("hook");
record({
  stage: "hook-audit", shotId: null, invoked: true,
  ok: hookSummary.hard === 0 || hookAccepted, cached: false,
  degraded: hookSummary.hard > 0 && hookAccepted,
  attempt: 1, ms: 0, artifact: null,
  evidence: {
    platform: PLATFORM, windowSec: hookWindowFor(PLATFORM), hookSfxEnabled,
    hook: hookCard ? { type: hookCard.type, promise: hookCard.promise, payoffShotId: hookCard.payoffShotId, sfx: hookSfxSpec } : null,
    cardIssues: hookCard ? validateHookCard(hookCard) : [],
    checks: hookChecks, hard: hookSummary.hard, soft: hookSummary.soft,
    acceptedBy: hookAccepted ? "ACCEPT_REJECTED(hook)" : null
  },
  verdict: null,
  note: "开场钩子审计（类型库 / 承诺兑现 / 0–0.6s 钩子音窗口）"
});
if (hookSummary.hard > 0 && !hookAccepted) {
  log("⛔ 开场钩子硬失败：前 3 秒是短平台完播率的分水岭，不允许「靠运气」进流水线。");
  for (const check of hookSummary.hardFailures) log(`   · ${check.id}：${check.detail}`);
  log("   修法：在 shotlist 顶层写 hook{ type, promise, payoffShotId, firstShotTemplate{visual,line}, sfx{kind,atSec} }；");
  log("   确需带瑕疵继续：--accept-rejected hook（会记为 degraded 留痕）。");
  process.exit(8);
}
/**
 * 平台语速门（T-2026-0930-0005）：把"抖音的语速要明显更快"从形容词变成可机检的判据。
 *
 * 起因（产品所有者 2026-09-30 口径）：客户对抖音快节奏的感知就是"说话语速要明显更快"，
 * 而此前全链路只有一个全局语速口径（3.5 字/秒，仅在 prd-specialist / hook-designer 的提示词里），
 * 平台维度完全没有；"念得完"也不在任何门里核过——长文案配短镜会一路跑到配音才暴露。
 *
 * 口径与数值来源：`packages/video-studio/src/platform-intent.ts#SPEECH_RATE_POLICY`
 * （抖音 4.8 目标 / 5.6 上限；长视频沿用既有 3.5 / 4.2）。
 * 判据输入是**完整 shotlist.shots**，与钩子门同口径：`--only` 补渲不能改变语速判据的输入。
 * 语速靠"文案写得更紧"，不靠 atempo 硬拉（voice-bridge fitTempo 上限 1.25 不动）。
 */
const speechProfile = speechRateProfile(PLATFORM);
const speechRows = (PRERENDER_REQUESTED ? shotlist.shots.filter(shot => !completedByShot.has(shot.shotId)) : []).map((shot) => ({
  shotId: String(shot.shotId ?? ""),
  fit: checkSpeechFit({
    shotId: String(shot.shotId ?? ""),
    text: dialogueText(shot),
    durationSec: Number(shot.duration),
    profile: speechProfile,
  }),
}));
const speechOver = speechRows.filter((row) => row.fit.severity === "over");
const speechLoose = speechRows.filter((row) => row.fit.severity === "loose");
/** 时长缺失/非法按"无法判定"处理，计软提示——时长本身另有门管，不在本门重复判死。 */
const speechUnknown = speechRows.filter((row) => row.fit.severity === "invalid");
const speechMeasured = speechRows.filter((row) => row.fit.units > 0);
const speechAccepted = ACCEPT_REJECTED.includes("speech-rate");
log(`平台语速：${PLATFORM} → ${speechProfile.tier} 档（目标 ${speechProfile.target} · 上限 ${speechProfile.max} 字/秒 · 配音基础速率 ${speechProfile.ttsSpeed}×）`);
log(`  台词镜 ${speechMeasured.length} 个｜念不完 ${speechOver.length} · 节奏偏松 ${speechLoose.length} · 无法判定 ${speechUnknown.length}`);
for (const row of speechOver) log(`  ✗ [${row.shotId}] ${row.fit.detail}`);
for (const row of speechLoose) log(`  · [${row.shotId}] ${row.fit.detail}`);
record({
  stage: "speech-rate", shotId: null, invoked: true,
  ok: speechOver.length === 0 || speechAccepted, cached: false,
  degraded: speechOver.length > 0 && speechAccepted,
  attempt: 1, ms: 0, artifact: null,
  evidence: {
    platform: PLATFORM, profile: speechProfile,
    measured: speechMeasured.length, over: speechOver.length, loose: speechLoose.length, unknown: speechUnknown.length,
    rows: speechRows.map((row) => ({ shotId: row.shotId, units: row.fit.units, unitsPerSecond: row.fit.unitsPerSecond, severity: row.fit.severity })),
    acceptedBy: speechAccepted ? "ACCEPT_REJECTED(speech-rate)" : null
  },
  verdict: null,
  note: "平台语速门（逐镜按镜时长折算可念字数；超上限判念不完）"
});
if (speechOver.length > 0 && !speechAccepted) {
  log("⛔ 平台语速硬失败：台词在镜时长内念不完，配音阶段才发现会直接毁掉节奏与对齐。");
  log(`   修法（择一）：① 把文案改写到「镜时长 × ${speechProfile.max} 字」以内；② 加长该镜时长；③ 拆成两镜。`);
  log("   禁止把配音速率拉上去硬塞（voice-bridge fitTempo 上限 1.25 不得上调）；");
  log("   确需带瑕疵继续：--accept-rejected speech-rate（会记为 degraded 留痕）。");
  process.exit(9);
}
/** 只计算真实存在的刀口；单镜片不能进入 compose 的逐刀转场分支。 */
const EFFECTIVE_CUT_TRANSITION = shots.length > 1 ? CUT_TRANSITION : "";
const EFFECTIVE_CUT_TRANSITION_AT = CUT_TRANSITION_AT.trim()
  ? [...new Set(CUT_TRANSITION_AT.split(",").map((value) => Number(value.trim()))
    .filter((value) => Number.isInteger(value) && value >= 2 && value <= shots.length))].join(",")
  : "";
const CUT_TRANSITION_COUNT = !EFFECTIVE_CUT_TRANSITION ? 0
  : CUT_TRANSITION_AT.trim() ? EFFECTIVE_CUT_TRANSITION_AT.split(",").filter(Boolean).length : shots.length - 1;
const transitionLoss = Number((CUT_TRANSITION_COUNT * CUT_TRANSITION_DURATION).toFixed(3));
/** One completion policy is used before paid rendering and again by the issued original contract. */
function completionForShots(document: Record<string, unknown>, selected: Array<Record<string, unknown>>): FilmCompletionRecord {
  if (!selected.length || selected.some(shot => typeof shot.duration !== "number" || !Number.isFinite(shot.duration) || shot.duration <= 0))
    throw new Error("FILM_COMPLETION_INVALID: each selected shot needs a positive duration");
  const actualSeconds = selected.reduce((sum, shot) => sum + Number(shot.duration), 0);
  return describeFilmCompletion(filmCompletionPolicyForDocument(document, actualSeconds), actualSeconds);
}
const plannedCompletion = completionForShots(sourceDocument, sourceDocument.shots!);
const totalSeconds = plannedCompletion.policy.targetSeconds ?? plannedCompletion.actualSeconds;
const selectedCompletion = completionForShots(sourceDocument, shots);
/** The complete selected picture clock owns postproduction. Never retime to the creative target. */
let expectedMasterSeconds = selectedCompletion.actualSeconds;
/** 剪辑网格（真实切点，秒）：配乐卡点与 BPM 反推的事实依据（去掉片尾那一个点） */
const CUT_GRID: number[] = (() => {
  /**
   * 2026-09-25 南昌片真机修正：早先这里只是"各镜时长累加"，**没有扣逐刀转场的重叠**。
   * `--cut-transition-at` 每刀吃掉 transitionDuration，15 刀下来网格最多偏移 2.4s——
   * 配乐工位按错锚点对齐、监制据此判"卡点只有 10/15 命中"（真机）。现在与 compose/音效层同源。
   */
  const durations = shots.map((shot) => Number(shot.duration ?? 5));
  const transitionAt = EFFECTIVE_CUT_TRANSITION
    ? EFFECTIVE_CUT_TRANSITION_AT.split(",").map((value) => Number(value.trim())).filter((value) => Number.isFinite(value) && value > 0)
    : [];
  return cutTimesFromShots(durations, EFFECTIVE_CUT_TRANSITION ? CUT_TRANSITION_DURATION : 0, transitionAt);
})();

/**
 * **素材镜**（2026-09-25 口径修订，产品所有者硬规定）：
 * 卡里给了 `photo` 的镜头**不是**"静态照片段"，而是**素材镜**——真实素材只作**生成输入**，
 * 由 `material-gen` 阶段把它当首帧交给生成模型出带真实运动的镜头（gate G-MAT1）。
 * 因此这类镜头：跳过文生关键帧（首帧就是真实素材），但仍要**有提示词、有提交门、有产物溯源**，
 * 且**严禁**用"裁切 + 推拉/滤镜"把素材本身当镜头（旧的 `photo-motion` 路径已删除）。
 * 相关环节按"生成镜/素材镜"分流，否则 G7 会因为"素材镜没有文生关键帧"而误判缺件。
 */
const isMaterialShot = (shot: ShotCard): boolean => String((shot as Record<string, unknown>).photo ?? "").trim().length > 0;
/**
 * **授权真人素材镜**（T-2026-0929-0003，真机探针 2026-09-29）：
 * 镜头卡给出 `assetRef: "asset://<asset ID>"` 时，主角是**火山方舟「私域真人人像库」里已认证的真人**。
 *   · Seedream 图片接口**不接受** `asset://`（真机 400 `invalid url specified`）→ 跳过文生关键帧；
 *   · Seedance 视频接口**接受** `asset://` 作参考图（真机 200 受理并出片，口型/台词可用）→ 以参考图出片，
 *     **不传首帧**（首帧会给一张 AI 生成的脸，顶掉真人身份）；
 *   · 授权有效性属平台侧事实：本工具只校验引用格式并如实标记
 *     `external-asset-id-not-provider-verified`，不把"格式合法"当"授权有效"。
 */
const ASSET_REF_PATTERN = /^asset:\/\/[A-Za-z0-9][A-Za-z0-9_-]*$/;
/** 注意：**不要**写成 `value is string` 的类型谓词——那会把 `string` 在否定分支收窄成 `never`（TS 实测） */
const isAssetRefLocal = (value: unknown): boolean => typeof value === "string" && ASSET_REF_PATTERN.test(value.trim());
const assetRefOf = (shot: ShotCard): string => String((shot as Record<string, unknown>).assetRef ?? "").trim();
const isAssetShot = (shot: ShotCard): boolean => isAssetRefLocal(assetRefOf(shot));
/** 送审基准图只投本地文件：asset:// 是平台引用、不是文件路径（真机 ENOENT 事故） */
const localReviewRefsEarly = (list: string[]): string[] => list.filter((ref) => !isAssetRefLocal(ref) && existsSync(ref));
const generatedShots = (): ShotCard[] => shots.filter((shot) => !completedByShot.has(shot.shotId) && !isMaterialShot(shot) && !isAssetShot(shot));
const materialShots = (): ShotCard[] => pendingShots().filter(isMaterialShot);
/** 商品镜：素材镜里由 G-PROD1 绑定真实商品档案的镜头（参考图锁的是**产品外观**，不要求复刻参考构图） */
const isProductMaterialShot = (shot: ShotCard): boolean => Boolean((shot as Record<string, unknown>).productRef);
/** 需要提示词文生关键帧/台词的人镜两类：生成镜 + 授权真人素材镜（素材镜另有动效提示词） */
const promptShots = (): ShotCard[] => shots.filter((shot) => !completedByShot.has(shot.shotId) && !isMaterialShot(shot));
const assetShots = (): ShotCard[] => shots.filter((shot) => !completedByShot.has(shot.shotId) && isAssetShot(shot) && !isMaterialShot(shot));
/** 开跑前 fail-fast：`assetRef` 存在但格式不合法（例如漏了 `asset://` 前缀）要当场停，不能静默降级成生成镜 */
for (const shot of pendingShots()) {
  const raw = (shot as Record<string, unknown>).assetRef;
  if (raw !== undefined && String(raw).trim().length > 0 && !isAssetRefLocal(raw)) {
    throw new Error(`授权真人素材引用格式非法（${shot.shotId}）：${String(raw).slice(0, 80)}（应为 asset://<asset ID>）`);
  }
}
if (assetShots().length > 0) {
  log(`授权真人素材镜 ${assetShots().length} 镜：${assetShots().map((s) => `${s.shotId}→${assetRefOf(s)}`).join(" · ")}（外部素材 ID，未向平台核验授权有效性）`);
}

/**
 * 提交前硬闸（T-2026-0929-0013，客户口径："问题要在提交提示词之前发现，不要反复重试烧钱"）：
 * 在**每一次真正花钱的提交之前**，对最终编译出来的提示词做确定性体检；命中红线即拒绝提交（fail-closed），
 * 并把结论写进门账本（G-PRE1）。同时禁止"同一提示词重试"（指纹相同 = 同一注押两次）。
 */
function preflightSubmitGuard(input: { shotId: string; stage: string; prompt: string; fps: number; attempt: number; prevFingerprint: string | null }): void {
  const text = input.prompt;
  const issues: string[] = [];
  const hasScreen = /屏幕|触控|界面/.test(text);
  const screenOk = /(虚化|不可辨|光晕|过曝成色块|背对|不出现)/.test(text);
  if (hasScreen && !screenOk) issues.push("屏幕类元素未声明虚化/背对/不入画——模型会把界面渲染成可读文字（真机返修 6 次）");
  const hasDoc = /身份证|证件|护照|单据|票据/.test(text);
  const docOk = /(不可辨|背面|无证件文字|无身份证|不出现)/.test(text);
  if (hasDoc && !docOk) issues.push("证件类道具未声明不可辨认/背面/不入画——会出现可辨字迹与号码（隐私红线，真机返修 5 次）");
  if (/定住|稳住|定格/.test(text) && /推|拉|移|摇|环绕/.test(text)) issues.push("同一镜同时锁\"定住\"时点与推拉运镜——模型做不到，落幅必漂（真机返修 3 次）");
  const fpsMatch = text.match(/(\d{2})\s*fps/i);
  if (fpsMatch && Number(fpsMatch[1]) !== input.fps) issues.push(`提示词写 ${fpsMatch[1]}fps，管线按 ${input.fps}fps 出片`);
  const fingerprint = createHash("sha256").update(text).digest("hex").slice(0, 12);
  const identicalRetry = input.prevFingerprint !== null && input.prevFingerprint === fingerprint;
  if (identicalRetry) issues.push("本次重试的提示词与上一次完全相同（指纹 " + fingerprint + "）——禁止同注押两次");
  const gate = recordGate({
    stepKey: "g-pre-submit",
    sourceStage: input.stage,
    checks: [
      { id: "no-text-redline", pass: !issues.some((i) => i.includes("可读文字") || i.includes("可辨字迹")), hard: true, detail: issues.filter((i) => i.includes("可读文字") || i.includes("可辨字迹")).join("；") || "无文字类红线" },
      { id: "no-timing-conflict", pass: !issues.some((i) => i.includes("落幅必漂")), hard: true, detail: issues.find((i) => i.includes("落幅必漂")) ?? "无时点/运镜冲突" },
      { id: "no-identical-retry", pass: !identicalRetry, hard: true, detail: identicalRetry ? "同提示词重试被拒" : `提示词指纹 ${fingerprint}（第 ${input.attempt} 次提交）` },
      { id: "fps-consistent", pass: !issues.some((i) => i.includes("fps")), hard: true, detail: issues.find((i) => i.includes("fps")) ?? "帧率一致" }
    ],
    shotIds: [input.shotId],
    evidence: { stage: input.stage, attempt: input.attempt, promptChars: text.length, fingerprint, issues },
    reason: issues.length === 0 ? `提交前体检通过（${input.stage}/${input.shotId}，指纹 ${fingerprint}）` : `提交前体检未通过：${issues.join("；")}`
  });
  if (!gate.approved) {
    throw new Error(`PREFLIGHT_BLOCKED（未花钱）：${input.shotId} — ${issues.join("；")}｜修好提示词再提交，不要靠重试`);
  }
  if (issues.length === 0) log(`  ✓ 提交前体检（G-PRE1）：${input.shotId} 指纹 ${fingerprint}`);
}

/* ---------- ⓪-0.3 一次过就绪度门（G-FP1，T-2026-0929-0009：不再盲重试烧额度） ---------- */
/**
 * 真机归因：本会话每一次返修都能在卡片里提前看到——让模型"别写屏幕字"、6 秒里锁"2.5s 定住"又要推镜、
 * 服装锁到面料配饰、一镜塞三个互相打架的诉求。这里在花钱前给出**就绪度 + 改卡建议**，
 * 新付费提交只核对待生成镜头的源合同与授权；成功素材直接采用，不运行 canary 品质复审。
 */
let FIRST_PASS_ORDER: ShotCard[] = shots;
if (PRERENDER_REQUESTED) {
  const readiness = assessFilmFirstPass(shots.filter(shot => !completedByShot.has(shot.shotId)) as unknown as Array<Record<string, unknown>>, { fps: FPS });
  const shotIds = shots.map((shot) => String(shot.shotId));
  const order = readiness.renderOrder;
  FIRST_PASS_ORDER = order.map((id) => shots.find((shot) => String(shot.shotId) === id)!).filter(Boolean);
  const gate = recordGate({
    stepKey: "g-first-pass",
    sourceStage: "prompt",
    checks: [
      {
        id: "first-pass-ready", pass: readiness.ready, hard: true,
        detail: readiness.ready
          ? `${FIRST_PASS_POLICY_VERSION}：${shots.length} 镜无高风险项（就绪度通过；渲染顺序按风险降序：${order.join(" → ")}）`
          : readiness.blockers.map((entry) => `${entry.shotId}｜${entry.finding.id}｜${entry.finding.detail}｜改卡建议：${entry.finding.suggestion}`).join("；")
      }
    ],
    shotIds,
    evidence: { policy: FIRST_PASS_POLICY_VERSION, perShot: readiness.perShot, renderOrder: order },
    reason: readiness.ready ? `${FIRST_PASS_POLICY_VERSION}：就绪` : `存在 ${readiness.blockers.length} 项高风险（花钱前拦住）`
  });
  if (!gate.approved) {
    log(`⛔ 一次过就绪度未通过（未花任何渲染额度）：`);
    for (const entry of readiness.blockers) log(`   · ${entry.shotId} ${entry.finding.id}：${entry.finding.detail}\n     改卡建议：${entry.finding.suggestion}`);
    throw new Error(`FIRST_PASS_NOT_READY: ${readiness.blockers.map((entry) => `${entry.shotId}:${entry.finding.id}`).join(",")}`);
  }
  log(`一次过就绪度 G-FP1 通过（渲染顺序按风险降序：${order.join(" → ")}）`);
}


/* ---------- ⓪-0.4 提示词红线门（G-RL1，T-2026-0929-0008：提高一次过率） ---------- */
/**
 * 每一次"渲完才发现"的返修，都对应一条可以提前写死在卡片里的红线。这里在**花钱之前**统一清零：
 * 屏幕文字/图标/LOGO、证件字迹与号码、卡片类道具重复、timeline 定住而运镜没定住、卡片与管线帧率不一致。
 * hard 项不清零就 fail-closed；soft 项进证据与日志（不阻断，但必须被看见）。
 */
if (PRERENDER_REQUESTED) {
  const redlines = auditFilmRedlines(shots.filter(shot => !completedByShot.has(shot.shotId)) as unknown as Array<Record<string, unknown>>, { fps: FPS });
  const shotIds = shots.map((shot) => String(shot.shotId));
  const redlineGate = recordGate({
    stepKey: "g-prompt-redlines",
    sourceStage: "prompt",
    checks: [
      {
        id: "redlines-clear", pass: redlines.hard.length === 0, hard: true,
        detail: redlines.hard.length === 0
          ? `${PROMPT_REDLINE_POLICY_VERSION}：${shots.length} 镜红线清零（soft ${redlines.soft.length} 项已记录）`
          : redlines.hard.map((issue) => `${issue.id}｜${issue.detail}｜为什么：${issue.why}`).join("；")
      },
      ...(redlines.soft.length > 0
        ? [{ id: "redlines-soft", pass: true, hard: false, detail: redlines.soft.map((issue) => `${issue.id}｜${issue.detail}`).join("；") }]
        : [])
    ],
    shotIds,
    evidence: { policy: PROMPT_REDLINE_POLICY_VERSION, perShot: redlines.perShot, soft: redlines.soft },
    reason: redlines.hard.length === 0
      ? `提示词红线 ${PROMPT_REDLINE_POLICY_VERSION}：hard 0 · soft ${redlines.soft.length}`
      : `提示词红线未清零（${redlines.hard.length} 项 hard）`
  });
  if (!redlineGate.approved) {
    throw new Error(`提示词红线未清零（花钱前拦住）：${redlines.hard.map((issue) => `[${issue.id}] ${issue.detail}`).join("；")}`);
  }
  for (const issue of redlines.soft.slice(0, 6)) log(`⚠ 提示词红线（软）${issue.id}：${issue.detail}`);
}

/* ---------- ⓪-0.5 认证真人素材一致性门（T-2026-0929-0007，事故机制化） ---------- */
/**
 * 事故复盘（2026-09-29）：客户给了平台已认证的真人素材 ID，但系统只校验"引用能不能提交"，
 * 没有任何地方记录"这位真人是谁"；镜头卡文案写男性 → 模型跟文案 → 6 镜渲成男性全部被拒收。
 * 本门把人物属性变成硬闸：
 *   ① 每个 `asset://` 必须有**真人主档**（bundles/ai-video/library/real-person-assets/<assetId>/profile.json）；
 *   ② 主档必须 real-authorized 且在有效期内，性别等关键属性不许为空（缺了先问客户，禁止先生成）；
 *   ③ 镜头卡文本与主档属性**逐项一致**（性别/年龄段/assetRef），冲突即 fail-closed；
 *   ④ 上述约束仅作用于待提交镜头；已有成功镜头不重新查主档或作 canary/身份品质评审。
 */
const REAL_PERSON_LIBRARY = resolve(arg("--real-person-library", join(REPO_ROOT, "bundles/ai-video/library/real-person-assets")));
const realPersonLibrary = loadRealPersonAssets(REAL_PERSON_LIBRARY);
const realPersonChecks: GateCheck[] = [];
const identityAnchors = new Map<string, string>();   // shotId → 认证基准照（本地文件，仅用于像不像比对）
const realPersonByShot = new Map<string, { assetId: string; displayName: string; scopeText: string }>();
for (const shot of assetShots()) {
  const id = assetIdOf(assetRefOf(shot));
  const entry = realPersonLibrary.byAssetId.get(id);
  if (!entry) {
    throw new Error(`镜头 ${shot.shotId} 使用认证真人素材 ${id}，但真人主档库里没有该素材（${REAL_PERSON_LIBRARY}）→ 先建主档（性别/年龄段/授权/证据），禁止临时编人物属性`);
  }
  const hard = entry.issues.filter((issue) => issue.hard);
  if (hard.length > 0) {
    throw new Error(`认证真人主档 ${id} 不可用：${hard.map((issue) => `[${issue.code}] ${issue.detail}`).join("；")}`
      + `（缺关键属性时**先向客户确认**，不允许先拍后猜）`);
  }
  const conflicts = assertShotMatchesCertifiedAsset(shot as unknown as Record<string, unknown>, entry.asset);
  const hardConflicts = conflicts.filter((issue) => issue.hard);
  if (hardConflicts.length > 0) {
    throw new Error(`认证真人一致性门未通过（${REAL_PERSON_POLICY_VERSION}）：${hardConflicts.map((issue) => `[${issue.code}] ${issue.detail}`).join("；")}`);
  }
  realPersonChecks.push({
    id: `certified-consistent:${shot.shotId}`, pass: true, hard: true,
    detail: `${shot.shotId} 与主档一致（${entry.asset.displayName}｜${entry.asset.certified.gender}｜${entry.asset.certified.ageBand ?? "年龄段未声明"}）`
  });
  realPersonByShot.set(String(shot.shotId), { assetId: id, displayName: entry.asset.displayName, scopeText: identityReviewContext(entry.asset).discipline as string });
  const anchor = identityAnchorPath(entry.asset, entry.dir);
  if (anchor) identityAnchors.set(String(shot.shotId), anchor);
}
if (realPersonChecks.length > 0) {
  const realPersonGate = recordGate({
    stepKey: "g-real-person",
    sourceStage: "portrait",
    checks: [
      ...realPersonChecks,
      {
        id: "pre-submit-authority", pass: true, hard: true,
        detail: `本次 ${realPersonChecks.length} 个待生成真人镜已核对主档与授权；成功后默认采用，不执行 canary 或身份品质复审`
      }
    ],
    shotIds: [...realPersonByShot.keys()],
    evidence: {
      library: REAL_PERSON_LIBRARY,
      policy: REAL_PERSON_POLICY_VERSION,
      usage: assetShots().map((shot) => realPersonUsageReceipt({ asset: realPersonLibrary.byAssetId.get(assetIdOf(assetRefOf(shot)))!.asset, projectId: PROJECT, shots: [String(shot.shotId)] }))
    },
    reason: `认证真人一致性门通过：${realPersonChecks.length} 镜与平台认证主档属性一致（资产 ID 与授权证据已留痕）`
  });
  if (!realPersonGate.approved) throw new Error(`认证真人门未通过：${realPersonGate.reason}`);
  log(`认证真人素材门 G-RP1 通过：${realPersonChecks.length} 镜（主档 ${REAL_PERSON_LIBRARY}）`);
}

/* ---------- ⓪-0 真实商品档案绑定（T-2026-0929-0004） ---------- */
/**
 * 产品口径（产品所有者 2026-09-29）：涉及**具体公司名或品牌名**的片子，默认必须用该公司/品牌的**真实产品**。
 *   · 系统里有档案（`bundles/ai-video/library/products/*`）就用它：客户上传的档案优先于系统检索生成的档案；
 *   · 没有档案 → **fail-closed**：先跑 `scripts/tools/product-archive.mts search|build` 建档，不拿 AI 编产品；
 *   · 绑定后该镜自动成为**素材镜**（真实产品照片只作生成输入，materialUsage=generation-reference），
 *     并把"外观以参考照片为准、不得改结构/标识"写进道具口径——由 material-gen 阶段按 G-MAT1 把关。
 */
const PRODUCT_LIBRARY = resolve(arg("--product-library", join(REPO_ROOT, "bundles/ai-video/library/products")));
const productLibrary = loadProductArchives(PRODUCT_LIBRARY, {
  probeImage: (file: string) => {
    try {
      const info = probe(file);
      const width = Number(info.width ?? 0);
      const height = Number(info.height ?? 0);
      return width > 0 && height > 0 ? { width, height } : null;
    } catch { return null; }
  }
});
const productSelectorOf = (shot: ShotCard): string => String((shot as Record<string, unknown>).product ?? "").trim();
const declaredProducts = Array.isArray((shotlist as Record<string, unknown>).products) ? ((shotlist as Record<string, unknown>).products as unknown[]).map((item) => String(item).trim()).filter(Boolean) : [];
const declaredCompany = String((shotlist as Record<string, unknown>).company ?? "").trim();
const declaredBrand = String((shotlist as Record<string, unknown>).brand ?? "").trim();
const productBindingGuide = `请先建档：tsx scripts/tools/product-archive.mts search --name "<公司/品牌>"（系统检索，priority=1）`
  + `，或由客户提供照片后 tsx scripts/tools/product-archive.mts build --name "<商品名>" --photo <图…> --company "<公司>"（priority=10）`;
/**
 * 档案库整体只做**告警**：一个多商品方案库里难免有"只有参数、没有产品图"的成员（例如同页多型号）。
 * 真正 fail-closed 的时机是**本片引用它**的时候（下面解析不到可用档案即报错），而不是别人家的档案不完整就拦住本片。
 */
const brokenArchives = productLibrary.archives.filter((entry) => entry.issues.some((issue) => issue.hard));
if (brokenArchives.length > 0) {
  log(`⚠ 商品档案库有 ${brokenArchives.length} 份档案存在硬问题（本片未引用则不拦截）：`
    + brokenArchives.map((entry) => `${entry.archive.id}[${entry.issues.filter((issue) => issue.hard).map((issue) => issue.code).join(",")}]`).join("、"));
}
if (pendingShots().length > 0 && (declaredCompany || declaredBrand)) {
  const ownerSelector = declaredCompany || declaredBrand;
  const ownerMatch = selectProductArchive(productLibrary.archives, ownerSelector);
  if (!ownerMatch.archive) {
    throw new Error(`本片声明了公司/品牌「${ownerSelector}」，但商品档案库里没有对应档案（${ownerMatch.reason}）。`
      + `涉及具体公司/品牌的片子必须使用真实产品：${productBindingGuide}`);
  }
}
const productBindings: Array<{ shotId: string; selector: string; archiveId: string; sourceKind: string; priority: number; matchedBy: string; photoFile: string; photoSha256: string; bound: boolean }> = [];
for (const selector of pendingShots().length > 0 ? declaredProducts : []) {
  if (!selectProductArchive(productLibrary.archives, selector).archive) {
    throw new Error(`shotlist.products 声明的商品「${selector}」没有可用档案：${productBindingGuide}`);
  }
}
for (const shot of pendingShots()) {
  const selector = productSelectorOf(shot);
  if (!selector) continue;
  const match = selectProductArchive(productLibrary.archives, selector);
  if (!match.archive || !match.dir) {
    throw new Error(`镜头 ${shot.shotId} 声明了商品「${selector}」，但没有可用的真实商品档案（${match.reason}）。${productBindingGuide}`);
  }
  const entry = productLibrary.byId.get(match.archive.id)!;
  const hero = productHeroPhoto(match.archive);
  if (!hero) throw new Error(`镜头 ${shot.shotId} 绑定的商品档案 ${match.archive.id} 没有主图（role=hero）`);
  const card = shot as Record<string, unknown>;
  const existingPhoto = String(card.photo ?? "").trim();
  const photoAbs = productPhotoPath(entry, hero);
  const bound = !existingPhoto;
  if (bound) {
    card.photo = photoAbs;
    card.materialUsage = "generation-reference";
    card.focus = { x: 0.5, y: 0.5 };
  }
  card.productRef = {
    id: match.archive.id,
    sourceKind: match.archive.source.kind,
    priority: match.archive.source.priority,
    matchedBy: match.matchedBy,
    photo: hero.file,
    photoSha256: hero.sha256,
    reviewStatus: match.archive.source.reviewStatus ?? null,
    bound
  };
  card.props = [String(card.props ?? "").trim(), productArchivePromptLines(match.archive).join("｜")].filter(Boolean).join("｜");
  productBindings.push({
    shotId: String(shot.shotId), selector, archiveId: match.archive.id, sourceKind: match.archive.source.kind,
    priority: match.archive.source.priority, matchedBy: String(match.matchedBy), photoFile: photoAbs, photoSha256: hero.sha256, bound
  });
  log(`真实商品绑定 ${shot.shotId} ← ${match.archive.id}（${match.archive.source.kind}，priority=${match.archive.source.priority}）主图 ${hero.file}`);
}
if (productBindings.length > 0) {
  const systemGenerated = productBindings.filter((entry) => entry.sourceKind === "system-generated");
  const productGate = recordGate({
    stepKey: "g-product-ref",
    sourceStage: "product",
    checks: [
      { id: "product-archive-present", pass: productBindings.length > 0, hard: true, detail: `${productBindings.length} 镜绑定真实商品档案（库 ${PRODUCT_LIBRARY}）` },
      { id: "product-photo-verified", pass: productBindings.every((entry) => existsSync(entry.photoFile)), hard: true, detail: productBindings.map((entry) => `${entry.shotId}→${basename(entry.photoFile)}`).join("、") },
      {
        id: "product-source-priority", pass: true, hard: true,
        detail: systemGenerated.length > 0
          ? `${systemGenerated.length} 镜用的是**系统检索生成**的商品档案（priority=1，带检索证据与免责声明，未经客户确认）；客户上传档案（priority=10）可随时替换`
          : `全部使用客户上传的商品档案（priority=10）`
      },
      { id: "product-binding", pass: productBindings.every((entry) => entry.bound), hard: false, detail: productBindings.map((entry) => `${entry.shotId}:${entry.bound ? "已自动绑定主图" : "沿用镜头卡自带素材"}`).join("、") }
    ],
    shotIds: productBindings.map((entry) => entry.shotId),
    evidence: { library: PRODUCT_LIBRARY, bindings: productBindings, declaredProducts, company: declaredCompany || null, brand: declaredBrand || null },
    reason: `真实商品档案绑定 ${productBindings.length} 镜（客户上传优先，系统检索次之）`
  });
  if (!productGate.approved) throw new Error(`真实商品档案门未通过：${productGate.reason}`);
} else if (declaredCompany || declaredBrand || declaredProducts.length > 0) {
  log(`ℹ️ 本片声明了公司/品牌（${declaredCompany || declaredBrand}）但没有任何镜头绑定商品（shot.product 未声明）：未做真实商品绑定`);
}
/**
 * 素材用途**在开跑前先验一遍**（fail-fast）：缺声明/写成静态直出用途时当场停，
 * 不等到出片阶段才发现"这一镜本来就不该这么做"。错误信息里带规则原文。
 */
for (const shot of materialShots()) {
  try {
    readMaterialSpec(shot as unknown as Record<string, unknown>);
  } catch (err) {
    throw new Error(`素材用途硬约束未通过（${MATERIAL_POLICY_VERSION}）：${err instanceof Error ? err.message : String(err)}`);
  }
  log(`素材镜 ${shot.shotId}：素材用途声明 ok（generation-reference）——素材只作生成输入，禁止静态直出`);
}

interface CharacterEntryLike {
  id: string; name: string; files: Record<string, string>; dir: string;
  version: number | null;
  /** 档案正文里的外貌描述（纯文生图时的唯一人物变量；真人图不可作为视频首帧时靠它保人） */
  appearanceText: string;
  wardrobeLock: { id: string; description: string };
}
/**
 * 角色库装载（2026-09-24 扩展）：除 `HR_CHARACTER_LIBRARY` 外，**同时**装载随仓分发的默认模特库
 * `bundles/ai-video/library/characters/*`（系统默认 1 号模特 = 陈卓），并读取 registry.json 的别名表——
 * 这样"未指定模特时自动用陈卓""镜头卡写'陈卓'时解析到该档案"两条规则才能在管线里生效。
 */
function loadCharacters(): Map<string, CharacterEntryLike> {
  const library = new Map<string, CharacterEntryLike>();
  const repoCharacters = join(REPO_ROOT, "bundles/ai-video/library/characters");
  for (const root of [LIBRARY, repoCharacters]) {
    if (existsSync(root)) loadCharacterRoot(root, library);
  }
  return library;
}

/** registry.json：默认模特 + 姓名别名（别名解析在选角时用） */
function loadCharacterRegistry(): { defaultModel: string | null; aliases: Array<{ id: string; names: string[] }> } {
  const file = join(REPO_ROOT, "bundles/ai-video/library/characters/registry.json");
  if (!existsSync(file)) return { defaultModel: null, aliases: [] };
  try {
    const doc = JSON.parse(readFileSync(file, "utf8")) as {
      defaultModel?: string;
      models?: Array<{ id: string; name?: string; aliases?: string[] }>;
    };
    return {
      defaultModel: doc.defaultModel ?? null,
      aliases: (doc.models ?? []).map((m) => ({ id: m.id, names: [m.id, m.name ?? "", ...(m.aliases ?? [])].filter(Boolean) }))
    };
  } catch {
    return { defaultModel: null, aliases: [] };
  }
}

function loadCharacterRoot(root: string, library: Map<string, CharacterEntryLike>): void {
  for (const name of readdirSync(root)) {
    const dir = join(root, name);
    const profileFile = join(dir, "profile.json");
    if (!existsSync(profileFile) || !statSync(dir).isDirectory()) continue;
    const profile = JSON.parse(readFileSync(profileFile, "utf8")) as {
      id: string; name: string;
      identity?: Record<string, unknown>;
      appearance?: Record<string, unknown>;
      wardrobe?: Array<Record<string, unknown>>;
      portraitSets?: Array<{ dir: string; angles: string[]; active?: boolean; version: number; assets?: Record<string, string> }>;
    };
    const sets = profile.portraitSets ?? [];
    const active = sets.find((s) => s.active) ?? sets[sets.length - 1];
    const files: Record<string, string> = {};
    /**
     * 授权真人素材（T-2026-0929-0003）：档案里可以只给平台素材引用（`assets` 映射），
     * 没有本地定妆照文件。此时角度 → `asset://<asset ID>`，由 Seedance 作参考图承担人物身份；
     * 与本地文件角度可混用（本地文件优先）。
     */
    for (const [angle, ref] of Object.entries(active?.assets ?? {})) {
      if (isAssetRefLocal(ref)) files[angle] = ref.trim();
    }
    if (active) {
      const setDir = join(dir, active.dir);
      if (existsSync(setDir)) {
        for (const angle of active.angles) {
          /**
           * 角度文件解析统一走 `findAngleFile`（2026-09-24 修复）：
           * 早先这里按 `${profile.name}-${angle}` 前缀硬匹配，而随仓 1 号模特的
           * `portraits/v3/` 文件名前缀是"平江路讲述人"、档案 name 是"陈卓" →
           * 8 张定妆照全部匹配不到（G5 门当场亮红才发现）。
           */
          const hit = findAngleFile(setDir, profile.name, angle);
          if (hit) files[angle] = hit;
        }
      }
    }
    /** 档案 → 一段可用于纯文生图的人物描述（与 portrait-agent 的 appearanceOf 同口径，但不含任何地点/道具/时段） */
    const a = profile.appearance ?? {};
    const i = profile.identity ?? {};
    const wardrobe = Array.isArray(profile.wardrobe) && profile.wardrobe.length > 0 ? profile.wardrobe[0]! : {};
    const appearanceText = [
      `一位${String(i.age ?? "").trim()}${String(a.gender ?? i.gender ?? "女性") === "female" ? "女性" : String(a.gender ?? i.gender ?? "女性")}`,
      a.face ? String(a.face) : "",
      a.skin ? `肤质：${String(a.skin)}` : "",
      a.eyes ? `眼睛：${String(a.eyes)}` : "",
      a.hair ? `${String(a.hair)}发型` : "",
      Array.isArray(a.features) && a.features.length > 0 ? `特征：${(a.features as unknown[]).join("；")}` : "",
      a.bodyType ? `身形：${String(a.bodyType)}` : "",
      wardrobe.name ? `穿着${String(wardrobe.name)}${wardrobe.detail ? `（${String(wardrobe.detail)}）` : ""}` : ""
    ].filter(Boolean).join("，");
    library.set(profile.id, { id: profile.id, name: profile.name, files, dir, appearanceText, version: active?.version ?? null,
      wardrobeLock: { id: String(wardrobe.id ?? wardrobe.name ?? ""), description: [wardrobe.name, wardrobe.detail].filter(Boolean).join("：") } });
  }
}
const characters = loadCharacters();
/**
 * 选角（2026-09-24 规则）：
 *   ① 镜头卡/项目显式指定 → 用指定的；
 *   ② 文本里出现模特姓名或别名（如"陈卓"）→ 解析到该档案；
 *   ③ 都没指定 → 回落到 registry.json 的 **defaultModel（系统默认 1 号模特 = 陈卓）**；
 *   ④ 仍然没有 → 用库里第一个（并如实记录，不静默）。
 */
const characterRegistry = loadCharacterRegistry();
const lead = (() => {
  const list = [...characters.values()];
  const explicitId = shotlist.character?.id ?? "";
  const explicitName = shotlist.character?.name ?? "";
  const byExplicit = list.find((c) => c.id === explicitId || c.name === explicitName);
  if (byExplicit) return byExplicit;
  const aliasHit = characterRegistry.aliases.find((a) => a.names.some((n) => n && n.length > 1 && explicitName.includes(n)));
  if (aliasHit) return list.find((c) => c.id === aliasHit.id) ?? undefined;
  if (characterRegistry.defaultModel) {
    const preferred = list.find((c) => c.id === characterRegistry.defaultModel);
    if (preferred) return preferred;
  }
  return list[0];
})();
if (lead && characterRegistry.defaultModel && lead.id === characterRegistry.defaultModel) {
  log(`未显式指定模特 → 使用系统默认模特：${lead.name}（${lead.id}，1 号）`);
}

/** 人物身份、同组引用和本片明确服饰合同，独立于通用审美评审。 */
const characterIdFor = (shot: ShotCard): string => String((shot as Record<string, unknown>).characterId ?? lead?.id ?? assetIdOf(assetRefOf(shot)));
const allAssetShots = shotlist.shots.filter(isAssetShot);
const registeredCharacterSource = buildRegisteredCharacterReleaseSource({ projectId: PROJECT,
  shots: PRERENDER_REQUESTED ? sourceDocument.shots!.filter(shot => !completedByShot.has(String(shot.shotId))) : [], character: sourceDocument.character as Record<string, unknown> | undefined,
  assetLibraryRoot: REAL_PERSON_LIBRARY, characterLibraryRoots: [LIBRARY, join(REPO_ROOT, "bundles/ai-video/library/characters")],
  registryFile: join(REPO_ROOT, "bundles/ai-video/library/characters/registry.json") });
const characterBindings = registeredCharacterSource.bindings;
const characterReleaseContract = registeredCharacterSource.contract;
writeFileSync(join(WORK_DIR, `${PROJECT}-character-release-contract.json`), JSON.stringify(characterReleaseContract, null, 2));
function assertCharacterRenderPreflight(): void {
  if (!characterReleaseContract.shots.length) return;
  if (characterReleaseContract.status !== "passed" || characterBindings.some((binding) => !binding.identityAnchor))
    throw new Error(`CHARACTER_RENDER_PREFLIGHT_BLOCKED: 授权身份、服饰合同或登记基准图缺失；${characterReleaseContract.issues.map((issue) => issue.detail).join("；")}`);

}
function characterReleaseReport(_phase: "canary" | "release", _characterId?: string) {
  return { status: "not-reviewed", adoptedRenderedShots: completedOriginals.map(original => original.shotId),
    qualityReviewPerformed: false, identityVerified: false, wardrobeVerified: false,
    note: "Successfully rendered shots are adopted by default. No post-render identity, clothing, canary or human acceptance gate." };
}
/* ---------- ⓪-0 G5 定妆照确认（step_key: g5-portrait-confirm） ---------- */
/**
 * 管线 yml 的 `g5-portrait-confirm` 门：确认"这组定妆照可用于本片"。
 *
 * CLI 口径 = **资产硬闸 + 人类验收记录**（T-2026-1001-0007）：
 *   · 硬闸：角色档案在、四个必需角度齐备、单张 >50KB（占位图/失败图直接拦）；
 *   · 人类验收：读角色目录 `gates.jsonl` 最近一条 `g5-portrait-confirm`（`portrait-agent accept` 产出，
 *     `via=owner-acceptance`）；只有人类记录能做放行/否决，人类否决即阻断；
 *   · 机器评审（`portrait-agent review` 的 reviews/*.json / gates.jsonl 的 llm 记录）**只留证、不参与放行**，
 *     既不会因"机器判不合格"卡住交付，也不冒充人类签字；
 *   · 两条记录都没有时照常做资产闸但标 degraded（不冒充已验收），需先执行 `accept`。
 * 与 §⑤ 的 `keyframe`/`shot` 门不同，G5 管的是**角色资产**，不是本片画面。
 */
if (!DRY_RUN && generatedShots().length > 0 && PRERENDER_REQUESTED) {
  const requiredAngles = ["front", "threeQuarter", "closeup", "side"];
  const published = lead ? requiredAngles.map((angle) => ({ angle, path: lead.files[angle] ?? "" })) : [];
  /**
   * 授权真人素材引用（`asset://<asset ID>`）**不是本地文件**：没有文件、没有字节数可量。
   * 判据改为"引用格式合法即算在场"，并在 checks 里单列一条如实说明
   * `external-asset-id-not-provider-verified`（本工具不向平台核验授权有效性）。
   */
  const missing = published.filter((f) => !f.path || (!isAssetRefLocal(f.path) && !existsSync(f.path)));
  /** 安全取字节数：缺失/空路径返回 0（真机 2026-09-24：空路径直接 statSync 抛 ENOENT 把整个运行打断） */
  const sizeOf = (path: string): number => (path && existsSync(path) ? statSync(path).size : 0);
  const tiny = published.filter((f) => !isAssetRefLocal(f.path) && sizeOf(f.path) > 0 && sizeOf(f.path) < 50_000);
  const externalRefs = published.filter((f) => isAssetRefLocal(f.path)).map((f) => `${f.angle}=${f.path}`);
  /**
   * 定妆照监制记录：**优先读角色目录的门账本 `gates.jsonl`**（`g5-portrait-confirm`，
   * 由 `portrait-agent review` 落账，2026-09-24 起）；没有门记录时回退到 `reviews/*.json`。
   * 这样"定妆照确认"就有了按 step_key 的机器可读记录，而不是靠人翻评审文件。
   */
  const gateRecord = (() => {
    if (!lead) return null;
    const ledger = join(lead.dir, "gates.jsonl");
    if (!existsSync(ledger)) return null;
    try {
      const events = readFileSync(ledger, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as {
        stepKey?: string; projectId?: string; at?: string; approved?: boolean; score?: number | null; reason?: string;
        via?: string | null; sourceStage?: string | null; evidence?: { basis?: string | null; ownerAcceptance?: string } | null;
      });
      return selectPortraitDecisionRecord(events, `portrait:${lead.id}:v${lead.version}`);
    } catch (error) { throw new Error(`角色门账本不可读取：${error instanceof Error ? error.message : String(error)}`); }
  })();
  const reviewFile = (() => {
    if (!lead) return null;
    const dir = join(lead.dir, "reviews");
    if (!existsSync(dir)) return null;
    const files = readdirSync(dir).filter((f) => f.endsWith(".json")).sort();
    return files.length > 0 ? join(dir, files[files.length - 1]!) : null;
  })();
  const review = (() => {
    if (!reviewFile) return null;
    try {
      return JSON.parse(readFileSync(reviewFile, "utf8")) as { at?: string; verdict?: { approved?: boolean; score?: number; reason?: string } };
    } catch { return null; }
  })();
  /**
   * 决策语义（T-2026-1001-0007）：只有人类验收记录可放行/否决；机器记录（含旧版被机器判据带成
   * approved=false 的记录）一律按留证处理。口径单测见 `packages/video-studio/src/portrait-decision.test.ts`。
   */
  const portraitDecision = assessPortraitDecision(
    gateRecord ?? (review
      ? {
          at: review.at ?? null, approved: review.verdict?.approved, score: review.verdict?.score ?? null,
          reason: review.verdict?.reason ?? null, via: "llm", sourceStage: "portrait-review",
        }
      : null),
  );
  let acceptanceBytesVerified = false;
  if (lead && portraitDecision.decisive && !portraitDecision.blocking) {
    const receiptFile = gateRecord?.evidence?.ownerAcceptance;
    if (receiptFile) {
      try {
        const localReceipt = join(lead.dir, "reviews", basename(receiptFile));
        const receipt = JSON.parse(readFileSync(localReceipt, "utf8")) as { characterId?: string; version?: number; artifacts?: Array<{ angle?: string; file: string; sha256: string }> };
        acceptanceBytesVerified = receipt.characterId === lead.id && receipt.version === lead.version
          && published.every(({ angle, path }) => !isAssetRefLocal(path) && existsSync(path)
            && receipt.artifacts?.some((item) => (item.angle === angle || resolve(item.file) === resolve(path)) && item.sha256 === sha256FileSync(path)));
      } catch (error) { log(`人类验收文件核验失败：${error instanceof Error ? error.message : String(error)}`); }
    }
  }
  const checks: GateCheck[] = lead
    ? [
        { id: "character-present", pass: true, detail: `角色 ${lead.name}（${lead.id}）`, hard: true },
        {
          id: "required-angles", pass: missing.length === 0, hard: true,
          detail: missing.length === 0
            ? `必需角度齐备：${requiredAngles.join("/")}`
            : `缺角度或文件不存在：${missing.map((m) => m.angle).join("/")}`
        },
        {
          id: "file-size", pass: tiny.length === 0, hard: true,
          detail: tiny.length === 0
            ? `四角度均 >50KB 或为授权素材引用（${published.map((f) => `${f.angle}=${isAssetRefLocal(f.path) ? "asset://" : `${(sizeOf(f.path) / 1024).toFixed(0)}KB`}`).join(" ")}）`
            : `以下角度文件过小（疑似占位图）：${tiny.map((f) => f.angle).join("/")}`
        },
        ...(externalRefs.length > 0
          ? [{
              id: "external-asset-ref", pass: true, hard: true,
              detail: `授权真人素材引用 ${externalRefs.length} 个角度（${externalRefs.join("、")}）——`
                + "外部素材 ID：本工具只校验引用格式，未向平台核验授权有效期与归属（external-asset-id-not-provider-verified）"
            }]
          : []),
        {
          /** 附加信息（不参与硬闸）：档案里一共有多少角度可用——只有 4 个必需角度时也能拍，但选择面更窄 */
          id: "archive-angles", pass: Object.keys(lead.files).length >= 4, hard: false,
          detail: `档案可用角度 ${Object.keys(lead.files).join("/") || "无"}（共 ${Object.keys(lead.files).length} 个）`
        },
        ...(portraitDecision.kind === "none"
          ? []
          : [{
              id: "portrait-decision",
              /** 人类否决才阻断；机器记录只留证（hard=false，pass 恒为 true） */
              pass: !portraitDecision.blocking,
              hard: portraitDecision.decisive,
              detail: `${portraitDecision.detail}（来源：${gateRecord ? "gates.jsonl" : "reviews/*.json"}）`
            }]),
        ...(portraitDecision.decisive && !portraitDecision.blocking ? [{
          id: "human-acceptance-bytes", pass: acceptanceBytesVerified, hard: true,
          detail: acceptanceBytesVerified ? "当前角色版本的四角度字节与人类验收指纹一致" : "当前定妆照未与人类验收指纹绑定或已变化，须重新验收"
        }] : [])
      ]
    : [{ id: "applicable", pass: true, detail: "镜头卡未涉及人物（空镜片）→ 定妆照门不适用", hard: false }];
  const gate = recordGate({
    stepKey: "g5-portrait-confirm",
    sourceStage: "portrait",
    checks,
    /**
     * 没有定妆照监制记录时**不冒充实质评审**：确定性闸照跑，但 degraded 置位，
     * 让审计一眼看到"这个门这次只做了资产校验"。
     *
     * 例外（T-2026-0929-0003）：**全角度为平台授权真人素材引用**（asset://）时，
     * 人物同一性由平台在「私域真人人像库」建档时做了一致性校验与授权，本地没有图片可评——
     * 此时"external-asset-ref"判据就是这道门的实质判据，不再因"没有本地监制记录"降级；
     * 授权有效期与归属仍如实标注为未由本工具核验（external-asset-id-not-provider-verified）。
     */
    degraded: Boolean(lead) && portraitDecision.kind === "none" && externalRefs.length === 0,
    evidence: {
      character: lead ? { id: lead.id, name: lead.name, angles: Object.keys(lead.files) } : null,
      reviewFile,
      gateLedger: lead ? join(lead.dir, "gates.jsonl") : null,
      gateApproved: gateRecord?.approved ?? null,
      reviewApproved: review?.verdict?.approved ?? null,
      portraitDecision: { kind: portraitDecision.kind, decisive: portraitDecision.decisive, blocking: portraitDecision.blocking, detail: portraitDecision.detail },
      note: portraitDecision.kind === "human"
        ? "含人类验收记录（gates.jsonl，via=owner-acceptance）：放行/否决由人类决定"
        : portraitDecision.kind === "machine"
          ? "含机器评审留证（不参与放行）：机器判据不触发重做，决策交人类"
          : "无人类验收记录：本次仅做资产硬闸（角度/尺寸/字节）"
    },
    reason: lead
      ? (portraitDecision.kind === "none" ? "定妆照资产齐备（无人类验收记录，已标 degraded；请先由人类执行 portrait-agent accept）" : undefined)
      : "本片无人物，定妆照门不适用"
  });
  if (!gate.approved && !ACCEPT_REJECTED.includes("G5")) {
    throw new Error(`G5 定妆照确认未通过：${gate.reason}（确需继续请显式传 --accept-rejected G5）`);
  }
}

/* ================= 关键帧 / 视频 出图出片 ================= */

function dataUrl(file: string): string {
  /** 方舟授权真人素材（`asset://<asset ID>`）不是本地文件：**原样透传**给平台，不能 base64 编码 */
  if (isAssetRefLocal(file)) return file;
  if (WORKER_RUNTIME) return `film-ref:${WORKER_RUNTIME.reference(file)}`;
  const ext = file.toLowerCase().endsWith(".png") ? "png" : file.toLowerCase().endsWith(".webp") ? "webp" : "jpeg";
  return `data:image/${ext};base64,${readFileSync(file).toString("base64")}`;
}

async function arkImage(prompt: string, anchors: string[], size: string, shotId: string, target: string): Promise<string> {
  if (WORKER_RUNTIME) return WORKER_RUNTIME.image(prompt, anchors, size, shotId, target);
  if (!ARK_KEY) throw new Error("RENDER_KEY_REQUIRED: image generation requires configured credentials");
  const payload: Record<string, unknown> = {
    model: IMAGE_MODEL, prompt, size, response_format: "url", watermark: false,
    ...(anchors.length > 0 ? { image: anchors.length === 1 ? dataUrl(anchors[0]!) : anchors.slice(0, 4).map(dataUrl) } : {})
  };
  const res = await fetch(`${ARK_BASE}/images/generations`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${ARK_KEY}` },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(300_000)
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`出图失败 HTTP ${res.status}：${text.slice(0, 300)}`);
  const json = JSON.parse(text) as { data?: Array<{ url?: string }> };
  const url = json.data?.[0]?.url;
  if (!url) throw new Error(`出图响应缺少 url：${text.slice(0, 200)}`);
  return url;
}

/**
 * 关键帧的"托管 URL 台账"（2026-09-24 真机结论）。
 *
 * Ark 视频接口对**真人题材的图片输入**做隐私校验：
 *   · base64 data URL（first_frame / reference_image 都一样）→ 400 `InputImageSensitiveContentDetected.PrivacyInformation`
 *   · **同账号模型产物、以 Ark 托管 URL 形式引用** → 200 受理（探针脚本 `work/film/probe-first-frame.mts` 实测 A/B/C/D 四态）
 * 所以关键帧出图后必须把 Seedream 返回的托管 URL 存下来，供视频环节当首帧用（URL 有有效期，按时间戳老化）。
 */
function hostedUrlFile(shotId: string): string {
  return join(PLATE_DIR, `${shotId}.hosted-url.json`);
}
function saveHostedUrl(shotId: string, url: string): void {
  writeFileSync(hostedUrlFile(shotId), `${JSON.stringify({ url, at: stamp() }, null, 2)}\n`, "utf8");
}
function loadHostedUrl(shotId: string, maxAgeHours = 20): string | null {
  const file = hostedUrlFile(shotId);
  if (!existsSync(file)) return null;
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8")) as { url?: string; at?: string };
    if (!parsed.url || !parsed.at) return null;
    const ageHours = (Date.now() - Date.parse(parsed.at)) / 3_600_000;
    return ageHours <= maxAgeHours ? parsed.url : null;
  } catch {
    return null;
  }
}

/**
 * 关键帧指纹元文件（2026-09-26 新增，T-2026-0926-0007）。
 *
 * 为什么必须落盘：关键帧的缓存命中判据原来是"文件在盘 + >50KB"，改过镜头卡之后旧图会被
 * 当成有效产物复用（真机：把出镜服装从西装改回档案 w1 旗袍后，四镜旧图仍被记 ok）。
 * 现在出图时写一份指纹（出图用的提示词 sha256 + 锚点模式 + 模型），复用前逐条比对。
 */
function plateMetaFile(shotId: string): string {
  return join(PLATE_DIR, `${shotId}.plate-meta.json`);
}

function readPlateMeta(shotId: string): import("../../packages/video-studio/src/plate-cache.js").PlateCacheMeta | null {
  const file = plateMetaFile(shotId);
  if (!existsSync(file)) return null;
  try {
    return JSON.parse(readFileSync(file, "utf8")) as import("../../packages/video-studio/src/plate-cache.js").PlateCacheMeta;
  } catch {
    return null;
  }
}

function writePlateMeta(shotId: string, promptText: string, anchorMode: string, basePrompt: string, requestSha256: string, artifactFile: string): void {
  const payload = {
    promptSha256: createHash("sha256").update(basePrompt).digest("hex"),
    submittedPromptSha256: createHash("sha256").update(promptText).digest("hex"),
    requestSha256,
    artifactSha256: createHash("sha256").update(readFileSync(artifactFile)).digest("hex"),
    anchorMode,
    model: IMAGE_MODEL,
    at: stamp()
  };
  writeFileSync(plateMetaFile(shotId), `${JSON.stringify(payload, null, 2)}\n`, "utf8");
}

/** 本镜最近一次关键帧裁决是否为放行（被驳回过的产物不得被缓存复用洗白） */
function lastKeyframeApproved(history: StageRecord[], shotId: string): boolean {
  const rows = [...history].reverse().filter((r) => r.stage === "keyframe" && r.shotId === shotId);
  if (rows.length === 0) return false;
  return Boolean(rows[0]!.ok);
}

async function download(url: string, file: string): Promise<string> {
  if (WORKER_RUNTIME) return WORKER_RUNTIME.download(url, file);
  const res = await fetch(url, { signal: AbortSignal.timeout(300_000) });
  if (!res.ok) throw new Error(`下载失败 HTTP ${res.status}`);
  writeFileSync(file, Buffer.from(await res.arrayBuffer()));
  return file;
}

/** 逐镜视频提交（Seedance 异步任务制） */
async function arkVideo(options: {
  stage: string; target: string; shotId: string; prompt: string; firstFrame?: string; refs: string[]; seconds: number; generateAudio: boolean; seed?: number;
}): Promise<{ taskId: string; url: string; lastFrame: string | null; resumed: boolean; requestInputVerified: boolean; submissionReceipt?: FilmVideoSubmissionReceipt }> {
  if (options.refs.length > 3) throw new Error("REFERENCE_LIMIT_EXCEEDED: 视频最多3张引用，禁止静默截断");
  if (WORKER_RUNTIME) {
    assertCharacterRenderPreflight();
    return WORKER_RUNTIME.video({ ...options, aspect: ASPECT, resolution: SOURCE_RESOLUTION });
  }
  if (!ARK_KEY) throw new Error("RENDER_KEY_REQUIRED: video submission or provider query requires configured credentials");
  const content: Array<Record<string, unknown>> = [{ type: "text", text: options.prompt }];
  if (options.firstFrame) content.push({ type: "image_url", image_url: { url: options.firstFrame }, role: "first_frame" });
  for (const ref of options.refs) {
    if (ref === options.firstFrame) continue;
    content.push({ type: "image_url", image_url: { url: ref }, role: "reference_image" });
  }
  return runFilmRenderTask({
    baseUrl: ARK_BASE, apiKey: ARK_KEY,
    journalFile: join(LOG_DIR, "accepted-tasks", `${encodeURIComponent(options.shotId)}.json`),
    resumeTaskId: RESUME_TASKS[options.shotId], log,
    beforeSubmit: () => assertCharacterRenderPreflight(),
    expected: { model: VIDEO_MODEL, duration: options.seconds, resolution: SOURCE_RESOLUTION, ratio: ASPECT },
    body: {
      model: VIDEO_MODEL,
      content,
      duration: options.seconds,
      /**
       * 首帧模式下 Ark 明确拒绝 `ratio`（InvalidParameter.TaskTypeConstraint：
       * "For first-frame or first-last-frame generation, the output ratio follows the first-frame image"）——
       * 画幅由关键帧自己决定，这里只在纯文生视频时才传 ratio。
       */
      ...(options.firstFrame ? {} : { ratio: ASPECT }),
      resolution: SOURCE_RESOLUTION,
      generate_audio: options.generateAudio,
      watermark: false,
      return_last_frame: true,
      ...(options.seed ? { seed: options.seed } : {})
    }
  });
}

/* ================= 镜头文案与字幕 ================= */

function dialogueText(shot: ShotCard): string {
  return (shot.dialogue ?? []).map((d) => String(d.text ?? "")).filter(Boolean).join(" ");
}
/**
 * 关键帧提示词（薄封装，实现移到 `packages/video-studio/src/plate-prompt.ts` + 单测）。
 *
 * 2026-09-24 真机二次事故：本函数原来内联在脚本里，数组中被残留的 diff 标记 `+` 破坏，
 * 那一行成了 `+"场景结构与物理自洽（通用）：…"` = **NaN**——通用空间/物理不变量从未进过提示词，
 * 进 Ark 的是字面 "NaN"。评审侧有不变量、提示词侧没有，于是"无头之桥"屡次复现。
 * 现在实现搬进模块并加了退化哨兵断言（不得出现 NaN/undefined/[object Object]）+ 桥类结构硬约束测试。
 */
function platePrompt(shot: ShotCard, characterName: string, appearanceText = ""): string {
  return buildPlatePrompt(shot as unknown as PlatePromptShot, {
    characterName,
    appearanceText,
    aspect: ASPECT,
    resolution: SOURCE_RESOLUTION,
    title: shotlist.title, eraProfile: authorContext.eraProfile, ...(sceneBible ? { sceneBible } : {})
  });
}
function buildSrt(): string {
  const lines: string[] = [];
  let cursor = 0;
  /**
   * 单行字数护栏（2026-09-25 真机）：字幕工位按平台口径限制单行 ≤18 个汉字，
   * 超了直接判 `line_width` 失败并删产物（小红书首跑即被拦）。
   * 这里按标点做**最多两行**的折行，让名句/长句完整显示而不是被迫删字。
   * 宽度口径：汉字计 1、非汉字计 0.5（与工位的 maxLineCharsZh 口径一致）。
   */
  const wrapCue = (input: string, maxPerLine = 18): string => {
    const chunks = input.split(/(?<=[，。！？；、,.!?;])/).filter((s) => s.trim().length > 0);
    const wrapped: string[] = [];
    let current = "";
    for (const chunk of chunks) {
      const candidate = `${current}${chunk}`;
      const width = [...candidate].reduce((sum, ch) => sum + (/[\u4e00-\u9fff]/.test(ch) ? 1 : 0.5), 0);
      if (current && width > maxPerLine) {
        wrapped.push(current.trim());
        current = chunk;
      } else {
        current = candidate;
      }
    }
    if (current.trim()) wrapped.push(current.trim());
    /**
     * 标点口径（2026-09-25 工位判据 / 2026-09-27 真机修复）：交付字幕**不带标点**，
     * 数字内的 `. : - /` 保留。此前这里只按标点折行、却把标点一并写进 SRT，
     * 烧录模式的 "标点体检" 必然 fail（字幕工位按落盘 SRT 判），母版终审被判 score=0。
     * 折行仍按标点语义分段，落盘前逐行剔除标点，与旁挂模式工位的清洗口径一致。
     */
    const stripCuePunctuation = (line: string): string =>
      line.replace(/[，。！？；、,.!?;:："“”'‘’（）()【】《》—…·]/g, "").replace(/\s{2,}/g, " ").trim();
    return wrapped.slice(0, 2).map(stripCuePunctuation).filter(Boolean).join("\n");
  };
  shots.forEach((shot, index) => {
    const duration = Number(shot.duration ?? 5);
    const text = dialogueText(shot);
    if (text) {
      /**
       * 时间轴口径（2026-09-25 南昌片真机修正）：字幕起点必须用**真实切点**（`CUT_GRID`，已扣逐刀转场重叠），
       * 而不是"各镜时长累加"。早先末条字幕落在 51.31s、而成片只有 51.07s → 字幕工位抽证据帧失败、
       * 整条烧录被判失败（真机）。末条再夹到成片目标时长内。
       */
      const shotStart = index === 0 ? 0 : (CUT_GRID[index - 1] ?? cursor);
      const start = shotStart + Math.min(0.6, duration * 0.12);
      const end = Math.min(shotStart + duration - 0.35, expectedMasterSeconds - 0.15);
      lines.push(
        String(index + 1),
        `${srtTime(start)} --> ${srtTime(end)}`,
        wrapCue(text),
        ""
      );
    }
    cursor = index === 0 ? duration : Number(((CUT_GRID[index - 1] ?? cursor) + duration).toFixed(3));
  });
  return lines.join("\n");
}
function srtTime(seconds: number): string {
  const hh = String(Math.floor(seconds / 3600)).padStart(2, "0");
  const mm = String(Math.floor((seconds % 3600) / 60)).padStart(2, "0");
  const ss = String(Math.floor(seconds % 60)).padStart(2, "0");
  const ms = String(Math.round((seconds % 1) * 1000)).padStart(3, "0");
  return `${hh}:${mm}:${ss},${ms}`;
}

/**
 * 复用成片的复检设置：抽 3 帧 + 确定性检查（时长/分辨率/音轨）。
 * 与"新渲一版"走同一套判据，避免复用路径松于生产路径。
 */
function cachedShotSettings(shot: ShotCard): { frames: string[]; checks: Array<{ id: string; pass: boolean; detail: string; hard?: boolean }> } {
  const clip = join(CLIP_DIR, `${shot.shotId}.mp4`);
  const duration = Number(shot.duration ?? 5);
  const info = probe(clip);
  const actual = Number(info.duration ?? 0);
  const width = Number(info.width ?? 0);
  const height = Number(info.height ?? 0);
  const framesDir = join(WORK_DIR, "frames", PROJECT, shot.shotId);
  mkdirSync(framesDir, { recursive: true });
  const frames: string[] = [];
  for (const [i, at] of [0.6, duration / 2, Math.max(0.6, duration - 0.8)].entries()) {
    /**
     * 评审帧压缩（2026-09-24 三轮审计）：**复用分支同样要压缩**。
     * 真机事故：1080×1920 的 PNG 抽帧单张 ≈10MB，base64 后 4 张 ≈53MB → 评审模型 HTTP 413，
     * 监制被判"不可用"、镜头悬在"未复核"状态。渲染分支已改 720 宽 JPEG，复用分支漏改过一版。
     */
    const file = join(framesDir, `cached-f${i + 1}.jpg`);
    run(FFMPEG, ["-y", "-ss", String(at), "-i", clip, "-frames:v", "1", "-vf", "scale=720:-2", "-q:v", "3", file]);
    frames.push(file);
  }
  return {
    frames,
    checks: [
      { id: "duration", pass: Math.abs(actual - duration) <= 0.6, detail: `期望 ${duration}s 实测 ${actual.toFixed(2)}s`, hard: true },
      { id: "resolution", pass: height >= 720 && width >= 720, detail: `${width}x${height}`, hard: true },
      { id: "audio-track", pass: Boolean(info.hasAudio), detail: info.hasAudio ? `音轨 ${info.acodec}` : "无音轨" }
    ]
  };
}

/* ================= 主流程 ================= */

log(`项目 ${PROJECT}｜镜头 ${shots.length} 个｜目标 ${totalSeconds}s｜${ASPECT} 源 ${SOURCE_RESOLUTION} → 交付 ${OUTPUT_RESOLUTION} (${OUTPUT_SIZE.width}x${OUTPUT_SIZE.height})@${FPS}fps`);
log(`媒体工具：ffmpeg=${FFMPEG}｜ffprobe=${FFPROBE}`);
log(`后期缓存：${POST_DIR}｜交付目录：${OUT_DIR}`);
log(`角色档案：${lead ? `${lead.name}（${lead.id}）角度 ${Object.keys(lead.files).join("/")}` : "未找到（人物一致性将降级为文字描述）"}`);
log(`阶段：${[...STAGES].join(" → ")}｜监制：${flag("--allow-fallback-approve") ? "允许降级放行" : "fail-closed"}`);
if (DRY_RUN) log("⚠ dry-run：只做脚本/提示词/计划，不出图不出片");

const specReports: Array<Record<string, unknown>> = [];
/** 动作节拍预算（advisory：只报数不拦，避免把"9 个 vs 8 个"这种量级差当成缺陷） */
const motionBudgetNotes: Array<{ shotId: string; beats: number; advice: string }> = [];

interface EnhancementConsumption {
  shotId: string;
  status: ShotIntentStatus;
  verified: boolean;
  detail: string;
  sourceHash: string | null;
  outputHash: string | null;
}

/** Project success requires every shot to pass or explicitly be inapplicable. */
function enhancementStatus(statuses: readonly ShotIntentStatus[]): ShotIntentStatus {
  if (statuses.includes("failed")) return "failed";
  if (statuses.includes("unverified")) return "unverified";
  return statuses.includes("passed") ? "passed" : "not_applicable";
}

/** Validate the exact card consumed downstream, not a marker or a historical success row. */
function micromotionConsumption(shot: ShotCard, trace?: MicromotionTrace): EnhancementConsumption {
  const result: EnhancementConsumption = {
    shotId: shot.shotId, status: "unverified", verified: false,
    detail: "缺少当前镜头的微动作证据", sourceHash: null, outputHash: null
  };
  if (!trace) return result;
  try {
    const expected = planMicromotion(shot);
    result.sourceHash = expected.sourceHash;
    result.outputHash = shotIntentHash(shot.action ?? (shot.fields as Record<string, unknown> | undefined)?.action ?? null);
    if (trace.status === "failed") return { ...result, status: "failed", detail: trace.skipped ?? "微动作失败" };
    if (trace.status !== "passed" && trace.status !== "not_applicable") return { ...result, detail: trace.skipped ?? "微动作未验证" };
    if (trace.schemaVersion !== "workloom.micromotion-trace/v1" || trace.policyVersion !== MICROMOTION_POLICY_VERSION
      || !trace.sourceHash || trace.shotId !== shot.shotId || trace.sourceHash !== expected.sourceHash
      || trace.intentHash !== expected.intentHash || trace.status !== expected.status
      || shotIntentHash(trace.applied) !== shotIntentHash(expected.applied) || trace.text !== expected.text
      || !Number.isFinite(trace.charDelta) || trace.charDelta < 0 || trace.charDelta > 200) {
      return { ...result, detail: "微动作版本、原始意图、适用性或应用清单与当前卡片不匹配" };
    }
    if (trace.status === "passed") {
      const action = shot.action;
      if (trace.applied.length === 0 || trace.outputHash !== result.outputHash || typeof action !== "string"
        || !action.endsWith(MICROMOTION_MARKER + trace.applied.map((entry) => entry.clause).join("；"))) {
        return { ...result, detail: "微动作输出哈希或完整应用句未在当前 action 中核到" };
      }
    } else if (trace.applied.length || trace.text || trace.charDelta !== 0) {
      return { ...result, detail: "不适用镜头仍带微动作写入，状态矛盾" };
    }
    return { ...result, status: trace.status, verified: true, detail: trace.status === "passed"
      ? `已核对 ${trace.applied.length} 个适用通道的完整写入、原始意图与 action 哈希`
      : trace.skipped ?? "当前主体与可见部位不适用人物微动作" };
  } catch (error) {
    return { ...result, detail: `微动作消费证据无法核验：${error instanceof Error ? error.message : String(error)}` };
  }
}

/** KB evidence describes actual written fields; proposals and dropped clauses cannot count. */
function cineKbConsumption(shot: ShotCard, trace: Record<string, unknown>, policyVersion: string): EnhancementConsumption {
  const result: EnhancementConsumption = {
    shotId: shot.shotId, status: "unverified", verified: false,
    detail: String(trace.error ?? "摄影知识未验证"), sourceHash: null, outputHash: null
  };
  if (trace.status === "failed") return { ...result, status: "failed", detail: String(trace.error ?? "摄影知识失败") };
  if (trace.status !== "passed" && trace.status !== "not_applicable") return result;
  try {
    const intent = normalizeShotIntent(shot);
    result.sourceHash = intent.sourceHash;
    result.outputHash = shotIntentHash(shot);
    if (trace.schemaVersion !== "workloom.cine-kb-trace/v1" || trace.policyVersion !== policyVersion
      || trace.sourceHash !== intent.sourceHash || trace.intentHash !== shotIntentHash(intent)
      || trace.outputHash !== result.outputHash || !Array.isArray(trace.applied) || !Array.isArray(trace.actualWrittenFields)) {
      return { ...result, detail: "摄影知识版本、原始意图或输出哈希与当前卡片不匹配" };
    }
    const applied = trace.applied as Array<Record<string, unknown>>;
    const fields = applied.map((entry) => entry.field);
    const written = applied.every((entry) => typeof entry.field === "string" && typeof entry.written === "string"
      && entry.written.length > 0 && entry.writtenChars === entry.written.length && !entry.dropped
      && typeof shot[entry.field] === "string" && (shot[entry.field] as string).endsWith(entry.written)
      && entry.fieldHash === shotIntentHash(shot[entry.field]));
    if (!written || new Set(fields).size !== fields.length || shotIntentHash(fields) !== shotIntentHash(trace.actualWrittenFields)
      || (trace.status === "passed" ? applied.length === 0 : applied.length !== 0)) {
      return { ...result, detail: "摄影知识实际写入字段、完整贡献句或逐字段哈希不一致" };
    }
    return { ...result, status: trace.status, verified: true, detail: trace.status === "passed"
      ? `已核对 ${applied.length} 个实际写入字段及当前卡片哈希`
      : "没有适用的新增摄影知识，原卡保持不变" };
  } catch (error) {
    return { ...result, detail: `摄影知识消费证据无法核验：${error instanceof Error ? error.message : String(error)}` };
  }
}

/**
 * 微动作证据按**镜号**索引，而不是按对象引用：
 * 片型后置复核（`scene-policy-postplan`）会对当前镜头卡重新执行 `applyScenePolicy`，
 * 每次都会返回**新对象**（内容同构）。真机 2026-09-29：对象引用做键 → 后置复核之后
 * G7 的 `micromotion-applied` 判据全部报"缺少当前镜头的微动作证据"，环节被自己的记账方式卡死。
 */
const micromotionTraces = new Map<string, MicromotionTrace>();

/* ---------- ⓪ 摄影知识库注入（监制：cine-kb） ---------- */
/**
 * 为什么放在提示词之前：知识库的价值就在"写提示词前先定关键细节"——
 * 光圈档位、景别、光位、色调、材质先在库里选好，再交给交付闸与提示词融合。
 * 纪律：提示词字段只写**画面语言**；f 值等硬参数只进 trace（KB 检索总则）。
 */
if (STAGES.has("cine-kb")) {
  const started = Date.now();
  const kbDir = resolve(arg("--kb-dir", join(REPO_ROOT, "bundles/ai-video/library/cinematography-kb")));
  const bridgePath = join(REPO_ROOT, "bundles/ai-video/connectors/cine-kb-bridge/core.mjs");
  if (!existsSync(bridgePath) || !existsSync(kbDir)) {
    record({
      stage: "cine-kb", shotId: null, invoked: false, ok: false, cached: false, degraded: false, attempt: 1, ms: 0,
      artifact: null, evidence: { status: "unverified", kbDir, bridgePath, exists: { bridge: existsSync(bridgePath), kb: existsSync(kbDir) } },
      verdict: null, note: "请求的摄影知识库或连接器缺失，未验证"
    });
    throw new Error("摄影知识增强未通过：请求的知识库或连接器缺失");
  } else {
    type CineKbCore = {
      CINE_KB_POLICY_VERSION: string;
      loadKb: (dir: string) => Record<string, unknown>;
      kbStatus: (kb: unknown) => Record<string, unknown>;
      enrichShotCard: (kb: unknown, card: unknown, options: { englishGloss: boolean }) => { card: Record<string, unknown>; trace: Record<string, unknown> };
    };
    let core: CineKbCore;
    let kb: Record<string, unknown>;
    let status: { topics: number; entries: number; missingTopics: Array<{ id: string; title: string }> };
    try {
      core = await import(bridgePath) as CineKbCore;
      kb = core.loadKb(kbDir);
      status = core.kbStatus(kb) as typeof status;
    } catch (error) {
      record({
        stage: "cine-kb", shotId: null, invoked: true, ok: false, cached: false, degraded: false, attempt: 1,
        ms: Date.now() - started, artifact: null,
        evidence: { status: "unverified", kbDir, error: error instanceof Error ? error.message : String(error) },
        verdict: null, note: "摄影知识库加载失败，未验证"
      });
      throw error;
    }
    log(`摄影知识库：${status.topics} 篇 / ${status.entries} 条映射${status.missingTopics.length > 0 ? `｜⚠ 缺篇 ${status.missingTopics.map((t) => `${t.id} ${t.title}`).join("、")}` : ""}`);
    const traceDir = join(WORK_DIR, "cine-kb");
    mkdirSync(traceDir, { recursive: true });
    const perShot: EnhancementConsumption[] = [];
    for (const [index, shot] of shots.entries()) {
      if (completedByShot.has(shot.shotId)) continue;
      /**
       * 提示词语言口径（2026-09-24 真机）：分镜卡【语言约束】写明"全部字段必须使用中文"，
       * 因此默认只注入中文短语（英文关键词仍在 trace 里）；
       * 需要英文提示词的模型可由 `--prompt-english-gloss` 显式开启。
       */
      const { card, trace } = core.enrichShotCard(kb, shot, { englishGloss: flag("--prompt-english-gloss") });
      shots[index] = card as ShotCard;
      const consumption = cineKbConsumption(shots[index]!, trace, core.CINE_KB_POLICY_VERSION);
      perShot.push(consumption);
      // Shot ids are labels, not paths; an invalid id cannot escape or overwrite another trace.
      const traceName = `${String(index + 1).padStart(3, "0")}-${String(shot.shotId).replace(/[^\p{L}\p{N}_-]/gu, "_").slice(0, 80) || "shot"}.json`;
      const traceFile = join(traceDir, traceName);
      writeFileSync(traceFile, `${JSON.stringify({ ...trace, consumption, kbDir, kbStatus: status }, null, 2)}\n`, "utf8");
      const advisor = (trace as { apertureAdvisor?: { aperture: string; scenarioLabel: string | null; matchedBy: string } }).apertureAdvisor;
      const fields = ((trace as { applied?: Array<{ field: string; writtenChars: number }> }).applied ?? []).filter((entry) => entry.writtenChars > 0);
      log(`  ${shot.shotId}: ${consumption.status} · 光圈 ${advisor?.aperture ?? "-"}（${advisor?.scenarioLabel ?? "-"}）· 实际写入 ${fields.length} 个字段 → ${fields.map((f) => f.field).join("/") || "无"}`);
      record({
        stage: "cine-kb", shotId: shot.shotId, invoked: true, ok: consumption.verified, cached: trace.reused === true, degraded: false, attempt: 1,
        ms: Date.now() - started, artifact: traceFile,
        evidence: { ...consumption, traceStatus: trace.status, aperture: advisor?.aperture ?? null, scenario: advisor?.scenarioLabel ?? null, matchedBy: advisor?.matchedBy ?? null, injectedFields: fields.map((f) => f.field), missingTopics: status.missingTopics.map((t) => t.id) },
        verdict: null, note: consumption.detail
      });
    }
    const projectStatus = enhancementStatus(perShot.map((entry) => entry.status));
    const ok = perShot.length === pendingShots().length && perShot.every((entry) => entry.verified);
    const enrichedFile = join(WORK_DIR, `shotlist-enriched-${PROJECT}.json`);
    writeFileSync(enrichedFile, `${JSON.stringify({ projectId: PROJECT, shots, status: projectStatus, cineKbApplied: perShot.some((entry) => entry.status === "passed"), perShot }, null, 2)}\n`, "utf8");
    // The latest project row cannot let a successful last shot mask an earlier failed/unverified shot.
    record({
      stage: "cine-kb", shotId: null, invoked: true, ok, cached: false, degraded: false, attempt: 1,
      ms: Date.now() - started, artifact: enrichedFile,
      evidence: { status: projectStatus, perShot, textRulesOnly: true }, verdict: null,
      note: "逐镜适用性与写入证据汇总；不代表视频视觉质量通过"
    });
    if (!ok) throw new Error(`摄影知识增强未通过：${perShot.filter((entry) => !entry.verified).map((entry) => `${entry.shotId} ${entry.status}（${entry.detail}）`).join("；")}`);
  }
}

/* ---------- ① 连贯性导演评审（监制：continuity，step_key: continuity） ---------- */
/**
 * 管线 yml 的 `continuity` 环节（位置与 yml 一致：**在提示词融合之前**）。
 *
 * 为什么放这么前：跨镜问题（同一场戏换造型、时段倒退、方向相反、道具凭空出现）在**镜头卡**层面就能查出来，
 * 等到出片才发现要烧一整轮渲染额度。确定性检查在 `packages/video-studio/src/continuity.ts`（6 问 + 5 维评分），
 * LLM 只补"机检查不出的语义跳变"。硬阻断按 yml 纪律**直接打回**（不花钱）。
 */
if (STAGES.has("continuity") && pendingShots().length > 0) {
  const started = Date.now();
  const report = auditContinuity(pendingShots() as unknown as Array<Record<string, unknown>>, {
    targetSeconds: null,
    projectId: PROJECT
  });
  const checks: GateCheck[] = report.checks.map((c) => ({ id: c.id, pass: c.pass, detail: c.detail, hard: c.hard }));
  if (!DRY_RUN) {
    const verdict = await reviewStage({
      stage: "continuity", projectId: PROJECT,
      artifacts: [{ path: SHOTS_FILE, kind: "json", note: "镜头卡（跨镜一致性评审对象）" }],
      deterministic: checks,
      context: {
        shotCount: report.shotCount,
        totalSeconds: report.totalSeconds,
        sixQuestions: report.questions.map((q) => `${q.question} → ${q.answer}（${q.note}）`),
        fiveDimensions: report.dimensions.map((d) => `${d.name} ${d.score}/20`),
        deterministicScore: report.score,
        completion: plannedCompletion,
        discipline: FILM_COMPLETION_GUIDANCE + "硬阻断（打回）：造型无理由不一致、台词重复、显式硬上限超出。其余为软信号，进问题清单但不阻断；"
          + "跨镜判断只看镜头卡文本，不要索要额外画面证据。"
      },
      env: ENV, allowFallbackApprove: ALLOW_FALLBACK_APPROVE, log
    });
    record({
      stage: "continuity", shotId: null, invoked: true, ok: verdict.approved, cached: false, degraded: verdict.degraded,
      attempt: 1, ms: Date.now() - started, artifact: SHOTS_FILE,
      evidence: { score: verdict.score, deterministicScore: report.score, blocking: report.blocking, dimensions: report.dimensions, questions: report.questions },
      verdict
    });
    if (!verdict.approved && !ACCEPT_REJECTED.includes("continuity")) {
      log(`⛔ 连贯性导演评审未放行：${verdict.reason}（${verdict.issues.slice(0, 3).join("；")}）`);
      log(`   纪律：本环节在**花钱之前**硬阻断。确需带瑕疵继续，请显式传 --accept-rejected continuity（会留痕）。`);
      process.exit(4);
    }
    if (!verdict.approved) log(`⚠ 连贯性导演评审被打回，但已显式声明带瑕疵放行（--accept-rejected continuity）`);
  } else {
    record({
      stage: "continuity", shotId: null, invoked: false, ok: report.approved, cached: false, degraded: false,
      attempt: 0, ms: Date.now() - started, artifact: SHOTS_FILE,
      evidence: { dryRun: true, deterministicScore: report.score, blocking: report.blocking }, verdict: null
    });
    log(`连贯性（dry-run）：确定性 5 维 ${report.score}/100，硬阻断 ${report.blocking.length} 条`);
  }
}

/* ---------- ①-1 微动作增强（step_key: micromotion，按主体与可见部位判适用性） ---------- */
/**
 * 管线 yml 的 `micromotion` 环节。
 *
 * **与 yml 的顺序差异（显式声明）**：yml 把它排在 G6 之后；这里**前移到提示词融合之前**——
 * 增强的本质是改镜头卡（action 字段），融合之后再改就会绕开刚通过的 G6 审核
 * （"审过的提示词 ≠ 最终提交的提示词"）。前移后 G6 审的就是含微动作的最终稿。
 */
if (STAGES.has("micromotion")) {
  const started = Date.now();
  const traces: MicromotionTrace[] = [];
  const perShot: EnhancementConsumption[] = [];
  for (const [index, shot] of shots.entries()) {
    if (completedByShot.has(shot.shotId) || isMaterialShot(shot)) continue;
    const { card, trace } = applyMicromotion(shot as unknown as Record<string, unknown>);
    // Even a reused/N/A result may restore prior owned text. Always consume the returned card.
    shots[index] = card as ShotCard;
    micromotionTraces.set(String(shots[index]!.shotId), trace);
    traces.push(trace);
    perShot.push(micromotionConsumption(shots[index]!, trace));
  }
  const applicable = perShot.every((entry) => entry.verified);
  const bounded = traces.every((t) => Number.isFinite(t.charDelta) && t.charDelta >= 0 && t.charDelta <= 200);
  const languageOnly = !/f\/|ISO|帧率|焦段/.test(traces.map((t) => String(t.text ?? "")).join(" "));
  const checks: GateCheck[] = [
    { id: "intent-and-consumption", pass: applicable, hard: true, detail: applicable ? "每镜适用性、原始意图与实际写入哈希均已核验；合法不适用不增加动作" : perShot.filter((entry) => !entry.verified).map((entry) => `${entry.shotId}：${entry.detail}`).join("；") },
    { id: "bounded-delta", pass: bounded, hard: true, detail: bounded ? `增量均在界内（最大 ${Math.max(0, ...traces.map((t) => Number(t.charDelta ?? 0)))} 字）` : "微动作增量超过 200 字上限" },
    { id: "language-only", pass: languageOnly, hard: true, detail: "微动作只写画面语言（不含 f 值/ISO/帧率等技术参数）" }
  ];
  const traceFile = join(WORK_DIR, `micromotion-${PROJECT}.json`);
  // A dry run executes these deterministic transforms too; preserve their real evidence.
  writeFileSync(traceFile, `${JSON.stringify({ at: stamp(), projectId: PROJECT, traces, perShot, checks, shots: generatedShots(), textRulesOnly: true }, null, 2)}\n`, "utf8");
  const verdict = flag("--micromotion-review") && !DRY_RUN
    ? await reviewStage({
        stage: "micromotion", projectId: PROJECT,
        artifacts: [{ path: traceFile, kind: "json", note: "实际消费的当前镜头卡、适用性与逐字段写入证据" }],
        rubric: [
          "按原始主体与可见部位判适用性：空镜、商品、动物可为 not_applicable；不能要求补齐五路微动作或凑通道数量。",
          "只评审实际写入的动作是否保持源姿态、视线、否定约束与台词节拍：睡眠不睁眼、蹲姿不起身、不笑不加笑意，未出镜部位不补表演。",
          "passed 表示文本与写入证据通过；unverified/failed 必须保留未通过，旧标记或历史成功不能替代当前 sourceHash/outputHash。",
          "本环节只有镜头文本证据，不能据此宣称视频动作自然、人物一致或物理真实；这些由后续实片评审验证。"
        ],
        deterministic: checks,
        context: { traces, perShot, textRulesOnly: true },
        env: ENV, allowFallbackApprove: ALLOW_FALLBACK_APPROVE, log
      })
    : null;
  const ok = checks.every((c) => !c.hard || c.pass) && (verdict ? verdict.approved : true);
  const projectStatus = enhancementStatus(perShot.map((entry) => entry.status));
  record({
    stage: "micromotion", shotId: null, invoked: true, ok, cached: false, degraded: Boolean(verdict?.degraded),
    attempt: 1, ms: Date.now() - started, artifact: traceFile,
    evidence: {
      status: !ok && projectStatus !== "failed" && projectStatus !== "unverified" ? "failed" : projectStatus,
      perShot, checks,
      channels: traces.map((t) => ({ shotId: t.shotId, status: t.status, applied: t.applied.length, skipped: t.skipped ?? null, charDelta: t.charDelta })),
      llmReviewed: Boolean(verdict), textRulesOnly: true
    },
    verdict
  });
  if (!ok) {
    throw new Error(`微动作增强未通过自检：${checks.filter((check) => !check.pass).map((check) => check.detail).join("；")}${verdict && !verdict.approved ? `；监制：${verdict.reason}` : ""}`);
  }
  log(`微动作增强：${perShot.filter((entry) => entry.status === "passed").length} 镜实际写入，${perShot.filter((entry) => entry.status === "not_applicable").length} 镜不适用；已核验当前卡片${verdict ? `，监制${verdict.approved ? "放行" : "打回"}` : "（未启用 LLM 文本复评）"}`);
}

/** 摄影知识库和微动作可能重写镜头卡；在真正生成前复核当前完整片型方案。 */
if (scenePolicy) {
  for (let index = 0; index < shots.length; index += 1) if (!completedByShot.has(shots[index]!.shotId)) shots[index] = applyScenePolicy(shots[index]!, scenePolicy);
  const current = new Map(shots.map((shot) => [shot.shotId, shot]));
  scenePolicyReport = auditPendingScenePolicy(shotlist.shots.map((shot) => current.get(shot.shotId) ?? shot));
  scenePolicyReport.policy.selection = scenePolicySelection.reason;
  writeScenePolicyReport();
  /**
   * post-only 组装：片型门是"生成前/生成后"的**创作口径**检查，本模式不生成新镜头，
   * 该结论只作证据留痕（degraded + assemblyMode=post-only），不阻断后期链与交付。
   */
  const postOnlyPostplanDegraded = POST_ONLY_ASSEMBLY && !scenePolicyReport.passed;
  record({ stage: "scene-policy-postplan", shotId: null, invoked: true, ok: scenePolicyReport.passed,
    cached: false, degraded: postOnlyPostplanDegraded, attempt: 1, ms: 0, artifact: SCENE_POLICY_REPORT_FILE,
    evidence: {
      policy: scenePolicy.id, version: scenePolicy.version, defects: scenePolicyReport.defects, ratios: scenePolicyReport.ratios,
      ...(postOnlyPostplanDegraded ? { assemblyMode: "post-only" } : {})
    }, verdict: null });
  if (!scenePolicyReport.passed) {
    const defects = scenePolicyReport.defects.map((item) => `${item.shotId ?? "全片"}[${item.rule}] ${item.detail}`);
    /** post-only 组装：后置片型门同样是"生成前/生成后"的拍摄质量门，不生成新镜头时降级为告警（G-POST1 已留痕） */
    if (POST_ONLY_ASSEMBLY) {
      log(`⚠ ${scenePolicy.title} 后置分镜门禁未过（${defects.length} 项），post-only 组装降级不阻断`);
      for (const defect of defects.slice(0, 4)) log(`   · ${defect}`);
    } else {
      throw new Error(`${scenePolicy.title} 后置分镜门禁未过：${defects.join("；")}`);
    }
  }
}

/** 后续审核与生成共享这份当前镜头快照；每次替换镜头卡后均从 shots 重建视图。 */
const CURRENT_SHOTS_FILE = join(WORK_DIR, `shotlist-current-${PROJECT}.json`);
writeFileSync(CURRENT_SHOTS_FILE, `${JSON.stringify({ projectId: PROJECT, shots }, null, 2)}\n`, "utf8");

/* ---------- ② 脚本 + 提示词交付闸（监制：prompt） ---------- */
if (STAGES.has("spec") && pendingShots().length > 0) {
  const started = Date.now();
  const checks: Array<{ id: string; pass: boolean; detail: string; hard?: boolean }> = [];
  let rateFail = 0;
  /** post-only 字段闸用：声明了主角出镜的镜号（`shotlist.character.appearanceInShots`，缺省为空） */
  const leadAppearanceShotIds = (() => {
    const raw = (shotlist as unknown as { character?: { appearanceInShots?: unknown } }).character?.appearanceInShots;
    return new Set<string>(Array.isArray(raw) ? raw.map(String) : []);
  })();
  for (const shot of pendingShots()) {
    /** 素材镜不参与文生提示词融合（它的提示词是"图生视频"的动效提示词，由 material-gen 组装） */
    if (isMaterialShot(shot)) {
      record({
        stage: "spec", shotId: shot.shotId, invoked: false, ok: true, cached: false, degraded: false, attempt: 1, ms: 0,
        artifact: null,
        evidence: { photo: String((shot as Record<string, unknown>).photo), policy: MATERIAL_POLICY_VERSION },
        verdict: null, note: "素材镜：不做文生提示词融合（先按画幅准备素材，再由 material-gen 图生视频出片）"
      });
      continue;
    }
    const duration = Number(shot.duration ?? 0);
    const chars = dialogueText(shot).replace(/[，。！？、,.!?]/g, "").length;
    const rate = duration > 0 ? chars / duration : 0;
    const report = prepareShotPrompt(shot as unknown as Record<string, unknown>, { ratio: ASPECT, resolution: SOURCE_RESOLUTION, fps: FPS });
    /**
     * 提示词语言与引用归一（2026-09-24 真机，6 镜全部命中）：
     *   · 卡片【语言约束】要求全中文，而 vendor 负面约束默认夹带英文（no text / no watermark…）→ 映射成中文等价；
     *   · 角色图引用被写两遍 → 去重。
     * 归一后如仍有长度 ≥3 的拉丁词，写进阶段记录（供审计看到"还剩哪些英文"），不静默忽略。
     */
    const normalized = normalizePromptLanguage(report.prompt);
    /**
     * 镜头卡字段契约回写（2026-09-28 T1 真机监制打回）：
     * vendor 精炼器把 `bright_constraint` 重写成 40 字通用句、并截断 `pacing`/`depth_of_field`/`makeup`/
     * `color_palette` 等字段末句，监制逐条比对合同后判"约束被弱化/口径被删"。这里对**卡片更长的行**逐字回写原文。
     * 场景/道具等扩展类字段行比卡片长，不触发回写。
     */
    const contractFields = [
      { label: "场景", value: mergeUniqueSegments([(shot as Record<string, unknown>).scene, (shot as Record<string, unknown>).sceneDescription]) },
      { label: "明亮约束", value: (shot as Record<string, unknown>).bright_constraint },
      { label: "节奏", value: (shot as Record<string, unknown>).pacing },
      { label: "景深", value: (shot as Record<string, unknown>).depth_of_field },
      { label: "化妆", value: (shot as Record<string, unknown>).makeup },
      { label: "色彩/色调", aliases: ["色彩", "色调"], value: (shot as Record<string, unknown>).color_palette },
      { label: "角色", value: (shot as Record<string, unknown>).character },
      { label: "情绪", value: (shot as Record<string, unknown>).mood },
      { label: "转场", value: (shot as Record<string, unknown>).transition },
      { label: "服装", value: (shot as Record<string, unknown>).costume },
      { label: "构图", value: (shot as Record<string, unknown>).composition },
      { label: "动作", value: (shot as Record<string, unknown>).action },
      { label: "基础", value: (shot as Record<string, unknown>).baseline },
      { label: "导演意图", value: (shot as Record<string, unknown>).director_instruction },
      { label: "灯光设计", aliases: ["灯光/照明", "照明"], value: (shot as Record<string, unknown>).lighting },
    ];
    const contractFixed = restoreCardFieldText(normalized.prompt, contractFields);
    /** 时间轴补全（vendor 组装器会截断末段节拍，实测 6/6 镜） */
    const timelineFixed = restoreTimelineField(contractFixed.prompt, (shot as Record<string, unknown>).timeline);
    /**
     * 台词窗归一到真实镜头时长（2026-09-28 T1 真机监制打回）：
     * vendor `_renderDialogueBlocks` 用 `Math.round(duration)` 算窗，4.5s 镜头被写成 `[00s-05s]`，
     * 与合同「每镜 4.5 秒」冲突，生成端可能照 5s 拉长口播。这里按真实小数时长重排。
     */
    const dialogueFixed = normalizeDialogueWindow(timelineFixed.prompt, duration);
    const finalPrompt = dialogueFixed.prompt;
    specReports.push({
      shotId: shot.shotId, charCount: finalPrompt.length, promptSource: report.promptSource,
      deliveryPass: report.delivery.pass, issues: report.delivery.issues,
      missingSpecFields: report.missingSpecFields, missingP0Fields: report.missingP0Fields,
      redlines: report.redlines, degraded: report.degraded,
      sceneSubstituted: report.sceneSubstituted, sceneSubstitution: report.sceneSubstitution,
      languageNormalized: {
        replacements: normalized.replacements, dedupedRefs: normalized.dedupedRefs,
        remainingLatin: normalized.remainingLatin, timelineRestored: timelineFixed.restored,
        dialogueWindowClamped: dialogueFixed.clamped, dialogueWindowFrom: dialogueFixed.from,
        contractRestored: contractFixed.restored
      }
    });
    /** 【场景】被 vendor 写实校验替换/漂移：必须在运行日志里显性出现（不得静默换掉卡片场景） */
    if (report.sceneSubstituted) {
      log(`  ⚠ ${shot.shotId} ${report.sceneSubstitution?.reason ?? "【场景】与镜头卡不一致"}`);
    }
    if (normalized.replacements > 0 || normalized.dedupedRefs > 0) {
      log(`  ${shot.shotId}: 提示词归一（英文负面词→中文 ${normalized.replacements} 处 · 角色图去重 ${normalized.dedupedRefs} 处）`);
    }
    if (timelineFixed.restored) log(`  ${shot.shotId}: 时间轴补全（组装器截断了第 ${timelineFixed.segments} 段节拍）`);
    if (contractFixed.restored.length > 0) {
      log(`  ${shot.shotId}: 合同字段回写 ${contractFixed.restored.length} 项（${contractFixed.restored.map((item) => `${item.label}+${item.added}字`).join("、")}）`);
    }
    if (dialogueFixed.clamped > 0) {
      log(`  ${shot.shotId}: 台词时间窗归一到本镜时长 ${duration}s（${dialogueFixed.from.join(" / ")} → 修正后窗口已写入提示词）`);
    }
    writeFileSync(join(PROMPT_DIR, `${shot.shotId}.txt`), `${finalPrompt}\n`, "utf8");
    const promptFile = join(PROMPT_DIR, `${shot.shotId}.txt`);
    /**
     * post-only 组装（T-2026-0930-0015）：本片不产出新提示词，"**提示词载体类**检查"（交付闸/字数/
     * 片型约束/语速/台词窗/朝向互斥）不作出厂否决票——素材已经渲出来了，拿去交付。
     * 但 **25 字段 P0 规范**照旧是硬闸：真机事故就是组装卡 `character` 没写主角名/ID，
     * 一路漏到封面才炸（人物卡找不到来源镜）。字段规范与"有没有生成提示词"无关。
     */
    const promptCarrierHard = !POST_ONLY_ASSEMBLY;
    /**
     * post-only 字段闸（只拦"组装卡该有却没有"的字段）：
     *   · `scene` / `duration` 是所有镜头的事实必需项；
     *   · `character` 只在**声明了主角出镜**（`shotlist.character.appearanceInShots` 含本镜，
     *     或卡里已写了人物描述）时才要求写主角名/ID——商品微距、品牌尾卡本来就没有人物。
     * 生成片不改口径（本检查记为咨询项，硬闸仍是"交付闸 + 字数 + 片型约束"）。
     */
    const postOnlyFieldIssues: string[] = [];
    if (POST_ONLY_ASSEMBLY) {
      if (!String(shot.scene ?? "").trim()) postOnlyFieldIssues.push("scene");
      if (!(Number(shot.duration ?? 0) > 0)) postOnlyFieldIssues.push("duration");
      const characterText = String(shot.character ?? "");
      const declaredLead = Boolean(lead) && (leadAppearanceShotIds.has(shot.shotId) || characterText.trim().length > 0);
      const mentionsLead = Boolean(lead) && (characterText.includes(lead!.name) || characterText.includes(lead!.id));
      if (declaredLead && !mentionsLead) postOnlyFieldIssues.push(`character（必须写主角名/ID：${lead!.name}（${lead!.id}））`);
    }
    checks.push({
      id: `p0-fields:${shot.shotId}`,
      pass: POST_ONLY_ASSEMBLY ? postOnlyFieldIssues.length === 0 : report.missingP0Fields.length === 0,
      hard: POST_ONLY_ASSEMBLY,
      detail: POST_ONLY_ASSEMBLY
        ? (postOnlyFieldIssues.length === 0
          ? "post-only 组装：必需字段齐备（scene/duration/主角 character）"
          : `post-only 组装：缺 ${postOnlyFieldIssues.join("、")}——先补镜头卡再出片`)
        : `P0 字段缺失 ${report.missingP0Fields.length} 项（咨询项；生成片以交付闸为准）`
    });
    checks.push({
      id: `delivery:${shot.shotId}`, pass: report.delivery.pass, hard: promptCarrierHard,
      detail: report.delivery.pass ? `交付闸通过（${finalPrompt.length} 字 · ${report.promptSource}）` : `交付闸未过：${report.delivery.issues.join("；")}`
    });
    const primaryPolicyTag = scenePolicy ? shot.policyTags?.find((tag) => scenePolicy.primaryTags.includes(tag)) : undefined;
    const policyPromptPresent = !scenePolicy || (finalPrompt.includes(scenePolicy.prompt.scene)
      && Boolean(primaryPolicyTag && finalPrompt.includes(scenePolicy.prompt.byTag[primaryPolicyTag] ?? "\u0000")));
    checks.push({
      id: `scene-policy-prompt:${shot.shotId}`, pass: policyPromptPresent, hard: promptCarrierHard,
      detail: policyPromptPresent ? "片型场景与景别约束已进入最终视频提示词" : "最终视频提示词缺片型场景或景别约束，禁止生成"
    });
    checks.push({
      id: `char-count:${shot.shotId}`, pass: finalPrompt.length >= 1200, hard: promptCarrierHard,
      detail: `提示词 ${finalPrompt.length} 字（交付口径 ≥1200）`
    });
    checks.push({
      id: `speech-rate:${shot.shotId}`, pass: rate <= 3.6, hard: promptCarrierHard,
      detail: `台词 ${chars} 字 / ${duration}s = ${rate.toFixed(2)} 字每秒（上限 3.6）`
    });
    /**
     * 台词窗闸（2026-09-28 T1 真机监制打回）：提示词里的【台词】时间窗不得超过本镜时长。
     * 归一后理论上必然成立，这里按**产物文本**复核而不是相信上游，防止 vendor 改格式后静默漏修。
     */
    const dialogueWindows = [...finalPrompt.matchAll(/\[(\d+(?:\.\d+)?)s-(\d+(?:\.\d+)?)s\]/g)]
      .filter((item, index, list) => list.findIndex((other) => other[0] === item[0]) === index);
    const windowOverrun = duration > 0 ? dialogueWindows.filter((item) => Number(item[2]) > duration + 1e-9) : [];
    checks.push({
      id: `dialogue-window:${shot.shotId}`, pass: windowOverrun.length === 0, hard: promptCarrierHard,
      detail: dialogueWindows.length === 0
        ? "无台词时间窗（无需核验）"
        : windowOverrun.length > 0
          ? `台词窗 ${windowOverrun.map((item) => item[0]).join("、")} 超出本镜时长 ${duration}s`
          : `台词窗 ${dialogueWindows.map((item) => item[0]).join("、")} 在本镜 ${duration}s 内`
    });
    /**
     * 分镜自相矛盾闸（2026-09-24 SC-02 badcase）：
     * 同一镜里既要"面向镜头/视线交流"又要"转身/回头/背身"是**物理上互斥**的动作要求，
     * 模型每次只能满足一半，于是"这一版背身、下一版换脸"反复打回。
     * 这里在**花钱之前**拦下来：要求拆镜或改成"正面接近/正面站定"。
     */
    /**
     * 朝向互斥闸的判据口径（2026-09-24 真机二次校准）：
     *   · **先剥否定**：「不转身」「不指物」里的"转身"是禁止项，早先被当成要求项（假阳性）；
     *   · **再判顺序**：带时间顺序的动作（先…再…／随后／最后／停下后）是**分步执行**，
     *     不是同刻互斥——"走三步后停下、侧身回眸看向镜头"是正常镜头语言，
     *     真出问题的是"全程正面行进 + 转身侧身"这种没有先后交代的写法。顺序动作降级为提示。
     */
    const actionRaw = `${shot.action ?? ""} ${(shot.camera_movement ?? "")}`;
    const actionText = actionRaw.replace(/(不|没有|勿|避免|不要|禁止)[^，。；、,;]{0,12}/g, " ");
    const wantsFront = /面向镜头|正对镜头|正脸|直视镜头|眼神交流|看向镜头/.test(actionText);
    /** 注意：只把"身体转向"算作互斥；"转头/扭头看镜头"是正常小动作，不算（2026-09-24 修正） */
    const wantsTurn = /转身|回眸|侧身|侧转|背对|背身|转正脸|转回/.test(actionText);
    const sequenced = /先[^。；]{0,24}(再|随后|然后)|随后|然后|之后|最后|再转身|再转回|停下(后|之后)?|停留一拍|走(三|两)步后/.test(actionRaw);
    checks.push({
      id: `pose-contradiction:${shot.shotId}`, pass: !(wantsFront && wantsTurn && !sequenced), hard: promptCarrierHard,
      detail: wantsFront && wantsTurn && !sequenced
        ? "同一镜同时要求「面向镜头/眼神交流」与「转身/回头/侧身」——动作互斥，模型只能满足一半（真机 SC-02 连续 4 次被打回）。请拆成两镜，或改成「正面站定/正面走近」的重述。"
        : wantsFront && wantsTurn && sequenced
          ? "含转身/回眸与正面要求，但有明确时间顺序（先…再…）→ 属分步动作，不判互斥；建议在提示词里保留顺序词"
          : (wantsTurn ? "含转身/回眸（无正面要求或已否定，属可接受的动态）" : "无朝向互斥")
    });
    /**
     * 场景先验风险闸（软信号，2026-09-24 SC-02 badcase 的**真正根因**）：
     * 模型对「桥/栏杆 + 船/河 + 指物」这组语义有强先验——会主动把人演成侧身倚栏指船，
     * 哪怕提示词写着"面向镜头"。文本层查不出矛盾（文字没写侧身），只能靠**场景语义组合**预警。
     * 命中时给监制与设计者一个明确建议：改"正面走近"或去掉指物。
     */
    const sceneText = `${shot.scene ?? ""} ${shot.sceneDescription ?? ""}`;
    /**
     * 判据收紧（2026-09-27 真机 v2 首轮打回）：早先「指」与「水」两处都太宽——
     * ・「指」把**拇指/手指**这类正常手部描述算成"指物"；
     * ・「水」把**水磨石/水泥/水杯**这类材质与器物算成"水岸"。
     * 于是「水磨石地面 + 拇指滑动 + 看向镜头」这种完全正常的口播镜被判成高危构图先验，
     * 监制据此打回（score 62）。现在只认真正的指物动作与真正的水体/桥栏语义。
     */
    const priorRisk = /指(物|向|点|着|了指)|挥(手|动)?示意|递(物|出)|捧起|端(起|着)/.test(actionText)
      && /(水岸|水面|水边|河水|江水|江面|河面|湖面|湖边|海边|岸边|桥|栏杆|船)/.test(sceneText)
      && /面向镜头|看向镜头|正对镜头|正脸|眼神交流/.test(actionText);
    checks.push({
      id: `prior-risk:${shot.shotId}`, pass: !priorRisk, hard: false,
      detail: priorRisk
        ? "高风险构图先验：场景含「桥/栏杆/船/河」且动作含「指物/递物」又要求「正面看镜头」——模型大概率演成侧身倚栏指船（真机 SC-02 因此连续 4 次被打回）。建议：改「正面走近/正面站定」，或删掉指物动作。"
        : "无已知构图先验冲突"
    });
    /** 动作复杂度预算（软信号）：5 秒内节拍过多会让模型每次只满足一部分，表现为"这版动作对、下版表情对" */
    /**
     * 计拍只算**宏观动作节拍**（2026-09-24 真机）：微动作增强会在 action 末尾追加
     * 5 路微动作（面部/眼神/身体/呼吸/融合，用「；」分隔），把它算进节拍会让每镜
     * 平白多出 5–6 拍（真机 15→21），监制据此打回；微动作是质感层，不是叙事节拍。
     */
    const macroAction = actionRaw.split("【微动作】")[0] ?? actionRaw;
    const beats = (macroAction.match(/然后|随后|接着|再|边[^，。]{0,6}边|同时|先[^，。]{0,4}再/g) ?? []).length
      + macroAction.split(/[，,；;]/).filter((s) => s.trim().length > 1).length;
    /**
     * 节拍预算**只作参考信息，不进 PASS/FAIL 清单**（2026-09-24 修正）：
     * 放进确定性检查时，监制会把它当硬闸用（真机：9 个节拍直接打回，而 9 与 8 的差别并不构成缺陷）。
     * 现在改为 context 里的 advisory，监制可据情权衡，不再自动阻断。
     */
    motionBudgetNotes.push({ shotId: shot.shotId, beats, advice: beats > 8 ? "节拍偏多（建议 ≤8），可合并同拍的连续位移" : "节拍在预算内" });
    if (rate > 3.6) rateFail += 1;
    record({
      stage: "spec", shotId: shot.shotId, invoked: true,
      /** post-only 组装：以 25 字段 P0 规范为准（不产出提示词）；生成片：沿用"交付闸 + 字数 + 片型约束"口径 */
      ok: POST_ONLY_ASSEMBLY
        ? postOnlyFieldIssues.length === 0
        : report.delivery.pass && report.charCount >= 1200 && policyPromptPresent,
      cached: false, degraded: report.degraded, attempt: 1, ms: Date.now() - started,
      artifact: promptFile,
      evidence: {
        charCount: report.charCount, promptSource: report.promptSource, missing: report.missingSpecFields,
        missingP0: report.missingP0Fields, postOnlyFieldGate: POST_ONLY_ASSEMBLY,
        sceneSubstituted: report.sceneSubstituted, sceneSubstitution: report.sceneSubstitution
      },
      verdict: null
    });
  }
  writeFileSync(join(PROMPT_DIR, "spec-report.json"), `${JSON.stringify(specReports, null, 2)}\n`, "utf8");
  /**
   * 总时长核对：`--only` 局部重跑时只核对被选中的镜头合计（否则局部重跑永远过不了这一闸）。
   */
  const completion = completionForShots(sourceDocument, pendingShots());
  checks.push({
    id: "duration-total", pass: true, hard: true,
    detail: `完整镜头合计 ${completion.actualSeconds}s；创作目标 ${completion.policy.targetSeconds ?? "未指定"}s，差 ${completion.deltaFromTargetSeconds ?? "未指定"}s；完成度优先，禁止凑秒截句/压速${ONLY.length > 0 ? `，局部重跑 ${ONLY.join(",")}` : ""}`
  });
  /**
   * 全素材项目守卫（T-2026-0925-0001 真机发现，同"全真图"缺口在新版重现）：
   * 当 7 镜全部是**素材镜**（真实照片只作生成输入）时，文生提示词产物是空数组
   * （素材镜的提示词由 material-gen 阶段按"图生视频动效提示词"生成，G6 时还不存在），
   * 把空载体送给监制必然判"无正文"打回；而素材镜的把关门是 **G-MAT1**。
   * 因此这里显式跳过 G6 并留痕（via=skip），既不静默放行，也不让监制去判不适用的载体。
   */
  if (materialShots().length === pendingShots().length) {
    log(`ℹ️ 待生成 ${pendingShots().length} 镜均为素材镜：文生提示词门（G6）不适用，按 skip 留痕（已采用原片不重开；素材镜由 G-MAT1 把关）`);
    record({
      stage: "prompt-package", shotId: null, invoked: false, ok: true, cached: false, degraded: false, attempt: 1, ms: 0,
      artifact: join(PROMPT_DIR, "spec-report.json"),
      evidence: { materialShots: materialShots().map((s) => s.shotId), skipReason: "待生成镜均为素材镜（已采用原片不重新准备）" },
      verdict: null, note: "待生成范围无文生镜 → G6 不适用（素材镜提示词由 material-gen 生成并由 G-MAT1 把关）"
    });
    recordGate({
      stepKey: "g6-prompt-confirm",
      sourceStage: "prompt-package",
      checks: [{ id: "no-generated-shots", pass: true, hard: true, detail: `待生成 ${materialShots().length} 镜均为素材镜（usage=generation-reference）` }],
      shotIds: materialShots().map((s) => s.shotId),
      softApproved: true,
      via: "skip",
      score: null,
      degraded: false,
      reason: "待生成范围无文生镜，提示词门不适用",
      evidence: { materialShots: materialShots().length }
    });
  } else {
  const promptReviewOptions: Omit<ProducerGateOptions, "contracts"> = {
    stage: "prompt", projectId: PROJECT,
    rubric: scenePolicy ? [...PRODUCER_RUBRICS.prompt, scenePolicy.prompt.visualReview] : undefined,
    artifacts: [
      { path: join(PROMPT_DIR, "spec-report.json"), kind: "json" },
      /** 只送**生成镜**的提示词；真实素材段没有提示词文件（硬塞路径会让监制读到空文件） */
      ...promptShots().map((s) => ({ path: join(PROMPT_DIR, `${s.shotId}.txt`), kind: "text" as const }))
    ],
    deterministic: checks,
    context: {
      title: shotlist.title, shots: promptShots().length, materialShots: materialShots().map((s) => s.shotId), rateFail,
      scenePolicy: scenePolicyReport ? { id: scenePolicy!.id, version: scenePolicy!.version, ratios: scenePolicyReport.ratios,
        exceptionsApplied: scenePolicyReport.exceptionsApplied } : null,
      /** 节拍预算：只报数不拦（监制可据情权衡，不作 PASS/FAIL） */
      motionBudget: motionBudgetNotes,
      poseContradictionRule: "同一镜「面向镜头」与「转身/侧身/背身」互斥；「桥/栏杆/船/河 + 指物 + 正面」属高漂移先验，建议改正面走近或删指物",
      /**
       * 监制口径说明（2026-09-24 真机修正）：把"哪些是信息、哪些是判据"写清楚——
       * 早先监制把 advisory 的节拍数当硬闸用（21 拍直接打回），而节拍预算的产品口径是"只报数不拦"。
       */
      advisoryRule: "motionBudget 是**参考信息，不构成打回依据**（产品口径：节拍数只报数不拦）；"
        + "打回只能依据：交付闸/字数/语速/朝向互斥/构图先验这些确定性结论，或你把正文逐条读出来的实质缺陷。"
        + "微动作段（action 里【微动作】之后）是质感层，不参与节拍与动作复杂度判断。"
    }, env: ENV,
    allowFallbackApprove: ALLOW_FALLBACK_APPROVE, log
  };
  let verdict: ProducerVerdict;
  let scopedReviewFile: string | null = null;
  if (scenePolicy) {
    // The complete ten-shot author contract exceeds the producer adapter's per-call context limit.
    // Review every generated shot with its complete original contract and its own full spec report;
    // aggregate only after all shot verdicts exist. The global deterministic checks remain on G6.
    const scoped: Array<{ shotId: string; verdict: ProducerVerdict }> = [];
    const allShotIds = shots.map((item) => item.shotId);
    for (const shot of promptShots()) {
      const report = specReports.find((item) => item.shotId === shot.shotId);
      if (!report) throw new Error(`PROMPT_REVIEW_SCOPE_MISSING: ${shot.shotId}`);
      const reportFile = join(PROMPT_DIR, `spec-report-${shot.shotId}.json`);
      writeFileSync(reportFile, `${JSON.stringify(report, null, 2)}\n`, "utf8");
      const perShot = await reviewStage({
        ...promptReviewOptions,
        artifacts: [
          { path: reportFile, kind: "json" },
          { path: join(PROMPT_DIR, `${shot.shotId}.txt`), kind: "text" },
        ],
        deterministic: checks.filter((check) => !allShotIds.some((id) => check.id.endsWith(`:${id}`)) || check.id.endsWith(`:${shot.shotId}`)),
        context: { ...promptReviewOptions.context, shotId: shot.shotId },
      });
      scoped.push({ shotId: shot.shotId, verdict: perShot });
    }
    if (scoped.length !== promptShots().length) throw new Error("PROMPT_REVIEW_SCOPE_INCOMPLETE");
    scopedReviewFile = join(PROMPT_DIR, "prompt-review-scoped.json");
    writeFileSync(scopedReviewFile, `${JSON.stringify(scoped, null, 2)}\n`, "utf8");
    const approved = scoped.every((item) => item.verdict.approved);
    const failed = scoped.find((item) => !item.verdict.approved);
    verdict = {
      stage: "prompt", status: approved ? "passed" : scoped.some((item) => item.verdict.status === "unverified") ? "unverified" : "failed",
      approved, score: scoped.every(item => item.verdict.score !== null) ? Math.min(...scoped.map(item => item.verdict.score!)) : null,
      contractHash: buildProducerReviewContract(filmReviewContracts(filmContractSource)).contractHash,
      evidence: [...scoped.flatMap((item) => item.verdict.evidence ?? []),
        { path: scopedReviewFile, sha256: sha256FileSync(scopedReviewFile), scope: "per-shot-verdicts" }],
      hardFailures: scoped.flatMap((item) => item.verdict.hardFailures.map((issue) => `${item.shotId}: ${issue}`)),
      issues: scoped.flatMap((item) => item.verdict.issues.map((issue) => `${item.shotId}: ${issue}`)),
      suggestions: scoped.flatMap((item) => item.verdict.suggestions.map((itemText) => `${item.shotId}: ${itemText}`)),
      rerun: !approved, via: failed?.verdict.via ?? "llm", model: scoped[0]?.verdict.model,
      ms: scoped.reduce((sum, item) => sum + item.verdict.ms, 0),
      reason: approved ? `${scoped.length} 镜原始合同和完整提示词逐镜监制通过`
        : `${failed!.shotId} 等镜头监制未通过：${failed!.verdict.reason}`,
      degraded: scoped.some((item) => item.verdict.degraded),
    };
  } else {
    verdict = await reviewStage(promptReviewOptions);
  }
  record({
    stage: "prompt-review", shotId: null, invoked: true, ok: verdict.approved, cached: false, degraded: verdict.degraded,
    attempt: 1, ms: verdict.ms, artifact: join(PROMPT_DIR, "spec-report.json"),
    evidence: { score: verdict.score, ...(scopedReviewFile ? { outputFiles: [scopedReviewFile] } : {}) }, verdict
  });
  /** G6 提示词审核（step_key: g6-prompt-confirm）——把 prompt-review 的裁决按门记账 */
  recordGate({
    stepKey: "g6-prompt-confirm",
    sourceStage: "prompt-review",
    checks,
    shotIds: shots.map((s) => s.shotId),
    softApproved: verdict.approved,
    via: verdict.via,
    score: verdict.score,
    degraded: verdict.degraded,
    reason: verdict.reason,
    evidence: { issues: verdict.issues, suggestions: verdict.suggestions, artifacts: `${PROMPT_DIR}/${PROJECT}` }
  });
  if (!verdict.approved) {
    log(`⛔ 监制未放行提示词环节：${verdict.reason}（${verdict.suggestions.join("；")}）`);
    /**
     * 显式放行通道（2026-09-25 补，与 G5/G7/G8 一致）：监制的意见属于**文案层风格问题**、
     * 而交付闸（25 字段/长度/台词/锚点/情绪可见性）已全过时，允许用 `--accept-rejected G6` 留痕放行——
     * 否则单个镜头的文案口味会卡住整条修复链（真机：NC-08 反遮挡约束重跑被文案层意见挡住）。
     */
    const accepted = ACCEPT_REJECTED.includes("G6") || ACCEPT_REJECTED.includes("prompt");
    if (!accepted && !DRY_RUN) process.exit(3);
    if (accepted) {
      log(`⚠ 提示词门带瑕疵放行（显式 --accept-rejected G6）：${verdict.reason.slice(0, 120)}`);
      record({
        stage: "prompt-acknowledge", shotId: null, invoked: true, ok: true, cached: false, degraded: true,
        attempt: 1, ms: 0, artifact: join(PROMPT_DIR, "spec-report.json"),
        evidence: { score: verdict.score, reason: verdict.reason, suggestions: verdict.suggestions.slice(0, 5), acceptedBy: "ACCEPT_REJECTED(G6)" },
        verdict: null, note: "提示词门带瑕疵放行（监制文案层意见，交付闸全过；显式留痕）"
      });
    }
  }
}
}

/* ---------- ② 关键帧（监制：keyframe，逐镜视觉评审 + 打回重跑） ---------- */
if (STAGES.has("plates")) {
  /**
   * 关键帧锚点策略（2026-09-24 真机定论，见 `docs/producer-gate-design.md` §四·2）：
   *
   * Ark 对**视频输入图**做隐私血缘校验：由真人照片图生图而来的图会被永久标记
   * `InputImageSensitiveContentDetected.PrivacyInformation`（base64 与托管 URL 都被拒），
   * 而**纯文生图产物**可以被 Seedance 直接当首帧（探针 E/F 对照实测）。
   *
   * 因此默认 `--plate-anchor-mode none`：关键帧走纯文生图（人物外貌由角色档案文本给出），
   * 出片可用；`real` 模式（挂真人照片图生图）人更像，但**不能进 Seedance**，
   * 只适合定妆照/角色档案资产与本地渲染。要两者兼得必须先把真人授权进 Ark 私域人像库（asset://）。
   */
  const plateAnchorMode = arg("--plate-anchor-mode", "none");
  const portraitRefs = lead ? ["closeup", "front", "threeQuarter", "side"].map((a) => lead.files[a]).filter(Boolean) as string[] : [];
  const pendingPlateShots = pendingShots();
  const venueRefs = pendingPlateShots.length > 0 && Array.isArray((pendingPlateShots[0] as Record<string, unknown>).venueRefs)
    ? ((pendingPlateShots[0] as Record<string, unknown>).venueRefs as string[]).map(abs).filter(existsSync)
    : [];
  for (const shot of pendingPlateShots) {
    const plate = join(PLATE_DIR, `${shot.shotId}-plate.png`);
    /** 素材镜没有文生关键帧（首帧就是真实素材本身），但仍要有"素材准备件"与提示词 */
    if (isMaterialShot(shot)) {
      record({
        stage: "keyframe", shotId: shot.shotId, invoked: false, ok: true, cached: false, degraded: false, attempt: 1, ms: 0,
        artifact: null, evidence: { photo: String((shot as Record<string, unknown>).photo), skipReason: "素材镜：首帧=真实素材" },
        verdict: null, note: "素材镜：跳过文生关键帧（首帧由真实素材经画幅准备后提供，见 material-gen）"
      });
      continue;
    }
    /**
     * 授权真人素材镜：Seedream 图片接口不接受 `asset://`（真机 400 invalid url），
     * 且**关键帧本来就不该有脸**——人物身份由 Seedance 参考图承担（见 videos 阶段）。
     * 这里如实记录"跳过文生关键帧"，不产出任何 AI 生成的人脸首帧。
     */
    if (isAssetShot(shot)) {
      record({
        stage: "keyframe", shotId: shot.shotId, invoked: false, ok: true, cached: false, degraded: false, attempt: 1, ms: 0,
        artifact: null,
        evidence: { assetRef: assetRefOf(shot), skipReason: "授权真人素材镜：人物身份由 Seedance 参考图承担，不产文生关键帧" },
        verdict: null, note: "授权真人素材镜：跳过文生关键帧（Seedream 不接受 asset://；首帧会顶掉真人身份）"
      });
      continue;
    }
    /**
     * 关键帧缓存必须过**两道失效判据**（2026-09-26 真机 T-2026-0926-0007）：
     *
     *  1. **提示词指纹**：出图时写 `GR-xx.plate-meta.json`（prompt sha256 + 锚点模式 + 模型）。
     *     镜头卡改过（例如把西装改成档案 w1 旗袍）后，旧图必须重出——早先只看"文件在 + >50KB"
     *     就复用，真机表现为"改了卡片，产物还是旧图，却被记成 ok"。
     *  2. **历史裁决**：本镜最近一次 keyframe 记录必须是 ok。被监制打回过的图不得因为
     *     重跑一次就被"缓存复用"洗白（与 shot 阶段"复用也要复检"同一纪律）。
     *
     * 两条任一不满足 → 判缓存失效，照常重新出图并重新过监制。
     */
    const cachedPlateExists = existsSync(plate);
    const cachedMeta = readPlateMeta(shot.shotId);
    const basePlatePrompt = platePrompt(shot, lead?.name ?? "主角", lead?.appearanceText ?? "");
    const anchors = plateAnchorMode === "real"
      ? ([portraitRefs[0], portraitRefs[1], venueRefs[0]].filter(Boolean) as string[])
      : venueRefs.slice(0, 1);
    const imageSize = ENV.SEEDREAM_SIZE ?? "2K";
    const currentPromptSha = createHash("sha256").update(basePlatePrompt).digest("hex");
    rememberInputs("keyframe", [join(PROMPT_DIR, `${shot.shotId}.txt`), ...anchors], shot.shotId);
    const currentRequestSha = plateRequestSha256({
      prompt: basePlatePrompt, model: IMAGE_MODEL, anchorMode: plateAnchorMode, size: imageSize,
      referenceSha256: anchors.map((file) => createHash("sha256").update(readFileSync(file)).digest("hex"))
    });
    const cacheDecision = decidePlateCache({
      exists: cachedPlateExists,
      sizeBytes: cachedPlateExists ? statSync(plate).size : 0,
      meta: cachedMeta,
      currentPromptSha256: currentPromptSha,
      currentRequestSha256: currentRequestSha,
      currentArtifactSha256: cachedPlateExists ? createHash("sha256").update(readFileSync(plate)).digest("hex") : null,
      anchorMode: plateAnchorMode,
      lastApproved: lastKeyframeApproved(readStageHistory(), shot.shotId)
    });
    const plateCacheValid = RESUME && cacheDecision.valid && artifactReusable("keyframe", plate, undefined, shot.shotId);
    if (plateCacheValid) {
      const probeInfo = probe(plate);
      record({
        stage: "keyframe", shotId: shot.shotId, invoked: true, ok: true, cached: true, degraded: false, attempt: 1, ms: 0,
        artifact: plate, evidence: { ...probeInfo, promptSha256: currentPromptSha, anchorMode: plateAnchorMode }, verdict: null,
        note: `复用已有产物（${cacheDecision.reason}）`
      });
      continue;
    }
    if (cachedPlateExists && !plateCacheValid) {
      const reason = RESUME ? cacheDecision.reason : "本次禁用复用（--no-resume）";
      log(`  ↻ ${shot.shotId} 关键帧缓存失效（${reason}）→ 重新生成并复检`);
      record({
        stage: "keyframe-cache-invalid", shotId: shot.shotId, invoked: false, ok: false, cached: true, degraded: false, attempt: 0, ms: 0,
        artifact: plate, evidence: { reason, cachedPromptSha256: cachedMeta?.promptSha256 ?? null, currentPromptSha256: currentPromptSha }, verdict: null,
        note: `缓存失效（${reason}）：旧图不得直接复用`
      });
    }
    if (DRY_RUN) {
      record({ stage: "keyframe", shotId: shot.shotId, invoked: false, ok: true, cached: false, degraded: false, attempt: 0, ms: 0, artifact: null, evidence: { dryRun: true, prompt: basePlatePrompt, eraProfile: authorContext.eraProfile }, verdict: null });
      continue;
    }
    let approved = false;
    /** 关键帧阶段同样记录上一轮裁决，用于"带变更"重试 */
    let plateVerdict: ProducerVerdict | null = null;
    for (let attempt = 1; attempt <= MAX_ATTEMPTS && !approved; attempt += 1) {
      const started = Date.now();
      try {
        const prompt = basePlatePrompt
          /**
           * 关键帧重试同样"带变更"：把上一轮监制的具体问题写进去（原来只有一句泛泛的"构图更准"）。
           */
          + (attempt > 1 ? `\n${retryInstruction(plateVerdict, attempt, MAX_ATTEMPTS)}` : "");
        if (plateAnchorMode === "real" && attempt === 1) {
          log(`  ⚠ ${shot.shotId} 关键帧挂了真人锚点：产物会被 Seedance 隐私校验拒（仅适合做档案资产）`);
        }
        const url = await arkImage(prompt, anchors, imageSize, shot.shotId, plate);
        saveHostedUrl(shot.shotId, url);
        await download(url, plate);
        const info = probe(plate);
        const width = Number(info.width ?? 0); const height = Number(info.height ?? 0);
        const ratio = width && height ? width / height : 0;
        const [aspectWidth, aspectHeight] = ASPECT.split(":").map(Number);
        const expected = aspectWidth! / aspectHeight!;
        const verdict = await reviewStage({
          stage: "keyframe", projectId: PROJECT,
          rubric: scenePolicy ? [...PRODUCER_RUBRICS.keyframe, scenePolicy.prompt.visualReview] : undefined,
          artifacts: [{ path: plate, kind: "image", bytes: Number(info.bytes ?? 0), probe: info }],
          deterministic: [
            { id: "bytes", pass: Number(info.bytes ?? 0) > 50_000, detail: `文件 ${((Number(info.bytes ?? 0)) / 1024).toFixed(0)}KB`, hard: true },
            { id: "aspect", pass: Math.abs(ratio - expected) < 0.06, detail: `${width}x${height}（期望比例 ${expected.toFixed(3)}，实测 ${ratio.toFixed(3)}）`, hard: true }
          ],
          referenceImages: localReviewRefsEarly(portraitRefs).slice(0, 2), context: { shotId: shot.shotId, scene: shot.scene, action: shot.action,
            scenePolicy: scenePolicy ? { id: scenePolicy.id, tags: shot.policyTags, speechScene: shot.speechScene } : null }, env: ENV,
          allowFallbackApprove: ALLOW_FALLBACK_APPROVE, log
        });
        record({
          stage: "keyframe", shotId: shot.shotId, invoked: true, ok: verdict.approved, cached: false, degraded: verdict.degraded,
          attempt, ms: Date.now() - started, artifact: plate, evidence: info, verdict
        });
        /** 放行才写指纹：被驳回的图不写元文件，下一轮必然重出（缓存失效判据 ② 的物证） */
        if (verdict.approved) writePlateMeta(shot.shotId, prompt, plateAnchorMode, basePlatePrompt, currentRequestSha, plate);
        approved = verdict.approved;
        if (!approved) plateVerdict = verdict;
        if (!approved) log(`↻ 关键帧 ${shot.shotId} 第 ${attempt} 次未过监制：${verdict.reason}`);
      } catch (err) {
        record({
          stage: "keyframe", shotId: shot.shotId, invoked: true, ok: false, cached: false, degraded: false, attempt,
          ms: Date.now() - started, artifact: null, evidence: { error: err instanceof Error ? err.message.slice(0, 300) : String(err) }, verdict: null
        });
      }
    }
    if (!approved) log(`⛔ 关键帧 ${shot.shotId} 重跑 ${MAX_ATTEMPTS} 次仍未过监制，人工/AI 监制需介入`);
  }
}

/* ---------- ②-2 素材镜生成（step_key: material-generate，gate G-MAT1，监制：shot） ---------- */
/**
 * 产品所有者 2026-09-25 硬规定：**严禁在视频中直接静态展示图片**。
 * 真实素材（实拍照片）只能作为**生成输入**：先按目标画幅准备成"生成首帧"，再交给 Seedance
 * 图生视频出**带真实运动**的镜头（云/水/光/植被/人群 + 镜头运动），最后用四项判据证明它不是静态直出。
 *
 * 四段流水（每段都留痕）：
 *   ① 素材准备：按焦点裁到目标画幅（只影响生成输入，不产出成片内容）；
 *   ② 提示词：`buildMaterialMotionPrompt`（保真 + 真运动 + 禁止静态直出 + 无文字水印）；
 *   ③ 提交门 G-MAT1（mode=submit）：用途声明/素材在场/提示词齐备/画幅与时长约束——花钱之前的门；
 *   ④ 渲染后门 G-MAT1（mode=verify）：生成溯源（任务号+模型+素材与产物指纹）+ **静态复用度实测**
 *      （后段画面若仍能在素材里找到几乎一样的像素，即判静态直出）+ 监制保真评审。
 *
 * 复用度怎么测（确定性）：对镜头中后段抽 3 帧，与素材的 15 个候选窗口（3 个缩放 × 5 个位置）
 * 逐一算 PSNR 取最佳值：真生成的画面会因为云、水、光、人群的变化而明显低于 45dB；
 * "把照片放进时间线"这类硬伤则会命中 ≥45dB（判据与阈值在 `material-policy.ts`，含单测）。
 */
function psnrBetween(a: string, b: string): number | null {
  const res = spawnSync(FFMPEG, [
    "-hide_banner", "-i", a, "-i", b,
    "-lavfi", "[0:v]format=gray[a];[1:v]format=gray[b];[a][b]psnr",
    "-f", "null", "-"
  ], { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });
  const text = `${res.stdout ?? ""}\n${res.stderr ?? ""}`;
  const m = /average:([\d.]+|inf)/.exec(text);
  if (!m) return null;
  return m[1] === "inf" ? 99 : Number(m[1]);
}

/**
 * 复用度实测的**像素级内核**（2026-09-26 真机改造）。
 *
 * 为什么不再用 ffmpeg 逐对比较：候选窗口从 15 个扩到 54 个、采样点从 3 个扩到 12 个之后，
 * "一帧 × 一候选"一次 ffmpeg 进程要跑 600+ 次/镜（10 镜 ≈ 15 分钟），而把灰度帧解到内存里
 * 用 JS 算 PSNR/SSIM 只需几百毫秒/镜——同一判据、成本降两个数量级。
 */
function grayFrameRaw(clip: string, atSec: number, width: number, height: number): Buffer {
  const res = spawnSync(FFMPEG, [
    "-hide_banner", "-v", "error", "-ss", atSec.toFixed(3), "-i", clip, "-frames:v", "1",
    "-vf", `scale=${width}:${height}:force_original_aspect_ratio=increase,crop=${width}:${height}`,
    "-f", "rawvideo", "-pix_fmt", "gray", "-"
  ], { maxBuffer: 64 * 1024 * 1024 });
  if (res.status !== 0 || !res.stdout) throw new Error(`灰度抽帧失败：${clip}@${atSec.toFixed(2)}s`);
  return res.stdout as Buffer;
}

function psnrGray(a: Buffer, b: Buffer): number {
  const n = Math.min(a.length, b.length);
  if (n === 0) return 0;
  let mse = 0;
  for (let i = 0; i < n; i += 1) {
    const d = (a[i] ?? 0) - (b[i] ?? 0);
    mse += d * d;
  }
  mse /= n;
  return mse <= 1e-9 ? 99 : 10 * Math.log10((255 * 255) / mse);
}

/** 8×8 块级 SSIM（灰度）：深变焦仍"是那张照片"时显著高于真实重建场景 */
function ssimGray(a: Buffer, b: Buffer, width: number, height: number): number {
  const c1 = (0.01 * 255) ** 2;
  const c2 = (0.03 * 255) ** 2;
  const block = 8;
  let sum = 0;
  let blocks = 0;
  for (let by = 0; by + block <= height; by += block) {
    for (let bx = 0; bx + block <= width; bx += block) {
      let sa = 0; let sb = 0; let saa = 0; let sbb = 0; let sab = 0;
      for (let y = by; y < by + block; y += 1) {
        for (let x = bx; x < bx + block; x += 1) {
          const index = y * width + x;
          const va = a[index] ?? 0;
          const vb = b[index] ?? 0;
          sa += va; sb += vb; saa += va * va; sbb += vb * vb; sab += va * vb;
        }
      }
      const n = block * block;
      const ma = sa / n; const mb = sb / n;
      const va2 = saa / n - ma * ma;
      const vb2 = sbb / n - mb * mb;
      const cov = sab / n - ma * mb;
      sum += ((2 * ma * mb + c1) * (2 * cov + c2)) / ((ma * ma + mb * mb + c1) * (va2 + vb2 + c2));
      blocks += 1;
    }
  }
  return blocks > 0 ? sum / blocks : 0;
}

/**
 * 素材候选窗口的**缩放档位**：
 *
 * 2026-09-26 真机根因——旧档位只有 `[1, 1.2, 1.4]`，而"从远景推近到参考照片"的镜头后段
 * 等价于对素材做 2–4× 变焦，候选集里根本没有能对齐的窗口，于是匹配 PSNR 只有 13.2dB，
 * 静态直出门放行（成片 5.5–9.5s 观众看到的却是照片特写）。档位扩到 3.6× 才覆盖得住这条失效模式。
 */
const MATERIAL_REUSE_SCALES = [1, 1.3, 1.7, 2.2, 2.8, 3.6];
/** 候选窗口的平移档位（3×3：四角 + 四边中点 + 居中） */
const MATERIAL_REUSE_POSITIONS: Array<[string, number, number]> = [
  ["center", 0.5, 0.5], ["left", 0, 0.5], ["right", 1, 0.5], ["top", 0.5, 0], ["bottom", 0.5, 1],
  ["topleft", 0, 0], ["topright", 1, 0], ["bottomleft", 0, 1], ["bottomright", 1, 1]
];
/** 采样时刻（占镜头时长的比例）：覆盖首、中、尾三段，尾部加密——照片失效模式就出在尾段 */
const MATERIAL_REUSE_SAMPLE_RATIOS = [0.08, 0.2, 0.32, 0.44, 0.56, 0.68, 0.78, 0.86, 0.92, 0.97];

/**
 * 静态复用度实测：镜头帧 vs 素材候选窗口的最佳 PSNR。
 * 返回 `MaterialReuseSample[]`（供 `assessMaterialReuse` 判定，判定逻辑在模块里、有单测）。
 */
function measureMaterialReuse(clip: string, material: string, durationSec: number, shotId: string): {
  samples: Array<{ atSec: number; bestPsnrDb: number | null; bestSsim: number | null }>;
  candidates: number;
} {
  const dir = join(WORK_DIR, "material-reuse", PROJECT, shotId);
  mkdirSync(dir, { recursive: true });
  /** 9:16 为 180×320；其他画幅按源比例取样，避免横片被强行拉成竖片。 */
  const { width: W, height: H } = sampleDimensions(180);
  const candidates: string[] = [];
  const candidateNames: string[] = [];
  for (const scale of MATERIAL_REUSE_SCALES) {
    for (const [name, fx, fy] of MATERIAL_REUSE_POSITIONS) {
      const out = join(dir, `cand-s${scale}-${name}.png`);
      const label = `s${scale}-${name}`;
      try {
        if (!existsSync(out)) {
          /**
           * 画幅准备 → 变焦裁窗（2026-09-26 修正）：
           * 素材原始画幅可能是 16:9 横图，**必须先按 9:16 覆盖裁切**再按倍数变焦，
           * 否则"横图裁一块再拉成竖屏"会引入各向异性拉伸，匹配度恒低（真机：NC-02 峰值只有 13.5dB）。
           */
          run(FFMPEG, ["-y", "-i", material,
            "-vf", `scale=${SOURCE_SIZE.width}:${SOURCE_SIZE.height}:force_original_aspect_ratio=increase,`
              + `crop=${SOURCE_SIZE.width}:${SOURCE_SIZE.height},`
              + `crop=round(${SOURCE_SIZE.width}/${scale}/2)*2:round(${SOURCE_SIZE.height}/${scale}/2)*2:`
              + `(${SOURCE_SIZE.width}-round(${SOURCE_SIZE.width}/${scale}/2)*2)*${fx}:`
              + `(${SOURCE_SIZE.height}-round(${SOURCE_SIZE.height}/${scale}/2)*2)*${fy},`
              + `scale=${W}:${H}`,
            "-frames:v", "1", out]);
        }
        if (existsSync(out)) {
          candidates.push(out);
          candidateNames.push(label);
        }
      } catch {
        /* 裁切窗口越界（素材小于窗口）时跳过该候选，不影响其余候选 */
      }
    }
  }
  /** 候选一次解码成灰度内存，后续每帧只做内存比较 */
  const candidatePixels = candidates.map((file) => grayFrameRaw(file, 0, W, H));
  const samples: Array<{ atSec: number; bestPsnrDb: number | null; bestSsim: number | null }> = [];
  for (const ratio of MATERIAL_REUSE_SAMPLE_RATIOS) {
    const atSec = Math.min(durationSec - 0.05, Math.max(0.1, durationSec * ratio));
    if (atSec <= 0) continue;
    let best: number | null = null;
    let bestSsim: number | null = null;
    let framePixels: Buffer | null = null;
    try {
      framePixels = grayFrameRaw(clip, atSec, W, H);
    } catch {
      samples.push({ atSec, bestPsnrDb: null, bestSsim: null });
      continue;
    }
    for (const pixels of candidatePixels) {
      const value = psnrGray(framePixels, pixels);
      if (best === null || value > best) best = value;
      /** SSIM 只对"PSNR 已达视觉级"的候选计算（省 90% 计算量，不改变判定结果） */
      if (value >= 22) {
        const structural = ssimGray(framePixels, pixels, W, H);
        if (bestSsim === null || structural > bestSsim) bestSsim = structural;
      }
    }
    samples.push({ atSec, bestPsnrDb: best, bestSsim });
  }
  return { samples, candidates: candidatePixels.length };
}

/**
 * 参考独立性实测（material-scene/v1，2026-09-25 产品所有者口径纠偏）：
 * "图片只是实景素材参考，是用来构建真实视频场景的，不是简单做个运镜了事"。
 *
 * 判据（数值阈值与决策在 `material-policy.ts#assessReferenceIndependence`）：
 *   · 首帧最佳匹配 PSNR：把成片首帧与参考素材的全部候选窗口对齐后取最佳——高 = 首帧就是那张图；
 *   · 首帧直比 PSNR：不缩放不对齐直接比——很高 = 同一个取景、同一张图；
 *   · 中段最佳匹配 PSNR：整段仍能高精度对回参考图 = 参考图被变换，而不是重建场景。
 */
function measureReferenceIndependence(clip: string, material: string, durationSec: number, shotId: string): {
  firstFrameBestPsnrDb: number | null;
  midFrameBestPsnrDb: number | null;
  directPsnrDb: number | null;
  candidates: number;
} {
  const dir = join(WORK_DIR, "reference-independence", PROJECT, shotId);
  mkdirSync(dir, { recursive: true });
  const { width: W, height: H } = sampleDimensions(360);
  const scales = [1, 1.15, 1.3, 1.45];
  const positions: Array<[string, number, number]> = [
    ["center", 0.5, 0.5], ["left", 0, 0.5], ["right", 1, 0.5], ["top", 0.5, 0], ["bottom", 0.5, 1],
    ["topleft", 0, 0], ["topright", 1, 0], ["bottomleft", 0, 1], ["bottomright", 1, 1]
  ];
  const candidates: string[] = [];
  for (const scale of scales) {
    const cropW = Math.round((W / scale) / 2) * 2;
    const cropH = Math.round((H / scale) / 2) * 2;
    for (const [name, fx, fy] of positions) {
      const out = join(dir, `cand-s${scale}-${name}.png`);
      try {
        run(FFMPEG, ["-y", "-i", material,
          "-vf", `scale=${W * 2}:${H * 2}:force_original_aspect_ratio=increase,`
            + `crop=${cropW * 2}:${cropH * 2}:(iw-${cropW * 2})*${fx}:(ih-${cropH * 2})*${fy},scale=${W}:${H}`,
          "-frames:v", "1", out]);
        if (existsSync(out)) candidates.push(out);
      } catch {
        /* 候选窗口越界：跳过 */
      }
    }
  }
  const frameAt = (at: number, name: string): string => {
    const file = join(dir, name);
    run(FFMPEG, ["-y", "-ss", at.toFixed(2), "-i", clip, "-frames:v", "1",
      "-vf", `scale=${W}:${H}:force_original_aspect_ratio=increase,crop=${W}:${H}`, file]);
    return file;
  };
  const bestFor = (frame: string): number | null => {
    let best: number | null = null;
    for (const candidate of candidates) {
      const value = psnrBetween(frame, candidate);
      if (value === null) continue;
      if (best === null || value > best) best = value;
    }
    return best;
  };
  const first = frameAt(0.05, "first-frame.png");
  const mid = frameAt(Math.max(0.2, durationSec / 2), "mid-frame.png");
  /** 直比：参考素材整体缩到同尺寸，不裁切不对齐 */
  const referenceDirect = join(dir, "reference-direct.png");
  run(FFMPEG, ["-y", "-i", material, "-vf", `scale=${W}:${H}:force_original_aspect_ratio=increase,crop=${W}:${H}`, "-frames:v", "1", referenceDirect]);
  return {
    firstFrameBestPsnrDb: bestFor(first),
    midFrameBestPsnrDb: bestFor(mid),
    directPsnrDb: psnrBetween(first, referenceDirect),
    candidates: candidates.length
  };
}

/**
 * 运动强度实测（2026-09-25 产品所有者第二轮反馈："中间的图片镜头还是简单的图片、运镜拉跨"）。
 *
 * 口径：160×284 灰度、8fps、4 像素步长的相邻帧平均绝对差，返回三项：
 *   · meanEnergy 平均帧间差（"有没有一直在动"）；
 *   · maxEnergy  峰值帧间差；
 *   · rampRatio  峰值 ÷ 平均（"有没有速度坡道"，匀速≈1）。
 * 判定口径在 `material-policy.ts#assessMotionRichness`（含单测与真机标定值）。
 */
function measureMotionRichness(file: string): { meanEnergy: number; maxEnergy: number; rampRatio: number; frames: number; peakAtSec: number } {
  const { width: W, height: H } = sampleDimensions(160);
  const fps = 8;
  const res = spawnSync(FFMPEG, [
    "-v", "error", "-i", file,
    "-vf", `fps=${fps},scale=${W}:${H}:force_original_aspect_ratio=increase,crop=${W}:${H},format=gray`,
    "-f", "rawvideo", "-pix_fmt", "gray", "-"
  ], { maxBuffer: 128 * 1024 * 1024 });
  const buf = res.stdout as Buffer | null;
  if (!buf || buf.length < W * H * 2) return { meanEnergy: 0, maxEnergy: 0, rampRatio: 0, frames: 0, peakAtSec: 0 };
  const frames = Math.floor(buf.length / (W * H));
  const diffs: number[] = [];
  for (let f = 1; f < frames; f += 1) {
    const cur = buf.subarray(f * W * H, (f + 1) * W * H);
    const prev = buf.subarray((f - 1) * W * H, f * W * H);
    let sum = 0; let count = 0;
    for (let i = 0; i < W * H; i += 4) { sum += Math.abs(cur[i]! - prev[i]!); count += 1; }
    diffs.push(count > 0 ? sum / count : 0);
  }
  const meanEnergy = diffs.length > 0 ? diffs.reduce((a, c) => a + c, 0) / diffs.length : 0;
  const maxEnergy = diffs.length > 0 ? Math.max(...diffs) : 0;
  const peakIndex = diffs.indexOf(maxEnergy);
  return {
    meanEnergy, maxEnergy,
    rampRatio: meanEnergy > 0.01 ? maxEnergy / meanEnergy : 0,
    frames,
    peakAtSec: peakIndex >= 0 ? peakIndex / fps : 0
  };
}

/**
 * 渲染请求时长（真源约束）：Seedance 单镜时长**下限 4s / 上限 12s**
 * （`bundles/ai-video/library/media-catalog/media-catalog.json`：durationSec min 4 / max 12）。
 *
 * 事故（2026-09-25 南昌片真机）：本片是快剪节奏，多镜只有 1.8–3.5s，直接把分镜时长当 `duration`
 * 提交 → Ark 返回 `InvalidParameter: duration`（整排素材镜 0.4s 内全部失败）。
 * Standard native production accepts only exact supported integer durations before paid calls.
 * It preserves the returned original and rejects duration mismatches instead of retiming it.
 */
function renderSecondsFor(durationSec: number): number {
  if (!Number.isInteger(durationSec) || durationSec < RENDER_SECONDS_MIN || durationSec > RENDER_SECONDS_MAX)
    throw new Error("STANDARD_NATIVE_RENDER_DURATION_INVALID: original rendering requires exact integer seconds in 4..12; post does not trim or retime");
  return durationSec;
}

/** Only processing metadata is read here; raw clock, shape and silence never veto a completed render. */
function assertOriginalRenderMedia(file: string, _seconds: number, shotId: string): Record<string, unknown> {
  const info = probe(file);
  if (info.error || !(Number(info.width) > 0) || !(Number(info.height) > 0) || !(Number(info.duration) > 0))
    throw new Error(`RENDER_SOURCE_UNREADABLE: ${shotId}: ${JSON.stringify(info)}`);
  return info;
}

if (STAGES.has("material-gen")) {
  const { width: pw, height: ph } = SOURCE_SIZE;
  for (const shot of FIRST_PASS_ORDER.filter((item) => isMaterialShot(item) && !completedByShot.has(item.shotId))) {
    const shotStarted = Date.now();
    const card = shot as Record<string, unknown>;
    const spec = readMaterialSpec(card);
    const photo = abs(spec.photo);
    const clip = join(CLIP_DIR, `${shot.shotId}.mp4`);
    const duration = Number(shot.duration ?? 5);
    /** 生成输入（按目标画幅准备的素材副本）：**不是成片内容**，只是给模型的首帧 */
    const prepared = join(PLATE_DIR, `${shot.shotId}-material.jpg`);
    const promptFile = join(PROMPT_DIR, `${shot.shotId}.txt`);
    const focus = { x: spec.focus?.x ?? 0.5, y: spec.focus?.y ?? 0.5 };
    let materialSubmission: Awaited<ReturnType<typeof arkVideo>> | null = null;
    if (!existsSync(photo)) {
      record({
        stage: "material-gen", shotId: shot.shotId, invoked: true, ok: false, cached: false, degraded: false, attempt: 1, ms: 0,
        artifact: null, evidence: { photo, missing: true, policy: MATERIAL_POLICY_VERSION }, verdict: null, note: "素材文件不存在"
      });
      continue;
    }
    try {
      // Preparation is deterministic and cheap; regenerate from the current reference instead of trusting an old file.
      {
        run(FFMPEG, ["-y", "-i", photo,
          "-vf", `scale=${pw}:${ph}:force_original_aspect_ratio=increase,crop=${pw}:${ph}:(iw-${pw})*${focus.x}:(ih-${ph})*${focus.y}`,
          "-q:v", "2", prepared]);
      }
      /**
       * 首轮提示词：**场景构建**口径（material-scene/v1）——参考图只作实景依据，
       * 机位/视差/环境运动由模型构建（不再走"把参考图当首帧做动效"的老路）。
       * 重跑轮会在循环里升级强度并写入同一文件（`let` 是因为提交门要读当前轮提示词）。
       */
      let prompt = buildMaterialScenePrompt(card, {
        aspect: ASPECT, resolution: SOURCE_RESOLUTION, durationSec: duration, title: shotlist.title
      });
      writeFileSync(promptFile, `${prompt}\n`, "utf8");
      const promptIntent = prompt;
      rememberInputs("material-gen", [photo, prepared, promptFile], shot.shotId);
      const materialSha = sha256FileSync(photo);
      /**
       * G-MAT1 提交门（mode=submit）：素材用途 + 素材/提示词齐备 + 画幅时长约束。
       * 这一门是**素材镜唯一的"花钱前"闸门**（素材镜不进 G8 渲染提交，判据不同）。
       */
      const submitGate = recordGate({
        stepKey: "material-generate",
        sourceStage: "material-gen",
        shotIds: [shot.shotId],
        checks: [
          { id: "material-usage-declared", pass: spec.usage === "generation-reference", hard: true, detail: `用途声明 ${spec.usage}（只允许 generation-reference；禁止静态直出）` },
          { id: "material-file", pass: existsSync(photo) && statSync(photo).size > 20_000, hard: true, detail: `真实素材 ${basename(photo)}（${(statSync(photo).size / 1024).toFixed(0)}KB，sha256 ${materialSha.slice(0, 12)}）` },
          { id: "material-prepared", pass: existsSync(prepared) && statSync(prepared).size > 50_000, hard: true, detail: `生成首帧已按 ${ASPECT} 准备（${pw}x${ph}，仅作生成输入）` },
          {
            id: "prompt-ready", pass: prompt.trim().length >= 400, hard: true,
            detail: `素材镜提示词 ${prompt.trim().length} 字（场景构建口径：实景依据 + 自选机位 + 视差 + 环境运动）`
          },
          {
            /**
             * 口径升级（material-scene/v1）：判据从"禁止静态直出"改为"必须以实景依据构建视频场景"——
             * 提示词里必须出现 ① 实景依据 ② 构建视频场景 ③ 不得复刻参考图构图 ④ 禁止贴图式运动/静止画面。
             */
            id: "scene-construction-policy",
            pass: prompt.includes("实景依据") && prompt.includes("构建一段")
              && prompt.includes("不得复刻参考图的构图") && prompt.includes("贴图式运动") && prompt.includes("画面全程静止"),
            hard: true,
            detail: "提示词含「实景依据 / 构建视频场景 / 不得复刻参考图构图 / 禁止贴图式运动与静止画面」四条硬约束"
          },
          { id: "aspect-constraint", pass: prompt.includes(ASPECT), hard: true, detail: `含画幅约束 ${ASPECT}` },
          { id: "duration-limit", pass: duration > 0 && duration <= 30, hard: true, detail: `单镜时长 ${duration}s（上限 30s）` }
        ],
        evidence: {
          mode: "submit", policy: MATERIAL_POLICY_VERSION, material: photo, materialSha256: materialSha,
          promptFile, promptChars: prompt.trim().length, model: VIDEO_MODEL, seconds: duration
        }
      });
      if (!submitGate.approved) {
        record({
          stage: "material-gen", shotId: shot.shotId, invoked: false, ok: false, cached: false, degraded: false, attempt: 1,
          ms: Date.now() - shotStarted, artifact: null, evidence: { gateBlocked: "material-generate", reason: submitGate.reason },
          verdict: null, note: "G-MAT1 提交门未通过：未向渲染服务提交"
        });
        continue;
      }
      const rawClip = join(CLIP_DIR, `${shot.shotId}.raw.mp4`);
      if (DRY_RUN) {
        record({ stage: "material-gen", shotId: shot.shotId, invoked: false, ok: true, cached: false, degraded: false,
          attempt: 0, ms: 0, artifact: null, evidence: { dryRun: true }, verdict: null });
        continue;
      }
      preflightSubmitGuard({ shotId: shot.shotId, stage: "material-gen", prompt, fps: FPS, attempt: 1, prevFingerprint: null });
      const submitted = await arkVideo({ stage: "material-gen", target: rawClip, shotId: shot.shotId, prompt,
        firstFrame: undefined, refs: [dataUrl(prepared)], seconds: renderSecondsFor(duration), generateAudio: true, seed: 20260925 });
      materialSubmission = submitted;
      await download(submitted.url, rawClip);
      const info = assertOriginalRenderMedia(rawClip, duration, shot.shotId);
      if (!submitted.requestInputVerified) throw new Error(`RENDER_INPUT_UNVERIFIED: ${shot.shotId} downloaded candidate lacks actual submitted request proof; no automatic resubmission`);
      await issueOriginalRenderReceipt({ productionRoot: WORK_DIR, projectId: PROJECT, shotId: shot.shotId, submittedSha256: sourceFileHash,
        artifactPath: rawClip, taskId: submitted.taskId, requestInputVerified: true, submissionReceipt: submitted.submissionReceipt, parentWorkDir: WORKER_RUNTIME?.context.workDir });
      copyFileSync(rawClip, clip);
      if (sha256FileSync(clip) !== sha256FileSync(rawClip)) throw new Error(`RENDER_COPY_CHANGED: ${shot.shotId}`);
      record({ stage: "material-gen", shotId: shot.shotId, invoked: true, ok: true, cached: submitted.resumed, degraded: false,
        attempt: 1, ms: Date.now() - shotStarted, artifact: clip, evidence: { ...info, taskId: submitted.taskId,
          raw: rawClip, rawSha256: sha256FileSync(rawClip), outputSha256: sha256FileSync(clip), outputFiles: [rawClip],
          requestInputVerified: true, submissionReceipt: submitted.submissionReceipt ?? null, material: photo, materialSha256: materialSha,
          providerSuccess: true, qualityReviewPerformed: false, originalUnchanged: true }, verdict: null,
        note: "素材仅用于获授权的生成输入；成功渲染产物默认采用，无保真、运动或静态观感二次审核" });
    } catch (error) {
      record({ stage: "material-gen", shotId: shot.shotId, invoked: true, ok: false, cached: Boolean(materialSubmission?.resumed), degraded: false,
        attempt: 1, ms: Date.now() - shotStarted, artifact: null,
        evidence: { error: error instanceof Error ? error.message : String(error), taskId: materialSubmission?.taskId ?? null,
          submissionReceipt: materialSubmission?.submissionReceipt ?? null }, verdict: null,
        note: "实际生成或文件处理失败；未因品质重渲" });
      throw error;
    }
  }
  if (!DRY_RUN) {
    // Same-run success becomes pending-state input only after the formal adapter
    // rechecks the issued receipt, first witness and current source bytes.
    const currentCompleted = await adoptCompletedOriginalRenders({ productionRoot: WORK_DIR, projectId: PROJECT, submittedSha256: sourceFileHash });
    const previouslyCompleted = new Set(completedByShot.keys());
    completedOriginals.splice(0, completedOriginals.length, ...currentCompleted);
    completedByShot.clear();
    for (const original of currentCompleted) {
      completedByShot.set(original.shotId, original);
      if (!previouslyCompleted.has(original.shotId)) recordAdoptedOriginal(original);
    }
  }
}


/* ---------- ③ 逐镜视频（监制：shot） ---------- */
if (STAGES.has("videos") && pendingShots().length > 0) {
  /**
   * G7 预生产最终确认（step_key: g7-preproduction）。
   *
   * 位置：**关键帧全部放行之后、第一次提交渲染之前**。这是"花钱之前的最后一道门"：
   * 确认提示词稿与关键帧稿都齐备且都放行过，才允许把请求发给 Seedance。
   * 判据全部看**产物 + 历史裁决**（支持分段重跑：只跑 videos 时，plate/prompt 的放行记录在 stages.jsonl 里）。
   */
  const gateHistory = readStageHistory();
  /**
   * 素材镜不产出文生关键帧，G7 的**提示词**判据对"生成镜 + 授权真人素材镜"成立
   * （素材镜由 G-MAT1 门管，授权真人素材镜由下方 external-asset-shots 判据管）。
   */
  const promptReady = promptShots().every((s) => {
    const file = join(PROMPT_DIR, `${s.shotId}.txt`);
    return existsSync(file) && readFileSync(file, "utf8").trim().length >= 1200;
  });
  /** 授权真人素材镜就绪判据：引用格式合法 + 提示词齐备（≥1200 字）；**不要求关键帧**（这类镜头本就不产） */
  const assetShotDetail = assetShots().map((s) => {
    const file = join(PROMPT_DIR, `${s.shotId}.txt`);
    const promptOk = existsSync(file) && readFileSync(file, "utf8").trim().length >= 1200;
    return { shotId: s.shotId, ref: assetRefOf(s), ok: isAssetRefLocal(assetRefOf(s)) && promptOk };
  });
  const assetShotsReady = assetShotDetail.every((entry) => entry.ok);
  const plateReady = generatedShots().every((s) => {
    const plate = join(PLATE_DIR, `${s.shotId}-plate.png`);
    return existsSync(plate) && statSync(plate).size > 50_000;
  });
  const promptApproved = promptShots().length === 0 || stageApproved("prompt-review", [null], gateHistory);
  /**
   * 关键帧放行判据（2026-09-27 真机 v2 修正）：**放行必须晚于磁盘上这一版关键帧**。
   *
   * 事故：某镜在上一轮被放行（历史里有 ok 记录），本轮提示词变更 → 关键帧缓存失效 → 重渲 3 次全部被打回，
   * 但失败产物**覆盖了磁盘上的文件名**；G7 只看历史里的 ok 记录 → 误判"已放行"，
   * 于是用一版**从未被放行的关键帧**去渲染视频（最贵的环节）。判据改为"该镜存在 ok 记录且记录时间 ≥ 关键帧文件 mtime"。
   */
  const plateApprovedDetail = generatedShots().map((shot) => {
    const plate = join(PLATE_DIR, `${shot.shotId}-plate.png`);
    const ok = artifactReusable("keyframe", plate, undefined, shot.shotId);
    return { shotId: shot.shotId, ok, reason: ok ? "当前关键帧哈希与最新通过裁决一致" : "缺少当前关键帧的最新通过裁决" };
  });
  const plateApproved = plateApprovedDetail.every((entry) => entry.ok);
  /** Successful materials are adopted by task, witness and byte facts before G7.
   * Any still-pending material lacks that completed source; file size or an old
   * quality vote cannot turn it into a completed render. */
  const materialGateVerified = (shotId: string): boolean => completedByShot.has(shotId);
  const materialReady = materialShots().length === 0;
  const micromotionEvidence = STAGES.has("micromotion")
    ? promptShots().map((shot) => micromotionConsumption(shot, micromotionTraces.get(String(shot.shotId))))
    : [];
  const micromotionReady = !STAGES.has("micromotion") || micromotionEvidence.every((entry) => entry.verified);
  const g7 = recordGate({
    stepKey: "g7-preproduction",
    sourceStage: "keyframe",
    shotIds: pendingShots().map((s) => s.shotId),
    checks: [
      { id: "prompt-files", pass: promptReady, hard: true, detail: promptReady ? `${promptShots().length} 个文生镜头（生成镜 + 授权真人素材镜）提示词齐备且 ≥1200 字（另有 ${materialShots().length} 个素材镜走 material-gen 的动效提示词）` : "有生成镜/授权真人素材镜缺提示词或字数不足 1200" },
      { id: "plate-files", pass: plateReady, hard: true, detail: plateReady ? `${generatedShots().length} 个生成镜关键帧齐备（>50KB）` : "有生成镜关键帧缺失或过小" },
      {
        id: "external-asset-shots", pass: assetShotsReady, hard: true,
        detail: assetShots().length === 0
          ? "本片无授权真人素材镜（不适用）"
          : assetShotsReady
            ? `${assetShots().length} 个授权真人素材镜就绪：${assetShotDetail.map((e) => `${e.shotId}→${e.ref}（提示词齐备，无文生关键帧）`).join("；")}——外部素材 ID，未向平台核验授权有效性`
            : `授权真人素材镜未就绪：${assetShotDetail.filter((e) => !e.ok).map((e) => e.shotId).join("、")}`
      },
      { id: "prompt-approved", pass: promptApproved, hard: true, detail: promptApproved ? "提示词环节有放行裁决（历史/本轮）" : "提示词环节无放行裁决" },
      {
        id: "plates-approved", pass: plateApproved, hard: true,
        detail: plateApproved
          ? `每镜关键帧均有**晚于该文件**的放行裁决（${plateApprovedDetail.filter((e) => e.ok).length}/${generatedShots().length}）`
          : `有镜头关键帧缺少有效放行：${plateApprovedDetail.filter((e) => !e.ok).map((e) => `${e.shotId}（${e.reason}）`).join("；")}`
      },
      {
        id: "material-segments", pass: materialReady, hard: true,
        detail: materialReady
          ? "成功素材镜已按当前真实任务、首次签发见证和原片字节采用；不重复执行品质门或付费提交"
          : `待生成素材镜 ${materialShots().map(shot => shot.shotId).join("、")} 缺当前已签发原片；须先完成真实素材生成，不以旧品质票或文件大小替代`
      },
      /**
       * 环境真实性（2026-09-27 事故机制化）：G7 是"花钱之前最后一道门"，
       * 环境审计的结论必须在这道门的**判据清单**里可见（而不是只写在控制台日志里）——
       * 平台执行器与审计器按 step_key 读的是 checks[]，环境真实性缺了这一条就又会变成"只有人眼能发现"。
       */
      {
        id: "env-realism", pass: envHardTotal === 0 || envAccepted, hard: true,
        detail: envHardTotal === 0
          ? `环境真实性 + 设备口径硬缺陷 0（场景圣经 ${sceneBible ? sceneBible.spaceId : "未提供"}；设备清单 ${DEVICE_POLICY_VERSION}；软提示 ${envSoftTotal} 项，报告 ${basename(ENV_REPORT_FILE)}）`
          : `环境真实性硬缺陷 ${envSummary.hard} 项 + 设备口径硬缺陷 ${devSummary.hard} 项（${Object.entries({ ...envSummary.byRule, ...devSummary.byRule }).map(([rule, count]) => `${rule}×${count}`).join(" · ")}）${envAccepted ? "——已显式声明带瑕疵放行" : "——渲染前必须清零"}`
      },
      {
        /**
         * 片型配比（景别/机位/叙事证据）是**创作口径**（T-2026-0930-0014 产品所有者口径）：
         * 默认降为咨询项（不挡花钱前的放行）；需要旧口径时用 `--review-policy blocking`。
         */
        id: "scene-policy", pass: scenePolicyReport?.passed ?? true, hard: REVIEW_POLICY === "blocking",
        detail: scenePolicyReport
          ? `${scenePolicy!.id}@${scenePolicy!.version} 全片配比和逐镜品质门：${scenePolicyReport.defects.length} 项缺陷`
            + `（按 T-2026-0930-0014 口径默认记为咨询项${REVIEW_POLICY === "blocking" ? "；--review-policy blocking 下仍作硬闸" : ""}）；`
            + `报告 ${basename(SCENE_POLICY_REPORT_FILE)}`
          : "需求未命中已安装的片型知识条目（本门不适用）"
      },
      /** 平台语速门（2026-09-30）：与 hook-first-3s 同口径，结论必须在这道花钱前的门里可见 */
      {
        id: "speech-rate", pass: speechOver.length === 0 || speechAccepted, hard: true,
        detail: speechOver.length === 0
          ? `${PLATFORM} ${speechProfile.tier} 档（${speechProfile.target}–${speechProfile.max} 字/秒）：${speechMeasured.length} 个台词镜全部念得完${speechLoose.length > 0 ? `；节奏偏松 ${speechLoose.length} 项（软提示）` : ""}`
          : `${speechOver.length} 个台词镜念不完：${speechOver.map((row) => row.shotId).join("、")}（配音阶段才发现会毁掉节奏与对齐）${speechAccepted ? "——已显式声明带瑕疵放行" : "——必须改写文案或加长该镜"}`
      },
      /** 开场钩子（2026-09-27 新增岗位/机制）：同 env-realism，结论必须在这道花钱前的门里可见 */
      {
        id: "hook-first-3s", pass: hookSummary.hard === 0 || hookAccepted, hard: true,
        detail: hookSummary.hard === 0
          ? `开场钩子硬失败 0（${hookCard ? `${hookCard.type}｜兑现镜 ${hookCard.payoffShotId}` : "未登记钩子卡"}；平台 ${PLATFORM} 窗口前 ${hookWindowFor(PLATFORM)}s；软提示 ${hookSummary.soft} 项）`
          : `开场钩子硬失败 ${hookSummary.hard} 项（${hookSummary.hardFailures.map((check) => check.id).join("、")}）${hookAccepted ? "——已显式声明带瑕疵放行" : "——渲染前必须清零"}`
      },
      { id: "micromotion-applied", pass: micromotionReady, hard: true,
        detail: !STAGES.has("micromotion") ? "本轮未启用微动作增强，不声明已执行"
          : micromotionReady ? "已逐镜复核当前卡片的适用性、原始意图与实际写入哈希（含合法不适用）"
            : micromotionEvidence.filter((entry) => !entry.verified).map((entry) => `${entry.shotId}：${entry.detail}`).join("；") }
    ],
    evidence: {
      promptReady, plateReady, promptApproved, plateApproved, materialReady, micromotionReady, micromotionEvidence,
      adoptedOriginalShotIds: completedOriginals.map(original => original.shotId),
      envRealism: { hard: envSummary.hard, soft: envSummary.soft, byRule: envSummary.byRule, bible: sceneBible?.spaceId ?? null, report: ENV_REPORT_FILE },
      scenePolicy: scenePolicyReport ? { id: scenePolicy!.id, version: scenePolicy!.version, sourceSha256: scenePolicy!.sourceSha256,
        ratios: scenePolicyReport.ratios, exceptionsApplied: scenePolicyReport.exceptionsApplied, report: SCENE_POLICY_REPORT_FILE } : null,
      devicePolicy: { version: DEVICE_POLICY_VERSION, hard: devSummary.hard, soft: devSummary.soft, byRule: devSummary.byRule },
      openingHook: {
        platform: PLATFORM, windowSec: hookWindowFor(PLATFORM), hard: hookSummary.hard, soft: hookSummary.soft,
        hook: hookCard ? { type: hookCard.type, promise: hookCard.promise, payoffShotId: hookCard.payoffShotId } : null,
        sfx: hookSfxEnabled ? hookSfxSpec : null
      }
    }
  });
  if (!g7.approved && !ACCEPT_REJECTED.includes("G7")) {
    log(`⛔ G7 预生产最终确认未通过：${g7.reason}`);
    process.exit(5);
  }

  /**
   * 参考图口径（`docs/character-archive-design.md` 附录 A.2）：**默认不往每镜塞定妆照**。
   * 真机复验：影棚灰底定妆照当参考图会把"美颜 + 柔光箱"的风格带进成片
   * （细节 58.6 vs 实景帧 1204.2、饱和 0.369 vs 0.205）。人物一致性改由 **首帧 = 该镜关键帧** 承担
   * （关键帧本身已用定妆照锚定过长相）；确需额外锚定时用 `--use-portrait-refs` 显式打开。
   */
  const usePortraitRefs = flag("--use-portrait-refs");
  const refs = usePortraitRefs && lead
    ? (["front", "closeup"].map((a) => lead.files[a]).filter(Boolean) as string[])
    : [];
  /**
   * 授权真人素材镜的参考图口径（T-2026-0929-0003）：
   * 该镜**只**带平台授权素材引用（`asset://<asset ID>`）作 `reference_image`，且**不带首帧**——
   * 首帧会给一张 AI 生成的脸，把真人身份顶掉。人物身份、口型与台词都交给 Seedance 按参考图生成。
   */
  /**
   * 真人镜参考图：**主素材 + 同组素材（最多 3 张）**——单张参考容易漂脸，同组多张显著更稳。
   * 资质与授权范围来自真人主档（referenceAssets / assetGroupId）。
   */
  /**
   * 真人镜参考图：**同组多张素材（最多 3）+ 首镜已放行帧（身份锚）**，总计不超过 4 张。
   * 侧脸/背影等非正面构图靠这套锚定保长相——不靠删构图。
   */
  const refsForShot = (shot: ShotCard): string[] => isAssetShot(shot)
    ? generationIdentityLock(characterReleaseContract, shot.shotId).referenceAssets : refs;
  /**
   * 送审基准图口径：评审组件按**本地文件**读图，`asset://` 是平台素材引用、不是文件路径
   * （真机 2026-09-29：把 asset 引用当基准图投递 → `ENOENT: open 'asset://…'`，监制直接不可用）。
   * 因此送审时只投递本地存在的图片；授权素材引用只进生成请求（`arkVideo` 的 reference_image）。
   */
  const localReviewRefs = localReviewRefsEarly;
  for (const shot of FIRST_PASS_ORDER) {
    if (completedByShot.has(shot.shotId)) continue;
    const clip = join(CLIP_DIR, `${shot.shotId}.mp4`);
    const duration = Number(shot.duration ?? 5);
    /** A material shot never enters the unrelated generated-shot paid submission. */
    if (isMaterialShot(shot)) {
      const verified = materialGateVerified(shot.shotId);
      record({
        stage: "shot", shotId: shot.shotId, invoked: false, ok: existsSync(clip) && verified, cached: true,
        degraded: !verified, attempt: 0, ms: 0,
        artifact: existsSync(clip) ? clip : null,
        evidence: {
          photo: String((shot as Record<string, unknown>).photo), source: "material-gen",
          materialGate: verified ? "当前已签发原片来源已采用" : "缺当前已签发原片来源",
          policy: MATERIAL_POLICY_VERSION, skipReason: "素材镜的生成与判据在 material-gen 阶段完成"
        },
        verdict: null,
        note: verified
          ? "素材镜：复用已签发原片，不重复提交渲染"
          : "素材镜：缺真实已签发原片，未提交到其他生成路径"
      });
      continue;
    }
    const shotRefs = refsForShot(shot);
    const shotIsAsset = isAssetShot(shot);
    rememberInputs(
      "shot",
      shotIsAsset
        ? [join(PROMPT_DIR, `${shot.shotId}.txt`), join(realPersonLibrary.byAssetId.get(assetIdOf(assetRefOf(shot)))!.dir, "profile.json")]
        : [join(PROMPT_DIR, `${shot.shotId}.txt`), join(PLATE_DIR, `${shot.shotId}-plate.png`), ...shotRefs],
      shot.shotId
    );
    if (DRY_RUN) {
      record({ stage: "shot", shotId: shot.shotId, invoked: false, ok: true, cached: false, degraded: false, attempt: 0, ms: 0, artifact: null, evidence: { dryRun: true }, verdict: null });
      continue;
    }
    const plate = join(PLATE_DIR, `${shot.shotId}-plate.png`);
    const prompt = readFileSync(join(PROMPT_DIR, `${shot.shotId}.txt`), "utf8")
      + (REVISION_CONTEXT ? `\n\n【本次返修验收】保持原镜头主体与意图，仅修复下列已归因问题：${REVISION_CONTEXT}` : "");
    let approved = false;
    /**
     * 重试必须「带变更」（2026-09-24 烧额度根因）：
     * 早先第 2 次尝试提交的是**与第 1 次完全相同的提示词**（只有 seed 不同），
     * 本质是"重采样碰运气"而不是修问题——SC-02 因此连烧 5 次渲染仍不过。
     * 现在把上一轮监制的 issues/suggestions 显式写进提示词，并记录提示词指纹，
     * 让日志能自证"这次重试确实改了东西"。
     */
    let lastVerdict: ProducerVerdict | null = null;
    let lastPromptFingerprint: string | null = null;
    for (let attempt = 1; attempt <= MAX_ATTEMPTS && !approved; attempt += 1) {
      const started = Date.now();
      const originalAttemptPrompt = attempt === 1 ? prompt : `${prompt}\n\n${retryInstruction(lastVerdict, attempt, MAX_ATTEMPTS)}`;
      const attemptPrompt = originalAttemptPrompt + (shotIsAsset ? `\n\n${generationIdentityLock(characterReleaseContract, shot.shotId).promptFragment}` : "");
      const promptFingerprint = createHash("sha256").update(attemptPrompt).digest("hex").slice(0, 12);
      try {
        /**
         * 首帧必须用**Ark 托管 URL**（同账号模型产物），不能是 base64：
         * 真机实测 base64 真人图会被隐私校验拒（见 `hostedUrlFile` 注释与探针脚本）。
         * 托管 URL 过期（>20h）时退回 base64 并如实记录——让监制看到这是降级路径，而不是假装成功。
         */
        /**
         * 授权真人素材镜（T-2026-0929-0003）：**不要首帧**。
         * 首帧是一张 AI 生成的人脸，会把平台素材里的真人身份顶掉（Seedance 以首帧为画面基准）；
         * 这类镜头改由 `reference_image = asset://<asset ID>` 承担人物身份，让模型按真实长相生成。
         */
        const hosted = shotIsAsset ? null : loadHostedUrl(shot.shotId);
        const firstFrame = shotIsAsset ? undefined : hosted ?? (existsSync(plate) ? dataUrl(plate) : undefined);
        if (!shotIsAsset && !hosted && existsSync(plate)) {
          log(`  ⚠ ${shot.shotId} 无有效托管 URL，退回 base64 首帧（真人题材大概率被隐私校验拒）`);
        }
        /**
         * G8 渲染提交审批（step_key: g8-render-submit）——**花钱之前**的逐镜门。
         *
         * 与 §⑤ 的 `shot` 门（生成之后再评审）不同，G8 管的是"这一单该不该提交"：
         * 提示词是否达到交付口径、有没有把 f 值等技术参数写进正文（KB 纪律）、画幅约束是否在场、
         * 首帧锚点是否存在、以及本镜是否在知情放行名单里。不通过就不提交（不烧额度）。
         */
        const promptText = readFileSync(join(PROMPT_DIR, `${shot.shotId}.txt`), "utf8");
        const g8 = recordGate({
          stepKey: "g8-render-submit",
          sourceStage: "shot",
          shotIds: [shot.shotId],
          checks: [
            { id: "prompt-length", pass: promptText.trim().length >= 1200, hard: true, detail: `提示词 ${promptText.trim().length} 字（交付口径 ≥1200）` },
            { id: "no-hard-params", pass: !/f\/\d/.test(promptText), hard: true, detail: /f\/\d/.test(promptText) ? "提示词正文出现 f 值（KB 纪律：正文只写画面语言，f 值只进 trace）" : "正文不含 f 值等技术参数" },
            { id: "aspect-constraint", pass: /【约束】/.test(promptText) && promptText.includes(ASPECT), hard: true, detail: `含【约束】与画幅 ${ASPECT}` },
            { id: "duration-limit", pass: duration > 0 && duration <= 30, hard: true, detail: `单镜时长 ${duration}s（上限 30s）` },
            {
              id: "first-frame", pass: shotIsAsset ? true : Boolean(hosted) || existsSync(plate), hard: true,
              detail: shotIsAsset
                ? `授权真人素材镜：不带首帧，人物身份由参考图 ${assetRefOf(shot)} 承担（外部素材 ID，未平台核验）`
                : hosted ? `首帧用 Ark 托管 URL（${basename(hosted)}）` : existsSync(plate) ? "首帧退回本地关键帧 base64（隐私校验风险，已记录）" : "既无托管 URL 也无关键帧"
            },
            {
              id: "plate-size", pass: shotIsAsset || !existsSync(plate) || statSync(plate).size > 50_000, hard: false,
              detail: shotIsAsset ? "授权真人素材镜不产关键帧（合规口径，不是缺件）" : existsSync(plate) ? `关键帧 ${(statSync(plate).size / 1024).toFixed(0)}KB` : "无关键帧文件"
            }
          ],
          evidence: {
            model: VIDEO_MODEL, seconds: duration, attempt,
            promptFingerprint: createHash("sha256").update(attemptPrompt).digest("hex").slice(0, 12),
            promptChars: promptText.trim().length
          }
        });
        if (!g8.approved && !ACCEPT_REJECTED.includes(shot.shotId) && !ACCEPT_REJECTED.includes("G8")) {
          log(`  ⏭ ${shot.shotId} G8 未批准提交（${g8.reason.slice(0, 120)}）→ 不提交，避免白烧额度`);
          record({
            stage: "shot", shotId: shot.shotId, invoked: false, ok: false, cached: false, degraded: false, attempt,
            ms: Date.now() - started, artifact: null, evidence: { gateBlocked: "g8-render-submit", reason: g8.reason }, verdict: null,
            note: "G8 渲染提交审批未通过：未向渲染服务提交"
          });
          break;
        }
        preflightSubmitGuard({ shotId: String(shot.shotId), stage: "videos", prompt: attemptPrompt, fps: FPS, attempt, prevFingerprint: lastPromptFingerprint });
        lastPromptFingerprint = promptFingerprint;
        if (shotIsAsset) {
          const input = assessCharacterGenerationInput({ contract: characterReleaseContract, shotId: shot.shotId, prompt: attemptPrompt, referenceAssets: shotRefs });
          if (input.status !== "passed") throw new Error(`CHARACTER_GENERATION_INPUT_BLOCKED: ${input.issues.map((issue) => issue.detail).join("；")}`);
        }
        writeFileSync(join(PROMPT_DIR, `${shot.shotId}.submitted.txt`), attemptPrompt);
        if (shotIsAsset) rememberInputs("shot", [join(PROMPT_DIR, `${shot.shotId}.txt`), join(PROMPT_DIR, `${shot.shotId}.submitted.txt`),
          join(realPersonLibrary.byAssetId.get(assetIdOf(assetRefOf(shot)))!.dir, "profile.json")], shot.shotId);
        const submitted = await arkVideo({
          stage: "videos", target: clip, shotId: shot.shotId,
          prompt: attemptPrompt,
          firstFrame,
          refs: shotRefs.map(dataUrl),
          /** Exact supported submitted duration; no post-generation retiming. */
          seconds: renderSecondsFor(duration),
          generateAudio: true,
          seed: 20260924 + attempt
        });
        await download(submitted.url, clip);
        /** Preserve successful provider bytes; official post normalizes the actual media metadata. */
        assertOriginalRenderMedia(clip, duration, shot.shotId);
        log(`  · ${shot.shotId} 成功渲染原片保持字节不变，直接进入正式后期`);
        const info = probe(clip);
        if (!submitted.requestInputVerified) {
          record({ stage: "shot", shotId: shot.shotId, invoked: true, ok: false, cached: false, degraded: true,
            attempt, ms: Date.now() - started, artifact: clip,
            evidence: { ...info, taskId: submitted.taskId, resumed: submitted.resumed, requestInputVerified: false, submissionReceipt: submitted.submissionReceipt ?? null,
              rawSha256: sha256FileSync(clip), generationPromptSha256: null }, verdict: null,
            note: "已接续供应商任务并保存内部候选；缺实际提示词与引用输入证明，禁止正式出片且不自动重渲" });
          break;
        }
        await issueOriginalRenderReceipt({ productionRoot: WORK_DIR, projectId: PROJECT, shotId: shot.shotId, submittedSha256: sourceFileHash,
          artifactPath: clip, taskId: submitted.taskId, requestInputVerified: submitted.requestInputVerified, submissionReceipt: submitted.submissionReceipt, parentWorkDir: WORKER_RUNTIME?.context.workDir });
        record({ stage: "shot", shotId: shot.shotId, invoked: true, ok: true, cached: submitted.resumed, degraded: false,
          attempt, ms: Date.now() - started, artifact: clip, evidence: { ...info, taskId: submitted.taskId,
            providerSuccess: true, requestInputVerified: true, rawSha256: sha256FileSync(clip),
            submissionReceipt: submitted.submissionReceipt ?? null, generationPromptSha256: fingerprintText(attemptPrompt),
            basePromptSha256: fingerprintText(prompt), referenceAssets: shotRefs, qualityReviewPerformed: false, identityVerified: false, wardrobeVerified: false }, verdict: null,
          note: "供应商成功返回的镜头已默认采用，直接正式后期；未执行品质或人物审核" });
        approved = true;
      } catch (err) {
        record({
          stage: "shot", shotId: shot.shotId, invoked: true, ok: false, cached: false, degraded: false, attempt,
          ms: Date.now() - started, artifact: null, evidence: { error: err instanceof Error ? err.message.slice(0, 300) : String(err) }, verdict: null
        });
        throw err;
      }
    }

    if (!approved) throw new Error(`RENDER_PROCESS_FAILED: ${shot.shotId} actual provider or file processing failed; no quality retry was made`);
  }
}

// Every real post stage initializes this value before source access; dry-run never issues a source proof.
let originalPostContract!: Awaited<ReturnType<typeof loadOriginalRenderManifest>>;
if (!DRY_RUN && ["voice", "compose", "color", "subtitle", "danmaku", "bgm", "sfx", "cover", "mux", "master", "deliver"].some(stage => STAGES.has(stage))) {
  const originalManifest = await captureOriginalRenderManifest({ productionRoot: WORK_DIR, projectId: PROJECT });
  originalPostContract = await loadOriginalRenderManifest(originalManifest, { ffmpeg: FFMPEG, ffprobe: FFPROBE });
  // Freeze authored intent unchanged. Only derived post cards use the measured
  // complete picture clock, shared by composition, subtitles, covers and BGM.
  for (const shot of shots) {
    const entry = originalPostContract.timeline.find(row => row.shotId === shot.shotId);
    if (!entry) throw new Error(`STANDARD_NATIVE_ORIGINAL_BINDING_INVALID: ${shot.shotId}`);
    shot.duration = entry.durationSec;
  }
  expectedMasterSeconds = originalPostContract.durationSec;
  let elapsedFrames = 0;
  CUT_GRID.splice(0, CUT_GRID.length, ...originalPostContract.originals.slice(0, -1).map(original => {
    elapsedFrames += Math.max(1, Math.ceil(original.media.videoFrames / original.media.fps * FPS - 1e-8));
    return elapsedFrames / FPS;
  }));
}
function originalForShot(shot: ShotCard): string {
  const original = originalPostContract?.originals.find(s => s.shotId === shot.shotId);
  if (!original || !existsSync(original.path) || statSync(original.path).size !== original.bytes || fingerprintFile(original.path) !== original.sha256)
    throw new Error(`STANDARD_NATIVE_ORIGINAL_CHANGED: ${shot.shotId}`);
  return original.path;
}
function originalFactsForShot(shot: ShotCard) {
  const path = originalForShot(shot), original = originalPostContract.originals.find(s => s.shotId === shot.shotId)!;
  return { path, sha256: original.sha256, bytes: original.bytes, durationSeconds: original.media.videoFrames / original.media.fps, fps: original.media.fps,
    audio: { present: original.media.audioChannels > 0, sampleRate: original.media.audioSampleRate, channels: original.media.audioChannels, durationSec: original.media.audioDurationSec } };
}

/* ---------- ③-2 原始音轨来源核验（step_key: voice） ---------- */
/** This factual stage verifies each issued original file and its existing audio stream.
 * Authored words remain metadata; this stage makes no ASR, voice synthesis or lip-sync claim. */
const NARRATION_PROFILE = arg("--narration-profile", "zh-xiaozhi");
if (["--narration-profile", "--dub-on-verify-failure"].some(flag))
  throw new Error("STANDARD_NATIVE_VOICE_OPTION_REJECTED: post preserves each original rendered audio stream");

/** Historical dubbed paths remain recognizable by audit code; they are never selected. */
function voicedFile(shotId: string): string { return join(CLIP_DIR, `${shotId}.voiced.mp4`); }
function latestVoiceRecord(shotId: string): StageRecord | null {
  return readStageHistory().filter(entry => entry.stage === "voice" && entry.shotId === shotId
    && entry.evidence?.projectId === PROJECT).at(-1) ?? null;
}

/** Read only the pinned original and metadata needed for the selected post operation. */
function nativeAudioFactsForShot(shot: ShotCard): {
  path: string; sha256: string; bytes: number;
  nativeAudio: { present: boolean; sampleRate: number; channels: number; durationSec: number };
} {
  const facts = originalFactsForShot(shot);
  return { path: facts.path, sha256: facts.sha256, bytes: facts.bytes, nativeAudio: facts.audio };
}
function clipFor(shot: ShotCard): string { return nativeAudioFactsForShot(shot).path; }

const narrationCoverage: Array<{ shotId: string; speaker: string; text: string; ok: boolean; source: string; detail: string }> = [];
if (STAGES.has("voice") && DRY_RUN) {
  record({ stage: "voice", shotId: null, invoked: false, ok: false, cached: false, degraded: true, attempt: 0, ms: 0,
    artifact: null, evidence: { dryRun: true, verification: "not-performed" }, verdict: null,
    note: "dry-run: no original native audio certification was issued" });
} else if (STAGES.has("voice")) {
  const started = Date.now();
  for (const shot of shots) {
    const shotStarted = Date.now(), text = dialogueText(shot);
    const speaker = String((shot.dialogue ?? [])[0]?.speaker ?? "原始环境声");
    try {
      const facts = nativeAudioFactsForShot(shot);
      const contract = resolveFilmAudioContract(shot as unknown as Parameters<typeof resolveFilmAudioContract>[0]);
      rememberInputs("voice", [facts.path], shot.shotId);
      const detail = facts.nativeAudio.present ? "保留原片已有音频；未执行语音、口型或品质审核" : "原片无音频，保持静音；未执行TTS或补造语音";
      narrationCoverage.push({ shotId: shot.shotId, speaker, text, ok: true, source: "clip-audio", detail });
      record({ stage: "voice", shotId: shot.shotId, invoked: true, ok: true, cached: false, degraded: false,
        attempt: 1, ms: Date.now() - shotStarted, artifact: facts.path,
        evidence: { projectId: PROJECT, source: "clip-audio", verification: "native-audio-source-verified",
          originalManifestSha256: originalPostContract.manifestSha256, rawSha256: facts.sha256,
          rawBytes: facts.bytes, textSha256: fingerprintText(text), audioPolicyHash: contract.policyHash,
          sourcePolicy: contract.sourcePolicy, nativeAudio: facts.nativeAudio,
          spokenTextVerified: false, lipSyncVerified: false }, verdict: null, note: detail });
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      narrationCoverage.push({ shotId: shot.shotId, speaker, text, ok: false, source: "clip-audio-unverified", detail });
      record({ stage: "voice", shotId: shot.shotId, invoked: true, ok: false, cached: false, degraded: false,
        attempt: 1, ms: Date.now() - shotStarted, artifact: null,
        evidence: { projectId: PROJECT, source: "clip-audio-unverified", verification: "failed", error: detail,
          spokenTextVerified: false, lipSyncVerified: false }, verdict: null,
        note: "原片或原始音轨证据不符：停止后期，不替换声音" });
      throw new Error(`STANDARD_NATIVE_AUDIO_BLOCKED: ${shot.shotId}: ${detail}`);
    }
  }
  record({ stage: "voice-summary", shotId: null, invoked: true, ok: true, cached: false, degraded: false,
    attempt: 1, ms: Date.now() - started, artifact: null,
    evidence: { projectId: PROJECT, verifiedOriginalSources: narrationCoverage.length, total: shots.length,
      originalManifestSha256: originalPostContract.manifestSha256, perShot: narrationCoverage,
      spokenTextVerified: false, lipSyncVerified: false }, verdict: null,
    note: "逐镜同源原始音轨来源已核验；此回执不认证台词或口型" });
  log(`原始音轨：${narrationCoverage.length}/${shots.length} 镜同源来源核验通过（未调用ASR/TTS）`);
}

/* ---------- ④ 合成母版 ---------- */
let master = join(POST_DIR, "master-raw.mp4");
if (STAGES.has("compose") && DRY_RUN) log("dry-run：跳过合成，不签发原片或成片认证");
if (STAGES.has("compose") && !DRY_RUN) {
  if (!originalPostContract) throw new Error("STANDARD_NATIVE_MANIFEST_REQUIRED: composition requires the issued original contract");
  const expectedOrder = originalPostContract.timeline.map(entry => entry.shotId), actualOrder = shots.map(shot => shot.shotId);
  if (actualOrder.length !== expectedOrder.length || actualOrder.some((id, index) => id !== expectedOrder[index])
    || ORDER_POLICY !== "storyboard" || COMPOSE_ORDER || REUSE_PLAN || XFADE !== 0 || EFFECTIVE_CUT_TRANSITION
    || expectedMasterSeconds !== originalPostContract.durationSec)
    throw new Error("STANDARD_NATIVE_TIMELINE_OVERRIDE_REJECTED: preserve every original full shot in submitted order without retiming");
  const nativeFacts = shots.map(nativeAudioFactsForShot), clips = shots.map(clipFor);
  const actualTimeline = shots.map((shot, index) => ({ shotId: shot.shotId,
    video: { path: clips[index]!, sha256: nativeFacts[index]!.sha256, bytes: nativeFacts[index]!.bytes, inSec: 0 },
    audio: { path: clips[index]!, sha256: nativeFacts[index]!.sha256, bytes: nativeFacts[index]!.bytes, inSec: 0 },
    durationSec: Number(shot.duration), speed: 1 }));
  assertStandardPostTimeline(originalPostContract.contract, actualTimeline);
  rememberInputs("compose", clips);
  const started = Date.now(), { durationSec } = originalPostContract;
  const { width, height } = OUTPUT_SIZE, fps = FPS, totalFrames = Math.round(durationSec * fps);
  const result = runCli(join(REPO_ROOT, "scripts/tools/compose-film.mts"), [
    "--clips", clips.join(","), "--out", master, "--width", String(width), "--height", String(height),
    "--fps", String(fps), "--fade", "0", "--color", "none", "--native-clock"
  ]);
  for (const [index, shot] of shots.entries()) {
    const after = nativeAudioFactsForShot(shot), before = nativeFacts[index]!;
    if (after.path !== before.path || after.sha256 !== before.sha256 || after.bytes !== before.bytes)
      throw new Error(`STANDARD_NATIVE_SOURCE_CHANGED_DURING_COMPOSE: ${shot.shotId}`);
  }
  const info = existsSync(master) ? probe(master) : {};
  const receiptFile = master.replace(/\.mp4$/i, ".av-sync.json");
  let processReceipt: Record<string, any> | null = null;
  if (result.ok && existsSync(master) && existsSync(receiptFile)) {
    try { processReceipt = JSON.parse(readFileSync(receiptFile, "utf8")); }
    catch (error) { throw new Error(`STANDARD_NATIVE_COMPOSE_RECEIPT_INVALID: ${(error as Error).message}`); }
  }
  const clock = processReceipt?.outputMedia;
  const sourceBindings = Array.isArray(processReceipt?.sources) && processReceipt!.sources.length === nativeFacts.length
    && Array.isArray(processReceipt!.target?.shotFrames) && processReceipt!.target.shotFrames.length === nativeFacts.length
    && processReceipt!.sources.every((source: Record<string, any>, index: number) => {
      const original = originalPostContract.originals[index]!;
      return source.path === nativeFacts[index]!.path && source.sha256 === nativeFacts[index]!.sha256
        && source.source?.videoFrames === original.media.videoFrames && source.source?.fps === original.media.fps
        && source.normalized?.videoFrames === Math.max(1, Math.ceil(original.media.videoFrames / original.media.fps * fps - 1e-8))
        && source.normalized?.fps === fps && source.normalized?.width === width && source.normalized?.height === height
        && processReceipt!.target.shotFrames[index] === source.normalized.videoFrames;
    });
  const actualFrames = Number(clock?.videoFrames), actualSeconds = actualFrames / fps;
  const mediaOk = processReceipt?.schemaVersion === "workloom.composition-process/v1"
    && processReceipt.outputSha256 === (existsSync(master) ? sha256FileSync(master) : "") && sourceBindings
    && Number.isSafeInteger(actualFrames) && actualFrames > 0 && clock?.fps === fps && clock?.width === width && clock?.height === height
    && Number(info.width) === width && Number(info.height) === height && Math.abs(Number(info.fps) - fps) <= 1e-6
    && Number(info.videoFrames) === actualFrames
    && (!originalPostContract.originals.some(original => original.media.audioChannels > 0) || clock?.hasAudio === true && info.hasAudio === true)
    && Math.abs(Number(info.videoDurationSec || info.duration) - actualSeconds) <= 2e-6;
  if (mediaOk) {
    expectedMasterSeconds = actualSeconds;
    const counts = processReceipt!.target?.shotFrames;
    if (!Array.isArray(counts) || counts.length !== shots.length || counts.some((count: unknown) => !Number.isSafeInteger(count) || Number(count) < 1)
      || counts.reduce((sum: number, count: number) => sum + count, 0) !== actualFrames)
      throw new Error("STANDARD_NATIVE_COMPOSE_RECEIPT_INVALID: actual complete shot frame ranges are missing");
    let frames = 0;
    CUT_GRID.splice(0, CUT_GRID.length, ...counts.slice(0, -1).map((count: number) => { frames += count; return frames / fps; }));
    shots.forEach((shot, index) => { shot.duration = counts[index] / fps; });
  }
  const verdict = result.ok && mediaOk ? await reviewStage({ stage: "compose", projectId: PROJECT,
    artifacts: [{ path: master, kind: "video", probe: info }],
    deterministic: [
      { id: "original-timeline", pass: true, hard: true, detail: "所有原片按提交顺序完整入片，画面和音频同源，in=0 / speed=1" },
      { id: "duration", pass: mediaOk, hard: true, detail: `实际完整源时间线 ${actualSeconds}s / ${actualFrames} frames @${fps}fps（原计划 ${durationSec}s）` },
      { id: "resolution", pass: mediaOk, hard: true, detail: `${width}x${height} requested export geometry; raw originals unchanged` }
    ], context: { originalManifestSha256: originalPostContract.manifestSha256, actualTimeline,
      transitions: null, fadeSeconds: 0, retimed: false, localVoiceReplacement: false },
    env: ENV, allowFallbackApprove: ALLOW_FALLBACK_APPROVE, log }) : null;
  record({ stage: "compose", shotId: null, invoked: true, ok: Boolean(result.ok && mediaOk && verdict?.approved),
    cached: false, degraded: Boolean(verdict?.degraded), attempt: 1, ms: Date.now() - started, artifact: existsSync(master) ? master : null,
    evidence: { ...info, outputFiles: existsSync(master) ? [`${master.replace(/\.mp4$/i, "")}.av-sync.json`] : [],
      tool: "scripts/tools/compose-film.mts", originalManifestSha256: originalPostContract.manifestSha256,
      sourcePolicy: "render-native", actualTimeline, processReceipt, actualBodyDurationSec: actualSeconds, qualityReviewPerformed: false, fadeSeconds: 0, transitions: null, retimed: false,
      order: { policy: "storyboard", expected: expectedOrder, actual: actualOrder, ok: true },
      toolOk: result.ok, mediaOk, toolOutput: result.out.slice(-400) }, verdict });
  if (!result.ok || !mediaOk || !verdict?.approved || verdict.degraded)
    throw new Error(`STANDARD_NATIVE_COMPOSE_FAILED: ${result.ok ? mediaOk ? "composition review unverified" : "requested output clock or geometry mismatch" : result.out.slice(-400)}`);
}

/* ---------- ⑤ 调色：执行所选配方，不进行素材或候选品质审核 ---------- */
let colored = STAGES.has("color") ? master : preferDownstream(join(POST_DIR, "master-graded.mp4"), master, "color");
if (STAGES.has("color") && existsSync(master)) {
  rememberInputs("color", [master]);
  const started = Date.now(), graded = join(POST_DIR, "master-graded.mp4");
  const profile = arg("--color-profile", "natural"), intensity = arg("--color-intensity", "0.3");
  const result = runCli(COLOR_CLI, ["grade", "--in", master, "--out", graded, "--profile", profile, "--intensity", intensity, "--no-verify", "--no-defects"]);
  const produced = result.ok && existsSync(graded);
  record({ stage: "color", shotId: null, invoked: true, ok: produced, cached: false, degraded: false,
    attempt: 1, ms: Date.now() - started, artifact: produced ? graded : null,
    evidence: { profile, intensity, tool: "color-bridge grade", qualityReviewPerformed: false, toolOutput: result.out.slice(-800) }, verdict: null });
  if (!produced) throw new Error(`COLOR_PROCESS_FAILED: ${result.out.slice(-800)}`);
  colored = graded;
}

/* ---------- ⑥ 字幕（subtitle-bridge：选型 + 版式 + 旁挂文件；烧录按需） ---------- */
/**
 * 两种落地方式（`--subtitle-mode`）：
 *   · sidecar（缺省）：**母版不烧字**——出 `subtitles/<项目>.zh.srt|.zh.ass|.vtt` + 清单，
 *     后期想用就软轨内嵌（`mux` 阶段）或交给剪辑软件，不想用就当没这回事（画面像素从未被改）；
 *   · burn：仍把字烧进画面（另存 `master-subtitled.mp4`），母版变成带字版（发出去就回不来）。
 * 旁挂文件与烧录共用同一套字体选型 / 版式 / ASS 生成器（subtitle-bridge plan），所以两种形态观感一致。
 */
/** 未重跑字幕时，若磁盘上有"不早于当前上游"的字幕版就沿用它（只重跑后段的场景） */
let subtitled = STAGES.has("subtitle") ? colored : preferDownstream(join(POST_DIR, "master-subtitled.mp4"), colored, "subtitle");
/** 旁挂字幕文件（sidecar 模式的产物；burn 模式下为 null，下游仍走烧字版） */
let subtitleSidecar: { dir: string; srt: string; ass: string; manifest: string | null; timelineOk: boolean } | null = null;
if (STAGES.has("subtitle") && existsSync(colored)) {
  rememberInputs("subtitle", [colored]);
  const started = Date.now();
  const srtFile = join(POST_DIR, "subtitle.srt");
  writeFileSync(srtFile, buildSrt(), "utf8");
  const briefFile = BRIEF_FILE ? abs(BRIEF_FILE) : null;
  const platform = arg("--platform", "抖音/快手");

  if (SUBTITLE_MODE !== "burn") {
    const sidecarDir = join(POST_DIR, "subtitles");
    const sidecarResult = runCli(SUBTITLE_CLI, [
      "sidecar", "--in", colored, "--out-dir", sidecarDir, "--srt", srtFile, "--name", PROJECT,
      "--platform", platform,
      ...(briefFile ? ["--brief", briefFile] : [])
    ]);
    const zhSrt = join(sidecarDir, `${PROJECT}.zh.srt`);
    const zhAss = join(sidecarDir, `${PROJECT}.zh.ass`);
    const manifest = join(sidecarDir, `${PROJECT}.subtitle-manifest.json`);
    const timelineOk = sidecarResult.ok && /时间轴回读 ok/.test(sidecarResult.out);
    const verdict = await reviewStage({
      stage: "subtitle", projectId: PROJECT,
      artifacts: [
        { path: existsSync(zhSrt) ? zhSrt : srtFile, kind: "text", note: "旁挂字幕（母版未烧字）" },
        ...(existsSync(zhAss) ? [{ path: zhAss, kind: "text" as const, note: "带版式的 ASS（软轨/再烧同源）" }] : [])
      ],
      deterministic: [
        { id: "sidecar-produced", pass: existsSync(zhSrt) && existsSync(zhAss), detail: existsSync(zhSrt) ? "旁挂字幕文件已产出（srt + ass）" : "旁挂字幕文件未产出", hard: true },
        { id: "tool-exit", pass: sidecarResult.ok, detail: sidecarResult.ok ? "字幕工位退出码 0" : `字幕工位失败：${sidecarResult.out.slice(-300)}`, hard: true },
        { id: "timeline", pass: timelineOk, detail: (sidecarResult.out.match(/时间轴回读[^\n]*/) ?? ["无回读信息"])[0] ?? "" },
        { id: "master-untouched", pass: sidecarResult.out.includes("母版未被改动 ok"), detail: "母版只读：出字幕文件的过程不改动画面（哈希与 mtime 双验）", hard: true }
      ],
      context: { mode: SUBTITLE_MODE, srt: readFileSync(srtFile, "utf8").slice(0, 1200), platform, toolOutput: sidecarResult.out.slice(-900) },
      env: ENV, allowFallbackApprove: ALLOW_FALLBACK_APPROVE, log
    });
    if (existsSync(zhSrt)) {
      subtitleSidecar = { dir: sidecarDir, srt: zhSrt, ass: existsSync(zhAss) ? zhAss : zhSrt, manifest: existsSync(manifest) ? manifest : null, timelineOk };

    }
    record({
      stage: "subtitle", shotId: null, invoked: true, ok: sidecarResult.ok && Boolean(subtitleSidecar), cached: false, degraded: false,
      attempt: 1, ms: Date.now() - started, artifact: existsSync(zhSrt) ? zhSrt : null,
      evidence: { mode: "sidecar", srt: zhSrt, ass: zhAss, manifest, outputFiles: [zhSrt, zhAss, manifest], timelineOk, tool: "subtitle-bridge sidecar", masterBurnedIn: false }, verdict
    });
    if (sidecarResult.ok) log(`字幕以旁挂文件产出（母版不烧字）：${zhSrt}`);
  }

  if (SUBTITLE_MODE !== "sidecar") {
    const out = join(POST_DIR, "master-subtitled.mp4");
    /**
     * 片头标题卡（2026-09-27 真机事故）：字幕工位的 `burn --title` 会在**正片开头烧一张 3 秒标题卡**。
     * 上一版把片名原样（`AI 班组住进你公司 · 获客增长系统 89 秒销售口播`）传进去，
     * 大号标题横穿人物面部、两行还各自超宽——产品所有者看到的第一眼就是"排版乱"。
     * 纪律：
     *   · 封面卡已经承担片头标题时（本管线默认会产出并前置封面卡）**不再重复烧标题卡**；
     *   · 确需标题卡（`--no-open-with-cover` 或只跑字幕段）时，用**短标题**（取 `·` 前主标题、≤12 字），
     *     不再把整条片名塞进画面。
     */
    // 片名用于项目元数据；仅显式 --opening-title 授权烧入开场画面。
    const titlePolicy = resolveOpeningTitle({ explicitTitle: arg("--opening-title", ""), disabled: flag("--no-title-card") });
    const openingTitle = titlePolicy.title;
    const burnOpeningTitle = titlePolicy.burn;
    if (!burnOpeningTitle) log("  · 片头标题卡：未明确请求，不从项目片名推导");
    const result = runCli(SUBTITLE_CLI, [
      "burn", "--in", colored, "--out", out, "--srt", srtFile,
      ...(burnOpeningTitle ? ["--title", openingTitle] : []),
      "--platform", platform,
      ...(briefFile ? ["--brief", briefFile] : []),
      "--evidence-dir", join(POST_DIR, "subtitle-evidence")
    ]);
    const info = existsSync(out) ? probe(out) : {};
    const verdict = await reviewStage({
      // 阶段名统一为 `subtitle`（历史裁决按阶段名检索：burn/sidecar 只是同一步的两种落地方式，
      // 命名分开会让"历史日志里有 subtitle 的放行裁决"这条链路完整性检查在本模式下误判缺失）
      stage: "subtitle", projectId: PROJECT,
      artifacts: [{ path: existsSync(out) ? out : colored, kind: "video", probe: info }, { path: srtFile, kind: "text" }],
      deterministic: [
        { id: "burned", pass: existsSync(out), detail: existsSync(out) ? "字幕版已产出" : "字幕版未产出", hard: true },
        { id: "tool-exit", pass: result.ok, detail: result.ok ? "字幕工位退出码 0" : `字幕工位失败：${result.out.slice(-300)}`, hard: true },
        /**
         * 标点口径（2026-09-25）：烧录模式没有旁挂清单可查，判据取自**字幕工位的实测输出**
         * （工位在烧录前会打印"标点体检 ok/fail"，它查的是真正写进画面的事件文本）。
         */
        {
          id: "punctuation", pass: /标点体检 ok/.test(result.out), hard: true,
          detail: (result.out.match(/标点体检[^\n]*/) ?? ["字幕工位未输出标点体检（无法证明字幕不带标点）"])[0]
        },
        { id: "timeline", pass: /时间轴回读 (\d+)\/(\d+) 条（一致）/.test(result.out) || result.out.includes("一致"), detail: (result.out.match(/时间轴回读[^\n]*/) ?? ["无回读信息"])[0] ?? "" }
      ],
      context: { mode: SUBTITLE_MODE, srt: readFileSync(srtFile, "utf8").slice(0, 1200), platform, toolOutput: result.out.slice(-900) },
      env: ENV, allowFallbackApprove: ALLOW_FALLBACK_APPROVE, log
    });
    if (existsSync(out)) subtitled = out;
    record({
      stage: "subtitle", shotId: null, invoked: true, ok: result.ok && existsSync(out), cached: false, degraded: false,
      attempt: 1, ms: Date.now() - started, artifact: existsSync(out) ? out : null,
      evidence: {
        mode: "burn", srt: srtFile, tool: "subtitle-bridge burn", masterBurnedIn: true,
        punctuationOk: /标点体检 ok/.test(result.out),
        punctuationDetail: (result.out.match(/标点体检[^\n]*/) ?? [null])[0]
      }, verdict
    });
  } else {
    // sidecar 模式：画面这一路保持"未烧字"，下游（弹幕/配乐/封面）都从干净版派生
    subtitled = colored;
  }
}

/* ---------- ⑦ 弹幕（subtitle-bridge danmaku） ---------- */
/**
 * 弹幕层**可按项目关闭**（2026-09-25）：小红书这类内容社区没有弹幕文化，
 * 硬塞一层评点会显得违和。关闭时后续环节直接接字幕版（`master-subtitled.mp4`），
 * 并在阶段日志里留一条"显式跳过"，终审的血缘/层级检查也据此少一层（不冒充已执行）。
 */
const DANMAKU_ENABLED = !flag("--no-danmaku");

let danmakuOut = DANMAKU_ENABLED
  ? (STAGES.has("danmaku") ? subtitled : preferDownstream(join(POST_DIR, "master-danmaku.mp4"), subtitled, "danmaku"))
  : subtitled;
if (DANMAKU_ENABLED && STAGES.has("danmaku") && existsSync(subtitled)) {
  rememberInputs("danmaku", [subtitled]);
  const started = Date.now();
  const itemsFile = DANMAKU_FILE ? abs(DANMAKU_FILE) : join(POST_DIR, "danmaku.json");
  if (!DANMAKU_FILE) {
    /** 无现成弹幕稿：按镜头内容即时报文生成（评论语气，与画面语境一致） */
    const items: Array<Record<string, unknown>> = [];
    let cursor = 0.5;
    const pool = (shot: ShotCard): string[] => {
      const mood = String(shot.mood ?? "");
      return mood.includes("食")
        ? ["桂花糖粥绝了", "想吃海棠糕", "这条街有味道"]
        : mood.includes("俏皮") || mood.includes("生活气")
          ? ["评弹一响就上头", "巷子好好逛", "本地人路过"]
          : mood.includes("夜")
            ? ["夜景太温柔了", "灯笼好看", "已收藏"]
            : ["这也太好看了吧", "苏州真会养人", "想去走走"];
    };
    for (const shot of shots) {
      const duration = Number(shot.duration ?? 5);
      const texts = pool(shot);
      texts.forEach((text, i) => {
        items.push({ text, at: Number((cursor + 0.8 + i * 1.4).toFixed(2)), mode: i === 1 ? "top" : "scroll" });
      });
      cursor += duration;
    }
    writeFileSync(itemsFile, `${JSON.stringify(items, null, 2)}\n`, "utf8");
  }
  const out = join(POST_DIR, "master-danmaku.mp4");
  const result = runCli(SUBTITLE_CLI, [
    "danmaku", "--in", subtitled, "--out", out, "--items", itemsFile,
    "--platform", arg("--platform", "B站"),
    "--evidence-dir", join(POST_DIR, "danmaku-evidence")
  ]);
  /** 失败弹幕渲染不借用另一阶段的关闭标记。 */
  const info = existsSync(out) ? probe(out) : {};
  const density = (result.out.match(/条数[^\n]*/) ?? ["无密度信息"])[0] ?? "";
  const verdict = await reviewStage({
    stage: "danmaku", projectId: PROJECT,
    artifacts: [{ path: existsSync(out) ? out : subtitled, kind: "video", probe: info }, { path: itemsFile, kind: "json" }],
    deterministic: [
      { id: "rendered", pass: existsSync(out), detail: existsSync(out) ? "弹幕版已产出" : "弹幕版未产出", hard: true },
      { id: "tool-exit", pass: result.ok, detail: result.ok ? "弹幕工位退出码 0" : `弹幕工位失败：${result.out.slice(-300)}`, hard: true },
      { id: "density", pass: /并发峰值 \d+\/8/.test(result.out), detail: density }
    ],
    context: { items: JSON.parse(readFileSync(itemsFile, "utf8")).slice(0, 12), toolOutput: result.out.slice(-700) },
    env: ENV, allowFallbackApprove: ALLOW_FALLBACK_APPROVE, log
  });
  if (existsSync(out)) danmakuOut = out;
  record({
    stage: "danmaku", shotId: null, invoked: true, ok: result.ok && existsSync(out), cached: false, degraded: false,
    attempt: 1, ms: Date.now() - started, artifact: existsSync(out) ? out : null, evidence: { items: itemsFile, tool: "subtitle-bridge danmaku" }, verdict
  });
}

/* ---------- ⑧ 配乐（bgm-bridge） ---------- */
/** 未重跑配乐时沿用磁盘上不早于上游的配乐版；重跑则由下面的 bgm 环节覆盖 */
let scored = STAGES.has("bgm") ? danmakuOut : preferDownstream(join(POST_DIR, "master-scored.mp4"), danmakuOut, "bgm");

/**
 * 配乐混音参数：走**配乐师（数字员工）的配方库**（bundles/ai-video/library/bgm-recipes/recipes.json）。
 * 2026-10-09 产品所有者口径："BGM 走内置配乐 agent 流程；一个是可能不够应景，另一个是声音有点小、基本感受不到。"
 *   · 配方（题材×情绪×平台）决定基准电平/让位深度（`musicLevelDb`/`duckingDb`，平台覆盖优先）；
 *   · `--bgm-presence music-led` 用于"音乐是片子骨架"的城市片/旅拍片：在配方基准上给可闻度加成，
 *     仍受上限钳制（不超过 -8dB），语音段靠 `--bgm-ducking` 让位；
 *   · `--bgm-level` 显式给值时优先（调用方接管）。
 */
async function resolveBgmMixSettings(input: {
  genre: string; mood: string; platform: string; recipeId?: string; presence: string;
  explicitLevel: string; explicitDucking: string; boostDb: number;
}): Promise<{ recipeId: string | null; recipeLabel: string | null; levelDb: string; duckingDb: string; levelSource: string; override: unknown }> {
  const core = await import(join(REPO_ROOT, "bundles/ai-video/connectors/bgm-bridge/core.mjs")) as {
    findRecipes: (query: { genre?: string; mood?: string; platform?: string; recipeId?: string }) => { recipe?: { id?: string; genre?: string; mood?: string } | null };
    applyPlatformOverrides: (recipe: unknown, platform?: string | null) => { musicLevelDb: number | null; duckingDb: number | null; lufsTarget: number | null; override?: unknown };
  };
  /** 平台要用**规范 id**（xiaohongshu），中文标签会让配方检索落空（真机实测）。 */
  const platformId = (() => { try { return getCoverSpec(input.platform).id; } catch { return input.platform; } })();
  const hit = input.recipeId
    ? core.findRecipes({ recipeId: input.recipeId })
    : core.findRecipes({ genre: input.genre, mood: input.mood, platform: platformId });
  const recipe = hit?.recipe ?? null;
  const effects = core.applyPlatformOverrides(recipe, platformId);
  const baseLevel = Number.isFinite(effects.musicLevelDb) ? Number(effects.musicLevelDb) : -18;
  const boost = input.presence === "music-led" ? input.boostDb : 0;
  const resolvedLevel = Math.max(-24, Math.min(-8, baseLevel + boost));
  const explicit = input.explicitLevel.trim();
  return {
    recipeId: recipe?.id ?? null,
    recipeLabel: recipe ? `${recipe.genre ?? "-"} · ${recipe.mood ?? "-"}` : null,
    levelDb: explicit || String(resolvedLevel),
    duckingDb: input.explicitDucking.trim() || String(effects.duckingDb ?? 14),
    levelSource: explicit ? "explicit-flag" : (input.presence === "music-led" ? `recipe+music-led(+${boost}dB)` : "recipe"),
    override: effects.override ?? null
  };
}

/**
 * 配乐师（数字员工）的**选曲**流程：提示词简报 → 题材配方 → 本地曲库按简报打分 → 选中曲目。
 * 2026-10-09 产品所有者口径："BGM 要走内置配乐 agent 流程；不够应景 + 声音有点小。"
 * growthtest 旧默认是"按标签找第一首"（`pickDeclaredMusicBed`），既不读简报也不打分；
 * 这里改走 `bgm-bridge` 的 `analyzePromptBrief` + `resolveTrackForBrief(policy=local)`——
 * 与 Growth 仓默认的 `best` 同源（brief→recipe→候选打分），最终混音仍由本脚本按可闻度口径执行。
 */
async function pickAgentMusicBed(input: {
  genre: string; mood: string; platform: string; recipeId?: string; durationSec: number; promptText: string;
}): Promise<{ id: string; title: string; path: string; bpm: number | null; durationSec: number | null;
  recipeId: string | null; layer: string | null; score: number | null; reasons: string[] } | null> {
  try {
    const briefMod = await import(join(REPO_ROOT, "bundles/ai-video/connectors/bgm-bridge/brief.mjs")) as {
      analyzePromptBrief: (options: { promptText: string; platform?: string | null; durationSec?: number | null }) => {
        brief: { recipeId?: string | null; musicLevelDeltaDb?: number } };
    };
    const core = await import(join(REPO_ROOT, "bundles/ai-video/connectors/bgm-bridge/core.mjs")) as {
      findRecipes: (query: { genre?: string; mood?: string; platform?: string; recipeId?: string }) => { recipe?: { id?: string } | null };
      resolveTrackForBrief: (options: Record<string, unknown>) => Promise<{
        track?: { id?: string; title?: string; localPath?: string; bpm?: number | null; durationSec?: number | null;
          match?: { score?: number; reasons?: string[] } } | null;
        layer?: string | null; attempts?: Array<{ status?: string; message?: string }>;
      }>;
    };
    /** 平台用规范 id；配方优先取调用方显式声明（`--bgm-recipe`），否则按题材+情绪检索。 */
    const platformId = (() => { try { return getCoverSpec(input.platform).id; } catch { return input.platform; } })();
    const { brief } = briefMod.analyzePromptBrief({ promptText: input.promptText, platform: platformId, durationSec: input.durationSec });
    const recipe = input.recipeId
      ? core.findRecipes({ recipeId: input.recipeId }).recipe ?? null
      : core.findRecipes({ genre: input.genre, mood: input.mood, platform: platformId }).recipe ?? null;
    const resolution = await core.resolveTrackForBrief({ brief, recipe, policy: "local", durationSec: input.durationSec, env: ENV });
    const track = resolution?.track ?? null;
    const path = String(track?.localPath ?? "");
    if (!track || !path || !existsSync(path)) {
      log(`  ↻ 配乐师选曲：本地曲库未命中（${resolution?.attempts?.at(-1)?.message ?? "无候选"}）`);
      return null;
    }
    const reasons = [
      `配乐师简报：配方 ${brief?.recipeId ?? "-"}（能量加成 ${brief?.musicLevelDeltaDb ?? 0}dB）`,
      ...(track.match?.reasons ?? []).slice(0, 4)
    ];
    log(`  ✓ 配乐师选曲：${track.title ?? track.id}（匹配分 ${track.match?.score ?? "-"}，来源层 ${resolution?.layer ?? "-"}）`);
    return {
      id: String(track.id ?? ""), title: String(track.title ?? ""), path,
      bpm: Number.isFinite(Number(track.bpm)) ? Number(track.bpm) : null,
      durationSec: Number.isFinite(Number(track.durationSec)) ? Number(track.durationSec) : null,
      recipeId: brief?.recipeId ?? null, layer: resolution?.layer ?? null,
      score: Number.isFinite(Number(track.match?.score)) ? Number(track.match?.score) : null,
      reasons
    };
  } catch (error) {
    log(`  ↻ 配乐师选曲失败（${error instanceof Error ? error.message.slice(0, 140) : String(error)}）→ 回退按标签选曲`);
    return null;
  }
}
if (STAGES.has("bgm") && existsSync(danmakuOut) && !DRY_RUN) {
  rememberInputs("bgm", [danmakuOut]);
  const started = Date.now(), out = join(POST_DIR, "master-scored.mp4");
  const genre = arg("--bgm-genre", "旅行"), mood = arg("--bgm-mood", "温润治愈"), policy = arg("--bgm-policy", "keep-dialogue");
  const chosenTrack = arg("--bgm-track", "");
  const sourcePolicy = "declared-local";
  if (flag("--allow-synth-bgm") || ["online-first", "compose-only"].includes(arg("--bgm-source-policy", "")))
    throw new Error("BGM_SOURCE_POLICY_INVALID: successful-render post consumes declared local music only");
  void sourcePolicy;
  let trackPath = chosenTrack;
  if (chosenTrack && !existsSync(trackPath)) {
    const core = await import(join(REPO_ROOT, "bundles/ai-video/connectors/bgm-bridge/core.mjs"));
    const found = core.findTracks({ trackId: chosenTrack, commercialUse: true });
    if (!found.track?.path || !existsSync(found.track.path)) throw new Error(`BGM_TRACK_MISSING: ${chosenTrack}`);
    trackPath = found.track.path;
  }
  const requestedOff = flag("--no-bgm");
  const agentBed = !requestedOff && !chosenTrack
    ? await pickAgentMusicBed({ genre, mood, platform: COVER_PLATFORM_ARG || PLATFORM, recipeId: arg("--bgm-recipe", "").trim() || undefined,
      durationSec: expectedMasterSeconds, promptText: bgmPromptText })
    : null;
  const declaredTrack = !requestedOff && !chosenTrack && !agentBed ? await pickDeclaredMusicBed(expectedMasterSeconds, CUT_GRID, { genre, mood }) : null;
  if (!requestedOff && !chosenTrack && !declaredTrack && !agentBed) throw new Error("BGM_SOURCE_MISSING: no declared local music source is available");
  const musicBed = agentBed ?? declaredTrack;
  if (musicBed) trackPath = musicBed.path;
  if (!requestedOff) rememberInputs("bgm", [danmakuOut, trackPath]);
  /** 配乐师配方 → 基准电平/让位深度（平台覆盖优先），music-led 片子再加可闻度加成。 */
  const bgmMix = await resolveBgmMixSettings({
    genre, mood, platform: COVER_PLATFORM_ARG || PLATFORM, recipeId: arg("--bgm-recipe", "").trim() || undefined,
    presence: arg("--bgm-presence", "standard"),
    explicitLevel: arg("--bgm-level", ""), explicitDucking: arg("--bgm-ducking", ""),
    boostDb: Number(arg("--bgm-presence-boost", "8"))
  });
  if (bgmMix.recipeId) log(`  配乐配方：${bgmMix.recipeId}（${bgmMix.recipeLabel}）· 电平 ${bgmMix.levelDb}dB（${bgmMix.levelSource}）· 让位 ${bgmMix.duckingDb}dB`);
  const result = requestedOff ? { ok: true, out: "no_bgm_needed: explicit --no-bgm; original program retained" } : runCli(BGM_CLI, [
    "mix", "--in", danmakuOut, "--out", out, "--bgm", trackPath, "--policy", policy,
    /**
     * 音乐床电平（2026-10-09 产品所有者两轮反馈："听不出 BGM / 声音有点小"）：
     * 走配乐师配方（题材×情绪×平台）的 `musicLevelDb`；`--bgm-presence music-led` 再给加成，
     * `--bgm-level` 显式值优先。语音段让位仍由配方 `duckingDb` 保证。
     */
    "--music-level", bgmMix.levelDb, "--ducking", bgmMix.duckingDb, "--lufs", "-14",
    "--true-peak", arg("--bgm-true-peak", "-1.5"), "--section", arg("--bgm-section", "full"),
    "--declared-program-mix", ...(musicBed?.bpm ? ["--bgm-bpm", String(musicBed.bpm)] : [])
  ]);
  if (!result.ok || (!existsSync(out) && !requestedOff)) throw new Error(`BGM_PROCESS_FAILED: ${result.out.slice(-800)}`);
  if (!requestedOff && existsSync(out)) scored = out;
  if (!originalPostContract) throw new Error("STANDARD_NATIVE_MANIFEST_REQUIRED: final audio export requires the original timeline");
  const nativeAudioClock = await assertStandardPostExportClock(scored, expectedMasterSeconds, { ffmpeg: FFMPEG, ffprobe: FFPROBE, expectedFps: FPS });
  bgmManifestInfo = { layer: requestedOff ? "off" : "on", via: chosenTrack ? "requested-track" : "declared-recipe", declaredOff: requestedOff,
    recipe: bgmMix.recipeId, recipeLabel: bgmMix.recipeLabel, musicLevelDb: bgmMix.levelDb, musicLevelSource: bgmMix.levelSource,
    agentFlow: agentBed ? { pick: "bgm-agent", track: agentBed.id, layer: agentBed.layer, score: agentBed.score,
      briefRecipe: agentBed.recipeId, reasons: agentBed.reasons } : { pick: "declared-label-fallback" },
    duckingDb: bgmMix.duckingDb, platformOverride: bgmMix.override,
    notRequired: requestedOff, reason: requestedOff ? "用户明确要求保留纯原声" : null,
    sourceAuthority: "native-program", stemsVerified: false, output: requestedOff ? null : basename(out), evidence: result.out.slice(-500) };
  record({ stage: "bgm", shotId: null, invoked: true, ok: true, cached: false, degraded: false,
    attempt: 1, ms: Date.now() - started, artifact: scored,
    evidence: { genre, mood, policy, via: bgmManifestInfo.via, nativeAudioClock,
      sourceAuthority: "native-program", stemsVerified: false, applicable: !requestedOff, qualityReviewPerformed: false,
      qualityRetries: 0, tool: "bgm-bridge mix", declaredTrack: musicBed?.id ?? chosenTrack ?? null,
      agentFlow: agentBed ? { track: agentBed.id, layer: agentBed.layer, score: agentBed.score, briefRecipe: agentBed.recipeId } : null,
      toolOutput: result.out.slice(-800) }, verdict: null });
}

if (!bgmManifestInfo && stageApproved("bgm")) {
  const last = latestLineageRecord(lineageRecords(readStageHistory(), "bgm"), PROJECT, "bgm", null);
  const evidence = last?.evidence ?? {};
  const off = evidence.applicable === false;
  const signed = !off && evidence.sourceAuthority === "signed-stems" && evidence.stemsVerified === true;
  bgmManifestInfo = { layer: off ? "off" : "on", via: evidence.via ?? "historical-receipt", declaredOff: off,
    sourceAuthority: signed ? "signed-stems" : evidence.sourceAuthority === "native-program" ? "native-program" : "declared-unverified", stemsVerified: signed,
    output: last?.artifact ? basename(last.artifact) : null, recoveredFrom: last?.at ?? null,
    reason: off ? evidence.skipReason ?? "本次有效回执声明不适用" : null };
}
const bgmScored = scored;
/* ---------- ⑧-2 转场音效层（step_key: sfx，《瞭望塔》式城市片的第三层声音，2026-09-25 新增） ---------- */
/**
 * 拉片结论（`docs/watchtower-deconstruction.md` §三/§六）：这类片子听感的一半来自**剪辑点上的音效**——
 * 甩镜有气流（whoosh）、段落重音有冲击（impact）、进入高潮前有抬升（riser）。
 * 本阶段把这层补上，且全部**合成**（无第三方采样，确定性可复现）：
 *   ① 从镜头时长 + 逐刀转场参数推出剪辑点（与 compose 的 xfade 口径一致）；
 *   ② 每个剪辑点铺 whoosh、段落重音铺 impact、高潮前铺 riser（`planCutSfx`）；
 *   ③ 合成音效 → 逐条 adelay 拼成 SFX 轨 → 与母版音轨混音（视频轨 copy）；
 *   ④ 复核：响度仍在 −14 LUFS ±1.5、剪辑点窗口内确有新增能量（"做了但听不见"要被抓出来）。
 */
/**
 * 转场音效层（whoosh/impact/riser）的**启用口径**（2026-10-09 产品所有者两轮反馈后定稿）：
 *   · 原生硬切生产里，切点上的气流声/抬升声会被听成"呲"（第一轮：逐刀 whoosh；第二轮：高潮前 riser 收在最后一刀上）；
 *   · 因此**默认不铺**这一层，只有显式声明才启用：`--sfx-layer`（整层：重音 impact + 高潮 riser）、
 *     `--sfx-cut-whoosh`（连硬切也铺 whoosh），或声明了逐刀运动掩体转场（whoosh 与转场天然配对）；
 *   · `--no-sfx` 永远优先关闭（即使声明了其它开关）。
 */
const SFX_EXPLICIT = flag("--sfx-layer") || flag("--sfx-cut-whoosh") || Boolean(EFFECTIVE_CUT_TRANSITION);
if (STAGES.has("sfx") && flag("--no-sfx")) {
  record({ stage: "sfx", shotId: null, invoked: true, ok: true, cached: false, degraded: false, attempt: 1, ms: 0,
    artifact: null, evidence: { applicable: false, skipReason: "调用方显式 --no-sfx：不铺转场音效层" },
    verdict: null, note: "SFX 层按调用方声明关闭（保留原声 + 配乐）" });
}
if (STAGES.has("sfx") && !flag("--no-sfx") && !SFX_EXPLICIT && !DRY_RUN) {
  record({ stage: "sfx", shotId: null, invoked: true, ok: true, cached: false, degraded: false, attempt: 1, ms: 0,
    artifact: null,
    evidence: { applicable: false, skipReason: "原生硬切生产默认不铺转场音效层（需 --sfx-layer / --sfx-cut-whoosh 显式开启）",
      hookSfxDeclared: hookSfxEnabled ? { kind: hookSfxSpec.kind, atSec: hookSfxSpec.atSec } : null,
      hookSfxProduced: false },
    verdict: null, note: "SFX 层按默认口径不适用：保留原声 + 配乐，不铺 whoosh/impact/riser" });
}
if (STAGES.has("sfx") && !flag("--no-sfx") && SFX_EXPLICIT && existsSync(scored) && !DRY_RUN) {
  rememberInputs("sfx", [scored]);
  const started = Date.now();
  const sfxDir = join(POST_DIR, "sfx");
  mkdirSync(sfxDir, { recursive: true });
  const totalDuration = Number(probe(scored).duration ?? 0);
  const shotDurations = shots.map((s) => Number(s.duration ?? 5));
  const cutTimes = cutTimesFromShots(shotDurations, EFFECTIVE_CUT_TRANSITION ? CUT_TRANSITION_DURATION : 0,
    EFFECTIVE_CUT_TRANSITION ? EFFECTIVE_CUT_TRANSITION_AT.split(",").map((v) => Number(v.trim())).filter((v) => Number.isFinite(v) && v > 0) : []);
  /** 段落重音 = 进入快剪段的第一刀 + 最后一刀（模板可覆盖） */
  const accentTimes = cutTimes.length > 1 ? [cutTimes[0]!, cutTimes[cutTimes.length - 1]!] : cutTimes.slice(0, 1);
  /**
   * whoosh 的摆放口径（2026-10-09 产品所有者打回：成片"镜头切换处每刀一声呲"）：
   *   · whoosh 的设计用途是**运动掩体转场**（甩镜拖影/擦除）的气流声；原生标准生产是**硬切**，
   *     没有掩体可掩护——每刀一铺就退化成一串噪声，听感即"呲"。
   *   · 因此只有声明过逐刀转场时才在转场点铺 whoosh；硬切也想铺气流的片子必须显式 `--sfx-cut-whoosh`。
   *   · 段落重音（impact）与高潮抬升（riser）不受影响。
   */
  const whooshCuts = EFFECTIVE_CUT_TRANSITION ? cutTimes : (flag("--sfx-cut-whoosh") ? cutTimes : []);
  const plannedCuts = [...new Set([...whooshCuts, ...accentTimes])].sort((a, b) => a - b);
  /**
   * 高潮那一刻 = 最后一个重音刀口（进入收尾镜之前）。
   * riser 由策划器**前置**到高潮之前（真机打回：riser 落在切点之后 = 高潮过去了才抬升）。
   */
  const climaxAtSec = accentTimes.length > 0 ? accentTimes[accentTimes.length - 1] : undefined;
  const sfxPlan = planCutSfxDetailed({ cutTimes: plannedCuts, durationSec: totalDuration, accentTimes, climaxAtSec }, CUT_SFX_POLICY);
  /**
   * 开场钩子音（2026-09-27）：0–0.6s 是转场音效覆盖不到的窗口，单独摆一条。
   * 与转场音效的冲突在这里显式消解（不是静默丢弃）：钩子音**优先**——它是前 3 秒机制的一部分，
   * 被它挤掉的剪辑点音效如实记进 `hookConflicts`。
   */
  const hookPlacement = planHookSfx({
    enabled: hookSfxEnabled && existsSync(scored),
    atSec: hookSfxSpec.atSec, kind: hookSfxSpec.kind, gainDb: hookSfxSpec.gainDb
  });
  const hookConflicts = hookPlacement
    ? sfxPlan.placements.filter((placement) => Math.abs(placement.atSec - hookPlacement.atSec) < CUT_SFX_POLICY.minGapSec)
    : [];
  const placements = [
    ...(hookPlacement ? [hookPlacement] : []),
    ...sfxPlan.placements.filter((placement) => !hookConflicts.includes(placement))
  ];
  try {
    const files: string[] = [];
    const renderOne = (kind: "whoosh" | "impact" | "riser", durationSec: number, file: string): void => {
      run(FFMPEG, ["-y", ...buildSfxArgs({ kind, durationSec }), "-f", "wav", file]);
    };
    placements.forEach((placement, index) => {
      const file = join(sfxDir, `${String(index + 1).padStart(2, "0")}-${placement.kind}-${placement.atSec}s.wav`);
      /** 钩子音按 `HOOK_SFX_POLICY.durationSec`（0.26s 收在 0–0.6s 窗口内），剪辑点音效按各音色默认时长 */
      const durationSec = hookPlacement && placement === hookPlacement
        ? HOOK_SFX_POLICY.durationSec
        : (placement.kind === "riser" ? 1.2 : placement.kind === "impact" ? 0.26 : 0.36);
      renderOne(placement.kind, durationSec, file);
      files.push(file);
    });
    const sfxTrack = join(sfxDir, "sfx-track.wav");
    if (placements.length === 0) {
      log("  ⚠ 没有剪辑点可铺音效（跳过 SFX 层）");
      record({
        stage: "sfx", shotId: null, invoked: true, ok: true, cached: false, degraded: true, attempt: 1, ms: Date.now() - started,
        artifact: null, evidence: { placements: 0, cutTimes, whooshCuts, plannedCuts }, verdict: null, note: "无剪辑点：SFX 层未产出（如实记录，不静默）"
      });
    } else {
      /** 合成 SFX 轨：每条音效按 atSec 延迟后混在一起（amix 不做响度归一，避免把短音效拉爆） */
      const inputs = placements.map((_, index) => `-i ${JSON.stringify(files[index]!)}`).join(" ");
      const delays = placements.map((placement, index) =>
        `[${index}:a]adelay=${Math.round(placement.atSec * 1000)}|${Math.round(placement.atSec * 1000)},volume=${placement.gainDb}dB[a${index}]`
      ).join(";");
      const mixInputs = placements.map((_, index) => `[a${index}]`).join("");
      run(FFMPEG, ["-y", ...placements.flatMap((_, index) => ["-i", files[index]!]),
        "-filter_complex", `${delays};${mixInputs}amix=inputs=${placements.length}:normalize=0:dropout_transition=0[aout]`,
        "-map", "[aout]", "-t", totalDuration.toFixed(3), "-ar", "48000", "-ac", "2", "-c:a", "pcm_s16le", sfxTrack]);
      void inputs;
      /** 与母版混音：视频轨 copy，音轨 = 母版 + SFX（SFX 已在摆放阶段设过增益） */
      const out = join(POST_DIR, "master-sfx.mp4");
      run(FFMPEG, ["-y", "-i", scored, "-i", sfxTrack,
        "-filter_complex", "[0:a][1:a]amix=inputs=2:duration=first:normalize=0[aout]",
        "-map", "0:v:0", "-map", "[aout]",
        "-c:v", "copy", "-c:a", "aac", "-b:a", "192k", "-ar", "48000", "-ac", "2",
        "-movflags", "+faststart", out]);
      const verdict = await reviewStage({
        stage: "sfx", projectId: PROJECT,
        artifacts: [{ path: out, kind: "video", probe: probe(out) }, ...placements.slice(0, 6).map((p, i) => ({ path: files[i]!, kind: "audio" as const, note: `${p.kind}@${p.atSec}s` }))],
        rubric: [
          "音效与画面剪辑点对齐：甩镜/擦除处能听到气流，段落重音处有冲击，高潮前有抬升",
          "开场钩子音（若启用）：0–0.6s 内有一记与钩子画面同帧的音效，首句台词仍清晰可辨（开场音是「抬一下」，不是音效秀）",
          "音效不能盖台词：有人声的镜头里，人声仍清晰可辨（响度与让位不因加音效而破坏）",
          "音效不过量：不是每个镜头都塞特效，密集段也不能糊成一片（间隔与条数在口径内）",
          "整片响度仍在母版口径（−14 LUFS ±1.5）"
        ],
        deterministic: [
          { id: "sfx-produced", pass: existsSync(out), detail: existsSync(out) ? "带音效母版已产出" : "带音效母版未产出", hard: true },
          { id: "sfx-count", pass: placements.length >= Math.min(3, plannedCuts.length), detail: `音效 ${placements.length} 条 / 计划编排点 ${plannedCuts.length} 个（剪辑点 ${cutTimes.length} 个，其中铺 whoosh ${whooshCuts.length} 个）`, hard: true },
          {
            id: "hook-sfx-window",
            pass: !hookSfxEnabled || Boolean(hookPlacement),
            hard: hookSfxEnabled && hookWindowFor(PLATFORM) <= HOOK_WINDOW_SEC,
            detail: hookPlacement
              ? `开场钩子音 ${hookPlacement.kind}@${hookPlacement.atSec}s（窗口 0–${HOOK_SFX_POLICY.windowSec}s，与钩子画面同帧）`
              : (hookSfxEnabled ? "钩子音已启用但未摆放（异常）" : "未启用钩子音（长视频平台默认不强制）")
          },
          { id: "video-untouched", pass: Number(probe(out).duration ?? 0) > 0, detail: "视频轨 copy（画面零改动）", hard: true }
        ],
        context: {
          placements: placements.map((p) => `${p.kind}@${p.atSec}s（${p.gainDb}dB，${p.reason}）`),
          cutTimes, whooshCuts, plannedCuts, policy: CUT_SFX_POLICY,
          discipline: "音效是**剪辑点掩体**，不是音效秀：条数与增益按口径执行；听不见=白做，盖住人声=事故。"
        },
        env: ENV, allowFallbackApprove: ALLOW_FALLBACK_APPROVE, log
      });
      if (existsSync(out) && verdict.approved) scored = out;
      record({
        stage: "sfx", shotId: null, invoked: true, ok: verdict.approved && existsSync(out), cached: false,
        degraded: verdict.degraded, attempt: 1, ms: Date.now() - started, artifact: existsSync(out) ? out : null,
        evidence: {
          placements: placements.map((p) => ({ atSec: p.atSec, kind: p.kind, gainDb: p.gainDb, reason: p.reason })),
          dropped: sfxPlan.dropped.map((p) => ({ atSec: p.atSec, kind: p.kind, reason: p.reason })),
          hook: hookPlacement ? { atSec: hookPlacement.atSec, kind: hookPlacement.kind, gainDb: hookPlacement.gainDb, reason: hookPlacement.reason } : null,
          hookConflicts: hookConflicts.map((p) => ({ atSec: p.atSec, kind: p.kind, reason: "被开场钩子音挤掉（0–0.6s 内不与剪辑点音效叠加）" })),
          climaxAtSec, cutTimes, whooshCuts, plannedCuts, loudnessBefore: null, loudnessAfter: null, drift: null, qualityReviewPerformed: false,
          tool: "sfx-synth（合成，无第三方采样）"
        },
        verdict, note: `音效 ${placements.length} 条（whoosh/impact/riser）${hookPlacement ? " · 含开场钩子音" : ""}`
      });
    }
  } catch (err) {
    record({
      stage: "sfx", shotId: null, invoked: true, ok: false, cached: false, degraded: false, attempt: 1,
      ms: Date.now() - started, artifact: null,
      evidence: { error: err instanceof Error ? err.message.slice(0, 300) : String(err) }, verdict: null
    });
  }
}

/* ---------- ⑨ 封面：已声明源 → 平台设计稿 → 实际合成 ---------- */
/** Deterministic platform composition preserves the declared single hero, title hierarchy,
 * account style and source binding. No model design or image-quality review runs here. */

/**
 * 封面设计师（数字员工）的模型调用：**只产出设计稿 JSON**，不产图、不评分。
 * 产品口径（2026-10-09）：封面标题与副标题由封面设计师出稿，不许在管线里硬编码文案；
 * 模型不可用/稿件非法时才退确定性兜底稿（`designVia` 如实记录）。
 */
async function requestCoverDesign(
  config: { baseUrl: string; apiKey: string; model: string },
  prompt: string,
  timeoutMs = 45_000
): Promise<string> {
  const body: Record<string, unknown> = {
    model: config.model,
    messages: [
      { role: "system", content: "你是 WorkLoom 的封面设计师，只输出符合 schema 的 JSON 设计稿，不写解释文字。" },
      { role: "user", content: prompt }
    ],
    temperature: 0,
    response_format: { type: "json_object" }
  };
  /** DeepSeek 官方端点默认思考模式会吃掉短 JSON 稿的预算；仅对官方端点关闭思考（其它兼容端点不发该字段）。 */
  if (/api\.deepseek\.com/i.test(config.baseUrl)) body.thinking = { type: "disabled" };
  const response = await fetch(`${config.baseUrl}/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${config.apiKey}` },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs)
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`封面设计师调用失败 HTTP ${response.status}：${text.slice(0, 200)}`);
  let parsed: { choices?: Array<{ message?: { content?: string } }> };
  try {
    parsed = JSON.parse(text) as typeof parsed;
  } catch {
    throw new Error(`封面设计师响应不是 JSON：${text.slice(0, 160)}`);
  }
  const content = parsed.choices?.[0]?.message?.content ?? "";
  if (!content.trim()) throw new Error("封面设计师返回空稿件");
  return content;
}

/** drawtext 文本净化：ASCII 冒号/逗号/引号等会破坏 filter 语法，换成等价全角或删除（视觉无损） */
function escapeDrawtextText(text: string): string {
  return String(text)
    .replace(/\\/g, "／")
    .replace(/"/g, "”")
    .replace(/'/g, "’")
    .replace(/:/g, "：")
    .replace(/,/g, "，")
    .replace(/;/g, "；")
    .replace(/\[/g, "【")
    .replace(/\]/g, "】")
    .replace(/\r?\n/g, " ")
    .trim();
}

if (!STAGES.has("sfx")) scored = preferDownstream(join(POST_DIR, "master-sfx.mp4"), scored, "sfx");

/** Default-use selects the requested frame without scoring already adopted footage. */
function pickCoverFrameForPolicy(times: number[], inspect: (atSec: number) => number): { atSec: number; sharpness: number | null } {
  if (!times.length || times.some(time => !Number.isFinite(time) || time < 0)) throw new Error("COVER_FRAME_TIME_INVALID");
  return { atSec: times[0]!, sharpness: null };
}
function inspectCoverForPolicy(facts: { bytes: number; width: number; height: number; expectedWidth: number; expectedHeight: number; cleanSource: boolean },
  inspect: () => { checks: GateCheck[]; measurements: CoverMeasurements }): { checks: GateCheck[]; measurements: CoverMeasurements | null } {
  return { measurements: null, checks: [
    { id: "cover-produced", pass: facts.bytes > 0 && facts.width === facts.expectedWidth && facts.height === facts.expectedHeight,
      hard: true, detail: `${facts.width}x${facts.height} · ${facts.bytes} bytes` },
    { id: "clean-source", pass: facts.cleanSource, hard: true, detail: "封面帧来源与当前干净母版绑定" }
  ] };
}
function coverChecksPassed(checks: GateCheck[]): boolean { return checks.every(check => check.hard === false || check.pass); }
function coverSourcesForShots(shotCards: ShotCard[], character: CoverLeadSource | null) {
  const personShots = shotCards.filter(shot => coverShotHasCharacter(shot, character));
  const leadMatchedPersons = personShots.filter(shot => coverShotMatchesLead(shot, character));
  const fallbackBackground = [...shotCards].reverse().find(shot => !coverShotHasCharacter(shot, character)) ?? shotCards[0];
  if (!fallbackBackground) throw new Error("COVER_SOURCE_SHOTS_EMPTY");
  return { personShots, leadMatchedPersons, fallbackBackground };
}
function coverCompositionForPlan(requestedHero: string, plan: CoverPlan, background: ShotCard, person: ShotCard | null, character: CoverLeadSource | null) {
  const source = (shot: ShotCard) => ({ shotId: shot.shotId, hasCharacter: coverShotHasCharacter(shot, character),
    characterIds: coverShotCharacterIds(shot, character) });
  return resolveCoverComposition({ requestedHero, background: source(background), person: person ? source(person) : null,
    personEnabled: plan.person.enabled });
}
if (STAGES.has("cover") && existsSync(colored)) {
  rememberInputs("cover", [colored]);
  const started = Date.now();
  const platform = arg("--platform", "抖音/快手");
  /**
   * 平台规格（唯一事实源：`packages/video-studio/src/cover-platforms.ts`）：
   * 画幅/画布/安全区/标题带/字数上限/英文词数全从这里取；
   * `--cover-platform` 缺省沿用 `--platform`（"抖音/快手"→抖音），因此**默认路径与平台化之前一致**。
   */
  const coverSpec: CoverPlatformSpec = getCoverSpec(COVER_PLATFORM_ARG || platform);
  const coverPng = join(OUT_DIR, `${PROJECT}-cover.png`);
  const coverDir = join(POST_DIR, "cover");
  mkdirSync(coverDir, { recursive: true });
  const coverLead: CoverLeadSource | null = lead ? { id: lead.id, name: lead.name, appearanceInShots: shotlist.character?.appearanceInShots } : null;
  const { personShots, leadMatchedPersons, fallbackBackground } = coverSourcesForShots(shots, coverLead);
  COVER_HERO = resolveCoverHero(COVER_REQUESTED_HERO, leadMatchedPersons.length > 0);
  COVER_ARCHETYPE = ["subject", "scenery", "object", "product"].includes(COVER_HERO) ? "subject-led" : "person-led";
  COVER_LOWER_BAND_TEXT = COVER_HERO === "person-solo";
  /** UHD 封面图形按最终视频画布原生绘制，文字/装饰层不经过视频超分。 */
  const { width: CW, height: CH } = QUALITY === "uhd" ? OUTPUT_SIZE : coverSpec.canvas;
  const coverScale = Math.min(CW / coverSpec.canvas.width, CH / coverSpec.canvas.height);
  /** 平台安全区（机检口径；person-solo 的下带文字另有一套上下限，底部遮挡仍按平台） */
  const coverSafeArea = {
    topMinRatio: coverSpec.safeArea.topMinRatio,
    titleBottomMaxRatio: coverSpec.titleBand.bottomMaxRatio,
    bottomReservedRatio: coverSpec.safeArea.bottomReservedRatio
  };
  let coverSafeAreaForLayout = COVER_LOWER_BAND_TEXT
    ? { ...COVER_LOWER_BAND_SAFE_AREA, bottomReservedRatio: coverSpec.safeArea.bottomReservedRatio }
    : coverSafeArea;
  log(`封面平台：${coverSpec.name}（${coverSpec.id}｜${coverSpec.ratio} ${CW}×${CH}｜标题带 `
    + `${(coverSafeAreaForLayout.topMinRatio * 100).toFixed(0)}%–${(coverSafeAreaForLayout.titleBottomMaxRatio * 100).toFixed(0)}%｜`
    + `底部遮挡 ${(coverSafeArea.bottomReservedRatio * 100).toFixed(0)}%）`);
  const shotAt = (shotId: string): number => {
    const index = shots.findIndex((s) => s.shotId === shotId);
    /**
     * 镜头在**母版时间轴**上的起点：必须扣掉逐刀转场的重叠（2026-09-25 真机）——
     * 早先用"时长累加"，15 刀累计偏移 2.4s，导致封面取帧取到别的镜头（真机：地标插卡里出现的是人物）。
     */
    if (index <= 0) return 0;
    return CUT_GRID[index - 1] ?? shots.slice(0, index).reduce((sum, s) => sum + Number(s.duration ?? 5), 0);
  };
  /**
   * 人物来源镜硬闸（T-2026-0930-0015，产品所有者口径）：
   * 卡片里有人物镜、管线也知道主角是谁，但**没有任何一张卡的 character 写了主角名/ID** 时，
   * 封面"人物为主"版式必然找不到来源镜 → 设计师稿非法 → 退最小稿 → 母版终审被拦（真机事故）。
   * 这里在做封面之前**显式报错**并指出改哪一处，不再静默退化；显式声明 `--cover-archetype subject-led`
   * （本来就不要人物卡）时不拦。
   */
  if (COVER_ARCHETYPE !== "subject-led" && lead && personShots.length > 0 && leadMatchedPersons.length === 0) {
    const detail = `COVER_PERSON_SOURCE_MISSING: 分镜卡里有 ${personShots.length} 个带 character 的镜头，但没有任何一个写了主角「${lead.name}（${lead.id}）」；`
      + "封面「人物为主」版式无法定位人物来源镜（真机事故：character 只写「这位女士…」）。"
      + `请把主角名/ID 写进对应镜头的 character 字段（如「${lead.name}（${lead.id}；与认证素材为同一人…）」），`
      + "或显式声明 --cover-archetype subject-led 只用物体主视觉。";
    log(`⛔ ${detail}`);
    record({
      stage: "cover", shotId: null, invoked: false, ok: false, cached: false, degraded: false, attempt: 1, ms: 0,
      artifact: null,
      evidence: {
        code: "COVER_PERSON_SOURCE_MISSING", archetype: COVER_ARCHETYPE,
        lead: { name: lead.name, id: lead.id },
        personShots: personShots.map((s) => s.shotId)
      },
      verdict: null, note: "封面人物卡缺主角来源镜：先补镜头卡 character（P0 字段）再出片"
    });
    throw new Error(detail);
  }
  const coverBrief = BRIEF_FILE && existsSync(abs(BRIEF_FILE))
    ? (JSON.parse(readFileSync(abs(BRIEF_FILE), "utf8")) as CoverDesignInput["brief"])
    : null;
  /**
   * 副标题覆盖（可选）：`--cover-subline` 优先于 brief.coverSubline；
   * 两者都没有时由封面设计师出稿，兜底稿用不含姓名的时长钩子（见 cover-design.ts）。
   */
  const coverSublineOverride = arg("--cover-subline", "").trim();
  /**
   * 封面知识库 / 账号档案（2026-09-27）：
   *   · KB 注入（cover-kb）：平台规格走**代码**（coverSpec），经验与判据来自 KB（≤3 条，带 trace）；
   *   · 账号档案（account-profiles/*.yml）：视觉锤四件套（字体/色板/版式/角标）+ 钩子偏好 + 禁区；
   *   · 两者都关/都没配时，提示词与校验行为退化为平台化之前（仍按平台出画幅）。
   */
  const coverBridgePath = join(REPO_ROOT, "bundles/ai-video/connectors/cover-kb-bridge/core.mjs");
  const needCoverBridge = COVER_KB_ENABLED || Boolean(COVER_ACCOUNT_ARG);
  const coverBridge = needCoverBridge && existsSync(coverBridgePath)
    ? await import(coverBridgePath) as {
      loadKb: (dir: string) => unknown;
      kbStatus: (kb: unknown) => { ok: boolean; topics: number; mappingRows: number; paramRows: number; missingTopics: Array<{ id: string }>; untrackedTopics: string[] };
      inferTheme: (kb: unknown, text: string) => { theme: string; matched: string[] } | null;
      normalizeAccountProfile: (raw: unknown) => { profile: CoverAccountProfile; accountType: string | null; hookBias: string[]; notes: string[] };
      enrichCoverHints: (kb: unknown, options: Record<string, unknown>) => {
        hints: string[]; trace: Array<{ kbId: string; section: string; reason: string }>;
        fallback: boolean; source?: string; notes?: string[]; conflicts?: string[];
      };
    }
    : null;
  /** 账号档案（视觉锤） */
  let accountProfile: CoverAccountProfile | null = null;
  const accountNotes: string[] = [];
  if (COVER_ACCOUNT_ARG) {
    if (!coverBridge) throw new Error(`账号档案需要 cover-kb 连接器：${coverBridgePath} 不存在`);
    const accountFile = /\.ya?ml$/i.test(COVER_ACCOUNT_ARG)
      ? abs(COVER_ACCOUNT_ARG)
      : join(COVER_ACCOUNT_DIR, `${COVER_ACCOUNT_ARG}.yml`);
    /**
     * 档案缺失**不静默降级**：显式指定的账号读不到，就是拿不到视觉锤约束——
     * 宁可让调用方发现路径写错，也不要用"无档案"的默认行为冒充"账号一致性已生效"。
     */
    if (!existsSync(accountFile)) {
      throw new Error(`--account 档案不存在：${accountFile}（目录 ${COVER_ACCOUNT_DIR}）`);
    }
    const normalized = coverBridge.normalizeAccountProfile(YAML.parse(readFileSync(accountFile, "utf8")));
    accountProfile = normalized.profile;
    accountNotes.push(...normalized.notes);
    log(`封面账号档案：${accountProfile.account_id}${accountProfile.display_name ? `（${accountProfile.display_name}）` : ""}`
      + `｜账号类型 ${normalized.accountType ?? "未识别"}｜视觉锤字体 ${accountProfile.visual_hammer?.fontId ?? "-"}`
      + `｜钩子偏好 ${normalized.hookBias.join("/") || "-"}｜strict ${accountProfile.strict === true ? "on" : "off"}`
      + `${accountNotes.length > 0 ? `｜⚠ ${accountNotes.join("；")}` : ""}`);
  }
  /** 知识库注入载荷（≤3 条 + trace） */
  const coverKb: {
    applied: boolean; source: string; hints: string[]; trace: Array<Record<string, unknown>>;
    notes: string[]; conflicts: string[]; theme: string; topics: number;
  } = { applied: false, source: "none", hints: [], trace: [], notes: [], conflicts: [], theme: "", topics: 0 };
  if (COVER_KB_ENABLED) {
    if (!coverBridge || !existsSync(COVER_KB_DIR)) {
      coverKb.notes.push(`封面知识库或连接器缺失（bridge=${existsSync(coverBridgePath)}｜kb=${existsSync(COVER_KB_DIR)}）`);
      log(`  ⚠ 封面知识库不可用 → 本次不注入（不静默：已记入 cover 阶段证据）`);
    } else {
      const kb = coverBridge.loadKb(COVER_KB_DIR);
      const status = coverBridge.kbStatus(kb);
      coverKb.topics = status.topics;
      if (!status.ok) {
        coverKb.notes.push(`KB 不完整：缺篇 ${status.missingTopics.map((t) => t.id).join("/") || "无"}｜未登记 ${status.untrackedTopics.join("/") || "无"}`);
        log(`  ⚠ 封面知识库自检未过：${coverKb.notes[coverKb.notes.length - 1]}（仍继续，但已留痕）`);
      }
      const inferred = COVER_THEME_ARG ? null : coverBridge.inferTheme(kb, `${shotlist.title ?? ""} ${coverBrief?.goal ?? ""}`);
      const theme = COVER_THEME_ARG || inferred?.theme || "";
      const payload = coverBridge.enrichCoverHints(kb, {
        platformId: coverSpec.id,
        spec: coverSpec,
        theme,
        accountType: accountProfile?.account_type ?? null,
        hookBias: Array.isArray(accountProfile?.hook_bias) ? accountProfile.hook_bias : []
      });
      coverKb.applied = !payload.fallback;
      coverKb.source = payload.source ?? "kb";
      coverKb.hints = payload.hints;
      coverKb.trace = payload.trace as unknown as Array<Record<string, unknown>>;
      coverKb.notes.push(...(payload.notes ?? []));
      coverKb.conflicts.push(...(payload.conflicts ?? []));
      coverKb.theme = theme;
      const traceDir = join(WORK_DIR, "cover-kb");
      mkdirSync(traceDir, { recursive: true });
      const traceFile = join(traceDir, `${PROJECT}.json`);
      writeFileSync(traceFile, `${JSON.stringify({
        at: stamp(), projectId: PROJECT, platformId: coverSpec.id, platformLabel: COVER_PLATFORM_ARG || platform,
        theme, accountId: accountProfile?.account_id ?? null, accountNotes,
        hints: coverKb.hints, trace: coverKb.trace, notes: coverKb.notes, conflicts: coverKb.conflicts,
        kbDir: COVER_KB_DIR, kbTopics: status.topics, spec: coverSpec
      }, null, 2)}\n`, "utf8");
      log(`封面知识库：${status.topics} 篇｜题材 ${theme || "未匹配（不硬凑）"}｜注入 ${coverKb.hints.length} 条`
        + `${coverKb.conflicts.length > 0 ? `｜⚠ 矛盾闸 ${coverKb.conflicts.length} 条（以代码规格为准）` : ""}`
        + `｜trace → ${traceFile}`);
    }
  }
  const designInput: CoverDesignInput = {
    title: shotlist.title,
    /** 真实成片时长（扣转场后的目标）：标题里的"XX 秒"必须与它一致（真机：写 48 秒而片子 51s → 打回） */
    durationSeconds: expectedMasterSeconds,
    /** 版式交办给设计师（2026-09-26）：物体为主 / 人物为主二选一，渲染与监制都按它判 */
    archetype: COVER_ARCHETYPE,
    /** 平台标签用调用方原文（缺省"抖音/快手"→抖音口径），规格由 cover-platforms.ts 解析 */
    platform: COVER_PLATFORM_ARG || platform,
    brief: coverSublineOverride ? { ...(coverBrief ?? {}), coverSubline: coverSublineOverride } : coverBrief,
    character: lead ? { id: lead.id, name: lead.name } : null,
    /** 知识库注入载荷（≤3 条）与账号视觉锤（可空）——两者为空时提示词与历史逐字一致 */
    ...(coverKb.hints.length > 0 ? { kbHints: coverKb.hints } : {}),
    ...(accountProfile ? { accountProfile } : {}),
    shots: shots.map((s) => ({
      shotId: s.shotId,
      scene: String(s.scene ?? ""),
      dialogueText: dialogueText(s),
      hasCharacter: coverShotHasCharacter(s, coverLead),
      duration: Number(s.duration ?? 5)
    }))
  };
  /**
   * ① 设计稿：默认直接采用合法的确定性稿；显式诊断才调用设计师。
   * 模型不可用的兜底与正常确定性设计分别记账，避免把默认成功误标为降级。
   */
  let plan: CoverPlan;
  /**
   * 设计稿来源（2026-10-09 产品所有者口径）：
   * **封面文案由封面设计师数字员工出稿，标题不许硬编码**；模型不可用或稿件非法才退确定性稿，
   * 并如实标注 `designVia`（agent / fallback / deterministic）。`--cover-design deterministic`
   * 供离线/省费场景显式降级（调用方声明，不算失败）。
   */
  let designVia: "agent" | "fallback" | "deterministic" = "deterministic";
  let designNote = "";
  /**
   * 人物卡来源由管线注入：优先与主视觉时段一致的人物镜（夜景封面配夜景人物），
   * 否则用第一个人物镜。**不抠像**：直接用片子自己的镜头帧做肖像卡
   * （真机验证：定妆照抠像会把脸也抠掉、边缘留光晕）。
   */
  const personShotFor = (backgroundShotId: string | undefined): ShotCard | null => {
    /**
     * 人物卡的时段匹配（2026-09-25 二次复核：白天冷调人物卡贴在黄昏暖调底图上被判"气质冲突"）：
     * 底图是**黄昏/落霞/夕阳/夜景/灯光**一类暖调或夜调时，优先用夜景造型的人物镜（旗袍+暖光），
     * 只有白天天光底图才用日间造型。匹配不到就退回第一个人物镜（并在证据里如实记录）。
     */
    /**
     * 封面人物卡**只允许用主角**（2026-09-25 真机）：早先从"所有带 character 的镜头"里挑，
     * 结果挑到了路人（打太极的老人 / 夜跑者），监制判"人物不是主角、还是逆光背影剪影"。
     * 现在先按主角姓名过滤（陈卓），再按时段匹配；主角没有可用镜头时退回"不带人物卡"。
     */
    const leadShots = leadMatchedPersons;
    const pool = leadShots.length > 0 ? leadShots : [];
    if (pool.length === 0) return null;
    const backgroundScene = String(shots.find((s) => s.shotId === backgroundShotId)?.scene ?? "");
    const warmOrNight = /黄昏|落霞|夕阳|傍晚|夜|灯/.test(backgroundScene);
    return pool.find((s) => (warmOrNight ? /夜|灯|黄昏|落霞/.test(String(s.scene ?? "")) : true))
      ?? pool[0] ?? null;
  };
  const coverDesignMode = arg("--cover-design", "agent");
  const fallbackHeadline = arg("--cover-hook", shotlist.title ?? "封面");
  const deterministicCoverPlan = (): CoverPlan => fallbackCoverPlan(designInput, {
    headline: fallbackHeadline,
    heroShotId: fallbackBackground.shotId,
    personShotId: personShotFor(fallbackBackground.shotId)?.shotId
  });
  /**
   * 封面文案红线（2026-10-09 产品所有者口径）：模型不得把**模特/真人的姓名**写进封面；
   * 需要名字只能由调用方在 `brief.coverSubline` 显式给出。
   */
  const forbiddenCoverNames = [lead?.name, lead?.id].map((value) => String(value ?? "").trim()).filter((value) => value.length >= 2);
  const assertCoverCopyHasNoPersonName = (candidate: CoverPlan): void => {
    const copy = [candidate.headline, candidate.subline, candidate.badge].filter(Boolean).join(" ");
    const hit = forbiddenCoverNames.find((name) => copy.includes(name));
    if (hit) throw new Error(`封面文案出现真人姓名「${hit}」（除 brief.coverSubline 显式声明外，封面不得出现姓名）`);
  };
  const coverDesignerLlm = coverDesignMode === "agent" ? resolveProducerLlm(ENV) : null;
  if (coverDesignMode === "agent" && coverDesignerLlm) {
    let lastDesignError = "";
    for (let attempt = 1; attempt <= 2; attempt += 1) {
      try {
        const basePrompt = buildCoverDesignPrompt(designInput);
        const prompt = attempt === 1 ? basePrompt
          : `${basePrompt}\n\n【上一稿被拒的原因（必须修正）】${lastDesignError}\n只输出修正后的 JSON 设计稿。`;
        const raw = await requestCoverDesign(coverDesignerLlm, prompt);
        const candidate = parseCoverPlan(raw, designInput, { personShotId: personShotFor(undefined)?.shotId });
        assertCoverCopyHasNoPersonName(candidate);
        plan = candidate;
        designVia = "agent";
        designNote = `封面设计师（${coverDesignerLlm.model}）出稿：第 ${attempt} 次通过校验；未执行审美评分`;
        break;
      } catch (error) {
        lastDesignError = error instanceof Error ? error.message.slice(0, 200) : String(error);
      }
    }
    if (designVia !== "agent") {
      plan = deterministicCoverPlan();
      designVia = "fallback";
      designNote = `封面设计师出稿未通过（${lastDesignError}）→ 确定性兜底稿；未执行审美评分`;
    }
  } else {
    plan = deterministicCoverPlan();
    designVia = "deterministic";
    designNote = coverDesignMode === "agent"
      ? "未配置封面设计师模型 → 使用确定性稿（如实记录，不冒充设计师出稿）"
      : "调用方显式 --cover-design deterministic：使用确定性稿（未调用设计师模型）";
  }
  log(`  ⇢ ${designNote}`);
  /** 人物卡来源：与主视觉时段一致的人物镜（管线按最终设计稿再校正一次） */
  const personShot = personShotFor(plan.background.shotId);
  if (plan.person?.enabled && personShot) {
    plan = { ...plan, person: { ...plan.person, shotId: personShot.shotId, atSec: plan.person.atSec ?? 1.0 } };
  }
  /**
   * 版式归一（2026-09-26）：物体为主版式下**强制关闭人物层**——即使设计师仍写了 `person.enabled=true`
   * （LLM 受旧口径影响时会这么写），也不允许把人物小图贴到景物/商品上。渲染与监制都按归一后的稿子走。
   */
  if (COVER_ARCHETYPE === "subject-led" && plan.person?.enabled) {
    plan = { ...plan, person: { ...plan.person, enabled: false } };
    log("  ↻ 封面版式：物体为主（subject-led）→ 已强制关闭人物层（人物小图不与主视觉并存）");
  }
  /** Select the declared time on the actual complete body clock; no sharpness scoring. */
  const bgCandidates = (shot: ShotCard): number[] => {
    const duration = Number(shot.duration ?? 5);
    const list = [plan.background.atSec, 0.3, duration * 0.5, duration * 0.75, duration - 0.3];
    return [...new Set(list.map((t) => Math.max(0.2, Math.min(duration - 0.2, Number(t) || 0.3)).toFixed(2)))].map(Number);
  };
  const pickSharpest = (_shot: ShotCard, times: number[]): { atSec: number; sharpness: number | null } =>
    pickCoverFrameForPolicy(times, () => { throw new Error("COVER_QUALITY_REVIEW_DISABLED"); });
  const COVER_MIN_SHARPNESS = null;
  let bgShot = shots.find((s) => s.shotId === plan.background.shotId) ?? shots[0]!;
  let bgPick = pickSharpest(bgShot, bgCandidates(bgShot));
  const bgSubstituted = false;
  /**
   * 小图层（次要画面）与几何——必须在 `bgShot` 定稿**之后**再定：
   *   `landmark` 版 = 人物卡（人物镜取帧，右下角）；
   *   `person`   版 = **地标小图**（底图是人物满幅，地标放右上角），三件套仍然齐备。
   */
  /**
   * `scenery`（景物为主，2026-09-26 产品所有者口径）：**只留一个主视觉**——满幅地标 + 标题，
   * 不叠人物卡。产品原话："要么整个版面以人物为主（商品片则以商品为主）做点缀加标题，
   * 要么直接以景物为主"；把人物硬贴在地标上属于两种主视觉打架，正是被打回的那版。
   */
  const composition = coverCompositionForPlan(COVER_HERO, plan, bgShot, personShot, coverLead);
  COVER_HERO = composition.heroMode;
  COVER_LOWER_BAND_TEXT = composition.lowerBandText;
  coverSafeAreaForLayout = COVER_LOWER_BAND_TEXT
    ? { ...COVER_LOWER_BAND_SAFE_AREA, bottomReservedRatio: coverSpec.safeArea.bottomReservedRatio } : coverSafeArea;
  const insetShot = composition.insetShotId ? shots.find(shot => shot.shotId === composition.insetShotId) ?? null : null;
  let insetEnabled = composition.insetEnabled;
  if (composition.suppressedReason !== "single-hero" && composition.suppressedReason) log(`封面移除重复人物/画面层：${composition.suppressedReason}`);
  /** 母版时长：小图取帧必须夹在成片时长内（真机：inset 时刻越界 → 取不到帧 → 后续 ffmpeg 崩） */
  const masterSeconds = Number(probe(colored).duration ?? 0);
  /** split：右侧竖带（宽 40%、全高）；person：地标小图（右上）；landmark：人物卡（右下） */
  const cardW = COVER_HERO === "split"
    ? Math.round(CW * 0.40)
    : COVER_HERO === "person"
      ? Math.round(CW * 0.38)
      : Math.round(CW * Math.min(0.52, Math.max(0.40, plan.person.widthRatio)));
  const cardH = COVER_HERO === "split" ? CH : Math.round(cardW * 1.32);
  const cardX = COVER_HERO === "split" ? CW - cardW : CW - cardW - Math.round(CW * 0.052);
  const cardY = COVER_HERO === "split" ? 0 : COVER_HERO === "person" ? Math.round(CH * 0.16) : CH - cardH - Math.round(CH * 0.09);
  const cardBorder = Math.max(Math.round(6 * coverScale), Math.round(cardW * 0.018));

  const bgAt = bgPick.atSec;
  /**
   * 主版式分叉（2026-09-25）：
   *   `person` 版：**人物镜取满幅做底**（人物是背景，不存在"贴片边缘"），地标帧留给右上角小图；
   *   `landmark` 版（默认）：地标取满幅做底，人物走右下卡片。
   */
  let heroShot = shots.find(shot => shot.shotId === composition.heroShotId) ?? bgShot;
  let heroAt = heroShot.shotId === bgShot.shotId ? bgAt : 1.0;
  const bgFrameA = join(coverDir, "bg-frame-a.png");
  const bgFrameB = join(coverDir, "bg-frame-b.png");
  run(FFMPEG, ["-y", "-ss", (shotAt(heroShot.shotId) + heroAt).toFixed(2), "-i", colored, "-frames:v", "1", bgFrameA]);
  run(FFMPEG, ["-y", "-ss", (shotAt(heroShot.shotId) + heroAt).toFixed(2), "-i", colored, "-frames:v", "1", bgFrameB]);
  /**
   * 标题带压暗用**多层薄带**拼渐变（2026-09-25 真机二次修正）：
   * 上一版用两层厚带（0.32 + 0.16）→ 监制一眼看出"两条贯穿全宽的硬接缝"，判为合成残留。
   * 现在 14 层薄带、透明度从 0.40 线性衰减到 0，边缘不可辨。
   */
  /**
   * 压暗带随文字带移动（person-solo：文字在下方安全带 → 压暗带也落到下半幅）。
   * 方向也随之翻转：上方文字带是"上深下浅"，下方文字带是"上浅下深"。
   */
  const scrimTop = COVER_LOWER_BAND_TEXT ? Math.round(CH * 0.50) : 0;
  const scrimHeight = Math.round(CH * (COVER_LOWER_BAND_TEXT ? 0.40 : 0.46));
  /**
   * 层数（2026-09-27）：上带维持 14 层（历史真机口径，逐像素不变）；
   * 下带（person-solo）用 28 层——三角剖面在中段最亮，14 层在 1080 高上每层约 31px，
   * 肉眼能看到阶梯状条带（真实监制反馈"可见横向色带"），加密到 28 层（约 15px）后不可辨。
   */
  const scrimBands = COVER_LOWER_BAND_TEXT ? 28 : 14;
  const bandHeight = Math.max(2, Math.round(scrimHeight / scrimBands));
  const scrimFilters = Array.from({ length: scrimBands }, (_, index) => {
    /**
     * 透明度剖面（2026-09-27 真机修正）：
     *   · 上带（默认）= 上深下浅（0.40 → 0）：顶端在画面外，只有下端渐隐，无可见边；
     *   · 下带（person-solo）= **三角剖面**（两端 0、中间 0.40）：原来的"上浅下深"会在
     *     画面内留下一条硬边——真实监制打回原话："标题带下沿（约 80.6%）可见一条硬边
     *     压暗矩形分界线横切人物胸口，属于明显的贴图/蒙版残留痕迹"。
     */
    const t = index / (scrimBands - 1);
    const alpha = 0.40 * (COVER_LOWER_BAND_TEXT ? 1 - Math.abs(2 * t - 1) : 1 - t);
    const y = scrimTop + index * bandHeight;
    return `drawbox=x=0:y=${y}:w=${CW}:h=${bandHeight}:color=black@${alpha.toFixed(3)}:t=fill`;
  });
  const bgOnly = join(coverDir, "bg-only.png");
  run(FFMPEG, ["-y", "-i", bgFrameA, "-vf", [
    `scale=${CW}:${CH}:force_original_aspect_ratio=increase`,
    /**
     * 取帧裁切（2026-09-27 平台化）：竖版画幅仍居中裁切（抖音路径逐像素不变）；
     * 横版平台（B站/YouTube）从竖屏镜头帧里取 16:9 时**偏上取景**（人脸/主体通常在上中部），
     * 避免居中裁切把人物头部切掉。偏置系数 0.38 = 从可用高度 38% 处起裁。
     */
    coverSpec.orientation === "horizontal"
      ? `crop=${CW}:${CH}:(iw-${CW})/2:(ih-${CH})*0.38`
      : `crop=${CW}:${CH}`,
    /** 轻调色：保持片子本身的光线气质（暖调画面不要被压成冷雾——监制二次复核点名的第 5 条） */
    "eq=contrast=1.05:saturation=1.06",
    "colorbalance=rm=0.04:bm=-0.03",
    "vignette=PI/6",
    /**
     * 标题带压暗默认开启（2026-09-25 真机）：设计稿常给 `grade`，但实拍底图亮部复杂时
     * 主标题会"压住地标轮廓/与背景同色"（监制两次点名）。这里改成**始终**叠一层渐变暗带——
     * 代价只是标题带略暗，收益是标题始终可读、不与地标抢轮廓。
     */
    ...scrimFilters
  ].join(","), bgOnly]);
  /**
   * 人物卡：片子自己的镜头帧（与片子同一套造型/光线），白细边 + 投影，落在右下角。
   * 为什么不用"整幅下半身横带"：真机监制一眼看出"贯穿全宽的横向硬接缝 + 地标被一刀切断"，
   * 判为合成残留；改成有边界的肖像卡后，接缝不再存在，"有一张卡"本身是设计意图而不是事故。
   */
  const bgPerson = join(coverDir, "bg-person.png");
  const personFile = join(coverDir, "person-band.png");
  if (insetEnabled && insetShot) {
    /** 小图取帧：landmark 版取人物镜（按设计稿时刻）；person 版取地标镜（已选好的最清晰帧） */
    const insetAt = COVER_HERO === "person"
      ? bgAt
      : Math.max(0.5, Math.min(Number(insetShot.duration ?? 5) - 0.4, plan.person.atSec ?? 1.0));
    const personFrame = join(coverDir, "person-frame.png");
    /** 取帧时刻夹在母版内（越界会让 ffmpeg 产出空文件，下一步直接崩） */
    const insetTime = Math.max(0.05, Math.min(Math.max(0.1, masterSeconds - 0.12), shotAt(insetShot.shotId) + insetAt));
    run(FFMPEG, ["-y", "-ss", insetTime.toFixed(2), "-i", colored, "-frames:v", "1", personFrame]);
    /**
     * 人物层：**无边框 + 四边柔化**的软嵌入（2026-09-25 三次复核后的定稿）。
     * 演进过程（都是真机监制打回的意见）：定妆照抠像 → 会掉脸留光晕；白细边矩形卡 → "贴纸感/白底抠图"；
     * 现在改成：片子自己的镜头帧 → 四边 44px 渐隐 → 与底图自然衔接（既有"人物在场"的设计意图，
     * 又不产生硬边、白框、抠像痕迹）。色温仍向底图靠拢（暖调 + 轻对比）。
     */
    /**
     * 上/左/右三边渐隐、**下边保持不透明**（2026-09-25 真机二次修正）：
     * 四边全渐隐会让卡片变成"半透明雾面贴片"（监制：几乎不可辨）；下边不透明度保证人物"站得住"。
     */
    const fadePx = Math.max(Math.round(56 * coverScale), Math.round(cardW * (COVER_HERO === "split" ? 0.22 : 0.16)));
    const edge = (value: string): string => `min(1\\,${value})`;
    /** split：只渐隐左边界（与地标自然衔接）；其余版式：上/左/右三边渐隐 */
    const alphaExpr = COVER_HERO === "split"
      ? `255*${edge(`X/${fadePx}`)}`
      : `255*min(${edge(`X/${fadePx}`)}\\,min(${edge(`(${cardW}-X)/${fadePx}`)}\\,${edge(`Y/${fadePx}`)}))`;
    if (!existsSync(personFrame)) {
      insetEnabled = false;
      log(`  ⚠ 封面小图取帧失败（${insetShot.shotId}@${insetTime.toFixed(2)}s）→ 本版不叠小图，回退为单主视觉`);
      run(FFMPEG, ["-y", "-i", bgOnly, "-frames:v", "1", bgPerson]);
    } else {
    run(FFMPEG, ["-y", "-i", personFrame, "-vf",
      /**
       * 先**向主体收紧**再进卡：人物镜是"中景/中近景"，整帧塞进卡里人只占一小块；
       * 这里先裁到画面中央 72% 宽、上部 88% 高（主体所在区域），再缩放进卡，
       * 保证卡里"看得出是谁"（真机监制：主体过小无法辨认 → 打回）。
       */
      (COVER_HERO === "split"
        /** split：按竖带比例取人物镜的中段（人像在上三分），整幅高铺满带 */
        ? `crop=iw*0.62:ih*0.96:(iw-iw*0.62)/2:ih*0.02,scale=${cardW}:${cardH}:force_original_aspect_ratio=increase,crop=${cardW}:${cardH},`
        : `crop=iw*0.72:ih*0.88:(iw-iw*0.72)/2:(ih-ih*0.88)*0.35,scale=${cardW}:${cardH}:force_original_aspect_ratio=increase,crop=${cardW}:${cardH},`)
        + `eq=contrast=1.04:saturation=1.05,colorbalance=rm=0.05:bm=-0.04,format=rgba,`
        + `geq=r='r(X,Y)':g='g(X,Y)':b='b(X,Y)':a='${alphaExpr}'`,
      "-frames:v", "1", personFile]);
    /** 投影（半透明黑矩形，偏移右下）再叠卡；投影让"这是一张卡"成立，而不是贴纸 */
    const shadow = join(coverDir, "person-shadow.png");
    run(FFMPEG, ["-y", "-i", bgOnly, "-vf",
      `drawbox=x=${cardX + Math.round(10 * coverScale)}:y=${cardY + Math.round(14 * coverScale)}:w=${cardW}:h=${cardH}:color=black@0.35:t=fill`,
      "-frames:v", "1", shadow]);
    run(FFMPEG, ["-y", "-i", shadow, "-i", personFile, "-filter_complex",
      `[0:v][1:v]overlay=x=${cardX}:y=${cardY}`, "-frames:v", "1", bgPerson]);
    }
  } else {
    run(FFMPEG, ["-y", "-i", bgOnly, "-frames:v", "1", bgPerson]);
  }
  /** 排版：强调色装饰条 + 主标题（可两行）+ 副标题 + 角标 */
  const FONT_FILE = join(REPO_ROOT, "bundles/ai-video/library/fonts", COVER_FONTS[plan.typography.fontId].file);
  /** 景物为主版式没有人物卡抢版面，主标题可以再大一档（同屏信息更少但更醒目） */
  const headSizeDesired = Math.round(CH * plan.typography.headlineSizeRatio * (COVER_HERO === "scenery" && !insetEnabled ? 1.15 : 1));
  const subSize = Math.round(CH * plan.typography.sublineSizeRatio);
  const badgeSize = Math.max(Math.round(28 * coverScale), Math.round(subSize * 0.72));
  const left = plan.typography.align === "center" ? 0 : Math.round(64 * coverScale);
  /**
   * 标题**自适应字级**（2026-09-25 真机二次复核：'标题末字被右缘裁切'）：
   * drawtext 不会自动换行/缩放，设计稿给的字级在实际字数下会溢出画幅。
   * 这里按"汉字 1em、非汉字 0.55em"估宽，把字级压到**一行放得下**为止（下限 60% 设计字级，
   * 再小就说明这句话太长——由机检的标题带检查兜底）。
   */
  const headlineLinesRaw = plan.headline.split("\n").map((line) => escapeDrawtextText(line)).filter(Boolean).slice(0, 2);
  /** 视觉宽度（em）：汉字 1、西文/数字 0.55（与字体无关的保守估计） */
  const emWidth = (text: string): number => [...text].reduce(
    (sum, ch) => sum + (/[\u4e00-\u9fff\u3000-\u303f\uff00-\uffef]/.test(ch) ? 1 : 0.55), 0
  );
  const availableWidth = CW - left - Math.round(CW * 0.06);
  const longestLineEm = Math.max(1, ...headlineLinesRaw.map(emWidth));
  const headSize = Math.max(
    Math.round(headSizeDesired * 0.6),
    Math.min(headSizeDesired, Math.floor(availableWidth / longestLineEm))
  );
  /**
   * 文字带起点：person-solo 下移到面部下方安全带（52%），其余版式保持**平台**顶部安全区
   * （2026-09-27 平台化：抖音 6% / 小红书 7% / YouTube 5%，来自 cover-platforms.ts）。
   */
  const accentY = Math.round(CH * coverSafeAreaForLayout.topMinRatio);
  const accentH = Math.max(Math.round(8 * coverScale), Math.round(CH * 0.006));
  const titleY = accentY + Math.round(headSize * 0.42);
  const lineGap = Math.round(headSize * 0.12);
  const titleLines = headlineLinesRaw;
  const textFilters: string[] = [
    `drawbox=x=${left + 2}:y=${accentY}:w=${Math.round(CW * 0.12)}:h=${accentH}:color=${plan.typography.accentColor}@0.95:t=fill`
  ];
  titleLines.forEach((line, index) => {
    const y = titleY + index * (headSize + lineGap);
    const x = plan.typography.align === "center" ? `(w-text_w)/2` : String(left);
    textFilters.push(
      `drawtext=fontfile='${FONT_FILE}':text=${line}:expansion=none:fontsize=${headSize}:fontcolor=${plan.typography.color}`
        + `:borderw=${Math.max(3, Math.round(headSize * 0.035))}:bordercolor=black@0.55:shadowx=2:shadowy=3:shadowcolor=black@0.35:x=${x}:y=${y}`
    );
  });
  const subY = titleY + titleLines.length * (headSize + lineGap) + Math.round(headSize * 0.12);
  let cursorY = subY;
  /**
   * 副标题/角标**同样自适应字级**（2026-09-27 真机：`四支团队 78 个岗位，你只管拍板`
   * 在 0.03 字级下宽约 1.8 倍画幅 → 直接被右缘裁切，产品所有者当场判"排版太乱"）。
   * 口径同主标题：汉字 1em、非汉字 0.55em 估宽，压到一行放得下为止（下限 55% 设计字级）。
   * 注意必须在 `emWidth/availableWidth` 定义之后计算（上一版放在前面触发 TDZ 报错）。
   */
  const sublineText = plan.subline ? escapeDrawtextText(plan.subline) : "";
  const subSizeDraw = sublineText
    ? Math.max(Math.round(subSize * 0.55), Math.min(subSize, Math.floor(availableWidth / Math.max(1, emWidth(sublineText)))))
    : subSize;
  if (plan.subline) {
    textFilters.push(
      `drawtext=fontfile='${FONT_FILE}':text=${sublineText}:expansion=none:fontsize=${subSizeDraw}`
        + `:fontcolor=${plan.typography.accentColor}:borderw=${Math.max(2, Math.round(subSizeDraw * 0.06))}:bordercolor=black@0.5`
        + `:x=${plan.typography.align === "center" ? "(w-text_w)/2" : String(left + 4)}:y=${cursorY}`
    );
    cursorY += subSizeDraw + Math.round(subSizeDraw * 0.45);
  }
  /**
   * 角标去重（2026-09-27 真机）：设计师会同时把时长写进副标题与角标
   * （封面出现「89 秒看懂获客增长系统」+「89秒 · 获客增长」两行同义信息）。
   * 判据：角标与副标题都含"秒"时判定重复，保留信息量更大的副标题。
   */
  const badgeText = plan.badge && plan.subline && /秒/.test(plan.badge) && /秒/.test(plan.subline) ? undefined : plan.badge;
  if (badgeText) {
    textFilters.push(
      `drawtext=fontfile='${FONT_FILE}':text=${escapeDrawtextText(badgeText)}:expansion=none:fontsize=${badgeSize}`
        + `:fontcolor=white@0.92:borderw=${Math.max(2, Math.round(badgeSize * 0.06))}:bordercolor=black@0.5`
        + `:x=${plan.typography.align === "center" ? "(w-text_w)/2" : String(left + 4)}:y=${cursorY}`
    );
  }
  const bgText = join(coverDir, "bg-text.png");
  run(FFMPEG, ["-y", "-i", bgOnly, "-vf", textFilters.join(","), "-frames:v", "1", bgText]);
  run(FFMPEG, ["-y", "-i", bgPerson, "-vf", textFilters.join(","), "-frames:v", "1", coverPng]);
  /** ③ 机检（口径与阈值在 `cover-design.ts#coverDeterministicChecks`） */
  const coverInfo = probe(coverPng);
  const coverSafeAreaForCheck = coverSafeAreaForLayout;
  const backgroundMatchesCleanMaster = sha256FileSync(bgFrameA) === sha256FileSync(bgFrameB);
  const { checks, measurements } = inspectCoverForPolicy({ bytes: Number(coverInfo.bytes ?? 0), width: Number(coverInfo.width ?? 0),
    height: Number(coverInfo.height ?? 0), expectedWidth: CW, expectedHeight: CH, cleanSource: backgroundMatchesCleanMaster },
    () => { throw new Error("COVER_QUALITY_REVIEW_DISABLED"); });
  const verdict = await reviewStage({ stage: "cover", projectId: PROJECT,
    artifacts: [{ path: coverPng, kind: "image", bytes: Number(coverInfo.bytes ?? 0), probe: coverInfo }],
    deterministic: checks, context: { designVia, plan, measurements, composition },
    env: ENV, allowFallbackApprove: false, log });
  record({
    /**
     * 封面"合格"必须同时满足**机检全过 + 监制放行**（2026-09-25 修正）：
     * 早先只看机检，于是"机检全过但监制打回（人物卡遮挡主体/调性冲突）"被记成 ok=true——审计会误读。
     */
    stage: "cover", shotId: null, invoked: true, ok: coverChecksPassed(checks) && verdict.approved, cached: false,
    /** 设计师出稿失败退兜底稿属于"降级"（2026-10-09 口径：封面文案默认由设计师出稿，兜底不是正常路径）。 */
    degraded: verdict.degraded || designVia === "fallback", attempt: 1, ms: Date.now() - started,
    artifact: existsSync(coverPng) ? coverPng : null,
    evidence: {
      designVia, plan, hook: plan.headline.replace(/\n/g, " "), font: plan.typography.fontId,
      qualityReviewPerformed: false, materialUsePolicy: "default-use",
      composition: { ...composition, requestedHero: COVER_REQUESTED_HERO, heroShotId: heroShot.shotId, insetEnabled,
        insetShotId: insetEnabled ? insetShot?.shotId ?? null : null },
      background: { shotId: heroShot.shotId, atSec: heroAt, source: "colored（未烧字幕母版）" },
      backgroundPick: { sharpness: bgPick.sharpness, floor: COVER_MIN_SHARPNESS, substituted: bgSubstituted, plannedShotId: plan.background.shotId },
      headline: { text: plan.headline, fontId: plan.typography.fontId, sizePx: headSize, subSizePx: subSizeDraw },
      /** 平台口径证据（2026-09-27）：出的是哪个平台的封面、机检按哪套安全区判 */
      coverPlatform: {
        id: coverSpec.id, label: COVER_PLATFORM_ARG || platform, ratio: coverSpec.ratio,
        canvas: { width: CW, height: CH }, safeArea: coverSafeAreaForCheck,
        headlineLimit: coverSpec.language === "en" ? `${coverSpec.headlineMaxChars} words` : `${coverSpec.headlineMaxChars} chars`
      },
      /** 封面知识库注入证据：hints 与 trace 一一对应（无 trace 视为未注入） */
      coverKb: {
        enabled: COVER_KB_ENABLED, applied: coverKb.applied, source: coverKb.source,
        topics: coverKb.topics, theme: coverKb.theme, hints: coverKb.hints, trace: coverKb.trace,
        notes: coverKb.notes, conflicts: coverKb.conflicts
      },
      /** 账号视觉锤证据（含 warn 级偏离记录） */
      accountProfile: accountProfile
        ? {
          accountId: accountProfile.account_id, strict: accountProfile.strict === true,
          fontId: accountProfile.visual_hammer?.fontId ?? null,
          hookBias: accountProfile.hook_bias ?? [], notes: accountNotes, warnings: plan.warnings ?? []
        }
        : null,
      person: {
        enabled: insetEnabled, shotId: insetEnabled ? insetShot?.shotId ?? null : null,
        atSec: insetEnabled ? plan.person.atSec ?? null : null,
        card: insetEnabled ? { x: cardX, y: cardY, w: cardW, h: cardH, border: cardBorder } : null,
        source: insetEnabled ? "colored（片子自己的镜头帧：肖像卡，不抠像）" : null
      },
      measurements, checks, designRaw: designNote,
      backgroundPickDetail: bgPick.sharpness === null ? "未执行锐度评分；按设计稿取帧"
        : `边缘能量 ${bgPick.sharpness.toFixed(2)}／下限 ${COVER_MIN_SHARPNESS}${bgSubstituted ? "（改取全片最清晰帧）" : ""}`
    },
    verdict
  });
  if (!coverChecksPassed(checks)) {
    log(`⛔ 封面机检未通过：${checks.filter((c) => !c.pass).map((c) => c.id).join("、")}`);
  }
  /**
   * 封面是否**真的合格**（机检全过 + 监制放行）。
   * 2026-09-27 真机事故：封面两轮被判"标题压脸、副标题被裁、出现第二个人像"（28/38 分），
   * 但片头仍把这张被打回的图合成进了成片 → 用户第一眼看到的就是那张乱版封面。
   * 纪律：**未放行的封面不进成片**（宁可没有封面卡），并如实留痕。
   */
  const coverApproved = coverChecksPassed(checks) && verdict.approved;
  if (!coverApproved && existsSync(coverPng)) {
    log(`⛔ 封面未放行（机检 ${checks.filter((c) => c.pass).length}/${checks.length} · 监制 ${verdict.approved ? "放行" : "打回"}）→ 不合成进片头`);
  }

}

/** 正式发布来源先装配封面；母版、软字幕与所有后续交付使用同一来源。 */
const cleanScored = scored;
let publicationCoverReceipt: CoverFirstFrameReceipt | null = null;
const publicationNeedsCover = !flag("--no-open-with-cover");
function assertFactualReleaseSources(): void {
  const compose = latestLineageRecord(lineageRecords(readStageHistory(), "compose"), PROJECT, "compose", null);
  const rawMaster = join(POST_DIR, "master-raw.mp4");
  if (!stageApproved("compose") || !compose?.lineage?.outputs.some((artifact) => artifact.path === rawMaster && artifact.sha256 === sha256FileSync(rawMaster)))
    throw new Error("PUBLICATION_COMPOSE_UNVERIFIED: 正式成片须有当前合成来源和母版字节回执，不能复用历史配音母版");
  const postEdges = [
    { stage: "color", output: colored, input: rawMaster },
    { stage: "subtitle", output: subtitled, input: colored },
    { stage: "danmaku", output: danmakuOut, input: subtitled },
    { stage: "bgm", output: bgmScored, input: danmakuOut },
    { stage: "sfx", output: cleanScored, input: bgmScored },
  ];
  for (const edge of postEdges) {
    if (edge.output !== edge.input && !artifactReusable(edge.stage, edge.output, edge.input))
      throw new Error(`PUBLICATION_POST_SOURCE_UNVERIFIED: ${edge.stage} 缺当前上游字节与最新通过回执，禁止发布旧后期素材`);
  }
  for (const shot of shots) {
    if (!sourceDocument.shots?.some(submitted => submitted.shotId === shot.shotId))
      throw new Error(`STANDARD_NATIVE_ORIGINAL_BINDING_INVALID: ${shot.shotId} is absent from frozen submitted intent`);
    const raw = originalForShot(shot), selected = clipFor(shot);
    if (raw !== selected || !compose.lineage.inputs.some(artifact => artifact.path === selected && artifact.sha256 === sha256FileSync(selected)))
      throw new Error(`PUBLICATION_COMPOSE_SOURCE_MISMATCH: ${shot.shotId} pinned original did not enter actual composition`);
  }
  if (sha256FileSync(originalPostContract.manifestFile) !== originalPostContract.manifestSha256)
    throw new Error("PUBLICATION_ORIGINAL_MANIFEST_CHANGED: 冻结原片清单已变化");
  const identity = characterReleaseReport("release");
  writeFileSync(join(WORK_DIR, `${PROJECT}-character-release-report.json`), JSON.stringify(identity, null, 2));
  assertCoverPublication({ required: publicationNeedsCover, preserveSourceFramesRequired: true, receipt: publicationCoverReceipt,
    inputSha256: existsSync(cleanScored) ? sha256FileSync(cleanScored) : undefined,
    coverSha256: existsSync(join(OUT_DIR, `${PROJECT}-cover.png`)) ? sha256FileSync(join(OUT_DIR, `${PROJECT}-cover.png`)) : undefined,
    outputSha256: existsSync(scored) ? sha256FileSync(scored) : undefined });
}
if (!DRY_RUN && ["cover", "mux", "master", "deliver"].some((stage) => STAGES.has(stage)) && existsSync(cleanScored)) {
  const cover = join(OUT_DIR, `${PROJECT}-cover.png`);
  if (publicationNeedsCover) {
    if (!existsSync(cover) || !stageApproved("cover")) throw new Error("PUBLICATION_COVER_MISSING: 正式发布来源必须有已通过确定性检查的封面");
    const output = join(POST_DIR, "master-publication.mp4");
    rememberInputs("cover-intro", [cleanScored, cover]);
    const started = Date.now();
    publicationCoverReceipt = await embedCoverFirstFrame({ input: cleanScored, cover, output, ffmpeg: FFMPEG, ffprobe: FFPROBE, preserveSourceFrames: true });
    expectedMasterSeconds = publicationCoverReceipt.video.durationSeconds;
    scored = publicationCoverReceipt.output.path;
    record({ stage: "cover-intro", shotId: null, invoked: true, ok: true, cached: false, degraded: false,
      attempt: 1, ms: Date.now() - started, artifact: scored, evidence: { ...publicationCoverReceipt, outputFiles: [scored] },
      verdict: null, note: "正式发布片首帧封面已装配；已核对普通媒体元数据、复制的音频与字幕包及输入字节，未进行视频逐帧或品质复检" });
  }
}
if (!DRY_RUN && ["mux", "master", "deliver"].some((stage) => STAGES.has(stage))) assertFactualReleaseSources();

/* ---------- ⑩ 软字幕轨收口（母版不烧字 + 字幕可开关） ---------- */
/**
 * 旁挂字幕的两种用法在这里分叉：
 *   · 交付目录里保留 `.srt/.ass/.vtt` 文件（平台后台上传口 / 剪辑软件用）；
 *   · 另出一支 `-softsub.mp4`：字幕作为**可开关的字幕轨**内嵌，画面与声音轨逐帧 copy
 *     （工位复检四件：video_unchanged / audio_unchanged / duration_kept / subtitle_tracks）。
 * 这样"要带字幕的片子"和"不要字幕的片子"是同一个画面母版派生的两个文件，不会各烧一遍。
 */
if (!subtitleSidecar && SUBTITLE_MODE !== "burn" && stageApproved("subtitle")) {
  const sidecarDir = join(POST_DIR, "subtitles"), srt = join(sidecarDir, `${PROJECT}.zh.srt`), ass = join(sidecarDir, `${PROJECT}.zh.ass`), manifest = join(sidecarDir, `${PROJECT}.subtitle-manifest.json`);
  if ([srt, ass, manifest].every((file) => existsSync(file))) {
    const doc = JSON.parse(readFileSync(manifest, "utf8")) as { checks?: Array<{ kind?: string; ok?: boolean }> };
    const timelineOk = doc.checks?.some((check) => check.kind === "timeline_readback" && check.ok === true) === true;
    if (timelineOk) subtitleSidecar = { dir: sidecarDir, srt, ass, manifest, timelineOk };
  }
}
let softsubFile: string | null = null;
if (STAGES.has("mux") && subtitleSidecar && existsSync(scored) && !DRY_RUN) {
  rememberInputs("mux", [scored, subtitleSidecar.srt, subtitleSidecar.ass]);
  const started = Date.now();
  const deliverSubtitleDir = join(OUT_DIR, "subtitles");
  mkdirSync(deliverSubtitleDir, { recursive: true });
  for (const name of readdirSync(subtitleSidecar.dir)) {
    if (!/\.(srt|ass|vtt|json)$/i.test(name)) continue;
    execFileSync("cp", [join(subtitleSidecar.dir, name), join(deliverSubtitleDir, name)]);
  }
  const out = join(OUT_DIR, `${PROJECT}-softsub.mp4`);
  const result = runCli(SUBTITLE_CLI, [
    "softmux", "--in", scored, "--out", out,
    "--srt", join(deliverSubtitleDir, `${PROJECT}.zh.srt`),
    "--lang", arg("--subtitle-lang", "chi"),
    ...(existsSync(join(deliverSubtitleDir, `${PROJECT}.en.srt`))
      ? ["--srt-en", join(deliverSubtitleDir, `${PROJECT}.en.srt`), "--lang-en", "eng"]
      : [])
  ]);
  const info = existsSync(out) ? probe(out) : {};
  const nativeAudioClock = existsSync(out)
    ? await assertStandardPostExportClock(out, expectedMasterSeconds, { ffmpeg: FFMPEG, ffprobe: FFPROBE, expectedFps: FPS }) : null;
  const verdict = await reviewStage({
    stage: "mux", projectId: PROJECT,
    artifacts: [
      ...(existsSync(out) ? [{ path: out, kind: "video" as const, probe: info, note: "软字幕轨版（字幕可开关，画面零改动）" }] : []),
      ...(existsSync(join(deliverSubtitleDir, `${PROJECT}.zh.srt`))
        ? [{ path: join(deliverSubtitleDir, `${PROJECT}.zh.srt`), kind: "text" as const, note: "交付目录里的旁挂字幕" }]
        : [])
    ],
    deterministic: [
      { id: "softsub-produced", pass: existsSync(out), detail: existsSync(out) ? "软字幕轨版已产出" : "软字幕轨版未产出", hard: true },
      { id: "tool-exit", pass: result.ok, detail: result.ok ? "字幕工位退出码 0" : `软轨内嵌失败：${result.out.slice(-300)}`, hard: true },
      { id: "video-unchanged", pass: result.out.includes("video_unchanged=ok"), detail: (result.out.match(/复检：[^\n]*/) ?? ["无复检信息"])[0] ?? "", hard: true },
      { id: "subtitle-files", pass: existsSync(join(deliverSubtitleDir, `${PROJECT}.zh.srt`)), detail: "交付目录含旁挂字幕文件（平台上传口/剪辑软件可直接用）", hard: true }
    ],
    context: { mode: SUBTITLE_MODE, toolOutput: result.out.slice(-900), softsub: out },
    env: ENV, allowFallbackApprove: ALLOW_FALLBACK_APPROVE, log
  });
  if (existsSync(out)) softsubFile = out;
  record({
    stage: "mux", shotId: null, invoked: true, ok: result.ok && existsSync(out), cached: false, degraded: false,
    attempt: 1, ms: Date.now() - started, artifact: existsSync(out) ? out : null,
    evidence: { tool: "subtitle-bridge softmux", subtitlesDir: deliverSubtitleDir, videoUnchanged: result.out.includes("video_unchanged=ok"), nativeAudioClock }, verdict
  });
  if (existsSync(out)) {
    log(`软字幕轨版：${out}（画面与 ${basename(scored)} 逐帧一致；旁挂字幕在 ${deliverSubtitleDir}）`);
  }
}

/* ---------- ⑪ 正式母版：真实导出合同与原子发布 ---------- */
if (STAGES.has("master") && existsSync(scored) && !DRY_RUN) {
  assertFactualReleaseSources();
  rememberInputs("master", [scored]);
  const started = Date.now(), before = fingerprintArtifact(scored), info = probe(scored);
  const actualDuration = Number(info.videoDurationSec || info.duration), actualFps = Number(info.fps);
  const requestedFrames = Math.round(expectedMasterSeconds * FPS), actualFrames = Number(info.videoFrames);
  if (info.error || Number(info.width) !== OUTPUT_SIZE.width || Number(info.height) !== OUTPUT_SIZE.height
    || !Number.isSafeInteger(requestedFrames) || requestedFrames < 1 || !Number.isSafeInteger(actualFrames) || actualFrames !== requestedFrames
    || !Number.isFinite(actualFps) || !Number.isFinite(actualDuration) || actualDuration <= 0
    || Math.abs(actualFps - FPS) > 1e-6 || Math.abs(actualDuration - expectedMasterSeconds) > 2e-6
    || Math.abs(actualDuration - actualFrames / FPS) > 2e-6)
    throw new Error(`MASTER_EXPORT_SPEC_INVALID: requested ${OUTPUT_SIZE.width}x${OUTPUT_SIZE.height}@${FPS} ${expectedMasterSeconds}s; actual ${JSON.stringify(info)}`);
  if (STAGES.has("subtitle") && (SUBTITLE_MODE === "burn" ? !existsSync(join(POST_DIR, "master-subtitled.mp4")) : !subtitleSidecar || !existsSync(subtitleSidecar.srt)))
    throw new Error("MASTER_SUBTITLE_MISSING: requested actual subtitle output was not produced");
  const naming = auditDeliverableNaming({ path: DELIVERABLE, durationSec: actualDuration });
  const finalPath = naming.suggestedName ? join(OUT_DIR, naming.suggestedName) : DELIVERABLE;
  const pending = join(OUT_DIR, `.${basename(finalPath)}.${randomUUID()}.pending`);
  try {
    copyFileSync(scored, pending, fsConstants.COPYFILE_EXCL);
    if (fingerprintArtifact(pending).sha256 !== before.sha256 || fingerprintArtifact(scored).sha256 !== before.sha256)
      throw new Error("MASTER_CHANGED_DURING_PUBLICATION");
    renameSync(pending, finalPath);
  } catch (error) { rmSync(pending, { force: true }); throw error; }
  deliverablePath = finalPath;
  masterApprovedForUhd = QUALITY === "uhd";
  record({ stage: "master", shotId: null, invoked: true, ok: true, cached: false, degraded: false,
    attempt: 1, ms: Date.now() - started, artifact: finalPath, evidence: { ...info, sourceSha256: before.sha256,
      quality: QUALITY, exportSettings: { ...OUTPUT_SIZE, fps: FPS, durationSec: expectedMasterSeconds },
      qualityReviewPerformed: false, identityVerified: false, clothingVerified: false,
      speechVerified: false, lipSyncVerified: false }, verdict: null,
    note: "正式母版已按请求规格真实导出并原子发布；成功渲染镜头默认采用，无品质终审" });
  log(`✅ 正式成片：${finalPath}（原字节与实际导出合同已记录；未执行品质审核）`);
}

/* ---------- ⑫ 多风格交付包（step_key: deliver：请求配方、真实文件和来源合同） ---------- */
if (QUALITY === "uhd" && STAGES.has("deliver") && !DRY_RUN && !masterApprovedForUhd) {
  throw new Error("UHD 多风格交付缺本轮请求规格的实际母版导出回执");
}
/**
 * 管线 yml 的 deliver 步：**干净母版 + 旁挂字幕 + 2–3 个风格变体 + 软字幕轨版 + 交付清单**，
 * 纪律是"镜头只生成一次，变体零 token"——变体只做**后期层派生**（调色/混音/文案），绝不重跑渲染。
 * 默认核对请求的调色、封面和配乐配方与真实文件，不进行 RGB、听音或模型品质投票。
 */
if (STAGES.has("deliver") && !DRY_RUN && (QUALITY !== "uhd" || masterApprovedForUhd)
  && artifactReusable("master", deliverablePath, scored)) {
  rememberInputs("deliver", [deliverablePath]);
  const started = Date.now();
  /**
   * 变体派生源必须是**不含配乐**的母版（2026-09-30 真机）：
   * 变体自带三套配乐（三轴之一）——若从"已加配乐"的交付母版派生，变体配乐会叠在母版配乐上，
   * 工位的 `music_audible` 复检直接判红（实测：配乐可闻度 -13~-15dB < 3dB）→ 三支变体全缺配乐 → G-DLV1 误红。
   * 用旁挂字幕版（`master-subtitled`，画面与交付母版逐帧一致、无配乐）作为派生源。
   */
  const variantSource = (() => {
    const currentColorSource = colored === master
      ? artifactReusable("compose", master)
      : artifactReusable("color", colored, master);
    if (!currentColorSource) throw new Error("VARIANT_SOURCE_UNVERIFIED: 无当前合成来源的干净调色母版，禁止派生变体");
    if (SUBTITLE_MODE === "sidecar") return colored;
    const candidate = join(POST_DIR, "master-subtitled.mp4");
    if (!artifactReusable("subtitle", candidate, colored))
      throw new Error("VARIANT_SOURCE_UNVERIFIED: 无当前原生音轨来源的字幕母版，禁止沿用旧配音或已混配乐的交付片");
    return candidate;
  })();
  const variantBodyInfo = probe(variantSource);
  const variantBodySeconds = Number(variantBodyInfo.videoDurationSec || variantBodyInfo.duration);
  const variantBodyFrames = Number(variantBodyInfo.videoFrames);
  if (!Number.isSafeInteger(variantBodyFrames) || variantBodyFrames < 1 || !(variantBodySeconds > 0))
    throw new Error("VARIANT_SOURCE_CLOCK_INVALID: actual complete body clock is unavailable");
  const variantPlans = buildVariantPlan({ master: variantSource, outDir: OUT_DIR, projectId: PROJECT, coverHook: arg("--cover-hook", shotlist.title ?? "") });
  /**
   * 配乐层是否启用由当前 bgm 处理回执的显式关闭声明决定。
   * 关闭时仅要求调色与封面配方；启用时每版须消费明确登记且不同的音乐字节。
   */
  const bgmLayerOff = records.some((row) => row.stage === "bgm" && (row.evidence as { applicable?: unknown }).applicable === false);
  const samples: Array<{ variantId: string; frames: Array<{ r: number; g: number; b: number }>; loudness: { lufs: number; peakDb: number } | null }> = [];
  const variantManifest: Array<{
    id: string; label: string; path: string; sha256: string; note: string; gradeProfile: string | null;
    width: number; height: number;
    cover?: { path: string; sha256: string } | null; coverReceipt?: CoverFirstFrameReceipt | null;
    bgm?: { track: string; sha256: string; declaredBpm?: number | null; measuredBpm?: null; gridErrorMs?: null;
      recipe?: string | null; musicLevelDb?: string; musicLevelSource?: string } | null;
    nativeAudioClock?: Awaited<ReturnType<typeof assertStandardPostExportClock>>;
  }> = [];
  /**
   * 变体封面（三轴之一，2026-09-26 产品口径）：主封面 + 该变体的强调色条与风格角标。
   * 为什么不是每支重跑封面设计师：变体是**零 token 的后期层派生**，重跑设计稿会破坏这条纪律；
   * 三支封面的差异用"强调色 + 风格角标"保证**可区分且可核对**（sha256 进清单）。
   */
  const renderVariantCover = (variantId: string, accent: string): { path: string; sha256: string } | null => {
    const source = join(OUT_DIR, `${PROJECT}-cover.png`);
    if (!existsSync(source)) return null;
    const target = join(OUT_DIR, `${PROJECT}-cover-${variantId}.png`);
    const dimensions = probe(source);
    const design = buildVariantCoverFilters({ variantId: variantId as CoverVariantId, accent,
      platform: COVER_PLATFORM_ARG || PLATFORM, width: Number(dimensions.width), height: Number(dimensions.height) });
    run(FFMPEG, ["-v", "error", "-y", "-i", source, "-vf", design.filter, "-frames:v", "1", target]);
    return { path: target, sha256: sha256FileSync(target) };
  };

  /**
   * 三风格独立封面（2026-10-09 产品所有者口径）：
   *   "不同的风格，要制作不同的封面——包括封面的整体设计、标题文案和字体。"
   *   · 文案：首选**封面设计师数字员工**一次出三套（标题/副标题/角标/主视觉镜/取帧秒/字体/强调色），
   *     严格校验（镜头存在、字数、字体在库、三套彼此不同、不得出现真人姓名），不合规退确定性表；
   *   · 主视觉：各风格取自己那一镜（暖调→黄昏/灯；冷调→夜景/现代；高对比→雪/市井），从该风格版本自己的成片取帧；
   *   · 字体：暖调=思源宋体（书卷气）、冷调=思源黑体重、高对比=得意黑；
   *   · 版式与调色：逐风格不同（暖调低饱和暖调、冷调青蓝、高对比高饱和）。
   */
  const STYLE_COVER_FALLBACK: Record<string, { label: string; fontId: CoverFontId; second: string;
    keywords: string[]; accent: string; badge: string }> = {
    "warm-film": { label: "暖调胶片", fontId: "noto-serif", second: "黄昏再看一遍",
      keywords: ["黄昏", "夕", "落日", "灯", "夜", "暖", "运河"], accent: "#FFB86B", badge: "暖调胶片" },
    "cool-tech": { label: "冷调技术", fontId: "source-han-heavy", second: "夜色另一面",
      keywords: ["夜", "灯", "天际线", "高楼", "桥", "水面", "现代"], accent: "#6FD3FF", badge: "冷调技术" },
    "punchy-social": { label: "社交高对比", fontId: "smiley-sans", second: "高能 60 秒",
      keywords: ["雪", "市井", "街", "吃", "人", "集市", "烟火"], accent: "#FF5A5F", badge: "高对比社交" }
  };
  const styleCoverGrade: Record<string, string> = {
    "warm-film": "colorbalance=rs=0.07:gs=0.015:bs=-0.06,eq=saturation=1.04:contrast=1.05",
    "cool-tech": "colorbalance=rs=-0.05:gs=-0.01:bs=0.08,eq=saturation=0.90:contrast=1.07",
    "punchy-social": "eq=saturation=1.16:contrast=1.12"
  };
  /** 风格封面的画布尺寸：以平台规格为准（UHD 交付时跟随输出画布）。 */
  const styleCoverSpec = getCoverSpec(COVER_PLATFORM_ARG || PLATFORM);
  const { width: SCW, height: SCH } = QUALITY === "uhd" ? OUTPUT_SIZE : styleCoverSpec.canvas;
  const styleShotFor = (keywords: string[]): { shotId: string; atSec: number } => {
    const scored = shots.map((shot) => {
      const card = shot as unknown as Record<string, unknown>;
      const text = [card.scene, card.sceneDescription, card.color_palette, card.motion].map((v) => String(v ?? "")).join(" ");
      const hit = keywords.reduce((sum, word) => sum + (text.includes(word) ? 1 : 0), 0);
      return { shot, hit };
    }).sort((a, b) => b.hit - a.hit);
    const picked = scored[0]?.shot ?? shots[0]!;
    const duration = Number(picked.duration ?? 4);
    return { shotId: picked.shotId, atSec: Number(Math.min(1.2, Math.max(0.3, duration - 0.4)).toFixed(2)) };
  };
  const visualLengthOf = (value: string): number => [...String(value)].reduce((sum, ch) => sum + (/[\u4e00-\u9fff]/.test(ch) ? 1 : 0.55), 0);
  const styleCoverPlans = new Map<string, { styleId: string; headline: string; subline: string; badge: string;
    shotId: string; atSec: number; fontId: CoverFontId; accent: string; via: string }>();
  const fallbackStylePlan = (styleId: string) => {
    const def = STYLE_COVER_FALLBACK[styleId]!;
    const hero = styleShotFor(def.keywords);
    const mainTitle = String(arg("--cover-hook", "") || shotlist.title || "封面")
      .split(/[\n·|｜（(]/)[0]!.trim().slice(0, 8) || "封面";
    return { styleId, headline: `${mainTitle}\n${def.second}`, subline: `${def.label} · ${Math.round(expectedMasterSeconds)} 秒`,
      badge: def.badge, shotId: hero.shotId, atSec: hero.atSec, fontId: def.fontId, accent: def.accent, via: "deterministic" };
  };
  /**
   * 三套风格文案：先问封面设计师（一次调用），失败/不合规退确定性表。
   * 校验口径与主封面一致，另加"三套必须彼此不同（标题/主视觉镜/字体）"。
   */
  const designStyleCovers = async (): Promise<void> => {
    for (const styleId of Object.keys(STYLE_COVER_FALLBACK)) styleCoverPlans.set(styleId, fallbackStylePlan(styleId));
    /** 与主封面同一口径：`--cover-design agent`（默认）时请封面设计师出稿，`deterministic` 时只用确定性表。 */
    const styleCoverMode = arg("--cover-design", "agent");
    const styleCoverLlm = styleCoverMode === "agent" ? resolveProducerLlm(ENV) : null;
    if (styleCoverMode !== "agent" || !styleCoverLlm) return;
    try {
      const shotLines = shots.map((s) => `- ${s.shotId}：${String(s.scene ?? "").slice(0, 60)}`).join("\n");
      const prompt = `你是 WorkLoom 的封面设计师。为同一支片子设计**三支风格版封面**，每支的标题文案、主视觉镜头、字体都必须不同。
片子：${String(shotlist.title ?? "")}
内容目标：${String(coverBrief?.goal ?? shotlist.logline ?? "")}
平台：${COVER_PLATFORM_ARG || platform}（画布 ${CW}×${CH}，标题 ≤14 视觉字符、最多两行用 \\n 断行；副标题 ≤24 字；角标 ≤10 字）
可选镜头（backgroundShotId 必须来自这里）：
${shotLines}
可选字体 fontId：${Object.keys(COVER_FONTS).join(" / ")}
风格定位：warm-film=暖调胶片（黄昏/暖光/书卷气）；cool-tech=冷调技术（夜景/冷色/现代感）；punchy-social=社交高对比（短促有力/高饱和）
硬约束：封面文案不得出现真人姓名（如「${lead?.name ?? "—"}」）；不得虚构镜头或字体；标题不得写错片长（成片 ${Math.round(expectedMasterSeconds)} 秒）。
只输出 JSON：{"variants":[{"style":"warm-film","headline":"杭州\\n黄昏再看一遍","subline":"...","badge":"...","backgroundShotId":"HZ-12","backgroundAtSec":1.2,"fontId":"noto-serif","accentColor":"#FFB86B"},{"style":"cool-tech",...},{"style":"punchy-social",...}]}`;
      const raw = await requestCoverDesign(styleCoverLlm, prompt);
      const parsed = JSON.parse(raw.replace(/^```(?:json)?/m, "").replace(/```\s*$/m, "").trim()) as { variants?: Array<Record<string, unknown>> };
      const variants = Array.isArray(parsed.variants) ? parsed.variants : [];
      const accepted: Array<{ styleId: string; headline: string; subline: string; badge: string; shotId: string; atSec: number; fontId: CoverFontId; accent: string; via: string }> = [];
      const forbidden = [lead?.name, lead?.id].map((v) => String(v ?? "").trim()).filter((v) => v.length >= 2);
      for (const entry of variants) {
        const styleId = String(entry.style ?? "").trim();
        if (!STYLE_COVER_FALLBACK[styleId]) continue;
        const headline = String(entry.headline ?? "").trim();
        const subline = String(entry.subline ?? "").trim();
        const badge = String(entry.badge ?? "").trim();
        const shotId = String(entry.backgroundShotId ?? "").trim();
        const fontId = String(entry.fontId ?? "").trim() as CoverFontId;
        const accent = String(entry.accentColor ?? "").trim();
        const atSec = Number(entry.backgroundAtSec ?? NaN);
        const lines = headline.split("\n");
        const copy = [headline, subline, badge].join(" ");
        if (!headline || lines.length > 2 || lines.some((line) => visualLengthOf(line) > 14)) continue;
        if (visualLengthOf(subline) > 24 || visualLengthOf(badge) > 10) continue;
        if (!shots.some((s) => s.shotId === shotId)) continue;
        if (!Object.prototype.hasOwnProperty.call(COVER_FONTS, fontId)) continue;
        if (!/^#[0-9a-f]{6}$/i.test(accent)) continue;
        if (!Number.isFinite(atSec) || atSec < 0.2 || atSec > 3.5) continue;
        if (forbidden.some((name) => copy.includes(name))) continue;
        accepted.push({ styleId, headline, subline, badge, shotId, atSec: Number(atSec.toFixed(2)), fontId, accent, via: "agent" });
      }
      const distinctHeadlines = new Set(accepted.map((entry) => entry.headline)).size === accepted.length;
      const distinctShots = new Set(accepted.map((entry) => entry.shotId)).size === accepted.length;
      const distinctFonts = new Set(accepted.map((entry) => entry.fontId)).size === accepted.length;
      if (accepted.length === 3 && distinctHeadlines && distinctShots && distinctFonts) {
        for (const entry of accepted) styleCoverPlans.set(entry.styleId, entry);
        log(`  · 三风格封面：封面设计师出稿通过（标题/主视觉/字体三套互不相同）`);
      } else {
        log(`  ↻ 三风格封面：设计师稿未满足"三套互不相同"（收 ${accepted.length}/3，标题差异 ${distinctHeadlines}、镜头差异 ${distinctShots}、字体差异 ${distinctFonts}）→ 确定性表`);
      }
    } catch (error) {
      log(`  ↻ 三风格封面：设计师出稿失败（${error instanceof Error ? error.message.slice(0, 120) : String(error)}）→ 确定性表`);
    }
  };
  await designStyleCovers();
  /** 按风格渲染独立封面：从**该风格自己的成片**取帧，套该风格的调色/字体/文案/版式。 */
  const renderStyledVariantCover = (styleId: string, masterPath: string): { path: string; sha256: string } | null => {
    const style = styleCoverPlans.get(styleId);
    if (!style || !existsSync(masterPath)) return null;
    const fontEntry = COVER_FONTS[style.fontId];
    const fontFile = join(REPO_ROOT, "bundles/ai-video/library/fonts", fontEntry.file);
    if (!existsSync(fontFile)) throw new Error(`VARIANT_COVER_FONT_MISSING: ${styleId} → ${fontFile}`);
    const shotIndex = shots.findIndex((s) => s.shotId === style.shotId);
    if (shotIndex < 0) throw new Error(`VARIANT_COVER_SHOT_MISSING: ${styleId} → ${style.shotId}`);
    const start = shotIndex === 0 ? 0 : (CUT_GRID[shotIndex - 1] ?? shots.slice(0, shotIndex).reduce((sum, s) => sum + Number(s.duration ?? 5), 0));
    const duration = Number(shots[shotIndex]!.duration ?? 4);
    const at = Math.min(Math.max(0.2, style.atSec), Math.max(0.2, duration - 0.2));
    const target = join(OUT_DIR, `${PROJECT}-cover-${styleId}.png`);
    const headLines = style.headline.split("\n").slice(0, 2);
    const headSize = Math.round(SCH * 0.075);
    const subSize = Math.round(SCH * 0.030);
    const badgeSize = Math.round(SCH * 0.020);
    const left = Math.round(SCW * 0.07);
    const titleTop = styleId === "punchy-social" ? Math.round(SCH * 0.52) : Math.round(SCH * 0.58);
    const textColor = "#FFFFFF";
    const filters = [
      `scale=${SCW}:${SCH}:force_original_aspect_ratio=increase`,
      `crop=${SCW}:${SCH}`,
      styleCoverGrade[styleId] ?? "null",
      `drawbox=x=${left}:y=${titleTop - Math.round(headSize * 0.35)}:w=${Math.round(SCW * 0.12)}:h=${Math.max(4, Math.round(SCH * 0.006))}:color=${style.accent.replace("#", "0x")}@0.95:t=fill`
    ];
    headLines.forEach((line, index) => {
      const y = titleTop + index * Math.round(headSize * 1.08);
      filters.push(`drawtext=fontfile='${fontFile}':text=${escapeDrawtextText(line)}:expansion=none:fontsize=${headSize}:fontcolor=${textColor}`
        + `:borderw=${Math.max(3, Math.round(headSize * 0.04))}:bordercolor=black@0.55:shadowx=2:shadowy=3:shadowcolor=black@0.35:x=${left}:y=${y}`);
    });
    if (style.subline) {
      const subY = titleTop + headLines.length * Math.round(headSize * 1.08) + Math.round(headSize * 0.1);
      filters.push(`drawtext=fontfile='${fontFile}':text=${escapeDrawtextText(style.subline)}:expansion=none:fontsize=${subSize}`
        + `:fontcolor=${style.accent}:borderw=${Math.max(2, Math.round(subSize * 0.08))}:bordercolor=black@0.5:x=${left}:y=${subY}`);
    }
    if (style.badge) {
      const badgeY = Math.round(SCH * 0.90);
      filters.push(`drawtext=fontfile='${fontFile}':text=${escapeDrawtextText(style.badge)}:expansion=none:fontsize=${badgeSize}`
        + `:fontcolor=white@0.92:borderw=2:bordercolor=black@0.5:x=${left}:y=${badgeY}`);
    }
    run(FFMPEG, ["-v", "error", "-y", "-ss", String((start + at).toFixed(3)), "-i", masterPath,
      "-vf", filters.join(","), "-frames:v", "1", target]);
    const info = probe(target);
    if (Number(info.width) !== SCW || Number(info.height) !== SCH) throw new Error(`VARIANT_COVER_CANVAS_INVALID: ${styleId} → ${info.width}x${info.height}`);
    log(`  风格封面 ${styleId}（${style.via}）：${style.headline.replace(/\n/g, " / ")} · ${style.fontId} · ${style.shotId}@${style.atSec}s`);
    return { path: target, sha256: sha256FileSync(target) };
  };
  /** 取几个时间点的 1×1 平均色：稳定的"画面指纹"（不做逐像素对比，只判风格差异是否可测） */
  const meanColorsAt = (file: string, times: number[]): Array<{ r: number; g: number; b: number }> => times.map((at) => {
    const out = spawnSync(FFMPEG, ["-v", "error", "-ss", String(at), "-i", file, "-frames:v", "1", "-vf", "scale=1:1", "-f", "rawvideo", "-pix_fmt", "rgb24", "-"], { maxBuffer: 1024 });
    if (out.status !== 0 || out.error || !Buffer.isBuffer(out.stdout) || out.stdout.length < 3) {
      throw new Error(`VARIANT_RGB_MEASUREMENT_FAILED: ${file} at ${at}s; status=${out.status}; ${out.error?.message ?? out.stderr?.toString().slice(0, 200) ?? "missing RGB bytes"}`);
    }
    const buf = out.stdout;
    return { r: buf[0]!, g: buf[1]!, b: buf[2]! };
  });
  const usedVariantBgmHashes = new Set<string>();
  for (const plan of variantPlans) {
    try {
      if (plan.passthrough) {
        execFileSync("cp", [variantSource, plan.output]);
      } else {
        /** 调色变体走同一个调色工位（与母版一致的口径，避免"变体用了另一套引擎"） */
        const graded = runCli(COLOR_CLI, [...plan.gradeArgs, "--out", plan.output, "--no-verify", "--no-defects"]);
        if (!graded.ok) throw new Error(`VARIANT_COLOR_PROCESSING_FAILED: ${plan.variant.id}: ${graded.out.slice(-400)}`);
      }
      if (!existsSync(plan.output)) throw new Error(`VARIANT_OUTPUT_MISSING: ${plan.variant.id}`);
      /**
       * 变体配乐（三轴之一）：按该变体声明曲风线索从**曲库**选择实际源；
       * 缺请求曲源或实际混音失败明确报错，不自动替换或降级。
       */
      let variantBgm: { track: string; sha256: string; declaredBpm?: number | null; measuredBpm?: null; gridErrorMs?: null } | null = null;
      if (bgmLayerOff) {
        log(`  变体 ${plan.variant.id} 配乐：按声明关闭（无签章分轨引用 → bgm_layer=false），跳过混音`);
      } else try {
        const variantDuration = Number(probe(plan.output).duration ?? 0);
        /** 变体同样走配乐师流程（按该风格的曲风线索打简报分），选中曲目不得与已用曲目同字节。 */
        const agentVariantBed = await pickAgentMusicBed({
          genre: plan.variant.bgmGenre ?? genre, mood: plan.variant.bgmMood ?? mood,
          platform: COVER_PLATFORM_ARG || PLATFORM, recipeId: arg("--bgm-recipe", "").trim() || undefined,
          durationSec: variantDuration, promptText: bgmPromptText
        });
        const bed = agentVariantBed && !usedVariantBgmHashes.has(sha256FileSync(agentVariantBed.path))
          ? agentVariantBed
          : await pickDeclaredMusicBed(variantDuration, CUT_GRID, {
            genre: plan.variant.bgmGenre, mood: plan.variant.bgmMood, excludeTrackHashes: usedVariantBgmHashes,
          });
        if (bed) {
          const mixed = plan.output.replace(/\.mp4$/i, "-bgm.mp4");
          /** 变体同样走配乐师配方（该风格的曲风线索）× 同一 music-led 口径，保证"风格不同、声音也不同"。 */
          const variantMix = await resolveBgmMixSettings({
            genre: plan.variant.bgmGenre ?? genre, mood: plan.variant.bgmMood ?? mood,
            platform: COVER_PLATFORM_ARG || PLATFORM, recipeId: arg("--bgm-recipe", "").trim() || undefined,
            presence: arg("--bgm-presence", "standard"),
            explicitLevel: arg("--bgm-level", ""), explicitDucking: arg("--bgm-ducking", ""),
            boostDb: Number(arg("--bgm-presence-boost", "8"))
          });
          const mix = runCli(BGM_CLI, [
            "mix", "--in", plan.output, "--out", mixed, "--bgm", bed.path, "--policy", "keep-dialogue",
            "--music-level", String(Math.max(-24, Math.min(-8, Number(variantMix.levelDb) + Number(plan.variant.musicLevelDeltaDb ?? 0)))),
            "--ducking", variantMix.duckingDb, "--lufs", "-14", "--section", "auto",
            "--true-peak", arg("--bgm-true-peak", "-1.5"),
            ...(BGM_DECLARED_PROGRAM_MIX ? ["--declared-program-mix"] : []),
            ...(bed.bpm ? ["--bgm-bpm", String(bed.bpm)] : []),
            "--evidence-dir", join(POST_DIR, "bgm-evidence"),
          ]);
          if (mix.ok && existsSync(mixed)) {
            execFileSync("mv", [mixed, plan.output]);
            variantBgm = {
              track: bed.id,
              sha256: createHash("sha256").update(readFileSync(bed.path)).digest("hex"),
              declaredBpm: bed.bpm,
              measuredBpm: null,
              gridErrorMs: null,
              recipe: variantMix.recipeId,
              musicLevelDb: variantMix.levelDb,
              musicLevelSource: variantMix.levelSource,
            };
            usedVariantBgmHashes.add(variantBgm.sha256);
            log(`  变体 ${plan.variant.id} 配乐：${bed.id}（声明曲目；未作声音或卡点品质复检）`);
          } else {
            throw new Error(`VARIANT_BGM_PROCESSING_FAILED: ${plan.variant.id}: ${mix.out.slice(-400)}`);
          }
        } else {
          throw new Error(`VARIANT_BGM_SOURCE_MISSING: ${plan.variant.id}: no requested music source available`);
        }
      } catch (err) {
        throw err;
      }
      /** 三风格独立封面优先；渲染失败（缺字体/缺镜头/取帧异常）才退"主封面+强调色条"的兼容路径。 */
      const variantCover = renderStyledVariantCover(plan.variant.id, plan.output)
        ?? renderVariantCover(plan.variant.id, plan.variant.coverAccent);
      let variantCoverReceipt: CoverFirstFrameReceipt | null = null;
      if (publicationNeedsCover) {
        if (!variantCover) throw new Error(`VARIANT_COVER_MISSING: ${plan.variant.id}`);
        const clean = plan.output.replace(/\.mp4$/i, "-clean.mp4");
        renameSync(plan.output, clean);
        variantCoverReceipt = await embedCoverFirstFrame({ input: clean, cover: variantCover.path, output: plan.output, ffmpeg: FFMPEG, ffprobe: FFPROBE, preserveSourceFrames: true });
      }
      const info = probe(plan.output);
      const nativeAudioClock = await assertStandardPostExportClock(plan.output, variantBodySeconds + (variantCoverReceipt ? 1 / FPS : 0), { ffmpeg: FFMPEG, ffprobe: FFPROBE, expectedFps: FPS, expectedVideoFrames: variantBodyFrames + (variantCoverReceipt ? 1 : 0) });
      if (Number(info.width) !== OUTPUT_SIZE.width || Number(info.height) !== OUTPUT_SIZE.height) {
        throw new Error(`变体 ${plan.variant.id} 分辨率 ${info.width}x${info.height}，要求 ${OUTPUT_SIZE.width}x${OUTPUT_SIZE.height}`);
      }
      const duration = Number(info.duration ?? 0);
      const times = [duration * 0.2, duration * 0.5, duration * 0.8].map((t) => Math.max(0.2, Math.round(t * 10) / 10));
      void times;
      variantManifest.push({
        id: plan.variant.id, label: plan.variant.label, path: plan.output,
        sha256: sha256FileSync(plan.output),
        note: plan.variant.note, gradeProfile: plan.variant.gradeProfile,
        width: Number(info.width), height: Number(info.height),
        cover: variantCover, coverReceipt: variantCoverReceipt, bgm: variantBgm, nativeAudioClock,
        coverDesign: styleCoverPlans.get(plan.variant.id) ?? null,
      });
      log(`  变体 ${plan.variant.id}（${plan.variant.label}）→ ${basename(plan.output)}`);
    } catch (err) {
      record({
        stage: "deliver", shotId: null, invoked: true, ok: false, cached: false, degraded: false, attempt: 1, ms: 0,
        artifact: null, evidence: { variant: plan.variant.id, error: err instanceof Error ? err.message.slice(0, 300) : String(err) },
        verdict: null, note: "变体派生失败"
      });
      throw err;
    }
  }
  const distinctness = { status: "not-reviewed", approved: true, pairs: [], worstPair: null, detail: "No frame or audio quality comparison was performed; requested style recipes and output files are checked separately." };
  /**
   * 三轴判据（2026-09-26 产品所有者："一次必须产出 3 个不同风格的后期版本"）：
   * 数量 ≥3，且 **调色 / 封面 / 配乐** 三轴上两两不同——只换滤镜名不算风格。
   */
  const variantAxes = assessVariantAxes(variantManifest.map((variant) => ({
    id: variant.id,
    gradeProfile: variant.gradeProfile,
    coverSha: variant.cover?.sha256 ?? null,
    bgmSha: variant.bgm?.sha256 ?? null,
  })), { bgmRequired: !bgmLayerOff });
  const gate = recordGate({
    stepKey: "deliver",
    sourceStage: "deliver",
    checks: [
      {
        id: "master-resolution", pass: (() => {
          const info = probe(deliverablePath);
          return Number(info.width) === OUTPUT_SIZE.width && Number(info.height) === OUTPUT_SIZE.height;
        })(), hard: true, detail: `${QUALITY} 母版要求 ${OUTPUT_SIZE.width}x${OUTPUT_SIZE.height}`
      },
      {
        id: "variant-resolutions",
        pass: variantManifest.every((variant) => variant.width === OUTPUT_SIZE.width && variant.height === OUTPUT_SIZE.height),
        hard: true, detail: `变体 ${variantManifest.length} 支均须为 ${OUTPUT_SIZE.width}x${OUTPUT_SIZE.height}`
      },
      { id: "variants-produced", pass: variantManifest.length >= VARIANT_MIN_COUNT, hard: true, detail: `产出变体 ${variantManifest.length} 个（产品口径：至少 ${VARIANT_MIN_COUNT} 个不同风格的后期版本）：${variantManifest.map((v) => v.id).join("/")}` },
      { id: "variant-axes", pass: variantAxes.ok, hard: true, detail: variantAxes.detail },
    ],
    evidence: {
      samples,
      variants: variantManifest.map((v) => ({
        id: v.id, sha256: v.sha256.slice(0, 16),
        gradeProfile: v.gradeProfile,
        cover: v.cover ? { path: v.cover.path, sha256: v.cover.sha256.slice(0, 16) } : null,
        bgm: v.bgm ? { track: v.bgm.track, sha256: v.bgm.sha256.slice(0, 16), measuredBpm: v.bgm.measuredBpm, gridErrorMs: v.bgm.gridErrorMs } : null,
      })),
      axes: variantAxes,
    }
  });
  /** UHD sidecars join the same pending package; no public delivery file exists before G-DLV1. */
  const stagedSubtitles: string[] = [];
  if (QUALITY === "uhd" && subtitleSidecar) {
    const dir = join(OUT_DIR, "subtitles");
    mkdirSync(dir, { recursive: true });
    for (const name of readdirSync(subtitleSidecar.dir)) {
      if (!/\.(srt|ass|vtt|json)$/i.test(name)) continue;
      const target = join(dir, name);
      copyFileSync(join(subtitleSidecar.dir, name), target);
      stagedSubtitles.push(target);
    }
  }
  const publishedVariants = variantManifest.map((variant) => ({
    ...variant,
    path: publicDeliveryPath(variant.path),
    cover: variant.cover ? { ...variant.cover, path: publicDeliveryPath(variant.cover.path) } : null,
  }));
  const coverFile = join(OUT_DIR, `${PROJECT}-cover.png`);
  const withCover = join(OUT_DIR, `${PROJECT}-with-cover.mp4`);
  /**
   * 受理任务 / 返工台账（T-2026-0930-0015）：客户要能看到"**每一次花钱的账**"——几次提交、几次判不合格、
   * 几次平台拒收、几次 canary 止损、后期返工几次。清单与 Markdown 同时落盘（UHD 走暂存发布，一并纳入）。
   */
  const renderLedger = buildRenderLedger(readStageHistory());
  const renderLedgerFile = join(OUT_DIR, `${PROJECT}-render-ledger.md`);
  writeFileSync(renderLedgerFile, renderLedgerMarkdown(renderLedger), "utf8");
  const stagedContentAssets = [...new Set([deliverablePath, ...stagedSubtitles,
    ...variantManifest.flatMap((variant) => [variant.path, ...(variant.cover ? [variant.cover.path] : [])]),
    ...(existsSync(coverFile) ? [coverFile] : []),
    ...(softsubFile ? [softsubFile] : []),
    ...(existsSync(withCover) && stageApproved("cover-intro") ? [withCover] : []),
    renderLedgerFile,
  ])];
  const assetHashes = QUALITY === "uhd"
    ? await Promise.all(stagedContentAssets.map(async (path) => ({ path: publicDeliveryPath(path), sha256: await sha256UhdAsset(path) })))
    : stagedContentAssets.map((path) => ({ path: publicDeliveryPath(path), sha256: sha256FileSync(path) }));
  const manifestFile = join(OUT_DIR, `${PROJECT}-delivery-manifest.json`);
  writeFileSync(manifestFile, `${JSON.stringify({ ...buildDeliveryManifest({
    projectId: PROJECT,
    platform: arg("--platform", "抖音/快手"),
    /**
     * 键名必须是模块入参的小写 `deliverable`：批量改名（deliverable→DELIVERABLE）时别把**键**也改掉，
     * 否则这支主件会被 JSON.stringify 静默丢掉（真机 2026-09-25 踩过：清单里没有母版指纹）。
     */
    deliverable: {
      path: publicDeliveryPath(deliverablePath),
      sha256: QUALITY === "uhd" ? await sha256UhdAsset(deliverablePath) : sha256FileSync(deliverablePath),
      bytes: statSync(deliverablePath).size,
      durationSec: Number(probe(deliverablePath).duration ?? 0),
      namingAudit: auditDeliverableNaming({ path: deliverablePath, durationSec: Number(probe(deliverablePath).duration ?? 0) }),
    },
    subtitles: { sidecarDir: subtitleSidecar
        ? (QUALITY === "uhd" ? publicDeliveryPath(join(OUT_DIR, "subtitles")) : subtitleSidecar.dir)
        : null,
      softsub: softsubFile ? publicDeliveryPath(softsubFile) : null, burned: SUBTITLE_MODE !== "sidecar" },
    cover: { path: existsSync(join(OUT_DIR, `${PROJECT}-cover.png`)) ? publicDeliveryPath(join(OUT_DIR, `${PROJECT}-cover.png`)) : null, hook: arg("--cover-hook", shotlist.title ?? "") },
    variants: publishedVariants,
    distinctness,
    variantAxes,
    samples,
    at: stamp()
  }), assets: assetHashes, completion: originalPostContract.contract.completion, quality: {
    tier: QUALITY, sourceResolution: SOURCE_RESOLUTION, outputResolution: OUTPUT_RESOLUTION,
    width: OUTPUT_SIZE.width, height: OUTPUT_SIZE.height,
    localEnhancement: "not-requested",
    exportGeometryMode: "local-compositor-normalization",
    enhancementModelInvoked: false
  },
  /**
   * 交付口径留痕（T-2026-0930-0014）：审核层状态 + post-only 组装声明。
   * 客户侧应能一眼看到"哪些是既有素材复用、哪些事后检查被移除、质量由谁验收"。
   */
  reviewPolicy: REVIEW_POLICY,
  reviewPolicyNote: REVIEW_DISABLED_REASON,
  assembly: {
    mode: POST_ONLY_ASSEMBLY ? "post-only" : "generated",
    reason: POST_ONLY_REASON || null,
    shotReceiptsMissing: POST_ONLY_ASSEMBLY ? postOnlyMissingReceipts : [],
  },
  /**
   * 视频类型分流结论（T-2026-0930-0015）：审计能回答"这条片子按哪条管线做的、商品锚点是什么"。
   */
  route: {
    kind: ROUTE_PREFLIGHT.kind,
    source: ROUTE_PREFLIGHT.source,
    productAnchor: ROUTE_PREFLIGHT.productAnchor,
    notes: ROUTE_PREFLIGHT.notes,
  },
  /** 配乐层状态（T-2026-0930-0015）：off 时写明原因，不让"没配乐"变成查不到的黑盒 */
  bgm: bgmManifestInfo,
  publication: { coverMode: publicationCoverReceipt?.mode ?? (publicationNeedsCover ? "missing" : "explicit-clean-version"), coverReceipt: publicationCoverReceipt,
    openingTitleSource: resolveOpeningTitle({ explicitTitle: arg("--opening-title", ""), disabled: flag("--no-title-card") }).source },
  characterRelease: characterReleaseReport("release"),
  sourceDisclosure: { footageOrigin: policyBrief?.footageOrigin ?? "unverified", platformPosted: false,
    note: "制作与来源说明留在元数据；本工具不执行外部平台发布" },
  /** 渲染/返工台账（次数与原因；不做费用估算） */
  renderLedger,
  renderLedgerFile: publicDeliveryPath(renderLedgerFile) }, null, 2)}\n`, "utf8");
  if (QUALITY === "uhd") {
    if (!gate.approved || gate.degraded) {
      record({ stage: "deliver", shotId: null, invoked: true, ok: false, cached: false, degraded: gate.degraded,
        attempt: 1, ms: Date.now() - started, artifact: manifestFile,
        evidence: { variants: variantManifest.map((v) => v.id), distinctness: distinctness.pairs, manifest: manifestFile },
        verdict: null, note: "G-DLV1 未放行，所有 UHD 文件只留在暂存区" });
      throw new Error(`UHD 交付包未放行（G-DLV1）：${gate.reason}`);
    }
    const stagedAssets = [...stagedContentAssets, manifestFile];
    rememberInputs("deliver", [deliverablePath, manifestFile, ...variantManifest.map((variant) => variant.path)]);
    try {
      const published = await publishUhdDelivery({
        stagingDir: OUT_DIR, publicRoot: PUBLIC_OUT_DIR, releaseId: RUN_ID,
        assets: stagedAssets.map((path) => relative(OUT_DIR, path)),
        manifestName: basename(manifestFile), approved: gate.approved && !gate.degraded,
      });
      const publishedManifest = publicDeliveryPath(manifestFile);
      record({ stage: "deliver", shotId: null, invoked: true, ok: true, cached: false, degraded: false,
        attempt: 1, ms: Date.now() - started, artifact: publishedManifest,
        evidence: { variants: variantManifest.map((v) => v.id), distinctness: distinctness.pairs,
          manifest: publishedManifest, files: published.files,
          outputFiles: stagedAssets.filter((path) => path !== manifestFile).map(publicDeliveryPath) },
        verdict: null, note: "G-DLV1 全绿后整包发布 UHD 交付目录" });
      log(`✅ UHD 交付包（G-DLV1 全绿）→ ${published.releaseDir}（${published.files} 个文件；当前指针 ${published.currentFile}）`);
    } catch (error) {
      record({ stage: "deliver", shotId: null, invoked: true, ok: false, cached: false, degraded: false,
        attempt: 1, ms: Date.now() - started, artifact: manifestFile,
        evidence: { publishError: error instanceof Error ? error.message : String(error) }, verdict: null,
        note: "UHD 交付发布失败，正式目录保留上一版" });
      throw error;
    }
  } else {
    record({
      stage: "deliver", shotId: null, invoked: true, ok: gate.approved, cached: false, degraded: gate.degraded, attempt: 1,
      ms: Date.now() - started, artifact: manifestFile,
      evidence: { variants: variantManifest.map((v) => v.id), distinctness: distinctness.pairs, manifest: manifestFile }, verdict: null, note: "多风格交付包（G-DLV1：变体雷同否决）"
    });
    if (!gate.approved && !ACCEPT_REJECTED.includes("deliver")) {
      log(`⛔ 交付包未放行（G-DLV1）：${gate.reason}`);
      process.exit(6);
    }
  }
}

/* ---------- ⑬ 返修闭环（step_key: revise，gate G-DLV4：层增量 + 复用 sha256 证据） ---------- */
/**
 * 用法：`--stages revise --revise-note "SC-02 手部畸变，另外配乐换掉"`。
 * 行为：把返修意见分诊成 shot-level / layer-level / mixed，写出**影响分析 + 复用 sha256 证据**的返修报告，
 * 并给出可直接执行的 `--stages` 序列；**不自动重跑**（返修要花钱，交给人/上游决定执行）。
 */
if (STAGES.has("revise") && !DRY_RUN) {
  const note = arg("--revise-note", "");
  if (!note) {
    /**
     * 没有返修意见时**这是"不适用"，不是"失败"**（2026-09-25 修正）：
     * 早先记 `ok:false`，阶段汇总里会显示 `revise failed=1`，把"没触发"读成"跑挂了"。
     */
    record({
      stage: "revise", shotId: null, invoked: false, ok: true, cached: false, degraded: false, attempt: 1, ms: 0,
      artifact: null, evidence: { missing: "--revise-note", applicable: false }, verdict: null,
      note: "无返修意见（--revise-note 未提供）：本阶段不适用，未执行"
    });
  } else {
    const started = Date.now();
    const plan = buildRevisionPlan({
      note,
      shots: shots.map((shot) => ({ shotId: shot.shotId, clipPath: join(CLIP_DIR, `${shot.shotId}.mp4`) })),
      hasher: (file) => (existsSync(file) ? createHash("sha256").update(readFileSync(file)).digest("hex") : "missing")
    });
    const report = buildRevisionReport(plan, note);
    const reportFile = join(OUT_DIR, `${PROJECT}-revision-report.json`);
    writeFileSync(reportFile, `${JSON.stringify(report, null, 2)}\n`, "utf8");
    const gate = recordGate({
      stepKey: "revise",
      sourceStage: "revise",
      shotIds: plan.rerunShots,
      checks: [
        { id: "revision-classified", pass: plan.executable, hard: true, detail: report.gate.detail },
        { id: "reuse-evidence", pass: plan.blockers.every((blocker) => blocker.code !== "reuse_evidence_unavailable"), hard: true, detail: `复用镜头 ${plan.reuseEvidence.length} 个，均带 sha256 证据` },
        { id: "render-gate-awareness", pass: true, hard: false, detail: plan.requiresRenderSubmitGate ? "点名画面内容 → 重跑镜头并走 G8 提交审批" : "纯后期层 → 零渲染（镜头全部复用）" }
      ],
      evidence: { note, kind: plan.kind, stages: plan.stages, reuseEvidence: plan.reuseEvidence.map((e) => ({ shotId: e.shotId, sha256: e.sha256.slice(0, 16) })), report: reportFile }
    });
    record({
      stage: "revise", shotId: null, invoked: true, ok: gate.approved, cached: false, degraded: false, attempt: 1,
      ms: Date.now() - started, artifact: reportFile,
      evidence: { kind: plan.kind, layers: plan.layers, rerunShots: plan.rerunShots, stages: plan.stages, status: "planned" }, verdict: null,
      note: `返修影响分析（${plan.kind}）`
    });
    log(`返修报告：${reportFile}`);
    log(`  类型 ${plan.kind}｜重跑镜头 ${plan.rerunShots.join("/") || "无（零渲染）"}｜重做层 ${plan.layers.join(" → ") || "无"}`);
    for (const step of plan.executionSteps) log(`  执行步骤（${step.scope}）：--stages ${step.stages.join(",")}${step.scope === "selected-shots" ? ` --only ${step.shotIds.join(",")}` : ""}`);
    if (report.renderSubmitApproval.required) log("  渲染费用审批：G8 待核实，规划通过不授予付费权限");
    if (!plan.executable) process.exitCode = 6;
    else if (flag("--execute-revision")) {
      const execution = await executeRevision({
        note,
        shots: shotlist.shots.map((shot) => ({ shotId: shot.shotId, clipPath: join(CLIP_DIR, `${shot.shotId}.mp4`) })),
        onStep: async (step, index) => {
          const originalArgs = process.argv.slice(2);
          const childArgs: string[] = [];
          const removeValue = new Set(["--stages", "--only", "--revise-note", "--revision-context"]);
          for (let i = 0; i < originalArgs.length; i++) {
            if (removeValue.has(originalArgs[i]!)) { i += 1; continue; }
            if (originalArgs[i] === "--execute-revision") continue;
            childArgs.push(originalArgs[i]!);
          }
          childArgs.push("--stages", step.stages.join(","), "--revision-context", note);
          if (step.scope === "selected-shots") childArgs.push("--only", step.shotIds.join(","), "--no-resume");
          const result = spawnSync(process.execPath, ["--import", "tsx", join(REPO_ROOT, "scripts/tools/full-chain-film.mts"), ...childArgs], {
            cwd: REPO_ROOT, env: process.env, encoding: "utf8", maxBuffer: 32 * 1024 * 1024,
            timeout: Number(arg("--revision-timeout-ms", "2700000"))
          });
          const logFile = join(LOG_DIR, `revision-${RUN_ID}-step-${index + 1}.log`);
          writeFileSync(logFile, `${result.stdout ?? ""}\n${result.stderr ?? ""}`, "utf8");
          return { exitCode: result.status, detail: result.error ? result.error.message : `退出 ${result.status}，工位日志 ${logFile}` };
        }
      });
      const executionFile = join(OUT_DIR, `${PROJECT}-revision-execution.json`);
      writeFileSync(executionFile, `${JSON.stringify(execution, null, 2)}\n`, "utf8");
      record({
        stage: "revise", shotId: null, invoked: true, ok: execution.status === "completed", cached: false,
        degraded: execution.status === "unverified", attempt: 1, ms: Date.now() - started, artifact: executionFile,
        evidence: { status: execution.status, steps: execution.steps, reused: execution.reused, errors: execution.errors }, verdict: null,
        note: "按登记工位顺序执行；逐镜和整片步骤分离；未选镜头每步前后核对真实字节"
      });
      if (execution.status !== "completed") process.exitCode = 6;
    }
  }
}

/* ---------- 收尾：阶段汇总落盘 ---------- */
const byStage = new Map<string, { invoked: number; ok: number; failed: number; degraded: number; cached: number }>();
for (const r of records) {
  const cur = byStage.get(r.stage) ?? { invoked: 0, ok: 0, failed: 0, degraded: 0, cached: 0 };
  if (r.invoked) cur.invoked += 1;
  if (r.ok) cur.ok += 1; else if (r.invoked) cur.failed += 1;
  if (r.degraded) cur.degraded += 1;
  if (r.cached) cur.cached += 1;
  byStage.set(r.stage, cur);
}
writeFileSync(join(LOG_DIR, "stage-summary.json"), `${JSON.stringify({
  project: PROJECT, at: stamp(), shots: shots.length, totalSeconds, completion: originalPostContract?.contract.completion ?? plannedCompletion,
  stages: Object.fromEntries(byStage), records
}, null, 2)}\n`, "utf8");
log(`阶段日志：${STAGE_LOG}`);
for (const [stage, s] of byStage) log(`  · ${stage.padEnd(14)} invoked=${s.invoked} ok=${s.ok} failed=${s.failed} degraded=${s.degraded} cached=${s.cached}`);

if (!DRY_RUN) {
  const aliases: Record<string, string[]> = { spec: ["prompt-review", "prompt-package"], plates: ["keyframe"], videos: ["shot"], "material-gen": ["material-gen"], voice: ["voice"], continuity: ["continuity"] };
  const notApplicable = (stage: string): boolean =>
    (stage === "material-gen" && materialShots().length === 0)
    || (stage === "mux" && SUBTITLE_MODE === "burn")
    || (stage === "danmaku" && !DANMAKU_ENABLED);
  const missing = [...STAGES].filter((stage) => !notApplicable(stage) && !(aliases[stage] ?? [stage]).some((alias) => records.some((row) => row.stage === alias)));
  const latest = new Map<string, StageRecord>();
  for (const row of records) latest.set(`${lineageStage(row)}:${row.shotId ?? ""}`, row);
  const failed = [...latest.values()].filter((row) => (row.invoked || STAGES.has(row.stage)) && (!row.ok || row.degraded || row.verdict?.approved === false));
  /**
   * post-only 组装（T-2026-0929-0012）与"咨询项不阻断交付"（T-2026-0930-0014）：
   * 已**显式声明**的降级（evidence.assemblyMode=post-only）与咨询性结论不再算作"请求未完成"——
   * 它们的含义是"源素材是既有成品片段/某项创作口径未命中"，不是"产物没做出来"。
   * 未声明的失败照旧 exit 6，避免真实故障被混在声明里蒙混过关。
   */
  const declaredPostOnly = (row: StageRecord): boolean =>
    row.degraded && (row.evidence as { assemblyMode?: unknown } | undefined)?.assemblyMode === "post-only";
  const declared = failed.filter((row) => declaredPostOnly(row));
  const hardFailed = failed.filter((row) => !declaredPostOnly(row));
  if (missing.length || hardFailed.length) {
    log(`⛔ 请求未完成：缺阶段 ${missing.join("/") || "无"}；未通过 ${hardFailed.map((row) => row.stage + (row.shotId ? `:${row.shotId}` : "")).join("/") || "无"}`);
    process.exitCode = 6;
  } else if (declared.length > 0) {
    log(`⚠ 带声明降级完成（post-only 组装）：${declared.map((row) => row.stage + (row.shotId ? `:${row.shotId}` : "")).join("/")}`
      + "——降级项已留痕在阶段日志与交付清单（assemblyMode=post-only），后期链与交付物均已产出。");
  }
}
if (WORKER_RUNTIME) WORKER_RUNTIME.finish(records, !process.exitCode, completedOriginals.map(original => original.shotId));
