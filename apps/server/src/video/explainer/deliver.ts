/**
 * explainer/deliver.ts —— 交付段：两遍 loudnorm + 媒资库入库 · T-2026-0926-0008
 *
 * 为什么两遍（SKILL.md ⑧ 原命令）：单遍 loudnorm 是**动态**归一，会把片子的强弱对比压平；
 * 第一遍只量测（`-f null -` 读 stderr JSON），第二遍带 `measured_*` + `linear=true` 做线性归一——
 * 音色与动态都保住，只有整体电平落到 I=-15 / TP=-1.5 / LRA=11。
 *
 * 入库口径（spec §6.7 + 媒资库 0039）：`kind='final_cut'`、`source_type='generated'`、
 * `pipeline_kind='explainer'`、prompt=口播稿摘要、tags 带「口播/解说/片名」，
 * 走 `registerLocalAsset`（sha256 幂等 + 版本链 + D16 同事务事件）——**不新开第二条入库路径**。
 */
import { spawn } from "node:child_process";
import { existsSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { audioFingerprint } from "./asr-aligner.js";

export interface LoudnormMeasurement {
  input_i: number;
  input_tp: number;
  input_lra: number;
  input_thresh: number;
  target_offset: number;
}

function run(
  cmd: string,
  args: string[],
  opts: { env?: NodeJS.ProcessEnv; timeoutMs?: number; onLog?: (l: string) => void } = {},
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
      for (const line of text.split("\n")) if (line.trim() && opts.onLog && /loudnorm|input_|Error/.test(line)) opts.onLog(line.trim());
    });
    child.on("error", (e) => { clearTimeout(timer); reject(e); });
    child.on("exit", (code) => { clearTimeout(timer); resolve({ code: code ?? -1, stdout, stderr }); });
  });
}

export function ffmpegBin(env: NodeJS.ProcessEnv = process.env): string {
  return env.FFMPEG_PATH?.trim() || "ffmpeg";
}

/** 第一遍：只量测（读 stderr 里 loudnorm 的 JSON 块） */
export async function measureLoudness(
  input: string,
  opts: { env?: NodeJS.ProcessEnv; onLog?: (l: string) => void } = {},
): Promise<LoudnormMeasurement> {
  const r = await run(ffmpegBin(opts.env), [
    "-hide_banner", "-nostats", "-i", input,
    "-af", "loudnorm=I=-15:TP=-1.5:LRA=11:print_format=json",
    "-f", "null", "-",
  ], opts);
  if (r.code !== 0) throw new Error(`loudnorm 量测失败（退出码 ${r.code}）：${r.stderr.slice(-300)}`);
  const json = /\{[\s\S]*?"target_offset"[\s\S]*?\}/.exec(r.stderr);
  if (!json) throw new Error("loudnorm 量测输出里找不到 JSON（格式变了？）");
  const parsed = JSON.parse(json[0]) as Record<string, string>;
  const num = (key: string): number => {
    const value = Number(parsed[key]);
    if (!Number.isFinite(value)) throw new Error(`loudnorm 量测字段非法：${key}=${parsed[key]}`);
    return value;
  };
  return {
    input_i: num("input_i"),
    input_tp: num("input_tp"),
    input_lra: num("input_lra"),
    input_thresh: num("input_thresh"),
    target_offset: num("target_offset"),
  };
}

/** 第二遍：线性归一（视频轨 copy，只重编码音频） */
export async function normalizeLoudness(
  input: string,
  output: string,
  measured: LoudnormMeasurement,
  opts: { env?: NodeJS.ProcessEnv; onLog?: (l: string) => void } = {},
): Promise<void> {
  const filter = [
    "loudnorm=I=-15:TP=-1.5:LRA=11",
    `measured_I=${measured.input_i}`,
    `measured_TP=${measured.input_tp}`,
    `measured_LRA=${measured.input_lra}`,
    `measured_thresh=${measured.input_thresh}`,
    `offset=${measured.target_offset}`,
    "linear=true",
  ].join(":");
  const r = await run(ffmpegBin(opts.env), [
    "-hide_banner", "-nostats", "-y", "-i", input,
    "-c:v", "copy", "-af", filter, "-ar", "48000", "-c:a", "aac", "-b:a", "192k",
    output,
  ], { ...opts, timeoutMs: 3_600_000 });
  if (r.code !== 0) throw new Error(`loudnorm 归一失败（退出码 ${r.code}）：${r.stderr.slice(-300)}`);
}

export interface DeliverResult {
  deliveryPath: string;
  rawPath: string;
  measurement: LoudnormMeasurement;
  bytes: number;
  sha256: string;
}

/** 交付段主流程：量测 → 归一 → 落 delivery.mp4（入库由调用方决定走 DB 还是离线记录） */
export async function deliverFilm(input: {
  jobDir: string;
  env?: NodeJS.ProcessEnv;
  onLog?: (line: string) => void;
}): Promise<DeliverResult> {
  const raw = join(input.jobDir, "out", "v1.mp4");
  if (!existsSync(raw)) throw new Error(`成片不存在：${raw}（先渲染）`);
  const delivery = join(input.jobDir, "out", "delivery.mp4");
  const measurement = await measureLoudness(raw, { env: input.env, onLog: input.onLog });
  await normalizeLoudness(raw, delivery, measurement, { env: input.env, onLog: input.onLog });
  const fp = await audioFingerprint(delivery);
  writeFileSync(join(input.jobDir, "out", "delivery-loudnorm.json"), JSON.stringify({
    measured: measurement,
    target: { I: -15, TP: -1.5, LRA: 11 },
    delivery: { sha256: fp.sha256, bytes: fp.bytes, path: "out/delivery.mp4" },
  }, null, 1));
  return {
    deliveryPath: delivery,
    rawPath: raw,
    measurement,
    bytes: statSync(delivery).size,
    sha256: fp.sha256,
  };
}
