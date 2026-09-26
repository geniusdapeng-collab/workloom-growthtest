/**
 * video/whiteboard/narration.ts —— 口播稿 → 逐句配音 → SRT（T-2026-0926-0020）
 *
 * 这条链是全片的时间权威：**幕长与元素时序都由配音的真实时长派生**，
 * 因此这里不引入 ASR，也不猜时间——逐句合成、逐句量时长、按真实时长拼 SRT。
 *
 * 为什么逐句合成，而不是整段合成再对齐：
 *   ① 上游白板引擎的 `sceneDurationMs` / `reveal.startMs` 是**毫秒级**契约，
 *      整段合成只能拿到一个总时长，句间边界得靠 ASR 反推（额外模型、额外误差）；
 *   ② 逐句合成天然给出句边界，SRT 与音频**构造即一致**（不存在"字幕对不上"的漂移）；
 *   ③ 单句失败只重试该句，不用整条重合成。
 *
 * 音色走本机配音工位（`bundles/ai-video/connectors/voice-bridge`）：
 * 声纹不出域——参考音频只在工位目录，本模块只按 profile 名请求合成。
 */
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import type { SrtCue } from "./srt.js";
import { buildSrt } from "./srt.js";

const execFileAsync = promisify(execFile);
const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, "../../../../..");

export class NarrationError extends Error {
  constructor(message: string, public readonly detail?: string) {
    super(message);
    this.name = "NarrationError";
  }
}

/* ================= 分句 ================= */

/**
 * 口播稿分句（确定性，纯函数）。
 *
 * 规则：
 *   · **文档脚手架行整行丢弃**：标题（`#`）、引用（`>`）、表格（`|`）、分隔线（`---`）、
 *     注释（`<!--`）——它们是脚本的结构与元数据，不是要朗读的内容。
 *     真机踩过：口播稿文件带 `> 用途：…` 的说明头，未过滤时第一句配音会把说明读出来；
 *   · 列表符号（`-` / `1.` 等）只剥符号、保留正文；
 *   · 行内 Markdown（`**加粗**`、`` `代码` ``、`[文字](链接)`）只留文字；
 *   · 按句末标点（。！？!?；;）与换行切分，保留标点；
 *   · 过短的碎片（默认 <6 字）并入前一句，避免"好了！"这类碎句各占一个元素位。
 */
export function splitSentences(script: string, minChars = 6): string[] {
  const cleaned = script
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .filter((line) => !/^\s{0,4}(#{1,6}\s+|>\s?|\||-{3,}|<!--)/.test(line))
    .map((line) => line
      .replace(/^\s{0,4}([-*+]\s+|\d+[.、)]\s+)/, "")
      .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")   // Markdown 链接 → 链接文字
      .replace(/\*\*|__|`/g, "")                  // 加粗/代码标记
      .trim())
    .filter((line) => line.length > 0)
    .join("\n");

  const raw = cleaned
    .split(/(?<=[。！？!?；;])|\n+/)
    .map((s) => s.replace(/\s+/g, " ").trim())
    .filter((s) => s.length > 0);

  const out: string[] = [];
  for (const piece of raw) {
    const prev = out[out.length - 1];
    if (prev !== undefined && piece.replace(/[。！？!?；;，,、]/g, "").length < minChars) {
      out[out.length - 1] = `${prev}${piece}`;
    } else {
      out.push(piece);
    }
  }
  return out;
}

/* ================= 配音工位 ================= */

export interface NarrationConfig {
  profile: string;
  lufs: number;
  gapMs: number;
  bridgeUrl: string;
  timeoutMs: number;
  ffmpeg: string;
  ffprobe: string;
  /** 逐句合成的并发度（本机配音引擎实测：3 并发 ≈ 155s 出 3 句，串行 ≈ 420s） */
  concurrency: number;
}

export function narrationConfig(env: NodeJS.ProcessEnv = process.env): NarrationConfig {
  return {
    profile: env.WHITEBOARD_NARRATION_PROFILE?.trim() || env.WORKLOOM_VOICE_PROFILE?.trim() || "zh-myvoice",
    lufs: Number(env.WHITEBOARD_NARRATION_LUFS ?? "-16"),
    gapMs: Number(env.WHITEBOARD_NARRATION_GAP_MS ?? "240"),
    bridgeUrl: env.WORKLOOM_VOICE_BRIDGE_URL?.trim() || "http://127.0.0.1:9776",
    timeoutMs: Number(env.WHITEBOARD_NARRATION_TIMEOUT_MS ?? 600_000),
    ffmpeg: env.WHITEBOARD_FFMPEG?.trim() || env.FFMPEG_PATH?.trim() || "ffmpeg",
    ffprobe: env.WHITEBOARD_FFPROBE?.trim() || "ffprobe",
    concurrency: Math.max(1, Math.min(6, Number(env.WHITEBOARD_NARRATION_CONCURRENCY ?? "3"))),
  };
}

export interface NarrationProgress {
  done: number;
  total: number;
  /** 正在合成的句子（人类可读进度） */
  current: string;
  startedAt: string;
}

export interface NarrationSegment {
  index: number;
  text: string;
  startMs: number;
  endMs: number;
  /** 逐句音频文件（排障 / 单句重合成用；成片只用拼好的整轨） */
  file: string;
}

export interface NarrationResult {
  segments: NarrationSegment[];
  cues: SrtCue[];
  srt: string;
  wavPath: string;
  totalMs: number;
  profile: string;
  /** 复用的分句数（断点续跑证据：重跑时这个数字应该是"已合成的那些"） */
  reusedSegments: number;
}

/**
 * 分句清单（`segments.manifest.json`）——**复用的正确性凭据**。
 *
 * 修的是一个真实缺陷：最早按「文件是否存在」判断复用，键是**下标**。
 * 于是改了稿子（第 3 句从"A"变成"B"）再跑，第 3 句的音频还是旧的 A——
 * 字幕写着 B、耳朵听到 A，而且没有任何报错。现在复用必须同时满足：
 *   ① 文件存在；② 清单里该下标的 `sha256(文本)` 与当前稿子一致；③ 音色档案一致。
 * 三者任一不符就重新合成该句。
 */
export interface SegmentManifestEntry {
  index: number;
  sha256: string;
  profile: string;
  file: string;
  seconds: number;
}

export interface SegmentManifest {
  schema: "workloom.whiteboard-narration/v1";
  scriptSha256: string;
  profile: string;
  segments: SegmentManifestEntry[];
  /**
   * 清单来源：
   *   · `synthesized` = 本次真实合成写入；
   *   · `assumed-from-existing-files` = 首次引入清单时的**一次性迁移**：
   *     任务目录里已有分句音频、但还没有清单（旧版本产物），按"这些文件就对应当前稿子"假设补写。
   *     仅在下标/文件齐全时成立，并会打警告——不是常规路径。
   */
  derivedFrom?: "synthesized" | "assumed-from-existing-files";
}

function textSha(text: string): string {
  return createHash("sha256").update(text).digest("hex").slice(0, 16);
}

/**
 * 单句是否可复用（导出为**纯函数**，便于单测穷举"改了稿子/换了音色/文件丢了"三种情况）。
 * 判定必须同时满足：文件存在 + 清单里该句文本哈希一致 + 音色档案一致。
 */
export function reusableSegment(args: {
  manifest: SegmentManifest | null;
  index: number;
  text: string;
  profile: string;
  fileExists: boolean;
}): boolean {
  if (!args.fileExists || !args.manifest) return false;
  const entry = args.manifest.segments.find((s) => s.index === args.index);
  if (entry) return entry.sha256 === textSha(args.text) && entry.profile === args.profile;
  // 一次性迁移路径：清单刚由"已有文件"推导出来，尚无逐条记录
  return args.manifest.derivedFrom === "assumed-from-existing-files";
}

function readManifest(path: string): SegmentManifest | null {
  if (!existsSync(path)) return null;
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as SegmentManifest;
    return parsed.schema === "workloom.whiteboard-narration/v1" ? parsed : null;
  } catch {
    return null;
  }
}

/** 跑一个子进程；失败信息只保留 stderr 尾部（排障够用，不污染日志） */
async function run(cmd: string, args: string[], timeoutMs: number): Promise<string> {
  try {
    const { stdout } = await execFileAsync(cmd, args, {
      timeout: timeoutMs, maxBuffer: 32 * 1024 * 1024, killSignal: "SIGKILL",
    });
    return stdout;
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string; message?: string; killed?: boolean };
    if (e.killed) throw new NarrationError(`命令超时被终止：${cmd} ${args.slice(0, 3).join(" ")}`);
    throw new NarrationError(
      `命令失败：${cmd}`,
      `${e.stdout ?? ""}\n${e.stderr ?? e.message ?? ""}`.trim().slice(-1200),
    );
  }
}

/** 音频时长（秒）——ffprobe 是唯一事实源，不靠文件名或估算 */
export async function probeDurationSec(file: string, ffprobe = "ffprobe"): Promise<number> {
  const out = await run(ffprobe, [
    "-v", "error", "-show_entries", "format=duration", "-of", "default=nw=1:nk=1", file,
  ], 60_000);
  const value = Number(out.trim());
  if (!Number.isFinite(value) || value <= 0) throw new NarrationError(`ffprobe 读不到时长：${file}`);
  return value;
}

export interface SynthesizeOptions {
  script: string;
  outDir: string;
  env?: NodeJS.ProcessEnv;
  /** 进度回调（长任务必须可见：本机引擎单句 80–220s，30 句就是几十分钟） */
  onProgress?: (progress: NarrationProgress) => void;
}

/**
 * 口播稿 → 配音轨 + SRT。
 *
 * 产物：`<outDir>/seg-XX.wav`（逐句）+ `<outDir>/narration.wav`（整轨）+ `<outDir>/narration.srt`。
 * 已存在且时长可读的分句音频会被**复用**（同一份稿子重跑不重复烧算力）。
 */
export async function synthesizeNarration(opts: SynthesizeOptions): Promise<NarrationResult> {
  const env = opts.env ?? process.env;
  const cfg = narrationConfig(env);
  const sentences = splitSentences(opts.script);
  if (sentences.length === 0) throw new NarrationError("口播稿为空：分句后没有任何句子");

  const voiceCli = join(REPO_ROOT, "bundles/ai-video/connectors/voice-bridge/cli.mjs");
  if (!existsSync(voiceCli)) throw new NarrationError(`配音工位 CLI 不存在：${voiceCli}`);
  mkdirSync(opts.outDir, { recursive: true });

  /**
   * 合成暂存区必须落在**系统临时目录**里，不能直接写进任务目录。
   *
   * 原因：配音工位有"路径监狱"（core.mjs#assertPathAllowed），只允许写白名单根目录
   * （工位目录 / ~/Movies / ~/Desktop / os.tmpdir()）。任务目录在仓库内，不在白名单里，
   * 直接写会被 `path_not_allowed` 拒绝（真机踩到）。
   *
   * 这里刻意**不放宽工位白名单**（那是全局安全边界，为一个调用方放宽代价太大），
   * 而是让工位写它自己的合法空间，再由本模块把产物复制进任务目录：
   * 权限最小的做法，也符合"工位只服务自己的目录"的设计。
   */
  const staging = mkdtempSync(join(tmpdir(), "workloom-wb-voice-"));

  // ① 逐句合成（幂等复用 + 有界并发）
  //
  // 为什么必须并发：本机 MLX 配音引擎单句耗时 80–220s（含权重换入换出），
  // 30 句全串行要接近一小时；实测 3 并发总墙钟 155s 出 3 句（≈52s/句），
  // 因为引擎侧请求可以重叠。并发度可配置（WHITEBOARD_NARRATION_CONCURRENCY，默认 3），
  // 上限 6 —— 这台机器内存有限，再高会触发引擎换页反而更慢。
  const files = sentences.map((_, i) => join(opts.outDir, `seg-${String(i + 1).padStart(2, "0")}.wav`));
  const durations: number[] = [];
  const startedAt = new Date().toISOString();
  let done = 0;
  let reused = 0;
  const report = (current: string) => opts.onProgress?.({ done, total: sentences.length, current, startedAt });

  // 复用凭据（清单）：缺失但分句文件齐全时，按"文件对应当前稿子"做**一次性迁移**并告警
  const manifestPath = join(opts.outDir, "segments.manifest.json");
  let manifest = readManifest(manifestPath);
  const scriptSha = createHash("sha256").update(sentences.join("\u0000")).digest("hex");
  if (!manifest || manifest.scriptSha256 !== scriptSha) {
    const existing = sentences.filter((_, i) => existsSync(files[i]!)).length;
    /**
     * 旧产物迁移（引入清单之前的任务目录只有 seg-NN.wav、没有清单，无法自证文本对应关系）。
     * 默认**不猜**：宁可重合成，也不冒"字幕写 B、耳朵听 A"的风险。
     * 明确知道"就是这份稿子生成的"时，用 `WHITEBOARD_NARRATION_TRUST_EXISTING=1` 显式声明信任，
     * 才按已有文件补写清单（打警告，且清单标记 `derivedFrom=assumed-from-existing-files`）。
     */
    const trustExisting = (opts.env?.WHITEBOARD_NARRATION_TRUST_EXISTING
      ?? process.env.WHITEBOARD_NARRATION_TRUST_EXISTING ?? "0") === "1";
    if (!manifest && existing > 0 && trustExisting) {
      console.warn(
        `[whiteboard] 分句清单缺失，按 WHITEBOARD_NARRATION_TRUST_EXISTING=1 信任现有 `
        + `${existing}/${sentences.length} 个分句文件（一次性迁移路径；若稿子已改动，请先清空 ${opts.outDir}/seg-*.wav 再重跑）`,
      );
      manifest = {
        schema: "workloom.whiteboard-narration/v1",
        scriptSha256: scriptSha,
        profile: cfg.profile,
        segments: [],
        derivedFrom: "assumed-from-existing-files",
      };
    } else if (!manifest && existing > 0) {
      console.warn(
        `[whiteboard] 分句清单缺失且存在旧的 ${existing} 个分句文件：默认不猜（全部重新合成）。`
        + "确认这批文件就是当前稿子生成的，可置 WHITEBOARD_NARRATION_TRUST_EXISTING=1 复用",
      );
      manifest = { schema: "workloom.whiteboard-narration/v1", scriptSha256: scriptSha, profile: cfg.profile, segments: [] };
    } else {
      // 稿子变了：旧清单作废（不复用任何旧音频，避免"字幕写 B、耳朵听 A"）
      manifest = { schema: "workloom.whiteboard-narration/v1", scriptSha256: scriptSha, profile: cfg.profile, segments: [] };
    }
  }
  const reusable = (i: number): boolean => {
    return reusableSegment({
      manifest, index: i, text: sentences[i]!, profile: cfg.profile, fileExists: existsSync(files[i]!),
    });
  };

  const synthesizeOne = async (i: number, text: string): Promise<void> => {
    const file = files[i]!;
    if (reusable(i)) {
      durations[i] = await probeDurationSec(file, cfg.ffprobe);
      /**
       * 复用也要**补写清单条目**：否则"旧文件（assumed 路径复用）+ 新合成条目"混在一起时，
       * 下一次重跑会因为 `derivedFrom` 已被置为 synthesized 而失去 assumed 兜底，
       * 把复用过的那批句子又全部重合成（真机踩到：26 句差点白烧）。
       * 复用即登记 → 清单逐步被真实哈希填满，之后每次都严格按哈希判定。
       */
      if (!manifest!.segments.some((s) => s.index === i)) {
        manifest!.segments = [...manifest!.segments, {
          index: i, sha256: textSha(text), profile: cfg.profile, file, seconds: durations[i]!,
        }].sort((a, b) => a.index - b.index);
        writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
      }
      reused += 1;
      done += 1;
      report(text);
      return;
    }
    {
      const staged = join(staging, `seg-${String(i + 1).padStart(2, "0")}.wav`);
      try {
        await run(process.execPath, [
          voiceCli, "speak",
          "--text", text,
          "--profile", cfg.profile,
          "--out", staged,
          "--lufs", String(cfg.lufs),
        ], cfg.timeoutMs);
      } catch (err) {
        const detail = err instanceof NarrationError ? err.detail : undefined;
        throw new NarrationError(
          `配音合成失败（第 ${i + 1} 句）：${text.slice(0, 40)}`,
          `${detail ?? ""}\n—— 检查配音工位是否在跑（${cfg.bridgeUrl}），音色档案 ${cfg.profile} 是否存在`,
        );
      }
      if (!existsSync(staged)) throw new NarrationError(`配音工位未产出音频：${staged}`);
      copyFileSync(staged, file);
    }
    durations[i] = await probeDurationSec(file, cfg.ffprobe);
    const entry: SegmentManifestEntry = {
      index: i, sha256: textSha(text), profile: cfg.profile, file, seconds: durations[i]!,
    };
    manifest!.segments = [...manifest!.segments.filter((s) => s.index !== i), entry].sort((a, b) => a.index - b.index);
    manifest!.derivedFrom = "synthesized";
    writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
    done += 1;
    report(text);
  };

  /**
   * 逐句失败**不中止整批**：`Promise.all` 在第一次失败时立刻抛出，而其余 worker 仍在后台跑完——
   * 结果是"已完成的 26 句白跑、整片状态却是 failed"（真机踩到：一句引擎抖动牵连全批）。
   * 改为 `allSettled` 语义：先把能合成的都合成完，再一次性报告失败句号；
   * 单句抖动只损失那一句，重跑只补那一句（配合清单复用）。
   */
  const failures: Array<{ index: number; reason: string }> = [];
  let succeeded = 0;
  try {
    report(sentences[0] ?? "");
    const queue = sentences.map((text, i) => ({ text, i }));
    const workers = Array.from({ length: Math.min(cfg.concurrency, queue.length) }, async () => {
      for (;;) {
        const next = queue.shift();
        if (!next) return;
        try {
          await synthesizeOne(next.i, next.text);
          succeeded += 1;
        } catch (err) {
          failures.push({ index: next.i, reason: `${(err as Error).message}`.slice(0, 200) });
        }
      }
    });
    await Promise.all(workers);
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
  if (failures.length > 0) {
    failures.sort((a, b) => a.index - b.index);
    throw new NarrationError(
      `${failures.length} 句配音失败（本批已成功 ${succeeded} 句，产物保留可直接续跑）：`
      + failures.slice(0, 4).map((f) => `第 ${f.index + 1} 句`).join("、")
      + (failures.length > 4 ? ` 等 ${failures.length} 句` : ""),
      failures.map((f) => `#${f.index + 1}: ${f.reason}`).join("\n").slice(0, 900),
    );
  }
  for (const [i] of sentences.entries()) if (!durations[i]) throw new NarrationError(`第 ${i + 1} 句没有产出音频`);

  // ② 时间轴：毫秒取整，严格由真实时长累加（不按字数估算）
  const gapSec = Math.max(0, cfg.gapMs) / 1000;
  const silencePath = join(opts.outDir, "silence.wav");
  await run(cfg.ffmpeg, [
    "-y", "-v", "error", "-f", "lavfi", "-i", "anullsrc=r=44100:cl=mono",
    "-t", gapSec.toFixed(3), "-c:a", "pcm_s16le", silencePath,
  ], 60_000);

  const segments: NarrationSegment[] = [];
  let cursorMs = 0;
  for (const [i, text] of sentences.entries()) {
    const durMs = Math.round(durations[i]! * 1000);
    segments.push({ index: i + 1, text, startMs: cursorMs, endMs: cursorMs + durMs, file: files[i]! });
    cursorMs += durMs + (i === sentences.length - 1 ? 0 : Math.round(gapSec * 1000));
  }

  // ③ 拼接整轨（先统一采样率/位深/声道，避免工位输出格式漂移导致 concat 失败）
  const normDir = join(opts.outDir, "norm");
  mkdirSync(normDir, { recursive: true });
  const listLines: string[] = [];
  const quote = (p: string) => `file '${p.replace(/'/g, "'\\''")}'`;
  for (const [i, file] of files.entries()) {
    const norm = join(normDir, `n-${String(i + 1).padStart(2, "0")}.wav`);
    await run(cfg.ffmpeg, ["-y", "-v", "error", "-i", file, "-ar", "44100", "-ac", "1", "-c:a", "pcm_s16le", norm], 120_000);
    listLines.push(quote(norm));
    if (i < files.length - 1 && gapSec > 0) listLines.push(quote(silencePath));
  }
  const listPath = join(opts.outDir, "concat.txt");
  writeFileSync(listPath, `${listLines.join("\n")}\n`, "utf8");
  const wavPath = join(opts.outDir, "narration.wav");
  await run(cfg.ffmpeg, ["-y", "-v", "error", "-f", "concat", "-safe", "0", "-i", listPath, "-c", "copy", wavPath], 300_000);
  const totalMs = Math.round((await probeDurationSec(wavPath, cfg.ffprobe)) * 1000);

  /**
   * 时间轴自校验（纪律：不信任"应该对齐"）。
   * 拼接后的实测时长必须与逐句累加的计划一致（容差 50ms）；否则后面所有幕长与
   * 元素时序都会整体漂移——宁可在这里失败，也不产出一条"字幕整体偏后半句"的片子。
   */
  if (Math.abs(totalMs - cursorMs) > 50) {
    throw new NarrationError(
      `配音轨时长与逐句累加不一致：实测 ${totalMs}ms vs 计划 ${cursorMs}ms（差 ${totalMs - cursorMs}ms）`,
      "常见原因：工位输出采样率/声道与拼接参数不一致，或 concat 列表中混入了损坏的分句文件",
    );
  }

  const cues: SrtCue[] = segments.map((seg) => ({
    index: seg.index,
    startMs: seg.startMs,
    endMs: seg.endMs,
    durMs: seg.endMs - seg.startMs,
    text: seg.text,
  }));
  const srt = buildSrt(cues);
  writeFileSync(join(opts.outDir, "narration.srt"), srt, "utf8");
  // 中间态清理（逐句产物保留，便于单句重合成排障）
  rmSync(normDir, { recursive: true, force: true });
  rmSync(listPath, { force: true });
  rmSync(silencePath, { force: true });

  return { segments, cues, srt, wavPath, totalMs, profile: cfg.profile, reusedSegments: reused };
}

/**
 * 配音落点核查（工位 `verify`：ASR 转写与期望文本的匹配率 + 响度/真峰值）。
 * 作为**可听性证据**记录，不作为唯一判据——内容一致性由"逐句合成的输入即原文"构造保证。
 */
export async function verifyNarration(
  wavPath: string,
  expectText: string,
  opts: { env?: NodeJS.ProcessEnv } = {},
): Promise<{ matchRatio: number | null; detail: string }> {
  const env = opts.env ?? process.env;
  const cfg = narrationConfig(env);
  const voiceCli = join(REPO_ROOT, "bundles/ai-video/connectors/voice-bridge/cli.mjs");
  const out = await run(process.execPath, [
    voiceCli, "verify", "--in", wavPath, "--expect-text", expectText, "--no-strict",
  ], cfg.timeoutMs);
  const parsed = JSON.parse(out) as { result?: { match_ratio?: number; detail?: string; heard_text?: string } };
  const heard = parsed.result?.heard_text ?? "";
  return {
    matchRatio: parsed.result?.match_ratio ?? null,
    detail: (parsed.result?.detail ?? `ASR 转写：${heard || "（空）"}`).slice(0, 400),
  };
}

/** 读回已合成的 SRT（断点续跑时复用，不重跑 TTS） */
export function readNarrationSrt(path: string): string {
  return readFileSync(path, "utf8");
}
