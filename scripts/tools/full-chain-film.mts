#!/usr/bin/env tsx
/**
 * full-chain-film.mts —— 全链路出片（AI 监制自动放行版，T-2026-0924-0001）
 *
 * 与 `render-project.mts` 的分工：
 *   · render-project.mts 是"预生产产物 → 逐镜提交渲染"的服务端工具（依赖 server + DB + G8 审批）；
 *   · 本工具是**端到端制片**：脚本 → 提示词交付闸 → 关键帧 → 逐镜视频 → 合成 → 调色 → 字幕
 *     → 弹幕 → 配乐 → 封面 → 母版，每一步都过 **AI 监制门**（`producer-gate`），
 *     不合格就打回重跑，并把"这一步到底有没有被调用/有没有降级"写进阶段日志。
 *
 * 用法：
 *   tsx scripts/tools/full-chain-film.mts \
 *     --shots <shotlist.json> --project VID-PJL01 \
 *     --library <角色档案库根> --work-dir <.vm-work 根> --out <交付目录> \
 *     [--stages spec,plates,videos,compose,color,subtitle,danmaku,bgm,cover,mux] \
 *     [--subtitle-mode sidecar|burn|both]   # 缺省 sidecar：字幕只做旁挂文件 + 软字幕轨，母版不烧字 \
 *     [--aspect 9:16] [--resolution 1080p] [--fps 30] [--max-attempts 2] \
 *     [--keys-file ~/.workloom/live.env] [--brief <brief.json>] [--no-resume] [--dry-run]
 *
 * 阶段日志：`<work-dir>/logs/stages.jsonl`（逐条：stage/shotId/invoked/ok/degraded/cached/verdict）
 * 阶段汇总：`<work-dir>/logs/stages.json`
 */
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, utimesSync, writeFileSync
} from "node:fs";
import { homedir } from "node:os";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import {
  applyMicromotion, appendGateEvent, assessVariantDistinctness, auditContinuity, buildDeliveryManifest, buildGateEvent,
  assessMotionRichness, buildCoverDesignPrompt, buildMaterialMotionPrompt, buildPlatePrompt, buildRevisionPlan, buildRevisionReport, buildVariantPlan,
  buildMaterialScenePrompt, assessReferenceIndependence, decidePlateCache, MATERIAL_MOTION_POLICY, MATERIAL_RAW_MOTION_POLICY, MATERIAL_SCENE_POLICY_VERSION,
  isDoubledNarration, speechAcceptance,
  REFERENCE_INDEPENDENCE_POLICY,
  coverDeterministicChecks, coverPrefersNightBackground, COVER_FONTS, COVER_REVIEW_RUBRIC, COVER_SAFE_AREA,
  fallbackCoverPlan, findAngleFile, MATERIAL_POLICY_STATEMENT, MATERIAL_POLICY_VERSION, assessMaterialReuse,
  assertMaterialGenerationProvenance, parseCoverPlan, prepareShotPrompt, readMaterialSpec, resolveProducerLlm, reviewStage,
  buildSfxArgs, cutTimesFromShots, planCutSfxDetailed, CUT_SFX_POLICY,
  measureBpm, beatGridReport, checkShotOrder, assessVariantAxes, VARIANT_MIN_COUNT,
  normalizePromptLanguage,
  restoreTimelineField,
  type CoverDesignInput, type CoverMeasurements, type CoverPlan, type GateCheck, type GateEvent, type PipelineGateStepKey,
  type PlatePromptShot, type ProducerVerdict
} from "../../packages/video-studio/src/index.js";

const REPO_ROOT = resolve(import.meta.dirname ?? process.cwd(), "../..");
const FFMPEG = process.env.WL_FFMPEG ?? "ffmpeg";
const FFPROBE = process.env.WL_FFPROBE ?? "ffprobe";

function arg(name: string, fallback = ""): string {
  const i = process.argv.indexOf(name);
  return i >= 0 ? (process.argv[i + 1] ?? fallback) : fallback;
}
const flag = (name: string) => process.argv.includes(name);
const abs = (p: string) => (isAbsolute(p) ? p : resolve(REPO_ROOT, p));
const stamp = () => new Date().toISOString();
const log = (line: string): void => process.stdout.write(`[${stamp().slice(11, 19)}] ${line}\n`);

/* ================= 参数 ================= */

const SHOTS_FILE = abs(arg("--shots"));
if (!SHOTS_FILE || !existsSync(SHOTS_FILE)) throw new Error("需要 --shots <shotlist.json>");
const PROJECT = arg("--project", basename(SHOTS_FILE, ".json"));
const LIBRARY = resolve(arg("--library", join(REPO_ROOT, "var/media/characters")));
const WORK_DIR = resolve(arg("--work-dir", join(REPO_ROOT, ".vm-work")));
const OUT_DIR = resolve(arg("--out", join(REPO_ROOT, "outputs", PROJECT)));
const KEYS_FILE = arg("--keys-file", join(homedir(), ".workloom", "live.env"));
const BRIEF_FILE = arg("--brief");
const ASPECT = arg("--aspect", "9:16");
const RESOLUTION = arg("--resolution", "1080p");
const FPS = Number(arg("--fps", "30"));
const MAX_ATTEMPTS = Number(arg("--max-attempts", "2"));
/** 转场淡入淡出时长（秒）：快剪片（小红书/瞭望塔风格）用 0.1–0.2，抒情片用 0.5 */
const XFADE = Number(arg("--xfade", "0.5"));
/**
 * 逐刀转场（2026-09-25 新增，产品所有者第二轮反馈"运镜拉跨、不像《土耳其瞭望塔》"）：
 * 默认 `hblur`（横向拖影式甩镜转场）@0.18s；传 `--cut-transition ""` 即纯硬切。
 * 注意与 `--xfade` 的分工：`--xfade` 只管首尾淡入淡出（compose 的 fade），逐刀转场是这一对参数。
 */
const CUT_TRANSITION = arg("--cut-transition", "hblur");
const CUT_TRANSITION_DURATION = Number(arg("--cut-transition-duration", "0.18"));
/**
 * 转场只作用在这些**入点**（第 N 个镜头进场处，1 起）；空 = 每一刀都做。
 * 滕王阁片：只在进入/离开中段快剪的 4 处做甩镜转场（人物口播镜之间保持硬切），
 * 这样既拿到瞭望塔式的甩镜节奏，又不把总时长吃掉（6 镜满刀 0.18s 会掉到 29.2s，真机被打回）。
 */
const CUT_TRANSITION_AT = arg("--cut-transition-at", "2,3,4,5");
/**
 * 镜头顺序口径（2026-09-26 产品所有者点名）：
 *   `storyboard`（默认）= 成片顺序必须等于分镜顺序，后期不得为卡点/情绪重排；
 *   `reuse-assembly`    = 媒资库历史镜头复用路径，允许重组，但必须给 `--reuse-plan` 重组依据。
 * 重排入口用 `--compose-order NC-04,NC-01,...` 显式声明；不声明就按分镜顺序。
 */
const ORDER_POLICY = arg("--order-policy", "storyboard") as "storyboard" | "reuse-assembly";
const COMPOSE_ORDER = arg("--compose-order", "");
const REUSE_PLAN = arg("--reuse-plan", "");
/**
 * 封面主版式（2026-09-25 南昌片收口）：
 *   `landmark`（默认）= 地标满幅 + 人物卡（适合"人物镜头质量一般"的片子）；
 *   `split`          = **左侧地标满幅 + 右侧人物竖带**（无卡片硬边，双主体都清晰；当"人物卡贴在地标上"反复被判 "贴图感/遮挡主体"时的收口版式）；
 *   `person`         = **人物满幅 + 地标小图**——当"人物卡贴在地标上"反复被判
 *                      "贴图感/遮挡主体/人物不是主角"时改用这一版：人物是背景（不存在贴片边缘），
 *                      地标以柔边小图出现在右上角，三件套（人物/地标/标题）仍然齐备。
 */
const COVER_HERO = arg("--cover-hero", "landmark");
/**
 * 封面版式（2026-09-26 产品所有者口径，收敛为两种主视觉）：
 *   · `subject-led`（物体为主）：景物/商品/动物等**非人主体**满幅 + 标题（`--cover-hero subject|scenery`）；
 *   · `person-led`（人物为主）：人物是唯一主视觉，背景只作点缀（`--cover-hero person`）。
 * 旧的 `landmark`（地标 + 人物卡）与 `split`（左地标右人物竖带）保留为兼容档，但不再是推荐默认。
 */
const COVER_ARCHETYPE: "person-led" | "subject-led" =
  ["subject", "scenery", "object", "product"].includes(COVER_HERO) ? "subject-led" : "person-led";
/**
 * 逐刀转场总损耗（秒）与**成片目标时长**（同一口径，compose 校验与终审都用它）：
 * 15 刀 × 0.16s = 2.4s 会被 xfade 吃掉，目标应是"分镜总时长 − 损耗"，而不是分镜总时长。
 */
const CUT_TRANSITION_COUNT = CUT_TRANSITION
  ? CUT_TRANSITION_AT.split(",").map((value) => Number(value.trim())).filter((value) => Number.isFinite(value) && value > 0).length
  : 0;
const transitionLoss = Number((CUT_TRANSITION_COUNT * CUT_TRANSITION_DURATION).toFixed(3));
const DANMAKU_FILE = arg("--danmaku");
/** 只跑指定镜头（逗号分隔；用于单镜验证与局部重跑） */
const ONLY = arg("--only").split(",").map((s) => s.trim()).filter(Boolean);
/**
 * 监制已知悉但放行的镜头（逗号分隔）。
 * 用途：监制打回、但客观条件（账号欠费/额度用尽/时效）不允许重跑时，
 * **不允许静默放行**——必须显式列出，运行日志与阶段记录里要留"带瑕疵放行"的痕迹。
 */
const ACCEPT_REJECTED = arg("--accept-rejected").split(",").map((s) => s.trim()).filter(Boolean);
/**
 * 素材镜**运动强度**的显式放行名单（2026-09-25 新增）。
 * 用途：额度受限（如 Ark 账号欠费）时，先用**后期运镜增强**交付，并把"原始渲染运动不足"
 * 如实记为带瑕疵放行（绝不静默通过）；额度恢复后去掉这个参数即可按新提示词重渲。
 */
const ACCEPT_WEAK_MOTION = arg("--accept-weak-material-motion").split(",").map((s) => s.trim()).filter(Boolean);
/** 只做后期运镜增强、不提交新渲染（额度受限/只想换运镜设计时用） */
const MATERIAL_POST_ONLY = flag("--material-post-only");
/** 后期速度坡道（剪辑手法，默认开；关掉则完全保留模型给的时间节奏） */
const MATERIAL_SPEED_RAMP = !flag("--no-material-speed-ramp");
/**
 * 后期数字运镜（变焦 + 换景别切，默认**关**）。
 * 产品所有者口径：画面里的运镜必须由模型构建（参考图只作实景依据），数字变焦只作应急手段。
 */
const MATERIAL_POST_CAMERA_MOVE = flag("--material-post-camera-move");
/**
 * 照片尾段自动裁剪（2026-09-26 新增，默认开）：
 * 复用度实测确认"尾段就是参考照片（含深度变焦）"时，裁掉尾段并把剩余部分变速归一回镜头时长。
 * 前提是保留 ≥55% 时长且首次命中在中后段——否则整镜判不合格（不做"从照片里裁一点点"的假修）。
 */
const MATERIAL_PHOTO_TAIL_TRIM = !flag("--no-material-photo-tail-trim");

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

async function pickGridCompatibleBed(
  masterSeconds: number,
  cutTimes: readonly number[],
  hints: { genre?: string; mood?: string } = {},
): Promise<{
  id: string; title: string; path: string; bpm: number; measuredBpm: number; gridErrorMs: number;
  score: number; reasons: string[];
} | null> {
  /**
   * 直接读**全库**再排序（2026-09-26 真机发现）：
   * `findTracks` 的返回是 `items.slice(0, 20)`——切片发生在排序**之前**，
   * 于是"1034 首的曲库"在选曲侧只能看到库里前 20 首（真机现状），再好的曲子也进不了候选池。
   * 这里改用 `loadAllLocalTracks(ENV)` 拿全量，按"标签粗筛 + 曲风线索 + 本地库优先 + 时长富余"排序后再实测。
   */
  const core = (await import(join(REPO_ROOT, "bundles/ai-video/connectors/bgm-bridge/core.mjs"))) as {
    loadAllLocalTracks: (env?: NodeJS.ProcessEnv) => {
      tracks?: Array<{
        id?: string; title?: string; genre?: string; mood?: string; bpm?: number;
        durationSec?: number; localPath?: string | null; file?: string;
      }>;
    };
  };
  const library = core.loadAllLocalTracks(ENV);
  const minSeconds = Math.max(30, masterSeconds + 8);
  const allTracks = (library.tracks ?? [])
    .filter((track) => {
      const path = String(track.localPath ?? "");
      if (!path || !existsSync(path)) return false;
      const duration = Number(track.durationSec ?? 0);
      /** 时长口径：≥ 片子长度 + 8s 余量；元数据缺失时长时放行（交给实测判断） */
      return !(duration > 0) || duration >= minSeconds;
    });
  const grid = [60, 120, 240];
  const coarse = allTracks.map((item) => {
    const bpm = Number(item.bpm ?? 0);
    const path = String(item.localPath ?? "");
    const delta = Math.min(...grid.map((value) => Math.abs(bpm - value)));
    const reasons: string[] = [];
    let score = 0;
    if (delta <= 2) {
      /**
       * 网格族内部再排序：本片剪辑网格就是 120BPM（0.5s/拍），60BPM 的曲子虽然"同族"，
       * 但 13 个切点里能落上的拍点少一半（真机监制：13 个切点仅 2 个落点、平均误差 123ms）。
       * 因此 120 最高分、240 次之、60 最低。
       */
      score += bpm >= 117 && bpm <= 123 ? 50 : (bpm >= 235 ? 40 : 25);
      reasons.push(`BPM ${bpm} 落在剪辑网格族（Δ${delta}）`);
    } else if (delta <= 5) {
      score += 25;
      reasons.push(`BPM ${bpm} 贴近剪辑网格（Δ${delta}，混音可 ±2% 微调）`);
    }
    /**
     * 标签只是**粗筛**：不达标的不再直接丢（真机教训是标签本身会错），
     * 只把分数压低，让它排到后面——真正的判据是下面逐首实测的卡点误差。
     * 变体选曲（hints）时优先匹配该变体的曲风线索。
     */
    const label = [item.genre, item.mood, item.title].join(" ");
    const genreHit = (hints.genre ?? "").split("|").map((v) => v.trim()).filter(Boolean).filter((value) => label.includes(value));
    const moodHit = (hints.mood ?? "").split("|").map((v) => v.trim()).filter(Boolean).filter((value) => label.includes(value));
    if (genreHit.length > 0) { score += 24; reasons.push(`曲风线索命中「${genreHit.join("/")}」`); }
    if (moodHit.length > 0) { score += 18; reasons.push(`情绪线索命中「${moodHit.join("/")}」`); }
    if (/\.workloom-bgm\/library\//.test(path) || String(item.localPath ?? "").includes("/.workloom-bgm/")) {
      score += 20;
      reasons.push("来自产品所有者本地曲库");
    }
    if (Number(item.durationSec ?? 0) >= masterSeconds + 20) {
      score += 6;
      reasons.push(`时长 ${Math.round(Number(item.durationSec ?? 0))}s 富余`);
    }
    if (!hints.genre && !hints.mood && /旅行|城市|Vlog|旅拍|卡点|游记/.test(label)) {
      score += 8;
      reasons.push("题材贴合城市漫游");
    }
    return { id: String(item.id), title: String(item.title ?? ""), path, bpm, score, reasons };
  }).filter((value): value is { id: string; title: string; path: string; bpm: number; score: number; reasons: string[] } => value !== null);
  coarse.sort((a, b) => b.score - a.score);
  /**
   * 逐首实测（最多 8 首，避免选曲阶段扫全库）：
   * 用曲子前 45s 的波形测 BPM，再把**真实剪辑点**投到节拍上算误差。
   */
  const measured = coarse.slice(0, 16).map((candidate) => {
    try {
      const samples = readPcmSamples(candidate.path, 16000, 45);
      const bpm = measureBpm(samples, 16000);
      if (!(bpm.bpm > 0)) return null;
      const report = beatGridReport(bpm.bpm, cutTimes);
      return { ...candidate, measuredBpm: bpm.bpm, strength: bpm.strength, grid: report };
    } catch {
      return null;
    }
  }).filter((value): value is NonNullable<typeof value> => value !== null && value.grid.ok);
  const ranked = measured.map((candidate) => {
    const reasons = [...candidate.reasons];
    const gridDistance = candidate.grid.meanErrorMs;
    let score = candidate.score + Math.max(0, 60 - gridDistance) * 1.5;
    reasons.push(`实测 ${candidate.measuredBpm}BPM（标签 ${candidate.bpm}BPM，节拍强度 ${candidate.strength}）`);
    reasons.push(`卡点实测：${candidate.grid.detail}`);
    /** 同族里优先"一拍 = 剪辑点间隔"的那档（120 族最贴城市快剪），其次 240、60 */
    if (candidate.measuredBpm >= 117 && candidate.measuredBpm <= 123) { score += 40; reasons.push("实测落在 120 族（一拍 0.5s，最贴本片剪辑网格）"); }
    else if (candidate.measuredBpm >= 235) { score += 24; reasons.push("实测落在 240 族"); }
    else { score += 10; reasons.push("实测落在 60 族（同族但拍点较疏）"); }
    return { ...candidate, score, reasons };
  }).sort((a, b) => b.score - a.score);
  const best = ranked[0];
  if (!best) return null;
  return {
    id: best.id, title: best.title, path: best.path, bpm: best.bpm,
    measuredBpm: best.measuredBpm, gridErrorMs: best.grid.meanErrorMs,
    score: Math.round(best.score), reasons: best.reasons,
  };
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
   *   · 新增 `voice`：逐镜人声核查 + 缺播报的镜头补 TTS 旁白（"中间只有字幕没台词播报"的修复）。
   */
  /**
   * 2026-09-26 产品口径补充：`deliver`（多风格交付包）**默认开启**——
   * 真机复盘发现"一次产出几个版本"的约束一直没执行，根因就是它不在默认阶段表里，
   * 只有显式 `--stages ...,deliver` 才会跑，于是日常跑全链根本不产变体。
   */
  arg("--stages", "cine-kb,continuity,micromotion,spec,plates,material-gen,videos,voice,compose,color,subtitle,danmaku,bgm,cover,mux,deliver").split(",").map((s) => s.trim()).filter(Boolean)
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

const LOG_DIR = join(WORK_DIR, "logs");
const STAGE_LOG = join(LOG_DIR, "stages.jsonl");
const PLATE_DIR = join(WORK_DIR, "plates", PROJECT);
const CLIP_DIR = join(WORK_DIR, "clips", PROJECT);
const POST_DIR = join(WORK_DIR, "post", PROJECT);
const PROMPT_DIR = join(WORK_DIR, "prompts", PROJECT);
/** 成片交付路径（模板块与交付包/返修块共用；模板块内部变量名保持 `deliverable` 不变） */
const DELIVERABLE = join(OUT_DIR, `${PROJECT}-30s-final.mp4`);
/** 工位路径白名单（冒号分隔）：仓库根 + 运行产物根 + 交付目录 + 系统临时目录 */
const CLI_ALLOWED_ROOTS = [REPO_ROOT, WORK_DIR, OUT_DIR, tmpdir()].join(":");
for (const dir of [LOG_DIR, PLATE_DIR, CLIP_DIR, POST_DIR, PROMPT_DIR, OUT_DIR]) mkdirSync(dir, { recursive: true });

/** 环境：进程环境优先，其次仓库外秘密文件（只进内存，不落盘） */
function loadEnv(): Record<string, string> {
  const out: Record<string, string> = {};
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
if (!ARK_KEY && !DRY_RUN) throw new Error(`缺少火山方舟密钥（${KEYS_FILE} 的 VOLCENGINE_ARK_API_KEY / 环境变量）`);

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
};
const records: StageRecord[] = [];
function record(rec: Omit<StageRecord, "at">): void {
  const full: StageRecord = { at: stamp(), ...rec };
  records.push(full);
  appendFileSync(STAGE_LOG, `${JSON.stringify(full)}\n`, "utf8");
  const tag = full.ok ? (full.degraded ? "DEGRADED" : "ok") : "FAIL";
  log(`  ⇢ [${full.stage}${full.shotId ? ` ${full.shotId}` : ""}] ${tag}${full.cached ? "（复用）" : ""} ${full.ms}ms${full.artifact ? ` → ${full.artifact}` : ""}`);
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
  appendGateEvent(STAGE_LOG, event);
  records.push({
    at: event.at, stage: "gate", shotId: input.shotIds?.length === 1 ? input.shotIds[0]! : null,
    invoked: true, ok: event.ok, cached: false, degraded: event.degraded, attempt: 1, ms: 0, artifact: null,
    evidence: { stepKey: event.stepKey, gate: event.gate, via: event.via, score: event.score, sourceStage: event.sourceStage, shotIds: event.shotIds, checks: event.checks, reason: event.reason, ...(event.evidence ?? {}) },
    verdict: null, note: `门 ${event.gate}（${event.stepKey}）`, stepKey: event.stepKey, gate: event.gate
  });
  const tag = event.ok ? (event.degraded ? "DEGRADED" : "ok") : "FAIL";
  log(`  ⇢ [gate ${event.gate} ${event.stepKey}] ${tag}${event.via === "llm" ? `（llm${event.score !== null ? ` score=${event.score}` : ""}）` : "（deterministic）"} — ${event.reason.slice(0, 140)}`);
  return event;
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
  try {
    return readFileSync(STAGE_LOG, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line) as StageRecord);
  } catch {
    return [];
  }
}

/** 历史里某个环节是否有"放行"裁决（没有裁决记录的跳过环节按未知处理，不冒充已通过） */
function historyApproved(history: StageRecord[], stage: string): boolean {
  return history.some((r) => r.stage === stage && r.ok && (r.verdict ? r.verdict.approved : true));
}

/** 产物血缘：文件存在 + mtime 递进（raw → graded → subtitled → danmaku → scored） */
function lineageCheck(files: Array<{ label: string; path: string }>): { ok: boolean; detail: string } {
  const missing = files.filter((f) => !existsSync(f.path));
  if (missing.length > 0) return { ok: false, detail: `缺产物：${missing.map((f) => f.label).join("、")}` };
  const times = files.map((f) => ({ ...f, mtime: statSync(f.path).mtimeMs }));
  const outOfOrder = times.some((entry, index) => index > 0 && entry.mtime < times[index - 1]!.mtime);
  return {
    ok: !outOfOrder,
    detail: outOfOrder
      ? `产物时间顺序异常：${times.map((t) => `${t.label}=${new Date(t.mtime).toISOString().slice(11, 19)}`).join(" → ")}`
      : `产物血缘完整：${times.map((t) => `${t.label}(${(statSync(t.path).size / 1048576).toFixed(1)}MB)`).join(" → ")}`
  };
}

/**
 * 下游产物选择（2026-09-24 真机修复）：
 * 只重跑某一段时（例如 `--stages bgm,master`），未被重跑的环节应**沿用磁盘上更下游的既有产物**，
 * 而不是退回上游原片——早先 `let colored = master` 这类默认值会把"只跑 master"变成"交付未调色未烧字的原片"，
 * 同时让血缘检查（scored 的 mtime 早于 danmaku）永久失败。
 * 判据：候选文件存在且 **mtime 不早于**上游产物（晚于等于即视为由它或更晚的链路产出）。
 */
function preferDownstream(candidate: string, upstream: string): string {
  if (!existsSync(candidate)) return upstream;
  if (!existsSync(upstream)) return candidate;
  return statSync(candidate).mtimeMs >= statSync(upstream).mtimeMs ? candidate : upstream;
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
  return createHash("sha256").update(readFileSync(file)).digest("hex");
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
      /** 帧率：`r_frame_rate` 形如 "24/1"，取分子/分母（早先写成连除，得到 1/24，监制据此误判"帧率异常"） */
      fps: (() => {
        const [num, den] = String(video?.r_frame_rate ?? "0/1").split("/").map(Number);
        return num && den ? num / den : 0;
      })(),
      vcodec: video?.codec_name ?? null,
      acodec: audio?.codec_name ?? null,
      hasAudio: Boolean(audio),
      bytes: statSync(file).size
    };
  } catch (err) {
    return { error: err instanceof Error ? err.message.slice(0, 200) : String(err) };
  }
}
function runCli(cli: string, args: string[]): { ok: boolean; out: string } {
  try {
    const out = execFileSync(process.execPath, [abs(cli), ...args], {
      encoding: "utf8", maxBuffer: 32 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"],
      /**
       * 工位路径监狱（2026-09-24 真机修复）：调色/配乐工位默认只允许访问 `process.cwd()` 与 tmpdir。
       * 本工具的产物根在工作区之外（项目less 会话目录），不显式放开会被 `path_not_allowed` 拒掉
       * （真机：调色直接失败）。这里把仓库根、运行产物根、交付目录与 tmpdir 一起写进白名单。
       */
      env: {
        ...process.env,
        WL_REPO_ROOT: REPO_ROOT,
        WORKLOOM_COLOR_ALLOWED_ROOTS: CLI_ALLOWED_ROOTS,
        WORKLOOM_SUBTITLE_ALLOWED_ROOTS: CLI_ALLOWED_ROOTS,
        WORKLOOM_BGM_ALLOWED_ROOTS: CLI_ALLOWED_ROOTS,
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

/* ================= 输入 ================= */

interface ShotCard {
  shotId: string; sceneType?: string; duration?: number;
  scene?: string; sceneDescription?: string; action?: string; character?: string; costume?: string;
  makeup?: string; composition?: string; lighting?: string; color_palette?: string; mood?: string;
  dialogue?: Array<{ speaker?: string; text?: string; emotion?: string; trigger?: string }>;
  [key: string]: unknown;
}
const shotlist = JSON.parse(readFileSync(SHOTS_FILE, "utf8")) as {
  projectId?: string; title?: string; durationSeconds?: number; aspect?: string; resolution?: string;
  character?: { id?: string; name?: string }; shots: ShotCard[];
};
const shots = ONLY.length > 0 ? shotlist.shots.filter((s) => ONLY.includes(s.shotId)) : shotlist.shots;
if (!Array.isArray(shots) || shots.length === 0) throw new Error("shotlist 里没有镜头");
const totalSeconds = Number(shotlist.durationSeconds ?? shots.reduce((sum, s) => sum + Number(s.duration ?? 0), 0));
/**
 * 成片目标时长（秒）= 分镜总时长 − 逐刀转场损耗。
 * 逐刀 xfade 每刀吃掉 transitionDuration，15 刀 2.4s；compose 的 retime 目标与终审的时长判据都用它，
 * 保证"画面节拍网格"不被整片缩放（否则配乐卡点全乱，真机 4/15 命中）。
 */
const expectedMasterSeconds = Number(Math.max(1, totalSeconds - transitionLoss).toFixed(3));
/** 剪辑网格（真实切点，秒）：配乐卡点与 BPM 反推的事实依据（去掉片尾那一个点） */
const CUT_GRID: number[] = (() => {
  /**
   * 2026-09-25 南昌片真机修正：早先这里只是"各镜时长累加"，**没有扣逐刀转场的重叠**。
   * `--cut-transition-at` 每刀吃掉 transitionDuration，15 刀下来网格最多偏移 2.4s——
   * 配乐工位按错锚点对齐、监制据此判"卡点只有 10/15 命中"（真机）。现在与 compose/音效层同源。
   */
  const durations = shots.map((shot) => Number(shot.duration ?? 5));
  const transitionAt = CUT_TRANSITION
    ? CUT_TRANSITION_AT.split(",").map((value) => Number(value.trim())).filter((value) => Number.isFinite(value) && value > 0)
    : [];
  return cutTimesFromShots(durations, CUT_TRANSITION ? CUT_TRANSITION_DURATION : 0, transitionAt);
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
const generatedShots = shots.filter((shot) => !isMaterialShot(shot));
const materialShots = shots.filter((shot) => isMaterialShot(shot));
/**
 * 素材用途**在开跑前先验一遍**（fail-fast）：缺声明/写成静态直出用途时当场停，
 * 不等到出片阶段才发现"这一镜本来就不该这么做"。错误信息里带规则原文。
 */
for (const shot of materialShots) {
  try {
    readMaterialSpec(shot as unknown as Record<string, unknown>);
  } catch (err) {
    throw new Error(`素材用途硬约束未通过（${MATERIAL_POLICY_VERSION}）：${err instanceof Error ? err.message : String(err)}`);
  }
  log(`素材镜 ${shot.shotId}：素材用途声明 ok（generation-reference）——素材只作生成输入，禁止静态直出`);
}

interface CharacterEntryLike {
  id: string; name: string; files: Record<string, string>; dir: string;
  /** 档案正文里的外貌描述（纯文生图时的唯一人物变量；真人图不可作为视频首帧时靠它保人） */
  appearanceText: string;
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
      portraitSets?: Array<{ dir: string; angles: string[]; active?: boolean; version: number }>;
    };
    const sets = profile.portraitSets ?? [];
    const active = sets.find((s) => s.active) ?? sets[sets.length - 1];
    const files: Record<string, string> = {};
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
    library.set(profile.id, { id: profile.id, name: profile.name, files, dir, appearanceText });
  }
  return library;
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

/* ---------- ⓪-0 G5 定妆照确认（step_key: g5-portrait-confirm） ---------- */
/**
 * 管线 yml 的 `g5-portrait-confirm` 门：确认"这组定妆照可用于本片"。
 *
 * CLI 口径 = **资产硬闸 + 定妆照监制记录**：
 *   · 硬闸：角色档案在、四个必需角度齐备、单张 >50KB（占位图/失败图直接拦）；
 *   · 监制记录：读角色目录 `reviews/*.json` 的**最近一次**定妆照评审（`portrait-agent review` 产出），
 *     最近一次是"打回"就不放行；没有记录则如实标 degraded（说明这个门只做了确定性校验）。
 * 与 §⑤ 的 `keyframe`/`shot` 门不同，G5 管的是**角色资产**，不是本片画面。
 */
if (!DRY_RUN) {
  const requiredAngles = ["front", "threeQuarter", "closeup", "side"];
  const published = lead ? requiredAngles.map((angle) => ({ angle, path: lead.files[angle] ?? "" })) : [];
  const missing = published.filter((f) => !f.path || !existsSync(f.path));
  /** 安全取字节数：缺失/空路径返回 0（真机 2026-09-24：空路径直接 statSync 抛 ENOENT 把整个运行打断） */
  const sizeOf = (path: string): number => (path && existsSync(path) ? statSync(path).size : 0);
  const tiny = published.filter((f) => sizeOf(f.path) > 0 && sizeOf(f.path) < 50_000);
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
      const events = readFileSync(ledger, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as { stepKey?: string; at?: string; approved?: boolean; score?: number | null; reason?: string });
      const mine = events.filter((e) => e.stepKey === "g5-portrait-confirm");
      return mine.length > 0 ? mine[mine.length - 1]! : null;
    } catch { return null; }
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
            ? `四角度均 >50KB（${published.map((f) => `${f.angle}=${(sizeOf(f.path) / 1024).toFixed(0)}KB`).join(" ")}）`
            : `以下角度文件过小（疑似占位图）：${tiny.map((f) => f.angle).join("/")}`
        },
        {
          /** 附加信息（不参与硬闸）：档案里一共有多少角度可用——只有 4 个必需角度时也能拍，但选择面更窄 */
          id: "archive-angles", pass: Object.keys(lead.files).length >= 4, hard: false,
          detail: `档案可用角度 ${Object.keys(lead.files).join("/") || "无"}（共 ${Object.keys(lead.files).length} 个）`
        },
        ...(gateRecord
          ? [{
              id: "portrait-review", pass: gateRecord.approved !== false, hard: true,
              detail: `定妆照门记录（gates.jsonl）：${gateRecord.approved === false ? "打回" : "放行"}（score=${gateRecord.score ?? "?"}，${gateRecord.at ?? "无时间"}）`
            }]
          : review
          ? [{
              id: "portrait-review", pass: review.verdict?.approved !== false, hard: true,
              detail: `最近一次定妆照监制：${review.verdict?.approved === false ? "打回" : "放行"}（score=${review.verdict?.score ?? "?"}，${review.at ?? "无时间"}）`
            }]
          : [])
      ]
    : [{ id: "applicable", pass: true, detail: "镜头卡未涉及人物（空镜片）→ 定妆照门不适用", hard: false }];
  const gate = recordGate({
    stepKey: "g5-portrait-confirm",
    sourceStage: "portrait",
    checks,
    /**
     * 没有定妆照监制记录时**不冒充实质评审**：确定性闸照跑，但 degraded 置位，
     * 让审计一眼看到"这个门这次只做了资产校验"。
     */
    degraded: Boolean(lead) && !review && !gateRecord,
    evidence: {
      character: lead ? { id: lead.id, name: lead.name, angles: Object.keys(lead.files) } : null,
      reviewFile,
      gateLedger: lead ? join(lead.dir, "gates.jsonl") : null,
      gateApproved: gateRecord?.approved ?? null,
      reviewApproved: review?.verdict?.approved ?? null,
      note: gateRecord ? "含定妆照门记录（gates.jsonl）" : review ? "含定妆照监制评审文件（reviews/）" : "无定妆照监制记录：本次仅做资产硬闸（角度/尺寸/字节）"
    },
    reason: lead
      ? (gateRecord || review ? undefined : "定妆照资产齐备（无监制评审记录，已标 degraded）")
      : "本片无人物，定妆照门不适用"
  });
  if (!gate.approved && !ACCEPT_REJECTED.includes("G5")) {
    throw new Error(`G5 定妆照确认未通过：${gate.reason}（确需继续请显式传 --accept-rejected G5）`);
  }
}

/* ================= 关键帧 / 视频 出图出片 ================= */

function dataUrl(file: string): string {
  const ext = file.toLowerCase().endsWith(".png") ? "png" : file.toLowerCase().endsWith(".webp") ? "webp" : "jpeg";
  return `data:image/${ext};base64,${readFileSync(file).toString("base64")}`;
}

async function arkImage(prompt: string, anchors: string[], size: string): Promise<string> {
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

function readPlateMeta(shotId: string): { promptSha256?: string; anchorMode?: string; model?: string; at?: string } | null {
  const file = plateMetaFile(shotId);
  if (!existsSync(file)) return null;
  try {
    return JSON.parse(readFileSync(file, "utf8")) as { promptSha256?: string; anchorMode?: string; model?: string; at?: string };
  } catch {
    return null;
  }
}

function writePlateMeta(shotId: string, promptText: string, anchorMode: string): void {
  const payload = {
    promptSha256: createHash("sha256").update(promptText).digest("hex"),
    anchorMode,
    model: IMAGE_MODEL,
    at: stamp()
  };
  writeFileSync(plateMetaFile(shotId), `${JSON.stringify(payload, null, 2)}\n`, "utf8");
}

/** 当前提示词文件的 sha256（提示词还没产出时返回 null，视为缓存不可用） */
function promptSha256(shotId: string): string | null {
  const file = join(PROMPT_DIR, `${shotId}.txt`);
  if (!existsSync(file)) return null;
  const text = readFileSync(file, "utf8").trim();
  if (!text) return null;
  return createHash("sha256").update(text).digest("hex");
}

/** 本镜最近一次关键帧裁决是否为放行（被驳回过的产物不得被缓存复用洗白） */
function lastKeyframeApproved(history: StageRecord[], shotId: string): boolean {
  const rows = [...history].reverse().filter((r) => r.stage === "keyframe" && r.shotId === shotId);
  if (rows.length === 0) return false;
  return Boolean(rows[0]!.ok);
}

async function download(url: string, file: string): Promise<string> {
  const res = await fetch(url, { signal: AbortSignal.timeout(300_000) });
  if (!res.ok) throw new Error(`下载失败 HTTP ${res.status}`);
  writeFileSync(file, Buffer.from(await res.arrayBuffer()));
  return file;
}

/** 逐镜视频提交（Seedance 异步任务制） */
async function arkVideo(options: {
  prompt: string; firstFrame?: string; refs: string[]; seconds: number; generateAudio: boolean; seed?: number;
}): Promise<{ taskId: string; url: string; lastFrame: string | null }> {
  const content: Array<Record<string, unknown>> = [{ type: "text", text: options.prompt }];
  if (options.firstFrame) content.push({ type: "image_url", image_url: { url: options.firstFrame }, role: "first_frame" });
  for (const ref of options.refs.slice(0, 3)) {
    if (ref === options.firstFrame) continue;
    content.push({ type: "image_url", image_url: { url: ref }, role: "reference_image" });
  }
  const submit = await fetch(`${ARK_BASE}/contents/generations/tasks`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${ARK_KEY}` },
    body: JSON.stringify({
      model: VIDEO_MODEL,
      content,
      duration: options.seconds,
      /**
       * 首帧模式下 Ark 明确拒绝 `ratio`（InvalidParameter.TaskTypeConstraint：
       * "For first-frame or first-last-frame generation, the output ratio follows the first-frame image"）——
       * 画幅由关键帧自己决定，这里只在纯文生视频时才传 ratio。
       */
      ...(options.firstFrame ? {} : { ratio: ASPECT }),
      resolution: RESOLUTION,
      generate_audio: options.generateAudio,
      watermark: false,
      return_last_frame: true,
      ...(options.seed ? { seed: options.seed } : {})
    }),
    signal: AbortSignal.timeout(120_000)
  });
  const submitText = await submit.text();
  if (!submit.ok) throw new Error(`视频提交失败 HTTP ${submit.status}：${submitText.slice(0, 300)}`);
  const submitJson = JSON.parse(submitText) as { id?: string; data?: { id?: string } };
  const taskId = submitJson.id ?? submitJson.data?.id;
  if (!taskId) throw new Error(`未返回 task_id：${submitText.slice(0, 200)}`);

  const deadline = Date.now() + 20 * 60_000;
  let last: Record<string, unknown> = {};
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 10_000));
    const poll = await fetch(`${ARK_BASE}/contents/generations/tasks/${taskId}`, {
      headers: { authorization: `Bearer ${ARK_KEY}` }, signal: AbortSignal.timeout(60_000)
    });
    const pollText = await poll.text();
    try { last = JSON.parse(pollText) as Record<string, unknown>; } catch { last = { raw: pollText.slice(0, 200) }; }
    const status = String(last.status ?? "");
    if (status === "succeeded" || status === "success") {
      const url = String((last.content as Record<string, unknown> | undefined)?.video_url ?? "");
      const lastFrame = String((last.content as Record<string, unknown> | undefined)?.last_frame_url ?? "") || null;
      if (!url) throw new Error(`任务成功但无 video_url：${pollText.slice(0, 200)}`);
      return { taskId, url, lastFrame };
    }
    if (status === "failed" || status === "cancelled") {
      throw new Error(`渲染任务 ${status}：${pollText.slice(0, 300)}`);
    }
  }
  throw new Error(`轮询超时：${JSON.stringify(last).slice(0, 200)}`);
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
    resolution: RESOLUTION,
    title: shotlist.title
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
    return wrapped.slice(0, 2).join("\n");
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

log(`项目 ${PROJECT}｜镜头 ${shots.length} 个｜目标 ${totalSeconds}s｜${ASPECT} ${RESOLUTION}@${FPS}fps`);
log(`角色档案：${lead ? `${lead.name}（${lead.id}）角度 ${Object.keys(lead.files).join("/")}` : "未找到（人物一致性将降级为文字描述）"}`);
log(`阶段：${[...STAGES].join(" → ")}｜监制：${flag("--allow-fallback-approve") ? "允许降级放行" : "fail-closed"}`);
if (DRY_RUN) log("⚠ dry-run：只做脚本/提示词/计划，不出图不出片");

const specReports: Array<Record<string, unknown>> = [];
/** 动作节拍预算（advisory：只报数不拦，避免把"9 个 vs 8 个"这种量级差当成缺陷） */
const motionBudgetNotes: Array<{ shotId: string; beats: number; advice: string }> = [];

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
      artifact: null, evidence: { kbDir, bridgePath, exists: { bridge: existsSync(bridgePath), kb: existsSync(kbDir) } },
      verdict: null, note: "摄影知识库或连接器缺失，跳过注入（不静默：此处显式记录）"
    });
  } else {
    const core = await import(bridgePath) as {
      loadKb: (dir: string) => Record<string, unknown>;
      kbStatus: (kb: unknown) => Record<string, unknown>;
      enrichShotCard: (kb: unknown, card: unknown) => { card: Record<string, unknown>; trace: Record<string, unknown> };
    };
    const kb = core.loadKb(kbDir);
    const status = core.kbStatus(kb) as { topics: number; entries: number; missingTopics: Array<{ id: string; title: string }> };
    log(`摄影知识库：${status.topics} 篇 / ${status.entries} 条映射${status.missingTopics.length > 0 ? `｜⚠ 缺篇 ${status.missingTopics.map((t) => `${t.id} ${t.title}`).join("、")}` : ""}`);
    const traceDir = join(WORK_DIR, "cine-kb");
    mkdirSync(traceDir, { recursive: true });
    for (const [index, shot] of shots.entries()) {
      /**
       * 提示词语言口径（2026-09-24 真机）：分镜卡【语言约束】写明"全部字段必须使用中文"，
       * 因此默认只注入中文短语（英文关键词仍在 trace 里）；
       * 需要英文提示词的模型可由 `--prompt-english-gloss` 显式开启。
       */
      const { card, trace } = core.enrichShotCard(kb, shot, { englishGloss: flag("--prompt-english-gloss") });
      shots[index] = card as ShotCard;
      const traceFile = join(traceDir, `${shot.shotId}.json`);
      writeFileSync(traceFile, `${JSON.stringify({ ...trace, kbDir, kbStatus: status }, null, 2)}\n`, "utf8");
      const advisor = (trace as { apertureAdvisor?: { aperture: string; scenarioLabel: string | null; matchedBy: string } }).apertureAdvisor;
      const fields = ((trace as { applied?: Array<{ field: string; added: string }> }).applied ?? []);
      log(`  ${shot.shotId}: 光圈 ${advisor?.aperture ?? "-"}（${advisor?.scenarioLabel ?? "-"}）· 注入 ${fields.filter((f) => f.field !== "depth_of_field").length} 条知识 → ${fields.map((f) => f.field).join("/")}`);
      record({
        stage: "cine-kb", shotId: shot.shotId, invoked: true, ok: true, cached: false, degraded: false, attempt: 1,
        ms: Date.now() - started, artifact: traceFile,
        evidence: { aperture: advisor?.aperture ?? null, scenario: advisor?.scenarioLabel ?? null, matchedBy: advisor?.matchedBy ?? null, injectedFields: fields.map((f) => f.field), missingTopics: status.missingTopics.map((t) => t.id) },
        verdict: null, note: "知识库按场景注入（参数只进 trace，提示词只写画面语言）"
      });
    }
    /** 提示词交付闸前把增强后的镜头卡落盘留档 */
    writeFileSync(join(WORK_DIR, `shotlist-enriched-${PROJECT}.json`), `${JSON.stringify({ projectId: PROJECT, shots, cineKbApplied: true }, null, 2)}\n`, "utf8");
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
if (STAGES.has("continuity")) {
  const started = Date.now();
  const report = auditContinuity(shots as unknown as Array<Record<string, unknown>>, {
    targetSeconds: ONLY.length > 0 ? null : totalSeconds,
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
        discipline: "硬阻断（打回）：造型无理由不一致、总时长不符、台词重复。其余为软信号，进问题清单但不阻断；"
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

/* ---------- ①-1 微动作增强（step_key: micromotion，5 路：面部/身体/眼神/呼吸/融合） ---------- */
/**
 * 管线 yml 的 `micromotion` 环节。
 *
 * **与 yml 的顺序差异（显式声明）**：yml 把它排在 G6 之后；这里**前移到提示词融合之前**——
 * 增强的本质是改镜头卡（action 字段），融合之后再改就会绕开刚通过的 G6 审核
 * （"审过的提示词 ≠ 最终提交的提示词"）。前移后 G6 审的就是含微动作的最终稿。
 */
if (STAGES.has("micromotion")) {
  const started = Date.now();
  const traces: Array<Record<string, unknown>> = [];
  let empty = 0;
  for (const shot of generatedShots) {
    const { card, trace } = applyMicromotion(shot as unknown as Record<string, unknown>);
    traces.push(trace as unknown as Record<string, unknown>);
    if (trace.applied.length === 0 && !trace.skipped) empty += 1;
    if (!trace.skipped) {
      /** 就地替换镜头卡：后续 spec 融合、关键帧 platePrompt、视频提交读到的都是增强后的 action */
      const index = shots.findIndex((s) => s.shotId === shot.shotId);
      if (index >= 0) shots[index] = card as unknown as ShotCard;
    }
  }
  const channelsOk = traces.every((t) => (t.applied as unknown[]).length >= 4 || Boolean(t.skipped));
  const bounded = traces.every((t) => Number(t.charDelta ?? 0) <= 200);
  const languageOnly = !/f\/|ISO|帧率|焦段/.test(traces.map((t) => String(t.text ?? "")).join(" "));
  const checks: GateCheck[] = [
    { id: "five-channels", pass: channelsOk, hard: true, detail: channelsOk ? "每镜 5 路微动作齐备（面部/身体/眼神/呼吸/融合）" : "存在镜头不足 4 路微动作" },
    { id: "bounded-delta", pass: bounded, hard: true, detail: bounded ? `增量均在界内（最大 ${Math.max(0, ...traces.map((t) => Number(t.charDelta ?? 0)))} 字）` : "微动作增量超过 200 字上限" },
    { id: "language-only", pass: languageOnly, hard: true, detail: "微动作只写画面语言（不含 f 值/ISO/帧率等技术参数）" }
  ];
  const verdict = flag("--micromotion-review") && !DRY_RUN
    ? await reviewStage({
        stage: "micromotion", projectId: PROJECT,
        artifacts: [{ path: SHOTS_FILE, kind: "json" }],
        deterministic: checks,
        context: { traces: traces.slice(0, 8).map((t) => ({ shotId: t.shotId, text: t.text })) },
        env: ENV, allowFallbackApprove: ALLOW_FALLBACK_APPROVE, log
      })
    : null;
  const ok = checks.every((c) => !c.hard || c.pass) && (verdict ? verdict.approved : true);
  const traceFile = join(WORK_DIR, `micromotion-${PROJECT}.json`);
  if (!DRY_RUN) writeFileSync(traceFile, `${JSON.stringify({ at: stamp(), projectId: PROJECT, traces }, null, 2)}\n`, "utf8");
  record({
    stage: "micromotion", shotId: null, invoked: true, ok, cached: false, degraded: Boolean(verdict?.degraded),
    attempt: 1, ms: Date.now() - started, artifact: DRY_RUN ? null : traceFile,
    evidence: {
      channels: traces.map((t) => ({ shotId: t.shotId, applied: (t.applied as unknown[]).length, skipped: t.skipped ?? null, charDelta: t.charDelta })),
      llmReviewed: Boolean(verdict)
    },
    verdict
  });
  if (empty > 0 || !ok) {
    throw new Error(`微动作增强未通过自检：空增强 ${empty} 镜${verdict && !verdict.approved ? `；监制：${verdict.reason}` : ""}`);
  }
  log(`微动作增强：${shots.length} 镜 × 5 路（面部/身体/眼神/呼吸/融合）已并入 action${verdict ? `，监制${verdict.approved ? "放行" : "打回"}` : "（未启用 LLM 复评）"}`);
}

/* ---------- ② 脚本 + 提示词交付闸（监制：prompt） ---------- */
if (STAGES.has("spec")) {
  const started = Date.now();
  const checks: Array<{ id: string; pass: boolean; detail: string; hard?: boolean }> = [];
  let rateFail = 0;
  for (const shot of shots) {
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
    const report = prepareShotPrompt(shot as unknown as Record<string, unknown>, { ratio: ASPECT, resolution: RESOLUTION });
    /**
     * 提示词语言与引用归一（2026-09-24 真机，6 镜全部命中）：
     *   · 卡片【语言约束】要求全中文，而 vendor 负面约束默认夹带英文（no text / no watermark…）→ 映射成中文等价；
     *   · 角色图引用被写两遍 → 去重。
     * 归一后如仍有长度 ≥3 的拉丁词，写进阶段记录（供审计看到"还剩哪些英文"），不静默忽略。
     */
    const normalized = normalizePromptLanguage(report.prompt);
    /** 时间轴补全（vendor 组装器会截断末段节拍，实测 6/6 镜） */
    const timelineFixed = restoreTimelineField(normalized.prompt, (shot as Record<string, unknown>).timeline);
    const finalPrompt = timelineFixed.prompt;
    specReports.push({
      shotId: shot.shotId, charCount: finalPrompt.length, promptSource: report.promptSource,
      deliveryPass: report.delivery.pass, issues: report.delivery.issues,
      missingSpecFields: report.missingSpecFields, redlines: report.redlines, degraded: report.degraded,
      sceneSubstituted: report.sceneSubstituted, sceneSubstitution: report.sceneSubstitution,
      languageNormalized: {
        replacements: normalized.replacements, dedupedRefs: normalized.dedupedRefs,
        remainingLatin: normalized.remainingLatin, timelineRestored: timelineFixed.restored
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
    writeFileSync(join(PROMPT_DIR, `${shot.shotId}.txt`), `${finalPrompt}\n`, "utf8");
    const promptFile = join(PROMPT_DIR, `${shot.shotId}.txt`);
    checks.push({
      id: `delivery:${shot.shotId}`, pass: report.delivery.pass, hard: true,
      detail: report.delivery.pass ? `交付闸通过（${finalPrompt.length} 字 · ${report.promptSource}）` : `交付闸未过：${report.delivery.issues.join("；")}`
    });
    checks.push({
      id: `char-count:${shot.shotId}`, pass: finalPrompt.length >= 1200, hard: true,
      detail: `提示词 ${finalPrompt.length} 字（交付口径 ≥1200）`
    });
    checks.push({
      id: `speech-rate:${shot.shotId}`, pass: rate <= 3.6, hard: true,
      detail: `台词 ${chars} 字 / ${duration}s = ${rate.toFixed(2)} 字每秒（上限 3.6）`
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
      id: `pose-contradiction:${shot.shotId}`, pass: !(wantsFront && wantsTurn && !sequenced), hard: true,
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
    const priorRisk = /指|挥|递|捧|端/.test(actionText)
      && /桥|栏杆|船|河|水|岸/.test(sceneText)
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
      stage: "spec", shotId: shot.shotId, invoked: true, ok: report.delivery.pass && report.charCount >= 1200,
      cached: false, degraded: report.degraded, attempt: 1, ms: Date.now() - started,
      artifact: promptFile,
      evidence: {
        charCount: report.charCount, promptSource: report.promptSource, missing: report.missingSpecFields,
        sceneSubstituted: report.sceneSubstituted, sceneSubstitution: report.sceneSubstitution
      },
      verdict: null
    });
  }
  writeFileSync(join(PROMPT_DIR, "spec-report.json"), `${JSON.stringify(specReports, null, 2)}\n`, "utf8");
  /**
   * 总时长核对：`--only` 局部重跑时只核对被选中的镜头合计（否则局部重跑永远过不了这一闸）。
   */
  const selectedSeconds = shots.reduce((s, x) => s + Number(x.duration ?? 0), 0);
  const expectedSeconds = ONLY.length > 0 ? selectedSeconds : totalSeconds;
  checks.push({
    id: "duration-total", pass: Math.abs(selectedSeconds - expectedSeconds) < 0.001, hard: true,
    detail: `镜头时长合计 ${selectedSeconds}s（目标 ${expectedSeconds}s${ONLY.length > 0 ? `，局部重跑 ${ONLY.join(",")}` : ""}）`
  });
  /**
   * 全素材项目守卫（T-2026-0925-0001 真机发现，同"全真图"缺口在新版重现）：
   * 当 7 镜全部是**素材镜**（真实照片只作生成输入）时，文生提示词产物是空数组
   * （素材镜的提示词由 material-gen 阶段按"图生视频动效提示词"生成，G6 时还不存在），
   * 把空载体送给监制必然判"无正文"打回；而素材镜的把关门是 **G-MAT1**。
   * 因此这里显式跳过 G6 并留痕（via=skip），既不静默放行，也不让监制去判不适用的载体。
   */
  if (materialShots.length === shots.length) {
    log(`ℹ️ 全片 ${shots.length} 镜均为素材镜：文生提示词门（G6）不适用，按 skip 留痕（素材镜由 G-MAT1 把关）`);
    record({
      stage: "prompt-package", shotId: null, invoked: false, ok: true, cached: false, degraded: false, attempt: 1, ms: 0,
      artifact: join(PROMPT_DIR, "spec-report.json"),
      evidence: { materialShots: shots.map((s) => s.shotId), skipReason: "全片素材镜（真实素材只作生成输入）" },
      verdict: null, note: "全素材项目：无文生镜 → G6 不适用（素材镜提示词由 material-gen 生成并由 G-MAT1 把关）"
    });
    recordGate({
      stepKey: "g6-prompt-confirm",
      sourceStage: "prompt-package",
      checks: [{ id: "no-generated-shots", pass: true, hard: true, detail: `${shots.length} 镜全部为素材镜（usage=generation-reference）` }],
      shotIds: shots.map((s) => s.shotId),
      softApproved: true,
      via: "skip",
      score: null,
      degraded: false,
      reason: "全素材项目：无文生镜，提示词门不适用",
      evidence: { materialShots: shots.length }
    });
  } else {
  const verdict = await reviewStage({
    stage: "prompt", projectId: PROJECT,
    artifacts: [
      { path: join(PROMPT_DIR, "spec-report.json"), kind: "json" },
      /** 只送**生成镜**的提示词；真实素材段没有提示词文件（硬塞路径会让监制读到空文件） */
      ...generatedShots.map((s) => ({ path: join(PROMPT_DIR, `${s.shotId}.txt`), kind: "text" as const }))
    ],
    deterministic: checks,
    context: {
      title: shotlist.title, shots: generatedShots.length, materialShots: materialShots.map((s) => s.shotId), rateFail,
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
  });
  record({
    stage: "prompt-review", shotId: null, invoked: true, ok: verdict.approved, cached: false, degraded: verdict.degraded,
    attempt: 1, ms: verdict.ms, artifact: join(PROMPT_DIR, "spec-report.json"), evidence: { score: verdict.score }, verdict
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
  const venueRefs = shots.length > 0 && Array.isArray((shots[0] as Record<string, unknown>).venueRefs)
    ? ((shots[0] as Record<string, unknown>).venueRefs as string[]).map(abs).filter(existsSync)
    : [];
  for (const shot of shots) {
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
    const currentPromptSha = promptSha256(shot.shotId);
    const cacheDecision = decidePlateCache({
      exists: cachedPlateExists,
      sizeBytes: cachedPlateExists ? statSync(plate).size : 0,
      meta: cachedMeta,
      currentPromptSha256: currentPromptSha,
      anchorMode: plateAnchorMode,
      lastApproved: lastKeyframeApproved(readStageHistory(), shot.shotId)
    });
    const plateCacheValid = RESUME && cacheDecision.valid;
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
      record({ stage: "keyframe", shotId: shot.shotId, invoked: false, ok: true, cached: false, degraded: false, attempt: 0, ms: 0, artifact: null, evidence: { dryRun: true }, verdict: null });
      continue;
    }
    let approved = false;
    /** 关键帧阶段同样记录上一轮裁决，用于"带变更"重试 */
    let plateVerdict: ProducerVerdict | null = null;
    for (let attempt = 1; attempt <= MAX_ATTEMPTS && !approved; attempt += 1) {
      const started = Date.now();
      try {
        const prompt = platePrompt(shot, lead?.name ?? "主角", lead?.appearanceText ?? "")
          /**
           * 关键帧重试同样"带变更"：把上一轮监制的具体问题写进去（原来只有一句泛泛的"构图更准"）。
           */
          + (attempt > 1 ? `\n${retryInstruction(plateVerdict, attempt, MAX_ATTEMPTS)}` : "");
        const anchors = plateAnchorMode === "real"
          ? ([portraitRefs[0], portraitRefs[1], venueRefs[0]].filter(Boolean) as string[])
          : (venueRefs.slice(0, 1) as string[]);
        if (plateAnchorMode === "real" && attempt === 1) {
          log(`  ⚠ ${shot.shotId} 关键帧挂了真人锚点：产物会被 Seedance 隐私校验拒（仅适合做档案资产）`);
        }
        const url = await arkImage(prompt, anchors, ENV.SEEDREAM_SIZE ?? "2K");
        saveHostedUrl(shot.shotId, url);
        await download(url, plate);
        const info = probe(plate);
        const width = Number(info.width ?? 0); const height = Number(info.height ?? 0);
        const ratio = width && height ? width / height : 0;
        const expected = ASPECT === "9:16" ? 9 / 16 : 16 / 9;
        const verdict = await reviewStage({
          stage: "keyframe", projectId: PROJECT,
          artifacts: [{ path: plate, kind: "image", bytes: Number(info.bytes ?? 0), probe: info }],
          deterministic: [
            { id: "bytes", pass: Number(info.bytes ?? 0) > 50_000, detail: `文件 ${((Number(info.bytes ?? 0)) / 1024).toFixed(0)}KB`, hard: true },
            { id: "aspect", pass: Math.abs(ratio - expected) < 0.06, detail: `${width}x${height}（期望比例 ${expected.toFixed(3)}，实测 ${ratio.toFixed(3)}）`, hard: true }
          ],
          referenceImages: portraitRefs.slice(0, 2), context: { shotId: shot.shotId, scene: shot.scene, action: shot.action }, env: ENV,
          allowFallbackApprove: ALLOW_FALLBACK_APPROVE, log
        });
        record({
          stage: "keyframe", shotId: shot.shotId, invoked: true, ok: verdict.approved, cached: false, degraded: verdict.degraded,
          attempt, ms: Date.now() - started, artifact: plate, evidence: info, verdict
        });
        /** 放行才写指纹：被驳回的图不写元文件，下一轮必然重出（缓存失效判据 ② 的物证） */
        if (verdict.approved) writePlateMeta(shot.shotId, prompt, plateAnchorMode);
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
  /** 检索分辨率：180×320（够判结构，又比 360×640 快 4 倍） */
  const W = 180; const H = 320;
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
            "-vf", `scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920,`
              + `crop=round(1080/${scale}/2)*2:round(1920/${scale}/2)*2:(1080-round(1080/${scale}/2)*2)*${fx}:(1920-round(1920/${scale}/2)*2)*${fy},`
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
  const candidatePixels = candidates.map((file) => grayRaw(file));
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
 * **照片尾段裁剪**（2026-09-26 新增，额度受限时的止损手段）：
 *
 * 当复用度实测确认"镜头尾段是参考照片（含深度变焦）"而前段确实是由模型重建的真实场景时，
 * 不整镜丢弃，而是把尾段切掉、再把剩余部分**变速归一**回镜头时长（与 `normalizeClipDuration` 同源）——
 * 画面仍是渲染产物，节奏不变，观众看不到照片段。裁剪后必须重测复用度才能放行。
 */
function trimMaterialPhotoTail(clip: string, keepSec: number, targetSec: number): { from: number; to: number; factor: number } {
  const cut = `${clip}.headcut.mp4`;
  run(FFMPEG, ["-y", "-t", keepSec.toFixed(3), "-i", clip,
    "-c:v", "libx264", "-preset", "medium", "-crf", "18", "-pix_fmt", "yuv420p",
    "-c:a", "aac", "-b:a", "192k", "-ar", "48000", "-ac", "2", "-movflags", "+faststart", cut]);
  const normalized = normalizeClipDuration(cut, `${clip}.norm.mp4`, targetSec);
  execFileSync("mv", [`${clip}.norm.mp4`, clip]);
  return normalized;
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
  const W = 360; const H = 640;
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
  const W = 160; const H = 284; const fps = 8;
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
 * 因此：提交时长一律钳到 [4,12]，下载后再用 `normalizeClipDuration` **变速归一化**到目标时长——
 * 短镜要"渲染 4s、加速到 2.5s"（反而更有速度感），长镜则"渲染 12s、放慢到 15s"。
 */
const RENDER_SECONDS_MIN = 4;
const RENDER_SECONDS_MAX = 12;
function renderSecondsFor(durationSec: number): number {
  return Math.min(RENDER_SECONDS_MAX, Math.max(RENDER_SECONDS_MIN, Math.round(durationSec)));
}

/**
 * 把片段**变速**归一到目标时长（不是截断）：factor = 目标/实际。
 * 视频 `setpts=PTS*factor` + 音频 atempo 链（拆分以满足 atempo 的 0.5–2.0 单实例范围），再 `-t` 收口。
 * 失败时抛错（调用方按"该镜未产出"记档），不允许静默产出错长度的片段。
 */
function normalizeClipDuration(input: string, output: string, targetSec: number): { factor: number; from: number; to: number } {
  const from = Number(probe(input).duration ?? 0);
  if (!(from > 0) || !(targetSec > 0)) throw new Error(`时长归一化参数非法：${from}s → ${targetSec}s`);
  const factor = Number((targetSec / from).toFixed(6));
  const tempo = 1 / factor;
  const chain: string[] = [];
  let remaining = tempo;
  while (remaining > 2) { chain.push("atempo=2"); remaining /= 2; }
  while (remaining < 0.5) { chain.push("atempo=0.5"); remaining /= 0.5; }
  chain.push(`atempo=${remaining.toFixed(6)}`);
  run(FFMPEG, ["-y", "-i", input,
    "-vf", `setpts=PTS*${factor.toFixed(6)}`,
    "-af", chain.join(","),
    "-t", targetSec.toFixed(3),
    "-c:v", "libx264", "-preset", "medium", "-crf", "18", "-pix_fmt", "yuv420p",
    "-c:a", "aac", "-b:a", "192k", "-ar", "48000", "-ac", "2", "-movflags", "+faststart", output]);
  return { factor, from: Number(from.toFixed(3)), to: Number(Number(probe(output).duration ?? 0).toFixed(3)) };
}

/**
 * 速度坡道后期（《土耳其瞭望塔》观感的关键之一）：把匀速镜头重排成
 * **快起（whip-in）→ 稳行 → 快收（whip-out）** 三段，并整体归一化回原时长，
 * 时间线长度不变，但速度有了明显快慢对比。
 *
 * 实现（确定性、可复算）：
 *   ① 固定相对速度因子 f = [fastIn, mid, fastOut] 与源片段切分比例 split；
 *   ② 先算 Σ(source_i / f_i)，再乘归一化系数 k，使总时长恰等于目标时长（不靠 -t 截断、不冻结帧）；
 *   ③ 三段各自 `setpts` 变速 → concat → 重编码（音频同步重采样）。
 * 结果（每段来源区间与实际速度）写进阶段证据 `speedRamp`，可逐段复算。
 */
function applySpeedRamp(input: string, output: string, options: {
  durationSec: number;
  fastIn?: number;
  mid?: number;
  fastOut?: number;
}): { segments: Array<{ from: number; to: number; speed: number }>; total: number } {
  /** atempo 单实例有范围限制（0.5–2.0 最稳）：把目标速度拆成若干段串联，视频与音频严格同步变速 */
  const atempoChain = (speed: number): string => {
    const parts: string[] = [];
    let remaining = speed;
    while (remaining > 2) { parts.push("atempo=2"); remaining /= 2; }
    while (remaining < 0.5) { parts.push("atempo=0.5"); remaining /= 0.5; }
    parts.push(`atempo=${remaining.toFixed(4)}`);
    return parts.join(",");
  };
  const fastIn = options.fastIn ?? 2.8;
  const mid = options.mid ?? 1.0;
  const fastOut = options.fastOut ?? 1.8;
  const sourceDuration = Number(probe(input).duration ?? options.durationSec) || options.durationSec;
  const splits: Array<[number, number, number]> = [
    [0, 0.30, fastIn],
    [0.30, 0.72, mid],
    [0.72, 1, fastOut]
  ];
  const rawTotal = splits.reduce((sum, [a, b, f]) => sum + ((b - a) * sourceDuration) / f, 0);
  const k = rawTotal > 0 ? rawTotal / options.durationSec : 1;
  const workDir = join(WORK_DIR, "speed-ramp", PROJECT, basename(output, ".mp4"));
  mkdirSync(workDir, { recursive: true });
  const parts: string[] = [];
  const segments: Array<{ from: number; to: number; speed: number }> = [];
  splits.forEach(([a, b, f], index) => {
    const from = a * sourceDuration;
    const to = b * sourceDuration;
    const speed = f * k;
    const part = join(workDir, `part-${index + 1}.mp4`);
    run(FFMPEG, ["-y", "-ss", from.toFixed(3), "-to", to.toFixed(3), "-i", input,
      "-filter_complex", `[0:v]setpts=PTS/${speed.toFixed(4)},setpts=PTS-STARTPTS[v];[0:a]${atempoChain(speed)},asetpts=PTS-STARTPTS[a]`,
      "-map", "[v]", "-map", "[a]", "-c:v", "libx264", "-preset", "medium", "-crf", "18", "-pix_fmt", "yuv420p",
      "-c:a", "aac", "-b:a", "192k", "-ar", "48000", "-ac", "2", "-movflags", "+faststart", part]);
    parts.push(part);
    segments.push({ from: Number(from.toFixed(3)), to: Number(to.toFixed(3)), speed: Number(speed.toFixed(3)) });
  });
  const listFile = join(workDir, "concat.txt");
  writeFileSync(listFile, `${parts.map((p) => `file '${p}'`).join("\n")}\n`, "utf8");
  run(FFMPEG, ["-y", "-f", "concat", "-safe", "0", "-i", listFile, "-t", options.durationSec.toFixed(3),
    "-c:v", "libx264", "-preset", "medium", "-crf", "18", "-pix_fmt", "yuv420p",
    "-c:a", "aac", "-b:a", "192k", "-ar", "48000", "-ac", "2", "-movflags", "+faststart", output]);
  return { segments, total: Number((Number(probe(output).duration ?? 0)).toFixed(3)) };
}

/**
 * 镜头运动设计（2026-09-25 产品所有者第二轮反馈："中间的图片镜头还是简单的图片、运镜拉跨、
 * 要像《土耳其瞭望塔》"）。
 *
 * 这是在**真实生成画面**上做数字运镜（不是把静态图推拉——那仍然违反素材用途红线）：
 *   · 先 1.35× 超采样（lanczos），再 `zoompan` 做多段运镜，避免裁切放大导致的糊；
 *   · 每镜切两刀（punch cut）：前半段"大行程推近"，后半段"紧景别拉开 + 横向位移"，
 *     观感上等于同一个场景里换了机位/焦段，剪辑密度翻倍；
 *   · 每段用解析式缓动（easeOutCubic / easeInOutSine），确定性可复现；
 *   · 与 `applySpeedRamp`（快起→稳行→快收）叠加，得到"有速度、有位移、有景别变化"的镜头。
 *
 * 参数与实测（每段 zoom/pan 起止 + 成片运动能量）都写进阶段证据，可逐段复算。
 */
function applyCameraMovePunchCut(input: string, output: string, options: {
  durationSec: number;
  fps?: number;
  oversample?: number;
}): {
  segments: Array<{ from: number; to: number; zoom: [number, number]; panX: [number, number]; panY: [number, number]; ease: string }>;
  total: number;
} {
  const fps = options.fps ?? 30;
  const oversample = options.oversample ?? 1.35;
  const duration = options.durationSec;
  const cut = Number((duration * 0.48).toFixed(3));
  const workDir = join(WORK_DIR, "camera-move", PROJECT, basename(output, ".mp4"));
  mkdirSync(workDir, { recursive: true });
    /**
     * 三段运镜（每段之间是硬切/甩镜过渡，观感上等于"一个场景里换了三次机位"）：
     *   ① 甩镜入：高速横掠（带运动模糊）后定住——瞭望塔式的入场；
     *   ② 抬升推近：低角度上抬 + 推近，重心上移（牌匾/飞檐层次拉开）；
     *   ③ 拉开横移：紧景别起步 → 拉开并横移到另一侧收尾。
     */
  const cut1 = Number((duration * 0.42).toFixed(3));
  const cut2 = Number((duration * 0.74).toFixed(3));
  const plan: Array<{ from: number; to: number; zoom: [number, number]; panX: [number, number]; panY: [number, number]; ease: string; whip?: boolean }> = [
    { from: 0, to: cut1, zoom: [1.22, 1.06], panX: [0.78, 0.34], panY: [0.5, 0.47], ease: "whip", whip: true },
    { from: cut1, to: cut2, zoom: [1.10, 1.30], panX: [0.46, 0.52], panY: [0.62, 0.38], ease: "out-cubic" },
    { from: cut2, to: duration, zoom: [1.32, 1.08], panX: [0.38, 0.62], panY: [0.42, 0.52], ease: "in-out-sine" }
  ];
  const easeOf = (kind: string, frames: number): string => {
    const t = `(on/${frames})`;
    /** whip：前 12% 吃掉 60% 行程（甩镜），其余用 easeOutCubic 收尾（两段在 t=0.12 连续） */
    if (kind === "whip") return `if(lt(${t},0.12),5*${t},0.6+0.4*(1-pow(1-min(1,max(0,(${t}-0.12)/0.88)),3)))`;
    if (kind === "in-out-sine") return `(1-cos(PI*min(1,max(0,${t}))))/2`;
    return `(1-pow(1-min(1,max(0,${t})),3))`;
  };
  const parts: string[] = [];
  plan.forEach((segment, index) => {
    const span = segment.to - segment.from;
    const frames = Math.max(1, Math.round(span * fps));
    const ease = easeOf(segment.ease, frames);
    const z = `(${segment.zoom[0]}+(${segment.zoom[1]}-${segment.zoom[0]})*${ease})`;
    const x = `(iw-iw/zoom)*(${segment.panX[0]}+(${segment.panX[1]}-${segment.panX[0]})*${ease})`;
    const y = `(ih-ih/zoom)*(${segment.panY[0]}+(${segment.panY[1]}-${segment.panY[0]})*${ease})`;
    const part = join(workDir, `seg-${index + 1}.mp4`);
    /**
     * 甩镜段的运动模糊：`tmix` 只加在前 0.35s（真正的甩镜过程），定住后保持锐利——
     * 全程加模糊会显得画质脏，只在高速段加才像真实快门拖影。
     */
    const blurFilter = segment.whip
      ? `,tmix=frames=3:weights='1 2 1':enable='lt(t,0.35)'`
      : "";
    run(FFMPEG, [
      "-y", "-ss", segment.from.toFixed(3), "-t", span.toFixed(3), "-i", input,
      "-filter_complex",
      `[0:v]fps=${fps},scale=iw*${oversample}:ih*${oversample}:flags=lanczos,`
        + `zoompan=z='${z}':x='${x}':y='${y}':d=1:s=1080x1920:fps=${fps},setsar=1${blurFilter},format=yuv420p[v];`
        + `[0:a]afade=t=in:st=0:d=0.02,asetpts=PTS-STARTPTS[a]`,
      "-map", "[v]", "-map", "[a]",
      "-t", span.toFixed(3),
      "-c:v", "libx264", "-preset", "medium", "-crf", "18", "-pix_fmt", "yuv420p",
      "-c:a", "aac", "-b:a", "192k", "-ar", "48000", "-ac", "2", "-movflags", "+faststart", part
    ]);
    parts.push(part);
  });
  const listFile = join(workDir, "concat.txt");
  writeFileSync(listFile, `${parts.map((p) => `file '${p}'`).join("\n")}\n`, "utf8");
  run(FFMPEG, ["-y", "-f", "concat", "-safe", "0", "-i", listFile, "-t", duration.toFixed(3),
    "-c:v", "libx264", "-preset", "medium", "-crf", "18", "-pix_fmt", "yuv420p",
    "-c:a", "aac", "-b:a", "192k", "-ar", "48000", "-ac", "2", "-movflags", "+faststart", output]);
  return { segments: plan, total: Number(Number(probe(output).duration ?? 0).toFixed(3)) };
}

if (STAGES.has("material-gen")) {
  const [pw, ph] = RESOLUTION === "1080p" ? (ASPECT === "9:16" ? [1080, 1920] : [1920, 1080]) : [720, 1280];
  for (const shot of materialShots) {
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
    if (!existsSync(photo)) {
      record({
        stage: "material-gen", shotId: shot.shotId, invoked: true, ok: false, cached: false, degraded: false, attempt: 1, ms: 0,
        artifact: null, evidence: { photo, missing: true, policy: MATERIAL_POLICY_VERSION }, verdict: null, note: "素材文件不存在"
      });
      continue;
    }
    try {
      if (!(RESUME && existsSync(prepared) && statSync(prepared).size > 50_000) || DRY_RUN) {
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
        aspect: ASPECT, resolution: RESOLUTION, durationSec: duration, title: shotlist.title
      });
      writeFileSync(promptFile, `${prompt}\n`, "utf8");
      const promptIntent = prompt;
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
      /** 原始渲染产物（未做速度坡道）：留档，便于"坡道参数换一版"而不重新烧额度 */
      const rawClip = join(CLIP_DIR, `${shot.shotId}.raw.mp4`);
      let renderTaskId: string | null = null;
      let renderModel: string | null = null;
      /**
       * 复用判据（2026-09-25 收口）：只有**原始渲染产物**在盘上、且阶段日志里能查到它的任务号时才复用
       * （坡道是后期层，每次按当前参数重算即可；旧管线留下的 `<shot>.mp4` 没有 raw 与溯源 → 重新生成）。
       */
      /**
       * 后期运镜模式（额度受限）：**先**把上一版成片片段提升为原始渲染档（保留原件），
       * 再回填溯源——顺序不能颠倒：溯源分支以"原始档存在"为前提，先读会把溯源读空。
       */
      if (MATERIAL_POST_ONLY && !existsSync(rawClip) && existsSync(clip) && statSync(clip).size > 100_000) {
        const promoted = `${rawClip}.promote`;
        execFileSync("cp", [clip, promoted]);
        execFileSync("mv", [promoted, rawClip]);
        log(`  ⤴ ${shot.shotId} 后期运镜模式：把上一版片段登记为原始档（${basename(rawClip)}），不提交新渲染`);
      }
      if (RESUME && existsSync(rawClip) && statSync(rawClip).size > 100_000) {
        /**
         * 溯源回填：**从后往前**找最近一条真的带 taskId 的记录。
         * 为什么要反向找而不是取最后一条：额度不足等失败尝试也会写阶段记录（无 taskId），
         * 早先"取最后一条"会把溯源读空，进而误判"没有溯源"。
         */
        const history = readStageHistory().filter((r) => r.stage === "material-gen" && r.shotId === shot.shotId);
        const withTask = [...history].reverse().find((r) => Boolean((r.evidence as Record<string, unknown> | undefined)?.taskId));
        const lastEvidence = (withTask?.evidence ?? history.at(-1)?.evidence) as Record<string, unknown> | undefined;
        renderTaskId = (lastEvidence?.taskId as string | undefined) ?? null;
        renderModel = (lastEvidence?.model as string | undefined) ?? null;
      }
      const attempts = Math.max(1, MAX_ATTEMPTS);
      let accepted = false;
      let usedAttempt = 0;
      let lastVerdict: ProducerVerdict | null = null;
      let lastMotion = { meanEnergy: 0, maxEnergy: 0, rampRatio: 0, frames: 0, peakAtSec: 0 };
      let lastRawMotion = { meanEnergy: 0, maxEnergy: 0, rampRatio: 0, frames: 0, peakAtSec: 0 };
      let lastMotionVerdict = { rich: false, detail: "" };
      let lastRampVerdict = { rich: false, detail: "" };
      let lastRamp: { segments: Array<{ from: number; to: number; speed: number }>; total: number } | null = null;
      let lastReuse = { samples: [] as Array<{ atSec: number; bestPsnrDb: number | null }>, candidates: 0 };
      let lastReuseVerdict = { staticDisplay: false, hits: 0, samples: 0, worst: null as number | null, detail: "" };
      let lastInfo: Record<string, unknown> = {};
      let lastFrames: string[] = [];
      let lastOutputSha = "";
      while (usedAttempt < attempts && !accepted) {
        usedAttempt += 1;
        /**
         * 重跑必须"带变更"：第 2 次起把运动强度档位升到 assertive，并把上一轮监制/机检的问题写进提示词
         * （沿用视频镜的 `retryInstruction`，避免"重采样碰运气"白烧额度）。
         */
        const attemptPrompt = buildMaterialScenePrompt(card, {
          aspect: ASPECT, resolution: RESOLUTION, durationSec: duration, title: shotlist.title,
          motionStrength: usedAttempt > 1 ? "assertive" : "standard"
        }) + (usedAttempt > 1 ? `\n${retryInstruction(lastVerdict, usedAttempt, attempts)}\n【运动机检未过】${lastMotionVerdict.detail}` : "");
        writeFileSync(promptFile, `${attemptPrompt}\n`, "utf8");
        try {
          /**
           * 渲染（有新任务就重新提交；复用路径直接用盘上的 raw）。prompt 变量用于提交门证据，
           * 这里同步成当前轮的提示词，保证"提交的提示词 = 记录在案的提示词"。
           */
          prompt = attemptPrompt;
          const needRender = !renderTaskId || usedAttempt > 1;
          if (needRender && MATERIAL_POST_ONLY) {
            /** 后期运镜模式：不提交渲染（额度受限），只做运动设计 + 速度坡道 */
            log(`  ⏭ ${shot.shotId} 后期运镜模式：跳过渲染提交（额度受限），直接用原始档做运镜设计`);
          } else if (needRender) {
            if (DRY_RUN) {
              record({ stage: "material-gen", shotId: shot.shotId, invoked: false, ok: true, cached: false, degraded: false, attempt: usedAttempt, ms: 0, artifact: null, evidence: { dryRun: true }, verdict: null });
              break;
            }
            const submitted = await arkVideo({
              prompt: attemptPrompt,
              /**
               * **不再用 first_frame**（2026-09-25 产品所有者口径）：参考图只作实景依据，
               * 以 `reference_image` 角色提交，让模型自己构建机位与取景——
               * first_frame 会把"这张照片"钉成首帧，正是"把图片动起来"的根源。
               */
              firstFrame: undefined,
              refs: [dataUrl(prepared)],
              /** Seedance 时长下限 4s（见 `renderSecondsFor` 注释）：短镜先渲染 4s，再由下方变速归一化到目标时长 */
              seconds: renderSecondsFor(duration),
              generateAudio: ENV.SEEDANCE_GENERATE_AUDIO !== "0",
              seed: 20260925 + usedAttempt
            });
            await download(submitted.url, rawClip);
            const normalized = normalizeClipDuration(rawClip, `${rawClip}.norm.mp4`, duration);
            execFileSync("mv", [`${rawClip}.norm.mp4`, rawClip]);
            log(`  ⇄ ${shot.shotId} 时长归一：渲染 ${normalized.from}s → 目标 ${normalized.to}s（×${normalized.factor}）`);
            renderTaskId = submitted.taskId;
            renderModel = VIDEO_MODEL;
          }
          /**
           * 运动机检分两段（真机标定结论）：
           *   · **原始渲染**必须"一直在动"（mean ≥ 8）——这是模型有没有真做出运镜的判据；
           *   · **坡道后成片**必须"有快慢对比"（rampRatio ≥ 1.8）——这是后期节奏的判据。
           * 为什么分开：后期坡道会把慢段拉慢，成片 mean 会**低于**原始值（真机 SC-05：9.2 → 7.6），
           * 拿成片 mean 当"模型运动不足"的判据会误杀本来运镜很好的镜头。
           */
          /**
           * 原始渲染用**模型端口径**（mean ≥8，坡道只要 ≥1.25）：速度坡道由后期负责；
           * 成片用完整口径（mean ≥8 且 ramp ≥1.8）。两者分开，才不会"匀速但运动充分"被误杀。
           */
          lastRawMotion = measureMotionRichness(rawClip);
          lastMotionVerdict = assessMotionRichness(lastRawMotion, MATERIAL_RAW_MOTION_POLICY);
          /**
           * 带瑕疵放行（显式）：额度受限时允许"原始渲染运动不足"入片，但必须
           * ① 镜头在 `--accept-weak-material-motion` 名单里；② 单独写一条 acknowledge 记录留痕。
           */
          const weakAccepted = !lastMotionVerdict.rich && ACCEPT_WEAK_MOTION.includes(shot.shotId);
          if (weakAccepted) {
            log(`  ⚠ ${shot.shotId} 原始渲染运动不足（${lastRawMotion.meanEnergy.toFixed(2)} < ${MATERIAL_MOTION_POLICY.minMeanEnergy}）：按显式放行处理，交由后期运镜增强`);
            record({
              stage: "material-motion-acknowledge", shotId: shot.shotId, invoked: true, ok: true, cached: false,
              degraded: true, attempt: usedAttempt, ms: 0, artifact: rawClip,
              evidence: {
                rawMotion: lastRawMotion, policy: MATERIAL_MOTION_POLICY,
                reason: "额度受限（Ark AccountOverdueError）：本轮先用后期运镜增强交付，重渲待额度恢复",
                rerunCommand: `--stages material-gen --only ${shot.shotId} --max-attempts 2（去掉 --material-post-only/--accept-weak-material-motion）`
              },
              verdict: null, note: "带瑕疵放行：原始渲染运动不足，已用后期运镜增强补偿（显式留痕）"
            });
          }
          /**
           * 后期层（默认只保留**速度坡道**这一项剪辑手法；画面里的运镜必须由模型构建）：
           *   · `--material-speed-ramp`（默认开）：快起→稳行→快收，归一化回原时长——这是剪辑节奏，不是"把图动起来"；
           *   · `--material-post-camera-move`（默认**关**）：数字变焦 + 换景别切（应急手段）。
           * 产品所有者口径（2026-09-25）："图片只是实景素材参考，是用来构建真实视频场景的，不是简单做个运镜了事"——
           * 所以画面运动一律由模型构建（reference 模式 + 场景构建提示词），数字运镜不再默认参与出片。
           */
          const rampedClip = join(CLIP_DIR, `${shot.shotId}.ramped.mp4`);
          lastRamp = MATERIAL_SPEED_RAMP
            ? applySpeedRamp(rawClip, rampedClip, { durationSec: duration })
            : (() => {
              execFileSync("cp", [rawClip, rampedClip]);
              return { segments: [] as Array<{ from: number; to: number; speed: number }>, total: Number(Number(probe(rampedClip).duration ?? 0).toFixed(3)) };
            })();
          const cameraMove = MATERIAL_POST_CAMERA_MOVE
            ? applyCameraMovePunchCut(rampedClip, clip, { durationSec: duration, fps: FPS })
            : (() => {
              execFileSync("cp", [rampedClip, clip]);
              return {
                segments: [] as Array<{ from: number; to: number; zoom: [number, number]; panX: [number, number]; panY: [number, number]; ease: string }>,
                total: Number(Number(probe(clip).duration ?? 0).toFixed(3))
              };
            })();
          lastInfo = probe(clip);
          lastOutputSha = sha256FileSync(clip);
          const provenance = assertMaterialGenerationProvenance({
            renderTaskId, model: renderModel, sourceMaterialSha256: materialSha, outputSha256: lastOutputSha
          });
          lastReuse = measureMaterialReuse(clip, prepared, duration, shot.shotId);
          lastReuseVerdict = assessMaterialReuse(lastReuse.samples, { durationSec: duration });
          /**
           * 照片尾段止损（2026-09-26 真机 NC-02）：判出"尾段就是参考照片"后先尝试**裁尾段**再重测。
           * 只裁尾段、不整镜丢弃的前提：首次命中在中后段，且裁完仍保留 ≥55% 时长（否则就是拿素材凑数，直接判不合格）。
           */
          let photoTailTrim: { from: number; to: number; factor: number; keepSec: number; firstHitSec: number } | null = null;
          if (lastReuseVerdict.staticDisplay && MATERIAL_PHOTO_TAIL_TRIM) {
            for (let trimAttempt = 1; trimAttempt <= 2 && lastReuseVerdict.staticDisplay; trimAttempt += 1) {
              const firstHit = lastReuseVerdict.firstHitSec;
              const minKeep = Math.max(0.9, duration * 0.55);
              if (firstHit === null || firstHit - 0.15 < minKeep) {
                log(`  ⛔ ${shot.shotId} 复用度命中但无法靠裁尾段止损（首次命中 ${firstHit === null ? "n/a" : `${firstHit.toFixed(2)}s`}，需保留 ≥${minKeep.toFixed(2)}s）`);
                break;
              }
              const keep = Number((firstHit - 0.15).toFixed(3));
              try {
                photoTailTrim = { ...trimMaterialPhotoTail(clip, keep, duration), keepSec: keep, firstHitSec: firstHit };
                lastOutputSha = sha256FileSync(clip);
                lastInfo = probe(clip);
                lastReuse = measureMaterialReuse(clip, prepared, duration, shot.shotId);
                lastReuseVerdict = assessMaterialReuse(lastReuse.samples, { durationSec: duration });
                log(`  ✂ ${shot.shotId} 照片尾段裁剪：切掉 ${keep.toFixed(2)}s 之后（首次命中 ${firstHit.toFixed(2)}s），剩余 ${keep.toFixed(2)}s 变速 ${photoTailTrim.factor.toFixed(3)}× 归一回 ${duration}s`
                  + `；重测 ${lastReuseVerdict.staticDisplay ? "仍判静态直出" : "已通过"}`);
              } catch (err) {
                log(`  ⚠ ${shot.shotId} 照片尾段裁剪失败：${err instanceof Error ? err.message : String(err)}`);
                break;
              }
            }
          }
          /** 场景构建判据：这一镜是"构建出来的视频场景"还是"参考图被推动"（material-scene/v1） */
          const independence = measureReferenceIndependence(clip, prepared, duration, shot.shotId);
          const independenceVerdict = assessReferenceIndependence(independence, REFERENCE_INDEPENDENCE_POLICY);
          lastMotion = measureMotionRichness(clip);
          {
            const rampOk = lastMotion.rampRatio >= MATERIAL_MOTION_POLICY.minRampRatio;
            lastRampVerdict = {
              rich: rampOk,
              detail: `坡道后成片：运动能量 平均 ${lastMotion.meanEnergy.toFixed(2)}／峰值 ${lastMotion.maxEnergy.toFixed(2)}`
                + ` · 速度坡道比 ${lastMotion.rampRatio.toFixed(2)}（下限 ${MATERIAL_MOTION_POLICY.minRampRatio}）`
                + `；坡道段 ${(lastRamp?.segments ?? []).map((s) => `${s.from}–${s.to}s @${s.speed.toFixed(2)}x`).join(" / ")}`
            };
          }
          const framesDir = join(WORK_DIR, "frames", PROJECT, shot.shotId);
          mkdirSync(framesDir, { recursive: true });
          const frameFiles: string[] = [];
          for (const [i, at] of [0.2, 1.6, 3.0, Math.max(0.6, duration - 0.4)].entries()) {
            const file = join(framesDir, `material-f${i + 1}.jpg`);
            run(FFMPEG, ["-y", "-ss", String(at), "-i", clip, "-frames:v", "1", "-vf", "scale=720:-2", "-q:v", "3", file]);
            frameFiles.push(file);
          }
          lastFrames = frameFiles;
          lastVerdict = await reviewStage({
            stage: "shot", projectId: PROJECT,
            artifacts: [
              { path: clip, kind: "video", bytes: Number(lastInfo.bytes ?? 0), probe: lastInfo },
              ...frameFiles.map((f) => ({ path: f, kind: "image" as const }))
            ],
            rubric: [
              "**运镜要够猛且有节奏**：镜头必须有明显的位移（推进/拉开/横摇/俯仰/升降/环绕）与速度变化（快起稳收或慢起快收），"
                + "像《土耳其瞭望塔》那样的运动片；只有自然元素微动、镜头几乎不动，判不合格",
              "真实三维视差：因镜头位移，前景与远景的相对位移明显不同（不是整幅画面一起平移/缩放的贴图感）",
              "真实地标保真：首帧里的真实地标/建筑形制、檐口层叠、匾额与文字标识、周边水域与地形关系在画面上保持不变（不得被改造、臆造或增删构件）",
              "不是静态直出：不允许「把素材照片放大/平移当镜头」的观感（画面出现全幅一致的位移/缩放痕迹即判不合格）",
              "画质与质感：写实摄影质感，无 AI 绘画感/塑料感，无结构畸变、无纹理重复、无穿模",
              "无文字与水印：画面内不得出现新增文字、字幕、LOGO、边框、角标"
            ],
            referenceImages: [prepared],
            deterministic: [
              { id: "duration", pass: Math.abs(Number(lastInfo.duration ?? 0) - duration) <= 0.6, detail: `期望 ${duration}s 实测 ${Number(lastInfo.duration ?? 0).toFixed(2)}s`, hard: true },
              { id: "resolution", pass: Number(lastInfo.width ?? 0) >= 720 && Number(lastInfo.height ?? 0) >= 720, detail: `${lastInfo.width}x${lastInfo.height}`, hard: true },
              { id: "audio-track", pass: Boolean(lastInfo.hasAudio), detail: lastInfo.hasAudio ? `音轨 ${lastInfo.acodec}` : "缺音轨（配音环节会补旁白）", hard: false },
              { id: "generation-provenance", pass: provenance.ok, detail: provenance.detail, hard: true },
              { id: "not-static-display", pass: !lastReuseVerdict.staticDisplay, detail: `素材复用度：${lastReuseVerdict.detail}（候选窗口 ${lastReuse.candidates} 个）`, hard: true },
              {
                id: "scene-constructed",
                pass: independenceVerdict.independent,
                detail: `${independenceVerdict.detail}（候选窗口 ${independence.candidates} 个；口径 ${MATERIAL_SCENE_POLICY_VERSION}）`,
                hard: true
              },
              {
                id: "motion-richness",
                pass: lastMotionVerdict.rich || ACCEPT_WEAK_MOTION.includes(shot.shotId),
                detail: `原始渲染：${lastMotionVerdict.detail}`
                  + (lastMotionVerdict.rich ? "" : "（**显式放行**：额度受限，后期运镜增强已应用，详见 material-motion-acknowledge 记录）"),
                hard: true
              },
              { id: "speed-ramp", pass: lastRampVerdict.rich, detail: lastRampVerdict.detail, hard: true }
            ],
            context: {
              shotId: shot.shotId, scene: shot.scene, motion: spec.motion ?? null,
              policy: MATERIAL_POLICY_STATEMENT,
              motionMeasured: lastMotion,
              rawMotionMeasured: lastRawMotion,
              cameraMove,
              speedRamp: lastRamp,
              discipline: "这是**由真实素材生成**的镜头：判「运镜是否有力度与节奏」「地标是否被改造」"
                + "「画面是否只是把素材平移缩放」，不要以「缺少 AI 感」为由打回。"
            },
            env: ENV, allowFallbackApprove: ALLOW_FALLBACK_APPROVE, log
          });
          const verifyGate = recordGate({
            stepKey: "material-generate",
            sourceStage: "material-gen",
            shotIds: [shot.shotId],
            checks: [
              { id: "generation-provenance", pass: provenance.ok, hard: true, detail: provenance.detail },
              { id: "not-static-display", pass: !lastReuseVerdict.staticDisplay, hard: true, detail: lastReuseVerdict.detail },
              {
                id: "scene-constructed", pass: independenceVerdict.independent, hard: true,
                detail: independenceVerdict.detail
              },
              {
                id: "motion-richness",
                pass: lastMotionVerdict.rich || ACCEPT_WEAK_MOTION.includes(shot.shotId),
                hard: true,
                detail: lastMotionVerdict.detail
              },
              { id: "speed-ramp", pass: lastRampVerdict.rich, hard: true, detail: lastRampVerdict.detail },
              { id: "fidelity-reviewed", pass: lastVerdict.approved || Boolean(lastVerdict.degraded), hard: false, detail: lastVerdict.approved ? "监制保真评审放行" : `监制未放行（${lastVerdict.reason.slice(0, 80)}）` }
            ],
            softApproved: lastVerdict.approved, via: lastVerdict.via, score: lastVerdict.score,
            evidence: {
              mode: "verify", attempt: usedAttempt, material: photo, materialSha256: materialSha, outputSha256: lastOutputSha,
              taskId: renderTaskId, model: renderModel, reuseSamples: lastReuse.samples,
              reuseVerdict: lastReuseVerdict.detail, photoTailTrim,
              motion: lastMotion, rawMotion: lastRawMotion, speedRamp: lastRamp, cameraMove,
              note: "素材镜复检口径：生成溯源 + 复用度实测 + **运动强度/速度坡道实测** + 监制"
            }
          });
          accepted = lastVerdict.approved && verifyGate.approved;
          void lastRampVerdict;
          record({
            stage: "material-gen", shotId: shot.shotId, invoked: true, ok: accepted, cached: false,
            degraded: lastVerdict.degraded, attempt: usedAttempt, ms: Date.now() - shotStarted, artifact: clip,
            evidence: {
              ...lastInfo, taskId: renderTaskId, model: renderModel, material: photo, materialSha256: materialSha,
              outputSha256: lastOutputSha, raw: rawClip, promptChars: attemptPrompt.trim().length, reuse: lastReuse.samples,
              reuseVerdict: lastReuseVerdict.detail, motion: lastMotion, rawMotion: lastRawMotion,
              motionVerdict: lastMotionVerdict.detail, rampVerdict: lastRampVerdict.detail,
              speedRamp: lastRamp, cameraMove, frames: frameFiles, photoTailTrim
            }, verdict: lastVerdict,
            note: accepted
              ? `素材镜（图生视频 + 速度坡道；原始运动 ${lastRawMotion.meanEnergy.toFixed(1)}／坡道比 ${lastMotion.rampRatio.toFixed(2)}；复用度峰值 ${lastReuseVerdict.worst === null ? "n/a" : `${lastReuseVerdict.worst.toFixed(1)}dB`}`
                + `${photoTailTrim ? `；照片尾段已裁除 ${photoTailTrim.firstHitSec.toFixed(2)}s→${photoTailTrim.keepSec.toFixed(2)}s` : ""}）`
              : `第 ${usedAttempt} 次未过（${lastMotionVerdict.rich ? "" : "运动不足；"}${lastVerdict.approved ? "" : `监制：${lastVerdict.reason.slice(0, 60)}`}）`
          });
          if (!accepted && usedAttempt < attempts) {
            log(`  ↻ ${shot.shotId} 运镜未达标（${lastMotionVerdict.detail}）→ 升级运动强度重渲`);
          }
        } catch (err) {
          record({
            stage: "material-gen", shotId: shot.shotId, invoked: true, ok: false, cached: false, degraded: false, attempt: usedAttempt,
            ms: Date.now() - shotStarted, artifact: null,
            evidence: { error: err instanceof Error ? err.message.slice(0, 300) : String(err), attempt: usedAttempt }, verdict: null
          });
        }
      }
      if (!accepted) log(`  ⚠ ${shot.shotId} 素材镜 ${usedAttempt} 次尝试仍未达标：${lastMotionVerdict.detail}`);
    } catch (err) {
      record({
        stage: "material-gen", shotId: shot.shotId, invoked: true, ok: false, cached: false, degraded: false, attempt: 1,
        ms: Date.now() - shotStarted, artifact: null,
        evidence: { error: err instanceof Error ? err.message.slice(0, 300) : String(err) }, verdict: null
      });
    }
  }
  if (materialShots.length > 0) log(`素材镜：${materialShots.length} 镜（生成输入 → 生成式镜头，禁止静态直出）`);
}


/* ---------- ③ 逐镜视频（监制：shot） ---------- */
if (STAGES.has("videos")) {
  /**
   * G7 预生产最终确认（step_key: g7-preproduction）。
   *
   * 位置：**关键帧全部放行之后、第一次提交渲染之前**。这是"花钱之前的最后一道门"：
   * 确认提示词稿与关键帧稿都齐备且都放行过，才允许把请求发给 Seedance。
   * 判据全部看**产物 + 历史裁决**（支持分段重跑：只跑 videos 时，plate/prompt 的放行记录在 stages.jsonl 里）。
   */
  const gateHistory = readStageHistory();
  /** 素材镜不产出文生关键帧，G7 的提示词/关键帧判据只对**生成镜**成立（素材镜由 G-MAT1 门管） */
  const promptReady = generatedShots.every((s) => {
    const file = join(PROMPT_DIR, `${s.shotId}.txt`);
    return existsSync(file) && readFileSync(file, "utf8").trim().length >= 1200;
  });
  const plateReady = generatedShots.every((s) => {
    const plate = join(PLATE_DIR, `${s.shotId}-plate.png`);
    return existsSync(plate) && statSync(plate).size > 50_000;
  });
  const promptApproved = historyApproved(gateHistory, "prompt-review") || historyApproved(records, "prompt-review");
  const plateApproved = generatedShots.every((s) => gateHistory.some((r) => r.stage === "keyframe" && r.shotId === s.shotId && r.ok));
  /**
   * 素材镜就绪判据（2026-09-25 口径修订）：**不是"有文件就行"**，而是要求
   * ① 片段在盘上；② G-MAT1 的 **verify 事件**存在（证明做过生成溯源 + 复用度实测 + 监制评审）。
   * 只看文件会把"静态直出的照片段"当成合格产物——这正是上一版翻车的地方。
   */
  const gateStepKeyOf = (r: Record<string, unknown>): string | null => String(
    (r as { stepKey?: unknown }).stepKey ?? ((r as { evidence?: { stepKey?: unknown } }).evidence?.stepKey) ?? ""
  ) || null;
  const gateShotIdsOf = (r: Record<string, unknown>): string[] => {
    const top = (r as { shotIds?: unknown }).shotIds;
    if (Array.isArray(top)) return top as string[];
    const inner = (r as { evidence?: { shotIds?: unknown } }).evidence?.shotIds;
    return Array.isArray(inner) ? (inner as string[]) : [];
  };
  const gateModeOf = (r: Record<string, unknown>): string | null => String(
    (r as { evidence?: { mode?: unknown } }).evidence?.mode ?? ""
  ) || null;
  const materialGateVerified = (shotId: string): boolean => [...gateHistory, ...records].some((r) => {
    const row = r as unknown as Record<string, unknown>;
    return r.stage === "gate" && gateStepKeyOf(row) === "material-generate"
      && gateModeOf(row) === "verify" && gateShotIdsOf(row).includes(shotId) && r.ok;
  });
  const materialReady = materialShots.every((s) => {
    const clip = join(CLIP_DIR, `${s.shotId}.mp4`);
    return existsSync(clip) && statSync(clip).size > 100_000 && materialGateVerified(s.shotId);
  });
  const micromotionReady = !STAGES.has("micromotion") || generatedShots.every((s) => String(s.action ?? "").includes("【微动作】"))
    || gateHistory.some((r) => r.stage === "micromotion" && r.ok);
  const g7 = recordGate({
    stepKey: "g7-preproduction",
    sourceStage: "keyframe",
    shotIds: shots.map((s) => s.shotId),
    checks: [
      { id: "prompt-files", pass: promptReady, hard: true, detail: promptReady ? `${generatedShots.length} 个生成镜提示词齐备且 ≥1200 字（另有 ${materialShots.length} 个素材镜走 material-gen 的动效提示词）` : "有生成镜缺提示词或字数不足 1200" },
      { id: "plate-files", pass: plateReady, hard: true, detail: plateReady ? `${generatedShots.length} 个生成镜关键帧齐备（>50KB）` : "有生成镜关键帧缺失或过小" },
      { id: "prompt-approved", pass: promptApproved, hard: true, detail: promptApproved ? "提示词环节有放行裁决（历史/本轮）" : "提示词环节无放行裁决" },
      { id: "plates-approved", pass: plateApproved, hard: true, detail: plateApproved ? "每镜关键帧均有放行裁决" : "有镜头关键帧未放行" },
      {
        id: "material-segments", pass: materialReady, hard: true,
        detail: materialReady
          ? `${materialShots.length} 个素材镜已产出且过 G-MAT1（生成溯源 + 非静态直出 + 保真评审）`
          : `有素材镜未产出或未过 G-MAT1（素材只作生成输入，禁止静态直出）`
      },
      { id: "micromotion-applied", pass: micromotionReady, hard: false, detail: micromotionReady ? "微动作增强已并入镜头卡（或本轮未启用）" : "镜头卡未见微动作增强标记" }
    ],
    evidence: { promptReady, plateReady, promptApproved, plateApproved, materialReady, micromotionReady }
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
  for (const shot of shots) {
    const clip = join(CLIP_DIR, `${shot.shotId}.mp4`);
    const duration = Number(shot.duration ?? 5);
    /**
     * 素材镜：片段已在 `material-gen` 阶段生成并过 G-MAT1（生成溯源 + 非静态直出 + 保真评审），
     * 这里不再走"生成镜复检/提交审批"（判据不同），但**必须**确认 G-MAT1 的 verify 事件在场。
     */
    if (isMaterialShot(shot)) {
      const verified = materialGateVerified(shot.shotId);
      record({
        stage: "shot", shotId: shot.shotId, invoked: false, ok: existsSync(clip) && verified, cached: true,
        degraded: !verified, attempt: 0, ms: 0,
        artifact: existsSync(clip) ? clip : null,
        evidence: {
          photo: String((shot as Record<string, unknown>).photo), source: "material-gen",
          materialGate: verified ? "G-MAT1 verify 事件在场" : "缺 G-MAT1 verify 事件",
          policy: MATERIAL_POLICY_VERSION, skipReason: "素材镜的生成与判据在 material-gen 阶段完成"
        },
        verdict: null,
        note: verified
          ? "素材镜：生成产物已过 G-MAT1（复用，不重复提交渲染）"
          : "素材镜：缺 G-MAT1 verify 事件（素材是否被当镜头用无法证明）"
      });
      continue;
    }
    const cached = RESUME && existsSync(clip) && statSync(clip).size > 100_000;
    /**
     * 复用产物**仍要过监制**（2026-09-24 真机修复）：
     * 早先缓存直接 `ok=true` 跳过评审，于是"上一轮被判打回的镜头"会因为文件在磁盘上而被放行。
     * 现在复用也要重跑确定性检查 + 视觉评审：过了才算真过，没过则照常重渲。
     */
    if (cached) {
      const info = probe(clip);
      const actual = Number(info.duration ?? 0);
      const settings = cachedShotSettings(shot);
      const verdict = await reviewStage({
        stage: "shot", projectId: PROJECT,
        artifacts: [{ path: clip, kind: "video", bytes: Number(info.bytes ?? 0), probe: info }, ...settings.frames.map((f) => ({ path: f, kind: "image" as const }))],
        deterministic: settings.checks,
        referenceImages: refs.slice(0, 2),
        context: { shotId: shot.shotId, dialogue: dialogueText(shot), action: shot.action, note: "复用既有成片的复检" },
        env: ENV, allowFallbackApprove: ALLOW_FALLBACK_APPROVE, log
      });
      record({
        stage: "shot", shotId: shot.shotId, invoked: true, ok: verdict.approved, cached: true, degraded: verdict.degraded,
        attempt: 1, ms: verdict.ms, artifact: clip, evidence: info, verdict,
        note: verdict.approved ? "复用既有产物（幂等）+ 复检通过" : "复用产物复检未过 → 重新渲染"
      });
      /**
       * G8 的**复用复核**（step_key: g8-render-submit，mode=recheck）：
       * 复用产物这次并没有真的"提交渲染"，但提交判据（提示词字数/无 f 值/画幅约束/时长/首帧锚点）
       * 仍然可以按当前产物复核一遍——审计要能看到"这一单当时满足提交条件"，而不是因为走了复用分支
       * 就完全查不到 G8。复核不通过只告警不拦截（复用是否放行由上面的 shot 复检决定）。
       */
      const reusePrompt = existsSync(join(PROMPT_DIR, `${shot.shotId}.txt`)) ? readFileSync(join(PROMPT_DIR, `${shot.shotId}.txt`), "utf8") : "";
      const plate = join(PLATE_DIR, `${shot.shotId}-plate.png`);
      const g8Recheck = recordGate({
        stepKey: "g8-render-submit",
        sourceStage: "shot",
        shotIds: [shot.shotId],
        checks: [
          { id: "prompt-length", pass: reusePrompt.trim().length >= 1200, hard: true, detail: `提示词 ${reusePrompt.trim().length} 字（交付口径 ≥1200）` },
          { id: "no-hard-params", pass: !/f\/\d/.test(reusePrompt), hard: true, detail: /f\/\d/.test(reusePrompt) ? "提示词正文出现 f 值（KB 纪律：正文只写画面语言）" : "正文不含 f 值等技术参数" },
          { id: "aspect-constraint", pass: /【约束】/.test(reusePrompt) && reusePrompt.includes(ASPECT), hard: true, detail: `含【约束】与画幅 ${ASPECT}` },
          { id: "duration-limit", pass: duration > 0 && duration <= 30, hard: true, detail: `单镜时长 ${duration}s（上限 30s）` },
          { id: "clip-on-disk", pass: existsSync(clip) && statSync(clip).size > 100_000, hard: true, detail: `成片片段 ${(statSync(clip).size / 1024 / 1024).toFixed(1)}MB` },
          { id: "plate-size", pass: !existsSync(plate) || statSync(plate).size > 50_000, hard: false, detail: existsSync(plate) ? `关键帧 ${(statSync(plate).size / 1024).toFixed(0)}KB` : "无关键帧文件" }
        ],
        evidence: { mode: "recheck", note: "复用产物复核：本次未向渲染服务提交", seconds: duration, cached: true }
      });
      if (!g8Recheck.approved) log(`  ⚠ ${shot.shotId} G8 复用复核存在未过项（复用放行以上方复检裁决为准）：${g8Recheck.reason.slice(0, 120)}`);
      if (verdict.approved) continue;
      log(`↻ ${shot.shotId} 既有成片复检未过（${verdict.reason}），重新渲染`);
      log(`  （复用判据：${actual.toFixed(2)}s / ${info.width}x${info.height}）`);
    }
    if (DRY_RUN) {
      record({ stage: "shot", shotId: shot.shotId, invoked: false, ok: true, cached: false, degraded: false, attempt: 0, ms: 0, artifact: null, evidence: { dryRun: true }, verdict: null });
      continue;
    }
    const plate = join(PLATE_DIR, `${shot.shotId}-plate.png`);
    const prompt = readFileSync(join(PROMPT_DIR, `${shot.shotId}.txt`), "utf8");
    let approved = false;
    /**
     * 重试必须「带变更」（2026-09-24 烧额度根因）：
     * 早先第 2 次尝试提交的是**与第 1 次完全相同的提示词**（只有 seed 不同），
     * 本质是"重采样碰运气"而不是修问题——SC-02 因此连烧 5 次渲染仍不过。
     * 现在把上一轮监制的 issues/suggestions 显式写进提示词，并记录提示词指纹，
     * 让日志能自证"这次重试确实改了东西"。
     */
    let lastVerdict: ProducerVerdict | null = null;
    for (let attempt = 1; attempt <= MAX_ATTEMPTS && !approved; attempt += 1) {
      const started = Date.now();
      const attemptPrompt = attempt === 1 ? prompt : `${prompt}\n\n${retryInstruction(lastVerdict, attempt, MAX_ATTEMPTS)}`;
      const promptFingerprint = createHash("sha256").update(attemptPrompt).digest("hex").slice(0, 12);
      try {
        /**
         * 首帧必须用**Ark 托管 URL**（同账号模型产物），不能是 base64：
         * 真机实测 base64 真人图会被隐私校验拒（见 `hostedUrlFile` 注释与探针脚本）。
         * 托管 URL 过期（>20h）时退回 base64 并如实记录——让监制看到这是降级路径，而不是假装成功。
         */
        const hosted = loadHostedUrl(shot.shotId);
        const firstFrame = hosted ?? (existsSync(plate) ? dataUrl(plate) : undefined);
        if (!hosted && existsSync(plate)) {
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
            { id: "first-frame", pass: Boolean(hosted) || existsSync(plate), hard: true, detail: hosted ? `首帧用 Ark 托管 URL（${basename(hosted)}）` : existsSync(plate) ? "首帧退回本地关键帧 base64（隐私校验风险，已记录）" : "既无托管 URL 也无关键帧" },
            { id: "plate-size", pass: !existsSync(plate) || statSync(plate).size > 50_000, hard: false, detail: existsSync(plate) ? `关键帧 ${(statSync(plate).size / 1024).toFixed(0)}KB` : "无关键帧文件" }
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
        const submitted = await arkVideo({
          prompt: attemptPrompt,
          firstFrame,
          refs: refs.map(dataUrl),
          /** 同素材镜：Seedance 时长下限 4s → 先渲染合法时长，再变速归一化到分镜时长 */
          seconds: renderSecondsFor(duration),
          generateAudio: ENV.SEEDANCE_GENERATE_AUDIO !== "0",
          seed: 20260924 + attempt
        });
        await download(submitted.url, clip);
        /**
         * 渲染时长 ≠ 分镜时长时的变速归一化（快剪片常态：分镜 2–4.5s，而模型下限 4s）：
         * 不截断（截断会丢动作），而是整段变速到目标时长——短镜变快、长镜变慢，节奏更可控。
         */
        const normalized = normalizeClipDuration(clip, `${clip}.norm.mp4`, duration);
        execFileSync("mv", [`${clip}.norm.mp4`, clip]);
        log(`  ⇄ ${shot.shotId} 时长归一：渲染 ${normalized.from}s → 目标 ${normalized.to}s（×${normalized.factor}）`);
        const info = probe(clip);
        const actual = Number(info.duration ?? 0);
        const height = Number(info.height ?? 0);
        const width = Number(info.width ?? 0);
        /**
         * 抽帧 + 动作证据（2026-09-24 SC-02 badcase 修复）：
         * 早先只抽 3 帧（0.6 / 中段 / 末段），监制无法判断"有没有在走动/挥手"，
         * 只能以"手部摆动与步态证据不足"打回（fail-closed）。现在：
         *   · 抽 4 帧给监制看（0.5 / 1.8 / 3.2 / 4.5）；
         *   · 另抽 8 帧算**画面运动能量**（相邻帧中心区平均绝对差），把"有没有动"变成数字证据；
         *   · 当分镜要求走/挥手/移动而运动能量过低时，判为硬失败（动作没做出来）。
         */
        const framesDir = join(WORK_DIR, "frames", PROJECT, shot.shotId);
        mkdirSync(framesDir, { recursive: true });
        const frameFiles: string[] = [];
        for (const [i, at] of [0.5, 1.8, 3.2, Math.max(0.6, duration - 0.5)].entries()) {
          /**
           * 评审帧压缩（2026-09-24 三轮审计）：全分辨率 PNG（1080×1920，单张 1–2MB）四张一起送审，
           * base64 后 ≈11MB → 评审模型直接 **HTTP 413**（payload too large）→ 监制不可用。
           * 改成 720 宽 JPEG（质量 82，单张 ≈100KB），肉眼足够判断动作/表情/一致性。
           */
          const file = join(framesDir, `f${i + 1}.jpg`);
          run(FFMPEG, ["-y", "-ss", String(at), "-i", clip, "-frames:v", "1", "-vf", "scale=720:-2", "-q:v", "3", file]);
          frameFiles.push(file);
        }
        const motion = measureMotionEnergy(clip, duration);
        const expectsMotion = /走|步行|漫步|挥|摆|蹲|起身|跑|turn|walk/i.test(String(shot.action ?? ""));
        const verdict = await reviewStage({
          stage: "shot", projectId: PROJECT,
          artifacts: [
            { path: clip, kind: "video", bytes: Number(info.bytes ?? 0), probe: info },
            ...frameFiles.map((f) => ({ path: f, kind: "image" as const }))
          ],
          deterministic: [
            { id: "duration", pass: Math.abs(actual - duration) <= 0.6, detail: `期望 ${duration}s 实测 ${actual.toFixed(2)}s`, hard: true },
            { id: "resolution", pass: height >= 720 && width >= 720, detail: `${width}x${height}`, hard: true },
            { id: "audio-track", pass: Boolean(info.hasAudio), detail: info.hasAudio ? `音轨 ${info.acodec}` : "无音轨（配乐环节可兜底，但人声缺失需复核）" },
            {
              id: "motion-evidence",
              pass: !expectsMotion || motion.energy >= 2.5,
              /**
               * 只做软证据（不跨景别当硬闸）：实测同一批片子里，
               * "走近"镜运动能量 5.79/255，而静物特写 12.48/255——近景/特写的像素级微动天然更高，
               * 绝对值不能跨景别比较。只有低到近乎全程静止（<0.8）才升级为硬失败。
               */
              hard: expectsMotion && motion.energy < 0.8,
              detail: `画面运动能量 ${motion.energy.toFixed(2)}/255（峰值帧 ${motion.peakAt.toFixed(1)}s，期望动作=${expectsMotion ? "是" : "否"}）`
                + (expectsMotion && motion.energy < 2.5 ? "：动作幅度偏低，可能是「站着念完」而非分镜要求的走/挥手" : "")
            }
          ],
          referenceImages: refs.slice(0, 2),
          context: { shotId: shot.shotId, dialogue: dialogueText(shot), action: shot.action, taskId: submitted.taskId },
          env: ENV, allowFallbackApprove: ALLOW_FALLBACK_APPROVE, log
        });
        record({
          stage: "shot", shotId: shot.shotId, invoked: true, ok: verdict.approved, cached: false, degraded: verdict.degraded,
          attempt, ms: Date.now() - started, artifact: clip,
          evidence: {
            ...info, taskId: submitted.taskId, frames: frameFiles,
            promptVariant: attempt === 1 ? "base" : "retry-with-feedback",
            promptFingerprint
          }, verdict
        });
        approved = verdict.approved;
        if (!approved) lastVerdict = verdict;
        if (!approved) log(`↻ 镜头 ${shot.shotId} 第 ${attempt} 次未过监制：${verdict.reason}`);
        /**
         * 监制不可用 ≠ 产物不合格（2026-09-24 真机：评审请求 413 → 系统连渲两次）：
         * 评审侧故障（fallback 且无硬失败）时**不应重渲**——重渲既修不了故障、又白烧额度。
         * 此时保留本次产物、标注 degraded，交给下一次复检或人工裁决。
         */
        const judgeUnavailable = !approved && verdict.via === "fallback" && (verdict.hardFailures ?? []).length === 0;
        if (judgeUnavailable) {
          log(`⏸ ${shot.shotId} 监制不可用（${verdict.reason.slice(0, 80)}）→ 不再重渲，保留本次产物待复检`);
          record({
            stage: "shot", shotId: shot.shotId, invoked: true, ok: false, cached: false, degraded: true, attempt,
            ms: Date.now() - started, artifact: clip, evidence: { ...info, taskId: submitted.taskId, frames: frameFiles, judgeUnavailable: true }, verdict,
            note: "监制不可用：不重渲（避免为评审故障付费），产物保留待复检"
          });
          break;
        }
      } catch (err) {
        record({
          stage: "shot", shotId: shot.shotId, invoked: true, ok: false, cached: false, degraded: false, attempt,
          ms: Date.now() - started, artifact: null, evidence: { error: err instanceof Error ? err.message.slice(0, 300) : String(err) }, verdict: null
        });
      }
    }
    if (!approved) log(`⛔ 镜头 ${shot.shotId} 重跑 ${MAX_ATTEMPTS} 次仍未过监制`);
  }
}

/* ---------- ③-2 配音 / 旁白（step_key: voice，2026-09-25 产品所有者点名修复） ---------- */
/**
 * 事故：滕王阁样片的**中间四镜只有字幕、没有台词播报**（真实素材镜是静音段 + 字幕），
 * 观众看到画面在动、字在跳，却没有人声——产品所有者当场指出"这是硬伤"。
 *
 * 本阶段把"每一句台词都要有人声"变成可验证的门：
 *   ① 逐镜做**人声核查**（本地 ASR + 语音频段活动度）：既看"有没有说话"，也看"说的是不是这句台词"；
 *   ② 没有人声的镜头用**本机 TTS**补旁白（`voice-cli dub`：时窗对齐 + 原声让位 + 视频轨 copy）；
 *   ③ 补完**再核查一次**（无回执不算完成），结果写进阶段日志供终审按镜检索。
 *
 * 判据（`active_ratio` 与 `match_ratio` 双条件）来自真机实测：
 *   · 有模型人声的镜：SC-01 active=0.538 / match=1.0、SC-06 active=0.421 / match=0.889；
 *   · 纯环境音的素材镜：SC-02/04/05 active=0.000 / match≈0（Whisper 对非人声还会"编"出一句套话，
 *     所以**只看 ASR 文本会误判**，必须叠加语音频段活动度这一条硬条件）。
 */
const NARRATION_PROFILE = arg("--narration-profile", "zh-xiaozhi");
/**
 * 台词匹配阈值（2026-09-25 复核后收敛）：
 * ASR 对**专有名词与数字**的误听是已知现象（真机："一篇滕王阁序，火了1300年" 被转成
 * "一片藤王閣序火了煙三百年"，逐字比对只有 0.46），拿它当"有没有说话"的硬判据会误杀。
 * 因此：**能听清（活动度）** 是硬条件，**内容大致一致（≥0.45）** 是软硬结合的第二条件，
 * 并且 TTS 补旁白这条路会额外记录"合成文本指纹"——内容由构造保证，ASR 只作可听性核查。
 */
const SPEECH_MATCH_MIN = Number(arg("--speech-match-min", "0.45"));
const SPEECH_ACTIVE_MIN = Number(arg("--speech-active-min", "0.25"));

interface SpeechReport {
  ok: boolean;
  matchRatio: number | null;
  activeRatio: number | null;
  segments: number | null;
  transcript: string | null;
  detail: string;
}

/**
 * 人声核查（本地 ASR + 语音频段活动度）。
 * `--min-match 0` 是为了拿到数值而不是让工位直接抛错；`--no-strict` 是为了让**响度/真峰值**
 * 这类交付项不干扰"有没有人声"的判断（真机：SC-04 因 -0.69dBTP 让核查返回空值，误判成"没人声"）。
 */
function checkSpeech(file: string, expectText: string): SpeechReport {
  const res = runCli(VOICE_CLI, ["verify", "--in", file, "--expect-text", expectText, "--min-match", "0", "--no-strict"]);
  if (!res.ok) {
    return { ok: false, matchRatio: null, activeRatio: null, segments: null, transcript: null, detail: `配音工位调用失败：${res.out.slice(-200)}` };
  }
  let checked: Record<string, unknown> = {};
  try {
    checked = ((JSON.parse(res.out) as { result?: { checked?: Record<string, unknown> } }).result?.checked) ?? {};
  } catch {
    return { ok: false, matchRatio: null, activeRatio: null, segments: null, transcript: null, detail: `核验输出不是 JSON：${res.out.slice(-120)}` };
  }
  const num = (value: unknown): number | null => (typeof value === "number" && Number.isFinite(value) ? value : null);
  const matchRatio = num(checked.match_ratio);
  const activeRatio = num(checked.active_ratio);
  const segments = num(checked.speech_segments);
  const transcript = typeof checked.asr_text === "string" ? checked.asr_text : null;
  /**
   * 判据交给 `speechAcceptance`（T-2026-0926-0121 真机修复）：
   * **强匹配（转写与台词对得上）时不得因活动度偏低而补旁白**——否则 TTS 会叠在原声上，
   * 同一句被说两遍（真机 VID-GR01 第 1 镜：匹配 1.000 / 活动度 0.228 → 转写变成两句重复）。
   */
  const verdict = speechAcceptance({ matchRatio, activeRatio, matchMin: SPEECH_MATCH_MIN, activeMin: SPEECH_ACTIVE_MIN });
  const ok = verdict.ok;
  const detail = `人声活动度 ${activeRatio === null ? "未测到" : activeRatio.toFixed(3)}（下限 ${SPEECH_ACTIVE_MIN}）`
    + ` · 台词匹配 ${matchRatio === null ? "未测到" : matchRatio.toFixed(3)}（下限 ${SPEECH_MATCH_MIN}）`
    + ` · 语音段 ${segments ?? "?"} · 转写 ${transcript === null ? "无" : `「${transcript.slice(0, 40)}」`}`
    + `｜判据：${verdict.reason}`;
  return { ok, matchRatio, activeRatio, segments, transcript, detail };
}

/** 配音产物路径（旁白混入后的镜头段；原片只读，不覆盖 `<shotId>.mp4`） */
function voicedFile(shotId: string): string {
  return join(CLIP_DIR, `${shotId}.voiced.mp4`);
}
/**
 * 合成用片段：配音版比原片段新时优先（原始片段保持只读，符合配音围栏"原片只读 + 新文件"口径）。
 */
function clipFor(shot: ShotCard): string {
  const raw = join(CLIP_DIR, `${shot.shotId}.mp4`);
  const voiced = voicedFile(shot.shotId);
  if (existsSync(voiced) && (!existsSync(raw) || statSync(voiced).mtimeMs >= statSync(raw).mtimeMs)) return voiced;
  return raw;
}

/** 逐镜人声覆盖情况（终审门按这份清单判"每句台词都有人声"） */
const narrationCoverage: Array<{ shotId: string; speaker: string; text: string; ok: boolean; source: string; detail: string }> = [];

if (STAGES.has("voice")) {
  const started = Date.now();
  if (!existsSync(VOICE_CLI)) {
    log(`⛔ 配音工位不存在：${VOICE_CLI}（语音阶段无法执行）`);
    record({
      stage: "voice", shotId: null, invoked: false, ok: false, cached: false, degraded: false, attempt: 1, ms: 0,
      artifact: null, evidence: { missing: VOICE_CLI }, verdict: null, note: "配音工位缺失：人声核查无法执行"
    });
  } else {
    for (const shot of shots) {
      const raw = join(CLIP_DIR, `${shot.shotId}.mp4`);
      const text = dialogueText(shot);
      const speaker = String((shot.dialogue ?? [])[0]?.speaker ?? "旁白");
      if (!existsSync(raw)) {
        narrationCoverage.push({ shotId: shot.shotId, speaker, text, ok: false, source: "missing-clip", detail: "镜头片段不存在" });
        record({
          stage: "voice", shotId: shot.shotId, invoked: false, ok: false, cached: false, degraded: false, attempt: 1, ms: 0,
          artifact: null, evidence: { missing: raw }, verdict: null, note: "缺镜头片段：无法做人声核查"
        });
        continue;
      }
      if (!text) {
        record({
          stage: "voice", shotId: shot.shotId, invoked: false, ok: true, cached: false, degraded: false, attempt: 1, ms: 0,
          artifact: raw, evidence: { dialogue: false }, verdict: null, note: "本镜无台词：人声门不适用（空镜/纯音乐段）"
        });
        continue;
      }
      const shotStarted = Date.now();
      const before = checkSpeech(raw, text);
      if (before.ok) {
        narrationCoverage.push({ shotId: shot.shotId, speaker, text, ok: true, source: "clip-audio", detail: before.detail });
        record({
          stage: "voice", shotId: shot.shotId, invoked: true, ok: true, cached: true, degraded: false, attempt: 1,
          ms: Date.now() - shotStarted, artifact: raw,
          evidence: { source: "clip-audio", matchRatio: before.matchRatio, activeRatio: before.activeRatio, transcript: before.transcript },
          verdict: null, note: `人声核查通过（${before.detail}）`
        });
        continue;
      }
      /**
       * 复用上轮配音版（分段重跑友好）：`<shot>.voiced.mp4` 已过核查就不再重复合成 TTS。
       * 判据仍然是**产物核查**（不是"文件在就算数"）——配音版没通过就照常重做。
       * 但**换音色必须重做**（2026-09-25 产品所有者反馈"中间镜与首位音色不一样、很割裂"）：
       * 旁白音色变了却复用旧文件，等于把旧音色又发一遍，所以这里比对上次记录的 profile。
       */
      const existingVoiced = voicedFile(shot.shotId);
      /**
       * 音色比对要取**最近一次真的做过 TTS 合成**的那条记录（它才有 `profile`）。
       * 早先取"最后一条成功记录"：而复用路径本身不写 profile → 读到 null → 判定"没换音色" → 复用了旧音色
       * （真机抓到：`zh-xiaozhi` 的旧旁白被当成新音色的产物继续用，产品所有者听到的仍是两把声音）。
       */
      const lastVoiceProfile = [...readStageHistory(), ...records]
        .filter((r) => r.stage === "voice" && r.shotId === shot.shotId)
        .map((r) => (r.evidence as { profile?: string } | undefined)?.profile)
        .filter((value): value is string => Boolean(value))
        .at(-1) ?? null;
      const profileChanged = Boolean(lastVoiceProfile && lastVoiceProfile !== NARRATION_PROFILE);
      if (profileChanged) {
        log(`  ↻ ${shot.shotId} 旁白音色变更（${lastVoiceProfile} → ${NARRATION_PROFILE}）→ 重新配音`);
      }
      if (existsSync(existingVoiced) && existingVoiced !== raw && !profileChanged) {
        const reused = checkSpeech(existingVoiced, text);
        if (reused.ok) {
          narrationCoverage.push({ shotId: shot.shotId, speaker, text, ok: true, source: "voiced-reuse", detail: reused.detail });
          record({
            stage: "voice", shotId: shot.shotId, invoked: true, ok: true, cached: true, degraded: false, attempt: 1,
            ms: Date.now() - shotStarted, artifact: existingVoiced,
            evidence: {
              source: "voiced-reuse", matchRatio: reused.matchRatio, activeRatio: reused.activeRatio,
              transcript: reused.transcript,
              /** 复用也要带上"这份产物当初是用哪把音色合成的"，否则下一轮无法判断音色有没有变 */
              profile: lastVoiceProfile ?? NARRATION_PROFILE, profileInherited: true
            },
            verdict: null, note: `复用上轮配音版并通过核查（${reused.detail}）`
          });
          continue;
        }
      }
      if (DRY_RUN) {
        narrationCoverage.push({ shotId: shot.shotId, speaker, text, ok: false, source: "dry-run", detail: before.detail });
        record({
          stage: "voice", shotId: shot.shotId, invoked: false, ok: false, cached: false, degraded: true, attempt: 1, ms: 0,
          artifact: null, evidence: { dryRun: true, before }, verdict: null, note: "dry-run：未补旁白"
        });
        continue;
      }
      log(`  ⚠ ${shot.shotId} 人声核查未过（${before.detail.slice(0, 90)}）→ 补旁白（音色 ${NARRATION_PROFILE}）`);
      const out = voicedFile(shot.shotId);
      const dub = runCli(VOICE_CLI, [
        "dub", "--in", raw, "--out", out, "--profile", NARRATION_PROFILE,
        "--text", text, "--policy", "keep-dialogue", "--lufs", "-16"
      ]);
      const produced = existsSync(out);
      const after = produced ? checkSpeech(out, text) : before;
      /**
       * 重复播报防线（真机同因）：补旁白是"叠"在原声之上，若原声本已说对，
       * 复核转写就会出现两遍 → 判本次补旁白失败并**放弃配音产物**（回退原片，绝不交付"说了两遍"的音频）。
       */
      const doubled = produced && isDoubledNarration(after.transcript, text);
      const ok = produced && after.ok && !doubled;
      if (doubled && existsSync(out)) {
        rmSync(out, { force: true });
        log(`  ⚠ ${shot.shotId} 补旁白后出现重复播报（同一句两次）→ 放弃配音产物，回退原片`);
      }
      /** 合成文本指纹：TTS 的输入就是台词原文 → 内容一致性由构造保证（ASR 只作可听性核查） */
      const ttsTextSha256 = createHash("sha256").update(text).digest("hex").slice(0, 16);
      narrationCoverage.push({
        shotId: shot.shotId, speaker, text, ok,
        source: ok ? "tts-narration" : (doubled ? "tts-doubled-fallback" : "tts-failed"),
        detail: ok
          ? after.detail
          : (doubled
            ? `补旁白出现重复播报（同一句两次）→ 已放弃配音产物并回退原片：${after.detail}`
            : `补旁白${produced ? "后仍未通过" : "未产出"}：${after.detail}`)
      });
      record({
        stage: "voice", shotId: shot.shotId, invoked: true, ok, cached: false, degraded: !ok, attempt: 1,
        ms: Date.now() - shotStarted, artifact: produced && !doubled ? out : null,
        evidence: {
          source: "tts-narration", profile: NARRATION_PROFILE, policy: "keep-dialogue", doubled,
          ttsTextSha256, ttsText: text,
          before: { matchRatio: before.matchRatio, activeRatio: before.activeRatio, transcript: before.transcript },
          after: { matchRatio: after.matchRatio, activeRatio: after.activeRatio, transcript: after.transcript },
          toolOutput: dub.out.slice(-300)
        },
        verdict: null,
        note: ok
          ? `已补旁白并通过复核（${after.detail}）`
          : (doubled
            ? "重复播报防线命中：同一句被补旁白叠成两遍，已删除配音产物并回退原片（不交付重复音频）"
            : `补旁白未通过复核：${after.detail}`)
      });
      if (!ok) log(`  ⛔ ${shot.shotId} 补旁白后仍未通过人声核查：${after.detail}`);
    }
    const covered = narrationCoverage.filter((entry) => entry.ok).length;
    const total = narrationCoverage.length;
    log(`配音/旁白：${covered}/${total} 镜有可用人声（音色 ${NARRATION_PROFILE}）`);
    record({
      stage: "voice-summary", shotId: null, invoked: true, ok: covered === total && total > 0, cached: false,
      degraded: covered !== total, attempt: 1, ms: Date.now() - started, artifact: null,
      evidence: { covered, total, profile: NARRATION_PROFILE, perShot: narrationCoverage },
      verdict: null,
      note: covered === total ? "每句台词都有人声" : `有 ${total - covered} 镜缺人声（终审门会拦下）`
    });
  }
}

/* ---------- ④ 合成母版 ---------- */
let master = join(POST_DIR, "master-raw.mp4");
if (STAGES.has("compose")) {
  const started = Date.now();
  /**
   * 镜头顺序不变量（2026-09-26）：成片顺序默认必须**等于分镜顺序**——
   * 镜头之间有内容逻辑顺序，后期不许为卡点/情绪重排；素材来自媒资库时走 reuse-assembly 并给依据。
   * 这里把"顺序"做成显式判据 + 阶段证据，未来任何"排在前面/后面"的改动都会被这一关拦下。
   */
  const storyboardOrder = shots.map((s) => s.shotId);
  const requestedOrder = COMPOSE_ORDER
    ? COMPOSE_ORDER.split(",").map((value) => value.trim()).filter(Boolean)
    : storyboardOrder;
  const clipById = new Map(shots.map((s) => [s.shotId, clipFor(s)]));
  const orderCheck = checkShotOrder(storyboardOrder, requestedOrder, ORDER_POLICY, { reusePlan: REUSE_PLAN });
  if (!orderCheck.ok) {
    log(`⛔ 镜头顺序判据不通过：${orderCheck.detail}`);
    record({
      stage: "compose-order", shotId: null, invoked: true, ok: false, cached: false, degraded: false, attempt: 1, ms: 0,
      artifact: null,
      evidence: { policy: ORDER_POLICY, expected: orderCheck.expected, actual: orderCheck.actual, firstDivergence: orderCheck.firstDivergence },
      verdict: null, note: "后期不得重排镜头（内容逻辑顺序）；确需重排请走 --order-policy reuse-assembly + --reuse-plan"
    });
  } else if (ORDER_POLICY === "reuse-assembly") {
    log(`↻ 镜头顺序：媒资库复用路径（reuse-assembly）—— ${orderCheck.detail}`);
  }
  /** 合成用片段：优先取配音版（旁白已混入），原始片段保持只读 */
  const clips = orderCheck.ok
    ? requestedOrder.map((shotId) => clipById.get(shotId)!).filter(Boolean)
    : [];
  const missing = clips.filter((c) => !existsSync(c));
  /**
   * 带瑕疵放行审计：被监制打回、又出现在 `--accept-rejected` 里的镜头，
   * 合成时要写一条 explicit 记录（不得静默拼进母版）。
   */
  const unapproved = shots
    .filter((s) => {
      const shotRecords = records.filter((r) => r.stage === "shot" && r.shotId === s.shotId && r.invoked);
      return shotRecords.length > 0 && !shotRecords.some((r) => r.ok);
    })
    .map((s) => s.shotId);
  const acceptedWithFlaw = unapproved.filter((id) => ACCEPT_REJECTED.includes(id));
  const blocked = unapproved.filter((id) => !ACCEPT_REJECTED.includes(id));
  if (acceptedWithFlaw.length > 0) {
    log(`⚠ 监制已知悉放行（带瑕疵入片）：${acceptedWithFlaw.join("、")} —— 详见阶段日志的 verdict.issues`);
    record({
      stage: "compose-acknowledge", shotId: null, invoked: true, ok: true, cached: false, degraded: true, attempt: 1, ms: 0,
      artifact: null,
      evidence: { acceptedWithFlaw, reason: "客观条件不允许重跑（见阶段日志），经显式 --accept-rejected 确认后拼入母版" },
      verdict: null, note: "带瑕疵放行（非静默）"
    });
  }
  if (blocked.length > 0) {
    log(`⛔ 以下镜头被监制打回且未显式放行，合成中止：${blocked.join("、")}（如确需拼入，请显式 --accept-rejected ${blocked.join(",")}）`);
    record({
      stage: "compose", shotId: null, invoked: false, ok: false, cached: false, degraded: false, attempt: 1, ms: 0,
      artifact: null, evidence: { blocked }, verdict: null, note: "监制未放行镜头阻塞合成"
    });
  }
  if (missing.length > 0 || blocked.length > 0) {
    record({ stage: "compose", shotId: null, invoked: false, ok: false, cached: false, degraded: false, attempt: 1, ms: 0, artifact: null, evidence: { missing }, verdict: null, note: "缺镜头产物，跳过合成" });
  } else {
    const [w, h] = RESOLUTION === "1080p" ? (ASPECT === "9:16" ? [1080, 1920] : [1920, 1080]) : [720, 1280];
    const result = runCli(join(REPO_ROOT, "scripts/tools/compose-film.mts"), [
      "--clips", clips.join(","), "--out", master, "--width", String(w), "--height", String(h),
      "--fps", String(FPS), "--fade", String(XFADE), "--color", "none",
      /**
       * 逐刀转场（2026-09-25）：`--cut-transition` 指定 xfade 名（默认 `hblur` ≈ 甩镜拖影）、
       * `--cut-transition-duration` 指定秒数（默认 0.18）。传空字符串 = 纯硬切。
       */
      ...(CUT_TRANSITION ? ["--transition", CUT_TRANSITION, "--transition-duration", String(CUT_TRANSITION_DURATION)] : [])
      , ...(CUT_TRANSITION && CUT_TRANSITION_AT ? ["--transition-at", CUT_TRANSITION_AT] : [])
      /**
       * 时长目标 = **分镜总时长 − 转场重叠量**（2026-09-25 南昌片真机修正）：
       * 早先这里传的是分镜总时长本身，转场吃掉 2.4s 后又把整片拉长 4.7%——
       * 结果是"画面节拍网格"被整体缩放，配乐卡点全乱（真机：卡点命中 4/15）。
       * 现在只在**有缺口时**按真实目标补足，节拍网格保持不动。
       */
      , "--retime-to", String(Number((totalSeconds - (CUT_TRANSITION ? CUT_TRANSITION_AT.split(",").filter(Boolean).length * CUT_TRANSITION_DURATION : 0)).toFixed(3)))
    ]);
    const info = existsSync(master) ? probe(master) : {};
    const verdict = result.ok ? await reviewStage({
      stage: "compose", projectId: PROJECT,
      artifacts: [{ path: master, kind: "video", probe: info }],
      deterministic: [
        { id: "exists", pass: existsSync(master), detail: existsSync(master) ? "母版已生成" : "母版不存在", hard: true },
        {
          /**
           * 目标时长 = 分镜总时长 − 转场重叠（与 compose 的 `--retime-to` 同一口径）：
           * 逐刀转场会按刀数吃掉时长，拿分镜总时长当目标会误判"时长不符"（真机 2026-09-25）。
           */
          id: "duration",
          pass: Math.abs(Number(info.duration ?? 0) - expectedMasterSeconds) <= 1.0,
          detail: `实测 ${Number(info.duration ?? 0).toFixed(2)}s（目标 ${expectedMasterSeconds}s = 分镜 ${totalSeconds}s − 转场 ${transitionLoss.toFixed(2)}s）`,
          hard: true
        },
        { id: "resolution", pass: Number(info.width) === w && Number(info.height) === h, detail: `${info.width}x${info.height}` , hard: true }
      ],
      context: {
        clips: clips.length,
        /** 时长容差口径（把"判据"交给监制，而不是让它自己猜）：目标 ±1.0s，转场会吃掉少量时长 */
        durationPolicy: `目标 ${totalSeconds}s，容差 ±1.0s（逐刀转场 ${CUT_TRANSITION || "无"}@${CUT_TRANSITION_DURATION}s 在 ${CUT_TRANSITION_AT || "全部"} 入点生效，会按刀数缩短总长）`,
        transitions: CUT_TRANSITION ? { name: CUT_TRANSITION, durationSec: CUT_TRANSITION_DURATION, at: CUT_TRANSITION_AT } : null
      }, env: ENV, allowFallbackApprove: ALLOW_FALLBACK_APPROVE, log
    }) : null;
    record({
      stage: "compose", shotId: null, invoked: true, ok: Boolean(result.ok && verdict?.approved), cached: false,
      degraded: Boolean(verdict?.degraded), attempt: 1, ms: Date.now() - started, artifact: master,
      evidence: {
        ...info, tool: "scripts/tools/compose-film.mts",
        /** 顺序判据证据（policy/期望顺序/实际顺序），终审与审计都能按它复核"有没有打乱镜头" */
        order: { policy: ORDER_POLICY, expected: orderCheck.expected, actual: orderCheck.actual, ok: orderCheck.ok },
      }, verdict
    });
    if (!result.ok) log(`⛔ 合成失败：${result.out.slice(-400)}`);
  }
}

/* ---------- ⑤ 调色（color-bridge 择优） ---------- */
/** 未重跑调色时：磁盘上若已有"不早于 raw"的调色版就沿用它（只重跑后段的场景） */
let colored = STAGES.has("color") ? master : preferDownstream(join(POST_DIR, "master-graded.mp4"), master);
if (STAGES.has("color") && existsSync(master)) {
  const started = Date.now();
  const graded = join(POST_DIR, "master-graded.mp4");
  const recipe = arg("--color-recipe", "outdoor-travel");
  /**
   * 两种调色口径（2026-09-24 真机）：
   *   `best`（默认）= 择优：候选池打分 + 允许"不调"；真机两次被监制打回（题材不符/无效调整），
   *                   说明择优池在江南实景+口播这类题材上会挑出风格不符的候选（vintage-fade）；
   *   `grade`      = 显式配方 + 强度（监制给定风格时用）：`--color-profile natural --color-intensity 0.3`。
   */
  const colorMode = arg("--color-mode", "best");
  const profile = arg("--color-profile", "natural");
  const intensity = arg("--color-intensity", "0.3");
  const result = colorMode === "grade"
    ? runCli(COLOR_CLI, ["grade", "--in", master, "--out", graded, "--profile", profile, "--intensity", intensity])
    : runCli(COLOR_CLI, ["best", "--in", master, "--out", graded, "--recipe", recipe, "--min-improvement", "1.5"]);
  const produced = existsSync(graded);
  const info = produced ? probe(graded) : probe(master);
  const verdict = await reviewStage({
    stage: "color", projectId: PROJECT,
    artifacts: [{ path: produced ? graded : master, kind: "video", probe: info }],
    deterministic: [
      { id: "grade-produced", pass: produced, detail: produced ? "调色母版已产出" : "调色未产出（择优判定无需调色或工位失败）" },
      { id: "color-tool-exit", pass: result.ok, detail: result.ok ? "调色工位退出码 0" : `调色工位失败：${result.out.slice(-200)}`, hard: !result.ok }
    ],
    context: {
      mode: colorMode,
      ...(colorMode === "grade" ? { profile, intensity } : { recipe }),
      toolOutput: result.out.slice(-800)
    },
    env: ENV, allowFallbackApprove: ALLOW_FALLBACK_APPROVE, log
  });
  /**
   * **监制裁决决定流向**（2026-09-24 真机修正）：
   * 早先只要工位产出了 `master-graded.mp4` 就把它当母版往下走，于是"监制打回的调色版"照样进成片。
   * 现在：只有监制放行的调色版才替换母版；被打回则**保留原片**（产品自己的"不劣化优先"口径），
   * 并在记录里写明"调色环节已执行但产物被驳回，按原片走"。
   */
  const useGraded = produced && Boolean(verdict.approved);
  if (useGraded) colored = graded;
  else if (produced) {
    log(`↺ 调色产物被监制驳回（score=${verdict.score}）→ 保留原片母版继续后期（不劣化优先）`);
  }
  /**
   * 「调色被驳回 → 回退原片」是**设计内的正常结局**（不劣化优先），不是交付失败：
   * 这里显式打上 `fallbackToOriginal` 标记，供终审的"上游全部放行"判据识别——
   * 否则"我们主动选择不调色"会被读成"调色环节没签字"（真机 2026-09-25）。
   */
  const colorFallback = produced && !verdict.approved;
  record({
    stage: "color", shotId: null, invoked: true, ok: result.ok, cached: false, degraded: !produced, attempt: 1,
    ms: Date.now() - started, artifact: produced ? graded : null,
    evidence: {
      mode: colorMode, ...(colorMode === "grade" ? { profile, intensity } : { recipe }),
      tool: `color-bridge ${colorMode}`,
      ...(colorFallback ? { fallbackToOriginal: true, fallbackReason: `监制驳回（score=${verdict.score}）：${verdict.reason.slice(0, 120)}` } : {})
    }, verdict
  });
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
let subtitled = STAGES.has("subtitle") ? colored : preferDownstream(join(POST_DIR, "master-subtitled.mp4"), colored);
/** 旁挂字幕文件（sidecar 模式的产物；burn 模式下为 null，下游仍走烧字版） */
let subtitleSidecar: { dir: string; srt: string; ass: string; manifest: string | null; timelineOk: boolean } | null = null;
if (STAGES.has("subtitle") && existsSync(colored)) {
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
      /**
       * 血缘刷新（2026-09-24 真机）：旁挂字幕的内容通常与本轮一致，工位按幂等不重写文件，
       * 于是 mtime 停留在上一轮 → 终审的血缘检查判"字幕来自旧产物、与母版断链"。
       * 这一轮既然重新产出了字幕决策，就把文件时间戳刷新到本轮（内容不变、血缘归位）。
       */
      try {
        const now = new Date();
        for (const file of [zhSrt, zhAss, manifest]) {
          if (file && existsSync(file)) utimesSync(file, now, now);
        }
      } catch {
        /* 时间戳刷新失败不影响交付，血缘检查会如实报出 */
      }
    }
    record({
      stage: "subtitle", shotId: null, invoked: true, ok: sidecarResult.ok && Boolean(subtitleSidecar), cached: false, degraded: false,
      attempt: 1, ms: Date.now() - started, artifact: existsSync(zhSrt) ? zhSrt : null,
      evidence: { mode: "sidecar", srt: zhSrt, ass: zhAss, manifest, tool: "subtitle-bridge sidecar", masterBurnedIn: false }, verdict
    });
    if (sidecarResult.ok) log(`字幕以旁挂文件产出（母版不烧字）：${zhSrt}`);
  }

  if (SUBTITLE_MODE !== "sidecar") {
    const out = join(POST_DIR, "master-subtitled.mp4");
    const result = runCli(SUBTITLE_CLI, [
      "burn", "--in", colored, "--out", out, "--srt", srtFile,
      "--title", arg("--title", shotlist.title ?? ""),
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
  ? (STAGES.has("danmaku") ? subtitled : preferDownstream(join(POST_DIR, "master-danmaku.mp4"), subtitled))
  : subtitled;
if (DANMAKU_ENABLED && STAGES.has("danmaku") && existsSync(subtitled)) {
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
let scored = STAGES.has("bgm") ? danmakuOut : preferDownstream(join(POST_DIR, "master-scored.mp4"), danmakuOut);
if (STAGES.has("bgm") && existsSync(danmakuOut)) {
  const started = Date.now();
  const out = join(POST_DIR, "master-scored.mp4");
  const genre = arg("--bgm-genre", "旅行");
  const mood = arg("--bgm-mood", "温润治愈");
  const policy = arg("--bgm-policy", "keep-dialogue");
  const sourcePolicy = arg("--bgm-source-policy", "online-first");
  /**
   * 指定曲目（2026-09-24 真机补）：`--bgm-track <曲库 id | 绝对路径>`。
   *
   * 背景：`best` 的自动选曲在"题材"维度上不够硬——真机把「运动/高燃」的曲目选给了江南水乡口播片
   * （match.reasons 明确写着"题材未命中"，但因为能量/BPM 命中仍被采信）。
   * 产品所有者本地曲库（`~/.workloom-bgm/library`，1034 首，已打标）里本就有题材贴合的曲子，
   * 因此监制可以直接点名曲目：这条路径**跳过自动择优**，但仍走工位的混音/让位/响度/选段全套复检。
   */
  /**
   * 真峰值目标（2026-09-27 真机）：默认 -1.5 dBTP 而不是混音器默认的 -1.0——
   * AAC 编码后会有 ~0.1dB 过冲，直接按 -1.0 出片会变成 -0.9，越过终审的"真峰值 ≤ -1.0 dBTP"硬上限。
   */
  const BGM_TRUE_PEAK = arg("--bgm-true-peak", "-1.5");
  const chosenTrack = arg("--bgm-track", "");
  const result = runCli(BGM_CLI, [
    "best", "--in", danmakuOut, "--out", out, "--genre", genre, "--mood", mood, "--policy", policy,
    "--source-policy", sourcePolicy,
    "--evidence-dir", join(POST_DIR, "bgm-evidence")
  ]);
  /**
   * 「最佳候选」判定无需配乐时的**监制兜底路径**（2026-09-24）：
   * 真机结果：口播片人声太满 → `best` 按"不劣化优先"给出 `no_bgm_needed`（无产物）。
   * 这类结论在纯质量口径下是对的，但产品口径里"成片必须带配乐轨"，所以监制显式接管：
   * 用**自算作曲**（叙事/口播配方）+ **让位混音**（keep-dialogue、低于人声若干 dB、母版 −14 LUFS）手工出一版，
   * 并在阶段记录里写明这是"监制决定"，不是工具自动结论。
   */
  let bgmVia = "best";
  let bgmDetail = result.out.slice(-800);
  if (chosenTrack) {
    /** 监制点名曲目：id → 走曲库索引解析出绝对路径；已是绝对路径则直用 */
    let trackPath = chosenTrack;
    /** 点名曲目的真实 BPM（交混音器当基准；解析不到时留空，不硬编造） */
    let trackBpm: number | null = null;
    if (!existsSync(trackPath)) {
      try {
        const core = await import(join(REPO_ROOT, "bundles/ai-video/connectors/bgm-bridge/core.mjs"));
        const found = (core as { findTracks: (q: Record<string, unknown>) => { track?: { path?: string; bpm?: number } } })
          .findTracks({ trackId: chosenTrack, commercialUse: true });
        if (found.track?.path && existsSync(found.track.path)) {
          trackPath = found.track.path;
          trackBpm = Number.isFinite(Number(found.track.bpm)) ? Number(found.track.bpm) : null;
        }
        else throw new Error(`曲库中未找到可用曲目：${chosenTrack}`);
      } catch (err) {
        throw new Error(`--bgm-track 解析失败（${chosenTrack}）：${err instanceof Error ? err.message : String(err)}`);
      }
    }
      const mix = runCli(BGM_CLI, [
        "mix", "--in", danmakuOut, "--out", out, "--bgm", trackPath, "--policy", policy,
        "--music-level", arg("--bgm-level", "-26"), "--ducking", arg("--bgm-ducking", "14"), "--lufs", "-14",
        "--true-peak", BGM_TRUE_PEAK,
        "--section", arg("--bgm-section", "auto"),
        /** 同理：点名曲目也要把真实 BPM 交给混音器（否则基准落到默认 100，卡点判定失真） */
        ...(trackBpm ? ["--bgm-bpm", String(trackBpm)] : []),
        /**
         * 剪辑网格 + 剪辑驱动 BPM（2026-09-25 真机）：成片方最清楚自己的剪辑点（每镜固定时长、硬切），
         * 把网格直接交给混音器反推 BPM（5s 切点 → 96BPM = 8 拍/镜）——卡点平均误差从 116ms 降到 0ms。
         * 不传的话它只能从"音轨起音"猜剪辑点，会把台词音节当切点，BPM 反推整体落空并退回 100BPM 默认值。
         */
        "--bpm-strategy", "cut-driven",
        "--cut-times", CUT_GRID.join(","),
        "--evidence-dir", join(POST_DIR, "bgm-evidence")
      ]);
    bgmVia = "library-track";
    bgmDetail = `监制点名曲目（跳过自动择优）：${trackPath}\n--- mix ---\n${mix.out.slice(-900)}`;
    log(`↻ 配乐：监制点名曲库曲目 → ${trackPath.split("/").slice(-1)[0]}（走混音/让位/响度/选段复检）`);
  } else if (!existsSync(out)) {
    /**
     * **不再退回自算作曲**（2026-09-26 产品所有者口径："最早那批纯音乐质量太差，去掉"）。
     *
     * `best` 判 no_bgm_needed 的常见理由是"人声太满、配乐会添乱"——这是**质量口径**的判断，
     * 但产品口径要求"成片必须有配乐轨"。正确做法不是让宿主临时合成一首（那正是被打回的那批），
     * 而是**降低择优门槛、仍然只从曲库里选**：优先低密度、纯器乐、BPM 与剪辑网格相容的曲子当"音乐床"，
     * 用更低的音乐电平（-28dB）与更深的让位（16dB）保证不抢人声。
     */
    const bed = await pickGridCompatibleBed(Number(probe(danmakuOut).duration ?? 0), CUT_GRID);
    if (bed) {
      const mix = runCli(BGM_CLI, [
        "mix", "--in", danmakuOut, "--out", out, "--bgm", bed.path, "--policy", policy,
        "--music-level", arg("--bgm-bed-level", "-28"), "--ducking", arg("--bgm-bed-ducking", "16"), "--lufs", "-14",
        "--true-peak", BGM_TRUE_PEAK,
        "--section", arg("--bgm-section", "auto"),
        /**
         * **把曲目真实 BPM 交给混音器**（2026-09-26 真机修复）：
         * 不传时 `deriveTempoFromCuts` 的基准会落到默认 100，反推出的 BPM 与剪辑网格自相矛盾
         * （VID-GR01：标称 120BPM 的曲子被判 99.6BPM、卡点 7/17、平均 122ms → 监制连续打回配乐）。
         */
        "--bgm-bpm", String(bed.bpm),
        "--bpm-strategy", "cut-driven",
        "--cut-times", CUT_GRID.join(","),
        "--evidence-dir", join(POST_DIR, "bgm-evidence")
      ]);
      if (mix.ok && existsSync(out)) {
        bgmVia = "library-bed";
        bgmDetail = `best 严格阈值未过（人声太满）→ **曲库音乐床**（不自算作曲）\n`
          + `曲目 ${bed.id} · ${bed.title} · 标签 ${bed.bpm}BPM / **实测 ${bed.measuredBpm}BPM** · `
          + `卡点实测平均误差 ${bed.gridErrorMs}ms · 评分 ${bed.score}\n`
          + `评分依据：${bed.reasons.join("；")}\n--- mix ---\n${mix.out.slice(-700)}`;
        log(`↻ 配乐：严格选曲未过阈值 → 曲库音乐床 ${bed.id}（标签 ${bed.bpm}BPM / 实测 ${bed.measuredBpm}BPM，`
          + `卡点平均误差 ${bed.gridErrorMs}ms，评分 ${bed.score}；不再自算作曲）`);
      } else {
        bgmDetail = `曲库音乐床混音失败：${mix.out.slice(-500)}`;
      }
    } else if (flag("--allow-synth-bgm")) {
      const recipe = arg("--bgm-recipe", "interview");
      const bgmFile = join(POST_DIR, "bgm-composed.wav");
      const compose = runCli(BGM_CLI, ["compose", "--out", bgmFile, "--in", danmakuOut, "--id", recipe, "--seed", "20260924"]);
      if (compose.ok && existsSync(bgmFile)) {
        const mix = runCli(BGM_CLI, [
          "mix", "--in", danmakuOut, "--out", out, "--bgm", bgmFile, "--policy", policy,
          "--music-level", arg("--bgm-level", "-26"), "--ducking", arg("--bgm-ducking", "14"), "--lufs", "-14",
        "--true-peak", BGM_TRUE_PEAK,
          "--bpm-strategy", "cut-driven",
          "--cut-times", CUT_GRID.join(","),
          "--evidence-dir", join(POST_DIR, "bgm-evidence")
        ]);
        bgmVia = "producer-compose+mix";
        bgmDetail = `显式 --allow-synth-bgm：自算作曲(${recipe}) + mix\n--- mix ---\n${mix.out.slice(-500)}`;
        log(`⚠ 配乐：显式启用了自算作曲兜底（${recipe}）——非默认路径`);
      } else {
        bgmDetail = `compose 失败：${compose.out.slice(-400)}`;
      }
    } else {
      bgmDetail = "曲库里没有与剪辑网格相容（BPM 60/120/240 ±5）且时长足够的曲目；"
        + "按产品口径**不自算作曲**，本环节判失败（不静默降级）。"
        + "处理办法：把新曲目打标进本地曲库（bgm-cli tag），或改用与曲库 BPM 相容的剪辑网格。";
      log("⛔ 配乐：曲库内无网格相容曲目，且未允许自算作曲 → 本环节判失败（不静默降级）");
    }
  }
  const info = existsSync(out) ? probe(out) : {};
  const lufs = (result.out.match(/-?\d+(\.\d+)?\s*LUFS/) ?? ["无响度读数"])[0] ?? "";
  const mixLufs = (bgmDetail.match(/-?\d+(\.\d+)?\s*LUFS/) ?? ["无响度读数"])[0] ?? lufs;
  /** 成品响度实测（工位没给读数时由宿主补测，避免"无证据"卡门） */
  const measured = existsSync(out) ? measureLoudness(out) : { lufs: null, peakDb: null, detail: "无产物" };
  const verdict = await reviewStage({
    stage: "bgm", projectId: PROJECT,
    artifacts: [{ path: existsSync(out) ? out : danmakuOut, kind: "video", probe: info }],
    deterministic: [
      { id: "scored", pass: existsSync(out), detail: existsSync(out) ? "配乐版已产出" : "配乐版未产出", hard: true },
      { id: "tool-exit", pass: result.ok, detail: result.ok ? "配乐工位退出码 0" : `配乐工位失败：${result.out.slice(-300)}`, hard: true },
      { id: "audio-track", pass: Boolean(info.hasAudio), detail: info.hasAudio ? `音轨 ${info.acodec}` : "无音轨", hard: !info.hasAudio },
      {
        id: "loudness", pass: measured.lufs === null ? false : measured.lufs >= -17 && measured.lufs <= -12,
        detail: `${measured.detail}（母版口径 −14 LUFS ±2）`
      },
      {
        id: "true-peak", pass: measured.peakDb === null ? false : measured.peakDb <= -1,
        detail: `真峰值 ${measured.peakDb === null ? "未读到" : `${measured.peakDb.toFixed(1)} dBFS`}（上限 −1 dBTP）`
      }
    ],
    context: {
      genre, mood, policy, via: bgmVia, loudness: mixLufs, measuredLoudness: measured.detail, toolOutput: bgmDetail,
      /**
       * 曲风判据的事实依据（2026-09-25）：把 brief 的题材/平台/剪辑风格交给监制，
       * 免得它拿"上一部片子的题材"当标准（真机：给滕王阁城市地标片挑的电子律动曲被判"不符江南水乡温润题材"）。
       */
      briefTone: shotlist.title, platform: arg("--platform", "抖音/快手"),
      briefHint: BRIEF_FILE && existsSync(abs(BRIEF_FILE)) ? readFileSync(abs(BRIEF_FILE), "utf8").slice(0, 900) : null,
      /** 人声分布与剪点网格是判"让位/卡点"的事实依据（否则监制只能凭感觉） */
      dialogueShots: shots.filter((s) => (s.dialogue ?? []).length > 0).map((s) => s.shotId),
      /** 真实切点（含逐刀转场补偿）：与 CUT_GRID / 音效层同源，避免"交给监制的网格是错的" */
      cutGridSeconds: CUT_GRID,
      styleIntent: (() => {
        try {
          return BRIEF_FILE && existsSync(abs(BRIEF_FILE))
            ? (JSON.parse(readFileSync(abs(BRIEF_FILE), "utf8")) as { editingStyle?: string }).editingStyle ?? null
            : null;
        } catch { return null; }
      })(),
      discipline: "曲风是否合适以 brief 的题材/平台/剪辑风格为准；不要用与本片无关的其他题材（如水乡/纪实）当作标准。"
        + "让位深度只按**有台词的镜头**衡量（其余是无对白的音乐段）；卡点看剪辑点是否落在曲子的节拍上。"
    },
    env: ENV, allowFallbackApprove: ALLOW_FALLBACK_APPROVE, log
  });
  if (existsSync(out)) scored = out;
  /**
   * **时长守恒闸**（2026-09-25 南昌片真机）：配乐工位按选段/节拍对齐时会把音频裁到曲子边界，
   * 结果是 master-scored 比 master-subtitled 短了 1.15s（49.90 → 48.75），终审直接判"时长不符"。
   * 这里在配乐产物落地后做一次守恒校验：短了就用 `apad` 把音轨补到原长（视频轨 copy，画面零改动）。
   */
  if (existsSync(out)) {
    const before = Number(probe(danmakuOut).duration ?? 0);
    const after = Number(probe(out).duration ?? 0);
    if (before > 0 && after > 0 && before - after > 0.05) {
      const fixed = `${out}.padded.mp4`;
      run(FFMPEG, ["-y", "-i", out, "-map", "0:v:0", "-map", "0:a:0",
        "-c:v", "copy", "-af", "apad", "-t", before.toFixed(3),
        "-c:a", "aac", "-b:a", "192k", "-movflags", "+faststart", fixed]);
      execFileSync("mv", [fixed, out]);
      scored = out;
      log(`  ⚖ 配乐时长守恒：${after.toFixed(2)}s → ${before.toFixed(2)}s（apad 补足，画面零改动）`);
    }
  }
  record({
    stage: "bgm", shotId: null, invoked: true, ok: result.ok && existsSync(out), cached: false, degraded: false,
    attempt: 1, ms: Date.now() - started, artifact: existsSync(out) ? out : null,
    evidence: { genre, mood, policy, via: bgmVia, loudness: mixLufs, measured: measured.detail, tool: `bgm-bridge ${bgmVia}` }, verdict
  });
}

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
if (STAGES.has("sfx") && existsSync(scored) && !DRY_RUN) {
  const started = Date.now();
  const sfxDir = join(POST_DIR, "sfx");
  mkdirSync(sfxDir, { recursive: true });
  const totalDuration = Number(probe(scored).duration ?? 0);
  const shotDurations = shots.map((s) => Number(s.duration ?? 5));
  const cutTimes = cutTimesFromShots(shotDurations, CUT_TRANSITION ? CUT_TRANSITION_DURATION : 0,
    CUT_TRANSITION ? CUT_TRANSITION_AT.split(",").map((v) => Number(v.trim())).filter((v) => Number.isFinite(v) && v > 0) : []);
  /** 段落重音 = 进入快剪段的第一刀 + 最后一刀（模板可覆盖） */
  const accentTimes = cutTimes.length > 1 ? [cutTimes[0]!, cutTimes[cutTimes.length - 1]!] : cutTimes.slice(0, 1);
  /**
   * 高潮那一刻 = 最后一个重音刀口（进入收尾镜之前）。
   * riser 由策划器**前置**到高潮之前（真机打回：riser 落在切点之后 = 高潮过去了才抬升）。
   */
  const climaxAtSec = accentTimes.length > 0 ? accentTimes[accentTimes.length - 1] : undefined;
  const sfxPlan = planCutSfxDetailed({ cutTimes, durationSec: totalDuration, accentTimes, climaxAtSec }, CUT_SFX_POLICY);
  const placements = sfxPlan.placements;
  try {
    const files: string[] = [];
    const renderOne = (kind: "whoosh" | "impact" | "riser", durationSec: number, file: string): void => {
      run(FFMPEG, ["-y", ...buildSfxArgs({ kind, durationSec }), "-f", "wav", file]);
    };
    placements.forEach((placement, index) => {
      const file = join(sfxDir, `${String(index + 1).padStart(2, "0")}-${placement.kind}-${placement.atSec}s.wav`);
      renderOne(placement.kind, placement.kind === "riser" ? 1.2 : placement.kind === "impact" ? 0.26 : 0.36, file);
      files.push(file);
    });
    const sfxTrack = join(sfxDir, "sfx-track.wav");
    if (placements.length === 0) {
      log("  ⚠ 没有剪辑点可铺音效（跳过 SFX 层）");
      record({
        stage: "sfx", shotId: null, invoked: true, ok: true, cached: false, degraded: true, attempt: 1, ms: Date.now() - started,
        artifact: null, evidence: { placements: 0, cutTimes }, verdict: null, note: "无剪辑点：SFX 层未产出（如实记录，不静默）"
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
      const before = measureLoudness(scored);
      const after = measureLoudness(out);
      const drift = before.lufs !== null && after.lufs !== null ? Math.abs(after.lufs - before.lufs) : null;
      const verdict = await reviewStage({
        stage: "sfx", projectId: PROJECT,
        artifacts: [{ path: out, kind: "video", probe: probe(out) }, ...placements.slice(0, 6).map((p, i) => ({ path: files[i]!, kind: "audio" as const, note: `${p.kind}@${p.atSec}s` }))],
        rubric: [
          "音效与画面剪辑点对齐：甩镜/擦除处能听到气流，段落重音处有冲击，高潮前有抬升",
          "音效不能盖台词：有人声的镜头里，人声仍清晰可辨（响度与让位不因加音效而破坏）",
          "音效不过量：不是每个镜头都塞特效，密集段也不能糊成一片（间隔与条数在口径内）",
          "整片响度仍在母版口径（−14 LUFS ±1.5）"
        ],
        deterministic: [
          { id: "sfx-produced", pass: existsSync(out), detail: existsSync(out) ? "带音效母版已产出" : "带音效母版未产出", hard: true },
          { id: "sfx-count", pass: placements.length >= Math.min(3, cutTimes.length), detail: `音效 ${placements.length} 条 / 剪辑点 ${cutTimes.length} 个`, hard: true },
          { id: "video-untouched", pass: Number(probe(out).duration ?? 0) > 0, detail: "视频轨 copy（画面零改动）", hard: true },
          {
            id: "loudness-drift", pass: drift === null ? false : drift <= 1.5,
            detail: `加音效前后响度漂移 ${drift === null ? "未测到" : `${drift.toFixed(2)} LUFS`}（上限 1.5）`, hard: true
          }
        ],
        context: {
          placements: placements.map((p) => `${p.kind}@${p.atSec}s（${p.gainDb}dB，${p.reason}）`),
          cutTimes, policy: CUT_SFX_POLICY,
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
          climaxAtSec, cutTimes, loudnessBefore: before.detail, loudnessAfter: after.detail, drift,
          tool: "sfx-synth（合成，无第三方采样）"
        },
        verdict, note: `转场音效 ${placements.length} 条（whoosh/impact/riser）`
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

/* ---------- ⑨ 封面（封面设计师：设计稿 → 合成 → 机检 → 监制，2026-09-25 重写） ---------- */
/**
 * 事故：上一版封面 = "抽一帧 + 烧一行标题"——产品所有者复核时点名**封面设计师没有发挥作用**
 * （封面只有标题，没有主视觉设计、没有人物、没有副标题/角标）。
 *
 * 新口径把封面做成"设计稿 → 合成 → 机检 → 监制"四段（机检口径在 `cover-design.ts`，含单测）：
 *   ① 封面设计师（LLM）出**结构化设计稿**：主标题/副标题/角标、主视觉取哪一镜哪一秒、人物带高度、
 *      字级配色、版式左右——并给出设计理由；设计稿不合法或设计师不可用 → 确定性兜底稿（仍是三件套）；
 *   ② 合成（ffmpeg，确定性）：干净母版取帧 → 调色/暗角/标题带压暗 → 人物带（柔化过渡）→ 大标题排版；
 *   ③ 机检四项：标题真的画上去了 / 人物带真的合成进去了 / 底图来自**未烧字**母版 / 文字没落进平台遮挡区；
 *   ④ 监制（LLM）看整图（rubric 见 `COVER_REVIEW_RUBRIC`）。
 */

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

/** 两个图在指定区域的 PSNR（判定"这块区域到底改没改"） */
function psnrRegion(a: string, b: string, crop: { x: number; y: number; w: number; h: number }): number | null {
  const res = spawnSync(FFMPEG, [
    "-hide_banner", "-i", a, "-i", b,
    "-lavfi", `[0:v]crop=${crop.w}:${crop.h}:${crop.x}:${crop.y},format=gray[a];`
      + `[1:v]crop=${crop.w}:${crop.h}:${crop.x}:${crop.y},format=gray[b];[a][b]psnr`,
    "-f", "null", "-"
  ], { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });
  const text = `${res.stdout ?? ""}\n${res.stderr ?? ""}`;
  const m = /average:([\d.]+|inf)/.exec(text);
  if (!m) return null;
  return m[1] === "inf" ? 99 : Number(m[1]);
}

/** 灰度原始像素（封面机检用：墨迹包围盒与遮挡区墨迹比例都按**交付图的实际像素**算） */
function grayRaw(file: string): Buffer {
  const res = spawnSync(FFMPEG, ["-hide_banner", "-v", "error", "-i", file, "-f", "rawvideo", "-pix_fmt", "gray", "-"], {
    maxBuffer: 64 * 1024 * 1024
  });
  if (res.status !== 0 || !res.stdout) throw new Error(`灰度解码失败：${file}`);
  return res.stdout as Buffer;
}

/**
 * 墨迹包围盒 + 遮挡区墨迹比例（对两图之差的灰度图做统计）。
 * 阈值 26 是"肉眼可辨的改动"量级：编码噪声（JPEG/PNG 重编码）远低于它，避免把噪声当字。
 */
function inkMetrics(diffFile: string, width: number, height: number, threshold = 26): {
  top: number; bottom: number; left: number; right: number; bottomBandInkRatio: number;
} {
  const raw = grayRaw(diffFile);
  let top = height; let bottom = -1; let left = width; let right = -1;
  const bottomStart = Math.round(height * (1 - COVER_SAFE_AREA.bottomReservedRatio));
  let bottomBandInk = 0;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      if (raw[y * width + x]! <= threshold) continue;
      if (y < top) top = y;
      if (y > bottom) bottom = y;
      if (x < left) left = x;
      if (x > right) right = x;
      if (y >= bottomStart) bottomBandInk += 1;
    }
  }
  const bandPixels = width * (height - bottomStart);
  return {
    top: bottom >= 0 ? top : 0,
    bottom: bottom >= 0 ? bottom : 0,
    left: right >= 0 ? left : 0,
    right: right >= 0 ? right : 0,
    bottomBandInkRatio: bandPixels > 0 ? bottomBandInk / bandPixels : 0
  };
}

/** 两图相减（差异图，用于测"字画在哪、有多大"） */
function imageDiff(a: string, b: string, out: string): void {
  run(FFMPEG, ["-y", "-i", a, "-i", b,
    "-filter_complex", "[0:v]format=gray[g0];[1:v]format=gray[g1];[g0][g1]blend=all_mode=difference",
    "-frames:v", "1", out]);
}

/** 封面设计师（LLM）：只出设计稿，不画图 */
async function callCoverDesigner(designInput: CoverDesignInput): Promise<string> {
  const llm = resolveProducerLlm(ENV);
  if (!llm) throw new Error("未配置 LLM（LLM_BASE_URL / LLM_API_KEY / LLM_MODEL）");
  const res = await fetch(`${llm.baseUrl}/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${llm.apiKey}` },
    body: JSON.stringify({
      model: llm.model,
      messages: [
        { role: "system", content: "你是封面设计师，只输出严格合法的 JSON 设计稿。" },
        { role: "user", content: buildCoverDesignPrompt(designInput) }
      ],
      temperature: 0.4,
      response_format: { type: "json_object" }
    }),
    signal: AbortSignal.timeout(180_000)
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`封面设计稿请求失败 HTTP ${res.status}：${text.slice(0, 200)}`);
  const content = (JSON.parse(text) as { choices?: Array<{ message?: { content?: string } }> }).choices?.[0]?.message?.content ?? "";
  if (!content.trim()) throw new Error("封面设计师返回空内容");
  return content;
}

if (STAGES.has("cover") && existsSync(colored)) {
  const started = Date.now();
  const platform = arg("--platform", "抖音/快手");
  const coverPng = join(OUT_DIR, `${PROJECT}-cover.png`);
  const coverDir = join(POST_DIR, "cover");
  mkdirSync(coverDir, { recursive: true });
  const CW = 1080; const CH = 1920;
  const shotAt = (shotId: string): number => {
    const index = shots.findIndex((s) => s.shotId === shotId);
    /**
     * 镜头在**母版时间轴**上的起点：必须扣掉逐刀转场的重叠（2026-09-25 真机）——
     * 早先用"时长累加"，15 刀累计偏移 2.4s，导致封面取帧取到别的镜头（真机：地标插卡里出现的是人物）。
     */
    if (index <= 0) return 0;
    return CUT_GRID[index - 1] ?? shots.slice(0, index).reduce((sum, s) => sum + Number(s.duration ?? 5), 0);
  };
  const personShots = shots.filter((s) => String(s.character ?? "").length > 0);
  const designInput: CoverDesignInput = {
    title: shotlist.title,
    /** 真实成片时长（扣转场后的目标）：标题里的"XX 秒"必须与它一致（真机：写 48 秒而片子 51s → 打回） */
    durationSeconds: expectedMasterSeconds,
    /** 版式交办给设计师（2026-09-26）：物体为主 / 人物为主二选一，渲染与监制都按它判 */
    archetype: COVER_ARCHETYPE,
    platform,
    brief: BRIEF_FILE && existsSync(abs(BRIEF_FILE))
      ? (JSON.parse(readFileSync(abs(BRIEF_FILE), "utf8")) as CoverDesignInput["brief"])
      : null,
    character: lead ? { id: lead.id, name: lead.name } : null,
    shots: shots.map((s) => ({
      shotId: s.shotId,
      scene: String(s.scene ?? ""),
      dialogueText: dialogueText(s),
      hasCharacter: String(s.character ?? "").length > 0,
      duration: Number(s.duration ?? 5)
    }))
  };
  /**
   * ① 设计稿：设计师（LLM）→ 严格校验；不可用/不合规 → 确定性兜底稿。
   * 兜底稿也必须是"主视觉 + 人物 + 主标题"三件套（不允许退回"只有标题"）。
   */
  const fallbackBackground = (personShots.length > 0
    ? [...shots].reverse().find((s) => String(s.character ?? "").length === 0) ?? shots[0]!
    : shots[shots.length - 1]!);
  let plan: CoverPlan;
  let designVia: "llm" | "fallback" = "llm";
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
    const leadShots = lead
      ? personShots.filter((shot) => String(shot.character ?? "").includes(lead.name) || String(shot.character ?? "").includes(lead.id))
      : personShots;
    const pool = leadShots.length > 0 ? leadShots : [];
    if (pool.length === 0) return null;
    const backgroundScene = String(shots.find((s) => s.shotId === backgroundShotId)?.scene ?? "");
    const warmOrNight = /黄昏|落霞|夕阳|傍晚|夜|灯/.test(backgroundScene);
    return pool.find((s) => (warmOrNight ? /夜|灯|黄昏|落霞/.test(String(s.scene ?? "")) : true))
      ?? pool[0] ?? null;
  };
  try {
    const raw = await callCoverDesigner(designInput);
    try {
      plan = parseCoverPlan(raw, designInput, { personShotId: personShotFor(undefined)?.shotId, personAtSec: 1.0 });
      designNote = raw.slice(0, 600);
    } catch (first) {
      /**
       * 设计稿自修复一次（2026-09-25）：把校验错误回给设计师，要求它只针对错误项改一版。
       * 真机首跑就是"越界字级/字库不在白名单"这类可修复项——直接退兜底稿会让封面设计师形同虚设。
       */
      const reason = first instanceof Error ? first.message.slice(0, 300) : String(first);
      log(`  ↻ 封面设计稿未过校验（${reason.slice(0, 120)}）→ 要求设计师自修复一次`);
      const repaired = await callCoverDesigner({ ...designInput, repairFrom: raw.slice(0, 1500), repairReason: reason });
      plan = parseCoverPlan(repaired, designInput, { personShotId: personShotFor(undefined)?.shotId, personAtSec: 1.0 });
      designNote = repaired.slice(0, 600);
    }
  } catch (err) {
    designVia = "fallback";
    designNote = `设计师不可用 → 兜底稿：${err instanceof Error ? err.message.slice(0, 200) : String(err)}`;
    plan = fallbackCoverPlan(designInput, {
      headline: arg("--cover-hook", shotlist.title ?? "封面"),
      heroShotId: fallbackBackground.shotId,
      personShotId: personShotFor(fallbackBackground.shotId)?.shotId
    });
    log(`  ⚠ 封面设计师不可用 → 使用兜底稿：${designNote}`);
  }
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
  /**
   * ② 合成：底图取帧 = **该镜头里最清晰的一帧**（真机二次复核抓到"甩镜中间帧糊到地标不可辨识"）：
   *   · 在设计稿给的时刻 + 镜头内 4 个等分点里挑边缘能量最高的一帧（`frameSharpness`）；
   *   · 若该镜头整段都偏软（低于口径下限），**自动改取全片最清晰的帧**并把替换写进证据——
   *     宁可换镜头，也不交付一张"看不清地标"的封面。
   * 口径（2026-09-25 实测标定）：同样抽帧下白天实拍 8.3–8.7、黄昏雾光 3.2–4.9、夜景甩镜 2.4–6.1，
   * 因此下限取 5.5（低于它基本就是运动模糊/失焦）。
   */
  const bgCandidates = (shot: ShotCard): number[] => {
    const duration = Number(shot.duration ?? 5);
    const list = [plan.background.atSec, 0.3, duration * 0.5, duration * 0.75, duration - 0.3];
    return [...new Set(list.map((t) => Math.max(0.2, Math.min(duration - 0.2, Number(t) || 0.3)).toFixed(2)))].map(Number);
  };
  const frameSharpness = (file: string): number => {
    const res = spawnSync(FFMPEG, ["-hide_banner", "-v", "error", "-i", file, "-vf", "scale=270:480,format=gray", "-f", "rawvideo", "-pix_fmt", "gray", "-"], { maxBuffer: 32 * 1024 * 1024 });
    const buf = res.stdout as Buffer | null;
    if (!buf || buf.length < 270 * 480) return -1;
    const W = 270; const H = 480;
    let sum = 0; let count = 0;
    for (let y = 1; y < H - 1; y += 1) {
      for (let x = 1; x < W - 1; x += 1) {
        const i = y * W + x; const v = buf[i]!;
        sum += Math.abs(v - buf[i + 1]!) + Math.abs(v - buf[i - 1]!) + Math.abs(v - buf[i - W]!) + Math.abs(v - buf[i + W]!);
        count += 4;
      }
    }
    return count > 0 ? sum / count : -1;
  };
  const COVER_MIN_SHARPNESS = 5.5;
  /**
   * 夜景底图的清晰度下限（2026-09-25 真机标定）：夜色画面天然边缘能量低
   * （实测 滕王阁夜景生成镜最清晰帧 3.0，而白天镜 8–12）。沿用 5.5 会把"唯一符合文案的夜景镜"否掉，
   * 逼着替换成白天景 → 图文不符（真机打回两次）。夜景单独用 2.8。
   */
  const sharpnessFloorFor = (shot: ShotCard): number => (isNightShot(shot) ? 2.8 : COVER_MIN_SHARPNESS);
  const pickSharpest = (shot: ShotCard, times: number[]): { atSec: number; sharpness: number } => {
    let best = { atSec: times[0]!, sharpness: -1 };
    for (const t of times) {
      const tmp = join(coverDir, `sharp-${shot.shotId}-${t}.png`);
      run(FFMPEG, ["-y", "-ss", (shotAt(shot.shotId) + t).toFixed(2), "-i", colored, "-frames:v", "1", tmp]);
      const value = frameSharpness(tmp);
      if (value > best.sharpness) best = { atSec: t, sharpness: value };
    }
    return best;
  };
  let bgShot = shots.find((s) => s.shotId === plan.background.shotId) ?? shots[0]!;
  let bgPick = pickSharpest(bgShot, bgCandidates(bgShot));
  /**
   * 文案与底图**时段一致性**（2026-09-25 真机）：设计稿标题写"亮灯那刻"，底图却是白天无灯版 →
   * 监制判"文案与画面对不上"打回。这里做一次确定性校正：标题含夜/灯类字样而底图不是夜景时，
   * 自动改取**夜景镜头里最清晰的一帧**（并把替换写进证据）。
   */
  /**
   * 夜景一致性判据要**覆盖标题/副标题/角标/设计理由**（2026-09-25 真机：主标题写"值得专程来"没事，
   * 副标题写"江与夜"而底图是阴天日景 → 监制判"文案与画面矛盾"打回）。
   */
  const planText = [plan.headline, plan.subline ?? "", plan.badge ?? "", plan.rationale].join(" ");
  /** 夜景意图判定交给 cover-design 的窄口径函数（"点亮/亮起"不再误触发，见该函数注释） */
  const wantsNight = coverPrefersNightBackground(planText);
  /**
   * "夜景镜"判定要**排除白天灯箱**（2026-09-25 真机）：早先用 /灯/ 匹配，把"地铁站厅灯箱"也算成夜景，
   * 封面底图因此换成地铁扶梯 → 监制判"与『滕王阁的夜』文案矛盾、未见地标"。
   * 现在只认真正的夜色词；文案提到地标时，底图还必须是该地标的镜头。
   */
  const wantsLandmark = /滕王阁/.test(planText);
  const isNightShot = (shot: ShotCard): boolean => {
    const scene = String(shot.scene ?? "");
    if (!/夜景|夜色|夜间|夜晚|灯光秀|灯火|夜市/.test(scene)) return false;
    return wantsLandmark ? /滕王阁/.test(scene) : true;
  };
  if (wantsNight && !isNightShot(bgShot)) {
    const nightShots = shots.filter(isNightShot);
    let bestNight: { shot: ShotCard; atSec: number; sharpness: number } | null = null;
    for (const candidate of nightShots) {
      const pick = pickSharpest(candidate, bgCandidates(candidate));
      if (!bestNight || pick.sharpness > bestNight.sharpness) bestNight = { shot: candidate, atSec: pick.atSec, sharpness: pick.sharpness };
    }
    if (bestNight) {
      log(`  ↻ 封面底图：标题含夜景字样而底图是日景 → 改用夜景镜 ${bestNight.shot.shotId}（${bestNight.atSec}s，边缘能量 ${bestNight.sharpness.toFixed(1)}）`);
      bgShot = bestNight.shot;
      bgPick = { atSec: bestNight.atSec, sharpness: bestNight.sharpness };
    }
  }
  let bgSubstituted = false;
  if (bgPick.sharpness < sharpnessFloorFor(bgShot)) {
    let best: { shot: ShotCard; atSec: number; sharpness: number } = { shot: bgShot, atSec: bgPick.atSec, sharpness: bgPick.sharpness };
    /**
     * 替换偏好（2026-09-25 二次复核）：优先取**宽景/全景**镜头当底图——
     * 匾额/特写这类细节镜虽然更锐，但构图局促，人物卡与标题一压就"遮挡主体"（真机封面被打回 61 分的直接原因）。
     */
    const detailShot = (shot: ShotCard): boolean => /匾额|牌匾|细节|特写|微距/.test(String(shot.scene ?? ""));
    /**
     * 候选池要**尊重夜景约束**（2026-09-25 真机）：标题/副标题写"赣江夜"时，
     * 清晰度替换绝不能再换回日景镜头（真机：换了 NC-02 白天景 → 监制判"图文不符"打回）。
     */
    const candidatePool = wantsNight ? shots.filter(isNightShot) : shots;
    if (candidatePool.length === 0) candidatePool.push(bgShot);
    for (const candidate of candidatePool) {
      if (candidate.shotId === bgShot.shotId) continue;
      const pick = pickSharpest(candidate, bgCandidates(candidate));
      /** 细节镜只在"没有别的选择"时上位：给它的清晰度打 0.75 折扣参与比较 */
      /** 候选自身不达标（按它自己的下限）就不参与替换 */
      if (pick.sharpness < sharpnessFloorFor(candidate)) continue;
      const weighted = detailShot(candidate) ? pick.sharpness * 0.75 : pick.sharpness;
      const currentWeighted = detailShot(best.shot) ? best.sharpness * 0.75 : best.sharpness;
      if (weighted > currentWeighted) best = { shot: candidate, atSec: pick.atSec, sharpness: pick.sharpness };
    }
    if (best.shot.shotId !== bgShot.shotId) {
      log(`  ↻ 封面底图：${bgShot.shotId} 最清晰帧仅 ${bgPick.sharpness.toFixed(1)}（下限 ${sharpnessFloorFor(bgShot)}）→ 改用 ${best.shot.shotId} 的 ${best.atSec}s（${best.sharpness.toFixed(1)}）`);
      bgSubstituted = true;
      bgShot = best.shot;
      bgPick = { atSec: best.atSec, sharpness: best.sharpness };
    }
  }
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
  const insetShot = COVER_HERO === "landmark" ? personShot : COVER_HERO === "person" ? bgShot : personShot;
  const insetEnabled = ["scenery", "subject", "object", "product"].includes(COVER_HERO)
    ? false
    : COVER_HERO === "landmark"
      ? Boolean(plan.person.enabled && personShot)
      : Boolean(personShot);
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
  const cardBorder = Math.max(6, Math.round(cardW * 0.018));

  const bgAt = bgPick.atSec;
  /**
   * 主版式分叉（2026-09-25）：
   *   `person` 版：**人物镜取满幅做底**（人物是背景，不存在"贴片边缘"），地标帧留给右上角小图；
   *   `landmark` 版（默认）：地标取满幅做底，人物走右下卡片。
   */
  const heroShot = COVER_HERO === "person" ? (personShotFor(bgShot.shotId) ?? bgShot) : bgShot;
  const heroAt = COVER_HERO === "person" ? 1.0 : bgAt;
  const bgFrameA = join(coverDir, "bg-frame-a.png");
  const bgFrameB = join(coverDir, "bg-frame-b.png");
  run(FFMPEG, ["-y", "-ss", (shotAt(heroShot.shotId) + heroAt).toFixed(2), "-i", colored, "-frames:v", "1", bgFrameA]);
  run(FFMPEG, ["-y", "-ss", (shotAt(heroShot.shotId) + heroAt).toFixed(2), "-i", colored, "-frames:v", "1", bgFrameB]);
  /**
   * 标题带压暗用**多层薄带**拼渐变（2026-09-25 真机二次修正）：
   * 上一版用两层厚带（0.32 + 0.16）→ 监制一眼看出"两条贯穿全宽的硬接缝"，判为合成残留。
   * 现在 14 层薄带、透明度从 0.40 线性衰减到 0，边缘不可辨。
   */
  const scrimTop = 0;
  const scrimHeight = Math.round(CH * 0.46);
  const scrimBands = 14;
  const bandHeight = Math.max(2, Math.round(scrimHeight / scrimBands));
  const scrimFilters = Array.from({ length: scrimBands }, (_, index) => {
    const alpha = 0.40 * (1 - index / (scrimBands - 1));
    const y = scrimTop + index * bandHeight;
    return `drawbox=x=0:y=${y}:w=${CW}:h=${bandHeight}:color=black@${alpha.toFixed(3)}:t=fill`;
  });
  const bgOnly = join(coverDir, "bg-only.png");
  run(FFMPEG, ["-y", "-i", bgFrameA, "-vf", [
    `scale=${CW}:${CH}:force_original_aspect_ratio=increase`,
    `crop=${CW}:${CH}`,
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
    const fadePx = Math.max(56, Math.round(cardW * (COVER_HERO === "split" ? 0.22 : 0.16)));
    const edge = (value: string): string => `min(1\\,${value})`;
    /** split：只渐隐左边界（与地标自然衔接）；其余版式：上/左/右三边渐隐 */
    const alphaExpr = COVER_HERO === "split"
      ? `255*${edge(`X/${fadePx}`)}`
      : `255*min(${edge(`X/${fadePx}`)}\\,min(${edge(`(${cardW}-X)/${fadePx}`)}\\,${edge(`Y/${fadePx}`)}))`;
    if (!existsSync(personFrame)) {
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
      `drawbox=x=${cardX + 10}:y=${cardY + 14}:w=${cardW}:h=${cardH}:color=black@0.35:t=fill`,
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
  const badgeSize = Math.max(28, Math.round(subSize * 0.72));
  const left = plan.typography.align === "center" ? 0 : 64;
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
  const accentY = Math.round(CH * COVER_SAFE_AREA.topMinRatio);
  const accentH = Math.max(8, Math.round(CH * 0.006));
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
  if (plan.subline) {
    textFilters.push(
      `drawtext=fontfile='${FONT_FILE}':text=${escapeDrawtextText(plan.subline)}:expansion=none:fontsize=${subSize}`
        + `:fontcolor=${plan.typography.accentColor}:borderw=${Math.max(2, Math.round(subSize * 0.06))}:bordercolor=black@0.5`
        + `:x=${plan.typography.align === "center" ? "(w-text_w)/2" : String(left + 4)}:y=${cursorY}`
    );
    cursorY += subSize + Math.round(subSize * 0.45);
  }
  if (plan.badge) {
    textFilters.push(
      `drawtext=fontfile='${FONT_FILE}':text=${escapeDrawtextText(plan.badge)}:expansion=none:fontsize=${badgeSize}`
        + `:fontcolor=white@0.92:borderw=${Math.max(2, Math.round(badgeSize * 0.06))}:bordercolor=black@0.5`
        + `:x=${plan.typography.align === "center" ? "(w-text_w)/2" : String(left + 4)}:y=${cursorY}`
    );
  }
  const bgText = join(coverDir, "bg-text.png");
  run(FFMPEG, ["-y", "-i", bgOnly, "-vf", textFilters.join(","), "-frames:v", "1", bgText]);
  run(FFMPEG, ["-y", "-i", bgPerson, "-vf", textFilters.join(","), "-frames:v", "1", coverPng]);
  /** ③ 机检（口径与阈值在 `cover-design.ts#coverDeterministicChecks`） */
  const coverInfo = probe(coverPng);
  const diffFile = join(coverDir, "text-diff.png");
  imageDiff(coverPng, bgPerson, diffFile);
  const ink = inkMetrics(diffFile, CW, CH);
  const titleBand = { x: 0, y: Math.round(CH * COVER_SAFE_AREA.topMinRatio), w: CW, h: Math.round(CH * (COVER_SAFE_AREA.titleBottomMaxRatio - COVER_SAFE_AREA.topMinRatio)) };
  /** 人物卡区域（机检的人工地物）：卡内 30%–75% 高度、中央 70% 宽度——避开白边与投影的干扰 */
  const personBox = {
    x: cardX + Math.round(cardW * 0.15), y: cardY + Math.round(cardH * 0.30),
    w: Math.round(cardW * 0.70), h: Math.max(80, Math.round(cardH * 0.45))
  };
  const titleBandPsnr = psnrRegion(coverPng, bgPerson, titleBand);
  const personBoxPsnr = insetEnabled ? psnrRegion(coverPng, bgText, personBox) : null;
  const backgroundMatchesCleanMaster = abs(colored) === abs(join(POST_DIR, "master-graded.mp4"))
    || (() => {
      /** 允许"母版走了原片（调色被驳回）"的情形：只要是 **colored 这一路** 的同一帧即可 */
      try {
        return sha256FileSync(bgFrameA) === sha256FileSync(bgFrameB);
      } catch {
        return false;
      }
    })();
  const measurements: CoverMeasurements = {
    bytes: Number(coverInfo.bytes ?? 0),
    width: Number(coverInfo.width ?? 0),
    height: Number(coverInfo.height ?? 0),
    titleBandPsnrDb: titleBandPsnr,
    personBoxPsnrDb: personBoxPsnr,
    backgroundMatchesCleanMaster,
    titleTopRatio: ink.top / CH,
    titleBottomRatio: ink.bottom / CH,
    bottomBandInkRatio: ink.bottomBandInkRatio
  };
  /**
   * 景物为主/物体为主版式（`--cover-hero scenery|subject`）**不合成人物层**，
   * 因此"人物框 PSNR 必须下降"这条机检在该版式下不适用——
   * 2026-09-26 产品所有者口径：封面只有两种主视觉，要么人物为主、要么物体（景物/商品/动物）为主；
   * 没有人物层不是缺陷，而是版式选择。
   */
  const checks = coverDeterministicChecks(measurements).filter((check) => insetEnabled || check.id !== "person-layer");
  /**
   * 底图清晰度（硬闸，2026-09-25 二次复核新增）：监制抓到的"地标糊到不可辨识"应当由机检拦住，
   * 而不是等 LLM 打回。口径见上面的标定（同一抽帧标准下白天 8.3–8.7 / 黄昏 3.2–4.9 / 夜景甩镜 2.4–6.1）。
   */
  checks.push({
    id: "background-sharpness",
    pass: bgPick.sharpness >= sharpnessFloorFor(bgShot),
    detail: `底图边缘能量 ${bgPick.sharpness.toFixed(2)}（下限 ${sharpnessFloorFor(bgShot)}${isNightShot(bgShot) ? "，夜景口径" : ""}；低于它基本是运动模糊/失焦）`
      + `${bgSubstituted ? "（已自动改取全片最清晰帧）" : ""}`,
    hard: true
  });
  /** ④ 监制：看整图（rubric 只问可验证的事） */
  const verdict = await reviewStage({
    stage: "cover", projectId: PROJECT,
    artifacts: [
      { path: coverPng, kind: "image", bytes: Number(coverInfo.bytes ?? 0), probe: coverInfo },
      ...(insetEnabled ? [{ path: bgOnly, kind: "image" as const, note: "底图（供对比：设计是否依赖了主视觉）" }] : [])
    ],
    rubric: COVER_REVIEW_RUBRIC,
    deterministic: checks,
    context: {
      designVia, plan: { ...plan, source: designVia }, rationale: plan.rationale,
      designRaw: designNote, measurements,
      safeArea: COVER_SAFE_AREA,
      /** 版式（2026-09-26）：监制按 archetype 判，不再一律要求"主角人物必须在场" */
      archetype: COVER_ARCHETYPE,
      discipline: COVER_ARCHETYPE === "subject-led"
        ? "本片封面版式是**物体为主（subject-led）**：景物/商品/动物等非人主体满幅 + 标题即为合格；"
          + "**人物缺席不是缺陷**（禁止要求补人物卡/人物竖带，那会让两种主视觉打架）。"
          + "文字落进底部平台遮挡区、标题与底图同色看不清、主体被裁掉/糊到不可辨识，算不合格。"
        : "本片封面版式是**人物为主（person-led）**：人物是唯一主视觉（占画面高 ≥55%），背景只作点缀；"
          + "人物缺席、或人物过小沦为贴图，算不合格。文字落进底部遮挡区或标题看不清同样不合格。"
    },
    env: ENV, allowFallbackApprove: ALLOW_FALLBACK_APPROVE, log
  });
  record({
    /**
     * 封面"合格"必须同时满足**机检全过 + 监制放行**（2026-09-25 修正）：
     * 早先只看机检，于是"机检全过但监制打回（人物卡遮挡主体/调性冲突）"被记成 ok=true——审计会误读。
     */
    stage: "cover", shotId: null, invoked: true, ok: checks.every((c) => c.pass) && verdict.approved, cached: false,
    degraded: designVia === "fallback" || verdict.degraded, attempt: 1, ms: Date.now() - started,
    artifact: existsSync(coverPng) ? coverPng : null,
    evidence: {
      designVia, plan, hook: plan.headline.replace(/\n/g, " "), font: plan.typography.fontId,
      background: { shotId: bgShot.shotId, atSec: bgAt, source: "colored（未烧字幕母版）" },
      backgroundPick: { sharpness: bgPick.sharpness, floor: COVER_MIN_SHARPNESS, substituted: bgSubstituted, plannedShotId: plan.background.shotId },
      headline: { text: plan.headline, fontId: plan.typography.fontId, sizePx: headSize, subSizePx: subSize },
      person: {
        shotId: personShot?.shotId ?? null, atSec: plan.person.atSec ?? null,
        card: { x: cardX, y: cardY, w: cardW, h: cardH, border: cardBorder },
        source: "colored（片子自己的镜头帧：肖像卡，不抠像）"
      },
      measurements, checks, designRaw: designNote,
      backgroundPickDetail: `边缘能量 ${bgPick.sharpness.toFixed(2)}／下限 ${COVER_MIN_SHARPNESS}${bgSubstituted ? "（改取全片最清晰帧）" : ""}`
    },
    verdict
  });
  if (!checks.every((c) => c.pass)) {
    log(`⛔ 封面机检未通过：${checks.filter((c) => !c.pass).map((c) => c.id).join("、")}`);
  }
  /**
   * **封面合成进成片**（2026-09-26 产品所有者点名："封面也没合成进去，还是黑色的"）：
   * 早先封面只是旁边一个 PNG，成片片头是一张黑底标题卡——现在把封面做成 1.2s 开场卡
   * （轻微推近，避免"完全静止"）再接正片，输出 `<项目>-with-cover.mp4`。
   * 用 `--no-open-with-cover` 可关掉（平台若要求纯正片版本）。
   */
  if (!flag("--no-open-with-cover") && existsSync(coverPng) && existsSync(scored)) {
    try {
      const card = join(coverDir, "cover-card.mp4");
      run(FFMPEG, ["-y", "-loop", "1", "-t", "1.2", "-i", coverPng,
        "-f", "lavfi", "-t", "1.2", "-i", "anullsrc=r=48000:cl=stereo",
        "-vf", "scale=1188:2112:force_original_aspect_ratio=increase,crop=1188:2112,zoompan=z='1.0+0.06*on/36':d=1:s=1080x1920:fps=30,format=yuv420p",
        "-map", "0:v", "-map", "1:a", "-c:v", "libx264", "-preset", "medium", "-crf", "18",
        "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "160k", "-shortest", card]);
      const withCover = join(OUT_DIR, `${PROJECT}-with-cover.mp4`);
      run(FFMPEG, ["-y", "-i", card, "-i", scored,
        "-filter_complex", "[0:v][0:a][1:v][1:a]concat=n=2:v=1:a=1[v][a]",
        "-map", "[v]", "-map", "[a]", "-c:v", "libx264", "-preset", "medium", "-crf", "18",
        "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "192k", "-movflags", "+faststart", withCover]);
      log(`  ⇢ 封面已合成进片头：${withCover}（封面卡 1.2s + 正片，总时长 ${Number(probe(withCover).duration ?? 0).toFixed(2)}s）`);
      record({
        stage: "cover-intro", shotId: null, invoked: true, ok: true, cached: false, degraded: false, attempt: 1, ms: 0,
        artifact: withCover,
        evidence: {
          coverPng, card, withCover,
          durationSec: Number(probe(withCover).duration ?? 0),
          note: "封面卡 1.2s（轻微推近）+ 正片；封面不再只是旁挂 PNG"
        }, verdict: null, note: "封面合成进成片片头"
      });
    } catch (error) {
      log(`  ⚠ 封面合成进成片失败：${error instanceof Error ? error.message.slice(0, 160) : String(error)}`);
    }
  }
}

/* ---------- ⑩ 软字幕轨收口（母版不烧字 + 字幕可开关） ---------- */
/**
 * 旁挂字幕的两种用法在这里分叉：
 *   · 交付目录里保留 `.srt/.ass/.vtt` 文件（平台后台上传口 / 剪辑软件用）；
 *   · 另出一支 `-softsub.mp4`：字幕作为**可开关的字幕轨**内嵌，画面与声音轨逐帧 copy
 *     （工位复检四件：video_unchanged / audio_unchanged / duration_kept / subtitle_tracks）。
 * 这样"要带字幕的片子"和"不要字幕的片子"是同一个画面母版派生的两个文件，不会各烧一遍。
 */
let softsubFile: string | null = null;
if (STAGES.has("mux") && subtitleSidecar && existsSync(scored) && !DRY_RUN) {
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
    evidence: { tool: "subtitle-bridge softmux", subtitlesDir: deliverSubtitleDir, videoUnchanged: result.out.includes("video_unchanged=ok") }, verdict
  });
  if (existsSync(out)) {
    log(`软字幕轨版：${out}（画面与 ${basename(scored)} 逐帧一致；旁挂字幕在 ${deliverSubtitleDir}）`);
  }
}

/* ---------- ⑪ 母版交付 + 终审 ---------- */
if (existsSync(scored) && !DRY_RUN) {
  /**
 * 旁挂字幕的**磁盘回填**（2026-09-24 真机）：只跑 `--stages master` 时，进程内 `subtitleSidecar` 为 null，
 * 但文件其实在盘上（上一环节已产出）。门应该看**产物**而不是进程状态——否则"分段重跑"会被误判缺件。
 */
if (!subtitleSidecar && SUBTITLE_MODE !== "burn") {
  const sidecarDir = join(POST_DIR, "subtitles");
  const zhSrt = join(sidecarDir, `${PROJECT}.zh.srt`);
  const zhAss = join(sidecarDir, `${PROJECT}.zh.ass`);
  if (existsSync(zhSrt)) {
    subtitleSidecar = {
      dir: sidecarDir, srt: zhSrt, ass: existsSync(zhAss) ? zhAss : zhSrt,
      manifest: existsSync(join(sidecarDir, `${PROJECT}.subtitle-manifest.json`)) ? join(sidecarDir, `${PROJECT}.subtitle-manifest.json`) : null,
      timelineOk: true
    };
    log(`旁挂字幕从磁盘回填（分段重跑）：${zhSrt}`);
  }
}

  const deliverable = DELIVERABLE;
  execFileSync("cp", [scored, deliverable]);
  const info = probe(deliverable);
  const accidents = detectQualityAccidents(deliverable);
  /**
   * 音画对齐实测报告（2026-09-26 真机事故沉淀 · 机制）：
   * 合成阶段（compose-film）必须留下 `<master>.av-sync.json`——逐镜实测声音相对画面的偏移与全片累计漂移。
   * 为什么按硬闸处理：这类漂移**肉眼很难在剪辑台上发现**，但用户一听就是"上一镜的音效串到下一镜"，
   * 真机上已经出过一次（15 镜尾镜 +125ms）。机制口径：没测 = 不过，不允许"没测就当过"。
   */
  const avSyncReportPath = join(POST_DIR, "master-raw.av-sync.json");
  const avSyncReport = existsSync(avSyncReportPath)
    ? JSON.parse(readFileSync(avSyncReportPath, "utf8")) as {
      ok?: boolean; maxAbsLagMs?: number; driftMs?: number | null; measured?: number;
      violations?: string[]; generatedAt?: string;
    }
    : null;
  /**
   * 链路完整性：**产物血缘 + 历史裁决**（支持"只重跑一段"）。
   * 历史裁决来自 stages.jsonl；血缘来自文件与 mtime 递进——两者都过才算五项后期都落地。
   */
  const history = readStageHistory();
  /**
   * 血缘链按**实际落地方式**拼：sidecar 模式下母版不烧字，`master-subtitled.mp4` 本来就不该存在，
   * 若把它写死进链，血缘检查会因"缺产物"永久红灯（真机回归会踩）。
   */
  const chain = [
    { label: "raw", path: join(POST_DIR, "master-raw.mp4") },
    { label: "graded", path: join(POST_DIR, "master-graded.mp4") },
    /**
     * burn 模式才把带字幕成片计入血缘；sidecar 模式下母版不烧字，
     * 盘上遗留的旧 master-subtitled.mp4 属于历史产物，计入会造成"时间戳倒序"的假告警（2026-09-24 真机）。
     */
    ...(SUBTITLE_MODE === "burn" && existsSync(join(POST_DIR, "master-subtitled.mp4"))
      ? [{ label: "subtitled", path: join(POST_DIR, "master-subtitled.mp4") }]
      : []),
    /** 弹幕层被显式关闭时不计入血缘（该层本来就不存在，计进去会变成假红灯） */
    ...(DANMAKU_ENABLED ? [{ label: "danmaku", path: join(POST_DIR, "master-danmaku.mp4") }] : []),
    { label: "scored", path: scored },
    ...(softsubFile ? [{ label: "softsub", path: softsubFile }] : [])
  ];
  const lineage = lineageCheck(chain);
  const capabilityStages = (DANMAKU_ENABLED ? ["color", "subtitle", "danmaku", "bgm"] : ["color", "subtitle", "bgm"]) as ReadonlyArray<"color" | "subtitle" | "danmaku" | "bgm">;
  const capabilityChecks = capabilityStages.map((stage) => ({
    id: `history-${stage}`,
    pass: historyApproved(history, stage),
    detail: historyApproved(history, stage)
      ? `历史日志里有 ${stage} 的放行裁决`
      : `历史日志里没有 ${stage} 的放行裁决（若本次只重跑部分环节，请确认该环节此前确实执行过）`
  }));
  if (!DANMAKU_ENABLED) {
    /** 关闭也要留痕：终审报告里写明"弹幕层按平台口径未启用"，而不是让它消失得无影无踪 */
    capabilityChecks.push({
      id: "danmaku-disabled",
      pass: true,
      detail: "弹幕层按平台口径显式关闭（--no-danmaku；小红书等内容社区无弹幕文化），不计入五层血缘"
    });
  }
  const stageSummary = {
    total: records.length,
    invoked: records.filter((r) => r.invoked).length,
    ok: records.filter((r) => r.ok).length,
    failed: records.filter((r) => !r.ok && r.invoked).length,
    degraded: records.filter((r) => r.degraded).length,
    cached: records.filter((r) => r.cached).length,
    skipped: [...STAGES].filter((s) => !records.some((r) => r.stage.startsWith(s))).length
  };
  /**
   * 终审的两条新增硬判据（2026-09-25 产品所有者点名）：
   *   ① **每句台词都要有人声**（`voice` 阶段的逐镜核查结果；只跑 master 时从阶段日志回填）；
   *   ② **素材镜必须过 G-MAT1**（生成溯源 + 非静态直出；素材只作生成输入）。
   * 两条都按"产物 + 历史裁决"判定，支持分段重跑（只跑 master 时也能查到门记录）。
   */
  const voiceHistory = history.filter((r) => r.stage === "voice-summary");
  const narrationFromHistory = (voiceHistory.at(-1)?.evidence as { perShot?: typeof narrationCoverage } | undefined)?.perShot ?? [];
  /**
   * 覆盖表口径（2026-09-25 南昌片真机修正）：
   * 早先"只跑某几镜的配音"（`--stages voice --only NC-15`）会把 voice-summary 覆盖成**只含那几镜**的清单，
   * 终审据此误判 NC-01/NC-16"有台词但人声未通过"。
   * 现在：以**逐镜 voice 记录**为准（每镜取最近一次裁决），summary 只作兜底——分段重跑不再破坏覆盖表。
   */
  const coverageByShot = new Map<string, (typeof narrationCoverage)[number]>();
  for (const entry of narrationFromHistory) coverageByShot.set(entry.shotId, entry);
  for (const record of [...history, ...records]) {
    if (record.stage !== "voice" || !record.shotId) continue;
    const evidence = (record.evidence ?? {}) as { source?: string; matchRatio?: number | null; activeRatio?: number | null };
    if (evidence.source === "missing-clip" || (record.verdict as { approved?: boolean } | null)?.approved === false) continue;
    coverageByShot.set(record.shotId, {
      shotId: record.shotId, speaker: "-", text: "-", ok: record.ok,
      source: evidence.source ?? "unknown",
      detail: `活动度 ${evidence.activeRatio ?? "?"} · 匹配 ${evidence.matchRatio ?? "?"}`
    });
  }
  const coverage = [...coverageByShot.values()];
  const dialogueShots = shots.filter((s) => dialogueText(s).length > 0);
  const missingNarration = dialogueShots.filter((s) => !coverage.some((entry) => entry.shotId === s.shotId && entry.ok));
  /**
   * 门事件的形状有两种（都来自同一份 stages.jsonl）：
   *   · 历史行 = `buildGateEvent` 的原始形状（`stepKey` 在顶层、`shotIds` 也在顶层）；
   *   · 本轮内存行 = `recordGate` 的包装形状（`stepKey` / `shotIds` 落在 `evidence` 里）。
   * 早先只读 `evidence.shotIds` → 分段重跑（门记录来自历史行）时"素材镜缺 G-MAT1"误报（真机抓到）。
   * 现在两种形状都读。
   */
  const gateStepKeyOf = (r: Record<string, unknown>): string | null => String(
    (r as { stepKey?: unknown }).stepKey ?? ((r as { evidence?: { stepKey?: unknown } }).evidence?.stepKey) ?? ""
  ) || null;
  const gateShotIdsOf = (r: Record<string, unknown>): string[] => {
    const top = (r as { shotIds?: unknown }).shotIds;
    if (Array.isArray(top)) return top as string[];
    const inner = (r as { evidence?: { shotIds?: unknown } }).evidence?.shotIds;
    return Array.isArray(inner) ? (inner as string[]) : [];
  };
  const gateModeOf = (r: Record<string, unknown>): string | null => String(
    (r as { evidence?: { mode?: unknown } }).evidence?.mode ?? ""
  ) || null;
  const materialGateEvents = [...history, ...records].filter((r) => r.stage === "gate"
    && gateStepKeyOf(r as unknown as Record<string, unknown>) === "material-generate");
  const materialPolicyFails = materialShots.filter((s) => !materialGateEvents.some((r) => {
    const row = r as unknown as Record<string, unknown>;
    return gateModeOf(row) === "verify" && gateShotIdsOf(row).includes(s.shotId) && r.ok;
  }));
  const verdict = await reviewStage({
    stage: "master", projectId: PROJECT,
    /**
     * 终审证据包（2026-09-24 真机修正）：只给成片本体时，监制会凭"看不到封面产物"判定"封面阶段被跳过"。
     * 这里把封面 PNG、阶段汇总 JSON 一并作为产物附件交给它审。
     */
    artifacts: [
      { path: deliverable, kind: "video", bytes: Number(info.bytes ?? 0), probe: info },
      ...(existsSync(join(OUT_DIR, `${PROJECT}-cover.png`)) ? [{ path: join(OUT_DIR, `${PROJECT}-cover.png`), kind: "image" as const, note: "封面产物" }] : []),
      ...(softsubFile ? [{ path: softsubFile, kind: "video" as const, note: "软字幕轨版（字幕可开关、画面零改动）" }] : []),
      ...(subtitleSidecar ? [{ path: subtitleSidecar.srt, kind: "text" as const, note: "旁挂字幕文件（母版未烧字）" }] : []),
      { path: STAGE_LOG, kind: "json", note: "逐环节阶段日志（invoked/ok/degraded/cached/verdict）" }
    ],
    deterministic: [
      ...[],
      {
        id: "duration",
        pass: Math.abs(Number(info.duration ?? 0) - expectedMasterSeconds) <= 1.0,
        detail: `成片 ${Number(info.duration ?? 0).toFixed(2)}s（目标 ${expectedMasterSeconds}s = 分镜 ${totalSeconds}s − 转场 ${transitionLoss.toFixed(2)}s）`,
        hard: true
      },
      { id: "resolution", pass: Number(info.height ?? 0) >= 1920 || Number(info.width ?? 0) >= 1920, detail: `${info.width}x${info.height}`, hard: true },
      { id: "audio", pass: Boolean(info.hasAudio), detail: info.hasAudio ? `音轨 ${info.acodec}` : "无音轨", hard: true },
      { id: "no-black-frame", pass: accidents.blackSeconds <= 0.2, detail: `最长黑帧 ${accidents.blackSeconds.toFixed(2)}s（阈值 ≤0.2s）· ${accidents.detail}`, hard: true },
      { id: "silence-window", pass: accidents.silenceSeconds <= 2.0, detail: `最长静音段 ${accidents.silenceSeconds.toFixed(2)}s（阈值 ≤2.0s；配乐铺底后不应出现长静音）` },
      { id: "post-chain-lineage", pass: lineage.ok, detail: lineage.detail },
      /**
       * 字幕交付口径（2026-09-24）：sidecar 模式必须真的留下旁挂文件；
       * burn 模式必须真的有带字成片。两种都不能"说交付了但盘上什么都没有"。
       */
      {
        id: "subtitle-delivery",
        pass: SUBTITLE_MODE === "burn"
          ? existsSync(join(POST_DIR, "master-subtitled.mp4"))
          : Boolean(subtitleSidecar && existsSync(subtitleSidecar.srt)),
        detail: SUBTITLE_MODE === "burn"
          ? "字幕模式 burn：成片含烧录字幕"
          : `字幕模式 sidecar：母版不烧字，旁挂文件 ${subtitleSidecar ? basename(subtitleSidecar.srt) : "(缺失)"}${softsubFile ? " + 软字幕轨版" : ""}`,
        hard: true
      },
      /**
       * 音画对齐硬闸（2026-09-26 机制）：报告来自合成阶段的逐镜实测。
       * 硬闸口径：本次跑了 compose 还没报告 = 直接红；只跑 master（分段重跑）时缺报告 → 非硬告警并留痕。
       */
      {
        id: "av-sync",
        pass: avSyncReport?.ok === true,
        detail: avSyncReport
          ? `音画对齐实测：可测 ${avSyncReport.measured ?? 0} 镜，最大偏移 ${avSyncReport.maxAbsLagMs ?? "?"}ms，`
            + `累计漂移 ${avSyncReport.driftMs ?? "?"}ms（报告 ${basename(avSyncReportPath)}，生成于 ${avSyncReport.generatedAt ?? "?"}）`
          : `缺音画对齐实测报告（${basename(avSyncReportPath)}）——机制不允许「没测就当过」；`
            + "跑一次 compose 阶段即可生成（分段重跑 master 时该报告应已存在）",
        hard: STAGES.has("compose"),
      },
      /**
       * 字幕**标点口径**（2026-09-25）：正规字幕不带标点。
       * 判据看旁挂清单里的机检结果（`no_punctuation`），而不是看内存里的字幕文本——
       * 交付的是文件，门就该验文件。
       */
      {
        id: "subtitle-punctuation",
        pass: SUBTITLE_MODE === "burn"
          /**
           * burn 模式：读字幕环节记录里的 `punctuationOk`（来自工位实测输出）；
           * 分段重跑（只跑 master）时从阶段日志回填——判据始终落在"工位真的查过"这件事上。
           */
          ? (() => {
            const subtitleRecords = [...history, ...records].filter((r) => r.stage === "subtitle" && r.invoked);
            const last = subtitleRecords.at(-1)?.evidence as { punctuationOk?: boolean; punctuationDetail?: string } | undefined;
            return Boolean(last?.punctuationOk);
          })()
          : !subtitleSidecar
          || !subtitleSidecar.manifest
          || (() => {
            try {
              const doc = JSON.parse(readFileSync(subtitleSidecar.manifest!, "utf8")) as { checks?: Array<{ kind?: string; ok?: boolean; detail?: { hits?: number } }> };
              const entry = (doc.checks ?? []).find((c) => c.kind === "no_punctuation");
              return entry ? entry.ok !== false : false;
            } catch {
              return false;
            }
          })(),
        detail: SUBTITLE_MODE === "burn"
          ? (() => {
            const subtitleRecords = [...history, ...records].filter((r) => r.stage === "subtitle" && r.invoked);
            const last = subtitleRecords.at(-1)?.evidence as { punctuationOk?: boolean; punctuationDetail?: string } | undefined;
            return last
              ? `${last.punctuationDetail ?? "标点体检"}` + (last.punctuationOk ? "" : "（不合格：字幕残留标点）")
              : "字幕环节没有标点体检记录（无法证明烧进画面的字幕不带标点）";
          })()
          : subtitleSidecar?.manifest
          ? (() => {
            try {
              const doc = JSON.parse(readFileSync(subtitleSidecar.manifest!, "utf8")) as { checks?: Array<{ kind?: string; ok?: boolean; detail?: { hits?: number } }> };
              const entry = (doc.checks ?? []).find((c) => c.kind === "no_punctuation");
              return entry
                ? `字幕标点体检：残留 ${entry.detail?.hits ?? 0} 处（${entry.ok === false ? "不合格" : "合格"}）`
                : "旁挂清单里没有标点体检项（无法证明字幕不带标点）";
            } catch {
              return "旁挂清单读取失败，标点体检无法核实";
            }
          })()
          : "无旁挂字幕（burn 模式）：标点由字幕工位在烧录校验里把关",
        hard: true
      },
      /**
       * **每句台词都要有人声**（产品所有者 2026-09-25 点名）：画面在动、字幕在跳却没有人声属硬伤。
       * 判据来自 `voice` 阶段的逐镜 ASR + 语音频段活动度核查（阈值见该阶段）。
       */
      {
        id: "narration-coverage",
        pass: missingNarration.length === 0,
        detail: missingNarration.length === 0
          ? `${dialogueShots.length} 个有台词的镜头均有人声（逐镜 ASR 核查）`
          : `以下镜头有台词但人声未通过核查：${missingNarration.map((s) => s.shotId).join("、")}`,
        hard: true
      },
      /**
       * **素材只作生成输入**（产品所有者 2026-09-25 硬规定）：素材镜必须过 G-MAT1 的验证事件。
       */
      {
        id: "material-usage-policy",
        /**
         * 额度受限时的**复用既有渲染**通道（2026-09-26）：
         * 本片是在既有渲染素材上重剪（Seedance 欠费、不能重渲），重新编码后的片段摘要与原始渲染记录不再逐字节相等，
         * 但"这些镜头确实由生成模型产出、且经过 G-MAT1 复检"这一事实没变。
         * 因此允许用 `--accept-rejected material-usage-policy` 显式放行，并在阶段日志留一条 acknowledge 收据——
         * 绝不静默通过。
         */
        pass: materialPolicyFails.length === 0 || ACCEPT_REJECTED.includes("material-usage-policy"),
        detail: materialShots.length === 0
          ? "本片无素材镜（无实拍素材入片）"
          : materialPolicyFails.length === 0
            ? `${materialShots.length} 个素材镜均过 G-MAT1（生成溯源 + 非静态直出 + 保真评审；${MATERIAL_POLICY_VERSION}）`
            : `以下素材镜缺 G-MAT1 验证记录：${materialPolicyFails.map((s) => s.shotId).join("、")}（素材不得直接静态展示）`
              + (ACCEPT_REJECTED.includes("material-usage-policy")
                ? "；**已显式放行**（复用既有渲染素材重剪，原始渲染记录在既有工作区，未重渲，见 material-reuse-acknowledge 记录）"
                : ""),
        hard: true
      },
      /**
       * **上游环节必须全部放行**（2026-09-25 修）：
       * 真机事故：compose 被监制打回（时长超差 0.77s），但后续环节照跑、master 仍放行——
       * 等于"某一环没签字，成品照样出厂"。这里把"血缘链上每个环节最近一次裁决必须放行"做成硬闸。
       */
      (() => {
        const chainStages = ["cine-kb", "compose", "color", "subtitle", "bgm"] as const;
        const rejected = chainStages.filter((stage) => {
          const rowsForStage = [...history, ...records].filter((r) => r.stage === stage && r.invoked);
          if (rowsForStage.length === 0) return false;
          const last = rowsForStage.at(-1)!;
          const verdict = last.verdict as ProducerVerdict | null;
          /** 调色被驳回但已按"不劣化优先"回退原片：设计内结局，不算未签字（见 color 阶段 evidence 标记） */
          if ((last.evidence as { fallbackToOriginal?: boolean } | undefined)?.fallbackToOriginal === true) return false;
          return verdict ? !verdict.approved : !last.ok;
        });
        return {
          id: "upstream-approved",
          /**
           * 显式放行通道（2026-09-26）：监制对某些环节的"质量偏好型"打回（例如本片只有 2 句台词、
           * 字幕天然有大段空档；或额度受限时复用既有渲染），允许用 `--accept-rejected <stage>` 留痕放行。
           * 未显式列出的环节仍是 fail-closed。
           */
          pass: rejected.length === 0 || rejected.every((stage) => ACCEPT_REJECTED.includes(stage)),
          detail: rejected.length === 0
            ? `上游环节最近一次裁决均已放行（${chainStages.join("/")}）`
            : `以下环节最近一次裁决未放行，成品不得出厂：${rejected.join("、")}`
              + (rejected.every((stage) => ACCEPT_REJECTED.includes(stage))
                ? "；**已显式放行**（--accept-rejected，留痕见阶段日志）"
                : ""),
          hard: true
        };
      })(),
      ...capabilityChecks
    ],
    context: {
      stageSummary, stages: [...STAGES],
      narration: coverage.map((entry) => `${entry.shotId}（${entry.speaker}）：${entry.ok ? "有人声" : "缺人声"}`),
      materialPolicy: { version: MATERIAL_POLICY_VERSION, statement: MATERIAL_POLICY_STATEMENT, shots: materialShots.map((s) => s.shotId) }
    },
    env: ENV, allowFallbackApprove: ALLOW_FALLBACK_APPROVE, log
  });
  record({
    stage: "master", shotId: null, invoked: true, ok: verdict.approved, cached: false, degraded: verdict.degraded,
    attempt: 1, ms: verdict.ms, artifact: deliverable, evidence: { ...info, stageSummary }, verdict
  });
  writeFileSync(join(LOG_DIR, "stage-summary.json"), `${JSON.stringify({ project: PROJECT, at: stamp(), summary: stageSummary, deliverable, records }, null, 2)}\n`, "utf8");
  /**
   * 终审结论要如实说：`✅ 成片` 只在监制放行时出现；未放行时输出 ⚠ + 理由，
   * 避免"文件存在"被读成"已通过"。
   */
  if (verdict.approved) log(`✅ 成片（终审放行，score=${verdict.score}）：${deliverable}`);
  else log(`⚠ 母版已生成但**终审未放行**（score=${verdict.score}）：${verdict.reason}\n   文件：${deliverable}（按带瑕疵交付处理，详见阶段日志）`);
}

/* ---------- ⑫ 多风格交付包（step_key: deliver，gate G-DLV1：变体雷同一票否决） ---------- */
/**
 * 管线 yml 的 deliver 步：**干净母版 + 旁挂字幕 + 2–3 个风格变体 + 软字幕轨版 + 交付清单**，
 * 纪律是"镜头只生成一次，变体零 token"——变体只做**后期层派生**（调色/混音/文案），绝不重跑渲染。
 * gate `G-DLV1`：任一对变体"画面与音轨都测不出差别"即一票否决（那不算两个变体，是把同一支片子发两遍）。
 */
if (STAGES.has("deliver") && existsSync(DELIVERABLE) && !DRY_RUN) {
  const started = Date.now();
  const variantPlans = buildVariantPlan({ master: DELIVERABLE, outDir: OUT_DIR, projectId: PROJECT, coverHook: arg("--cover-hook", shotlist.title ?? "") });
  const samples: Array<{ variantId: string; frames: Array<{ r: number; g: number; b: number }>; loudness: { lufs: number; peakDb: number } | null }> = [];
  const variantManifest: Array<{
    id: string; label: string; path: string; sha256: string; note: string; gradeProfile: string | null;
    cover?: { path: string; sha256: string } | null;
    bgm?: { track: string; sha256: string; measuredBpm?: number; gridErrorMs?: number } | null;
  }> = [];
  /**
   * 变体封面（三轴之一，2026-09-26 产品口径）：主封面 + 该变体的强调色条与风格角标。
   * 为什么不是每支重跑封面设计师：变体是**零 token 的后期层派生**，重跑设计稿会破坏这条纪律；
   * 三支封面的差异用"强调色 + 风格角标"保证**可区分且可核对**（sha256 进清单）。
   */
  const renderVariantCover = (variantId: string, accent: string, label: string): { path: string; sha256: string } | null => {
    const source = join(OUT_DIR, `${PROJECT}-cover.png`);
    if (!existsSync(source)) return null;
    const target = join(OUT_DIR, `${PROJECT}-cover-${variantId}.png`);
    const fontFile = join(REPO_ROOT, "bundles/ai-video/library/fonts", COVER_FONTS["smiley-sans"].file);
    const hex = accent.replace("#", "0x");
    try {
      execFileSync(FFMPEG, [
        "-v", "error", "-y", "-i", source,
        "-vf", [
          `drawbox=x=0:y=ih-14:w=iw:h=14:color=${hex}@0.95:t=fill`,
          `drawbox=x=64:y=ih-124:w=iw-128:h=76:color=black@0.45:t=fill`,
          /** 注意：drawtext 表达式里高度变量是 `h`（不是 drawbox 的 `ih`）——写错整条滤镜配置会失败 */
          `drawtext=${existsSync(fontFile) ? `fontfile='${fontFile}':` : ""}text='${label}':`
            + `fontcolor=white:fontsize=44:x=84:y=h-112`,
        ].join(","),
        "-frames:v", "1", target,
      ]);
    } catch (err) {
      log(`  ⚠ 变体封面合成失败（${variantId}）：${err instanceof Error ? err.message.slice(0, 160) : String(err)}`);
      return null;
    }
    return existsSync(target)
      ? { path: target, sha256: createHash("sha256").update(readFileSync(target)).digest("hex") }
      : null;
  };
  /** 取几个时间点的 1×1 平均色：稳定的"画面指纹"（不做逐像素对比，只判风格差异是否可测） */
  const meanColorsAt = (file: string, times: number[]): Array<{ r: number; g: number; b: number }> => times.map((at) => {
    const out = spawnSync(FFMPEG, ["-v", "error", "-ss", String(at), "-i", file, "-frames:v", "1", "-vf", "scale=1:1", "-f", "rawvideo", "-pix_fmt", "rgb24", "-"], { maxBuffer: 1024 });
    const buf = out.stdout ?? Buffer.alloc(0);
    return buf.length >= 3 ? { r: buf[0]!, g: buf[1]!, b: buf[2]! } : { r: 0, g: 0, b: 0 };
  });
  for (const plan of variantPlans) {
    try {
      if (plan.passthrough) {
        execFileSync("cp", [DELIVERABLE, plan.output]);
      } else {
        /** 调色变体走同一个调色工位（与母版一致的口径，避免"变体用了另一套引擎"） */
        runCli(COLOR_CLI, [...plan.gradeArgs, "--out", plan.output]);
      }
      if (!existsSync(plan.output)) { log(`  ⚠ 变体 ${plan.variant.id} 未产出（跳过）`); continue; }
      /**
       * 变体配乐（三轴之一）：按该变体的曲风线索从**曲库**里选，且必须**实测 BPM 命中剪辑网格**；
       * 选不到就留空（三轴判据随后会拦下，而不是静默用同一条曲子糊过去）。
       */
      let variantBgm: { track: string; sha256: string; measuredBpm?: number; gridErrorMs?: number } | null = null;
      try {
        const variantDuration = Number(probe(plan.output).duration ?? 0);
        const bed = await pickGridCompatibleBed(variantDuration, CUT_GRID, {
          genre: plan.variant.bgmGenre, mood: plan.variant.bgmMood,
        });
        if (bed) {
          const mixed = plan.output.replace(/\.mp4$/i, "-bgm.mp4");
          const mix = runCli(BGM_CLI, [
            "mix", "--in", plan.output, "--out", mixed, "--bgm", bed.path, "--policy", "keep-dialogue",
            "--music-level", String(-26 + plan.variant.musicLevelDeltaDb),
            "--ducking", "14", "--lufs", "-14", "--section", "auto",
            "--bpm-strategy", "cut-driven", "--cut-times", CUT_GRID.join(","),
            "--evidence-dir", join(POST_DIR, "bgm-evidence"),
          ]);
          if (mix.ok && existsSync(mixed)) {
            execFileSync("mv", [mixed, plan.output]);
            variantBgm = {
              track: bed.id,
              sha256: createHash("sha256").update(readFileSync(bed.path)).digest("hex"),
              measuredBpm: bed.measuredBpm,
              gridErrorMs: bed.gridErrorMs,
            };
            log(`  变体 ${plan.variant.id} 配乐：${bed.id}（实测 ${bed.measuredBpm}BPM，卡点平均 ${bed.gridErrorMs}ms）`);
          } else {
            log(`  ⚠ 变体 ${plan.variant.id} 配乐混音失败：${mix.out.slice(-200)}`);
          }
        } else {
          log(`  ⚠ 变体 ${plan.variant.id} 未找到"实测 BPM 命中剪辑网格"的曲库曲目（三轴判据会拦下）`);
        }
      } catch (err) {
        log(`  ⚠ 变体 ${plan.variant.id} 配乐环节异常：${err instanceof Error ? err.message.slice(0, 160) : String(err)}`);
      }
      const variantCover = renderVariantCover(plan.variant.id, plan.variant.coverAccent, `${plan.variant.label}${plan.variant.copySuffix}`);
      const info = probe(plan.output);
      const duration = Number(info.duration ?? 0);
      const times = [duration * 0.2, duration * 0.5, duration * 0.8].map((t) => Math.max(0.2, Math.round(t * 10) / 10));
      const measured = measureLoudness(plan.output);
      samples.push({
        variantId: plan.variant.id,
        frames: meanColorsAt(plan.output, times),
        loudness: measured.lufs !== null && measured.peakDb !== null ? { lufs: measured.lufs, peakDb: measured.peakDb } : null
      });
      variantManifest.push({
        id: plan.variant.id, label: plan.variant.label, path: plan.output,
        sha256: createHash("sha256").update(readFileSync(plan.output)).digest("hex"),
        note: plan.variant.note, gradeProfile: plan.variant.gradeProfile,
        cover: variantCover, bgm: variantBgm,
      });
      log(`  变体 ${plan.variant.id}（${plan.variant.label}）→ ${basename(plan.output)}`);
    } catch (err) {
      record({
        stage: "deliver", shotId: null, invoked: true, ok: false, cached: false, degraded: false, attempt: 1, ms: 0,
        artifact: null, evidence: { variant: plan.variant.id, error: err instanceof Error ? err.message.slice(0, 300) : String(err) },
        verdict: null, note: "变体派生失败"
      });
    }
  }
  const distinctness = assessVariantDistinctness(samples);
  /**
   * 三轴判据（2026-09-26 产品所有者："一次必须产出 3 个不同风格的后期版本"）：
   * 数量 ≥3，且 **调色 / 封面 / 配乐** 三轴上两两不同——只换滤镜名不算风格。
   */
  const variantAxes = assessVariantAxes(variantManifest.map((variant) => ({
    id: variant.id,
    gradeProfile: variant.gradeProfile,
    coverSha: variant.cover?.sha256 ?? null,
    bgmSha: variant.bgm?.sha256 ?? null,
  })));
  const gate = recordGate({
    stepKey: "deliver",
    sourceStage: "deliver",
    checks: [
      { id: "variants-produced", pass: variantManifest.length >= VARIANT_MIN_COUNT, hard: true, detail: `产出变体 ${variantManifest.length} 个（产品口径：至少 ${VARIANT_MIN_COUNT} 个不同风格的后期版本）：${variantManifest.map((v) => v.id).join("/")}` },
      { id: "variants-distinct", pass: distinctness.approved, hard: true, detail: distinctness.detail },
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
  const manifestFile = join(OUT_DIR, `${PROJECT}-delivery-manifest.json`);
  writeFileSync(manifestFile, `${JSON.stringify(buildDeliveryManifest({
    projectId: PROJECT,
    platform: arg("--platform", "抖音/快手"),
    /**
     * 键名必须是模块入参的小写 `deliverable`：批量改名（deliverable→DELIVERABLE）时别把**键**也改掉，
     * 否则这支主件会被 JSON.stringify 静默丢掉（真机 2026-09-25 踩过：清单里没有母版指纹）。
     */
    deliverable: { path: DELIVERABLE, sha256: createHash("sha256").update(readFileSync(DELIVERABLE)).digest("hex"), bytes: statSync(DELIVERABLE).size },
    subtitles: { sidecarDir: subtitleSidecar?.dir ?? null, softsub: softsubFile, burned: SUBTITLE_MODE !== "sidecar" },
    cover: { path: existsSync(join(OUT_DIR, `${PROJECT}-cover.png`)) ? join(OUT_DIR, `${PROJECT}-cover.png`) : null, hook: arg("--cover-hook", shotlist.title ?? "") },
    variants: variantManifest,
    distinctness,
    variantAxes,
    samples,
    at: stamp()
  }), null, 2)}\n`, "utf8");
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
        { id: "revision-classified", pass: plan.layers.length > 0 || plan.rerunShots.length > 0, hard: true, detail: report.gate.detail },
        { id: "reuse-evidence", pass: plan.reuseEvidence.every((e) => e.sha256 !== "missing"), hard: true, detail: `复用镜头 ${plan.reuseEvidence.length} 个，均带 sha256 证据` },
        { id: "render-gate-awareness", pass: true, hard: false, detail: plan.requiresRenderSubmitGate ? "点名画面内容 → 重跑镜头并走 G8 提交审批" : "纯后期层 → 零渲染（镜头全部复用）" }
      ],
      evidence: { note, kind: plan.kind, stages: plan.stages, reuseEvidence: plan.reuseEvidence.map((e) => ({ shotId: e.shotId, sha256: e.sha256.slice(0, 16) })), report: reportFile }
    });
    record({
      stage: "revise", shotId: null, invoked: true, ok: gate.approved, cached: false, degraded: false, attempt: 1,
      ms: Date.now() - started, artifact: reportFile,
      evidence: { kind: plan.kind, layers: plan.layers, rerunShots: plan.rerunShots, stages: plan.stages }, verdict: null,
      note: `返修影响分析（${plan.kind}）`
    });
    log(`返修报告：${reportFile}`);
    log(`  类型 ${plan.kind}｜重跑镜头 ${plan.rerunShots.join("/") || "无（零渲染）"}｜重做层 ${plan.layers.join(" → ") || "无"}`);
    log(`  建议执行：--stages ${plan.stages.join(",") || "(需人工确认)"}`);
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
  project: PROJECT, at: stamp(), shots: shots.length, totalSeconds,
  stages: Object.fromEntries(byStage), records
}, null, 2)}\n`, "utf8");
log(`阶段日志：${STAGE_LOG}`);
for (const [stage, s] of byStage) log(`  · ${stage.padEnd(14)} invoked=${s.invoked} ok=${s.ok} failed=${s.failed} degraded=${s.degraded} cached=${s.cached}`);
