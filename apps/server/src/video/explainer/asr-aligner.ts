/**
 * explainer/asr-aligner.ts —— 配音 → 字级时间戳（对齐环节封装）· T-2026-0926-0008
 *
 * 四条后端（spec v2.0 只列了后三条，review 修复 F5 增加第一条）：
 *   `voice-station`（缺省）：本机配音工位 ASR（mlx-whisper 词级时间戳）→ 我方 `aligner.ts` 逐字对齐；
 *   `vendor-whisper` / `vendor-sherpa`：直接用引擎自带 `scripts/timestamps_cpu.py`（自带 ASR + 对齐），
 *     后端精度与 vendor 文档一致（FireRed 最优，faster-whisper 次之）；
 *   `precomputed`：已有 timestamps.json（人工听核后重跑 / 断点续跑）。
 *
 * 顺序硬规（SKILL.md ②）：**预剪 → 时间戳 → 一切后续，不可换**。本模块假定音频已是最终配音，
 * 因此不提供"先对齐后再改音频"的路径：换音频必须重跑本模块（job 目录里以音频 sha256 留痕）。
 */
import { spawn } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { REPO_ROOT, engineDirOf } from "./engine.js";
import { alignScriptToTimestamps, timingJsonOf, type AsrWord } from "./aligner.js";
import { TimestampsFileSchema, assertSpokenNumbers, type ExplainerScript, type TimestampsFile } from "./types.js";

export type AsrBackend = "voice-station" | "vendor-whisper" | "vendor-sherpa" | "precomputed";

export interface AlignInput {
  script: ExplainerScript;
  /** 最终配音（wav/mp3），与成片音轨同一条 */
  audioPath: string;
  /** 工程目录（写 audio/timestamps.json 与 remotion/src/timing.json） */
  jobDir: string;
  backend?: AsrBackend;
  engineDir?: string;
  env?: NodeJS.ProcessEnv;
  onLog?: (line: string) => void;
  timeoutMs?: number;
}

export interface AlignResult {
  timestampPath: string;
  timingPath: string;
  backend: AsrBackend;
  precision: "word" | "segment";
  total: number;
  /** match < 0.90 的句号（人工听核清单） */
  lowMatch: number[];
  timestamps: TimestampsFile;
}

export function resolvePython(env: NodeJS.ProcessEnv = process.env): string {
  const explicit = env.TALKCRAFT_PYTHON?.trim();
  if (explicit) return explicit;
  const venv = join(REPO_ROOT, "var/tcvenv/bin/python");
  return existsSync(venv) ? venv : "python3";
}

export function defaultAlignBackend(env: NodeJS.ProcessEnv = process.env): AsrBackend {
  const raw = (env.TALKCRAFT_ASR_BACKEND ?? "voice-station").trim();
  if (raw === "voice-station" || raw === "vendor-whisper" || raw === "vendor-sherpa" || raw === "precomputed") return raw;
  throw new Error(`TALKCRAFT_ASR_BACKEND 非法：${raw}（合法：voice-station | vendor-whisper | vendor-sherpa | precomputed）`);
}

function run(
  cmd: string,
  args: string[],
  opts: { cwd?: string; env?: NodeJS.ProcessEnv; timeoutMs?: number; onLog?: (line: string) => void },
): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, {
      cwd: opts.cwd,
      env: opts.env ?? process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`${cmd} 超时（${Math.round((opts.timeoutMs ?? 900_000) / 1000)}s）`));
    }, opts.timeoutMs ?? 900_000);
    child.stdout.on("data", (d) => { stdout += String(d); });
    child.stderr.on("data", (d) => {
      const text = String(d);
      stderr += text;
      for (const line of text.split("\n")) if (line.trim()) opts.onLog?.(line.trim());
    });
    child.on("error", (err) => { clearTimeout(timer); reject(err); });
    child.on("exit", (code) => { clearTimeout(timer); resolve({ code: code ?? -1, stdout, stderr }); });
  });
}

export async function alignTimestamps(input: AlignInput): Promise<AlignResult> {
  const env = input.env ?? process.env;
  const backend = input.backend ?? defaultAlignBackend(env);
  const engineDir = input.engineDir ?? engineDirOf(env);
  const audioDir = join(input.jobDir, "audio");
  const timingDir = join(input.jobDir, "remotion", "src");
  mkdirSync(audioDir, { recursive: true });
  mkdirSync(timingDir, { recursive: true });
  const timestampPath = join(audioDir, "timestamps.json");
  const timingPath = join(timingDir, "timing.json");

  // 口播稿硬规：数字必须汉字（否则逐字锚定必然错位——在入口就拦，不留到 QA 阶段）
  for (const sentence of input.script.sentences) assertSpokenNumbers(sentence.text);

  let timestamps: TimestampsFile;
  let precision: AlignResult["precision"] = "word";
  if (backend === "voice-station") {
    const wordsPath = join(audioDir, "asr-words.json");
    const python = resolvePython(env);
    const helper = join(REPO_ROOT, "scripts/tools/talkcraft-asr-words.py");
    const r = await run(python, [
      helper, input.audioPath, wordsPath,
      "--hf-home", env.HF_HOME?.trim() || join(env.HOME ?? "", ".cache/huggingface"),
      "--engine-url", env.TALKCRAFT_ASR_ENGINE_URL?.trim() || "http://127.0.0.1:8099",
    ], { env, timeoutMs: input.timeoutMs, onLog: input.onLog });
    if (r.code !== 0) throw new Error(`voice-station ASR 失败（退出码 ${r.code}）：${r.stderr.slice(-500)}`);
    const parsed = JSON.parse(readFileSync(wordsPath, "utf8")) as {
      backend: string; precision: "word" | "segment"; words: AsrWord[]; duration: number;
    };
    precision = parsed.precision;
    const total = parsed.duration > 0 ? parsed.duration : (parsed.words[parsed.words.length - 1]?.end ?? 0);
    timestamps = alignScriptToTimestamps(input.script, parsed.words, total, { sampleRate: 16000 });
    if (precision === "segment") {
      input.onLog?.("[asr-aligner] 警告：ASR 只有句级时间戳（精度降档），逐字时间为句内线性插值");
    }
  } else if (backend === "precomputed") {
    if (!existsSync(timestampPath)) throw new Error(`precomputed 模式要求已存在 ${timestampPath}`);
    timestamps = TimestampsFileSchema.parse(JSON.parse(readFileSync(timestampPath, "utf8")));
    precision = "word";
  } else {
    const python = resolvePython(env);
    const scriptJson = join(audioDir, "script.json");
    writeFileSync(scriptJson, JSON.stringify({ sentences: input.script.sentences.map((s) => s.text) }, null, 1));
    const backendFlag = backend === "vendor-whisper" ? "whisper" : "firered";
    const r = await run(python, [
      join(engineDir, "scripts/timestamps_cpu.py"),
      input.audioPath, scriptJson, timestampPath,
      "--backend", backendFlag,
      ...(env.TALKCRAFT_ASR_CHUNK_SEC ? ["--chunk-sec", env.TALKCRAFT_ASR_CHUNK_SEC] : []),
    ], { env, timeoutMs: input.timeoutMs, onLog: input.onLog });
    if (r.code !== 0) throw new Error(`vendor 对齐失败（${backend}，退出码 ${r.code}）：${r.stderr.slice(-500)}`);
    timestamps = TimestampsFileSchema.parse(JSON.parse(readFileSync(timestampPath, "utf8")));
  }

  writeFileSync(timestampPath, JSON.stringify(timestamps, null, 1));
  writeFileSync(timingPath, JSON.stringify(timingJsonOf(timestamps), null, 0));
  const lowMatch = timestamps.sentences.filter((s) => !s.ok).map((s) => s.i);
  return {
    timestampPath,
    timingPath,
    backend,
    precision,
    total: timestamps.total,
    lowMatch,
    timestamps,
  };
}

/**
 * 与 vendor `scripts/make_timing.py` 逐字段对账（真机自检用；引擎未安装时返回 null）。
 * 有偏差即抛错——两套实现漂移会直接表现为"字幕/动效整体偏一拍"，必须在自检里暴露。
 */
export async function verifyTimingParity(
  jobDir: string,
  opts: { engineDir?: string; env?: NodeJS.ProcessEnv } = {},
): Promise<{ ok: boolean; vendorChars: number; oursChars: number } | null> {
  const env = opts.env ?? process.env;
  const engineDir = opts.engineDir ?? engineDirOf(env);
  const script = join(engineDir, "scripts/make_timing.py");
  if (!existsSync(script)) return null;
  const tsPath = join(jobDir, "audio/timestamps.json");
  const vendorOut = join(jobDir, "audio/timing.vendor.json");
  const r = await run(resolvePython(env), [script, tsPath, vendorOut], { env, timeoutMs: 120_000 });
  if (r.code !== 0) throw new Error(`vendor make_timing.py 失败：${r.stderr.slice(-300)}`);
  const vendor = JSON.parse(readFileSync(vendorOut, "utf8")) as { chars: Array<{ ch: string; t: number; e: number }> };
  const ours = JSON.parse(readFileSync(join(jobDir, "remotion/src/timing.json"), "utf8")) as {
    chars: Array<{ ch: string; t: number; e: number }>;
  };
  const same = vendor.chars.length === ours.chars.length
    && vendor.chars.every((c, i) => {
      const o = ours.chars[i]!;
      return c.ch === o.ch && Math.abs(c.t - o.t) <= 0.002 && Math.abs(c.e - o.e) <= 0.002;
    });
  if (!same) {
    throw new Error(`timing 对账失败：vendor ${vendor.chars.length} 字 vs 我方 ${ours.chars.length} 字（或数值偏差 >2ms）`);
  }
  return { ok: true, vendorChars: vendor.chars.length, oursChars: ours.chars.length };
}

/** 音频 sha256 留痕（换音频必须重对齐的判定依据） */
export async function audioFingerprint(audioPath: string): Promise<{ sha256: string; bytes: number }> {
  const { createHash } = await import("node:crypto");
  const { createReadStream, statSync } = await import("node:fs");
  const hash = createHash("sha256");
  await new Promise<void>((resolve, reject) => {
    createReadStream(audioPath).on("data", (chunk) => hash.update(chunk)).on("end", () => resolve()).on("error", reject);
  });
  return { sha256: hash.digest("hex"), bytes: statSync(audioPath).size };
}

/** 把外部音频纳入工程（copy 而非 move：原文件可能仍被配音工位引用） */
export function stageAudio(audioPath: string, jobDir: string): string {
  const target = join(jobDir, "audio", "full.wav");
  mkdirSync(join(jobDir, "audio"), { recursive: true });
  copyFileSync(audioPath, target);
  return target;
}
