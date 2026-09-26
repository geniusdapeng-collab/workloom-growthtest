/**
 * explainer/voice-prep.ts —— 配音准备（TTS 合成 / 真人录音预剪）· T-2026-0926-0008
 *
 * 两条来源（spec §6.3 + SKILL.md ②）：
 *   `tts`（缺省）：本机配音工位（voice-bridge → mlx-audio）按音色档案合成整条配音；
 *     走 `voicewrite.speak`，工位内部已做分句 + 气口拼装 + 响度归一 + 真峰值复检；
 *     **TTS 产物跳过预剪**——它没有口水词与重说，预剪只会压气口（spec §6.3 原文口径）。
 *   `upload`：真人录音，必须过引擎 `scripts/voice_trim.py`——先 `--dry-run --words-out` 出报告，
 *     报告进制片档案并由人过目确认后才落盘（"顺序硬规：预剪 → 时间戳 → 一切后续"）。
 *
 * 声纹边界（与《语音与数字员工交付契约》一致）：参考音频与音色档案只留在本机工位，
 * 本模块只传 profile 名与文本，不搬运声纹。
 */
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readFileSync, statSync } from "node:fs";
import os from "node:os";
import { join } from "node:path";
import { audioFingerprint, resolvePython } from "./asr-aligner.js";
import { engineDirOf } from "./engine.js";

export interface VoicePrepInput {
  /** 完整口播稿（各句以换行分隔；工位按 max_chunk_chars 自行分块） */
  text: string;
  jobDir: string;
  /** tts = 本机克隆音色合成；upload = 真人录音（必经预剪确认） */
  source: "tts" | "upload";
  /** 音色档案 id（工位 profiles/<id>） */
  profile?: string;
  /** upload：录音文件绝对路径 */
  uploadPath?: string;
  /** upload：是否已按 dry-run 报告确认（未确认则只出报告，不落盘） */
  confirmed?: boolean;
  env?: NodeJS.ProcessEnv;
  onLog?: (line: string) => void;
  timeoutMs?: number;
}

export interface VoicePrepResult {
  audioPath: string;
  source: "tts" | "upload";
  profile: string | null;
  durationSec: number | null;
  lufs: number | null;
  truePeakDbtp: number | null;
  sha256: string;
  bytes: number;
  /** upload 路径的预剪报告（相对工程目录）；tts 为 null */
  trimReportPath: string | null;
  trimmed: boolean;
  engineDurationSec: number | null;
}

export function stationDirOf(env: NodeJS.ProcessEnv = process.env): string {
  return env.WORKLOOM_VOICE_STATION_DIR?.trim()
    || join(os.homedir(), ".workloom", "voice-station");
}

export function voiceBridgeToken(env: NodeJS.ProcessEnv = process.env): string {
  const explicit = env.WORKLOOM_VOICE_BRIDGE_TOKEN?.trim();
  if (explicit) return explicit;
  const file = join(stationDirOf(env), "bridge-token");
  if (existsSync(file)) return readFileSync(file, "utf8").trim();
  return "";
}

async function callBridge(
  tool: string,
  params: Record<string, unknown>,
  opts: { env: NodeJS.ProcessEnv; timeoutMs: number; onLog?: (l: string) => void },
): Promise<Record<string, unknown>> {
  const url = (opts.env.WORKLOOM_VOICE_BRIDGE_URL?.trim() || "http://127.0.0.1:9776").replace(/\/+$/, "");
  const token = voiceBridgeToken(opts.env);
  if (!token) throw new Error(`配音工位缺 token：请配置 WORKLOOM_VOICE_BRIDGE_TOKEN 或 ${join(stationDirOf(opts.env), "bridge-token")}`);
  /**
   * 重试纪律（T-2026-0926-0008 真机补）：工位是单进程 Node 服务，长合成期间被客户端中断过一次后
   * 事件循环可能卡住（实测 `/health` 10s 无响应，随后 fetch failed）。**网络类失败重试 2 次**，
   * 业务失败（path_not_allowed / verify_failed / bad_request）不重试——避免把确定性错误重放成雪崩。
   */
  const maxAttempts = 3;
  let lastError: Error | null = null;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      return await callBridgeOnce(url, token, tool, params, opts);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const transient = /fetch failed|ECONNRESET|ECONNREFUSED|socket hang up|timeout|aborted|超时/i.test(message);
      lastError = new Error(`${message}（工位 ${url}，tool=${tool}，第 ${attempt}/${maxAttempts} 次）`);
      if (!transient || attempt === maxAttempts) throw lastError;
      opts.onLog?.(`[voice-prep] 工位调用失败（可重试）：${message} → ${attempt < maxAttempts ? "重试" : "放弃"}`);
      await new Promise((r) => setTimeout(r, 5_000 * attempt));
    }
  }
  throw lastError ?? new Error("配音工位调用失败（无错误信息）");
}

async function callBridgeOnce(
  url: string,
  token: string,
  tool: string,
  params: Record<string, unknown>,
  opts: { env: NodeJS.ProcessEnv; timeoutMs: number; onLog?: (l: string) => void },
): Promise<Record<string, unknown>> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs);
  try {
    const response = await fetch(`${url}/action`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body: JSON.stringify({ tool, params: { ...params, tenant_id: opts.env.WORKLOOM_VOICE_TENANT ?? "ws-local-voice" } }),
      signal: controller.signal,
    });
    const payload = await response.json().catch(() => null) as
      | { ok?: boolean; error?: string; message?: string; result?: Record<string, unknown> }
      | null;
    if (!response.ok || payload?.ok !== true) {
      throw new Error(`配音工位 ${tool} 失败：${payload?.error ?? `HTTP ${response.status}`} ${payload?.message ?? ""}`.trim());
    }
    return payload.result ?? {};
  } finally {
    clearTimeout(timer);
  }
}

function run(
  cmd: string,
  args: string[],
  opts: { env?: NodeJS.ProcessEnv; timeoutMs?: number; onLog?: (l: string) => void },
): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { env: opts.env ?? process.env, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => { child.kill("SIGKILL"); reject(new Error(`${cmd} 超时`)); }, opts.timeoutMs ?? 1_800_000);
    child.stdout.on("data", (d) => { stdout += String(d); });
    child.stderr.on("data", (d) => {
      const text = String(d);
      stderr += text;
      for (const line of text.split("\n")) if (line.trim()) opts.onLog?.(line.trim());
    });
    child.on("error", (e) => { clearTimeout(timer); reject(e); });
    child.on("exit", (code) => { clearTimeout(timer); resolve({ code: code ?? -1, stdout, stderr }); });
  });
}

export async function prepareVoice(input: VoicePrepInput): Promise<VoicePrepResult> {
  const env = input.env ?? process.env;
  const audioDir = join(input.jobDir, "audio");
  mkdirSync(audioDir, { recursive: true });
  const timeoutMs = input.timeoutMs ?? 1_800_000;

  if (input.source === "tts") {
    const profile = (input.profile ?? env.WORKLOOM_VOICE_PROFILE ?? "zh-myvoice").trim();
    const out = join(audioDir, "full.wav");
    /**
     * 产物先落**工位自己的 deliveries/**（工位的 path allowlist 只认
     * `~/.workloom/voice-station` 与用户目录；工程目录在仓库内，不在白名单里——真机实测被拒：
     * `path_not_allowed out`）。因此：工位出稿 → 本模块拷进工程目录。
     * 文件名与口播稿指纹绑定：同一稿重复跑复用同一份（幂等，不重复合成）。
     */
    /**
     * 分块与气口（T-2026-0926-0008 真机调参）：`max_chunk_chars=60` 让工位按**句**切块（每句一块），
     * `gap_ms=520` 在句间留出真实气口——这既让口播有呼吸感，也是 `sfx_check --mix` 能把音效判成
     * "UNMASKED（人声局部安静）"的物理前提（埋在语音里的 cue 等于没放）。
     */
    const gapMs = Number(env.TALKCRAFT_VOICE_GAP_MS ?? 520);
    const maxChunkChars = Number(env.TALKCRAFT_VOICE_MAX_CHUNK_CHARS ?? 60);
    /**
     * **逐句合成 + 本模块拼气口**（T-2026-0926-0008 真机重构）。
     *
     * 为什么不用工位的"整篇一次合成"：工位是单进程 Node 服务，整篇 14 句要跑 20 分钟以上；
     * 8GB 机器高负载下实测桥在合成中途挂起（`fetch failed`），而一次失败 = **整篇重来**（无中间产物）。
     * 逐句调用把单次请求压到几十秒，并且每句的 wav 落盘即缓存：中断后重跑只补缺的句子。
     * 气口由本模块用 ffmpeg `apad` + `concat` 精确插入（句间 gapMs），比工位内部拼接更可控，
     * 也让 sfx 能落进真实气口（sfx_check --mix 的 UNMASKED 前提）。
     */
    const sentences = splitForTts(input.text);
    if (sentences.length === 0) throw new Error("配音文本为空");
    const voiceLufs = Number(env.TALKCRAFT_VOICE_LUFS ?? -16);
    const parts: string[] = [];
    let reused = 0;
    for (const [index, sentence] of sentences.entries()) {
      const cache = join(
        stationDirOf(env),
        "deliveries",
        `talkcraft-s${String(index).padStart(2, "0")}-${createHash("sha256").update(`${profile}\u0000${sentence}\u0000${voiceLufs}`).digest("hex").slice(0, 12)}.wav`,
      );
      if (existsSync(cache) && statSync(cache).size > 20_000) {
        reused += 1;
        parts.push(cache);
        continue;
      }
      const result = await callBridge("voicewrite.speak", {
        profile,
        text: sentence,
        out: cache,
        gap_ms: 0,
        lufs: voiceLufs,
        max_chunk_chars: Math.max(maxChunkChars, sentence.length + 8),
      }, { env, timeoutMs, onLog: input.onLog });
      const produced = String(result.out ?? cache);
      if (!existsSync(produced)) throw new Error(`配音工位回执成功但产物不存在（第 ${index + 1} 句，不伪造完成）`);
      if (produced !== cache) copyFileSync(produced, cache);
      parts.push(cache);
      input.onLog?.(`[voice-prep] TTS ${index + 1}/${sentences.length} 句完成（${sentence.slice(0, 12)}…）`);
    }
    if (reused > 0) input.onLog?.(`[voice-prep] 复用已合成的句子产物 ${reused}/${sentences.length} 句`);
    await concatWithGaps(parts, out, { gapMs, lufs: voiceLufs, env, onLog: input.onLog });
    input.onLog?.(`[voice-prep] 拼装完成：${sentences.length} 句 / 句间 ${gapMs}ms → ${out}`);
    const duration = await probeDurationSec(out, env);
    const result: Record<string, unknown> = { duration_sec: duration, lufs: null, true_peak_dbtp: null };
    const fp = await audioFingerprint(out);
    return {
      audioPath: out,
      source: "tts",
      profile,
      durationSec: typeof result.duration_sec === "number" ? result.duration_sec : null,
      lufs: typeof result.lufs === "number" ? result.lufs : null,
      truePeakDbtp: typeof result.true_peak_dbtp === "number" ? result.true_peak_dbtp : null,
      sha256: fp.sha256,
      bytes: fp.bytes,
      trimReportPath: null,
      trimmed: false,
      engineDurationSec: typeof result.duration_sec === "number" ? result.duration_sec : null,
    };
  }

  /* ---------- 真人录音：预剪（dry-run → 人确认 → 落盘） ---------- */
  if (!input.uploadPath || !existsSync(input.uploadPath)) throw new Error(`真人录音路径不存在：${input.uploadPath ?? "(未给)"}`);
  const engineDir = engineDirOf(env);
  const trimScript = join(engineDir, "scripts/voice_trim.py");
  if (!existsSync(trimScript)) throw new Error(`缺少引擎脚本 voice_trim.py（${trimScript}）——先跑 pnpm talkcraft:install`);
  const scriptPath = join(audioDir, "script.txt");
  const { writeFileSync } = await import("node:fs");
  writeFileSync(scriptPath, `${input.text}\n`, "utf8");
  const raw = join(audioDir, "raw.wav");
  copyFileSync(input.uploadPath, raw);
  const reportPath = join(audioDir, "trim-report.json");
  const wordsPath = join(audioDir, "trim-words.json");
  const dry = await run(resolvePython(env), [
    trimScript, raw, scriptPath,
    "--dry-run", "--words-out", wordsPath, "--edl", reportPath,
  ], { env, timeoutMs, onLog: input.onLog });
  if (dry.code !== 0) throw new Error(`voice_trim 预演失败（退出码 ${dry.code}）：${dry.stderr.slice(-400)}`);

  if (!input.confirmed) {
    const report = existsSync(reportPath) ? JSON.parse(readFileSync(reportPath, "utf8")) as { cuts?: unknown[] } : { cuts: [] };
    throw new Error(
      `真人录音必须先过预剪确认：报告已生成 ${reportPath}（${(report.cuts ?? []).length} 处候选切点）。`
      + "请人工听核后带 confirmed=true 重跑（顺序硬规：预剪 → 时间戳 → 一切后续）。",
    );
  }

  const out = join(audioDir, "full.wav");
  const cut = await run(resolvePython(env), [
    trimScript, raw, scriptPath,
    "--out", out, "--edl", reportPath, "--words", wordsPath,
  ], { env, timeoutMs, onLog: input.onLog });
  if (cut.code !== 0) throw new Error(`voice_trim 落盘失败（退出码 ${cut.code}）：${cut.stderr.slice(-400)}`);
  const fp = await audioFingerprint(out);
  return {
    audioPath: out,
    source: "upload",
    profile: null,
    durationSec: null,
    lufs: null,
    truePeakDbtp: null,
    sha256: fp.sha256,
    bytes: fp.bytes,
    trimReportPath: "audio/trim-report.json",
    trimmed: true,
    engineDurationSec: null,
  };
}

/** 音频时长（ffprobe；缺失即 null，不编数字） */
export async function probeDurationSec(audioPath: string, env: NodeJS.ProcessEnv = process.env): Promise<number | null> {
  const ffprobe = env.FFPROBE_PATH?.trim() || "ffprobe";
  const r = await run(ffprobe, ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", audioPath], { env, timeoutMs: 60_000 });
  if (r.code !== 0) return null;
  const value = Number(r.stdout.trim());
  return Number.isFinite(value) && value > 0 ? Math.round(value * 1000) / 1000 : null;
}

/**
 * 配音文本切句（TTS 逐句合成的输入）：先按行（口播稿一行一句），行内再按句末标点切。
 * 只切文本，不删标点——音色模型从标点读停顿，删了会念成连读。
 */
export function splitForTts(text: string): string[] {
  const out: string[] = [];
  for (const line of text.split(/\n+/)) {
    const clean = line.trim();
    if (!clean) continue;
    const parts = clean.match(/[^。！？!?；;]+[。！？!?；;]?/g) ?? [clean];
    for (const part of parts) {
      const trimmed = part.trim();
      if (trimmed) out.push(trimmed);
    }
  }
  return out;
}

/**
 * 句间气口拼装：给每句末尾补 `gapMs` 静音（末句补一个短收尾），再 concat，最后一遍轻量 loudnorm。
 * 用 ffmpeg `apad`+`concat` 而不是"自己算时间轴"：采样级精确、无重采样漂移。
 */
export async function concatWithGaps(
  parts: string[],
  out: string,
  opts: { gapMs: number; lufs: number; env?: NodeJS.ProcessEnv; onLog?: (l: string) => void },
): Promise<void> {
  if (parts.length === 0) throw new Error("concatWithGaps：没有输入");
  const env = opts.env ?? process.env;
  const ffmpeg = env.FFMPEG_PATH?.trim() || "ffmpeg";
  const gapSec = Math.max(0, opts.gapMs) / 1000;
  const tailSec = 0.35;
  const inputs = parts.flatMap((p) => ["-i", p]);
  const filter = [
    ...parts.map((_, i) => `[${i}:a]apad=pad_dur=${i === parts.length - 1 ? tailSec : gapSec}[a${i}]`),
    `${parts.map((_, i) => `[a${i}]`).join("")}concat=n=${parts.length}:v=0:a=1[cat]`,
    `[cat]loudnorm=I=${opts.lufs}:TP=-1.5:LRA=11[out]`,
  ].join(";");
  const result = await run(ffmpeg, [
    "-y", "-hide_banner", "-loglevel", "error", ...inputs,
    "-filter_complex", filter, "-map", "[out]", "-ar", "24000", "-ac", "1", out,
  ], { env, timeoutMs: 600_000, onLog: opts.onLog });
  if (result.code !== 0) throw new Error(`句间拼装失败（ffmpeg 退出码 ${result.code}）：${result.stderr.slice(-300)}`);
}

/** 文本指纹（口播稿 sha256，与 audio sha256 一起进档案） */
export function textFingerprint(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

export function fileBytes(path: string): number {
  return existsSync(path) ? statSync(path).size : 0;
}
